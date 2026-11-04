#!/usr/bin/env node
'use strict';
// Build the prebuilt walking network the map loads:
//   data/tiles/{z}/{x}/{y}.pbf    vector tiles of the network: shade, slope, amenities, scenery
//   data/cache/walking-network-full.geojson  the same segments with every field (not committed)
//   data/places.geojson           benches, restrooms, water, viewpoints, points of interest
//   data/network-meta.json        sources, snapshot dates, filters, counts
//
// Usage: npm run build:network -- [options]
//   --bbox S,W,N,E        area to build (default: the Reno area plus a 5 km box around
//                         each park in parks.geojson that lies outside it)
//   --network FILE        use a saved Overpass network response (e.g. the map's old
//                         "Export raw OSM" download) instead of fetching
//   --features FILE       use a saved Overpass features response instead of fetching
//   --refresh             ignore cached OSM downloads in data/cache
//   --statuses LIST       access statuses to keep (default: candidate,review)
//   --no-canopy           skip shade
//   --no-elevation        skip slope
//   --out DIR             output directory (default: data)

const fs = require('fs');
const path = require('path');
const { buildSegments } = require('./lib/segments');
const { extractPlaces, extractAreas, extractParkBoundaries } = require('./lib/osm-features');
const { enrichPlaces, enrichAreas } = require('./lib/enrich');
const { enrichCanopy, metaCanopySource } = require('./lib/canopy');
const { enrichElevation, terrariumSource } = require('./lib/elevation');
const { webFeature } = require('./lib/web');
const { writeTiles } = require('./lib/tiles');

const ROOT = path.join(__dirname, '..');
const RENO_BBOX = [39.35, -120.03, 39.72, -119.65];
const PARK_BUFFER_M = 5000;

// The Reno box, plus a box around every curated park outside it (Tahoe, Washoe Lake,
// Dayton…), so outlying parks get a network without downloading the desert between.
function defaultBoxes(parksFile = path.join(ROOT, 'parks.geojson')) {
  const boxes = [RENO_BBOX];
  if (!fs.existsSync(parksFile)) return boxes;
  const [s, w, n, e] = RENO_BBOX;
  for (const f of JSON.parse(fs.readFileSync(parksFile, 'utf8')).features) {
    const [lon, lat] = f.geometry.coordinates;
    if (lon >= w && lon <= e && lat >= s && lat <= n) continue;
    const dy = PARK_BUFFER_M / 111195, dx = dy / Math.cos((lat * Math.PI) / 180);
    boxes.push([lat - dy, lon - dx, lat + dy, lon + dx].map((v) => Math.round(v * 1e4) / 1e4));
  }
  return boxes;
}
const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

function parseArgs(argv) {
  const opts = { boxes: null, statuses: ['candidate', 'review'], canopy: true, elevation: true, refresh: false, out: path.join(ROOT, 'data') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--bbox') opts.boxes = [next().split(',').map(Number)];
    else if (a === '--network') opts.network = next();
    else if (a === '--features') opts.features = next();
    else if (a === '--statuses') opts.statuses = next().split(',');
    else if (a === '--refresh') opts.refresh = true;
    else if (a === '--no-canopy') opts.canopy = false;
    else if (a === '--no-elevation') opts.elevation = false;
    else if (a === '--out') opts.out = path.resolve(next());
    else throw Error(`Unknown option ${a}`);
  }
  if (opts.boxes && (opts.boxes[0].length !== 4 || opts.boxes[0].some(Number.isNaN))) throw Error('--bbox must be S,W,N,E');
  opts.boxes = opts.boxes || defaultBoxes();
  return opts;
}

// Repeat each statement for every box; Overpass merges the results.
const each = (boxes, statements) => boxes.flatMap((box) => statements.map((st) => `  ${st}(${box.join(',')});`)).join('\n');

// With one box this is the query the map's old inspector used, so its raw exports work as --network input.
const networkQuery = (boxes) => `[out:json][timeout:300];
(
${each(boxes, ['way["highway"]'])}
);
(._;>;);
out body qt;`;

const featuresQuery = (boxes) => `[out:json][timeout:300];
(
${each(boxes, [
    'nwr["amenity"~"^(bench|toilets|drinking_water|water_point|shelter|fountain)$"]',
    'nwr["leisure"~"^(picnic_table|bench)$"]',
    'nwr["tourism"~"^(viewpoint|artwork|attraction|museum|picnic_site)$"]',
    'nwr["tourism"="information"]["information"="board"]',
    'nwr["historic"]',
    'nwr["natural"~"^(peak|waterfall|spring)$"]',
    'node["man_made"="water_tap"]',
    'node["bench"="yes"]',
    'node["shelter"="yes"]',
  ])}
);
out center tags;
(
${each(boxes, [
    'way["waterway"~"^(river|stream|canal|riverbank)$"]',
    'nwr["natural"="water"]',
    'nwr["leisure"~"^(park|nature_reserve|garden|recreation_ground)$"]',
    // Named state parks and preserves, for matching park boundaries only. The name
    // filter keeps out national forests and wilderness, whose outlines are enormous.
    'nwr["boundary"="protected_area"]["name"~"State Park|State Historic Park|Preserve|Regional Park|Nature Study|Open Space",i]',
  ])}
);
out geom;`;

async function overpass(query, label, cacheFile, refresh) {
  if (!refresh && fs.existsSync(cacheFile)) {
    console.log(`${label}: using cached ${path.relative(ROOT, cacheFile)} (pass --refresh to refetch)`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  console.log(`${label}: fetching from Overpass (can take a minute or two)…`);
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'User-Agent': 'reno-parks-network-builder' },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw Error(`Overpass HTTP ${res.status} for ${label}; try again later or set OVERPASS_URL to another server`);
  const json = await res.json();
  if (json.remark && /error|timed out|runtime/i.test(json.remark)) throw Error(`Overpass: ${json.remark}`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(json));
  return json;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const featureCollection = (features) => ({ type: 'FeatureCollection', features });

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const key = require('crypto').createHash('sha1').update(JSON.stringify(opts.boxes)).digest('hex').slice(0, 10);
  console.log(`Area: ${opts.boxes.length} box${opts.boxes.length > 1 ? 'es' : ''} (Reno${opts.boxes.length > 1 ? ' plus outlying parks' : ''})`);
  const cache = path.join(ROOT, 'data', 'cache');
  const t0 = Date.now();

  const networkRaw = opts.network ? readJson(opts.network) : await overpass(networkQuery(opts.boxes), 'Walking network', path.join(cache, `osm-network-${key}.json`), opts.refresh);
  const featuresRaw = opts.features ? readJson(opts.features) : await overpass(featuresQuery(opts.boxes), 'Amenities and scenery', path.join(cache, `osm-features-${key}.json`), opts.refresh);

  console.log('Building segments…');
  const { segments, nodeCount, componentCount, edgeCount } = buildSegments(networkRaw, { statuses: opts.statuses });
  console.log(`  ${edgeCount.toLocaleString()} edges → ${segments.length.toLocaleString()} segments, ${componentCount} components`);

  const places = extractPlaces(featuresRaw);
  const areas = extractAreas(featuresRaw);
  console.log(`  ${places.length.toLocaleString()} places, ${areas.water.length} water lines, ${areas.green.length} park polygons`);
  enrichPlaces(segments, places);
  enrichAreas(segments, areas);

  const sources = [
    { name: 'OpenStreetMap', use: 'paths, amenities, points of interest, water, parks', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors',
      url: 'https://www.openstreetmap.org/copyright', snapshot: networkRaw.osm3s?.timestamp_osm_base || networkRaw.metadata?.osm_timestamp || null },
  ];
  if (opts.canopy) {
    console.log('Measuring shade from canopy height…');
    const src = metaCanopySource({ log: console.log });
    await enrichCanopy(segments, src, { log: console.log });
    sources.push({ name: 'Meta & WRI High Resolution Canopy Height Maps', use: 'shade', license: 'CC BY 4.0', attribution: src.attribution,
      url: 'https://registry.opendata.aws/dataforgood-fb-forests/', note: 'Built from satellite imagery mostly captured 2018–2020; recent plantings or removals may be missing.' });
  }
  if (opts.elevation) {
    console.log('Measuring slope from elevation…');
    const src = terrariumSource({ cacheDir: path.join(cache, 'terrarium'), log: console.log });
    await enrichElevation(segments, src, { log: console.log });
    sources.push({ name: 'AWS Terrain Tiles', use: 'slope', license: 'See attribution', attribution: src.attribution,
      url: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md', note: 'About 7 m resolution; short steep pitches can be underestimated.' });
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const write = (name, data) => {
    const file = path.join(opts.out, name);
    fs.writeFileSync(file, JSON.stringify(data));
    console.log(`  wrote ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
  };
  console.log('Writing output…');
  // Full-detail copy for later work such as route building; too big to publish.
  const fullDir = path.join(opts.out, 'cache');
  fs.mkdirSync(fullDir, { recursive: true });
  fs.writeFileSync(path.join(fullDir, 'walking-network-full.geojson'), JSON.stringify(featureCollection(segments)));
  // Park outlines for `npm run build:parks`.
  fs.writeFileSync(path.join(fullDir, 'park-boundaries.geojson'), JSON.stringify(featureCollection(extractParkBoundaries(featuresRaw))));
  console.log('Writing vector tiles…');
  const tiles = writeTiles(segments.map(webFeature), path.join(opts.out, 'tiles'), { log: console.log });
  // Earlier builds wrote the network as GeoJSON; the tiles replace those files.
  for (const old of ['walking-network.geojson', 'walking-paths.geojson', 'walking-streets.geojson']) fs.rmSync(path.join(opts.out, old), { force: true });
  write('places.geojson', featureCollection(places));
  write('network-meta.json', {
    built_at: new Date().toISOString(),
    boxes: opts.boxes,
    statuses: opts.statuses,
    counts: { segments: segments.length, nodes: nodeCount, components: componentCount, places: places.length },
    tiles,
    method: {
      shade: 'Share of points every 5 m where ≥20% of a 5 m disk (9 m on roads) has canopy ≥3 m tall.',
      slope: 'Steepest grade over any 30 m stretch, from elevation sampled every 10 m. Bridges and tunnels are left blank.',
      amenities: 'Counted when within 20 m (benches), 25 m (water, shelters, picnic tables) or 50 m (restrooms) of the segment.',
      points_of_interest: 'Viewpoints and points of interest within 40–60 m of the segment.',
      water: 'Share of points every 10 m within 40 m of a mapped river, stream, canal or water body.',
      parks: 'Share of points every 10 m inside a mapped park, garden or nature reserve.',
    },
    sources,
  });
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)} s.`);
}

if (require.main === module) {
  main().catch((err) => { console.error(`\nBuild failed: ${err.message}`); process.exit(1); });
}

module.exports = { parseArgs, networkQuery, featuresQuery, defaultBoxes, RENO_BBOX };
