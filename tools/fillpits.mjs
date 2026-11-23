// fillpits.mjs <in.glb> <map.json> <out.glb>: fills a map's pits in its collision mesh, so nobody can fall where they
// cannot climb back out (2026-11-23). A small hole (up to 60 floor cells) gets a lid at its rim's height and becomes
// floor; a large lower area (a street below a raised yard) gets an invisible barrier along its edge, 2 m above the rim,
// since a lid over it would have players walking on air above a road they can see. Repeats until none are left (a
// barrier can uncover a new edge). Before all that, an invisible ground floor under the whole map (below). Only the
// collision changes; the world looks the same.
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder as MD3 } from "three/addons/libs/meshopt_decoder.module.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { World, gltfGeometries, mapMatrix } from "../sim.js";
import { findPits, navStep } from "./pits.mjs";
const [inF, jsonF, outF] = process.argv.slice(2);
if (!outF) { console.error("usage: node fillpits.mjs <in.glb> <map.json> <out.glb>"); process.exit(2); }
await MD3.ready; await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const m = JSON.parse(fs.readFileSync(jsonF)), buf = fs.readFileSync(inF);
const gl = await new Promise((r, j) => new GLTFLoader().setMeshoptDecoder(MD3).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", r, j));
const base = gltfGeometries(gl.scene, m), boxes = [], SMALL = 60, WALL = 2;
const box = (x, z, y0, y1, s) => { const g = new THREE.BoxGeometry(s, Math.max(.05, y1 - y0), s); g.deleteAttribute("normal"); g.deleteAttribute("uv"); g.translate(x, (y0 + y1) / 2, z); boxes.push(g); };
let rounds = 0, filled = 0, walled = 0, left = [], base0 = null, after = null;
/* the first guard (2026-11-23): an invisible floor tile in every hole of the map's ground. The ground level is the lowest
   height band that holds a real share of the floor (the street, on a map with a raised yard); a hole is an empty cell of
   the floor grid that the outside of the map cannot reach across empty cells, so nothing is added past the map's edge
   or over a lower area. A hole in a raised level is left to the pit fill below, which sees it as a pit */
let groundY = null, groundTiles = 0;
{ const W0 = new World(base); W0.buildNav(); base0 = { walk: W0.nodes.length, span: W0.span };
  const R = W0.raw, step = navStep(W0), bb = W0.bounds, bins = new Map();
  for (const n of R.nodes) { const k = Math.floor(n.p.y / .25); bins.set(k, (bins.get(k) || 0) + 1); }
  const k0 = [...bins.keys()].sort((a, b) => a - b).find(k => (bins.get(k) + (bins.get(k + 1) || 0)) >= R.nodes.length * .08);
  const band = R.nodes.filter(n => n.p.y >= k0 * .25 - .1 && n.p.y < (k0 + 2) * .25 + .1), ys = band.map(n => n.p.y).sort((a, b) => a - b);
  groundY = +(ys[Math.floor(ys.length * .1)] - .03).toFixed(2);
  let nx = 0, nz = 0; for (const n of R.nodes) { nx = Math.max(nx, n.ix); nz = Math.max(nz, n.iz); } nx += 2; nz += 2;
  const full = new Uint8Array(nx * nz), out = new Uint8Array(nx * nz), id = (x, z) => z * nx + x;
  for (const n of R.nodes) full[id(n.ix, n.iz)] = 1;
  const q = []; for (let x = 0; x < nx; x++) for (const z of [0, nz - 1]) q.push([x, z]); for (let z = 0; z < nz; z++) for (const x of [0, nx - 1]) q.push([x, z]);
  while (q.length) { const [x, z] = q.pop(); if (x < 0 || z < 0 || x >= nx || z >= nz) continue; const i = id(x, z); if (out[i] || full[i]) continue; out[i] = 1; q.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]); }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { const i = id(x, z); if (full[i] || out[i]) continue;
    box(bb.min.x + (x - .5) * step, bb.min.z + (z - .5) * step, groundY - .2, groundY, step * 1.02); groundTiles++; } }
for (; rounds < 6; rounds++) {
  const W = new World(boxes.length ? [...base, mergeGeometries(boxes)] : base); W.buildNav();
  const pits = findPits(W); left = pits; after = { walk: W.nodes.length, span: W.span }; if (!pits.length) break;
  const s = navStep(W) * 1.02;   // a hair over a cell, so neighbouring boxes close up
  // never in a cell that also holds the walkable floor (the raised yard can overhang the street below it: a barrier
  // rising from the street would cut the walkway above in two)
  const R = W.raw, mainCell = k => (R.cell.get(k) || []).some(x => x.c === R.main);
  for (const p of pits) {
    if (p.cells <= SMALL) { for (const n of W.raw.nodes) if (n.c === p.c) box(n.p.x, n.p.z, n.p.y - .1, p.rim, s); filled++; }
    else { for (const [n, rimY] of p.edges) if (!mainCell(n.ix + "," + n.iz)) box(n.p.x, n.p.z, n.p.y - .1, rimY + WALL, s * .55 /* narrow: a rail, not a wall that eats the walkway beside it */); walled++; }
  }
}
if (left.length) { console.error(`pits left after ${rounds} rounds: ${left.length}`); process.exit(1); }
// the fill must only close holes: the walkable network may grow (lids) but never lose ground; the longest walk may
// shorten a little (a lid is a short cut across a hole) but not collapse (a barrier cutting the map in two)
if (base0 && (after.walk < base0.walk * .97 || after.span < base0.span * .8)) { console.error(`the fill would shrink the map: walkable ${base0.walk} -> ${after.walk}, longest walk ${base0.span.toFixed(1)} -> ${after.span.toFixed(1)} m`); process.exit(1); }
if (!boxes.length) { fs.copyFileSync(inF, outF); console.log(JSON.stringify({ pits: 0, boxes: 0 })); process.exit(0); }
// into the file's own space (the map json's scale, turn and offset undone) and onto the scene as one more mesh
const g = mergeGeometries(boxes).toNonIndexed(); g.applyMatrix4(mapMatrix(m).invert());
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
const doc = await io.read(inF), root = doc.getRoot(), bufR = root.listBuffers()[0] || doc.createBuffer();
const pos = doc.createAccessor("pitfill").setType("VEC3").setArray(new Float32Array(g.attributes.position.array)).setBuffer(bufR);
const mesh = doc.createMesh("pitfill").addPrimitive(doc.createPrimitive().setAttribute("POSITION", pos));
(root.getDefaultScene() || root.listScenes()[0]).addChild(doc.createNode("pitfill").setMesh(mesh));
await io.write(outF, doc);
console.log(JSON.stringify({ groundY, groundTiles, rounds, lids: filled, barriers: walled, boxes: boxes.length, walkable: [base0.walk, after.walk], longestWalk: [+base0.span.toFixed(1), +after.span.toFixed(1)] }));
