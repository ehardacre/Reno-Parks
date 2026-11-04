'use strict';
/* Inspection graph: OSM node identity, never coordinate proximity, defines connectivity. */
const Walking = (() => {
  const explicit = new Set(['yes','designated','official','permissive']);
  function status(t) {
    if (t.area === 'yes' || /^(construction|proposed|abandoned|razed)$/.test(t.highway)) return 'excluded';
    const access = t.foot || t.access;
    if (['no','private','use_sidepath'].includes(access)) return 'restricted';
    if (Object.keys(t).some(k => /conditional/.test(k)) || (access && !explicit.has(access))) return 'review';
    if (/^(motorway|motorway_link|trunk|trunk_link|raceway|busway|escape)$/.test(t.highway) && !explicit.has(t.foot)) return 'excluded';
    if (explicit.has(t.foot) || /^(footway|path|pedestrian|steps|living_street)$/.test(t.highway)) return 'candidate';
    return 'review'; // Roads, cycleways, bridleways and unknown classes need inspection.
  }
  function build(raw, accept = () => true) {
    const nodes = new Map(raw.elements.filter(e=>e.type==='node').map(n=>[n.id,n]));
    const edges=[];
    for (const w of raw.elements.filter(e=>e.type==='way' && e.tags?.highway)) {
      const state=status(w.tags);
      if (!accept(w.tags,state)) continue;
      for(let i=1;i<w.nodes.length;i++) {
        const a=nodes.get(w.nodes[i-1]), b=nodes.get(w.nodes[i]);
        if(!a || !b) throw Error(`Incomplete OSM geometry for way ${w.id}`);
        if(a.id===b.id) continue;
        const rad=Math.PI/180, dlat=(b.lat-a.lat)*rad, dlon=(b.lon-a.lon)*rad;
        const h=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2;
        edges.push({type:'Feature',id:`${w.id}:${i-1}`,geometry:{type:'LineString',coordinates:[[a.lon,a.lat],[b.lon,b.lat]]},properties:{...w.tags,way_id:w.id,from:a.id,to:b.id,index:i-1,status:state,surface_value:w.tags.surface||'unknown',length_m:6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)))}});
      }
    }
    const parent=new Map();
    function root(x){let r=x;while(parent.get(r)!==r)r=parent.get(r);while(x!==r){const n=parent.get(x);parent.set(x,r);x=n;}return r;}
    for(const e of edges){const {from:a,to:b}=e.properties;if(!parent.has(a))parent.set(a,a);if(!parent.has(b))parent.set(b,b);parent.set(root(a),root(b));}
    const counts=new Map();for(const e of edges){const r=root(e.properties.from);counts.set(r,(counts.get(r)||0)+1);}
    const ordered=[...counts].sort((a,b)=>b[1]-a[1]);const ids=new Map(ordered.map(([r],i)=>[r,i+1]));
    for(const e of edges)e.properties.component=ids.get(root(e.properties.from));
    return {type:'FeatureCollection',features:edges,nodeCount:parent.size,componentCount:ids.size,nodes:[...parent.keys()].map(id=>nodes.get(id))};
  }
  return {status,build};
})();
module.exports = Walking;
