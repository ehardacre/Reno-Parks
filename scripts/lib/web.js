'use strict';
// Shrink segments for the browser. The full properties are useful while building,
// but the page only needs what it draws, and phones pay for every byte they parse.

// Graph bookkeeping the page doesn't use. The OSM way id is the part of the
// feature id before the colon.
const DROP = new Set(['way_id', 'from', 'to', 'component', 'elev_m']);
// Kept even when null or 0, because "no data" and "none" mean different things here.
const ALWAYS = new Set(['shade_pct', 'grade_max_pct']);
const round5 = (v) => Math.round(v * 1e5) / 1e5; // ~1 m
const SIMPLIFY_M = 1; // drop vertices that bend the line by less than this

// Douglas–Peucker simplification, measured in local meters.
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const kx = 111195 * Math.cos((pts[0][1] * Math.PI) / 180), ky = 111195;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0] * kx, ay = pts[a][1] * ky, dx = pts[b][0] * kx - ax, dy = pts[b][1] * ky - ay;
    const len2 = dx * dx + dy * dy;
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * kx - ax, py = pts[i][1] * ky - ay;
      const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - t * dx, py - t * dy);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function webFeature(f) {
  const properties = {};
  for (const [k, v] of Object.entries(f.properties)) {
    if (DROP.has(k)) continue;
    if (!ALWAYS.has(k) && (v === 0 || v === null || v === undefined)) continue;
    properties[k] = v;
  }
  const coords = [];
  for (const [x, y] of simplify(f.geometry.coordinates, SIMPLIFY_M)) {
    const c = [round5(x), round5(y)];
    const prev = coords[coords.length - 1];
    if (!prev || prev[0] !== c[0] || prev[1] !== c[1]) coords.push(c);
  }
  if (coords.length < 2) coords.push(coords[0]); // keep very short segments drawable
  return { type: 'Feature', id: f.id, geometry: { type: 'LineString', coordinates: coords }, properties };
}

module.exports = { webFeature, simplify };
