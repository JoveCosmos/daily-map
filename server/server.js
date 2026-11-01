/* The authoritative game server: runs the shared simulation at 64 ticks, takes each client's commands, decides every
   hit with lag compensation (the world rewound to what the shooter was looking at), runs the bots, and sends
   snapshots at 32 a second. It also serves the game's files, so one port carries both. */
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { World, TICK, DT, C, DMG, DEG, clamp, newPlayer, move, weapon, eye, eyePos, height, hitBox, standinParts, gltfGeometries, MAG, RESERVE, WEAPONS, WIDS, equip } from "../sim.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = +(process.env.PORT || 8945), MAP_ID = (process.env.MAP || "standin").replace(/[^a-z0-9_-]/gi, "");
const PER_TEAM = +(process.env.PER_TEAM || 3), MAX_PLAYERS = 12, REWIND_MAX = .4, RESPAWN = 3, PROTECT = 2;
const FAKE_LAG = +(process.env.FAKE_LAG_MS || 0) / 2;   // test only: half the delay each way, to try the netcode at internet ping
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ── the maps: every map a room can use, loaded once and shared by the rooms on it ─────────────────────────── */
let diagN = 0; setInterval(() => { diagN = 0; }, 3600e3);   // /diag lines per hour
/* the daily rotation lives in maps/rotation.json (tools/add-map.sh appends to it); the stand-in courtyard always loads */
const ROTATION = (() => { try { const r = JSON.parse(fs.readFileSync(new URL("../maps/rotation.json", import.meta.url))).rotation; if (Array.isArray(r) && r.length) return r.filter(x => /^[a-z0-9-]+$/.test(x)); } catch (e) {} return ["market", "yard"]; })();
const MAPLIST = ["standin", ...ROTATION], WORLDS = {}, MAPS = {};
for (const id of MAPLIST) {
  const M = JSON.parse(fs.readFileSync(path.join(ROOT, "maps", id + ".json"), "utf8")); let geoms;
  if (M.kind === "procedural") geoms = Object.values(standinParts()).flat();
  else { const buf = fs.readFileSync(path.join(ROOT, "maps", M.collision));
    await MeshoptDecoder.ready; const gl = await new Promise((res, rej) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "", res, rej));
    geoms = gltfGeometries(gl.scene, M); }
  const w = new World(geoms), t0 = Date.now(); w.buildNav(); WORLDS[id] = w; MAPS[id] = M;
  log(`map ${id}: ${w.nodes.length} walkable points, spawns ${w.spawn[0].length}/${w.spawn[1].length}, longest walk ${w.span.toFixed(0)} m (${Date.now() - t0} ms)`);
}

const nextDaily = () => { const now = Date.now() / 1000, i = (Math.floor(now / DAILY_PERIOD) + 1) % DAILY_LIST.length; return { map: MAPS[DAILY_LIST[i]].name, in: Math.round(DAILY_PERIOD - now % DAILY_PERIOD) }; };
/* ── a room: its own players, bots, pickups and clock; every room shares the one map and its routes ─────────── */
/* game modes: deathmatch (a fixed time, respawning, team kills decide) and rounds (CS competitive: a fixed round time,
   no respawn inside a round, eliminate or run the clock; first to 8 rounds, at most 15) - both restart when over */
const ENV = k => process.env[k] ? +process.env[k] : null;   // test only: shorter times
const MODES = { dm: { name: "Deathmatch", time: ENV("DM_TIME") ?? 600 }, rounds: { name: "Rounds", roundTime: ENV("ROUND_TIME") ?? 115, freeze: 3, toWin: ENV("TO_WIN") ?? 8, maxRounds: 15 } };
function createRoom(code, title, mode = "dm", botCfg = null, FF = false, mapId = "standin") {   // FF: friendly fire
  const MAP_ID = WORLDS[mapId] ? mapId : "standin", W = WORLDS[MAP_ID], SLOT = code === "DAILY" ? slotNow() : null;   // SLOT: this turn of the rotation, for the board   // botCfg: [CT, T] fixed counts, or null to fill empty slots to PER_TEAM
  const MODE = MODES[mode] ? mode : "dm", G = { ph: "live", until: 0, round: 0, sc: [0, 0], msg: "", winner: -1 };
/* ── entities: humans and bots share the same state and hit boxes ────────────── */
const ents = new Map(); let nextId = 1, tick = 0, time = 0;
const hist = [];                                  // per tick: { time, states: Map(id -> {x,y,z,duck,alive}) }, last second
let events = [];

const BOTNAMES = ["Vex", "Murk", "Rook", "Sable", "Ash", "Kite", "Bram", "Juno", "Wren", "Pike", "Onyx", "Lark", "Flint", "Moss"];
/* where to (re)spawn: always inside the team's own spawn area, the two areas at opposite ends of the map; within it, the
   point no living enemy can see and furthest from the nearest one, so nobody appears in front of a rifle */
/* test only (DUEL=1): the two sides spawn 12-18 m apart with a clear line between them, to measure hit registration */
const SIDE = W.side || (W.side = (() => { const dA = W.dijkstra(W.spawn[0][0] ?? 0), dB = W.dijkstra(W.spawn[1][0] ?? 0);   // once per map, shared by its rooms
  // never spawn in a pocket: a generated world can leave a house interior or a low nook joined to the street through a
  // gap in its mesh, and a spawn there looks like being stuck in a wall. Out: a ceiling within
  // 2.5 m above the eyes, or walls within 1.2 m on at least 6 of 8 sides
  const UP = new THREE.Vector3(0, 1, 0), D8 = [...Array(8)].map((_, k) => new THREE.Vector3(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4)));
  const open = n => { const o = n.p.clone(); o.y += 1.6; if (W.first(o, UP, 2.5)) return false; let walls = 0; for (const d of D8) if (W.first(o, d, 1.2)) walls++; return walls < 6; };
  const ok = W.nodes.map(open);
  return [W.nodes.filter(n => ok[n.i] && dA[n.i] < dB[n.i] * .55).map(n => n.i), W.nodes.filter(n => ok[n.i] && dB[n.i] < dA[n.i] * .55).map(n => n.i)]; })());
log(`[${code}] team sides: ${SIDE[0].length} / ${SIDE[1].length} spawn points`);
let DUEL = null;
if (process.env.DUEL === "1") {
  const A = W.nodes[W.spawn[0][0]], up = p => p.clone().setY(p.y + 1.4);
  const B = W.nodes.find(n => { const d = n.p.distanceTo(A.p); return d > 12 && d < 18 && W.clear(up(A.p), up(n.p)) && (() => { const ab = n.p.clone().sub(A.p).setY(0).normalize(), side = new THREE.Vector3(-ab.z, 0, ab.x).multiplyScalar(4.5); return W.clear(up(n.p).add(side), up(A.p)) && W.clear(up(n.p).sub(side), up(A.p)) && W.clear(up(n.p), up(n.p).add(side)) && W.clear(up(n.p), up(n.p).sub(side)); })(); });
  DUEL = [A, B || A]; log("duel spawns", A.p.toArray().map(x => x.toFixed(1)).join(","), "/", (B || A).p.toArray().map(x => x.toFixed(1)).join(","), "distance", B ? B.p.distanceTo(A.p).toFixed(1) : "none");
}
function pickSpawn(e) {
  if (DUEL) return DUEL[e.team];
  if (process.env.SPAWN_AT && !e.bot) { const x = PK.find(k => k.w === process.env.SPAWN_AT); if (x) return { p: x.p.clone().add(new THREE.Vector3(.6, 0, 0)), i: 0 }; }   // test only
  // the team's side: every walkable point clearly nearer its own end of the map than the other's (about a third of the
  // map), not a fixed spot. A random point of it no living enemy can see and no closer than 15 m to one (a fixed
  // spot got camped). Falls back to the team's core spawn cluster only if the whole side is covered
  const enemies = [...ents.values()].filter(v => v.team !== e.team && v.s.alive);
  const safe = i => { const p = W.nodes[i].p, head = p.clone(); head.y += C.eyeStand;
    for (const v of enemies) { const d = v.s.pos.distanceTo(p); if (d < 15 || (d < 70 && W.clear(eyePos(v.s), head))) return false; } return true; };
  const side = SIDE[e.team], tries = Math.min(side.length, 80);
  for (let k = 0; k < tries; k++) { const i = side[(Math.random() * side.length) | 0]; if (safe(i)) return W.nodes[i]; }
  const core = W.spawn[e.team].filter(i => side.includes(i)).length ? W.spawn[e.team].filter(i => side.includes(i)) : side;
  return W.nodes[core[(Math.random() * core.length) | 0]];
}
/* spawn facing: toward the enemy's side, but never into a wall. 24 eye-height rays; each direction scores its open
   distance (up to 25 m) plus a pull toward the enemy, so you start looking down the most open way they could come */
function spawnYaw(p, enemy) {
  const toE = Math.atan2(-(enemy.x - p.x), -(enemy.z - p.z)), o = p.clone(); o.y += 1.6; const d = new THREE.Vector3();
  let best = toE, bestScore = -1e9;
  for (let i = 0; i < 24; i++) { const yaw = toE + i / 24 * Math.PI * 2; d.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const h = W.first(o, d, 25), open = h ? h.distance : 25, score = Math.min(open, 25) + 6 * Math.cos(yaw - toE) - (open < 3 ? 40 : 0);
    if (score > bestScore) { bestScore = score; best = yaw; } }
  return Math.atan2(Math.sin(best), Math.cos(best));
}
/* what a player is sent about the others (anti wall-hack): a teammate or a dead body always; a living enemy only when
   the viewer could see it (head, chest or feet in line of sight from the eye, or from 0.5 m either side of it, so a
   peek shows them in time), within 4 m, or for 0.5 s after last seen. An unseen enemy RUNNING within 25 m is sent as
   heard (2): the page plays its footsteps but does not draw it, as a sound gives away roughly where someone is */
const seenTill = new Map(), V0 = new THREE.Vector3(), V1 = new THREE.Vector3();
function sightTo(viewer, e) {
  const eye = eyePos(viewer.s), side = new THREE.Vector3(-(e.s.pos.z - viewer.s.pos.z), 0, e.s.pos.x - viewer.s.pos.x).normalize().multiplyScalar(.5);
  for (const off of [0, 1, -1]) { V0.copy(eye).addScaledVector(side, off);
    for (const h of [1.6 - e.s.duck * .45, 1.1, .3]) { V1.set(e.s.pos.x, e.s.pos.y + h, e.s.pos.z); if (W.clear(V0, V1)) return true; } }
  return false;
}
function sendable(viewer, e) {
  if (e.team === viewer.team || !e.s.alive || !viewer.s.alive) return 1;
  const d = viewer.s.pos.distanceTo(e.s.pos), key = viewer.id * 100000 + e.id;
  if (d < 4 || sightTo(viewer, e)) { seenTill.set(key, time + .5); return 1; }
  if ((seenTill.get(key) || 0) > time) return 1;
  return d < 25 && Math.hypot(e.s.vel.x, e.s.vel.z) > 3.5 ? 2 : 0;
}
function spawnAt(e) {
  const n = pickSpawn(e);
  const s = e.s; s.pos.copy(n.p); s.vel.set(0, 0, 0); s.hp = 100; s.alive = true; s.duck = 0; s.punchX = s.punchY = 0; s.deployUntil = 0;
  equip(s, e.team ? "ak" : "m4"); s.last = "knife";
  s.yaw = spawnYaw(s.pos, W.nodes[W.spawn[1 - e.team][0] ?? 0].p); s.pitch = 0;
  e.respawnAt = 0; e.spawned = time; e.protect = time + PROTECT; e.spawnN = (e.spawnN || 0) + 1;   // the client turns to the spawn facing once per new spawnN
  if (e.bot) { e.mode = null; e.coverCd = 0; e.moving = false; e.phaseEnd = 0; e.burst = 0; e.nextShot = 0; e.lastKnown = null; e.path = W.astar(n.i, W.spawn[1 - e.team][(Math.random() * W.spawn[1 - e.team].length) | 0] ?? n.i); e.pi = 0; e.seen = 0; e.target = null; }
  events.push({ k: "spawn", id: e.id });
}
function addEntity(name, team, bot, ws) {
  const e = { id: nextId++, name, team, bot, ws, s: newPlayer(), q: [], ack: 0, clock: 0, kills: 0, deaths: 0, ping: 0, think: 0, burst: 0, nextShot: 0, reactAt: 0 };
  ents.set(e.id, e); spawnAt(e);
  if (MODE === "rounds" && G.round > 0 && G.ph !== "freeze") { e.s.alive = false; e.respawnAt = 0; }   // waits for the next round
  return e;
}
function balanceBots() {
  for (const team of [0, 1]) {
    const humans = [...ents.values()].filter(e => !e.bot && e.team === team).length, bots = [...ents.values()].filter(e => e.bot && e.team === team);
    const want = botCfg ? botCfg[team] : Math.max(0, PER_TEAM - humans);
    bots.sort((a, b) => (a.s.alive ? 1 : 0) - (b.s.alive ? 1 : 0));   // dead ones first
    while (bots.length > want) { if (MODE === "rounds" && G.ph === "live" && bots[0].s.alive) break; const b = bots.shift(); ents.delete(b.id); events.push({ k: "leave", id: b.id }); }
    for (let k = bots.length; k < want; k++) { const used = new Set([...ents.values()].map(e => e.name)); const nm = BOTNAMES.find(n => !used.has(n)) || "Bot" + nextId; addEntity(nm, team, true, null); }
  }
}

/* ── shooting, decided here ──────────────────────────────────────────────────── */
const NO_REWIND = process.env.NO_REWIND === "1";   // test only: decide hits on where everyone is now, to measure what rewinding is worth
function stateAt(id, t) {
  if (NO_REWIND) { const v = ents.get(id); return v ? { x: v.s.pos.x, y: v.s.pos.y, z: v.s.pos.z, duck: v.s.duck, alive: v.s.alive } : null; }
  // the newest recorded tick at or before t (the shooter's view time), never more than REWIND_MAX back
  const tt = clamp(t, time - REWIND_MAX, time); let best = null;
  for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].time <= tt + 1e-6) { best = hist[i]; break; } }
  const h = best && best.states.get(id); return h || null;
}
function resolveShot(e, dir, viewTime, melee = false) {
  const Wp = WEAPONS[e.s.w] || WEAPONS.ak, far = melee ? Wp.range : 300;
  const o = eyePos(e.s), wh = W.first(o, dir, far), wd = wh ? wh.distance : far;
  let best = null;
  for (const v of ents.values()) {
    if (v === e || (v.team === e.team && !FF)) continue;
    const st = e.bot ? { x: v.s.pos.x, y: v.s.pos.y, z: v.s.pos.z, duck: v.s.duck, alive: v.s.alive } : stateAt(v.id, viewTime);
    if (process.env.DEBUG_SHOTS && !e.bot && st) { const c = new THREE.Vector3(st.x, st.y + 1.2, st.z), along = c.clone().sub(o).dot(dir), miss = o.clone().addScaledVector(dir, along).distanceTo(c);
      log(`shot by ${e.id}: rewind ${((time - viewTime) * 1000).toFixed(0)} ms, target moved ${Math.hypot(st.x - v.s.pos.x, st.z - v.s.pos.z).toFixed(2)} m, ray passes ${(miss * 100).toFixed(0)} cm from the rewound chest, world hit at ${wd.toFixed(1)} m, target at ${along.toFixed(1)} m`); }
    if (!st || !st.alive) continue;
    const h = hitBox(new THREE.Vector3(st.x, st.y, st.z), st.duck, o, dir);
    if (h && h.t < wd && (!best || h.t < best.t)) best = { ...h, v };
  }
  const end = o.clone().addScaledVector(dir, best ? best.t : wd);
  events.push({ k: melee ? "melee" : "shot", id: e.id, g: WIDS.indexOf(e.s.w), f: [+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2)], t: [+end.x.toFixed(2), +end.y.toFixed(2), +end.z.toFixed(2)], w: wh && !best ? 1 : 0 });
  if (best && best.v.s.alive) damage(best.v, e, Wp.dmg[best.part], best.part === "head");
}
function damage(v, by, dmg, head) {
  if (v.protect > time || G.ph === "over") return;
  if (process.env.NO_DEATH === "1") { events.push({ k: "hit", id: v.id, by: by.id, d: dmg, h: head ? 1 : 0 }); return; }   // test only: hits count, nobody dies
  v.s.hp = Math.max(0, v.s.hp - dmg); events.push({ k: "hit", id: v.id, by: by.id, d: dmg, h: head ? 1 : 0 });
  if (v.bot && !v.seen) { v.seen = time; v.reactAt = time + .3 + Math.random() * .25; v.target = by; }
  if (v.s.hp <= 0 && v.s.alive) { if (v.s.prim) dropWeapon(v.s.prim, v.s.pos, v.s.mag, v.s.res); v.s.prim = null; v.s.alive = false; v.deaths++; if (by !== v) by.kills += by.team === v.team ? -1 : 1;   // a team kill costs a kill
     v.respawnAt = MODE === "dm" ? time + RESPAWN : 0; if (MODE === "dm" && by.team !== v.team) G.sc[by.team]++; if (SLOT != null) { if (!by.bot && by.team !== v.team) boardHit(SLOT, MAP_ID, by.name, 1, 0); if (!v.bot) boardHit(SLOT, MAP_ID, v.name, 0, 1); }
     events.push({ k: "kill", id: v.id, by: by.id, h: head ? 1 : 0, g: WIDS.indexOf(by.s.w), kh: Math.max(0, by.s.hp | 0), kd: Math.round(by.s.pos.distanceTo(v.s.pos)) }); }   // kh/kd: the killer's health left and the distance, for the victim's card
}

/* ── bots: walk the routes, take the nearest enemy they can see, shoot in bursts ─ */
function canSee(b, v) {
  if (!v.s.alive) return false;
  const e = eyePos(b.s), head = eyePos(v.s), chest = v.s.pos.clone(); chest.y += height(v.s) * .6;
  if (e.distanceTo(head) > 80) return false;
  const fwd = new THREE.Vector3(-Math.sin(b.s.yaw), 0, -Math.cos(b.s.yaw)), hd = head.clone().sub(e).setY(0).normalize();
  if (!(b.alert > time) && fwd.dot(hd) < Math.cos(80 * DEG)) return false;
  return W.clear(e, head) || W.clear(e, chest);
}
/* bots, beyond aim and strafe: below 45 health they break off to the nearest spot the attacker cannot see (14 m of
   walking at most), wait 2-3 s and come back from another side; a lost target is approached from the flank half the
   time; roaming favours the contested middle, and a hurt bot detours to a bandage or kevlar */
const BOTSTAT = { cover: 0, flank: 0, chase: 0, heal: 0, middle: 0, roam: 0, backToFight: 0 }; if (process.env.DEBUG_BOTS) setInterval(() => log(`[${code}] bots ${JSON.stringify(BOTSTAT)}`), 30000);   // test only
const pathTo = (b, i) => { b.path = i >= 0 ? W.astar(W.nearest(b.s.pos), i) : []; b.pi = 0; };
function coverFrom(b, threat) {
  const d = W.dijkstra(W.nearest(b.s.pos)), eye = eyePos(threat.s); let best = -1, bd = 14;
  for (const n of W.nodes) if (d[n.i] < bd) { V1.set(n.p.x, n.p.y + 1.1, n.p.z); if (!W.clear(eye, V1)) { bd = d[n.i]; best = n.i; } }
  return best;
}
function flankNode(b, at) {
  const goal = W.nearest(at), d = W.dijkstra(goal), ax = at.x - b.s.pos.x, az = at.z - b.s.pos.z, al = Math.hypot(ax, az) || 1, opts = [];
  for (const n of W.nodes) if (d[n.i] > 3 && d[n.i] < 9) { const vx = at.x - n.p.x, vz = at.z - n.p.z, vl = Math.hypot(vx, vz) || 1; if ((ax * vx + az * vz) / (al * vl) < .35) opts.push(n.i); }
  return opts.length ? opts[(Math.random() * opts.length) | 0] : goal;
}
const MIDDLE = W.middle || (W.middle = (() => { const a = new Set(SIDE[0]), c = new Set(SIDE[1]); return W.nodes.filter(n => !a.has(n.i) && !c.has(n.i)).map(n => n.i); })());
function roamTarget(b) {
  const s = b.s;
  if (s.hp < 70) { let best = null, bd = 40; for (const x of PK) if ((x.kind === 3 && s.hp < 100 || x.kind === 2) && !x.at) { const d = x.p.distanceTo(s.pos); if (d < bd) { bd = d; best = x; } } if (best) { BOTSTAT.heal++; return W.nearest(best.p); } }
  if (MIDDLE.length && Math.random() < .6) { BOTSTAT.middle++; return MIDDLE[(Math.random() * MIDDLE.length) | 0]; } BOTSTAT.roam++; return (Math.random() * W.nodes.length) | 0;
}
/* a bot's burst, once it has reacted and faces its target; errMul scales the spread and the gap between shots (a moving
   bot shoots slower and much less accurately, as anyone running and gunning does) */
function botFire(b, s, dy, errMul) {
    if (time > b.reactAt && Math.abs(dy) < 6 * DEG && time > b.nextShot) {
    if (b.burst <= 0) b.burst = 3 + (Math.random() * 4 | 0);
    const v = b.target, aimHead = Math.random() < .2, tgt = aimHead ? eyePos(v.s) : v.s.pos.clone().setY(v.s.pos.y + height(v.s) * .6);
    const o = eyePos(s), dist = o.distanceTo(tgt), err = errMul * (Math.max(1.8, 5 - (time - b.seen) * 1.4) + Math.hypot(v.s.vel.x, v.s.vel.z) * .35 + dist * .015) * DEG;
    const d = tgt.sub(o).normalize(), ax = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize(), ay = new THREE.Vector3().crossVectors(ax, d);
    const r = Math.sqrt(Math.random()) * err, th = Math.random() * Math.PI * 2; d.addScaledVector(ax, Math.tan(r) * Math.cos(th)).addScaledVector(ay, Math.tan(r) * Math.sin(th)).normalize();
    b.protect = 0; resolveShot(b, d, time); b.burst--; b.nextShot = time + (b.burst > 0 ? (WEAPONS[s.w] || WEAPONS.ak).rate * errMul : .28 + Math.random() * .27);
  }
}
function botTick(b) {
  const s = b.s; if (!s.alive) return;
  if (time > b.think) {
    b.think = time + .1;
    let best = null, bd = Infinity;
    for (const v of ents.values()) if (v.team !== b.team && v.s.alive && !(v.protect > time)) { const d = v.s.pos.distanceTo(s.pos); if (d < bd && canSee(b, v)) { bd = d; best = v; } }
    if (b.mode === "cover") { if (best && bd < 7) { b.mode = null; BOTSTAT.backToFight++; } else best = null; }   // in cover: only someone close pulls it back into the fight
    if (best && s.hp < 45 && time > (b.coverCd || 0)) { const c = coverFrom(b, best); if (c >= 0) { BOTSTAT.cover++; b.mode = "cover"; b.coverCd = time + 10; b.coverUntil = 0; b.lastKnown = best.s.pos.clone(); b.seen = 0; b.target = null; pathTo(b, c); best = null; } }
    if (b.mode === "cover" && (!b.path || !b.path.length)) { if (!b.coverUntil) b.coverUntil = time + 2 + Math.random(); else if (time > b.coverUntil) { b.mode = null; if (b.lastKnown) pathTo(b, flankNode(b, b.lastKnown)); } }
    if (best) { if (!b.seen || b.target !== best) { b.seen = time; b.reactAt = time + .35 + Math.random() * .3; } b.target = best; b.lastKnown = best.s.pos.clone(); }
    else if (b.seen) { b.seen = 0; b.target = null; if (b.lastKnown) { const f = Math.random() < .5; BOTSTAT[f ? "flank" : "chase"]++; pathTo(b, f ? flankNode(b, b.lastKnown) : W.nearest(b.lastKnown)); } }
  }
  if (b.mode !== "cover" && b.seen && b.target && b.target.s.alive) {
    const to = eyePos(b.target.s).sub(eyePos(s)), want = Math.atan2(-to.x, -to.z); let dy = ((want - s.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI; s.yaw += clamp(dy, -8 * DT, 8 * DT);
    s.pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
    // move while fighting: strafe a moment (about half the strafes shooting, less accurately), stop, fire a burst, strafe again
    if (!b.phaseEnd || time > b.phaseEnd) { b.moving = !b.moving; if (b.moving) b.runGun = Math.random() < .55; b.phaseEnd = time + (b.moving ? .35 + Math.random() * .45 : .45 + Math.random() * .5); if (b.moving && Math.random() < .5) b.side = -(b.side || 1); }
    if (b.moving) {
      const dist = to.length(), fwd = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw)), rt = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const dir = rt.multiplyScalar(b.side || 1); if (dist > 25) dir.add(fwd.multiplyScalar(.8)); dir.normalize();
      const sp = 3.6 * DT, eyeP = eyePos(s), next = s.pos.clone().addScaledVector(dir, sp);
      const k0 = s.pos.clone(); k0.y += .5;
      const ground = W.first(next.clone().setY(next.y + .5), new THREE.Vector3(0, -1, 0), 1.2);
      if (W.first(k0, dir, .6) || !ground) { b.side = -(b.side || 1); }
      else { s.pos.set(next.x, ground.point.y, next.z); s.vel.copy(dir).multiplyScalar(3.6); }
      void eyeP; if (b.runGun) botFire(b, s, dy, 2.2);   // group feedback 2026-11-01: "bots stand still while firing"
      return;
    }
    s.vel.set(0, 0, 0);
    botFire(b, s, dy, 1);
    return;
  }
  if (!b.path || !b.path.length) { if (b.mode === "cover") { s.vel.set(0, 0, 0); return; } pathTo(b, roamTarget(b)); }   // in cover: hold still behind it
  const tgt = W.nodes[b.path[b.pi]];
  if (!tgt) { b.path = []; return; }
  const L = Math.hypot(tgt.p.x - s.pos.x, tgt.p.z - s.pos.z);
  if (L < .3) { b.pi++; if (b.pi >= b.path.length) b.path = []; return; }
  const sp = C.maxspeed * C.rifle, k = Math.min(1, sp * DT / L), px = s.pos.x, pz = s.pos.z;
  s.pos.x += (tgt.p.x - s.pos.x) * k; s.pos.z += (tgt.p.z - s.pos.z) * k; s.pos.y += (tgt.p.y - s.pos.y) * k;
  s.vel.set((s.pos.x - px) / DT, 0, (s.pos.z - pz) / DT);
  const want = Math.atan2(-(tgt.p.x - s.pos.x), -(tgt.p.z - s.pos.z)); let dy = ((want - s.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI; s.yaw += clamp(dy, -6 * DT, 6 * DT); s.pitch = 0;
}

/* ── pickups: weapons in the contested middle, ammo spread out, and whatever the dead drop ───────────────────── */
const PK = []; let pkId = 1;
if (!W.layout) { const PK = []; let pkId = 1;   // the layout once per map; each room gets its own copy below
  const n = W.nodes, dA = W.dijkstra(W.spawn[0][0] ?? 0), dB = W.dijkstra(W.spawn[1][0] ?? 0), span = W.span || 1;
  const spread = (cands, k, avoid = []) => { const out = [...avoid]; const pick = [];
    for (let j = 0; j < k && cands.length; j++) { let best = cands[0], bd = -1;
      for (const i of cands) { const p = n[i].p; let d = Infinity; for (const q of out) d = Math.min(d, p.distanceTo(q)); if (!out.length) d = Math.abs(dA[i] - dB[i]) * -1; if (d > bd) { bd = d; best = i; } }
      out.push(n[best].p); pick.push(best); }
    return pick; };
  // weapons where both sides reach about as soon as each other, away from either spawn
  const mid = n.map(x => x.i).filter(i => isFinite(dA[i]) && isFinite(dB[i]) && dA[i] > span * .3 && dB[i] > span * .3 && Math.abs(dA[i] - dB[i]) < span * .22);
  const kinds = ["awp", "aug", "aug", "ak", "m4"];
  spread(mid.length ? mid : n.map(x => x.i), kinds.length).forEach((i, j) => PK.push({ id: pkId++, kind: 0, w: kinds[j], p: n[i].p.clone(), home: true, respawn: kinds[j] === "awp" ? 40 : 25, at: 0 }));
  const away = n.map(x => x.i).filter(i => dA[i] > 5 && dB[i] > 5);
  spread(away, 6, PK.map(x => x.p)).forEach(i => PK.push({ id: pkId++, kind: 1, p: n[i].p.clone(), home: true, respawn: 10, at: 0 }));
  spread(away, 3, PK.map(x => x.p)).forEach(i => PK.push({ id: pkId++, kind: 2, p: n[i].p.clone(), home: true, respawn: 25, at: 0 }));   // kevlar: +50 health, to 150
  spread(away, 4, PK.map(x => x.p)).forEach(i => PK.push({ id: pkId++, kind: 3, p: n[i].p.clone(), home: true, respawn: 15, at: 0 }));   // bandage: +40 health, to 100
  log("pickups:", PK.map(x => ["", "ammo", "kevlar", "bandage"][x.kind] || x.w).join(", "));
  W.layout = PK;
}
for (const x of W.layout) PK.push({ ...x, id: pkId++, p: x.p.clone(), at: 0 });
/* a new round or match starts with every pickup back and nothing dropped lying around */
function resetPickups() { for (let i = PK.length - 1; i >= 0; i--) { if (!PK[i].home) PK.splice(i, 1); else PK[i].at = 0; } }
function dropWeapon(w, pos, mag, res) {
  PK.push({ id: pkId++, kind: 0, w, p: pos.clone(), home: false, mag, res, until: time + 30, at: 0 });
  const dropped = PK.filter(x => !x.home); if (dropped.length > 24) PK.splice(PK.indexOf(dropped[0]), 1);
}
const near = (s, p, r) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < r && Math.abs(s.pos.y - p.y) < 1.3;
function usePickups(e, cmd) {
  const s = e.s, press = !!cmd.use && !e.useHeld; e.useHeld = !!cmd.use; if (!s.alive) return;
  // ammo: walk over a box to fill the primary's reserve
  for (const x of PK) if (x.kind === 1 && !x.at && s.prim && s.res < WEAPONS[s.prim].res && near(s, x.p, 1.2)) { s.res = WEAPONS[s.prim].res; x.at = time + x.respawn; events.push({ k: "ammo", id: e.id }); }
  // kevlar raises health above the normal 100 (to 150); a bandage brings it back up (to 100)
  for (const x of PK) if (x.kind === 2 && !x.at && s.hp < 150 && near(s, x.p, 1.2)) { s.hp = Math.min(150, s.hp + 50); x.at = time + x.respawn; events.push({ k: "kevlar", id: e.id }); }
  for (const x of PK) if (x.kind === 3 && !x.at && s.hp < 100 && near(s, x.p, 1.2)) { s.hp = Math.min(100, s.hp + 40); x.at = time + x.respawn; events.push({ k: "bandage", id: e.id }); }
  if (!press) return;
  // E: take the nearest weapon in reach, leaving yours in its place
  let best = null, bd = 1.6; for (const x of PK) if (x.kind === 0 && !x.at) { const d = Math.hypot(s.pos.x - x.p.x, s.pos.z - x.p.z); if (d < bd && Math.abs(s.pos.y - x.p.y) < 1.3) { bd = d; best = x; } }
  if (!best) return;
  if (s.prim) dropWeapon(s.prim, s.pos, s.mag, s.res);
  equip(s, best.w, best.mag, best.res); s.deployUntil = e.clock + WEAPONS[best.w].deploy;
  if (best.home) best.at = time + best.respawn; else PK.splice(PK.indexOf(best), 1);
  events.push({ k: "pick", id: e.id, g: WIDS.indexOf(best.w) });
}
function tickPickups() {
  for (let i = PK.length - 1; i >= 0; i--) { const x = PK[i]; if (x.home && x.at && time >= x.at) x.at = 0; if (!x.home && time > x.until) PK.splice(i, 1); }
  for (const e of ents.values()) if (e.bot && e.s.alive) usePickups(e, {});   // bots walk over ammo, kevlar and bandages like anyone
}

/* ── the match: clock, round ends, results, restart ──────────────────────────── */
const TEAMNAME = ["Atlas", "Ember"];   // our own two sides
function resetMatch() { G.sc = [0, 0]; G.round = 0; for (const e of ents.values()) { e.kills = 0; e.deaths = 0; } }
function respawnAll() { for (const e of ents.values()) spawnAt(e); }
function endMatch() {
  const w = G.sc[0] === G.sc[1] ? -1 : G.sc[0] > G.sc[1] ? 0 : 1; G.winner = w; G.ph = "over"; G.until = time + 12;
  G.msg = w < 0 ? "Draw" : TEAMNAME[w] + " wins"; events.push({ k: "match", w, sc: G.sc.slice() }); roster();
}
function startRound() {
  G.round++; G.ph = "freeze"; G.until = time + MODES.rounds.freeze; G.msg = "";
  resetPickups(); balanceBots();
  for (const e of ents.values()) { const keep = e.s.alive && e.s.prim ? [e.s.prim, e.s.mag, e.s.res] : null; spawnAt(e); if (keep) { equip(e.s, ...keep); e.s.last = "knife"; } e.protect = 0; }
  events.push({ k: "round", n: G.round });
}
function match() {
  if (MODE === "dm") {
    if (G.ph === "live" && !G.until) G.until = time + MODES.dm.time;
    if (G.ph === "live" && time >= G.until) endMatch();
    else if (G.ph === "over" && time >= G.until) { resetMatch(); resetPickups(); respawnAll(); G.ph = "live"; G.until = time + MODES.dm.time; G.msg = ""; events.push({ k: "restart" }); }
    return;
  }
  const R = MODES.rounds;
  if (!G.round) { startRound(); return; }
  if (G.ph === "freeze" && time >= G.until) { G.ph = "live"; G.until = time + R.roundTime; }
  else if (G.ph === "live") {
    const alive = [0, 1].map(t => [...ents.values()].filter(e => e.team === t && e.s.alive).length), present = [0, 1].map(t => [...ents.values()].some(e => e.team === t));
    let w = -1, why = "";
    if (present[0] && present[1] && !alive[0] && !alive[1]) { w = 2; why = "everyone down"; }
    else if (present[1] && !alive[1] && alive[0]) { w = 0; why = "Ember eliminated"; }
    else if (present[0] && !alive[0] && alive[1]) { w = 1; why = "Atlas eliminated"; }
    else if (time >= G.until) { w = present[0] ? 0 : present[1] ? 1 : 2; why = "time ran out"; }   // CT hold on time, if there are any
    if (w === 2) { G.ph = "end"; G.until = time + 4; G.winner = -1; G.msg = "Round drawn (" + why + ")"; events.push({ k: "roundEnd", w: -1, sc: G.sc.slice() }); }
    else if (w >= 0) { G.sc[w]++; G.ph = "end"; G.until = time + 4; G.winner = w; G.msg = TEAMNAME[w] + " win the round (" + why + ")"; events.push({ k: "roundEnd", w, sc: G.sc.slice() }); }
  } else if (G.ph === "end" && time >= G.until) {
    if (G.sc[0] >= R.toWin || G.sc[1] >= R.toWin || G.round >= R.maxRounds) endMatch(); else startRound();
  } else if (G.ph === "over" && time >= G.until) { resetMatch(); startRound(); events.push({ k: "restart" }); }
}
const frozen = () => (MODE === "rounds" && G.ph === "freeze") || G.ph === "over";   // the results screen holds everyone still

/* ── the tick ────────────────────────────────────────────────────────────────── */
function step() {
  tick++; time = tick * DT;
  const floor = W.bounds.min.y - 4;
  for (const e of ents.values()) {
    if (e.s.alive && e.s.pos.y < floor) { spawnAt(e); log(`[${code}] ${e.name} fell out of the world, respawned`); }   // a slip through the mesh: back in, no death
    if (e.bot) { if (!frozen()) botTick(e); continue; }
    // every command that has arrived, at most 8 a tick (a client cannot run faster than real time for long)
    // a client's clock stays within a quarter second of real time either way: idle time cannot be saved up and spent
    // in a burst, and a flood waits its turn
    e.clock = Math.max(e.clock, time - e.joinedAt - .25);
    for (let n = 0; n < 8 && e.q.length && e.clock + DT <= time - e.joinedAt + .25; n++) {
      const cmd = e.q.shift(); e.ack = cmd.seq; e.clock += DT;
      if (frozen()) { cmd.f = cmd.s = 0; cmd.jump = cmd.fire = false; }
      move(W, e.s, cmd);
      const shot = weapon(e.s, cmd, e.clock, (e.id * 100003 + cmd.seq) >>> 0);
      if (shot) { e.protect = 0; resolveShot(e, shot.dir, typeof cmd.vt === "number" ? cmd.vt : time, !!shot.melee); }
      usePickups(e, cmd);
    }
    if (e.q.length > 64) e.q.splice(0, e.q.length - 64);
  }
  for (const e of ents.values()) if (!e.s.alive && e.respawnAt && time >= e.respawnAt) spawnAt(e);
  match();
  tickPickups();
  const states = new Map(); for (const e of ents.values()) states.set(e.id, { x: e.s.pos.x, y: e.s.pos.y, z: e.s.pos.z, duck: e.s.duck, alive: e.s.alive });
  hist.push({ time, states }); if (hist.length > TICK) hist.shift();
  if (tick % 2 === 0) snapshot();
  if (tick % TICK === 0) roster();
  if (tick % (TICK * 30) === 0) for (const e of ents.values()) if (!e.bot) log(`[${code}] ${e.name} ping ${e.ping} ms`);   // what players actually get
}
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
function snapshot() {
  const row = (e, mine, vis) => [e.id, e.team, e.bot ? 1 : 0, r2(e.s.pos.x), r2(e.s.pos.y), r2(e.s.pos.z), r3(e.s.yaw), r3(e.s.pitch), r2(e.s.duck), e.s.alive ? 1 : 0, r2(e.s.vel.x), r2(e.s.vel.z), WIDS.indexOf(e.s.w), mine ? e.s.hp : null, vis];   // an enemy's health is not sent
  if (tick % 640 === 0) for (const [k, v] of seenTill) if (v < time) seenTill.delete(k);   // forget old sightings every 10 s
  const listFor = viewer => { const out = []; for (const e of ents.values()) { if (e === viewer) continue; const v = sendable(viewer, e); if (v) out.push(row(e, e.team === viewer.team, v === 2 ? 0 : 1)); } return out; };
  // every pickup, with the seconds until a taken one comes back (0 = there now), so the page can show where it will be
  const pk = PK.map(x => [x.id, x.kind, x.kind ? -x.kind : WIDS.indexOf(x.w), r2(x.p.x), r2(x.p.y), r2(x.p.z), x.at ? Math.max(0, Math.ceil(x.at - time)) : 0]);
  const ev = events; events = [];
  for (const e of ents.values()) {
    if (e.bot || !e.ws || e.ws.readyState !== 1) continue;
    const s = e.s;
    e.ws.send(JSON.stringify({ t: "s", k: tick, tm: time, a: e.ack, me: {
      p: [s.pos.x, s.pos.y, s.pos.z], v: [s.vel.x, s.vel.y, s.vel.z], d: s.duck, g: s.onGround, j: s.jumpHeld, h: s.hp, al: s.alive,
      m: s.mag, r: s.res, ra: s.reloadAt, ns: s.nextShot, sp: s.spray, ls: s.lastShot, px: s.punchX, py: s.punchY, ck: e.clock, ra2: e.respawnAt ? e.respawnAt - time : 0, pr: e.protect > time ? e.protect - time : 0,
      w: s.w, pm: s.prim, la: s.last, z: s.zoom, du: s.deployUntil, zh: s.zoomHeld, sn: e.spawnN, syw: e.spawnN ? s.yaw : 0 },
      e: listFor(e), pk, ev, gm: { m: MODE, ph: G.ph, tl: Math.max(0, Math.ceil(G.until - time)), rn: G.round, sc: G.sc, msg: G.msg, fz: frozen() } }));
  }
}
function roster() {
  const r = [...ents.values()].map(e => [e.id, e.name, e.team, e.bot ? 1 : 0, e.kills, e.deaths, e.ping]);
  for (const e of ents.values()) if (!e.bot && e.ws && e.ws.readyState === 1) e.ws.send(JSON.stringify({ t: "r", r }));
}


  /* a player joins: on the side asked for (or the emptier one), bots rebalanced around them */
  function join(ws, ws0, name, teamPref) {
    if ([...ents.values()].filter(e => !e.bot).length >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: "x", why: "That room is full" })); ws.close(1013, "full"); return; }
    const humans = [0, 1].map(t => [...ents.values()].filter(e => !e.bot && e.team === t).length);
    const team = teamPref === "ct" ? 0 : teamPref === "t" ? 1 : humans[0] <= humans[1] ? 0 : 1;
    const e = addEntity(name, team, false, ws); e.joinedAt = time;
    balanceBots(); emptySince = 0;
    ws.send(JSON.stringify({ t: "w", id: e.id, team: e.team, map: MAP_ID, tick, tm: time, rate: TICK, room: code, title, mode: MODE }));
    roster(); log(`[${code}] join ${e.id} ${name} team ${e.team ? "Ember" : "Atlas"}`);
    ws0.on("message", raw0 => FAKE_LAG ? setTimeout(() => onMsg(raw0), FAKE_LAG) : onMsg(raw0));
    function onMsg(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== "object") return;
      if (m.t === "c" && Array.isArray(m.c)) for (const c of m.c.slice(0, 32)) {
        if (!c || typeof c !== "object" || !Number.isFinite(c.seq) || c.seq <= (e.q.length ? e.q[e.q.length - 1].seq : e.ack)) continue;
        const fin = (x, d = 0) => Number.isFinite(+x) ? +x : d;
        e.q.push({ seq: c.seq, f: clamp(fin(c.f), -1, 1), s: clamp(fin(c.s), -1, 1), jump: !!c.jump, duck: !!c.duck, walk: !!c.walk, fire: !!c.fire, reload: !!c.reload,
                   yaw: fin(c.yaw) % (Math.PI * 2), pitch: clamp(fin(c.pitch), -89 * DEG, 89 * DEG), vt: fin(c.vt, time),
                   slot: ["p", "k", "q"].includes(c.slot) ? c.slot : null, zoom: !!c.zoom, use: !!c.use });
      } else if (m.t === "u") {
        // unstuck (group feedback 2026-11-01: fell into a pit and could not get out): a self-kill, as CS's "kill" - a death
        // on the board, no kill for anyone, the normal respawn - at most once every 10 s
        if (e.s.alive && time - (e.lastUnstuck ?? -99) >= 10) { e.lastUnstuck = time; e.protect = 0; damage(e, e, 1000, false); }
      } else if (m.t === "p") { ws.send(JSON.stringify({ t: "P", n: m.n, tm: time })); }
      else if (m.t === "q" && typeof m.ms === "number") e.ping = Math.round(m.ms);
    }
    ws0.on("close", () => { ents.delete(e.id); events.push({ k: "leave", id: e.id }); balanceBots(); roster(); log(`[${code}] leave ${e.id} ${name}`);
      if (![...ents.values()].some(x => !x.bot)) emptySince = Date.now(); });
  }
  let emptySince = Date.now();
  balanceBots();
  return { code, title, step, join, created: Date.now(), map: MAP_ID,
           moveAll: why => { for (const e of ents.values()) if (!e.bot && e.ws && e.ws.readyState === 1) { e.ws.send(JSON.stringify({ t: "newmap", why, best: SLOT != null ? boardTop(SLOT, 1).find(b => b.k > 0) || null : null })); e.ws.close(4000, "new map"); } },
           info: () => { const v = [...ents.values()]; return { code, title, map: MAP_ID, mapName: MAPS[MAP_ID].name, next: code === "DAILY" ? nextDaily() : null, board: SLOT != null ? boardTop(SLOT, 5) : undefined, past: SLOT != null ? boardPast(SLOT, 3) : undefined, mode: MODE, modeName: MODES[MODE].name, ff: FF, bots: v.filter(e => e.bot).length, humans: v.filter(e => !e.bot).length, bots: v.filter(e => e.bot).length, max: MAX_PLAYERS,
             ct: v.filter(e => !e.bot && e.team === 0).length, t: v.filter(e => !e.bot && e.team === 1).length }; },
           idle: () => emptySince && Date.now() - emptySince > 90000 };
}

/* ── the rooms: one public room always open, others made with a short code and closed when empty ───────────── */
const rooms = new Map(), MAX_ROOMS = 12;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() { for (;;) { let c = ""; for (let i = 0; i < 4; i++) c += ALPHA[(Math.random() * ALPHA.length) | 0]; if (!rooms.has(c)) return c; } }

setInterval(() => { for (const [c, r] of rooms) if (c !== "DAILY" && r.idle()) { rooms.delete(c); log(`room ${c} closed (empty)`); } }, 10000);
/* the daily map: one public room on a generated world that changes on a schedule (hourly for the demo; DAILY_PERIOD=86400
   switches at midnight UTC). Everyone in it is moved to the new world when it changes */
const DAILY_LIST = ROTATION, DAILY_PERIOD = +(process.env.DAILY_PERIOD || 3600);
/* today's board: every human's kills and deaths for each turn of the rotation (one map, one DAILY_PERIOD), kept for
   the last 8 turns in $STATE_DIRECTORY/boards.json so a restart keeps it. Names are free text (no accounts): one name,
   one row. Kills count against the other team (bots included); deaths count however they happen */
const BOARD_FILE = path.join(process.env.STATE_DIRECTORY || path.dirname(new URL(import.meta.url).pathname), "boards.json"), slotNow = () => Math.floor(Date.now() / 1000 / DAILY_PERIOD);
let boards = (() => { try { return JSON.parse(fs.readFileSync(BOARD_FILE, "utf8")); } catch (e) { return {}; } })(), boardsDirty = false;
function boardHit(slot, map, name, dk, dd) { const b = boards[slot] || (boards[slot] = { map, s: {} }), r = b.s[name] || (b.s[name] = [0, 0]); r[0] += dk; r[1] += dd; boardsDirty = true; }
setInterval(() => { if (!boardsDirty) return; boardsDirty = false; for (const k of Object.keys(boards).map(Number).sort((a, b) => b - a).slice(8)) delete boards[k];
  try { fs.writeFileSync(BOARD_FILE + ".tmp", JSON.stringify(boards)); fs.renameSync(BOARD_FILE + ".tmp", BOARD_FILE); } catch (e) { log("boards: " + e.message); } }, 10000);
const boardTop = (slot, n) => { const b = boards[slot]; return b ? Object.entries(b.s).sort((x, y) => y[1][0] - x[1][0] || x[1][1] - y[1][1]).slice(0, n).map(([name, [k, d]]) => ({ name, k, d })) : []; };
const boardPast = (slot, n) => Object.keys(boards).map(Number).filter(k => k < slot && boards[k].map && MAPS[boards[k].map]).sort((a, b) => b - a).slice(0, n)
  .map(k => ({ map: MAPS[boards[k].map].name.replace(/, HY-World$/, ""), preview: "maps/" + boards[k].map + "-preview.jpg", best: boardTop(k, 1).find(b => b.k > 0) || null, players: Object.keys(boards[k].s).length }));
const dailyIndex = () => Math.floor(Date.now() / 1000 / DAILY_PERIOD) % DAILY_LIST.length;
const dailyTitle = id => MAPS[id].name.replace(/, HY-World$/, "");
let dailyAt = dailyIndex();
rooms.set("DAILY", createRoom("DAILY", dailyTitle(DAILY_LIST[dailyAt]), "dm", null, false, DAILY_LIST[dailyAt]));
setInterval(() => { const i = dailyIndex(); if (i === dailyAt) return; dailyAt = i; const id = DAILY_LIST[i], old = rooms.get("DAILY");
  rooms.set("DAILY", createRoom("DAILY", dailyTitle(id), "dm", null, false, id)); if (old) old.moveAll(MAPS[id].name); log(`daily map is now ${id}`); }, 5000);

/* ── files and the socket on one port ────────────────────────────────────────── */
const GZ = new Map();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".glb": "model/gltf-binary", ".splat": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent((req.url || "/").split("?")[0]); } catch { res.writeHead(400); res.end("bad request"); return; } if (p === "/") p = "/index.html";
  // what a player's page reports about itself (phones); small, logged one line each, rate-limited
  if (p === "/diag" && req.method === "POST") { let b = ""; req.on("data", d => { if (b.length < 4000) b += d; }); req.on("end", () => { if ((diagN = diagN + 1) < 600) log("diag " + b.replace(/[\r\n]/g, " ").slice(0, 1500)); res.writeHead(204); res.end(); }); return; }
  if (p === "/rooms") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify([...rooms.values()].filter(r => r.code === "DAILY").map(r => ({ ...r.info(), preview: "maps/" + r.map + "-preview.jpg", online: [...rooms.values()].reduce((n, x) => n + x.info().humans, 0) })))); return; }
  const ok = /^\/(index\.html|preview\.html|game\.js|sim\.js|models\.js|vendor\/[\w./-]+|maps\/[\w.-]+)$/.test(p) && !p.includes("..");
  const f = path.join(ROOT, p);
  if (!ok || !f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end("not found"); return; }
  const type = MIME[path.extname(f)] || "application/octet-stream", cache = p.startsWith("/vendor/") || p.startsWith("/maps/") ? "public, max-age=86400" : "no-cache";
  // text goes out gzipped (code is several times smaller); built once per file version and kept
  if (/\.(js|html|json|css)$/.test(f) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    const st = fs.statSync(f), key = f + ":" + st.mtimeMs; let z = GZ.get(key);
    if (!z) { z = zlib.gzipSync(fs.readFileSync(f), { level: 9 }); GZ.set(key, z); }
    res.writeHead(200, { "content-type": type, "content-encoding": "gzip", "vary": "accept-encoding", "cache-control": cache }); res.end(z); return;
  }
  // the size goes with it, so the page can show how far a map download has got
  res.writeHead(200, { "content-type": type, "cache-control": cache, "content-length": fs.statSync(f).size });
  fs.createReadStream(f).pipe(res);
});
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
wss.on("connection", (ws0, req) => {
  const ws = FAKE_LAG ? { get readyState() { return ws0.readyState; }, send: d => setTimeout(() => ws0.readyState === 1 && ws0.send(d), FAKE_LAG), close: (...a) => ws0.close(...a) } : ws0;
  const q = new URL(req.url, "http://x").searchParams, name = (q.get("name") || "player").replace(/[^\w .-]/g, "").slice(0, 16) || "player";
  const team = ["ct", "t"].includes(q.get("team")) ? q.get("team") : "auto";
  let room;
  if (q.get("create") === "1") {
    if (rooms.size >= MAX_ROOMS) { ws0.send(JSON.stringify({ t: "x", why: "Too many rooms open, join one of them" })); ws0.close(1013, "too many rooms"); return; }
    const code = newCode(), title = (q.get("title") || name + "'s room").replace(/[^\w .'-]/g, "").slice(0, 24) || code;
    const bpt = parseInt(q.get("bpt"), 10), bots = q.get("bots") === "0" ? [0, 0] : bpt >= 1 && bpt <= 5 ? [bpt, bpt] : null;   // a private room: today's map, no bots or 1-5 a side
    room = createRoom(code, title, "dm", bots, false, DAILY_LIST[dailyAt]); rooms.set(code, room); log(`room ${code} "${title}" created by ${name}`);
  } else room = rooms.get((q.get("room") || "DAILY").toUpperCase());
  if (!room) { ws0.send(JSON.stringify({ t: "x", why: "No room with that code" })); ws0.close(4004, "no such room"); return; }
  room.join(ws, ws0, name, team);
});
server.listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT}, ${TICK} tick, ${PER_TEAM} a side`));
let next = performance.now();
// a room nobody is in waits (no tick) until someone joins
(function loop() { const now = performance.now(); let n = 0; while (now >= next && n < 8) { for (const r of rooms.values()) if (r.info().humans) r.step(); next += 1000 / TICK; n++; } if (now - next > 1000) next = now; setTimeout(loop, Math.max(0, next - performance.now())); })();

process.on("uncaughtException", err => log("uncaught:", err && err.stack || err));   // one bad message must not take every room down
