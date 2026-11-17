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
import { World, TICK, DT, C, DMG, DEG, clamp, newPlayer, move, weapon, eye, eyePos, height, hitBox, standinParts, gltfGeometries, MAG, RESERVE, WEAPONS, WIDS, equip, damageFor, penetrate, armour, held, draw, NADES, NADE, throwFrom, nadeStep, viewDir, U } from "../sim.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = +(process.env.PORT || 8945), MAP_ID = (process.env.MAP || "standin").replace(/[^a-z0-9_-]/gi, "");
const PER_TEAM = +(process.env.PER_TEAM || 3), MAX_PLAYERS = 12, REWIND_MAX = .4, RESPAWN = 3, PROTECT = 2;
const FAKE_LAG = +(process.env.FAKE_LAG_MS || 0) / 2;   // test only: half the delay each way, to try the netcode at internet ping
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ── the maps: every map a room can use, loaded once and shared by the rooms on it ─────────────────────────── */
let diagN = 0; setInterval(() => { diagN = 0; }, 3600e3);   // /diag lines per hour
/* the daily rotation lives in maps/rotation.json (tools/add-map.sh appends to it); the stand-in courtyard always loads.
   ROTATION=standin (test only) pins the public room to it, as nettest's duel needs */
const ROTATION = process.env.ROTATION ? process.env.ROTATION.split(",").filter(x => /^[a-z0-9-]+$/.test(x)) : (() => { try { const r = JSON.parse(fs.readFileSync(new URL("../maps/rotation.json", import.meta.url))).rotation; if (Array.isArray(r) && r.length) return r.filter(x => /^[a-z0-9-]+$/.test(x)); } catch (e) {} return ["market", "yard"]; })();
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

const nextDaily = () => { const now = Date.now() / 1000, i = (Math.floor(now / DAILY_PERIOD) + 1 + dailySkip) % DAILY_LIST.length; return { map: MAPS[DAILY_LIST[i]].name, in: Math.round(DAILY_PERIOD - now % DAILY_PERIOD) }; };
/* ── a room: its own players, bots, pickups and clock; every room shares the one map and its routes ─────────── */
/* game modes: deathmatch (a fixed time, respawning, team kills decide) and rounds (CS competitive: a fixed round time,
   no respawn inside a round, eliminate or run the clock; first to 8 rounds, at most 15) - both restart when over */
const ENV = k => process.env[k] ? +process.env[k] : null;   // test only: shorter times
const MODES = { dm: { name: "Deathmatch", time: ENV("DM_TIME") ?? 600 }, rounds: { name: "Rounds", roundTime: ENV("ROUND_TIME") ?? 115, freeze: 3, toWin: ENV("TO_WIN") ?? 8, maxRounds: 15 },
  /* CS's competitive short match (2026-11-14): first to 9 of 16, sides swap after 8, 1:55 rounds, the bomb; freeze time 5 s
   (CS has 15, which felt long here, 2026-11-17), and the room's creator can set it (FREEZES) */
  comp: { name: "Competitive", roundTime: ENV("ROUND_TIME") ?? 115, freeze: ENV("FREEZE") ?? 5, toWin: ENV("TO_WIN") ?? 9, maxRounds: 16, half: ENV("HALF") ?? 8, endTime: 5,
          bombTime: ENV("BOMB_TIME") ?? 40, buyTime: 20, plant: 3.2, defuse: 10, kitDefuse: 5, startMoney: ENV("START_MONEY") ?? 800, maxMoney: 16000 },
  /* Gun Game, as CS's Arms Race (2026-11-17): a kill hands you the next gun of LADDER, a knife kill also takes a level
     off the victim, and the first knife kill on the last level wins; deathmatch respawns, no pickups, no grenades */
  gg: { name: "Gun Game", time: ENV("GG_TIME") ?? 900 } };
/* Wingman, as CS's (2026-11-17): Competitive's rules two a side on one bomb site, 1:30 rounds */
MODES.wing = { ...MODES.comp, name: "Wingman", roundTime: ENV("ROUND_TIME") ?? 90, perTeam: 2 };
/* the daily challenge (2026-11-17): alone against four hard bots that keep coming back, on the day's challenge map;
   eight kills as fast as you can, each death 10 s on the clock. The first finished run of a name each UTC day counts */
MODES.dc = { name: "Daily challenge", time: 600, kills: ENV("DC_KILLS") ?? 8, penalty: 10 };
const DC_EPOCH = Date.UTC(2026, 10, 16), dcDay = () => Math.floor((Date.now() - DC_EPOCH) / 86400000) + 1;
const LADDER = ["ak", "m4", "aug", "famas", "p90", "mp7", "mac10", "xm1014", "awp", "ssg08", "deagle", "p250", "glock", "knife"];
/* bot difficulty (2026-11-14), as CS offers it: how fast a bot reacts, how far its aim strays (x), how often it goes for the
   head, how wide it notices things (degrees either side), how readily it uses grenades (x) */
const FINISHES = ["factory", "desert", "arctic", "night", "forest", "crimson", "gold"];   // weapon finishes, as models.js (cosmetic)
const DIFF = { easy: { react: [.75, .45], err: 2.8, head: .05, fov: 60, nade: .35 }, normal: { react: [.35, .3], err: 1, head: .2, fov: 80, nade: 1 },
               hard: { react: [.22, .15], err: .62, head: .33, fov: 90, nade: 1.3 }, expert: { react: [.14, .08], err: .4, head: .48, fov: 100, nade: 1.6 } };
const FREEZES = [0, 3, 5, 8, 10, 15];   // the freeze times a room's creator can pick, seconds
function createRoom(code, title, mode = "dm", botCfg = null, FF = false, mapId = "standin", diff = "normal", freeze = null) {   // FF: friendly fire
  const BD = DIFF[diff] || DIFF.normal;
  const MAP_ID = WORLDS[mapId] ? mapId : "standin", W = WORLDS[MAP_ID], SLOT = code === "DAILY" ? slotNow() : null;   // SLOT: this turn of the rotation, for the board   // botCfg: [CT, T] fixed counts, or null to fill empty slots to PER_TEAM
  const MODE = MODES[mode] ? mode : "dm", G = { ph: "live", until: 0, round: 0, sc: [0, 0], msg: "", winner: -1, tSite: 0, buyUntil: 0, rk: [], clutch: [null, null], hl: null }, DC = MODE === "dc", DMLIKE = MODE === "dm" || MODE === "gg" || DC, ROUNDS = !DMLIKE, COMP = MODE === "comp" || MODE === "wing", WING = MODE === "wing", GG = MODE === "gg", CM = COMP ? MODES[MODE] : MODES.comp;
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
  if (!B) { log(`DUEL: no clear 12-18 m lane on ${MAP_ID}; run the test server with ROTATION=standin`); process.exit(1); }   // 2026-11-16: it used to put both on one spot and every number it gave was wrong
  DUEL = [A, B]; log("duel spawns", A.p.toArray().map(x => x.toFixed(1)).join(","), "/", B.p.toArray().map(x => x.toFixed(1)).join(","), "distance", B.p.distanceTo(A.p).toFixed(1));
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
const seenTill = new Map(), V0 = new THREE.Vector3(), V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();
const NG = [], SMOKES = [], FIRES = [], DECOYS = []; let ngId = 1;   // grenades in flight or at rest, smoke clouds, fires (2026-11-14)
/* the radar (2026-11-14): the map's walkable points once, to every player as they join (decimetres), and which enemies
   each team can see right now - CS's radar shows an enemy any living teammate has in sight */
const RADAR = W.radar || (W.radar = { cell: clamp(Math.min(W.bounds.max.x - W.bounds.min.x, W.bounds.max.z - W.bounds.min.z) / 70, .6, 1.2),
  pts: W.nodes.map(n => [Math.round(n.p.x * 10), Math.round(n.p.z * 10)]) });
let SPOT = [[], []];
function spotted() {
  SPOT = [0, 1].map(t => { const out = [];
    for (const v of ents.values()) { if (v.team === t || !v.s.alive) continue;
      for (const m of ents.values()) if (m.team === t && m.s.alive && !(m.blindUntil > time) && sightTo(m, v)) { out.push(v); break; } }
    return out; });
}
/* smoke (2026-11-14): a segment that passes through a live smoke cloud is not a line of sight */
function smoked(a, b) {
  for (const c of SMOKES) { const ab = V2.subVectors(b, a), L2 = ab.lengthSq(); const u = L2 ? clamp(V3.subVectors(c.p, a).dot(ab) / L2, 0, 1) : 0;
    if (V3.copy(a).addScaledVector(ab, u).distanceTo(c.p) < NADE.smokeR * .9) return true; }
  return false;
}
function sightTo(viewer, e) {
  const eye = eyePos(viewer.s), side = new THREE.Vector3(-(e.s.pos.z - viewer.s.pos.z), 0, e.s.pos.x - viewer.s.pos.x).normalize().multiplyScalar(.5);
  for (const off of [0, 1, -1]) { V0.copy(eye).addScaledVector(side, off);
    for (const h of [1.6 - e.s.duck * .45, 1.1, .3]) { V1.set(e.s.pos.x, e.s.pos.y + h, e.s.pos.z); if (W.clear(V0, V1) && !smoked(V0, V1)) return true; } }
  return false;
}
function sendable(viewer, e) {
  if (e.team === viewer.team || !e.s.alive || !viewer.s.alive) return 1;
  const d = viewer.s.pos.distanceTo(e.s.pos), key = viewer.id * 100000 + e.id;
  if (d < 4 || sightTo(viewer, e)) { seenTill.set(key, time + .5); return 1; }
  if ((seenTill.get(key) || 0) > time) return 1;
  return d < 25 && Math.hypot(e.s.vel.x, e.s.vel.z) > 3.5 ? 2 : 0;
}
/* Gun Game: a player's kit is the gun of its level (reserve without end), and the knife */
function ggKit(e) {
  const s = e.s; s.prim = null; s.sec = null; s.pa = [0, 0]; s.sa = [0, 0]; for (const n of NADES) s.nades[n] = 0; s.zeus = false; s.c4 = false;
  const w = LADDER[Math.min(e.gl || 0, LADDER.length - 1)];
  if (w === "knife") { s.w = "knife"; s.mag = 0; s.res = 0; s.reloadAt = 0; s.zoom = 0; } else { equip(s, w, undefined, 999); s.last = "knife"; }
  s.deployUntil = (e.bot ? time : e.clock || time) + ((WEAPONS[w] || {}).deploy || .5);
}
function ggLevel(by, v, wid) {
  if (wid === "knife" && (v.gl || 0) > 0) { v.gl--; events.push({ k: "level", id: v.id, l: v.gl, down: 1 }); }
  by.gl = (by.gl || 0) + (wid === LADDER[Math.min(by.gl || 0, LADDER.length - 1)] || wid === "knife" ? 1 : 0);
  if (by.gl >= LADDER.length) { G.winner = by.team; G.ph = "over"; G.until = time + 12; G.msg = by.name + " wins Gun Game"; events.push({ k: "match", w: by.team, sc: G.sc.slice(), by: by.id }); roster(); return; }
  if (by.s.alive) ggKit(by); events.push({ k: "level", id: by.id, l: by.gl }); roster();
}
function spawnAt(e) {
  const n = pickSpawn(e);
  const s = e.s; s.pos.copy(n.p); s.vel.set(0, 0, 0); s.hp = 100; s.alive = true; s.duck = 0; s.punchX = s.punchY = 0; s.deployUntil = 0;
  s.armor = 0; s.helmet = false; s.cock = 0; s.trig = false;
  equip(s, e.team ? "glock" : "usp"); equip(s, e.team ? "ak" : "m4"); s.last = s.sec;   // CS's spawn: team pistol and rifle, Q swaps them
  for (const n of NADES) s.nades[n] = n === "decoy" ? 0 : 1; s.zeus = false;                // and a full set of grenades (no decoy)
  s.yaw = spawnYaw(s.pos, W.nodes[W.spawn[1 - e.team][0] ?? 0].p); s.pitch = 0;
  e.respawnAt = 0; e.spawned = time; e.protect = time + PROTECT; e.dmgBy = new Map(); e.blindUntil = 0; e.spawnP = s.pos.clone(); e.spawnN = (e.spawnN || 0) + 1;   // the client turns to the spawn facing once per new spawnN
  if (e.bot) { e.mode = null; e.coverCd = 0; e.moving = false; e.phaseEnd = 0; e.burst = 0; e.nextShot = 0; e.lastKnown = null; e.path = W.astar(n.i, W.spawn[1 - e.team][(Math.random() * W.spawn[1 - e.team].length) | 0] ?? n.i); e.pi = 0; e.seen = 0; e.target = null; }
  if (GG) ggKit(e);
  events.push({ k: "spawn", id: e.id });
}
function addEntity(name, team, bot, ws) {
  const e = { id: nextId++, name, team, bot, ws, s: newPlayer(), q: [], ack: 0, clock: 0, kills: 0, deaths: 0, assists: 0, dealt: 0, dmgBy: new Map(), money: MODES.comp.startMoney, kit: false, ping: 0, think: 0, burst: 0, nextShot: 0, reactAt: 0 };
  ents.set(e.id, e); spawnAt(e); if (COMP) compKit(e, null);
  if (ROUNDS && G.round > 0 && G.ph !== "freeze") { e.s.alive = false; e.respawnAt = 0; }   // waits for the next round
  return e;
}
function balanceBots() {
  for (const team of [0, 1]) {
    const humans = [...ents.values()].filter(e => !e.bot && e.team === team).length, bots = [...ents.values()].filter(e => e.bot && e.team === team);
    const want = botCfg ? botCfg[team] : Math.max(0, (WING ? 2 : PER_TEAM) - humans);
    bots.sort((a, b) => (a.s.alive ? 1 : 0) - (b.s.alive ? 1 : 0));   // dead ones first
    while (bots.length > want) { if (ROUNDS && G.ph === "live" && bots[0].s.alive) break; const b = bots.shift(); ents.delete(b.id); events.push({ k: "leave", id: b.id }); }
    for (let k = bots.length; k < want; k++) { const used = new Set([...ents.values()].map(e => e.name)); const nm = BOTNAMES.find(n => !used.has(n)) || "Bot" + nextId; addEntity(nm, team, true, null); }
  }
}

/* ── shooting, decided here ──────────────────────────────────────────────────── */
const NO_REWIND = process.env.NO_REWIND === "1";   // test only: decide hits on where everyone is now, to measure what rewinding is worth
function stateAt(id, t) {
  if (NO_REWIND) { const v = ents.get(id); return v ? { x: v.s.pos.x, y: v.s.pos.y, z: v.s.pos.z, duck: v.s.duck, alive: v.s.alive, yaw: v.s.yaw } : null; }
  // the newest recorded tick at or before t (the shooter's view time), never more than REWIND_MAX back
  const tt = clamp(t, time - REWIND_MAX, time); let best = null;
  for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].time <= tt + 1e-6) { best = hist[i]; break; } }
  const h = best && best.states.get(id); return h || null;
}
function resolveShot(e, dir, viewTime, melee = false, fl = {}, wid = null) {
  e.shots = (e.shots || 0) + 1;   // for the killcam's record
  if (!e.bot && !melee) { statOf(e.name).sh++; statsDirty = true; }
  const Wp = WEAPONS[wid || e.s.w] || WEAPONS.ak, far = melee ? Wp.range : Wp.reach || 300;
  const o = eyePos(e.s), wh = W.first(o, dir, far), wd = wh ? wh.distance : far;
  // a wallbang (2026-11-14): a wall no thicker than the gun's pen lets the bullet through, weaker. Its exit is found
  // by casting back from pen past the entry; one wall at most, and the next surface beyond it stops the bullet
  const pn = !melee && wh ? penetrate(W, o, dir, wd, Wp.pen, far) : null, lo = pn ? pn.lo : 0, hiD = pn ? pn.hi : wd, pm = pn ? pn.pm : 1;
  let best = null;
  for (const v of ents.values()) {
    if (v === e || (v.team === e.team && !FF)) continue;
    const st = e.bot ? { x: v.s.pos.x, y: v.s.pos.y, z: v.s.pos.z, duck: v.s.duck, alive: v.s.alive, yaw: v.s.yaw } : stateAt(v.id, viewTime);
    if (process.env.DEBUG_SHOTS && !e.bot && st) { const c = new THREE.Vector3(st.x, st.y + 1.2, st.z), along = c.clone().sub(o).dot(dir), miss = o.clone().addScaledVector(dir, along).distanceTo(c);
      log(`shot by ${e.id}: rewind ${((time - viewTime) * 1000).toFixed(0)} ms, target moved ${Math.hypot(st.x - v.s.pos.x, st.z - v.s.pos.z).toFixed(2)} m, ray passes ${(miss * 100).toFixed(0)} cm from the rewound chest, world hit at ${wd.toFixed(1)} m, target at ${along.toFixed(1)} m`); }
    if (!st || !st.alive) continue;
    const h = hitBox(new THREE.Vector3(st.x, st.y, st.z), st.duck, o, dir, st.yaw);
    if (h && (h.t < wd || (lo && h.t > lo && h.t < hiD)) && (!best || h.t < best.t)) best = { ...h, v, pen: h.t > wd };
  }
  const end = o.clone().addScaledVector(dir, best ? best.t : wd);
  events.push({ k: melee ? "melee" : "shot", id: e.id, g: WIDS.indexOf(e.s.w), f: [+o.x.toFixed(2), +o.y.toFixed(2), +o.z.toFixed(2)], t: [+end.x.toFixed(2), +end.y.toFixed(2), +end.z.toFixed(2)], w: wh && !best ? 1 : 0, pn: best && best.pen ? 1 : 0 });
  if (best && best.v.s.alive) damage(best.v, e, damageFor(Wp, best.part, best.t) * (best.pen ? pm : 1), best.part === "head", best.pen, best.part, Wp, wid, { ...fl, sm: !melee && smoked(o, end) });
}
/* a hit: raw damage before armour; part + Wp apply CS's armour (none for fire or a self-kill). wid names what did it */
function damage(v, by, dmg, head, pen, part, Wp, wid, fl = {}) {
  if (v.protect > time || G.ph === "over") return;
  if (part && Wp) dmg = armour(v.s, Wp, part, dmg); else dmg = Math.floor(dmg);
  if (dmg <= 0) return;
  // tagging (2026-11-14): the one hit slows down at once and recovers in sim.move; a self-kill (unstuck) does not tag
  // the weapon that hit decides (not what the attacker holds now); fire and the bomb do not tag
  if (by !== v && dmg < 1000 && Wp && Wp.tag) { const tg = Wp.tag; v.s.tag = Math.max(v.s.tag || 0, tg); v.s.vel.x *= 1 - tg; v.s.vel.z *= 1 - tg; }
  if (process.env.NO_DEATH === "1") { events.push({ k: "hit", id: v.id, by: by.id, d: dmg, h: head ? 1 : 0, pn: pen ? 1 : 0 }); return; }   // test only: hits count, nobody dies
  const real = Math.min(dmg, v.s.hp);   // the health this hit really took (CS's damage report never counts past zero)
  if (by !== v && !by.bot && by.team !== v.team) { const st = statOf(by.name); st.dmg += real; st.hi++; statsDirty = true; }
  if (by !== v) { v.dmgBy.set(by.id, (v.dmgBy.get(by.id) || 0) + real); if (by.team !== v.team) by.dealt += real; }   // what this life took, from whom (assists, damage)
  v.s.hp = Math.max(0, v.s.hp - dmg); events.push({ k: "hit", id: v.id, by: by.id, d: real, h: head ? 1 : 0, pn: pen ? 1 : 0 });
  if (v.bot && !v.seen) { v.seen = time; v.reactAt = time + BD.react[0] * .85 + Math.random() * BD.react[1]; v.target = by; }
  if (v.s.hp <= 0 && v.s.alive) { if (GG) {} else if (v.s.prim) dropWeapon(v.s.prim, v.s.pos, ...held(v.s, v.s.prim)); else if (COMP && v.s.sec) { dropWeapon(v.s.sec, v.s.pos, ...held(v.s, v.s.sec)); v.s.sec = null; }   // CS: the primary, or the pistol if none
     v.s.prim = null; v.s.cock = 0; v.s.alive = false; v.deaths++; if (by !== v) by.kills += by.team === v.team ? -1 : 1;   // a team kill costs a kill
     v.respawnAt = DMLIKE ? time + RESPAWN : 0; if (DMLIKE && by.team !== v.team) G.sc[by.team]++; if (SLOT != null) { if (!by.bot && by.team !== v.team) boardHit(SLOT, MAP_ID, by.name, 1, 0); if (!v.bot) boardHit(SLOT, MAP_ID, v.name, 0, 1); }
     // an assist, as CS counts it: another enemy of the victim who did 41 or more this life, or whose flash has it blind
     let as = null, fa = 0;
     for (const [aid, d] of v.dmgBy) { const a = ents.get(aid); if (aid !== by.id && a && a.team !== v.team && d >= 41 && (!as || d > v.dmgBy.get(as.id))) as = a; }
     if (!as && v.blindUntil > time && v.blindBy && v.blindBy !== by.id) { const a = ents.get(v.blindBy); if (a && a.team !== v.team) { as = a; fa = 1; } }
     if (as) as.assists++;
     if (COMP && by !== v) pay(by, by.team === v.team ? -300 : REWARD[wid || by.s.w] ?? 300);   // CS's kill reward; a team kill costs 300
     events.push({ k: "kill", id: v.id, by: by.id, h: head ? 1 : 0, g: WIDS.indexOf(wid || by.s.w), a: as ? as.id : 0, fa, pn: pen ? 1 : 0, sm: fl.sm ? 1 : 0, bl: by.blindUntil > time ? 1 : 0, ns: fl.ns ? 1 : 0, kh: Math.max(0, by.s.hp | 0), kd: Math.round(by.s.pos.distanceTo(v.s.pos)) }); sendKillcam(v, by); if (ROUNDS) noteKill(v, by, head); if (GG && by !== v && by.team !== v.team) ggLevel(by, v, wid || by.s.w); statKill(v, by, as, head, wid || by.s.w, MAP_ID); if (DC && !by.bot && by !== v && G.ph === "live") { if (head) by.dcHs = (by.dcHs || 0) + 1; if (by.kills >= MODES.dc.kills) dcFinish(true); } }   // kh/kd: the killer's health left and the distance, for the victim's card
}

/* ── bots: walk the routes, take the nearest enemy they can see, shoot in bursts ─ */
function canSee(b, v) {
  if (!v.s.alive || b.blindUntil > time) return false;
  const e = eyePos(b.s), head = eyePos(v.s), chest = v.s.pos.clone(); chest.y += height(v.s) * .6;
  if (e.distanceTo(head) > 80) return false;
  const fwd = new THREE.Vector3(-Math.sin(b.s.yaw), 0, -Math.cos(b.s.yaw)), hd = head.clone().sub(e).setY(0).normalize();
  if (!(b.alert > time) && fwd.dot(hd) < Math.cos(BD.fov * DEG)) return false;
  return (W.clear(e, head) && !smoked(e, head)) || (W.clear(e, chest) && !smoked(e, chest));
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
/* Competitive's objectives for a bot (2026-11-14): Ts go together to this round's site and plant there (or fetch a
   dropped bomb, or guard a planted one); CTs hold a site each and go to the bomb once it is down */
function compGoal(b) {
  if (!COMP || !SITES.length || G.ph !== "live" || !G.round) return null;
  const near = p => { const ns = W.nodes.filter(n => n.p.distanceTo(p) < 5); return ns.length ? ns[(Math.random() * ns.length) | 0].i : W.nearest(p); };
  if (BOMB.planted) return b.team === 0 ? W.nearest(BOMB.planted.p) : near(BOMB.planted.p);
  if (b.team === 1) { if (BOMB.drop) { const ts = [...ents.values()].filter(e => e.team === 1 && e.s.alive && e.bot); const me = ts.reduce((m, e) => e.s.pos.distanceTo(BOMB.drop) < m.s.pos.distanceTo(BOMB.drop) ? e : m, ts[0]); if (me === b) return W.nearest(BOMB.drop); }
    return b === BOMB.by ? W.nearest(SITES[G.tSite].p) : near(SITES[G.tSite].p); }
  return near(SITES[(b.id + G.round) % SITES.length].p);
}
function roamTarget(b) {
  const s = b.s; { const g = compGoal(b); if (g != null) return g; }
  if (s.hp < 70) { let best = null, bd = 40; for (const x of PK) if ((x.kind === 3 && s.hp < 100 || x.kind === 2 && s.armor < 50) && !x.at) { const d = x.p.distanceTo(s.pos); if (d < bd) { bd = d; best = x; } } if (best) { BOTSTAT.heal++; return W.nearest(best.p); } }
  if (MIDDLE.length && Math.random() < .6) { BOTSTAT.middle++; return MIDDLE[(Math.random() * MIDDLE.length) | 0]; } BOTSTAT.roam++; return (Math.random() * W.nodes.length) | 0;
}
/* a bot's burst, once it has reacted and faces its target; errMul scales the spread and the gap between shots (a moving
   bot shoots slower and much less accurately, as anyone running and gunning does) */
function botFire(b, s, dy, errMul) {
    if (time < s.deployUntil || s.reloadAt || (b.busyUntil || 0) > time || WEAPONS[s.w].nade) return;
    if (WEAPONS[s.w].melee) { if (b.target && b.target.s.pos.distanceTo(s.pos) > 2.5) botDraw(b, s.prim && held(s, s.prim)[0] > 0 ? s.prim : s.sec); return; }
    if (s.mag <= 0) {   // empty: in a close fight the pistol comes out (as CS players do), otherwise a reload
      const close = b.target && b.target.s.pos.distanceTo(s.pos) < 12;
      if (close && s.w !== s.sec && s.sec && held(s, s.sec)[0] > 0) botDraw(b, s.sec);
      else if (s.res > 0) { s.reloadAt = time + (WEAPONS[s.w].reload || 2); events.push({ k: "reload", id: b.id, w: WIDS.indexOf(s.w) }); } else if (s.w !== s.sec && s.sec) botDraw(b, s.sec);
      return;
    }
    if (time > b.reactAt && Math.abs(dy) < 6 * DEG && time > b.nextShot) {
    if (b.burst <= 0) b.burst = 3 + (Math.random() * 4 | 0);
    const v = b.target, aimHead = Math.random() < BD.head, tgt = aimHead ? eyePos(v.s) : v.s.pos.clone().setY(v.s.pos.y + height(v.s) * .6);
    const o = eyePos(s), dist = o.distanceTo(tgt), err = BD.err * errMul * (Math.max(1.8, 5 - (time - b.seen) * 1.4) + Math.hypot(v.s.vel.x, v.s.vel.z) * .35 + dist * .015) * DEG;
    const d = tgt.sub(o).normalize(), ax = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize(), ay = new THREE.Vector3().crossVectors(ax, d);
    const r = Math.sqrt(Math.random()) * err, th = Math.random() * Math.PI * 2; d.addScaledVector(ax, Math.tan(r) * Math.cos(th)).addScaledVector(ay, Math.tan(r) * Math.sin(th)).normalize();
    b.protect = 0; s.mag--; resolveShot(b, d, time); b.burst--; b.nextShot = time + (b.burst > 0 ? (WEAPONS[s.w] || WEAPONS.ak).rate * errMul : .28 + Math.random() * .27);
  }
}
/* ── bots and their kit (2026-11-14): a real magazine, the pistol when the rifle runs dry up close, the knife out
   while running with nobody around, and grenades used the way players use them ─────────────────────────────── */
function botDraw(b, id) { if (!id || id === b.s.w) return; draw(b.s, id, time); b.burst = 0; }
function spawnNade(e, kind, str) {
  const t0 = throwFrom(W, e.s, str);
  NG.push({ id: ngId++, kind, by: e, p: t0.p, v: t0.v, t0: time, rest: false });
  events.push({ k: "throw", id: e.id, n: NADES.indexOf(kind) });
}
/* where a bot must aim to land a grenade near T: tries throw strengths and pitches, flies each with the real physics,
   keeps the closest. The point that counts: where an HE or flash goes off, where a smoke settles, where a molotov
   first touches a floor. Returns { yaw, pitch, str, err, at } or null */
function botAim(b, kind, T) {
  const s = b.s, y0 = s.yaw, p0 = s.pitch, e = eyePos(s), yaw = Math.atan2(-(T.x - e.x), -(T.z - e.z)); let best = null;
  s.yaw = yaw;
  for (const str of [1, .5, 0]) for (let pt = -.35; pt <= 1.1; pt += .12) {
    s.pitch = pt; const g = { ...throwFrom(W, s, str), rest: false }; let at = null;
    for (let k = 0; k < 64 * 6; k++) { const h = nadeStep(W, g), age = k * DT;
      if (kind === "molotov" && h && h.normal.y > .7) { at = h.point; break; }
      if ((kind === "he" || kind === "flash") && age >= NADE.fuse[kind]) { at = g.p.clone(); break; }
      if (kind === "smoke" && g.rest) { at = g.p.clone(); break; }
      if (g.p.y < W.bounds.min.y - 4) break; }
    if (!at) continue; const err = at.distanceTo(T);
    if (!best || err < best.err) best = { yaw, pitch: pt, str, err, at };
  }
  s.yaw = y0; s.pitch = p0; return best;
}
/* grenade lineups (2026-11-17): for each bomb site, up to two smokes that land on it, thrown standing still from the
   attackers' way in (11 to 26 m out), found with the real grenade physics; once per map, shared by its rooms, sent in
   the welcome to Competitive and Wingman. str: 1 = left click, 0 = right click (a lob), .5 = both */
function lineups() {
  if (W.lineups) return W.lineups; const out = [], t0 = Date.now(), fake = { s: newPlayer() };
  for (const st of ALLSITES) {
    const path = W.astar(W.spawn[1][0] ?? 0, W.nearest(st.p)); let got = 0;
    for (const n of path.map(i => W.nodes[i]).filter(n => { const d = n.p.distanceTo(st.p); return d > 11 && d < 26; }).reverse()) {
      if (got >= 2 || Date.now() - t0 > 4000) break;
      if (out.some(l => Math.hypot(l.p[0] - n.p.x, l.p[2] - n.p.z) < 5)) continue;
      const f = fake.s; f.pos.copy(n.p); f.vel.set(0, 0, 0); f.duck = 0; f.alive = true; f.w = "smoke";
      const a = botAim(fake, "smoke", st.p);
      if (a && a.err < 1.6) { out.push({ site: st.name, kind: "smoke", p: P3(n.p), yaw: +a.yaw.toFixed(3), pitch: +a.pitch.toFixed(3), str: a.str, land: P3(a.at) }); got++; }
    }
  }
  log(`lineups for ${MAP_ID}: ${out.length} found in ${Date.now() - t0} ms`); return (W.lineups = out);
}
function botThrow(b, kind, T, maxErr, why) {
  const s = b.s; if (!(s.nades[kind] > 0) || time < (b.nadeCd || 0) || Math.random() > BD.nade) return false;
  const a = botAim(b, kind, T); b.nadeCd = time + 2;                         // a failed aim waits a little before trying again
  if (!a || a.err > maxErr) return false;
  s.yaw = a.yaw; s.pitch = a.pitch; s.nades[kind]--; spawnNade(b, kind, a.str);
  b.nadeCd = time + 7 + Math.random() * 6; b.busyUntil = time + .6; BOTSTAT[why] = (BOTSTAT[why] || 0) + 1;
  if (kind === "flash") { b.lookAway = time + 1.9; b.flashAt = a.at.clone(); }   // turn from its own flash, as players do
  return true;
}
const inFire = p => FIRES.find(f => Math.hypot(p.x - f.p.x, p.z - f.p.z) < NADE.fireR + .4 && Math.abs(p.y - f.p.y) < 1.6);

function botTick(b) {
  const s = b.s; if (!s.alive) return;
  if (s.reloadAt && time >= s.reloadAt) { const W0 = WEAPONS[s.w], n = Math.min(W0.mag - s.mag, s.res); s.mag += n; s.res -= n; s.reloadAt = 0; }
  if (s.tag > 0) s.tag = Math.max(0, s.tag - .6 * DT);                        // tagging wears off for bots too
  if (COMP && G.ph === "live") {
    b.wantPlant = b === BOMB.by && siteAt(s.pos) >= 0 && !b.seen;
    b.wantDefuse = b.team === 0 && !!BOMB.planted && !b.seen && Math.hypot(s.pos.x - BOMB.planted.p.x, s.pos.z - BOMB.planted.p.z) < 1.3;
    if (b.wantPlant || b.wantDefuse) { s.vel.set(0, 0, 0); return; }   // still, head down, hands busy
    const objective = BOMB.planted ? "planted" : BOMB.drop ? "drop" : "site";
    if (b.objective !== objective) { b.objective = objective; b.path = []; }   // the objective changed: a new route
  }
  if (b.lookAway > time && b.flashAt) { const to = b.flashAt.clone().sub(s.pos); s.yaw = Math.atan2(to.x, to.z); s.vel.set(0, 0, 0); return; }   // back to its own flash
  { const f = inFire(s.pos); if (f && !(b.fleeUntil > time)) { const away = s.pos.clone().sub(f.p).setY(0).normalize().multiplyScalar(NADE.fireR + 2.5).add(f.p); b.fleeUntil = time + 1.5; pathTo(b, W.nearest(away)); } }
  if (time > b.think) {
    b.think = time + .1;
    let best = null, bd = Infinity;
    for (const v of ents.values()) if (v.team !== b.team && v.s.alive && !(v.protect > time)) { const d = v.s.pos.distanceTo(s.pos); if (d < bd && canSee(b, v)) { bd = d; best = v; } }
    if (b.mode === "cover") { if (best && bd < 7) { b.mode = null; BOTSTAT.backToFight++; } else best = null; }   // in cover: only someone close pulls it back into the fight
    if (best && s.hp < 45 && time > (b.coverCd || 0)) { const c = coverFrom(b, best); if (c >= 0) { BOTSTAT.cover++;
      { const d = best.s.pos.distanceTo(s.pos); if (d > 8 && d < 30) botThrow(b, "smoke", s.pos.clone().lerp(best.s.pos, .45), 4, "smoke"); }   /* smoke the lane while falling back */ b.mode = "cover"; b.coverCd = time + 10; b.coverUntil = 0; b.lastKnown = best.s.pos.clone(); b.seen = 0; b.target = null; pathTo(b, c); best = null; } }
    if (b.mode === "cover" && (!b.path || !b.path.length)) { if (!b.coverUntil) b.coverUntil = time + 2 + Math.random(); else if (time > b.coverUntil) { b.mode = null; if (b.lastKnown) pathTo(b, flankNode(b, b.lastKnown)); } }
    if (best) { if (!b.seen || b.target !== best) { b.seen = time; b.reactAt = time + BD.react[0] + Math.random() * BD.react[1]; } b.target = best; b.lastKnown = best.s.pos.clone(); b.lostAt = 0;
      if (WEAPONS[s.w].melee && s.prim) botDraw(b, held(s, s.prim)[0] > 0 || held(s, s.prim)[1] > 0 ? s.prim : s.sec); }   // knife away when an enemy shows
    else if (b.seen) { b.seen = 0; b.target = null; b.lostAt = time;
      if (b.lastKnown) { const d = b.lastKnown.distanceTo(s.pos);   // it ducked out of sight: an HE where it was, or a flash before going after it
        if (d > 6 && d < 24) { const r = Math.random(); if (r < .35) botThrow(b, "he", b.lastKnown, 3, "he"); else if (r < .6) botThrow(b, "flash", b.lastKnown.clone().setY(b.lastKnown.y + 1.5), 4, "flash"); } }
      const objective = COMP && (b.team === 1 || BOMB.planted || Math.random() < .5) ? compGoal(b) : null;   // Competitive: Ts go back to the bomb's route, half the CTs back to their site
      if (objective != null) pathTo(b, objective);
      else if (b.lastKnown) { const f = Math.random() < .5; BOTSTAT[f ? "flank" : "chase"]++; pathTo(b, f ? flankNode(b, b.lastKnown) : W.nearest(b.lastKnown)); } }
    else if (b.lostAt && time - b.lostAt > 2.5 && b.lastKnown && b.lastKnown.distanceTo(s.pos) > 5 && b.lastKnown.distanceTo(s.pos) < 18) { botThrow(b, "molotov", b.lastKnown, 2.5, "molotov"); b.lostAt = 0; }   // it is still holding that spot: burn it out
    if (!GG && !best && !b.target && !b.seen && WEAPONS[s.w].melee === undefined && time - (b.spawned || 0) > 3 && time - (b.lostAt || b.spawned || 0) > 5 && b.path && b.path.length - b.pi > 12 && Math.random() < .02) botDraw(b, "knife");   // a long run with nobody around: knife out, a little faster
  }
  const pushOn = COMP && b === BOMB.by && !BOMB.planted && G.ph === "live" && time - b.seen > 1.2;   // the carrier does not stay in a duel: it takes the bomb on to the site
  if (b.mode !== "cover" && b.seen && b.target && b.target.s.alive && !(b.fleeUntil > time) && !pushOn) {   // standing in fire: get out first, fight after
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
  const sp = (WEAPONS[s.w].speed || 215) * U * (1 - (s.tag || 0)), k = Math.min(1, sp * DT / L), px = s.pos.x, pz = s.pos.z;
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
  const kinds = ["awp", "aug", "sg553", "ak", "m4", "m4a1s", "deagle", "mp9", "mac10", "nova", "p90", "ssg08", "negev", "xm1014", "famas", "galil"];
  spread(mid.length ? mid : n.map(x => x.i), kinds.length).forEach((i, j) => PK.push({ id: pkId++, kind: 0, w: kinds[j], p: n[i].p.clone(), home: true, respawn: kinds[j] === "awp" ? 40 : 25, at: 0 }));
  const away = n.map(x => x.i).filter(i => dA[i] > 5 && dB[i] > 5);
  spread(away, 6, PK.map(x => x.p)).forEach(i => PK.push({ id: pkId++, kind: 1, p: n[i].p.clone(), home: true, respawn: 10, at: 0 }));
  spread(away, 3, PK.map(x => x.p)).forEach(i => PK.push({ id: pkId++, kind: 2, p: n[i].p.clone(), home: true, respawn: 25, at: 0 }));   // kevlar + helmet: CS armour, 100
  spread(away, 4, PK.map(x => x.p)).forEach(i => PK.push({ id: pkId++, kind: 3, p: n[i].p.clone(), home: true, respawn: 15, at: 0 }));   // bandage: +40 health, to 100
  log("pickups:", PK.map(x => ["", "ammo", "kevlar", "bandage"][x.kind] || x.w).join(", "));
  W.layout = PK;
}
for (const x of W.layout) PK.push({ ...x, id: pkId++, p: x.p.clone(), at: 0 });
/* a new round or match starts with every pickup back and nothing dropped lying around */
function resetPickups() { for (let i = PK.length - 1; i >= 0; i--) { if (!PK[i].home) PK.splice(i, 1); else PK[i].at = 0; } NG.length = SMOKES.length = FIRES.length = DECOYS.length = 0; }
function dropWeapon(w, pos, mag, res) {
  PK.push({ id: pkId++, kind: 0, w, p: pos.clone(), home: false, mag, res, until: time + 30, at: 0 });
  const dropped = PK.filter(x => !x.home); if (dropped.length > 24) PK.splice(PK.indexOf(dropped[0]), 1);
}
const near = (s, p, r) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < r && Math.abs(s.pos.y - p.y) < 1.3;
function usePickups(e, cmd) {
  const s = e.s, press = !!cmd.use && !e.useHeld; e.useHeld = !!cmd.use; if (!s.alive) return;
  // ammo: walk over a box to fill the reserve of both guns, in hand or holstered
  const low = id => id && held(s, id)[1] < WEAPONS[id].res, fill = id => { if (!id) return; if (id === s.w) s.res = WEAPONS[id].res; else if (id === s.prim) s.pa[1] = WEAPONS[id].res; else if (id === s.sec) s.sa[1] = WEAPONS[id].res; };
  for (const x of PK) if (x.kind === 1 && !x.at && (low(s.prim) || low(s.sec)) && near(s, x.p, 1.2)) { fill(s.prim); fill(s.sec); x.at = time + x.respawn; events.push({ k: "ammo", id: e.id }); }
  // kevlar + helmet: CS armour, 100 points (2026-11-14; was +50 health); a bandage brings health back up (to 100)
  for (const x of PK) if (x.kind === 2 && !x.at && (s.armor < 100 || !s.helmet) && near(s, x.p, 1.2)) { s.armor = 100; s.helmet = true; x.at = time + x.respawn; events.push({ k: "kevlar", id: e.id }); }
  for (const x of PK) if (x.kind === 3 && !x.at && s.hp < 100 && near(s, x.p, 1.2)) { s.hp = Math.min(100, s.hp + 40); x.at = time + x.respawn; events.push({ k: "bandage", id: e.id }); }
  if (!press || GG) return;
  // E: take the nearest weapon in reach, leaving yours in its place
  let best = null, bd = 1.6; for (const x of PK) if (x.kind === 0 && !x.at) { const d = Math.hypot(s.pos.x - x.p.x, s.pos.z - x.p.z); if (d < bd && Math.abs(s.pos.y - x.p.y) < 1.3) { bd = d; best = x; } }
  if (!best) return;
  const mine = WEAPONS[best.w].slot === "s" ? s.sec : s.prim;
  if (mine) dropWeapon(mine, s.pos, ...held(s, mine));
  equip(s, best.w, best.mag, best.res); s.deployUntil = e.clock + WEAPONS[best.w].deploy;
  if (best.home) best.at = time + best.respawn; else PK.splice(PK.indexOf(best), 1);
  events.push({ k: "pick", id: e.id, g: WIDS.indexOf(best.w) });
}
function tickPickups() {
  for (let i = PK.length - 1; i >= 0; i--) { const x = PK[i]; if (x.home && x.at && time >= x.at) x.at = 0; if (!x.home && time > x.until) PK.splice(i, 1); }
  for (const e of ents.values()) if (e.bot && e.s.alive) usePickups(e, {});   // bots walk over ammo, kevlar and bandages like anyone
}

/* ── grenades (2026-11-14), CS's: an HE blows at 1.5 s, a flash blinds whoever has it in sight at 1.5 s, a smoke pops
   once it has stopped and blocks sight for 18 s, a molotov catches fire where it first hits the floor (or after 2 s
   over the floor below) and burns for 7 s. Smoke puts fire out, and a molotov thrown into smoke goes out ─────────── */
const P3 = v => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)], hurts = (by, v) => v === by || FF || v.team !== by.team;
const inSmoke = p => SMOKES.some(c => c.p.distanceTo(p) < NADE.smokeR);
function ignite(g, p) {
  if (inSmoke(p)) { events.push({ k: "fizzle", p: P3(p) }); return; }
  FIRES.push({ id: ngId++, p: p.clone(), until: time + NADE.fireTime, by: g.by, next: time });
  events.push({ k: "fire", p: P3(p) });
}
function detonate(g) {
  const W0 = WEAPONS[g.kind], up = g.p.clone(); up.y += .1;
  if (g.kind === "he") {
    for (const v of ents.values()) { if (!v.s.alive || !hurts(g.by, v)) continue;
      const c = v.s.pos.clone(); c.y += 1; const dist = c.distanceTo(g.p);
      if (dist < W0.radius && W.clear(up, c)) damage(v, g.by, W0.dmg * (1 - dist / W0.radius), false, false, "body", W0, "he"); }
    events.push({ k: "boom", n: 0, p: P3(g.p) });
  } else if (g.kind === "flash") {
    for (const v of ents.values()) { if (!v.s.alive) continue;
      const e = eyePos(v.s), dist = e.distanceTo(g.p); if (dist > 30 || !W.clear(up, e) || smoked(up, e)) continue;
      const dot = viewDir(v.s.yaw, v.s.pitch).dot(g.p.clone().sub(e).normalize()), facing = dot >= .5 ? 1 : dot >= -.2 ? .55 : .2;
      const dur = 4.9 * facing * (.35 + .65 * clamp(1 - dist / 30, 0, 1));
      if (dur > .25) { v.blindUntil = time + dur; v.blindBy = g.by.id; events.push({ k: "flashed", id: v.id, by: g.by.id, d: +dur.toFixed(2) }); } }
    events.push({ k: "boom", n: 1, p: P3(g.p) });
  } else if (g.kind === "smoke") {
    const c = { id: ngId++, p: g.p.clone(), until: time + NADE.smokeTime }; c.p.y += 1.2; SMOKES.push(c);
    for (let i = FIRES.length - 1; i >= 0; i--) if (FIRES[i].p.distanceTo(c.p) < NADE.smokeR + NADE.fireR) { events.push({ k: "fizzle", p: P3(FIRES[i].p) }); FIRES.splice(i, 1); }
    events.push({ k: "smoke", p: P3(c.p) });
  } else if (g.kind === "decoy") {   // CS's decoy: fakes its thrower's gun for 15 s, and shows on the enemy's radar as a player
    DECOYS.push({ id: ngId++, p: g.p.clone(), until: time + NADE.decoyTime, next: time + .4, by: g.by, w: g.by.s.prim || g.by.s.sec || "glock" });
  } else if (g.kind === "molotov") {
    const h = W.first(g.p, new THREE.Vector3(0, -1, 0), 3);
    if (h) ignite(g, h.point); else events.push({ k: "fizzle", p: P3(g.p) });
  }
}
function tickNades() {
  for (let i = NG.length - 1; i >= 0; i--) {
    const g = NG[i], hit = nadeStep(W, g), age = time - g.t0;
    if (hit) events.push({ k: "bounce", n: NADES.indexOf(g.kind), p: P3(hit.point) });
    let gone = false;
    if (g.kind === "molotov" && hit && hit.normal.y > .7) { ignite(g, hit.point); gone = true; }
    else if (g.kind === "smoke" || g.kind === "decoy" ? (g.rest && age >= 1) || age > 6 : age >= NADE.fuse[g.kind]) { detonate(g); gone = true; }
    else if (g.p.y < W.bounds.min.y - 4) { gone = true; log(`[${code}] a ${g.kind} left the map`); }   // thrown over an edge
    if (gone) NG.splice(i, 1);
  }
  for (let i = SMOKES.length - 1; i >= 0; i--) if (time >= SMOKES[i].until) SMOKES.splice(i, 1);
  for (let i = DECOYS.length - 1; i >= 0; i--) { const d = DECOYS[i];
    if (time >= d.until) { events.push({ k: "boom", n: 3, p: P3(d.p) }); DECOYS.splice(i, 1); continue; }
    if (time >= d.next) { events.push({ k: "decoy", p: P3(d.p), g: WIDS.indexOf(d.w) }); d.next = time + (Math.random() < .7 ? WEAPONS[d.w].rate || .12 : .5 + Math.random() * 1.2); } }
  for (let i = FIRES.length - 1; i >= 0; i--) {
    const f = FIRES[i]; if (time >= f.until) { FIRES.splice(i, 1); continue; }
    if (time < f.next) continue; f.next = time + .25;                         // CS's fire hurts in steps: 40 a second
    for (const v of ents.values()) if (v.s.alive && hurts(f.by, v) && Math.hypot(v.s.pos.x - f.p.x, v.s.pos.z - f.p.z) < NADE.fireR && Math.abs(v.s.pos.y - f.p.y) < 1.6)
      damage(v, f.by, NADE.fireDps * .25, false, false, null, null, "molotov");
  }
}

/* ── Competitive (2026-11-14), CS's rules and numbers: money, the buy menu, two bomb sites, the C4, round pay ────────
   Team 0 (Atlas) always plays CT, team 1 (Ember) T: at halftime the players change teams, the score goes with them. */
/* the two sites, once per map: on the defenders' half (nearer the CT spawn than the T spawn), as far apart as the half
   allows, each with open ground around it */
const ALLSITES = W.sites || (W.sites = (() => {
  const n = W.nodes; if (!n.length) return [];
  const dC = W.dijkstra(W.spawn[0][0] ?? 0), dT = W.dijkstra(W.spawn[1][0] ?? 0), span = W.span || 1;
  const open = x => n.filter(y => y.p.distanceTo(x.p) < 3).length >= 12;
  let cand = n.filter(x => isFinite(dC[x.i]) && isFinite(dT[x.i]) && dC[x.i] > span * .12 && dC[x.i] < dT[x.i] * .85 && open(x));
  if (cand.length < 2) cand = n.filter(x => isFinite(dC[x.i]) && dC[x.i] < dT[x.i]);
  if (cand.length < 2) cand = n;
  let a = cand[0], b = cand[0];
  for (let k = 0; k < 2; k++) { b = cand.reduce((m, x) => x.p.distanceTo(a.p) > m.p.distanceTo(a.p) ? x : m, cand[0]); a = cand.reduce((m, x) => x.p.distanceTo(b.p) > m.p.distanceTo(b.p) ? x : m, cand[0]); }
  return [{ name: "A", p: a.p.clone(), r: 3.5 }, { name: "B", p: b.p.clone(), r: 3.5 }];
})());
const SITES = WING ? [ALLSITES[1] || ALLSITES[0]] : ALLSITES;   // Wingman plays one site (CS uses B)
const siteAt = p => SITES.findIndex(x => Math.hypot(p.x - x.p.x, p.z - x.p.z) < x.r && Math.abs(p.y - x.p.y) < 2);
const inBuy = e => !!e.spawnP && e.spawnP.distanceTo(e.s.pos) < 12;   // the buy zone: around where you spawned this round (spawns spread over your side)
const canBuy = e => COMP && e.s.alive && (G.ph === "freeze" || (G.ph === "live" && time < G.buyUntil)) && inBuy(e);
const BOMB = { by: null, drop: null, planted: null, plant: null, defuse: null, boomed: false, defused: false };
const lossStreak = [0, 0];
/* CS's prices, [price, team] (team: 0 CT only, 1 T only, absent both) and its kill rewards */
const PRICE = { glock: [200, 1], usp: [200, 0], p250: [300], fiveseven: [500, 0], tec9: [500, 1], cz75: [500], deagle: [700],
                mp9: [1250, 0], mac10: [1050, 1], mp7: [1500], ump: [1200], p90: [2350], nova: [1050], xm1014: [2000], negev: [1700],
                galil: [1800, 1], famas: [2050, 0], ak: [2700, 1], m4: [3100, 0], m4a1s: [2900, 0], sg553: [3000, 1], aug: [3300, 0], ssg08: [1700], awp: [4750],
                vest: [650], vesthelm: [1000], he: [300], flash: [200], smoke: [300], molotov: [400, 1], incendiary: [600, 0], decoy: [50], kit: [400, 0], zeus: [200] };
const REWARD = { knife: 1500, mp9: 600, mac10: 600, mp7: 600, ump: 600, nova: 900, xm1014: 900, awp: 100, zeus: 0 };   // everything else 300 (rifles, pistols, grenades)
const pay = (e, x) => { e.money = clamp((e.money || 0) + x, 0, CM.maxMoney); };
/* a player's kit at a round's start: the team pistol and knife; a survivor keeps what it had (CS) */
function kitOf(e) { const s = e.s; return { zeus: s.zeus, prim: s.prim, pa: s.prim ? held(s, s.prim) : null, sec: s.sec, sa: s.sec ? held(s, s.sec) : null, nades: { ...s.nades }, armor: s.armor, helmet: s.helmet, kit: e.kit }; }
function compKit(e, keep) {
  const s = e.s; s.prim = null; s.pa = [0, 0]; s.c4 = false; s.zeus = false; s.burstOn = false; for (const n of NADES) s.nades[n] = 0; s.armor = 0; s.helmet = false; e.kit = false;
  equip(s, e.team ? "glock" : "usp"); s.last = "knife";
  if (keep) { if (keep.sec) equip(s, keep.sec, ...keep.sa); if (keep.prim) equip(s, keep.prim, ...keep.pa); Object.assign(s.nades, keep.nades); s.armor = keep.armor; s.helmet = keep.helmet; e.kit = keep.kit; s.zeus = keep.zeus; }
  s.last = s.prim ? s.sec : "knife";
}
/* buying: CS's rules - in the buy zone, in freeze time or the first 20 s, with the money; a gun replaces (drops) the one in
   its slot; armour 650, armour + helmet 1000 (the helmet alone 350 on full armour); four grenades at most, two flashes */
function buy(e, item) {
  const s = e.s, P = PRICE[item === "molotov" && e.team === 0 ? "incendiary" : item]; if (!P || !canBuy(e)) return false;
  let price = P[0]; if (P[1] != null && P[1] !== e.team) return false;
  const nadeCount = NADES.reduce((t, n) => t + s.nades[n], 0);
  if (item === "vest") { if (s.armor >= 100) return false; }
  else if (item === "vesthelm") { if (s.armor >= 100 && s.helmet) return false; if (s.armor >= 100) price = 350; }
  else if (item === "kit") { if (e.kit) return false; }
  else if (item === "zeus") { if (s.zeus) return false; }
  else if (NADES.includes(item)) { if (nadeCount >= 4 || s.nades[item] >= (item === "flash" ? 2 : 1)) return false; }
  else if (!WEAPONS[item] || held(s, item)[0] + held(s, item)[1] > 0 && (item === s.prim || item === s.sec)) return false;
  if ((e.money || 0) < price) return false;
  pay(e, -price);
  if (item === "vest") s.armor = 100; else if (item === "vesthelm") { s.armor = 100; s.helmet = true; } else if (item === "kit") e.kit = true; else if (item === "zeus") s.zeus = true;
  else if (NADES.includes(item)) s.nades[item]++;
  else { const mine = WEAPONS[item].slot === "s" ? s.sec : s.prim; if (mine) dropWeapon(mine, s.pos, ...held(s, mine)); equip(s, item); s.deployUntil = (e.bot ? time : e.clock) + WEAPONS[item].deploy; }
  events.push({ k: "buy", id: e.id, i: item, m: e.money });
  return true;
}
/* bots buy by their money, as CS bots do: a full buy (rifle, armour + helmet, grenades), a force buy, or an eco */
function botBuy(b) {
  const s = b.s, rifle = b.team ? "ak" : "m4", m = () => b.money || 0;
  const ctRifle = Math.random() < .5 ? "m4a1s" : "m4";
  if (m() >= PRICE[b.team ? "ak" : ctRifle][0] + 1000) { if (!s.prim || !["ak", "m4", "m4a1s", "awp", "aug", "sg553"].includes(s.prim)) buy(b, Math.random() < .12 && m() >= 4750 + 1000 ? "awp" : b.team ? "ak" : ctRifle); buy(b, "vesthelm"); if (!b.team) buy(b, "kit"); for (const n of ["smoke", "flash", "he", "molotov"]) if (m() > 500) buy(b, n); }
  else if (m() >= 2700 && !s.prim) { buy(b, b.team ? "galil" : "famas"); buy(b, "vest"); }
  else if (m() >= 1700 && !s.prim) { buy(b, ["ump", "mp7", b.team ? "mac10" : "mp9"][(Math.random() * 3) | 0]); buy(b, "vest"); }
  else if (m() >= 1200 && G.round > 1) { buy(b, b.team ? "tec9" : "fiveseven"); }
  else if (m() >= 650 && !s.armor && G.round > 1) buy(b, "vest");
}
/* the bomb, each tick of a live round: the carrier drops it on death, a T walks over it to take it, holding fire with
   it out (or a bot standing still) on a site plants it in 3.2 s, a CT holding E at it defuses in 10 s (5 with a kit),
   40 s after the plant it explodes */
function bombTick() {
  if (process.env.DEBUG_COMP && BOMB.by && tick % 128 === 0) { const c = BOMB.by, st = SITES[G.tSite]; log(`[${code}] carrier ${c.name} bot=${!!c.bot} at ${P3(c.s.pos)} -> site ${st.name} ${c.s.pos.distanceTo(st.p).toFixed(1)} m, path ${c.path ? c.path.length - (c.pi || 0) : "-"}, mode ${c.mode}, seen ${!!c.seen}, objective ${c.objective}, wantPlant ${!!c.wantPlant}`); }   // test only
  if (BOMB.by && (!BOMB.by.s.alive || !ents.has(BOMB.by.id))) { const c = BOMB.by; BOMB.drop = c.s.pos.clone(); c.s.c4 = false; BOMB.by = null; BOMB.plant = null; events.push({ k: "bombDrop", p: P3(BOMB.drop) }); }
  if (BOMB.drop && !BOMB.planted) for (const e of ents.values()) if (e.team === 1 && e.s.alive && Math.hypot(e.s.pos.x - BOMB.drop.x, e.s.pos.z - BOMB.drop.z) < 1.1 && Math.abs(e.s.pos.y - BOMB.drop.y) < 1.5) { BOMB.by = e; e.s.c4 = true; BOMB.drop = null; events.push({ k: "bombPick", id: e.id }); break; }
  const c = BOMB.by;
  if (c && !BOMB.planted) {
    const site = siteAt(c.s.pos), still = Math.hypot(c.s.vel.x, c.s.vel.z) < .6 && (c.bot || c.s.onGround);
    if (c.wantPlant && site >= 0 && still) {
      if (!BOMB.plant) { BOMB.plant = { by: c, t0: time }; events.push({ k: "plantStart", id: c.id }); }
      else if (time - BOMB.plant.t0 >= CM.plant) {
        BOMB.planted = { p: c.s.pos.clone(), site, at: time, boom: time + CM.bombTime }; BOMB.plant = null; BOMB.by = null; c.s.c4 = false; pay(c, 300);
        if (c.s.w === "c4") draw(c.s, c.s.prim || c.s.sec || "knife", c.bot ? time : c.clock);
        events.push({ k: "planted", id: c.id, site, p: P3(BOMB.planted.p) });
      }
    } else BOMB.plant = null;
  }
  const B = BOMB.planted;
  if (B && !BOMB.defused && !BOMB.boomed) {
    const near = e => e.team === 0 && e.s.alive && Math.hypot(e.s.pos.x - B.p.x, e.s.pos.z - B.p.z) < 1.4 && Math.abs(e.s.pos.y - B.p.y) < 1.6;
    if (BOMB.defuse && !(near(BOMB.defuse.by) && BOMB.defuse.by.wantDefuse)) BOMB.defuse = null;
    if (!BOMB.defuse) for (const e of ents.values()) if (near(e) && e.wantDefuse) { BOMB.defuse = { by: e, t0: time, need: e.kit ? CM.kitDefuse : CM.defuse }; events.push({ k: "defuseStart", id: e.id, kit: e.kit ? 1 : 0 }); break; }
    if (BOMB.defuse && time - BOMB.defuse.t0 >= BOMB.defuse.need) { BOMB.defused = true; pay(BOMB.defuse.by, 300); events.push({ k: "defused", id: BOMB.defuse.by.id }); }
    else if (time >= B.boom) {
      BOMB.boomed = true; events.push({ k: "boom", n: 2, p: P3(B.p) });
      const sigma = 1750 * U / 3, C4W = { name: "C4", ap: 1 };   // CS's bomb: 500 damage, falling off as a bell curve over 1750 units
      for (const v of ents.values()) if (v.s.alive) { const d = v.s.pos.distanceTo(B.p); damage(v, v, 500 * Math.exp(-(d * d) / (2 * sigma * sigma)), false, false, "body", C4W, "c4"); }
    }
  }
}
/* the round's pay, CS's: a win 3250 (3500 for an exploded or defused bomb); a loss 1400, rising 500 a round lost in a row
   to 3400 (a win brings the loser streak down one); Ts who lose with the bomb planted get 800 more; Ts alive when time
   runs out without a plant get nothing */
function payRound(w, why) {
  if (w < 0) return;
  lossStreak[1 - w]++; lossStreak[w] = Math.max(0, lossStreak[w] - 1);
  const bonus = Math.min(3400, 1400 + 500 * (lossStreak[1 - w] - 1)), winPay = why === "bomb" || why === "defuse" ? 3500 : 3250;
  for (const e of ents.values()) {
    if (e.team === w) { pay(e, winPay); continue; }
    if (why === "time" && e.team === 1 && e.s.alive) continue;
    pay(e, bonus + (e.team === 1 && BOMB.planted ? 800 : 0));
  }
}

/* ── talking (2026-11-14), as CS: chat to everyone (Y) or the team (U), the radio's stock calls (Z), a ping on a spot
   (middle click). Team messages reach only the team; in a round mode the dead talk only to the dead. Each player is
   held to a message every 0.7 s and eight in ten seconds ───────────────────────────────────────────────────────── */
const RADIO = ["Enemy spotted", "Need backup", "Cover me", "Go, go, go", "Fall back", "Hold this position", "Affirmative", "Negative", "Sector clear", "I'm in position"];
function talk(e, m) {
  if (e.bot) return;
  const now = time; e.talk = (e.talk || []).filter(t => now - t < 10);
  if (e.talk.length >= 8 || now - (e.talk[e.talk.length - 1] ?? -9) < .7) return;
  let ev = null, team = true;
  if (m.t === "say" && /^\/(surrender|kick)\b/i.test(String(m.m || "").trim())) { callVote(e, String(m.m).trim()); e.talk.push(now); return; }
  if (m.t === "say") { const text = String(m.m || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 120); if (!text) return; team = !!m.team; ev = { k: "say", id: e.id, m: text, tm: team ? 1 : 0, dead: e.s.alive ? 0 : 1 }; }
  else if (m.t === "radio") { const n = m.n | 0; if (n < 0 || n >= RADIO.length) return; ev = { k: "radio", id: e.id, n }; }
  else if (m.t === "ping") { if (!Array.isArray(m.p) || m.p.length !== 3 || !m.p.every(Number.isFinite)) return; const b = W.bounds;
    const p = [clamp(m.p[0], b.min.x - 2, b.max.x + 2), clamp(m.p[1], b.min.y - 2, b.max.y + 4), clamp(m.p[2], b.min.z - 2, b.max.z + 2)].map(x => +x.toFixed(2)); ev = { k: "ping", id: e.id, p }; }
  if (!ev) return; e.talk.push(now);
  for (const r of ents.values()) {
    if (r.bot) continue;
    if (team && r.team !== e.team) continue;
    if (ROUNDS && !e.s.alive && r.s.alive && G.ph === "live") continue;   // the dead are heard only by the dead
    (r.pv = r.pv || []).push(ev);
  }
}

/* ── votes (2026-11-14), as CS: "/surrender" (Competitive; every human on the team must agree, the other side takes the
   match) and "/kick NAME" (a majority of the other humans; the name is kept out of this room for 30 minutes). F1 yes,
   F2 no, 20 seconds. One vote at a time ─────────────────────────────────────────────────────────────────────────── */
let VOTE = null; const BANS = new Map();
function voters(v) { return [...ents.values()].filter(x => !x.bot && (v.kind === "kick" ? x !== v.target : x.team === v.team)); }
function callVote(e, cmd) {
  if (VOTE) return; const [c, ...rest] = cmd.slice(1).split(/\s+/), name = rest.join(" ").toLowerCase();
  if (c.toLowerCase() === "surrender") { if (!COMP || G.ph === "over") return; VOTE = { kind: "surrender", by: e, team: e.team, yes: new Set([e.id]), no: new Set(), until: time + 20 }; }
  else { const t = [...ents.values()].find(x => !x.bot && x !== e && x.name.toLowerCase() === name); if (!t) return;
    if ([...ents.values()].filter(x => !x.bot).length < 3) return;   // a kick needs at least three humans in the room: never one voice alone
    VOTE = { kind: "kick", by: e, target: t, yes: new Set([e.id]), no: new Set(), until: time + 20 }; }
  events.push({ k: "voteStart", kind: VOTE.kind, by: e.id, t: VOTE.target ? VOTE.target.id : 0, team: VOTE.kind === "surrender" ? VOTE.team : -1 }); voteTick();
}
function castVote(e, yes) { if (!VOTE || !voters(VOTE).includes(e)) return; (yes ? VOTE.yes : VOTE.no).add(e.id); (yes ? VOTE.no : VOTE.yes).delete(e.id); voteTick(); }
function voteTick() {
  if (!VOTE) return; const v = VOTE, all = voters(v).map(x => x.id), yes = all.filter(id => v.yes.has(id)).length, no = all.filter(id => v.no.has(id)).length;
  const need = v.kind === "surrender" ? all.length : Math.floor(all.length / 2) + 1;
  const pass = all.length > 0 && yes >= need, fail = time >= v.until || all.length - no < need || (v.kind === "kick" && !ents.has(v.target.id));
  if (!pass && !fail) return;
  VOTE = null; events.push({ k: "voteEnd", kind: v.kind, pass: pass ? 1 : 0, t: v.target ? v.target.id : 0 });
  if (!pass) return;
  if (v.kind === "kick") { BANS.set(v.target.name.toLowerCase(), time + 1800); const ws = v.target.ws; if (ws) { try { ws.send(JSON.stringify({ t: "x", why: "You were voted out of this room" })); ws.close(4003, "voted out"); } catch (x) {} } }
  else { G.sc[1 - v.team] = Math.max(G.sc[1 - v.team], CM.toWin); endMatch(); G.msg = TEAMNAME[1 - v.team] + " win: " + TEAMNAME[v.team] + " surrendered"; }
}

/* ── the match: clock, round ends, results, restart ──────────────────────────── */
const TEAMNAME = ["Atlas", "Ember"];   // our own two sides
function resetMatch() { G.sc = [0, 0]; G.round = 0; for (const e of ents.values()) { e.kills = 0; e.deaths = 0; e.assists = 0; e.dealt = 0; } }
function respawnAll() { for (const e of ents.values()) spawnAt(e); }
function endMatch() {
  const w = G.sc[0] === G.sc[1] ? -1 : G.sc[0] > G.sc[1] ? 0 : 1; G.winner = w; G.ph = "over"; G.until = time + 12;
  G.msg = w < 0 ? "Draw" : TEAMNAME[w] + " wins"; events.push({ k: "match", w, sc: G.sc.slice() }); roster();
}
function startRound() {
  G.round++; G.rk = []; G.clutch = [null, null]; G.hl = null; G.ph = "freeze"; G.until = time + (freeze ?? MODES[MODE].freeze); G.msg = "";
  const half = COMP && G.round === CM.half + 1;
  if (COMP && (G.round === 1 || half)) { for (const e of ents.values()) { e.money = CM.startMoney; e.kit = false; } lossStreak[0] = lossStreak[1] = 0; }
  if (half) { for (const e of ents.values()) e.team = 1 - e.team; G.sc = [G.sc[1], G.sc[0]]; events.push({ k: "half" }); }   // sides swap, the score goes with the players
  { const hs = [0, 1].map(t => [...ents.values()].filter(e => !e.bot && e.team === t));
    if (Math.abs(hs[0].length - hs[1].length) >= 2) { const big = hs[0].length > hs[1].length ? 0 : 1, mv = hs[big].sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0))[0]; mv.team = 1 - big; mv.movedRound = G.round; events.push({ k: "moved", id: mv.id, team: mv.team }); } }
  resetPickups(); balanceBots();
  if (COMP) {
    Object.assign(BOMB, { by: null, drop: null, planted: null, plant: null, defuse: null, boomed: false, defused: false }); G.tSite = SITES.length > 1 && Math.random() < .5 ? 1 : 0;
    for (const e of ents.values()) { const keep = e.s.alive && G.round > 1 && !half && e.movedRound !== G.round ? kitOf(e) : null;   /* a player moved to the other side starts fresh */ spawnAt(e); compKit(e, keep); e.protect = 0; e.wantPlant = e.wantDefuse = false; }
    const ts = [...ents.values()].filter(e => e.team === 1 && e.s.alive);
    if (ts.length) { BOMB.by = ts.find(e => process.env.BOMB_TO && e.name === process.env.BOMB_TO) || ts[(Math.random() * ts.length) | 0]; BOMB.by.s.c4 = true; }   // BOMB_TO: test only
    G.buyUntil = G.until + CM.buyTime;
    for (const b of ents.values()) if (b.bot) botBuy(b);
    roster();
  } else for (const e of ents.values()) { const keep = e.s.alive && e.s.prim ? [e.s.prim, ...held(e.s, e.s.prim)] : null; spawnAt(e); if (keep) { equip(e.s, ...keep); e.s.last = e.s.sec; } e.protect = 0; }
  events.push({ k: "round", n: G.round });
}
function match() {
  if (DC) {
    if (G.ph === "freeze" && time >= G.until) { G.ph = "live"; G.dcStart = time; G.until = time + MODES.dc.time; G.msg = ""; }
    else if (G.ph === "live" && G.dcStart && time >= G.until) dcFinish(false);
    return;
  }
  if (DMLIKE) {
    if (G.ph === "live" && !G.until) G.until = time + MODES[MODE].time;
    if (G.ph === "live" && time >= G.until) endMatch();
    else if (G.ph === "over" && time >= G.until) { resetMatch(); for (const e of ents.values()) e.gl = 0; resetPickups(); respawnAll(); G.ph = "live"; G.until = time + MODES[MODE].time; G.msg = ""; events.push({ k: "restart" }); }
    return;
  }
  const R = MODES[MODE];
  if (G.hl && !G.hl.sent && time >= G.hl.at) { G.hl.sent = true; sendHighlight(G.hl); }
  if (!G.round) { startRound(); return; }
  if (G.ph === "freeze" && time >= G.until) { G.ph = "live"; G.until = time + R.roundTime; }
  else if (G.ph === "live" && COMP) {
    if (process.env.TEST_PLANT && !BOMB.planted && SITES.length) BOMB.planted = { p: SITES[0].p.clone(), site: 0, at: time, boom: time + CM.bombTime };   // test only: a bomb already on A
    bombTick();
    const alive = [0, 1].map(t => [...ents.values()].filter(e => e.team === t && e.s.alive).length), present = [0, 1].map(t => [...ents.values()].some(e => e.team === t));
    let w = -1, why = "", msg = "";
    if (BOMB.boomed) { w = 1; why = "bomb"; msg = "The bomb exploded"; }
    else if (BOMB.defused) { w = 0; why = "defuse"; msg = "The bomb was defused"; }
    else if (present[0] && !alive[0] && alive[1]) { w = 1; why = "kill"; msg = "Atlas eliminated"; }
    else if (present[1] && !alive[1] && !BOMB.planted) { w = 0; why = "kill"; msg = "Ember eliminated"; }
    else if (!BOMB.planted && time >= G.until) { w = 0; why = "time"; msg = "Time ran out"; }
    if (w >= 0) { G.sc[w]++; payRound(w, why); G.ph = "end"; G.until = time + CM.endTime; G.winner = w; G.hl = pickHighlight(w); if (G.hl) { G.hl.at = time + 1; G.until = Math.max(G.until, G.hl.at + (G.hl.t1 - G.hl.t0) + 1); } G.msg = TEAMNAME[w] + " win the round: " + msg; events.push({ k: "roundEnd", w, sc: G.sc.slice(), why }); roster(); }
  }
  else if (G.ph === "live") {
    const alive = [0, 1].map(t => [...ents.values()].filter(e => e.team === t && e.s.alive).length), present = [0, 1].map(t => [...ents.values()].some(e => e.team === t));
    let w = -1, why = "";
    if (present[0] && present[1] && !alive[0] && !alive[1]) { w = 2; why = "everyone down"; }
    else if (present[1] && !alive[1] && alive[0]) { w = 0; why = "Ember eliminated"; }
    else if (present[0] && !alive[0] && alive[1]) { w = 1; why = "Atlas eliminated"; }
    else if (time >= G.until) { w = present[0] ? 0 : present[1] ? 1 : 2; why = "time ran out"; }   // CT hold on time, if there are any
    if (w === 2) { G.ph = "end"; G.until = time + 4; G.winner = -1; G.msg = "Round drawn (" + why + ")"; events.push({ k: "roundEnd", w: -1, sc: G.sc.slice() }); }
    else if (w >= 0) { G.sc[w]++; G.ph = "end"; G.until = time + 4; G.winner = w; G.hl = pickHighlight(w); if (G.hl) { G.hl.at = time + 1; G.until = Math.max(G.until, G.hl.at + (G.hl.t1 - G.hl.t0) + 1); } G.msg = TEAMNAME[w] + " win the round (" + why + ")"; events.push({ k: "roundEnd", w, sc: G.sc.slice() }); }
  } else if (G.ph === "end" && time >= G.until) {
    if (G.sc[0] >= R.toWin || G.sc[1] >= R.toWin || G.round >= R.maxRounds) endMatch(); else startRound();
  } else if (G.ph === "over" && time >= G.until) { resetMatch(); startRound(); events.push({ k: "restart" }); }
}
const frozen = () => ((ROUNDS || DC) && G.ph === "freeze") || G.ph === "over";   // the results screen holds everyone still

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
      const ra0 = e.s.reloadAt, co0 = e.s.cock;
      const shot = weapon(e.s, cmd, e.clock, (e.id * 100003 + cmd.seq) >>> 0);
      if (!ra0 && e.s.reloadAt) events.push({ k: "reload", id: e.id, w: WIDS.indexOf(e.s.w) });   // heard by those near (2026-11-14)
      if (!co0 && e.s.cock) events.push({ k: "pin", id: e.id });
      if (COMP) { e.wantPlant = e.s.w === "c4" && !!cmd.fire; e.wantDefuse = !!cmd.use; }
      if (shot && shot.nade) { e.protect = 0; spawnNade(e, shot.nade, shot.str); }
      else if (shot) { e.protect = 0; const vt = typeof cmd.vt === "number" ? cmd.vt : time, ns = !!(WEAPONS[shot.w || e.s.w] || {}).scoped && !shot.z; for (const d of shot.dirs || [shot.dir]) resolveShot(e, d, vt, !!shot.melee, { ns }, shot.w); }
      usePickups(e, cmd);
    }
    if (e.q.length > 64) e.q.splice(0, e.q.length - 64);
  }
  for (const e of ents.values()) if (!e.s.alive && e.respawnAt && time >= e.respawnAt) spawnAt(e);
  match();
  tickPickups();
  tickNades();
  const states = new Map(); for (const e of ents.values()) states.set(e.id, { x: e.s.pos.x, y: e.s.pos.y, z: e.s.pos.z, duck: e.s.duck, alive: e.s.alive, yaw: e.s.yaw });   // facing too: the arms
  hist.push({ time, states }); if (hist.length > TICK) hist.shift();
  if (tick % 4 === 0) spotted();
  if (tick % TICK === 0) voteTick();
  if (tick % 2 === 0) { snapshot(); record(); }
  if (tick % TICK === 0) roster();
  if (tick % (TICK * 30) === 0) for (const e of ents.values()) if (!e.bot) log(`[${code}] ${e.name} ping ${e.ping} ms`);   // what players actually get
}
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
/* the killcam (2026-11-17): everyone's last 3.5 s at the snapshot rate (where they stood, where they looked, what they
   held, how many shots they fired), and on a death the victim alone gets its killer's, its own and those near the killer,
   to watch it back through the killer's eyes. Only the dead see it, after the fact, so it gives nothing to the living. */
const KC_KEEP = 10;   // 3.5 s for a killcam, up to 8 s for a round's highlight
const kcRow = e => [r2(time), r2(e.s.pos.x), r2(e.s.pos.y), r2(e.s.pos.z), r3(e.s.yaw), r3(e.s.pitch), r2(e.s.duck), e.s.alive ? 1 : 0, WIDS.indexOf(e.s.w), e.shots || 0];
function record() { for (const e of ents.values()) { const h = e.hist || (e.hist = []); h.push(kcRow(e)); e.shots = 0; while (h.length && h[0][0] < time - KC_KEEP) h.shift(); } }
/* the round's highlight (2026-11-17): every kill of the round, and the moment a side was down to its last player against
   two or more; at the round's end the best of it (an ace, a won clutch, then the most kills, at least two) is sent to
   everyone as a record to watch through that player's eyes, as CS's round MVP */
function dcFinish(done) {
  const e = [...ents.values()].find(x => !x.bot); G.ph = "over"; G.until = time + 86400;
  if (!e) return; const el = time - G.dcStart, score = done ? el + e.deaths * MODES.dc.penalty : null;
  G.msg = done ? "Challenge done" : "Out of time";
  const res = done ? dcRecord(e.name, { t: +score.toFixed(1), el: +el.toFixed(1), d: e.deaths, hs: e.dcHs || 0, k: e.kills, map: MAP_ID }) : null;
  try { e.ws.send(JSON.stringify({ t: "dcres", done, day: dcDay(), map: MAPS[MAP_ID].name.replace(/, HY-World$/, ""), tt: done ? +score.toFixed(1) : null, el: +el.toFixed(1), d: e.deaths, hs: e.dcHs || 0, k: e.kills, ...(res || {}) })); } catch (err) {}
  log(`[${code}] challenge ${done ? "done" : "timed out"} by ${e.name}: ${done ? score.toFixed(1) + " s" : ""}`);
}
function noteKill(v, by, head) {
  if (G.ph !== "live") return; G.rk.push({ by: by.id, v: v.id, t: time, h: !!head, team: by.team, vt: v.team });
  const alive = [0, 1].map(t => [...ents.values()].filter(e => e.team === t && e.s.alive));
  for (const t of [0, 1]) if (alive[t].length === 1 && alive[1 - t].length >= 2 && !G.clutch[t]) G.clutch[t] = { id: alive[t][0].id, vs: alive[1 - t].length, t: time };
}
function pickHighlight(w) {
  if (w < 0 || !G.rk.length) return null;
  const enemies = [...ents.values()].filter(e => e.team !== w).length, best = { score: 0 };
  for (const id of new Set(G.rk.map(k => k.by))) {
    const ks = G.rk.filter(k => k.by === id && k.vt !== k.team), e = ents.get(id); if (!e || e.team !== w) continue;
    const cl = G.clutch[e.team] && G.clutch[e.team].id === id && e.team === w ? G.clutch[e.team] : null, ace = ks.length >= Math.max(3, enemies);
    if (ks.length < 2 && !cl) continue;
    const score = ks.length * 2 + (cl ? cl.vs * 3 : 0) + (ace ? 10 : 0);
    if (score > best.score) Object.assign(best, { score, id, ks, cl, ace });
  }
  if (!best.id) return null;
  const title = best.ace ? "Ace" : best.cl ? `1v${best.cl.vs} clutch` : `${best.ks.length} kills`;
  const t0 = Math.min(...best.ks.map(k => k.t), best.cl ? best.cl.t : Infinity) - 1.2, t1 = Math.max(...best.ks.map(k => k.t), best.cl ? best.cl.t : -Infinity) + .8;
  return { id: best.id, title, t0: Math.max(t0, t1 - 8), t1 };
}
function sendHighlight(hl) {
  const by = ents.get(hl.id); if (!by || !by.hist) return;
  const cut = (rows, half) => rows.filter((r, i) => r[0] >= hl.t0 - .1 && r[0] <= hl.t1 + .1 && (!half || i % 2 === 0));
  const h = [[by.id, by.team, cut(by.hist, false)], ...[...ents.values()].filter(e => e !== by && e.hist).map(e => [e.id, e.team, cut(e.hist, true)])].filter(x => x[2].length);
  const msg = JSON.stringify({ t: "hl", by: by.id, title: hl.title, t0: r2(hl.t0), t1: r2(hl.t1), h });
  for (const e of ents.values()) if (!e.bot && e.ws && e.ws.readyState === 1) try { e.ws.send(msg); } catch (err) {}
}
function sendKillcam(v, by) {
  if (v.bot || !v.ws || v.ws.readyState !== 1 || by === v || !by.hist || by.hist.length < 8) return;
  const kp = by.s.pos, near = [...ents.values()].filter(e => e !== by && e !== v && e.hist && e.hist.length && e.s.pos.distanceTo(kp) < 30).slice(0, 6);
  // the killer at the full rate with this moment added (the killing shot), the rest at half the rate
  const h = [[by.id, by.team, [...by.hist, kcRow(by)]], [v.id, v.team, [...(v.hist || []), kcRow(v)]], ...near.map(e => [e.id, e.team, e.hist.filter((_, i) => i % 2 === 0)])];
  try { v.ws.send(JSON.stringify({ t: "kc", by: by.id, at: r2(time), h })); } catch (err) {}
}
function snapshot() {
  const row = (e, mine, vis) => [e.id, e.team, e.bot ? 1 : 0, r2(e.s.pos.x), r2(e.s.pos.y), r2(e.s.pos.z), r3(e.s.yaw), r3(e.s.pitch), r2(e.s.duck), e.s.alive ? 1 : 0, r2(e.s.vel.x), r2(e.s.vel.z), WIDS.indexOf(e.s.w), mine ? e.s.hp : null, vis];   // an enemy's health is not sent
  if (tick % 640 === 0) for (const [k, v] of seenTill) if (v < time) seenTill.delete(k);   // forget old sightings every 10 s
  const listFor = viewer => { const out = []; for (const e of ents.values()) { if (e === viewer) continue; const v = sendable(viewer, e); if (v) out.push(row(e, e.team === viewer.team, v === 2 ? 0 : 1)); } return out; };
  // every pickup, with the seconds until a taken one comes back (0 = there now), so the page can show where it will be
  const pk = PK.filter(x => !GG || x.kind !== 0).map(x => [x.id, x.kind, x.kind ? -x.kind : WIDS.indexOf(x.w), r2(x.p.x), r2(x.p.y), r2(x.p.z), x.at ? Math.max(0, Math.ceil(x.at - time)) : 0]);
  const ev = events; events = [];
  const ng = NG.map(g => [g.id, NADES.indexOf(g.kind), r2(g.p.x), r2(g.p.y), r2(g.p.z)]), left = x => Math.max(0, r2(x.until - time));
  const sm = SMOKES.map(c => [c.id, r2(c.p.x), r2(c.p.y), r2(c.p.z), left(c)]), fi = FIRES.map(f => [f.id, r2(f.p.x), r2(f.p.y), r2(f.p.z), left(f)]);
  for (const e of ents.values()) {
    if (e.bot || !e.ws || e.ws.readyState !== 1) continue;
    const s = e.s;
    e.ws.send(JSON.stringify({ t: "s", k: tick, tm: time, a: e.ack, me: {
      p: [s.pos.x, s.pos.y, s.pos.z], v: [s.vel.x, s.vel.y, s.vel.z], d: s.duck, g: s.onGround, j: s.jumpHeld, h: s.hp, al: s.alive,
      m: s.mag, r: s.res, ra: s.reloadAt, ns: s.nextShot, sp: s.spray, ls: s.lastShot, px: s.punchX, py: s.punchY, ac: r3(s.acc || 0), tg: r3(s.tag || 0), st: r2(s.stamina || 0), ld: s.landed ? 1 : 0, ck: e.clock, ra2: e.respawnAt ? e.respawnAt - time : 0, pr: e.protect > time ? e.protect - time : 0,
      w: s.w, pm: s.prim, la: s.last, z: s.zoom, du: s.deployUntil, zh: s.zoomHeld, sc: s.sec, pa: s.pa, sa: s.sa, tr: s.trig, co: s.cock,
      nd: NADES.map(n => s.nades[n]), ar: s.armor, hm: s.helmet ? 1 : 0, te: e.team, zs: s.zeus ? 1 : 0, bo: s.burstOn ? 1 : 0, bl2: s.burstLeft,
      ...(COMP ? { mo: e.money, kit: e.kit ? 1 : 0, c4: s.c4 ? 1 : 0, ib: canBuy(e) ? 1 : 0,
        pp: BOMB.plant && BOMB.plant.by === e ? r2((time - BOMB.plant.t0) / CM.plant) : 0, dp: BOMB.defuse && BOMB.defuse.by === e ? r2((time - BOMB.defuse.t0) / BOMB.defuse.need) : 0,
        bd: e.team === 1 && BOMB.drop ? P3(BOMB.drop) : 0, tmo: [...ents.values()].filter(x => x.team === e.team).map(x => [x.id, x.money | 0]) } : {}), bl: e.blindUntil > time ? r2(e.blindUntil - time) : 0, sn: e.spawnN, syw: e.spawnN ? s.yaw : 0 },
      e: listFor(e), pk, ev, pv: e.pv && e.pv.length ? e.pv.splice(0) : undefined, ng, sm, fi, sp: SPOT[e.team].map(v => [v.id, r2(v.s.pos.x), r2(v.s.pos.z)]), dc: DECOYS.filter(d => d.by.team !== e.team).map(d => [d.id, r2(d.p.x), r2(d.p.z)]), gm: { m: MODE, ph: G.ph, tl: Math.max(0, Math.ceil(G.until - time)), rn: G.round, sc: G.sc, msg: G.msg, fz: frozen(), dc: DC ? { k: e.kills, d: e.deaths, need: MODES.dc.kills, pen: MODES.dc.penalty, el: G.dcStart && G.ph === "live" ? r2(time - G.dcStart) : 0 } : undefined,
        ...(COMP ? { bp: BOMB.planted ? [...P3(BOMB.planted.p), BOMB.planted.site] : 0, bl: BOMB.planted && !BOMB.boomed && !BOMB.defused ? r2(BOMB.planted.boom - time) : 0, bt: Math.max(0, Math.ceil(G.buyUntil - time)) } : {}) } }));
  }
}
function roster() {
  const r = [...ents.values()].map(e => [e.id, e.name, e.team, e.bot ? 1 : 0, e.kills, e.deaths, e.ping, e.assists, Math.round(e.dealt), e.fin || 0, GG ? e.gl || 0 : null]);
  for (const e of ents.values()) if (!e.bot && e.ws && e.ws.readyState === 1) e.ws.send(JSON.stringify({ t: "r", r }));
}


  /* a player joins: on the side asked for (or the emptier one), bots rebalanced around them */
  function join(ws, ws0, name, teamPref, fin) {
    if ((BANS.get(String(name).toLowerCase()) || 0) > time) { ws.send(JSON.stringify({ t: "x", why: "You were voted out of this room" })); ws.close(4003, "voted out"); return; }
    if ([...ents.values()].filter(e => !e.bot).length >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: "x", why: "That room is full" })); ws.close(1013, "full"); return; }
    const humans = [0, 1].map(t => [...ents.values()].filter(e => !e.bot && e.team === t).length);
    if (DC && humans[0] + humans[1] > 0) { ws.send(JSON.stringify({ t: "x", why: "A challenge run is for one player" })); ws.close(1013, "solo"); return; }
    const team = DC ? 0 : teamPref === "ct" ? 0 : teamPref === "t" ? 1 : humans[0] <= humans[1] ? 0 : 1;
    const e = addEntity(name, team, false, ws); e.joinedAt = time; e.fin = Math.max(0, FINISHES.indexOf(String(fin || "")));
    balanceBots(); emptySince = 0;
    if (DC) { G.ph = "freeze"; G.until = time + 3; G.dcStart = 0; e.kills = e.deaths = 0; e.dcHs = 0; e.protect = time + 4; }
    ws.send(JSON.stringify({ t: "w", id: e.id, team: e.team, map: MAP_ID, tick, tm: time, rate: TICK, room: code, title, mode: MODE, radar: RADAR, sites: COMP ? SITES.map(x => [x.name, ...P3(x.p), x.r]) : [], ladder: GG ? LADDER : undefined, lineups: COMP ? lineups().filter(l => SITES.some(x => x.name === l.site)) : undefined }));
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
                   slot: ["p", "s", "k", "g", "c", "q"].includes(c.slot) ? c.slot : null, zoom: !!c.zoom, use: !!c.use });
      } else if (m.t === "b" && typeof m.i === "string") { buy(e, m.i);
      } else if (m.t === "say" || m.t === "radio" || m.t === "ping") { talk(e, m);
      } else if (m.t === "vote") { castVote(e, !!m.y);
      } else if (m.t === "fin" && FINISHES.includes(m.f)) { e.fin = FINISHES.indexOf(m.f); roster();
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
/* lifetime stats per player name (2026-11-17), kept in $STATE_DIRECTORY/stats.json like the boards: kills and deaths
   against the other side, headshots, assists, damage, shots and hits, kills per gun and per map. Humans only; a name is
   a name (no accounts), so anyone typing it adds to it */
const STATS_FILE = path.join(path.dirname(BOARD_FILE), "stats.json");
let STATS = (() => { try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); } catch (e) { return {}; } })(), statsDirty = false;
function statOf(name) { const k = String(name).toLowerCase(); return STATS[k] || (STATS[k] = { n: name, k: 0, d: 0, hs: 0, a: 0, dmg: 0, sh: 0, hi: 0, w: {}, m: {}, since: Date.now() }); }
function statKill(v, by, as, head, wid, map) {
  if (by !== v && by.team !== v.team && !by.bot) { const st = statOf(by.name); st.k++; if (head) st.hs++; st.w[wid] = (st.w[wid] || 0) + 1; st.m[map] = (st.m[map] || 0) + 1; st.last = Date.now(); }
  if (!v.bot) { statOf(v.name).d++; statOf(v.name).last = Date.now(); }
  if (as && !as.bot) statOf(as.name).a++;
  statsDirty = true;
}
setInterval(() => { if (!statsDirty) return; statsDirty = false;
  try { fs.writeFileSync(STATS_FILE + ".tmp", JSON.stringify(STATS)); fs.renameSync(STATS_FILE + ".tmp", STATS_FILE); } catch (e) { log("stats: " + e.message); } }, 15000);
/* the daily challenge's runs, per UTC day number, the last 30 days, in $STATE_DIRECTORY/challenge.json */
const DC_FILE = path.join(path.dirname(BOARD_FILE), "challenge.json");
let DCR = (() => { try { return JSON.parse(fs.readFileSync(DC_FILE, "utf8")); } catch (e) { return {}; } })();
const dcMap = () => DAILY_LIST[(dcDay() * 7 + 3) % DAILY_LIST.length];   // the day's challenge map, its own order apart from the rotation
const dcTop = (day, n) => Object.values(DCR[day] || {}).sort((a, b) => a.t - b.t).slice(0, n);
function dcRecord(name, r) {
  const day = dcDay(), k = String(name).toLowerCase(), d = DCR[day] || (DCR[day] = {}), counted = !d[k];
  if (counted) d[k] = { name, ...r, at: Date.now() };
  for (const x of Object.keys(DCR).map(Number).sort((a, b) => b - a).slice(30)) delete DCR[x];
  try { fs.writeFileSync(DC_FILE + ".tmp", JSON.stringify(DCR)); fs.renameSync(DC_FILE + ".tmp", DC_FILE); } catch (e) { log("challenge: " + e.message); }
  const all = Object.values(d).sort((a, b) => a.t - b.t);
  return { counted, rank: 1 + all.findIndex(x => x.name.toLowerCase() === k), of: all.length, best: d[k].t };
}
const statView = st => { const top = o => Object.entries(o).sort((a, b) => b[1] - a[1])[0];
  const fw = top(st.w), fm = top(st.m);
  return { name: st.n, k: st.k, d: st.d, kd: +(st.k / Math.max(1, st.d)).toFixed(2), hs: st.k ? Math.round(100 * st.hs / st.k) : 0, a: st.a, dmg: st.dmg, acc: st.sh ? Math.round(100 * Math.min(st.hi, st.sh) / st.sh) : 0,
    gun: fw ? { name: (WEAPONS[fw[0]] || {}).name || fw[0], k: fw[1] } : null, map: fm && MAPS[fm[0]] ? { name: MAPS[fm[0]].name.replace(/, HY-World$/, ""), k: fm[1] } : null,
    since: st.since, rank: 1 + Object.values(STATS).filter(x => x.k > st.k).length, players: Object.keys(STATS).length }; };
const boardTop = (slot, n) => { const b = boards[slot]; return b ? Object.entries(b.s).sort((x, y) => y[1][0] - x[1][0] || x[1][1] - y[1][1]).slice(0, n).map(([name, [k, d]]) => ({ name, k, d })) : []; };
const boardPast = (slot, n) => Object.keys(boards).map(Number).filter(k => k < slot && boards[k].map && MAPS[boards[k].map]).sort((a, b) => b - a).slice(0, n)
  .map(k => ({ map: MAPS[boards[k].map].name.replace(/, HY-World$/, ""), preview: "maps/" + boards[k].map + "-preview.jpg", best: boardTop(k, 1).find(b => b.k > 0) || null, players: Object.keys(boards[k].s).length }));
/* TEMPORARY, for testing (2026-11-16): anyone can move the public room on to the next map from the menu (the arrow by
   "Next: ..."). It shifts the rotation by one and switches at once; one switch per 5 s for everyone. MAP_SKIP=0 turns
   it off. The board's turns still follow the clock, so a turn can hold two maps while this is on */
const MAP_SKIP = process.env.MAP_SKIP !== "0"; let dailySkip = 0, skipAt = 0;
const dailyIndex = () => (Math.floor(Date.now() / 1000 / DAILY_PERIOD) + dailySkip) % DAILY_LIST.length;
const dailyTitle = id => MAPS[id].name.replace(/, HY-World$/, "");
let dailyAt = dailyIndex();
rooms.set("DAILY", createRoom("DAILY", dailyTitle(DAILY_LIST[dailyAt]), "dm", null, false, DAILY_LIST[dailyAt]));
function switchDaily() { const i = dailyIndex(); if (i === dailyAt) return; dailyAt = i; const id = DAILY_LIST[i], old = rooms.get("DAILY");
  rooms.set("DAILY", createRoom("DAILY", dailyTitle(id), "dm", null, false, id)); if (old) old.moveAll(MAPS[id].name); log(`daily map is now ${id}`); }
setInterval(switchDaily, 5000);

/* ── files and the socket on one port ────────────────────────────────────────── */
const GZ = new Map();
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".glb": "model/gltf-binary", ".splat": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg", ".css": "text/css", ".mp3": "audio/mpeg" };
const server = http.createServer((req, res) => {
  let p; try { p = decodeURIComponent((req.url || "/").split("?")[0]); } catch { res.writeHead(400); res.end("bad request"); return; } if (p === "/") p = "/index.html";
  // what a player's page reports about itself (phones); small, logged one line each, rate-limited
  if (p === "/diag" && req.method === "POST") { let b = ""; req.on("data", d => { if (b.length < 4000) b += d; }); req.on("end", () => { if ((diagN = diagN + 1) < 600) log("diag " + b.replace(/[\r\n]/g, " ").slice(0, 1500)); res.writeHead(204); res.end(); }); return; }
  if (p === "/skipmap" && req.method === "POST") { const ok = MAP_SKIP && Date.now() - skipAt > 5000; if (ok) { skipAt = Date.now(); dailySkip++; switchDaily(); log("map skipped by a player"); }
    res.writeHead(ok ? 200 : 429, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ ok })); return; }
  if (p === "/challenge") { const nm = (new URL(req.url, "http://x").searchParams.get("name") || "").toLowerCase(), day = dcDay(), id = dcMap();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ day, id, map: MAPS[id].name.replace(/, HY-World$/, ""), preview: "maps/" + id + "-preview.jpg", kills: MODES.dc.kills, penalty: MODES.dc.penalty, top: dcTop(day, 8), me: nm && DCR[day] && DCR[day][nm] || null, players: Object.keys(DCR[day] || {}).length })); return; }
  if (p === "/stats") { const nm = new URL(req.url, "http://x").searchParams.get("name") || "", st = STATS[nm.toLowerCase()];
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ me: st ? statView(st) : null, top: Object.values(STATS).sort((a, b) => b.k - a.k).slice(0, 8).filter(x => x.k > 0).map(x => ({ name: x.n, k: x.k, kd: +(x.k / Math.max(1, x.d)).toFixed(2), hs: x.k ? Math.round(100 * x.hs / x.k) : 0 })) })); return; }
  if (p === "/rooms") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify([...rooms.values()].filter(r => r.code === "DAILY").map(r => ({ ...r.info(), skip: MAP_SKIP, preview: "maps/" + r.map + "-preview.jpg", online: [...rooms.values()].reduce((n, x) => n + x.info().humans, 0) })))); return; }
  const ok = /^\/(index\.html|preview\.html|game\.js|sim\.js|models\.js|vendor\/[\w./-]+|maps\/[\w.-]+|sounds\/[\w.-]+\.mp3|models\/[\w.-]+\.glb)$/.test(p) && !p.includes("..");
  const f = path.join(ROOT, p);
  if (!ok || !f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end("not found"); return; }
  const type = MIME[path.extname(f)] || "application/octet-stream", cache = p.startsWith("/vendor/") || p.startsWith("/maps/") || p.startsWith("/sounds/") || p.startsWith("/models/") ? "public, max-age=86400" : "no-cache";
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
    const bpt = parseInt(q.get("bpt"), 10), bots = process.env.TEST_BOTS ? process.env.TEST_BOTS.split(",").map(Number) : q.get("bots") === "0" ? [0, 0] : bpt >= 1 && bpt <= 5 ? (q.get("mode") === "wing" ? null : [bpt, bpt]) : null;   // TEST_BOTS "ct,t": test only   // a private room: today's map, no bots or 1-5 a side
    if (q.get("mode") === "dc") room = createRoom(code, "Daily challenge #" + dcDay(), "dc", [0, 4], false, dcMap(), "hard");
    else room = createRoom(code, title, ["comp", "gg", "wing"].includes(q.get("mode")) ? q.get("mode") : "dm", bots, false, DAILY_LIST[dailyAt], DIFF[q.get("diff")] ? q.get("diff") : "normal", q.get("frz") && FREEZES.includes(+q.get("frz")) ? +q.get("frz") : null); rooms.set(code, room); log(`room ${code} "${title}" created by ${name}`);   // Deathmatch, or Competitive (2026-11-14)
  } else room = rooms.get((q.get("room") || "DAILY").toUpperCase());
  if (!room) { ws0.send(JSON.stringify({ t: "x", why: "No room with that code" })); ws0.close(4004, "no such room"); return; }
  room.join(ws, ws0, name, team, q.get("fin"));
});
server.listen(PORT, "127.0.0.1", () => log(`listening on 127.0.0.1:${PORT}, ${TICK} tick, ${PER_TEAM} a side`));
let next = performance.now();
// a room nobody is in waits (no tick) until someone joins
(function loop() { const now = performance.now(); let n = 0; while (now >= next && n < 8) { for (const r of rooms.values()) if (r.info().humans) r.step(); next += 1000 / TICK; n++; } if (now - next > 1000) next = now; setTimeout(loop, Math.max(0, next - performance.now())); })();

process.on("uncaughtException", err => log("uncaught:", err && err.stack || err));   // one bad message must not take every room down
