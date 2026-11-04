'use strict';
// Attach nearby places and scenery measures to each segment's properties.
const { GridIndex, bbox, padBbox, pointLineDistance, pointSegmentDistance, densify, pointInRing } = require('./geo');

// How far from the segment's center line a place still counts as "along the route".
// Roads are mapped down the middle, so a sidewalk bench sits ~8–12 m off the line.
const RADIUS_M = {
  bench: 20, picnic: 25, shelter: 25, toilets: 50, water: 25,
  viewpoint: 60, peak: 60,
  artwork: 50, attraction: 60, museum: 60, historic: 50, water_feature: 60, fountain: 40, info_board: 25,
};
const MAX_RADIUS = Math.max(...Object.values(RADIUS_M));

// Property names for amenity counts (kept flat so map styles can use them).
const COUNT_KEY = { bench: 'n_bench', picnic: 'n_picnic', shelter: 'n_shelter', toilets: 'n_toilets', water: 'n_water' };

function enrichPlaces(segments, places) {
  const index = new GridIndex(0.002);
  for (const p of places) index.insert(padBbox(bbox([p.geometry.coordinates]), 0), p);

  for (const seg of segments) {
    const coords = seg.geometry.coordinates;
    const props = seg.properties;
    for (const k of Object.values(COUNT_KEY)) props[k] = 0;
    const amenityIds = [], poiIds = [];
    let viewpoints = 0, pois = 0;
    for (const p of index.query(padBbox(bbox(coords), MAX_RADIUS))) {
      const { kind, category } = p.properties;
      if (pointLineDistance(p.geometry.coordinates, coords) > RADIUS_M[kind]) continue;
      if (category === 'amenity') { props[COUNT_KEY[kind]]++; amenityIds.push(p.id); }
      else { poiIds.push(p.id); if (category === 'viewpoint') viewpoints++; else pois++; }
    }
    props.n_amenities = amenityIds.length;
    props.n_viewpoint = viewpoints;
    props.n_poi = pois;
    // Lists are only written when non-empty, to keep the output file small.
    if (amenityIds.length) props.amenity_ids = amenityIds;
    if (poiIds.length) props.poi_ids = poiIds;
  }
}

const WATER_M = 40; // a walk within ~40 m of a river or pond shore counts as "by the water"
const STATION_M = 10;

function enrichAreas(segments, { water, green }) {
  // Index water as individual line pieces so long rivers don't swamp every query.
  const waterIndex = new GridIndex(0.002);
  for (const line of water) {
    for (let i = 1; i < line.length; i++) waterIndex.insert(bbox([line[i - 1], line[i]]), [line[i - 1], line[i]]);
  }
  const greenIndex = new GridIndex(0.01);
  for (const g of green) { g.box = bbox(g.ring); greenIndex.insert(g.box, g); }

  for (const seg of segments) {
    const stations = densify(seg.geometry.coordinates, STATION_M);
    let nearWater = 0, inGreen = 0;
    const parkNames = new Set();
    for (const s of stations) {
      for (const [a, b] of waterIndex.query(padBbox([s[0], s[1], s[0], s[1]], WATER_M))) {
        if (pointSegmentDistance(s, a, b) <= WATER_M) { nearWater++; break; }
      }
      for (const g of greenIndex.query([s[0], s[1], s[0], s[1]])) {
        const [w, so, e, n] = g.box;
        if (s[0] < w || s[0] > e || s[1] < so || s[1] > n) continue;
        if (pointInRing(s, g.ring)) { inGreen++; if (g.name) parkNames.add(g.name); break; }
      }
    }
    seg.properties.water_pct = Math.round((100 * nearWater) / stations.length);
    seg.properties.park_pct = Math.round((100 * inGreen) / stations.length);
    if (parkNames.size) seg.properties.park = [...parkNames].join('; ');
  }
}

module.exports = { enrichPlaces, enrichAreas, RADIUS_M, COUNT_KEY };
