// playability check of a map json: walkable points, spawn sides, longest walk, pockets (spawn-unsafe points), pits
// (floor a player can fall into from the walkable network and never climb out of: fatal since 2026-11-23, add-map.sh
// fills them first with fillpits.mjs). node check.mjs <id> [collision.glb to check instead of the json's]
// prints one JSON line; exit 1 when the map is not playable
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { World, gltfGeometries } from "../sim.js";
import { findPits } from "./pits.mjs";
await MeshoptDecoder.ready;
const id = process.argv[2], dir = new URL("../maps/", import.meta.url), m = JSON.parse(fs.readFileSync(new URL(id + ".json", dir)));
const buf = fs.readFileSync(process.argv[3] || new URL(m.collision, dir));
const gl = await new Promise((r, j) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", r, j));
const W = new World(gltfGeometries(gl.scene, m)); W.buildNav(); const b = W.bounds, up = new THREE.Vector3(0, 1, 0);
const D8 = [...Array(8)].map((_, k) => new THREE.Vector3(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4)));
const pocket = n => { const o = n.p.clone(); o.y += 1.6; if (W.first(o, up, 2.5)) return true; let w = 0; for (const d of D8) if (W.first(o, d, 1.2)) w++; return w >= 6; };
const pockets = W.nodes.filter(pocket).length;
const pits = findPits(W).map(g => ({ at: [g.at.x, g.at.y, g.at.z].map(v => +v.toFixed(1)), edge: g.n, cells: g.cells, depth: +g.depth.toFixed(1) }));
const out = { id, size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map(v => +v.toFixed(1)), walkable: W.nodes.length,
  spawns: [W.spawn?.[0]?.length || 0, W.spawn?.[1]?.length || 0], longestWalk: +(W.span || 0).toFixed(1), pockets, pits: pits.length, pitList: pits.slice(0, 12) };
const problems = [];
if (out.walkable < 300) problems.push("fewer than 300 walkable points");
if (out.longestWalk < 15) problems.push("longest walk under 15 m (too small to play)");
if (out.longestWalk > 120) problems.push("longest walk over 120 m (scale too large?)");
if (Math.min(...out.spawns) < 3) problems.push("a team has fewer than 3 spawn points");
if (out.pits) problems.push(`${out.pits} pits a player can fall into and not climb out of (tools/fillpits.mjs fills them)`);
out.ok = !problems.length; out.problems = problems;
console.log(JSON.stringify(out)); process.exit(out.ok ? 0 : 1);
