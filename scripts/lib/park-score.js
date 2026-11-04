'use strict';
// Turn a park's summary into a 0–100 walking-resources score.
//
// Each part is scaled to 0–1 against a level that counts as "plenty" for this
// audience, then the parts are averaged with these weights. Edit the weights or the
// "plenty" levels to change what the ranking favors.
const WEIGHTS = {
  shade: 20,      // share of path length under tree canopy
  gentle: 20,     // share of path length under 5% grade at its steepest
  rest: 15,       // benches, shelters, picnic tables and water per km
  restrooms: 10,  // any restroom at all
  paths: 15,      // km of walking (streets and access roads count half)
  loops: 10,      // ways to wander and come back around
  sights: 10,     // viewpoints, points of interest and time beside water
};

const PLENTY = { shade_pct: 50, rest_per_km: 3, walk_km: 4, loops: 5, sights: 4 };
const clamp = (v) => Math.max(0, Math.min(1, v));

function scorePark(s) {
  const walkKm = s.km_paths + 0.5 * (s.km_streets + s.km_access_roads);
  const restPoints = s.benches + s.shelters + s.picnic_tables + s.drinking_water;
  const parts = {
    shade: clamp((s.shade_pct ?? 0) / PLENTY.shade_pct),
    gentle: clamp((s.under_5_pct ?? 0) / 100),
    rest: walkKm ? clamp(restPoints / walkKm / PLENTY.rest_per_km) : 0,
    restrooms: s.restrooms > 0 ? 1 : 0,
    paths: clamp(walkKm / PLENTY.walk_km),
    loops: clamp(s.loops / PLENTY.loops),
    sights: 0.6 * clamp((s.viewpoints + s.sights) / PLENTY.sights) + 0.4 * clamp(s.water_pct / 100),
  };
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const score = Math.round((100 * Object.entries(WEIGHTS).reduce((t, [k, w]) => t + w * parts[k], 0)) / total);
  const rounded = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { score, parts: rounded };
}

module.exports = { scorePark, WEIGHTS, PLENTY };
