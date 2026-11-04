#!/usr/bin/env node
'use strict';
// Score each curated park in parks.geojson on its walking resources.
//
// Reads what `npm run build:network` left behind (no downloads):
//   data/cache/walking-network-full.geojson   every segment, with shade, slope, etc.
//   data/cache/park-boundaries.geojson        OSM park outlines
//   data/places.geojson                       benches, restrooms, viewpoints…
//   park-boundaries.json                      optional hand fixes for park matching
// Writes:
//   data/park-scores.geojson   one feature per park: its area, summary and score
//
// Usage: npm run build:parks [-- --out DIR]

const fs = require('fs');
const path = require('path');
const { matchPark, segmentsIn, placesIn, summarize, indexSegments } = require('./lib/parks');
const { scorePark, WEIGHTS } = require('./lib/park-score');

const ROOT = path.join(__dirname, '..');

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw Error(`${path.relative(ROOT, file)} is missing; run \`npm run build:network\` first`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function circle([lon, lat], meters, steps = 48) {
  const dy = meters / 111195, dx = dy / Math.cos((lat * Math.PI) / 180);
  const ring = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / steps;
    return [Math.round((lon + dx * Math.cos(a)) * 1e6) / 1e6, Math.round((lat + dy * Math.sin(a)) * 1e6) / 1e6];
  });
  return { type: 'Polygon', coordinates: [ring] };
}

function geometryFor(match, segs) {
  if (match.rings) return { type: 'MultiPolygon', coordinates: match.rings.map((r) => [r]) };
  if (match.method === 'radius') return circle(match.center, match.radius_m);
  return { type: 'MultiLineString', coordinates: segs.map((s) => s.geometry.coordinates) };
}

const yes = (v) => /^yes/i.test(String(v || ''));

function buildParks({ root = ROOT, out = path.join(ROOT, 'data'), log = console.log } = {}) {
  const parks = readJson(path.join(root, 'parks.geojson')).features;
  const cache = path.join(out, 'cache');
  const segments = readJson(path.join(cache, 'walking-network-full.geojson')).features;
  const boundaries = readJson(path.join(cache, 'park-boundaries.geojson'), null)?.features;
  if (!boundaries) log('note: no park outlines yet (rerun `npm run build:network`); parks will use trails or a radius around their pin');
  const places = readJson(path.join(out, 'places.geojson')).features;
  const overrides = readJson(path.join(root, 'park-boundaries.json'), { overrides: {} }).overrides || {};

  const segIndex = indexSegments(segments);
  const byOsm = new Map((boundaries || []).map((f) => [f.properties.osm, f]));
  const results = [];
  for (const park of parks) {
    const id = park.properties.id;
    const match = matchPark(park, { boundaries: boundaries || [], segIndex, byOsm, override: overrides[id] });
    const segs = segmentsIn(match, segIndex);
    const placeList = placesIn(match, segs, places);
    const summary = summarize(segs, placeList, match);
    const { score, parts } = scorePark(summary);
    // Where OSM and the printed guide disagree, someone should look.
    const checks = [];
    if (yes(park.properties.restrooms) && !summary.restrooms) checks.push('guide says restrooms, none mapped in OSM');
    if (!yes(park.properties.restrooms) && summary.restrooms) checks.push('OSM has restrooms the guide does not list');
    if (yes(park.properties.benches) && !summary.benches) checks.push('guide says benches, none mapped in OSM');
    if (!segs.length) checks.push('no walking segments found');
    if (match.method === 'radius') checks.push(`no outline or trail matched; used ${match.radius_m} m around the pin`);
    results.push({
      type: 'Feature', id,
      geometry: geometryFor(match, segs),
      properties: {
        id, name: park.properties.name, score, parts,
        match: match.method, matched: match.names || null, osm: match.osm || null,
        ...summary, checks,
      },
    });
  }
  results.sort((a, b) => b.properties.score - a.properties.score);
  fs.writeFileSync(path.join(out, 'park-scores.geojson'), JSON.stringify({
    type: 'FeatureCollection', built_at: new Date().toISOString(), weights: WEIGHTS, features: results,
  }));
  return results;
}

function report(results, log = console.log) {
  const pad = (v, n) => String(v ?? '–').padEnd(n).slice(0, n);
  const num = (v, n) => String(v ?? '–').padStart(n);
  log(`\n${pad('Park', 34)} ${num('Score', 5)}  ${pad('Matched by', 10)} ${num('km', 5)} ${num('shade', 5)} ${num('<5%', 4)} ${num('WC', 3)} ${num('bench', 5)} ${num('loops', 5)} ${num('sights', 6)}`);
  for (const { properties: p } of results) {
    log(`${pad(p.name, 34)} ${num(p.score, 5)}  ${pad(p.match, 10)} ${num(p.km_total, 5)} ${num(p.shade_pct == null ? null : p.shade_pct + '%', 5)} ${num(p.under_5_pct == null ? null : p.under_5_pct + '%', 4)} ${num(p.restrooms, 3)} ${num(p.benches, 5)} ${num(p.loops, 5)} ${num(p.viewpoints + p.sights, 6)}`);
  }
  const flagged = results.filter((r) => r.properties.checks.length);
  if (flagged.length) {
    log('\nWorth a look:');
    for (const { properties: p } of flagged) log(`  ${p.name} (id ${p.id}): ${p.checks.join('; ')}${p.matched ? ` [matched: ${p.matched.join(', ')}]` : ''}`);
    log('\nFix a wrong or missing match in park-boundaries.json, then rerun `npm run build:parks`.');
  }
}

if (require.main === module) {
  try {
    const outArg = process.argv.indexOf('--out');
    const results = buildParks(outArg > 0 ? { out: path.resolve(process.argv[outArg + 1]) } : {});
    report(results);
    console.log(`\nWrote data/park-scores.geojson (${results.length} parks).`);
  } catch (err) {
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { buildParks, report };
