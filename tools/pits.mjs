// pits: floor outside the walkable network that a player can drop into from it and never climb out of (shared by
// check.mjs, which fails a map that has any, and fillpits.mjs, which fills them in the collision mesh)
import * as THREE from "three";
export function findPits(W) {
  const R = W.raw || { nodes: [] }, pitC = new Map(), A = new THREE.Vector3(), Bv = new THREE.Vector3(), size = new Map();
  for (const n of R.nodes) size.set(n.c, (size.get(n.c) || 0) + 1);
  for (const n of R.nodes) { if (n.c === R.main) continue;
    // floor under the walkable floor (the yard overhanging the street) cannot be fallen into from above: not an edge
    if ((R.cell.get(n.ix + "," + n.iz) || []).some(x => x.c === R.main && x.p.y > n.p.y)) continue;
    for (let dx = -2; dx <= 2 && !n.edge; dx++) for (let dz = -2; dz <= 2; dz++) {
      const list = R.cell.get((n.ix + dx) + "," + (n.iz + dz)); if (!list) continue;
      const m = list.find(m => m.c === R.main && m.p.y - n.p.y > .55 && m.p.y - n.p.y < 6.5 && (A.copy(m.p), A.y += .9, Bv.copy(n.p), Bv.y = A.y, W.clear(A, Bv)));
      if (m) { const g = pitC.get(n.c) || pitC.set(n.c, { c: n.c, n: 0, at: n.p, depth: 0, rim: -1e9, cells: size.get(n.c), edges: [] }).get(n.c);
        g.n++; g.depth = Math.max(g.depth, m.p.y - n.p.y); g.rim = Math.max(g.rim, m.p.y); g.edges.push([n, m.p.y]); n.edge = true; break; } } }
  return [...pitC.values()];
}
// the nav grid's cell size (as World.buildNav makes it)
export const navStep = W => { const b = W.bounds; return Math.min(1.2, Math.max(.6, Math.min(b.max.x - b.min.x, b.max.z - b.min.z) / 70)); };
