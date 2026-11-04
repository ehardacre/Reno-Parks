'use strict';
// Write the network as static vector tiles: data/tiles/{z}/{x}/{y}.pbf.
//
// A phone then downloads only the few tiles on screen instead of the whole network.
// At zoom 13 the smallest pieces are left out and only the fields used for coloring and
// filtering are kept; everything is in the street-level (zoom 14) tiles, which the map
// also uses for closer zooms.
const fs = require('fs');
const path = require('path');
const geojsonvt = require('geojson-vt');
const vtpbf = require('vt-pbf');
const { bbox } = require('./geo');

const LAYER = 'paths';
const MAX_ZOOM = 14;

// Fields needed to draw, filter and summarize at any zoom.
const STYLE_FIELDS = ['sid', 'name', 'status', 'highway', 'service', 'footway', 'surface', 'walk_access', 'length_m',
  'shade_pct', 'grade_max_pct', 'n_amenities', 'n_viewpoint', 'n_poi', 'water_pct', 'park_pct'];

const isMinorService = (p) => /^(parking_aisle|driveway|drive-through)$/.test(p.service || '');

// Which segments appear at which zooms, and whether they carry all their fields.
// Paths only matter once someone is looking at a neighborhood, so there are no tiles
// below zoom 13; zoomed out, the map shows just the parks.
const BANDS = [
  { zooms: [14, 14], full: true, keep: () => true },
  { zooms: [13, 13], keep: (p) => !isMinorService(p) && p.footway !== 'crossing' && p.length_m >= 15 },
];
const MIN_ZOOM = Math.min(...BANDS.map((b) => b.zooms[0]));

// Vector tiles hold only plain values, so lists become comma-separated strings.
function tileProperties(f, full) {
  const out = {};
  const props = { ...f.properties, sid: f.id };
  for (const [k, v] of Object.entries(props)) {
    if (!full && !STYLE_FIELDS.includes(k)) continue;
    out[k] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

function tileRange(box, z) {
  const n = 2 ** z;
  const x = (lon) => Math.floor(((lon + 180) / 360) * n);
  const y = (lat) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  const [w, s, e, nn] = box;
  return { x0: x(w), x1: x(e), y0: y(nn), y1: y(s) };
}

function writeTiles(features, dir, { log = () => {} } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  const box = bbox(features.flatMap((f) => f.geometry.coordinates));
  const stats = [];
  for (const band of BANDS) {
    const subset = features.filter((f) => band.keep(f.properties))
      .map((f) => ({ type: 'Feature', geometry: f.geometry, properties: tileProperties(f, band.full) }));
    const index = geojsonvt({ type: 'FeatureCollection', features: subset }, { maxZoom: band.zooms[1], indexMaxZoom: 0, tolerance: 3, buffer: 64 });
    for (let z = band.zooms[0]; z <= band.zooms[1]; z++) {
      const { x0, x1, y0, y1 } = tileRange(box, z);
      let count = 0, bytes = 0, largest = 0;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const tile = index.getTile(z, x, y);
          if (!tile || !tile.features.length) continue;
          const buf = Buffer.from(vtpbf.fromGeojsonVt({ [LAYER]: tile }, { version: 2 }));
          const file = path.join(dir, String(z), String(x), `${y}.pbf`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, buf);
          count++; bytes += buf.length; largest = Math.max(largest, buf.length);
        }
      }
      stats.push({ zoom: z, tiles: count, segments: subset.length, mb: Math.round(bytes / 1e5) / 10, largest_kb: Math.round(largest / 1e3) });
      log(`  zoom ${z}: ${count} tiles, ${(bytes / 1e6).toFixed(1)} MB, largest ${Math.round(largest / 1e3)} KB`);
    }
  }
  return { layer: LAYER, minzoom: MIN_ZOOM, maxzoom: MAX_ZOOM, zooms: stats.sort((a, b) => a.zoom - b.zoom) };
}

module.exports = { writeTiles, tileProperties, BANDS, LAYER, MIN_ZOOM, MAX_ZOOM };
