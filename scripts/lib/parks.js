'use strict';
// Match each curated park to the OSM data around it, pick the walking segments and
// places that belong to it, and summarize them.
//
// A park's area comes from, in order:
//   1. an override in park-boundaries.json
//   2. OSM park outlines whose name matches the park's name, near its pin
//   3. for trails, network segments carrying the trail's name, near its pin
//   4. otherwise everything within RADIUS_M of the pin (flagged as approximate)
const { GridIndex, bbox, padBbox, densify, pointInRing, pointSegmentDistance, haversine, pointLineDistance } = require('./geo');

const NEAR_M = 2000;       // an outline or trail this far from the pin can still be the park
const RADIUS_M = 400;      // fallback area around the pin
const EDGE_M = 15;         // paths this close to the outline count as inside (edge walks)
const PLACE_EDGE_M = 30;   // amenities this close to the outline count
const PLACE_NEAR_M = 50;   // for trail and radius matches: amenities this close to a segment
const STATION_M = 10;
const TRAIL_TYPES = /^(footway|path|track|bridleway|cycleway|pedestrian|steps)$/;

// Words that don't help tell parks apart.
const STOP = new Set(['park', 'parks', 'regional', 'state', 'historic', 'area', 'areas', 'the', 'of', 'at', 'and', 'nevada', 'county',
  'access', 'city', 'trail', 'trails', 'paths', 'path', 'nature', 'study']);
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));

// Shared distinctive words over all distinctive words in either name, so "Huffaker
// Park" matches "Huffaker Park" (1) far better than "Huffaker Hills Open Space" (0.25).
// A curated name like "Wingfield Park / Downtown Riverwalk" is tried one part at a time.
function nameScore(curated, osm) {
  const b = new Set(tokens(osm));
  if (!b.size) return 0;
  return Math.max(0, ...String(curated).split('/').map((part) => {
    const a = new Set(tokens(part));
    if (!a.size) return 0;
    const shared = [...a].filter((t) => b.has(t)).length;
    return shared / new Set([...a, ...b]).size;
  }));
}

const rings = (f) => (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map((p) => p[0]) : [f.geometry.coordinates[0]]);
const insideAny = (pt, rs) => rs.some((r) => pointInRing(pt, r));
const edgeDistance = (pt, rs) => Math.min(...rs.map((r) => pointLineDistance(pt, r)));
const distanceTo = (pt, rs) => (insideAny(pt, rs) ? 0 : edgeDistance(pt, rs));

function ringAreaM2(ring) {
  const lat0 = ring[0][1], kx = 111195 * Math.cos((lat0 * Math.PI) / 180), ky = 111195;
  let a = 0;
  for (let i = 1; i < ring.length; i++) a += (ring[i - 1][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[i - 1][1] * ky);
  return Math.abs(a) / 2;
}

function indexSegments(segments) {
  const index = new GridIndex(0.005);
  for (const s of segments) index.insert(bbox(s.geometry.coordinates), s);
  return index;
}

// Pick the area for one park. Returns { method, rings?, segments, osm?, names?, note? }.
function matchPark(park, { boundaries, segIndex, byOsm, override }) {
  const pin = park.geometry.coordinates;
  const near = (meters) => padBbox([pin[0], pin[1], pin[0], pin[1]], meters);

  if (override?.osm) {
    const found = override.osm.map((id) => byOsm.get(id)).filter(Boolean);
    if (found.length) return { method: 'override', rings: found.flatMap(rings), osm: found.map((f) => f.properties.osm), names: [...new Set(found.map((f) => f.properties.name))], note: override.note };
  }
  if (!override?.trail && !override?.radius_m) {
    const scored = boundaries
      .map((f) => ({ f, score: nameScore(park.properties.name, f.properties.name) }))
      // More than half: "Dayton State Park" vs "Dayton Skate Park" is exactly half.
      .filter((c) => c.score > 0.5 && distanceTo(pin, rings(c.f)) <= NEAR_M);
    if (scored.length) {
      const best = Math.max(...scored.map((c) => c.score));
      const chosen = scored.filter((c) => c.score === best);
      return { method: 'outline', rings: chosen.flatMap((c) => rings(c.f)), osm: chosen.map((c) => c.f.properties.osm), names: [...new Set(chosen.map((c) => c.f.properties.name))] };
    }
  }
  if (!override?.radius_m) {
    const trailName = override?.trail || park.properties.name;
    // Only footpaths and trails: "Bartley Ranch Road" is not Bartley Ranch.
    const hits = [...segIndex.query(near(NEAR_M))].filter((s) => s.properties.name && TRAIL_TYPES.test(s.properties.highway) &&
      nameScore(trailName, s.properties.name) >= 0.6 &&
      pointLineDistance(pin, s.geometry.coordinates) <= NEAR_M);
    if (hits.length) return { method: 'trail', segments: hits, names: [...new Set(hits.map((s) => s.properties.name))] };
  }
  const r = override?.radius_m || RADIUS_M;
  return { method: 'radius', radius_m: r, center: pin };
}

// Segments with at least half their length inside (or right at the edge of) the area.
function segmentsIn(match, segIndex) {
  if (match.segments) return match.segments;
  let box, inside;
  if (match.method === 'radius') {
    box = padBbox([match.center[0], match.center[1], match.center[0], match.center[1]], match.radius_m);
    inside = (pt) => haversine(pt, match.center) <= match.radius_m;
  } else {
    box = padBbox(bbox(match.rings.flat()), EDGE_M);
    inside = (pt) => insideAny(pt, match.rings) || edgeDistance(pt, match.rings) <= EDGE_M;
  }
  return [...segIndex.query(box)].filter((s) => {
    const st = densify(s.geometry.coordinates, STATION_M);
    return st.filter(inside).length / st.length >= 0.5;
  });
}

function placesIn(match, segs, places) {
  if (match.rings) {
    const box = padBbox(bbox(match.rings.flat()), PLACE_EDGE_M);
    return places.filter((p) => {
      const pt = p.geometry.coordinates;
      if (pt[0] < box[0] || pt[0] > box[2] || pt[1] < box[1] || pt[1] > box[3]) return false;
      return insideAny(pt, match.rings) || edgeDistance(pt, match.rings) <= PLACE_EDGE_M;
    });
  }
  const index = new GridIndex(0.002);
  for (const s of segs) index.insert(padBbox(bbox(s.geometry.coordinates), PLACE_NEAR_M), s);
  return places.filter((p) => [...index.query(bbox([p.geometry.coordinates]))].some((s) => pointLineDistance(p.geometry.coordinates, s.geometry.coordinates) <= PLACE_NEAR_M));
}

// --- Summary --------------------------------------------------------------------
const PAVED = /^(asphalt|concrete|paved|paving_stones|concrete:plates|sett|wood|metal)$/;
const FIRM = /^(compacted|fine_gravel)$/;

function summarize(segs, placeList, match) {
  const km = (list) => Math.round(list.reduce((t, s) => t + s.properties.length_m, 0) / 100) / 10;
  const total = segs.reduce((t, s) => t + s.properties.length_m, 0);
  const share = (pred) => (total ? Math.round((100 * segs.filter((s) => pred(s.properties)).reduce((t, s) => t + s.properties.length_m, 0)) / total) : 0);
  const avg = (key) => {
    const has = segs.filter((s) => s.properties[key] != null);
    const len = has.reduce((t, s) => t + s.properties.length_m, 0);
    return len ? Math.round(has.reduce((t, s) => t + s.properties[key] * s.properties.length_m, 0) / len) : null;
  };
  const graded = segs.filter((s) => s.properties.grade_max_pct != null);
  const gradedLen = graded.reduce((t, s) => t + s.properties.length_m, 0);
  const gradeShare = (pred) => (gradedLen ? Math.round((100 * graded.filter((s) => pred(s.properties.grade_max_pct)).reduce((t, s) => t + s.properties.length_m, 0)) / gradedLen) : null);

  // Independent loops in the path graph (edges − nodes + components): 0 means every
  // walk is out-and-back; higher means more ways to wander and come back around.
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const s of segs) for (const n of [s.properties.from, s.properties.to]) if (!parent.has(n)) parent.set(n, n);
  for (const s of segs) parent.set(find(s.properties.from), find(s.properties.to));
  const components = new Set([...parent.keys()].map(find)).size;
  const loops = Math.max(0, segs.length - parent.size + components);

  const count = (kind) => placeList.filter((p) => p.properties.kind === kind).length;
  const sights = placeList.filter((p) => p.properties.category !== 'amenity');
  const paths = segs.filter((s) => s.properties.status === 'candidate');
  const access = segs.filter((s) => s.properties.status !== 'candidate' && s.properties.highway === 'service');
  const streets = segs.filter((s) => s.properties.status !== 'candidate' && s.properties.highway !== 'service');
  const area = match.rings ? Math.round(match.rings.reduce((t, r) => t + ringAreaM2(r), 0) / 1e4) : match.radius_m ? Math.round((Math.PI * match.radius_m ** 2) / 1e4) : null;

  return {
    area_ha: area,
    km_total: km(segs), km_paths: km(paths), km_streets: km(streets), km_access_roads: km(access),
    loops,
    shade_pct: avg('shade_pct'),
    under_3_pct: gradeShare((g) => g < 3), under_5_pct: gradeShare((g) => g < 5), over_8_pct: gradeShare((g) => g >= 8),
    steepest_pct: graded.length ? Math.max(...graded.map((s) => s.properties.grade_max_pct)) : null,
    paved_pct: share((p) => PAVED.test(p.surface || '')), firm_pct: share((p) => FIRM.test(p.surface || '')),
    unpaved_pct: share((p) => p.surface && !PAVED.test(p.surface) && !FIRM.test(p.surface)), surface_unknown_pct: share((p) => !p.surface),
    water_pct: total ? Math.round(segs.reduce((t, s) => t + (s.properties.water_pct || 0) * s.properties.length_m, 0) / total) : 0, // missing = not by water
    restrooms: count('toilets'), drinking_water: count('water'), benches: count('bench'), shelters: count('shelter'), picnic_tables: count('picnic'),
    viewpoints: placeList.filter((p) => p.properties.category === 'viewpoint').length,
    sights: sights.filter((p) => p.properties.category === 'poi').length,
    sight_names: [...new Set(sights.map((p) => p.properties.name).filter(Boolean))].slice(0, 12),
  };
}

module.exports = { matchPark, segmentsIn, placesIn, summarize, nameScore, tokens, rings, indexSegments, RADIUS_M };
