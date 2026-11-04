'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { matchPark, segmentsIn, placesIn, summarize, indexSegments, nameScore } = require('../scripts/lib/parks');
const { scorePark } = require('../scripts/lib/park-score');
const { buildParks } = require('../scripts/build-parks');

// Local meters → [lon, lat] around a point in Reno.
const LON0 = -119.8, LAT0 = 39.5;
const M = (6371000 * Math.PI) / 180;
const at = (east, north) => [LON0 + east / (M * Math.cos((LAT0 * Math.PI) / 180)), LAT0 + north / M];
let nextNode = 1;
const seg = (id, coords, props) => ({ type: 'Feature', id, geometry: { type: 'LineString', coordinates: coords.map(([e, n]) => at(e, n)) },
  properties: { length_m: Math.hypot(coords[1][0] - coords[0][0], coords[1][1] - coords[0][1]), status: 'candidate', highway: 'footway', ...props } });
const box = (id, name, [w, s, e, n]) => ({ type: 'Feature', id, geometry: { type: 'MultiPolygon', coordinates: [[[at(w, s), at(e, s), at(e, n), at(w, n), at(w, s)]]] },
  properties: { name, osm: id } });
const place = (id, kind, category, e, n, name) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: at(e, n) }, properties: { kind, category, name } });

// A 200 m square park with a loop of paths inside, a road past it, and a path leaving it.
const segments = [
  seg('1:0', [[20, 20], [180, 20]], { from: 1, to: 2, shade_pct: 80, grade_max_pct: 1, surface: 'asphalt', water_pct: 100 }),
  seg('2:0', [[180, 20], [180, 180]], { from: 2, to: 3, shade_pct: 60, grade_max_pct: 2, surface: 'asphalt' }),
  seg('3:0', [[180, 180], [20, 180]], { from: 3, to: 4, shade_pct: 40, grade_max_pct: 9, surface: 'gravel' }),
  seg('4:0', [[20, 180], [20, 20]], { from: 4, to: 1, shade_pct: 20, grade_max_pct: 4 }),
  seg('5:0', [[-60, -50], [260, -50]], { from: 5, to: 6, highway: 'residential', status: 'review', name: 'Elm Park Road' }),
  seg('6:0', [[180, 100], [600, 100]], { from: 7, to: 8, name: 'Long Trail' }), // mostly outside
  seg('7:0', [[2000, 0], [2300, 0]], { from: 9, to: 10, highway: 'path', name: 'Ditch Trail' }),
  seg('8:0', [[2000, 40], [2300, 40]], { from: 11, to: 12, highway: 'residential', status: 'review', name: 'Ditch Trail Road' }),
];
const boundaries = [box('way/1', 'Elm Park', [0, 0, 200, 200]), box('way/2', 'Elmwood Open Space', [-500, -500, -300, -300])];
const places = [
  place('a', 'bench', 'amenity', 100, 25), place('b', 'toilets', 'amenity', 100, 210), // 10 m outside the edge: counts
  place('c', 'viewpoint', 'viewpoint', 50, 150, 'Hill view'), place('d', 'bench', 'amenity', 100, 400), // far: doesn't
  place('e', 'water', 'amenity', 2150, 5),
];
const park = (id, name, e, n) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: at(e, n) }, properties: { id, name, restrooms: 'Yes', benches: 'Yes' } });
const ctx = () => ({ boundaries, segIndex: indexSegments(segments), byOsm: new Map(boundaries.map((b) => [b.properties.osm, b])) });

test('name matching prefers the outline with the same distinctive words', () => {
  assert.equal(nameScore('Elm Park', 'Elm Park'), 1);
  assert.ok(nameScore('Elm Park', 'Elmwood Open Space') < 0.5);
  assert.equal(nameScore('Wingfield Park / Downtown Riverwalk', 'Downtown Riverwalk'), 1);
  assert.ok(nameScore('Mormon Station State Historic Park', 'Mormon Station Historic State Monument') > 0.5);
});

test('a park matches its outline and picks segments mostly inside it', () => {
  const m = matchPark(park(1, 'Elm Park Regional Park', 100, 100), ctx());
  assert.equal(m.method, 'outline');
  assert.deepEqual(m.osm, ['way/1']);
  assert.deepEqual(segmentsIn(m, ctx().segIndex).map((s) => s.id).sort(), ['1:0', '2:0', '3:0', '4:0']);
  assert.deepEqual(placesIn(m, [], places).map((p) => p.id).sort(), ['a', 'b', 'c']);
});

test('an outline sharing only half the distinctive words is not a match', () => {
  const skate = box('way/3', 'Dayton Skate Park', [4000, 4000, 4100, 4100]);
  const c = ctx();
  const m = matchPark(park(4, 'Dayton State Park', 4050, 4050), { ...c, boundaries: [...boundaries, skate] });
  assert.notEqual(m.method, 'outline');
});

test('trails match footpaths by name, never streets; otherwise a radius', () => {
  const t = matchPark(park(2, 'Ditch Trail', 2100, 20), ctx());
  assert.equal(t.method, 'trail');
  assert.deepEqual(t.segments.map((s) => s.id), ['7:0']);
  const segs = segmentsIn(t, ctx().segIndex);
  assert.deepEqual(placesIn(t, segs, places).map((p) => p.id), ['e']);
  const r = matchPark(park(3, 'Nowhere Park', 5000, 5000), ctx());
  assert.equal(r.method, 'radius');
});

test('overrides pick exact outlines, a trail name or a radius', () => {
  const c = ctx();
  assert.deepEqual(matchPark(park(1, 'Anything', 100, 100), { ...c, override: { osm: ['way/2'] } }).osm, ['way/2']);
  assert.equal(matchPark(park(1, 'Elm Park', 100, 100), { ...c, override: { radius_m: 300 } }).radius_m, 300);
  assert.equal(matchPark(park(1, 'Elm Park', 2100, 20), { ...c, override: { trail: 'Ditch Trail' } }).method, 'trail');
});

test('summary: length-weighted shade and grade, loops, amenities', () => {
  const m = matchPark(park(1, 'Elm Park', 100, 100), ctx());
  const segs = segmentsIn(m, ctx().segIndex);
  const s = summarize(segs, placesIn(m, segs, places), m);
  assert.equal(s.km_paths, 0.6);
  assert.equal(s.shade_pct, 50);
  assert.equal(s.under_5_pct, 75);
  assert.equal(s.over_8_pct, 25);
  assert.equal(s.steepest_pct, 9);
  assert.equal(s.loops, 1);
  assert.equal(s.paved_pct, 50);
  assert.equal(s.unpaved_pct, 25);
  assert.equal(s.surface_unknown_pct, 25);
  assert.equal(s.water_pct, 25);
  assert.deepEqual([s.benches, s.restrooms, s.viewpoints], [1, 1, 1]);
  assert.deepEqual(s.sight_names, ['Hill view']);
  assert.equal(s.area_ha, 4);
});

test('score rewards shade, gentle grades, rest stops and restrooms', () => {
  const base = { km_paths: 4, km_streets: 0, km_access_roads: 0, loops: 5, shade_pct: 50, under_5_pct: 100, benches: 12, shelters: 0,
    picnic_tables: 0, drinking_water: 0, restrooms: 1, viewpoints: 4, sights: 0, water_pct: 100 };
  assert.equal(scorePark(base).score, 100);
  const bare = scorePark({ ...base, shade_pct: 0, restrooms: 0 });
  assert.equal(bare.score, 70);
  assert.equal(bare.parts.shade, 0);
  assert.equal(scorePark({ ...base, km_paths: 0, km_streets: 0, loops: 0, benches: 0 }).parts.rest, 0);
});

test('build:parks writes scored parks and flags disagreements with the guide', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reno-parks-'));
  fs.mkdirSync(path.join(dir, 'data', 'cache'), { recursive: true });
  const fc = (features) => JSON.stringify({ type: 'FeatureCollection', features });
  fs.writeFileSync(path.join(dir, 'parks.geojson'), fc([park(1, 'Elm Park', 100, 100), park(2, 'Ditch Trail', 2100, 20)]));
  fs.writeFileSync(path.join(dir, 'data', 'cache', 'walking-network-full.geojson'), fc(segments));
  fs.writeFileSync(path.join(dir, 'data', 'cache', 'park-boundaries.geojson'), fc(boundaries));
  fs.writeFileSync(path.join(dir, 'data', 'places.geojson'), fc(places));
  const results = buildParks({ root: dir, out: path.join(dir, 'data'), log: () => {} });
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'park-scores.geojson'), 'utf8'));
  assert.equal(out.features.length, 2);
  const elm = results.find((r) => r.id === 1).properties;
  assert.equal(elm.match, 'outline');
  assert.equal(results.find((r) => r.id === 1).geometry.type, 'MultiPolygon');
  const ditch = results.find((r) => r.id === 2);
  assert.equal(ditch.geometry.type, 'MultiLineString');
  assert.ok(ditch.properties.checks.includes('guide says restrooms, none mapped in OSM'));
  assert.ok(out.features[0].properties.score >= out.features[1].properties.score); // ranked
  fs.rmSync(dir, { recursive: true });
});
