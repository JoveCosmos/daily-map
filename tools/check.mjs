// playability check of a map json: walkable points, spawn sides, longest walk, pockets (spawn-unsafe points), pits
// (floor a player can fall into from the walkable network and never climb out of: fatal since 2026-11-23, add-map.sh
// fills them first with fillpits.mjs), and the play tests (2026-11-23, after the Counter-Strike audit): straight walks
// with the game's own movement, routes walked the way bots walk them, spawn-to-site times, cracks in the floor.
//   node check.mjs <id> [collision.glb to check instead of the json's]       SIM=<sim.js> checks against another build
// prints one JSON line and, when there are any, one line per warning; exit 1 when the map is not playable
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { findPits } from "./pits.mjs";
const SIM = await import(process.env.SIM || "../sim.js");
const { World, gltfGeometries } = SIM;
await MeshoptDecoder.ready;
const id = process.argv[2], dir = new URL("../maps/", import.meta.url), m = JSON.parse(fs.readFileSync(new URL(id + ".json", dir)));
const buf = fs.readFileSync(process.argv[3] || new URL(m.collision, dir));
const gl = await new Promise((r, j) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", r, j));
const W = new World(gltfGeometries(gl.scene, m)); W.buildNav(); const b = W.bounds, up = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const D8 = [...Array(8)].map((_, k) => new THREE.Vector3(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4)));
const pocket = n => { const o = n.p.clone(); o.y += 1.6; if (W.first(o, up, 2.5)) return true; let w = 0; for (const d of D8) if (W.first(o, d, 1.2)) w++; return w >= 6; };
const pockets = W.nodes.filter(pocket).length;
const pits = findPits(W).map(g => ({ at: [g.at.x, g.at.y, g.at.z].map(v => +v.toFixed(1)), edge: g.n, cells: g.cells, depth: +g.depth.toFixed(1) }));
const out = { id, size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map(v => +v.toFixed(1)), walkable: W.nodes.length,
  spawns: [W.spawn?.[0]?.length || 0, W.spawn?.[1]?.length || 0], longestWalk: +(W.span || 0).toFixed(1), pockets, pits: pits.length, pitList: pits.slice(0, 12) };
const problems = [], warnings = [];
if (out.walkable < 300) problems.push("fewer than 300 walkable points");
if (out.longestWalk < 15) problems.push("longest walk under 15 m (too small to play)");
if (out.longestWalk > 120) problems.push("longest walk over 120 m (scale too large?)");
if (Math.min(...out.spawns) < 3) problems.push("a team has fewer than 3 spawn points");
if (out.pits) problems.push(`${out.pits} pits a player can fall into and not climb out of (tools/fillpits.mjs fills them)`);

/* the play tests (2026-11-23): what the Counter-Strike audit found on the first eight maps, measured on every new one.
   Run with the game's own movement (a box's step of 18 units, slopes to 45 degrees), so a sim.js without it skips them */
if (SIM.support && SIM.bombSites) {
  const { move, newPlayer, equip, bombSites, U, DT } = SIM, RUN = 215 * U, P = out.play = {};
  const cmd = o => ({ f: 0, s: 0, jump: false, duck: false, walk: false, fire: false, reload: false, yaw: 0, pitch: 0, ...o });
  const player = p => { const s = newPlayer(); equip(s, "ak"); s.pos.copy(p); for (let i = 0; i < 8; i++) move(W, s, cmd()); return s; };
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, N = W.nodes, pick = () => N[(rnd() * N.length) | 0];
  const at = v => [v.x, v.z].map(x => Math.round(x)).join(",");
  /* links too narrow for a body, left out of the routes (sim.js buildNav) */
  P.narrowLinks = W.narrow || 0;
  /* 1. straight walks: 60 runs between walkable points 8-25 m apart, level, the line clear for a body at the knees, the
     chest and the head. A run that never arrives either met something no higher than a step (the walk should take it:
     a movement problem) or something a CS player would jump or walk round; and the time spent off the ground on the
     way is a rough floor (a shot fired in the air takes the jump's spread) */
  { let runs = 0, stuck = 0, lowStuck = 0, air = 0, ticks = 0; const low = [];
    for (let k = 0; k < 1500 && runs < 60; k++) {
      const a = pick(), c = pick(), d = a.p.distanceTo(c.p); if (d < 8 || d > 25 || Math.abs(a.p.y - c.p.y) > .5) continue;
      let ok = true; for (const h of [.5, 1, 1.5]) { const p0 = a.p.clone(), p1 = c.p.clone(); p0.y += h; p1.y += h; if (!W.clear(p0, p1)) { ok = false; break; } } if (!ok) continue;
      runs++; const s = player(a.p), yaw = Math.atan2(-(c.p.x - a.p.x), -(c.p.z - a.p.z)); let i = 0;
      for (; i < 64 * 8; i++) { move(W, s, cmd({ f: 1, yaw })); if (i > 30) { ticks++; if (!s.onGround) air++; } if (Math.hypot(s.pos.x - c.p.x, s.pos.z - c.p.z) < .6) break; }
      if (i < 64 * 8) continue; stuck++;
      const dirv = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)); let hi = -1;
      for (let h = .02; h <= 1.2; h += .02) { const o = s.pos.clone(); o.y += h; if (W.first(o, dirv, .75)) hi = h; }
      if (hi > 0 && hi <= .48) { lowStuck++; low.push(at(s.pos)); } }
    P.walks = { runs, stuck, stuckLow: lowStuck, lowAt: low.slice(0, 6), airborne: +(100 * air / Math.max(1, ticks)).toFixed(1) }; }
  /* 2. routes walked as a bot walks them: 40 routes of 15 m and more between random walkable points, following the route's
     points with the game's movement (a jump where the route steps up more than a step). Where it gets no 30 cm nearer the
     next point for 1.5 s, a bot has to glide past (server.js botTick): counted, and the places listed */
  { let routes = 0, metres = 0, glides = 0; const where = new Map();
    for (let k = 0; k < 400 && routes < 40; k++) {
      const a = pick(), c = pick(); if (a.p.distanceTo(c.p) < 15) continue; const path = W.astar(a.i, c.i); if (path.length < 8) continue;
      routes++; const s = player(a.p); let pi = 1, prog = Infinity, progT = 0, t = 0, jumpAt = 0;
      for (let i = 0; i < 64 * 60 && pi < path.length; i++) { t += DT; const n = N[path[pi]], L = Math.hypot(n.p.x - s.pos.x, n.p.z - s.pos.z);
        if (L < .55) { pi++; prog = Infinity; progT = t; continue; }
        if (L < prog - .3) { prog = L; progT = t; }
        if (t - progT > 1.5) { glides++; const k2 = at(s.pos); where.set(k2, (where.get(k2) || 0) + 1); s.pos.copy(n.p); s.vel.set(0, 0, 0); s.onGround = true; pi++; prog = Infinity; progT = t; continue; }
        const yaw = Math.atan2(-(n.p.x - s.pos.x), -(n.p.z - s.pos.z)), jump = s.onGround && t > jumpAt && ((n.p.y - s.pos.y > .4 && L < 1.4) || t - progT > .5); if (jump) jumpAt = t + .8;
        const x0 = s.pos.x, z0 = s.pos.z; move(W, s, cmd({ f: 1, yaw, jump })); metres += Math.hypot(s.pos.x - x0, s.pos.z - z0); } }
    P.routes = { routes, km: +(metres / 1000).toFixed(2), glides, perKm: +(glides / Math.max(.01, metres / 1000)).toFixed(1), at: [...where].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`) }; }
  /* 3. spawn to site: seconds at a rifle's run (5.5 m/s) from each spawn to each bomb site (the server's own rule). In
     Counter-Strike the attackers need well over ten seconds to reach a site and the defenders get there several seconds
     before them; a small map gives neither */
  { const sites = bombSites(W), dC = W.dijkstra(W.spawn[0][0] ?? 0), dT = W.dijkstra(W.spawn[1][0] ?? 0), sec = d => +(d / RUN).toFixed(1);
    const rows = sites.map(st => { const i = W.nearest(st.p); return { site: st.name, ct: sec(dC[i]), t: sec(dT[i]) }; });
    P.sites = rows; P.tFirst = Math.min(...rows.map(r => r.t)); P.ctLead = +Math.min(...rows.map(r => r.t - r.ct)).toFixed(1); }
  /* 4. cracks: floor halfway between walkable points 2 m apart with no collision under it within 6.5 m. The walk steps
     over one narrower than a body (sim.js groundMove), a wider one stops a player like a wall */
  { const cell = new Map(N.map(n => [Math.round(n.p.x) + "," + Math.round(n.p.z), n])); let pairs = 0, cracks = 0;
    for (const n of N) for (const [dx, dz] of [[2, 0], [0, 2]]) { const o = cell.get(Math.round(n.p.x + dx) + "," + Math.round(n.p.z + dz)); if (!o || Math.abs(o.p.y - n.p.y) > .3) continue;
      pairs++; const mid = n.p.clone().lerp(o.p, .5); mid.y += .5; if (!W.first(mid, DOWN, 6.5)) cracks++; }
    P.cracks = { pairs, cracks, share: +(100 * cracks / Math.max(1, pairs)).toFixed(1) }; }
  // what fails a map, and what is only worth knowing before it goes into the rotation
  const w = P.walks, r = P.routes;
  if (w.runs >= 20 && w.stuckLow / w.runs > .15) problems.push(`${w.stuckLow} of ${w.runs} straight walks stop at something no higher than a step (at ${w.lowAt.join(" ")})`);
  if (r.routes >= 20 && r.perKm > 40) problems.push(`routes need a bot to glide ${r.perKm} times a km (at ${r.at.join(" ")}): links a body does not fit`);
  if (r.perKm > 15 && r.perKm <= 40) warnings.push(`routes need a bot to glide ${r.perKm} times a km, most at ${r.at.slice(0, 3).join(" ")}`);
  if (w.airborne > 3) warnings.push(`a straight walk spends ${w.airborne}% of its time off the ground (rough floor: shots there take the jump's spread)`);
  if (P.tFirst < 8) warnings.push(`attackers reach a bomb site in ${P.tFirst} s (Counter-Strike: well over 10); a larger --scale gives the rounds time`);
  if (P.ctLead < 3) warnings.push(`defenders reach a site only ${P.ctLead} s before attackers can (Counter-Strike: several seconds)`);
  if (P.cracks.share > 1) warnings.push(`${P.cracks.share}% of the floor between walkable points has a crack with nothing under it`);
  if (P.narrowLinks > 400) warnings.push(`${P.narrowLinks} links between walkable points are too narrow for a body (left out of the routes)`);
}
out.ok = !problems.length; out.problems = problems; out.warnings = warnings;
console.log(JSON.stringify(out)); for (const x of warnings) console.log("warning: " + x);
process.exit(out.ok ? 0 : 1);
