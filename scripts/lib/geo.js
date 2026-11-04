'use strict';
// Small geometry helpers. Coordinates are [lon, lat] in degrees; distances in meters.
// Distances use a local equirectangular projection, which is accurate to well under
// 1% over the few-hundred-meter spans we measure.

const R = 6371000;
const RAD = Math.PI / 180;

function haversine([lon1, lat1], [lon2, lat2]) {
  const dlat = (lat2 - lat1) * RAD, dlon = (lon2 - lon1) * RAD;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

// Meters per degree at a latitude, for converting search radii into bbox padding.
const metersPerDegLat = R * RAD; // ≈111,195 m, consistent with haversine()
const metersPerDegLon = (lat) => metersPerDegLat * Math.cos(lat * RAD);

// Distance from point p to segment a-b, all [lon, lat].
function pointSegmentDistance(p, a, b) {
  const kx = metersPerDegLon(p[1]), ky = metersPerDegLat;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function pointLineDistance(p, coords) {
  if (coords.length === 1) return haversine(p, coords[0]);
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) best = Math.min(best, pointSegmentDistance(p, coords[i - 1], coords[i]));
  return best;
}

// Points every `step` meters along a line, always including both ends.
function densify(coords, step) {
  const out = [coords[0]];
  let carry = 0; // distance walked since the last emitted point
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const d = haversine(a, b);
    let t = step - carry;
    while (t < d) {
      const f = t / d;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      t += step;
    }
    carry = d - (t - step);
  }
  const last = coords[coords.length - 1];
  // Snap a point that landed just short of the end onto it, rather than keeping both.
  if (out.length > 1 && haversine(out[out.length - 1], last) < step * 0.25) out[out.length - 1] = last;
  else if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function bbox(coords) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
}

function padBbox([w, s, e, n], meters) {
  const dy = meters / metersPerDegLat, dx = meters / metersPerDegLon((s + n) / 2);
  return [w - dx, s - dy, e + dx, n + dy];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Uniform grid over degrees. Items are inserted by bbox; queries return candidates
// whose bbox cells overlap, deduplicated. Callers do the exact distance test.
class GridIndex {
  constructor(cellDeg = 0.002) { this.cell = cellDeg; this.cells = new Map(); }
  *keys([w, s, e, n]) {
    const c = this.cell;
    for (let x = Math.floor(w / c); x <= Math.floor(e / c); x++)
      for (let y = Math.floor(s / c); y <= Math.floor(n / c); y++) yield x + ',' + y;
  }
  insert(box, item) {
    for (const k of this.keys(box)) {
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(item);
    }
  }
  query(box) {
    const seen = new Set();
    for (const k of this.keys(box)) for (const item of this.cells.get(k) || []) seen.add(item);
    return seen;
  }
}

module.exports = {
  haversine, lineLength, pointSegmentDistance, pointLineDistance, densify,
  bbox, padBbox, pointInRing, GridIndex, metersPerDegLat, metersPerDegLon,
};
