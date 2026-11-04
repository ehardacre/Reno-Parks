'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSegments } = require('../scripts/lib/segments');
const { extractPlaces, extractAreas, assembleRings } = require('../scripts/lib/osm-features');
const { enrichPlaces, enrichAreas } = require('../scripts/lib/enrich');
const { enrichCanopy, metaCanopySource, quadkey } = require('../scripts/lib/canopy');
const { enrichElevation } = require('../scripts/lib/elevation');
const { densify, haversine, lineLength } = require('../scripts/lib/geo');
const { parseArgs } = require('../scripts/build-network');

// Local meters → [lon, lat] around a point in Reno.
const LON0 = -119.8, LAT0 = 39.5;
const M_PER_DEG = (6371000 * Math.PI) / 180;
const M_LAT = 1 / M_PER_DEG, M_LON = 1 / (M_PER_DEG * Math.cos((LAT0 * Math.PI) / 180));
const at = (east, north) => [LON0 + east * M_LON, LAT0 + north * M_LAT];
const node = (id, east, north, tags) => { const [lon, lat] = at(east, north); return { type: 'node', id, lon, lat, ...(tags && { tags }) }; };

// A footway running east 0→300 m, with a branch north from its middle (150 m),
// a restricted service road, and a disconnected path.
const network = {
  elements: [
    node(1, 0, 0), node(2, 75, 0), node(3, 150, 0), node(4, 225, 0), node(5, 300, 0),
    node(6, 150, 100), node(7, 150, 200),
    node(8, 300, 50), node(9, 400, 50),
    node(10, 0, 500), node(11, 100, 500),
    { type: 'way', id: 100, nodes: [1, 2, 3, 4, 5], tags: { highway: 'footway', name: 'River Walk', surface: 'concrete' } },
    { type: 'way', id: 200, nodes: [3, 6, 7], tags: { highway: 'path', surface: 'gravel' } },
    { type: 'way', id: 300, nodes: [8, 9], tags: { highway: 'service', access: 'private' } },
    { type: 'way', id: 400, nodes: [10, 11], tags: { highway: 'residential', bridge: 'yes' } },
    { type: 'way', id: 500, nodes: [5, 8], tags: { highway: 'service', service: 'driveway' } },
  ],
};

const segs = () => buildSegments(network).segments;
const byId = (list) => Object.fromEntries(list.map((s) => [s.id, s]));

test('segments split ways at junctions and drop restricted ways and driveways', () => {
  const s = byId(segs());
  assert.deepEqual(Object.keys(s).sort(), ['100:0', '100:2', '200:0', '400:0']);
  assert.equal(s['100:0'].geometry.coordinates.length, 3);
  assert.equal(s['100:0'].properties.from, 1);
  assert.equal(s['100:0'].properties.to, 3);
  assert.equal(s['100:2'].properties.to, 5);
  assert.equal(s['100:0'].properties.name, 'River Walk');
  assert.ok(Math.abs(s['100:0'].properties.length_m - 150) < 0.5);
  assert.equal(s['100:0'].properties.component, s['200:0'].properties.component);
  assert.notEqual(s['100:0'].properties.component, s['400:0'].properties.component);
  assert.equal(s['400:0'].properties.status, 'review');
});

const features = {
  elements: [
    node(1000, 40, 10, { amenity: 'bench' }),                                  // beside 100:0
    node(1001, 260, -8, { highway: 'bus_stop', bench: 'yes', shelter: 'yes' }), // beside 100:2
    node(1002, 40, -5, { amenity: 'toilets', access: 'private' }),              // private: ignored
    node(1003, 100, 45, { tourism: 'viewpoint', name: 'Overlook' }),            // 45 m from 100:0
    node(1004, 150, 400, { tourism: 'artwork', name: 'Far Away' }),             // nowhere near
    { type: 'way', id: 1005, center: { lon: at(170, 150)[0], lat: at(170, 150)[1] }, tags: { amenity: 'toilets' } },
    node(1006, 160, 120, { amenity: 'drinking_water', drinking_water: 'no' }), // not drinkable
    // River 25 m south of the footway.
    { type: 'way', id: 2000, tags: { waterway: 'river' }, geometry: [at(-50, -25), at(350, -25)].map(([lon, lat]) => ({ lon, lat })) },
    // Park split into two member ways that must be joined into one ring.
    { type: 'relation', id: 3000, tags: { leisure: 'park', name: 'Branch Park' }, members: [
      { type: 'way', role: 'outer', geometry: [at(120, 50), at(180, 50), at(180, 250)].map(([lon, lat]) => ({ lon, lat })) },
      { type: 'way', role: 'outer', geometry: [at(120, 50), at(120, 250), at(180, 250)].map(([lon, lat]) => ({ lon, lat })) },
    ] },
  ],
};

test('places are classified, deduplicated and filtered', () => {
  const kinds = extractPlaces(features).map((p) => `${p.properties.osm}:${p.properties.kind}`).sort();
  assert.deepEqual(kinds, ['node/1000:bench', 'node/1001:bench', 'node/1001:shelter', 'node/1003:viewpoint', 'node/1004:artwork', 'way/1005:toilets']);
});

test('ring assembly joins reversed member ways', () => {
  const rings = assembleRings([[[0, 0], [1, 0], [1, 1]], [[0, 0], [0, 1], [1, 1]]]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
});

test('amenities, viewpoints, water and parks attach to nearby segments', () => {
  const list = segs();
  enrichPlaces(list, extractPlaces(features));
  enrichAreas(list, extractAreas(features));
  const s = byId(list);
  assert.equal(s['100:0'].properties.n_bench, 1);
  assert.equal(s['100:0'].properties.n_toilets, 0);
  assert.equal(s['100:0'].properties.n_viewpoint, 1);
  assert.equal(s['100:2'].properties.n_bench, 1);
  assert.equal(s['100:2'].properties.n_shelter, 1);
  assert.equal(s['100:2'].properties.n_amenities, 2);
  assert.equal(s['200:0'].properties.n_toilets, 1);
  assert.equal(s['200:0'].properties.n_water, 0);
  assert.equal(s['200:0'].properties.n_poi, 0);
  assert.equal(s['100:0'].properties.water_pct, 100);
  assert.equal(s['200:0'].properties.water_pct, 10); // 2 of 21 points (0 m and 10 m) are within 40 m of the river
  assert.equal(s['200:0'].properties.park, 'Branch Park');
  assert.ok(s['200:0'].properties.park_pct >= 70 && s['200:0'].properties.park_pct <= 80);
  assert.equal(s['100:0'].properties.park_pct, 0);
});

test('densify spaces points evenly and keeps both ends', () => {
  const straight = densify([at(0, 0), at(63, 0)], 10);
  assert.equal(straight.length, 8); // 0,10,…,60 plus the end at 63
  for (let i = 1; i < 7; i++) assert.ok(Math.abs(haversine(straight[0], straight[i]) - 10 * i) < 0.01);
  // Spacing is measured along the line, carrying across vertices.
  const bent = densify([at(0, 0), at(23, 0), at(23, 40)], 10);
  assert.equal(bent.length, 8);
  assert.ok(Math.abs(haversine(bent[3], at(23, 7))) < 0.01);
  assert.deepEqual(bent[bent.length - 1], at(23, 40));
});

test('shade is the share of points with enough nearby canopy', async () => {
  const list = segs();
  // Synthetic raster at 1 m per pixel: trees west of x=150 m, bare ground east of it.
  const source = {
    locate(lon, lat) { return { key: 't', x: Math.round((lon - LON0) / M_LON) + 1000, y: Math.round((LAT0 - lat) / M_LAT) + 1000, metersPerPx: 1 }; },
    async readWindow(key, x0, y0, x1, y1) {
      const w = x1 - x0, data = new Uint8Array(w * (y1 - y0));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data[(y - y0) * w + (x - x0)] = x < 1150 ? 12 : 0;
      return { data, width: w };
    },
  };
  await enrichCanopy(list, source);
  const s = byId(list);
  assert.equal(s['100:0'].properties.shade_pct, 100);
  assert.equal(s['100:2'].properties.shade_pct, 3); // only the first 5 m station (x=150, half-disk of trees) is shaded
  assert.equal(s['200:0'].properties.shade_pct, 100); // runs right along the tree line: half of every disk is canopy
});

test('missing canopy tiles leave shade blank rather than zero', async () => {
  const list = segs();
  await enrichCanopy(list, { locate: () => ({ key: 'x', x: 0, y: 0, metersPerPx: 1 }), readWindow: async () => null });
  assert.equal(list[0].properties.shade_pct, null);
});

test('Meta canopy tiles are addressed by zoom-9 quadkey', () => {
  const src = metaCanopySource();
  const loc = src.locate(-119.832, 39.5214);
  assert.equal(loc.key, '023010121'); // the tile that covers central Reno
  assert.ok(loc.x >= 0 && loc.x < 65536 && loc.y >= 0 && loc.y < 65536);
  assert.equal(quadkey(0, 0, 1), '0');
  assert.equal(quadkey(1, 1, 1), '3');
});

test('slope: steepest 30 m grade, climb and descent; bridges left blank', async () => {
  const list = segs();
  // Ground rises 5% to the north, flat east–west.
  const source = { prepare: async () => {}, sample: (lon, lat) => 1400 + ((lat - LAT0) / M_LAT) * 0.05 };
  await enrichElevation(list, source);
  const s = byId(list);
  assert.equal(s['100:0'].properties.grade_max_pct, 0);
  assert.ok(Math.abs(s['200:0'].properties.grade_max_pct - 5) < 0.2);
  assert.ok(Math.abs(s['200:0'].properties.climb_m - 10) < 0.2);
  assert.equal(s['200:0'].properties.descent_m, 0);
  assert.equal(s['400:0'].properties.grade_max_pct, null);
});

test('command-line options', () => {
  const o = parseArgs(['--bbox', '39.5,-119.9,39.6,-119.8', '--no-canopy', '--statuses', 'candidate']);
  assert.deepEqual(o.bbox, [39.5, -119.9, 39.6, -119.8]);
  assert.equal(o.canopy, false);
  assert.equal(o.elevation, true);
  assert.deepEqual(o.statuses, ['candidate']);
  assert.throws(() => parseArgs(['--bogus']));
  assert.ok(haversine(at(0, 0), at(0, 100)) > 99.9);
});

test('build script writes network, places and metadata from saved Overpass files', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reno-build-'));
  fs.writeFileSync(path.join(dir, 'network.json'), JSON.stringify(network));
  fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify(features));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-network.js'),
    '--network', path.join(dir, 'network.json'), '--features', path.join(dir, 'features.json'),
    '--no-canopy', '--no-elevation', '--out', path.join(dir, 'out')], { stdio: 'pipe' });
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, 'out', f), 'utf8'));
  const paths = read('walking-paths.geojson'), streets = read('walking-streets.geojson');
  const net = { features: paths.features.concat(streets.features) };
  const places = read('places.geojson'), meta = read('network-meta.json');
  assert.deepEqual(paths.features.map((f) => f.id).sort(), ['100:0', '100:2', '200:0']);
  assert.deepEqual(streets.features.map((f) => f.id), ['400:0']);
  assert.equal(net.features.length, 4);
  assert.equal(places.features.length, 6);
  assert.equal(meta.counts.segments, 4);
  assert.deepEqual(meta.sources.map((s) => s.name), ['OpenStreetMap']);
  const seg = net.features.find((f) => f.id === '100:2');
  assert.equal(seg.properties.n_shelter, 1);
  // Web output drops graph bookkeeping and zero counts, but keeps "not measured".
  assert.equal(seg.properties.way_id, undefined);
  assert.equal(seg.properties.n_toilets, undefined);
  assert.equal(seg.properties.n_picnic, undefined);
  fs.rmSync(dir, { recursive: true });
});

test('web features drop zeros and bookkeeping, round coordinates, keep shade and grade', () => {
  const { webFeature } = require('../scripts/lib/web');
  const f = webFeature({ type: 'Feature', id: '7:0', geometry: { type: 'LineString', coordinates: [[-119.8000001, 39.5], [-119.8000002, 39.5000001]] },
    properties: { way_id: 7, from: 1, to: 2, component: 1, highway: 'path', n_bench: 0, n_water: 2, shade_pct: 0, grade_max_pct: null, climb_m: null } });
  assert.deepEqual(f.properties, { highway: 'path', n_water: 2, shade_pct: 0, grade_max_pct: null });
  assert.deepEqual(f.geometry.coordinates, [[-119.8, 39.5], [-119.8, 39.5]]); // duplicates collapse but stay drawable
});
