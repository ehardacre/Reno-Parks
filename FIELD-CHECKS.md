# Field checks

Parks where the printed guide and OpenStreetMap disagreed. The guide (`parks.geojson`) now
shows the OpenStreetMap value; each park keeps the printed guide's original under
`guide_original`, and the map tells visitors the information is being checked.

After a visit, set the confirmed value in `parks.geojson` and remove `field_check` and
`guide_original` for that park. If something exists but isn't in OpenStreetMap, adding it
there (openstreetmap.org) fixes the map data on the next build.

## Restrooms and benches

- [ ] **Virginia Lake Park** (Reno) — benches: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.5034783,-119.8066535)
- [ ] **Huffaker Park** (Reno) — benches: guide said **Yes**, map data shows **None mapped**, restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.4665997,-119.7537208)
- [ ] **Mira Loma Park** (Reno) — benches: guide said **Yes**, map data shows **None mapped**, restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.4884093,-119.747248)
- [ ] **Wingfield Park / Downtown Riverwalk** (Reno) — benches: guide said **Yes**, map data shows **None mapped**, restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.5234,-119.81595)
- [ ] **Oxbow Nature Study Area** (Reno) — benches: guide said **Yes**, map data shows **None mapped**, restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.51883,-119.84632)
- [ ] **Mayberry Park** (Reno) — benches: guide said **Yes**, map data shows **None mapped**, restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.503111,-119.8967198)
- [ ] **Dorostkar Park** (Reno) — benches: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.5059925,-119.8866085)
- [ ] **Thomas Creek Park** (Reno) — restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.41438,-119.7890465)
- [ ] **Bartley Ranch Regional Park** (Reno) — restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.4670557,-119.8046513)
- [ ] **Bowers Mansion Regional Park** (Washoe Valley) — benches: guide said **Yes**, map data shows **None mapped**, restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.2856253,-119.8411229)
- [ ] **Tahoe East Shore Trail access areas** (Lake Tahoe & Incline Village) — restrooms: guide said **Some**, map data shows **Yes**. [Map](https://www.google.com/maps/search/?api=1&query=39.2345237,-119.9301428)
- [ ] **Mormon Station State Historic Park** (Carson Valley & beyond) — benches: guide said **Yes**, map data shows **None mapped**, restrooms: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.0048168,-119.8456589)
- [ ] **Fort Churchill State Historic Park** (Carson Valley & beyond) — benches: guide said **Yes**, map data shows **None mapped**. [Map](https://www.google.com/maps/search/?api=1&query=39.293,-119.267)

## Park areas to confirm

These had no matching OpenStreetMap outline, so their scores use paths within 400 m of the
pin. Drawing the park outline in OpenStreetMap, or adding an entry to `park-boundaries.json`,
fixes them.

- [ ] **Wilbur D. May Arboretum**
- [ ] **Swan Lake Nature Study Area**
- [ ] **Caughlin Ranch paths** (a trail network, not a park: naming the main trail in `park-boundaries.json` may work better)
- [ ] **McCarran Ranch Preserve**
- [ ] **Dayton State Park**: was wrongly matched to Dayton Skate Park (now fixed). Rerun `npm run build:parks` to see what it matches; no walking paths were found near its pin.
