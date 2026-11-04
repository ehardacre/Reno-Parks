'use strict';
// Turn the Overpass "features" response into:
//   places: point features (amenities, viewpoints, points of interest)
//   areas:  water lines/outlines and park polygons, used for scenery scores

// Categories drive map colors; kinds are what a walker cares about.
const CATEGORY = {
  bench: 'amenity', picnic: 'amenity', shelter: 'amenity', toilets: 'amenity', water: 'amenity',
  viewpoint: 'viewpoint', peak: 'viewpoint',
  artwork: 'poi', attraction: 'poi', museum: 'poi', historic: 'poi',
  water_feature: 'poi', fountain: 'poi', info_board: 'poi',
};

const LABEL = {
  bench: 'Bench', picnic: 'Picnic table', shelter: 'Shelter', toilets: 'Restroom', water: 'Drinking water',
  viewpoint: 'Viewpoint', peak: 'Summit', artwork: 'Public art', attraction: 'Attraction', museum: 'Museum',
  historic: 'Historic site', water_feature: 'Waterfall or spring', fountain: 'Fountain', info_board: 'Interpretive sign',
};

const closed = (t) => ['private', 'no'].includes(t.access);

// One OSM element can be several things (a bus stop with bench=yes and shelter=yes).
function kindsOf(t) {
  const k = [];
  if (!closed(t)) {
    if (t.amenity === 'bench' || t.leisure === 'bench' || t.bench === 'yes') k.push('bench');
    if (t.leisure === 'picnic_table' || t.tourism === 'picnic_site') k.push('picnic');
    if (t.amenity === 'shelter' || t.shelter === 'yes') k.push('shelter');
    if (t.amenity === 'toilets') k.push('toilets');
    if (t.drinking_water !== 'no' && (t.amenity === 'drinking_water' || t.amenity === 'water_point' ||
        (t.man_made === 'water_tap' && t.drinking_water === 'yes') ||
        (t.amenity === 'fountain' && t.drinking_water === 'yes'))) k.push('water');
  }
  if (t.tourism === 'viewpoint') k.push('viewpoint');
  if (t.natural === 'peak') k.push('peak');
  if (t.tourism === 'artwork') k.push('artwork');
  if (t.tourism === 'attraction') k.push('attraction');
  if (t.tourism === 'museum') k.push('museum');
  if (t.historic && t.historic !== 'no') k.push('historic');
  if (t.natural === 'waterfall' || t.natural === 'spring') k.push('water_feature');
  if (t.amenity === 'fountain' && t.drinking_water !== 'yes') k.push('fountain');
  if (t.tourism === 'information' && t.information === 'board') k.push('info_board');
  return k;
}

const PLACE_TAGS = ['name', 'description', 'opening_hours', 'wheelchair', 'backrest', 'covered', 'fee', 'seasonal', 'artist_name', 'ele', 'direction'];

function pointOf(e) {
  if (e.type === 'node') return [e.lon, e.lat];
  if (e.center) return [e.center.lon, e.center.lat];
  return null;
}

function extractPlaces(raw) {
  const out = [];
  const seen = new Set();
  for (const e of raw.elements || []) {
    if (!e.tags) continue;
    const pt = pointOf(e);
    if (!pt) continue;
    for (const kind of kindsOf(e.tags)) {
      const id = `${e.type[0]}${e.id}:${kind}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const props = { kind, category: CATEGORY[kind], label: LABEL[kind], osm: `${e.type}/${e.id}` };
      for (const k of PLACE_TAGS) if (e.tags[k] !== undefined) props[k] = e.tags[k];
      if (kind === 'historic') props.historic = e.tags.historic;
      out.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates: pt }, properties: props });
    }
  }
  return out;
}

const isWater = (t) => t.natural === 'water' || t.waterway === 'riverbank' || /^(river|stream|canal)$/.test(t.waterway || '');
const isGreen = (t) => /^(park|nature_reserve|garden)$/.test(t.leisure || '');

const lineOf = (geometry) => (geometry || []).filter(Boolean).map((p) => [p.lon, p.lat]);
const sameNode = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

// Join multipolygon member ways end-to-end into closed rings. Open leftovers are dropped.
function assembleRings(lines) {
  const pool = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    let grew = true;
    while (!sameNode(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i], end = ring[ring.length - 1];
        if (sameNode(end, l[0])) ring = ring.concat(l.slice(1));
        else if (sameNode(end, l[l.length - 1])) ring = ring.concat(l.slice(0, -1).reverse());
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && sameNode(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

function extractAreas(raw) {
  const water = []; // lines (rivers, shorelines)
  const green = []; // { ring, name }
  for (const e of raw.elements || []) {
    const t = e.tags || {};
    if (e.type === 'way' && e.geometry) {
      const line = lineOf(e.geometry);
      if (isWater(t)) water.push(line);
      if (isGreen(t) && line.length >= 4 && sameNode(line[0], line[line.length - 1])) green.push({ ring: line, name: t.name, osm: `way/${e.id}` });
    } else if (e.type === 'relation' && e.members) {
      const members = e.members.filter((m) => m.type === 'way' && m.geometry);
      if (isWater(t)) for (const m of members) water.push(lineOf(m.geometry));
      if (isGreen(t)) {
        const outers = members.filter((m) => m.role !== 'inner').map((m) => lineOf(m.geometry));
        for (const ring of assembleRings(outers)) green.push({ ring, name: t.name, osm: `relation/${e.id}` });
      }
    }
  }
  return { water: water.filter((l) => l.length > 1), green };
}

module.exports = { extractPlaces, extractAreas, kindsOf, assembleRings, CATEGORY, LABEL };
