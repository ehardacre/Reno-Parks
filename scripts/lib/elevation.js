'use strict';
// Slope from a digital elevation model.
//
// Source: AWS Terrain Tiles (Tilezen "terrarium" PNG encoding) at zoom 14, about 7 m
// per pixel in Reno. In the US these come from USGS 3DEP. Tiles are cached on disk.
const fs = require('fs');
const path = require('path');
const { densify, haversine } = require('./geo');

const STATION_M = 10;
const WINDOW_M = 30;   // steepest grade is measured over stretches at least this long
const ZOOM = 14;

function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return [x, y];
}

function terrariumSource({ cacheDir, zoom = ZOOM, log = () => {}, concurrency = 8 } = {}) {
  const { PNG } = require('pngjs');
  const tiles = new Map();
  const url = (x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`;

  async function load(x, y) {
    const file = cacheDir && path.join(cacheDir, String(zoom), String(x), `${y}.png`);
    let buf;
    if (file && fs.existsSync(file)) buf = fs.readFileSync(file);
    else {
      const res = await fetch(url(x, y));
      if (!res.ok) throw Error(`terrain tile ${zoom}/${x}/${y}: HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buf); }
    }
    const png = PNG.sync.read(buf);
    const elev = new Float32Array(256 * 256);
    for (let i = 0; i < elev.length; i++) {
      elev[i] = png.data[i * 4] * 256 + png.data[i * 4 + 1] + png.data[i * 4 + 2] / 256 - 32768;
    }
    tiles.set(`${x}/${y}`, elev);
  }

  function pixel(px, py) {
    const n = 2 ** zoom * 256;
    px = Math.min(Math.max(px, 0), n - 1); py = Math.min(Math.max(py, 0), n - 1);
    const t = tiles.get(`${Math.floor(px / 256)}/${Math.floor(py / 256)}`);
    return t[(py % 256) * 256 + (px % 256)];
  }

  return {
    attribution: 'Elevation: AWS Terrain Tiles (USGS 3DEP and others)',
    async prepare(points) {
      const need = new Set();
      for (const [lon, lat] of points) {
        const [x, y] = tileXY(lon, lat, zoom).map((v) => v * 256);
        // Bilinear sampling can touch the neighbor tile, so include all four corners.
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          need.add(`${Math.floor((x - 0.5 + dx) / 256)}/${Math.floor((y - 0.5 + dy) / 256)}`);
        }
      }
      const todo = [...need].filter((k) => !tiles.has(k)).map((k) => k.split('/').map(Number));
      log(`  elevation: ${todo.length} tiles`);
      let i = 0;
      await Promise.all(Array.from({ length: concurrency }, async () => {
        while (i < todo.length) { const [x, y] = todo[i++]; await load(x, y); }
      }));
    },
    sample(lon, lat) {
      const [tx, ty] = tileXY(lon, lat, zoom);
      const x = tx * 256 - 0.5, y = ty * 256 - 0.5; // pixel centers
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const top = pixel(x0, y0) * (1 - fx) + pixel(x0 + 1, y0) * fx;
      const bottom = pixel(x0, y0 + 1) * (1 - fx) + pixel(x0 + 1, y0 + 1) * fx;
      return top * (1 - fy) + bottom * fy;
    },
  };
}

// Bridges and tunnels don't follow the ground, so a terrain model can't grade them.
const offGround = (p) => (p.bridge && p.bridge !== 'no') || (p.tunnel && p.tunnel !== 'no');

async function enrichElevation(segments, source, { log = () => {} } = {}) {
  const stationsBySeg = segments.map((s) => (offGround(s.properties) ? null : densify(s.geometry.coordinates, STATION_M)));
  await source.prepare(stationsBySeg.flatMap((s) => s || []));
  log('  elevation: sampling');
  segments.forEach((seg, i) => {
    const pts = stationsBySeg[i];
    const p = seg.properties;
    if (!pts) { p.grade_max_pct = p.climb_m = p.descent_m = null; return; }
    const raw = pts.map(([lon, lat]) => source.sample(lon, lat));
    // Light smoothing removes single-pixel DEM noise without flattening real hills.
    // Endpoints stay raw so a steady slope keeps its full rise.
    const elev = raw.map((v, j) => (j === 0 || j === raw.length - 1 ? v : (raw[j - 1] + v + raw[j + 1]) / 3));
    const along = [0];
    for (let j = 1; j < pts.length; j++) along.push(along[j - 1] + haversine(pts[j - 1], pts[j]));
    let climb = 0, descent = 0;
    for (let j = 1; j < elev.length; j++) {
      const d = elev[j] - elev[j - 1];
      if (d > 0) climb += d; else descent -= d;
    }
    const total = along[along.length - 1];
    let maxGrade = 0;
    if (total <= WINDOW_M) {
      maxGrade = total > 0 ? Math.abs(elev[elev.length - 1] - elev[0]) / total : 0;
    } else {
      for (let a = 0, b = 0; a < pts.length; a++) {
        while (b < pts.length - 1 && along[b] - along[a] < WINDOW_M) b++;
        if (along[b] - along[a] < WINDOW_M) break;
        maxGrade = Math.max(maxGrade, Math.abs(elev[b] - elev[a]) / (along[b] - along[a]));
      }
    }
    p.elev_m = Math.round((elev[0] + elev[elev.length - 1]) / 2);
    p.grade_max_pct = Math.round(maxGrade * 1000) / 10;
    p.climb_m = Math.round(climb * 10) / 10;
    p.descent_m = Math.round(descent * 10) / 10;
  });
}

module.exports = { enrichElevation, terrariumSource, tileXY, WINDOW_M };
