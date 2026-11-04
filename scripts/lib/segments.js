'use strict';
// Collapse the per-node-pair edge graph into segments: runs of one OSM way between
// junctions (nodes where the walkable network branches or ends). This is the same
// unit Strava Metro and most routers use, and it keeps the output file small while
// still splitting wherever a route could turn.

const Walking = require('./walking');
const { lineLength } = require('./geo');

// Way tags worth carrying to the map. Everything else stays in OSM.
const KEEP_TAGS = [
  'highway', 'name', 'surface', 'footway', 'sidewalk', 'sidewalk:both', 'sidewalk:left',
  'sidewalk:right', 'lit', 'smoothness', 'incline', 'width', 'wheelchair', 'sac_scale',
  'trail_visibility', 'informal', 'bridge', 'tunnel', 'covered', 'access', 'foot', 'service',
];

// Whether walkers may use a segment, from OSM's `foot` tag (pedestrians only), falling
// back to `access` (everyone). Ways tagged private or foot=no never get this far:
// Walking.status marks them restricted and the build leaves them out.
//   yes       explicitly open to walkers, or a footpath, which is open by definition
//   limited   customers, destination traffic or permit holders only
//   street    an untagged public street: walking is normally legal; check for sidewalks
//   untagged  an access road with no access tags: may be private property
const PATH_TYPES = /^(footway|path|pedestrian|steps|living_street|cycleway|bridleway)$/;
function walkAccess(p) {
  if (/^(yes|designated|permissive|official)$/.test(p.foot || '')) return 'yes';
  const v = p.foot || p.access;
  if (/^(customers|destination|permit|delivery|agricultural|forestry|discouraged)$/.test(v || '')) return 'limited';
  if (/^(yes|permissive)$/.test(p.access || '') || PATH_TYPES.test(p.highway)) return 'yes';
  return p.highway === 'service' ? 'untagged' : 'street';
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

function buildSegments(raw, { statuses = ['candidate', 'review'] } = {}) {
  const graph = Walking.build(raw, (_tags, state) => statuses.includes(state));

  // Degree counts edge incidences, so a node in the middle of one way has degree 2.
  const degree = new Map();
  for (const e of graph.features) {
    for (const n of [e.properties.from, e.properties.to]) degree.set(n, (degree.get(n) || 0) + 1);
  }

  const byWay = new Map();
  for (const e of graph.features) {
    const list = byWay.get(e.properties.way_id);
    if (list) list.push(e); else byWay.set(e.properties.way_id, [e]);
  }

  const segments = [];
  for (const [wayId, edges] of byWay) {
    edges.sort((a, b) => a.properties.index - b.properties.index);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const first = run[0].properties, last = run[run.length - 1].properties;
      const coords = [run[0].geometry.coordinates[0], ...run.map((e) => e.geometry.coordinates[1])]
        .map(([x, y]) => [round6(x), round6(y)]);
      const props = { way_id: wayId };
      for (const k of KEEP_TAGS) if (first[k] !== undefined) props[k] = first[k];
      Object.assign(props, {
        status: first.status,
        walk_access: walkAccess(first),
        component: first.component,
        from: first.from,
        to: last.to,
        length_m: Math.round(lineLength(coords) * 10) / 10,
      });
      segments.push({ type: 'Feature', id: `${wayId}:${first.index}`, geometry: { type: 'LineString', coordinates: coords }, properties: props });
      run = [];
    };
    for (const e of edges) {
      const prev = run[run.length - 1];
      // Break on a gap (an edge skipped by Walking.build) or at a junction.
      if (prev && (prev.properties.to !== e.properties.from || degree.get(e.properties.from) !== 2)) flush();
      run.push(e);
    }
    flush();
  }
  return { segments, nodeCount: graph.nodeCount, componentCount: graph.componentCount, edgeCount: graph.features.length };
}

module.exports = { buildSegments, walkAccess, KEEP_TAGS };
