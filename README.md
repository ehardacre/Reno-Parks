# Reno-Parks

**Healing Steps**: a map of Reno-area parks rated by walking comfort, plus a walking
network that shows shade, amenities, scenery and slope along each path.

The site is static: `index.html` loads `parks.geojson` and the prebuilt files in `data/`.

## Walking network

`scripts/build-network.js` builds the network once, ahead of time, so the page loads prebuilt
files instead of querying OpenStreetMap in the browser. Dedicated walking paths load with the
page; streets are a separate file the map fetches only when you include them.

```bash
npm install
npm run build:network   # writes data/walking-paths.geojson, walking-streets.geojson, places.geojson, network-meta.json
```

Commit the `data/` folder afterwards so the published site picks it up. Downloads are
cached in `data/cache/` (not committed); pass `--refresh` to fetch fresh OSM data. Other
options are listed at the top of that script: `--bbox S,W,N,E`, `--statuses candidate`
(dedicated paths only), `--no-canopy`, `--no-elevation`, and `--network FILE` to reuse a
saved Overpass response. Pass them after `--`, e.g. `npm run build:network -- --refresh`.

### What each path segment gets

The network is split into segments: runs of one OSM way between junctions.

| Measure | How it's computed | Source |
|---|---|---|
| Shade | Share of points every 5 m with canopy ≥3 m tall covering ≥20% of a 5 m disk (9 m on streets, which are mapped down the middle) | [Meta & WRI canopy height](https://registry.opendata.aws/dataforgood-fb-forests/), ~1.2 m pixels, CC BY 4.0 |
| Amenities | Benches, restrooms, drinking water, shelters, picnic tables within 20–50 m | OpenStreetMap |
| Viewpoints and points of interest | Viewpoints, summits, public art, historic sites, interpretive signs, fountains within 40–60 m | OpenStreetMap |
| By water / in a park | Share of the segment within 40 m of a river, stream or pond, or inside a mapped park | OpenStreetMap |
| Slope | Steepest grade over any 30 m stretch, plus total climb and descent; blank for bridges and tunnels | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (USGS 3DEP in the US) |

Limits to keep in mind: the canopy imagery is mostly from 2018–2020; the elevation model is
~7 m resolution, so short steep pitches can read low; and amenities are only as complete as
OpenStreetMap. Fixing OSM fixes the map on the next build.

### Licensing

The network and places files are derived from OpenStreetMap and are available under the
[ODbL](https://opendatacommons.org/licenses/odbl/). Credit "© OpenStreetMap contributors"
and "Canopy height © Meta and World Resources Institute" wherever the data is shown.

## Tests

```bash
npm test
```
