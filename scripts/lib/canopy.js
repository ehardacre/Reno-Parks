'use strict';
// Shade from tree canopy height.
//
// Source: Meta & World Resources Institute "High Resolution Canopy Height Maps"
// (Tolan et al. 2024), ~1.2 m pixels, height in meters, CC BY 4.0. Hosted as one
// GeoTIFF per zoom-9 Web Mercator tile in a public S3 bucket, read with HTTP range
// requests so we never download a whole 300 MB tile.
//
// For each point every 5 m along a segment we look at a disk around it and call the
// point "shaded" if at least 20% of that disk has canopy at least 3 m tall. Roads get a
// wider disk because they are mapped down the middle while people walk on the side.
const { densify } = require('./geo');

const BASE = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float';
const TREE_M = 3;          // canopy at least this tall counts as a tree
const SHADED_SHARE = 0.2;  // share of the disk that must be tree for the point to count as shaded
const STATION_M = 5;
const BAND = 256;          // rows read per request
const ROADS = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/;
const diskRadius = (props) => (ROADS.test(props.highway) && props.footway !== 'sidewalk' ? 9 : 5);

// --- Meta/WRI source ------------------------------------------------------------
const EARTH = 6378137;
const WORLD = 2 * Math.PI * EARTH;
const ZOOM = 9;
const TILE_M = WORLD / 2 ** ZOOM;
const TILE_PX = 65536;
const RES = TILE_M / TILE_PX; // ≈1.194 m in Web Mercator units

function mercator(lon, lat) {
  return [(lon * Math.PI / 180) * EARTH, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * EARTH];
}

function quadkey(tx, ty, z) {
  let q = '';
  for (let i = z; i > 0; i--) {
    const m = 1 << (i - 1);
    q += ((tx & m) ? 1 : 0) + ((ty & m) ? 2 : 0);
  }
  return q;
}

function metaCanopySource({ base = BASE, log = () => {} } = {}) {
  let geotiff;
  const images = new Map();
  async function image(key) {
    if (!images.has(key)) {
      images.set(key, (async () => {
        geotiff = geotiff || require('geotiff');
        try {
          const tiff = await geotiff.fromUrl(`${base}/chm/${key}.tif`, { blockSize: 1 << 20 });
          return await tiff.getImage();
        } catch (err) {
          log(`  canopy tile ${key} unavailable (${err.message}); treating as no data`);
          return null;
        }
      })());
    }
    return images.get(key);
  }
  return {
    attribution: 'Canopy height: Meta & World Resources Institute, CC BY 4.0',
    locate(lon, lat) {
      const [x, y] = mercator(lon, lat);
      const tx = Math.floor((x + WORLD / 2) / TILE_M), ty = Math.floor((WORLD / 2 - y) / TILE_M);
      const minX = tx * TILE_M - WORLD / 2, maxY = WORLD / 2 - ty * TILE_M;
      return { key: quadkey(tx, ty, ZOOM), x: Math.floor((x - minX) / RES), y: Math.floor((maxY - y) / RES), metersPerPx: RES * Math.cos((lat * Math.PI) / 180) };
    },
    // Returns heights for the window [x0, x1) × [y0, y1); out-of-tile pixels are 0.
    async readWindow(key, x0, y0, x1, y1) {
      const img = await image(key);
      if (!img) return null;
      const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(TILE_PX, x1), cy1 = Math.min(TILE_PX, y1);
      const w = x1 - x0, out = new Uint8Array(w * (y1 - y0));
      if (cx1 <= cx0 || cy1 <= cy0) return { data: out, width: w };
      const [band] = await img.readRasters({ window: [cx0, cy0, cx1, cy1] });
      const bw = cx1 - cx0;
      for (let r = 0; r < cy1 - cy0; r++) out.set(band.subarray(r * bw, (r + 1) * bw), (r + cy0 - y0) * w + (cx0 - x0));
      return { data: out, width: w };
    },
  };
}

// --- Enrichment -----------------------------------------------------------------
async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

async function enrichCanopy(segments, source, { log = () => {}, concurrency = 4 } = {}) {
  const buckets = new Map();
  const totals = new Uint32Array(segments.length), shaded = new Uint32Array(segments.length);
  segments.forEach((seg, i) => {
    const radiusM = diskRadius(seg.properties);
    for (const [lon, lat] of densify(seg.geometry.coordinates, STATION_M)) {
      const loc = source.locate(lon, lat);
      const r = Math.max(1, Math.round(radiusM / loc.metersPerPx));
      const k = `${loc.key}|${Math.floor(loc.y / BAND)}`;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = { key: loc.key, band: Math.floor(loc.y / BAND), stations: [] }));
      b.stations.push({ seg: i, x: loc.x, y: loc.y, r });
      totals[i]++;
    }
  });

  let done = 0;
  const list = [...buckets.values()];
  await pool(list, concurrency, async (b) => {
    const rMax = Math.max(...b.stations.map((s) => s.r));
    const x0 = Math.min(...b.stations.map((s) => s.x)) - rMax, x1 = Math.max(...b.stations.map((s) => s.x)) + rMax + 1;
    const y0 = b.band * BAND - rMax, y1 = (b.band + 1) * BAND + rMax;
    const win = await source.readWindow(b.key, x0, y0, x1, y1);
    if (win) {
      for (const s of b.stations) {
        let tree = 0, all = 0;
        for (let dy = -s.r; dy <= s.r; dy++) {
          const row = (s.y + dy - y0) * win.width;
          for (let dx = -s.r; dx <= s.r; dx++) {
            if (dx * dx + dy * dy > s.r * s.r) continue;
            all++;
            if (win.data[row + s.x + dx - x0] >= TREE_M) tree++;
          }
        }
        if (tree / all >= SHADED_SHARE) shaded[s.seg]++;
      }
    } else {
      for (const s of b.stations) totals[s.seg]--; // no data: leave out of the share
    }
    if (++done % 25 === 0 || done === list.length) log(`  canopy: ${done}/${list.length} raster bands`);
  });

  segments.forEach((seg, i) => {
    seg.properties.shade_pct = totals[i] ? Math.round((100 * shaded[i]) / totals[i]) : null;
  });
}

module.exports = { enrichCanopy, metaCanopySource, quadkey, mercator, diskRadius, TREE_M, SHADED_SHARE };
