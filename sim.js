/* The shared simulation: the same file runs on the server (authoritative) and in every browser (prediction), so a
   client predicting its own movement and shots computes exactly what the server will. Movement is Source-style,
   collision is a capsule against a BVH of the map, spread comes from a seeded generator shared by both ends. */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const U = 0.0254, DEG = Math.PI / 180;
export const TICK = 64, DT = 1 / TICK;
export const C = {
  maxspeed: 250 * U, rifle: 215 / 250, walk: 0.52, duck: 0.34, accel: 5.5, airaccel: 12, aircap: 30 * U,
  friction: 5.2, stopspeed: 100 * U, gravity: 800 * U, jump: 301.993 * U,
  radius: 16 * U, stand: 72 * U, crouch: 54 * U, eyeStand: 64 * U, eyeCrouch: 46 * U
};
export const SPRAY = [[0,0],[.05,.3],[0,.8],[-.1,1.5],[.05,2.4],[.2,3.4],[.1,4.4],[-.15,5.2],[-.35,5.8],[-.2,6.2],
  [-.9,6.4],[-1.7,6.55],[-2.3,6.6],[-2.5,6.7],[-2.1,6.8],[-1.2,6.85],[0,6.9],[1.1,7.0],[2.0,7.05],[2.7,7.1],[2.9,7.15],
  [2.4,7.2],[1.3,7.3],[.1,7.35],[-1.0,7.4],[-1.9,7.45],[-2.2,7.5],[-1.6,7.55],[-.6,7.6],[.4,7.65]];
/* hand-made patterns (2026-11-23). AK: first 4 shots tight (a tap burst stays on the head), a hard straight climb to
   shot 10, then uneven sweeps left, right, left, each a different length. M4: lower climb, swings right first, slower
   and narrower sweeps. Each rifle its own pattern (gun feel pass, 2026-11-14): the AUG is the tightest, a low climb and a small weave. Degrees of view kick per shot */
const SPRAY_M4 = [[0,0],[0,.25],[.05,.65],[0,1.2],[-.05,1.85],[0,2.6],[.1,3.3],[.15,3.9],[.25,4.35],[.5,4.7],[.9,4.95],
  [1.3,5.1],[1.5,5.2],[1.4,5.3],[1.0,5.35],[.4,5.4],[-.3,5.45],[-.9,5.5],[-1.3,5.55],[-1.4,5.6],[-1.2,5.65],[-.7,5.7],
  [-.1,5.75],[.5,5.8],[1.0,5.85],[1.2,5.9],[1.0,5.95],[.5,6.0],[-.1,6.05],[-.6,6.1]];
const SPRAY_AUG = [[0,0],[0,.35],[-.05,.85],[-.1,1.45],[-.2,2.05],[-.3,2.6],[-.35,3.05],[-.3,3.4],[-.1,3.65],[.2,3.85],[.5,4.0],
  [.75,4.1],[.85,4.2],[.7,4.25],[.35,4.3],[-.1,4.35],[-.5,4.4],[-.8,4.45],[-.85,4.5],[-.6,4.55],[-.2,4.6],[.25,4.65],[.6,4.7],
  [.8,4.75],[.7,4.8],[.35,4.85],[-.05,4.9],[-.4,4.95],[-.6,5.0],[-.5,5.05]];
/* small kick patterns for pistols and SMGs (degrees of view kick per shot, like the rifles') */
const P_GLOCK = [[0,0],[0,.7],[.1,1.3],[-.1,1.8],[.15,2.2],[-.1,2.5],[.1,2.7]];
const P_USP = [[0,0],[0,.8],[-.1,1.5],[.1,2.1],[-.1,2.6],[.1,3.0]];
const P_DEAGLE = [[0,0],[0,2.2],[.3,4.0],[-.3,5.4],[.3,6.4]];
const P_MP9 = [[0,0],[0,.35],[.05,.8],[.1,1.3],[0,1.8],[-.15,2.25],[-.3,2.6],[-.2,2.9],[.1,3.1],[.4,3.25],[.6,3.35],[.5,3.45],[.2,3.5],
  [-.2,3.55],[-.5,3.6],[-.6,3.65],[-.4,3.7],[0,3.75],[.4,3.8],[.6,3.85],[.5,3.9],[.1,3.95],[-.3,4.0],[-.5,4.05],[-.4,4.1],[0,4.15],[.3,4.2],
  [.5,4.25],[.4,4.3],[.1,4.35]];
const P_MAC10 = P_MP9.map(([x, y]) => [-x * 1.3, y * 1.1]);
/* the rest of the arsenal's kicks (2026-11-14): each scaled from the closest gun above - CS's own pattern data is not
   at hand, so these keep each gun's character (how high, how wide, which way first), not its exact shape */
const sc = (P, kx, ky) => P.map(([x, y]) => [x * kx, y * ky]);
const P_P250 = sc(P_GLOCK, 1.1, 1.25), P_57 = sc(P_USP, -.9, 1.05), P_TEC9 = sc(P_GLOCK, -1.2, 1.15), P_CZ = sc(P_GLOCK, 1.4, 1.35);
const P_MP7 = sc(P_MP9, .85, .95), P_UMP = sc(P_MP9, -1.15, 1.25), P_P90 = sc(P_MP9, .9, 1.05);
const P_GALIL = sc(SPRAY, -.85, .9), P_FAMAS = sc(SPRAY_M4, .9, .85), P_M4S = sc(SPRAY_M4, .7, .78), P_SG = sc(SPRAY_AUG, -1.1, 1.1);
const P_NEGEV = [[0,0],[0,.9],[.3,1.9],[-.2,2.9],[.5,3.8],[-.4,4.4],[.3,4.7],[-.2,4.6],[.1,4.2],[0,3.6],[.1,3.0],[-.1,2.5],[.05,2.1],[0,1.9]];   // wild, then a tight line
/* the weapons, CS:GO's numbers (armour pass, 2026-11-14): dmg = base damage, times the hit zone (HG) and CS's range
   falloff (range, per 500 units), then armour (ap = CS's armour ratio; see armour() below). speed in Source units a
   second; inaccuracy in degrees (base standing/crouched, added at full run, added in the air); zoom as field-of-view
   multipliers. Gun feel: fire = spread each shot adds, tau = seconds it takes to fade, accMax its cap; pen = the thickest
   wall in metres a bullet passes; tag = how much a hit slows the one it hits. auto: false = one shot a click (pistols);
   pellets/pcone = a shotgun's pellets and their cone; shell = a shotgun reloads one shell at a time. Slots: p primary,
   s secondary (pistol), k knife, g grenade */
export const HG = { head: 4, body: 1, stomach: 1.25, arm: 1, leg: .75 };
export const WEAPONS = {
  knife:  { name: "Knife", slot: "k", melee: true, range: 1.7, rate: .4, speed: 250, deploy: .4, ap: 1.7, tag: .3, dmg: { head: 55, body: 40, stomach: 40, leg: 30 } },
  glock:  { name: "Glock-18", slot: "s", auto: false, burst: true, burstDelay: .5, rate: .15, mag: 20, res: 120, speed: 240, deploy: .55, reload: 2.27, spray: P_GLOCK, base: [.42, .3], move: 2, air: 4, fire: .9, tau: .2, accMax: 3, dmg: 30, ap: .94, range: .85, pen: .15, tag: .4 },
  usp:    { name: "USP-S", slot: "s", auto: false, quiet: true, rate: .17, mag: 12, res: 24, speed: 240, deploy: .55, reload: 2.17, spray: P_USP, base: [.3, .2], move: 2.2, air: 4, fire: 1.0, tau: .22, accMax: 3, dmg: 35, ap: 1.01, range: .91, pen: .18, tag: .4 },
  deagle: { name: "Desert Eagle", slot: "s", auto: false, rate: .225, mag: 7, res: 35, speed: 230, deploy: .7, reload: 2.2, spray: P_DEAGLE, base: [.5, .35], move: 5, air: 7, fire: 2.4, tau: .4, accMax: 5, dmg: 63, ap: 1.864, range: .81, pen: .25, tag: .6 },
  mp9:    { name: "MP9", slot: "p", rate: .07, mag: 30, res: 120, speed: 240, deploy: .8, reload: 2.1, spray: P_MP9, base: [.55, .4], move: 1.6, air: 6, fire: .5, tau: .1, accMax: 2.2, dmg: 26, ap: 1.2, range: .87, pen: .12, tag: .4 },
  mac10:  { name: "MAC-10", slot: "p", rate: .075, mag: 30, res: 100, speed: 240, deploy: .8, reload: 2.6, spray: P_MAC10, base: [.65, .45], move: 1.8, air: 6, fire: .55, tau: .1, accMax: 2.4, dmg: 29, ap: 1.15, range: .8, pen: .12, tag: .4 },
  nova:   { name: "Nova", slot: "p", rate: .88, mag: 8, res: 32, speed: 220, deploy: .9, reload: .5, shell: .5, kick: 3, base: [.8, .6], move: 2, air: 6, pellets: 9, pcone: 3.6, dmg: 26, ap: 1.0, range: .7, pen: .1, tag: .5 },
  p250:   { name: "P250", slot: "s", auto: false, rate: .15, mag: 13, res: 26, speed: 240, deploy: .55, reload: 2.2, spray: P_P250, base: [.45, .32], move: 2.2, air: 4, fire: 1.1, tau: .22, accMax: 3.4, dmg: 38, ap: 1.28, range: .9, pen: .18, tag: .45 },
  fiveseven: { name: "Five-SeveN", slot: "s", auto: false, rate: .15, mag: 20, res: 100, speed: 240, deploy: .55, reload: 2.2, spray: P_57, base: [.38, .26], move: 2, air: 4, fire: 1.0, tau: .2, accMax: 3.2, dmg: 32, ap: 1.823, range: .81, pen: .22, tag: .45 },
  tec9:   { name: "Tec-9", slot: "s", auto: false, rate: .12, mag: 18, res: 90, speed: 240, deploy: .55, reload: 2.5, spray: P_TEC9, base: [.55, .4], move: 1.6, air: 4, fire: 1.1, tau: .18, accMax: 3.6, dmg: 33, ap: 1.812, range: .81, pen: .22, tag: .45 },
  cz75:   { name: "CZ75-Auto", slot: "s", rate: .1, mag: 12, res: 12, speed: 240, deploy: .55, reload: 2.7, spray: P_CZ, base: [.55, .4], move: 2.4, air: 5, fire: 1.0, tau: .16, accMax: 3.8, dmg: 31, ap: 1.553, range: .85, pen: .2, tag: .45 },
  mp7:    { name: "MP7", slot: "p", rate: .08, mag: 30, res: 120, speed: 220, deploy: .8, reload: 2.4, spray: P_MP7, base: [.5, .36], move: 1.8, air: 6, fire: .5, tau: .1, accMax: 2.3, dmg: 29, ap: 1.25, range: .85, pen: .13, tag: .45 },
  ump:    { name: "UMP-45", slot: "p", rate: .09, mag: 25, res: 100, speed: 230, deploy: .8, reload: 2.6, spray: P_UMP, base: [.6, .42], move: 2, air: 6, fire: .6, tau: .11, accMax: 2.6, dmg: 35, ap: 1.3, range: .75, pen: .14, tag: .5 },
  p90:    { name: "P90", slot: "p", rate: .07, mag: 50, res: 100, speed: 230, deploy: .8, reload: 2.9, spray: P_P90, base: [.62, .45], move: 1.5, air: 6, fire: .45, tau: .1, accMax: 2.4, dmg: 26, ap: 1.38, range: .86, pen: .13, tag: .45 },
  galil:  { name: "Galil AR", slot: "p", rate: .09, mag: 35, res: 90, speed: 215, deploy: .9, reload: 2.4, spray: P_GALIL, base: [.45, .3], move: 5.5, air: 9, fire: 1.1, tau: .15, accMax: 3, dmg: 30, ap: 1.55, range: .98, pen: .28, tag: .5 },
  famas:  { name: "FAMAS", slot: "p", rate: .09, mag: 25, res: 90, speed: 220, deploy: .9, reload: 3.0, spray: P_FAMAS, base: [.42, .28], move: 5, air: 9, fire: 1.0, tau: .14, accMax: 2.8, burst: true, burstDelay: .35, dmg: 30, ap: 1.4, range: .96, pen: .26, tag: .5 },
  m4a1s:  { name: "M4A1-S", slot: "p", quiet: true, rate: .1, mag: 20, res: 80, speed: 225, deploy: .9, reload: 3.0, spray: P_M4S, base: [.28, .18], move: 5, air: 9, fire: .85, tau: .13, accMax: 2.2, dmg: 38, ap: 1.4, range: .99, pen: .25, tag: .5 },
  sg553:  { name: "SG 553", slot: "p", rate: .09, mag: 30, res: 90, speed: 210, deploy: .9, reload: 2.8, spray: P_SG, base: [.4, .25], scoped: .12, zoom: [1, .5], zoomSpeed: 150, move: 5, air: 9, fire: .95, tau: .14, accMax: 2.6, dmg: 30, ap: 2.0, range: .98, pen: .3, tag: .5 },
  ssg08:  { name: "SSG 08", slot: "p", rate: 1.25, mag: 10, res: 90, speed: 230, deploy: 1.1, reload: 3.7, base: [3, 3], scoped: .03, zoom: [1, .4, .15], zoomSpeed: 230, move: 6, air: 3, unzoom: true, kick: 1.6, dmg: 88, ap: 1.7, range: .98, pen: .45, tag: .55 },
  xm1014: { name: "XM1014", slot: "p", rate: .35, mag: 7, res: 32, speed: 215, deploy: .9, reload: .35, shell: .35, kick: 2.4, base: [.8, .6], move: 2, air: 6, pellets: 6, pcone: 4.2, dmg: 20, ap: 1.6, range: .7, pen: .1, tag: .5 },
  negev:  { name: "Negev", slot: "p", rate: .075, mag: 150, res: 300, speed: 150, deploy: 1.1, reload: 5.7, spray: P_NEGEV, base: [.9, .6], move: 4, air: 9, fire: .7, tau: .2, accMax: 4, dmg: 35, ap: 1.42, range: .97, pen: .28, tag: .55 },
  zeus:   { name: "Zeus x27", slot: "k", auto: false, rate: .5, mag: 1, res: 0, speed: 245, deploy: .9, reload: 99, base: [.2, .2], move: 1, air: 2, reach: 4.65, dmg: 500, ap: 2, pen: 0, tag: .6 },
  ak:     { name: "AK-47", slot: "p", rate: .1, mag: 30, res: 90, speed: 215, deploy: .9, reload: 2.0, spray: SPRAY, base: [.38, .22], move: 5.5, air: 9, fire: 1.2, tau: .15, accMax: 3, dmg: 36, ap: 1.55, range: .98, pen: .3, tag: .55 },
  m4:     { name: "M4A4", slot: "p", rate: .09, mag: 30, res: 90, speed: 225, deploy: .9, reload: 2.2, spray: SPRAY_M4, base: [.32, .2], move: 5, air: 9, fire: .95, tau: .13, accMax: 2.4, dmg: 33, ap: 1.4, range: .97, pen: .25, tag: .5 },
  aug:    { name: "AUG", slot: "p", rate: .09, mag: 30, res: 90, speed: 220, deploy: .9, reload: 2.4, spray: SPRAY_AUG, base: [.4, .25], scoped: .12, zoom: [1, .5], zoomSpeed: 150, move: 5, air: 9, fire: .9, tau: .14, accMax: 2.4, dmg: 28, ap: 1.8, range: .98, pen: .28, tag: .5 },
  awp:    { name: "AWP", slot: "p", rate: 1.46, mag: 10, res: 30, speed: 200, deploy: 1.15, reload: 2.6, base: [8, 8], scoped: .05, zoom: [1, .27, .11], zoomSpeed: 100, move: 12, air: 18, unzoom: true, kick: 2.2, dmg: 115, ap: 1.95, range: .99, pen: .6, tag: .6 },
  he:      { name: "HE grenade", slot: "g", nade: true, speed: 245, deploy: .5, dmg: 98, ap: 1.15, radius: 8.9 },
  flash:   { name: "Flashbang", slot: "g", nade: true, speed: 245, deploy: .5 },
  smoke:   { name: "Smoke", slot: "g", nade: true, speed: 245, deploy: .5 },
  molotov: { name: "Molotov", slot: "g", nade: true, speed: 245, deploy: .5, ap: 1 },
  decoy:   { name: "Decoy", slot: "g", nade: true, speed: 245, deploy: .5 },
  c4:      { name: "C4", slot: "c", c4: true, speed: 250, deploy: .4 }     // Competitive's bomb (2026-11-14): planted by the server, not fired
};
/* handling, gun by gun (2026-11-23; was one feel for every gun): rec = seconds after the trigger is let go for a full
   spray to reset (CS's recovery time: the AK's 7.62 kick is slow to settle, the M4 quicker, SMGs and small pistols
   quickest, the Deagle slow); pr = how fast the view punch settles (per second, higher = snappier). Client only: vk = how
   far the gun drives back into the hand, vkr = how fast it comes back, rise = the muzzle's climb (rad at full kick), roll
   = its twist, fl = the flash's life (s). The guns we draw are tuned one by one; the rest take their class's feel */
const FEEL = {
  ak:     { rec: .46, pr: 7,  vk: 1.6, vkr: 10, rise: .11, roll: .05,  fl: .055 },   // heavy, slow thump, climbs and twists
  m4:     { rec: .38, pr: 10, vk: 1.0, vkr: 15, rise: .06, roll: -.025, fl: .045 },   // flat, quick, buzzy
  m4a1s:  { rec: .36, pr: 11, vk: .8,  vkr: 16, rise: .05, roll: -.02, fl: .02 },
  aug:    { rec: .4,  pr: 10, vk: .9,  vkr: 14, rise: .05, roll: .02,  fl: .04 },
  galil:  { rec: .44, pr: 8,  vk: 1.3, vkr: 12, rise: .09, roll: .04,  fl: .05 },
  famas:  { rec: .38, pr: 10, vk: 1.0, vkr: 15, rise: .06, roll: -.03, fl: .045 },
  sg553:  { rec: .42, pr: 9,  vk: 1.1, vkr: 13, rise: .07, roll: .03,  fl: .05 },
  negev:  { rec: .6,  pr: 6,  vk: 1.2, vkr: 12, rise: .07, roll: .06,  fl: .055 },
  mp9:    { rec: .28, pr: 13, vk: .6,  vkr: 19, rise: .035, roll: .02, fl: .035 },  // light, rattly, settles at once
  mac10:  { rec: .3,  pr: 12, vk: .7,  vkr: 18, rise: .045, roll: -.04, fl: .04 },
  mp7:    { rec: .28, pr: 13, vk: .6,  vkr: 19, rise: .035, roll: .02, fl: .035 },
  ump:    { rec: .34, pr: 10, vk: .9,  vkr: 15, rise: .055, roll: -.03, fl: .045 },
  p90:    { rec: .3,  pr: 12, vk: .6,  vkr: 18, rise: .035, roll: .02, fl: .035 },
  glock:  { rec: .28, pr: 14, vk: .8,  vkr: 17, rise: .1,  roll: .03,  fl: .035 },   // snappy, little flip
  usp:    { rec: .3,  pr: 13, vk: .7,  vkr: 15, rise: .09, roll: .02,  fl: .012 },   // soft push, almost no flash
  p250:   { rec: .32, pr: 12, vk: 1.0, vkr: 15, rise: .12, roll: .03,  fl: .04 },
  fiveseven: { rec: .3, pr: 13, vk: .8, vkr: 16, rise: .1, roll: -.02, fl: .035 },
  tec9:   { rec: .3,  pr: 12, vk: .9,  vkr: 16, rise: .11, roll: -.04, fl: .04 },
  cz75:   { rec: .32, pr: 12, vk: .8,  vkr: 17, rise: .08, roll: .03,  fl: .04 },
  deagle: { rec: .55, pr: 6,  vk: 3.0, vkr: 7,  rise: .32, roll: .08,  fl: .07 },    // big flip, slow to come down
  nova:   { rec: .5,  pr: 6,  vk: 2.8, vkr: 7,  rise: .2,  roll: .04,  fl: .08 },
  xm1014: { rec: .45, pr: 7,  vk: 2.2, vkr: 9,  rise: .14, roll: .05,  fl: .07 },
  ssg08:  { rec: .8,  pr: 7,  vk: 2.2, vkr: 10, rise: .16, roll: .03,  fl: .06 },
  awp:    { rec: 1,   pr: 5,  vk: 4,   vkr: 9,  rise: .28, roll: .05,  fl: .09 },
  zeus:   { rec: .5,  pr: 8,  vk: .6,  vkr: 12, rise: .05, roll: 0,    fl: .02 } };
for (const [w, f] of Object.entries(FEEL)) Object.assign(WEAPONS[w], f);
export const NADES = ["he", "flash", "smoke", "molotov", "decoy"];
/* guns switched off for now (operator 2026-11-23: one mode, perfect each gun alone): those without a real model yet.
   Their code and numbers stay; nothing hands them out (no pickup, no buy, no bot, no ladder) while they are in here */
export const OFF = new Set([]);   // empty again (operator 2026-11-23 "unhide all"); the list was: zeus aug sg553 m4a1s famas galil negev ssg08 mac10 mp7 ump p90 p250 fiveseven tec9 cz75 nova xm1014
export const WIDS = Object.keys(WEAPONS);                     // index <-> id on the wire
export const DMG = { head: 36 * 4, body: 36, leg: 27 }, FIRE_INTERVAL = .1, RELOAD = 2.43, MAG = 30, RESERVE = 90;
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/* what a hit does before armour: the gun's base damage times the hit zone, less CS's range falloff over the distance in
   metres. The knife has its own table and no falloff */
export function damageFor(W0, part, dist) {
  if (typeof W0.dmg === "object") return W0.dmg[part] ?? W0.dmg.body;
  return W0.dmg * (HG[part] ?? 1) * Math.pow(W0.range || 1, dist / U / 500);
}
/* CS's armour, exactly: armour covers the chest, stomach and arms, and the head only with a helmet; never the legs. On
   a covered hit, health takes dmg x (armour ratio / 2) and the armour loses half of what it stopped; if the armour runs
   out, the rest goes to health. Health and armour lose whole points (CS truncates). Changes s, returns the health lost */
export function armour(s, W0, part, dmg) {
  const covered = s.armor > 0 && part !== "leg" && (part !== "head" || s.helmet);
  if (!covered) return Math.floor(dmg);
  let hp = dmg * (W0.ap ?? 1) * .5, ar = (dmg - hp) * .5;
  if (ar > s.armor) { hp = dmg - s.armor / .5; ar = s.armor; }
  s.armor = Math.max(0, s.armor - Math.floor(ar)); if (!s.armor) s.helmet = false;
  return Math.floor(hp);
}

/* mulberry32: the shot's spread from (entity id, command number), identical on server and client */
export function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ── the map's collision: boxes for the stand-in, a transformed mesh for a generated world ─────────────────────── */
export function standinParts() {
  const parts = { stone: [], floor: [], wood: [], dark: [] };
  const box = (m, x, y, z, sx, sy, sz, ry = 0) => {
    const g = new THREE.BoxGeometry(sx, sy, sz), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) { const f = Math.floor(i / 4), d = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]][f]; uv.setXY(i, uv.getX(i) * d[0] / 2.5, uv.getY(i) * d[1] / 2.5); }
    g.rotateY(ry); g.translate(x, y, z); parts[m].push(g);
  };
  const W = 52, D = 38, H = 6;
  box("floor", 0, -.5, 0, W, 1, D);
  box("stone", 0, H / 2, -D / 2 - .5, W + 2, H, 1); box("stone", 0, H / 2, D / 2 + .5, W + 2, H, 1);
  box("stone", -W / 2 - .5, H / 2, 0, 1, H, D); box("stone", W / 2 + .5, H / 2, 0, 1, H, D);
  for (const [z0, z1] of [[-D / 2, -11], [-7, -1.6], [1.6, 7], [11, D / 2]]) box("stone", 0, 2, (z0 + z1) / 2, 1.2, 4, z1 - z0);
  box("stone", 0, 3.4, 0, 1.2, 1.2, 3.2);
  box("stone", -15, 2.2, -6, 12, 4.4, .8); box("stone", -15, 2.2, 6, 12, 4.4, .8);
  box("stone", -9, 2.2, -3.6, .8, 4.4, 4); box("stone", -9, 2.2, 3.6, .8, 4.4, 4); box("stone", -9, 3.7, 0, .8, 1.4, 3.2);
  box("dark", -15, 4.6, 0, 12.8, .4, 12.8);
  box("stone", 18, 1.1, -12, 12, 2.2, 10);
  box("dark", 10.2, 1.1, -12, 4.2, .25, 3.2); { const g = new THREE.BoxGeometry(6.2, .3, 3); g.rotateZ(-Math.atan2(2.2, 6)); g.translate(9.1, 1.05, -8.4); parts.stone.push(g); }
  box("stone", 18, 2.75, -7.3, 12, 1.1, .4);
  for (const [x, z, s, st] of [[8, 8, 1.3, 1], [9.4, 8.2, 1.3, 1], [8.6, 9.6, 1.3, 2], [-5, -14, 1.3, 1], [-4, 14, 1.3, 2], [14, 3, 1.3, 1], [20, 10, 1.3, 1], [21.4, 10.3, 1.3, 1], [-21, -14, 1.3, 1], [-20.5, 13, 1.3, 2], [4, -3, 1.0, 1]])
    for (let k = 0; k < st; k++) box("wood", x, s / 2 + k * s, z, s, s, s, (x * 7 + z) % 3 * .2);
  for (let x = -20; x <= 20; x += 8) box("stone", x, 2.5, 16, .9, 5, .9);
  return parts;
}
export function mapMatrix(m) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...(m.offset || [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(m.rotate || [0, 0, 0]).map(d => d * DEG), "XYZ")),
    new THREE.Vector3().setScalar(m.scale || 1));
}
/* every mesh in a parsed glTF scene, baked to world space, then the map's own transform */
export function gltfGeometries(sceneRoot, m) {
  const xf = mapMatrix(m), out = []; sceneRoot.updateMatrixWorld(true);
  sceneRoot.traverse(o => { if (o.isMesh) {
    // compressed (meshopt) files store positions as small integers: turn them into plain floats before any transform
    // is baked in, or the transform is written back into integer storage and the mesh is ruined
    const g = new THREE.BufferGeometry(), src = o.geometry.attributes.position, f = new Float32Array(src.count * 3);
    for (let i = 0; i < src.count; i++) { f[i * 3] = src.getX(i); f[i * 3 + 1] = src.getY(i); f[i * 3 + 2] = src.getZ(i); }
    g.setAttribute("position", new THREE.BufferAttribute(f, 3)); if (o.geometry.index) g.setIndex(o.geometry.index.clone());
    g.applyMatrix4(o.matrixWorld); g.applyMatrix4(xf); out.push(g); } });
  return out;
}

/* ── the world: raycasts, the capsule push-out, walkable space and routes ─────────────────────────────────────── */
export class World {
  constructor(geoms) {
    const pos = geoms.map(g => { const n = new THREE.BufferGeometry(); n.setAttribute("position", (g.index ? g.toNonIndexed() : g).attributes.position.clone()); return n; });
    this.geom = mergeGeometries(pos); this.bvh = new MeshBVH(this.geom); this.geom.boundsTree = this.bvh; this.geom.computeBoundingBox();
    this.bounds = this.geom.boundingBox; this.ray = new THREE.Ray();
    this.nodes = []; this.spawn = [[], []]; this.span = 0;
  }
  first(o, d, far) { this.ray.origin.copy(o); this.ray.direction.copy(d); const h = this.bvh.raycastFirst(this.ray, THREE.DoubleSide); return h && h.distance <= far ? h : null; }
  all(o, d) { this.ray.origin.copy(o); this.ray.direction.copy(d); return this.bvh.raycast(this.ray, THREE.DoubleSide).sort((a, b) => a.distance - b.distance); }
  clear(a, b) { const d = new THREE.Vector3().subVectors(b, a), L = d.length(); if (L < 1e-4) return true; d.divideScalar(L); return !this.first(a, d, L - .02); }
  /* the capsule pushed out of every triangle it overlaps; returns how far it moved */
  collide(pos, r, h) {
    const seg = _seg, box = _box; seg.start.set(pos.x, pos.y + r, pos.z); seg.end.set(pos.x, pos.y + h - r, pos.z); const s0 = seg.start.clone();
    for (let it = 0; it < 3; it++) {
      box.makeEmpty(); box.expandByPoint(seg.start); box.expandByPoint(seg.end); box.min.addScalar(-r); box.max.addScalar(r);
      this.bvh.shapecast({ intersectsBounds: b => b.intersectsBox(box), intersectsTriangle: tri => {
        const dist = tri.closestPointToSegment(seg, _tp, _cp);
        if (dist < r) { const dir = _cp.sub(_tp), L = dir.length(); if (L < 1e-6) return; dir.divideScalar(L); const dep = r - dist; seg.start.addScaledVector(dir, dep); seg.end.addScaledVector(dir, dep); } } });
    }
    return seg.start.clone().sub(s0);
  }
  buildNav() {
    const b = this.bounds, step = clamp(Math.min(b.max.x - b.min.x, b.max.z - b.min.z) / 70, .6, 1.2), top = b.max.y + 2, down = new THREE.Vector3(0, -1, 0), up = new THREE.Vector3(0, 1, 0);
    const cell = new Map(), nodes = [], dirs = []; for (let k = 0; k < 8; k++) dirs.push(new THREE.Vector3(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4)));
    for (let x = b.min.x + step / 2; x < b.max.x; x += step) for (let z = b.min.z + step / 2; z < b.max.z; z += step) {
      for (const h of this.all(new THREE.Vector3(x, top, z), down)) {
        const n = h.face ? h.face.normal : null; if (!n || Math.abs(n.y) < .72) continue;
        const p = h.point.clone(), hd = this.first(p.clone().addScaledVector(up, .05), up, 3); if (hd && hd.distance < C.stand + .1) continue;
        let blocked = false; for (const hh of [.5, 1.3]) { const o = p.clone(); o.y += hh; for (const d of dirs) if (this.first(o, d, C.radius * .95)) { blocked = true; break; } if (blocked) break; }
        if (blocked) continue;
        const node = { i: nodes.length, p, ix: Math.round((x - b.min.x) / step), iz: Math.round((z - b.min.z) / step), nb: [] };
        nodes.push(node); const key = node.ix + "," + node.iz; (cell.get(key) || cell.set(key, []).get(key)).push(node);
      }
    }
    const a = new THREE.Vector3(), c = new THREE.Vector3();
    for (const n of nodes) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue; const list = cell.get((n.ix + dx) + "," + (n.iz + dz)); if (!list) continue;
      for (const m of list) { if (m.i < n.i || Math.abs(m.p.y - n.p.y) > .55) continue;
        a.copy(n.p); a.y += .45; c.copy(m.p); c.y += .45; if (!this.clear(a, c)) continue; a.y += .8; c.y += .8; if (!this.clear(a, c)) continue;
        const w = n.p.distanceTo(m.p); n.nb.push([m.i, w]); m.nb.push([n.i, w]); }
    }
    const comp = new Int32Array(nodes.length).fill(-1); let best = -1, bestN = 0;
    for (const n of nodes) { if (comp[n.i] >= 0) continue; const q = [n.i]; comp[n.i] = n.i; let cnt = 0;
      while (q.length) { const k = q.pop(); cnt++; for (const [j] of nodes[k].nb) if (comp[j] < 0) { comp[j] = n.i; q.push(j); } }
      if (cnt > bestN) { bestN = cnt; best = n.i; } }
    nodes.forEach(n => n.c = comp[n.i]); this.raw = { nodes, main: best, cell };
    const keep = nodes.filter(n => comp[n.i] === best), remap = new Map(keep.map((n, k) => [n.i, k]));
    keep.forEach(n => { n.nb = n.nb.filter(([j]) => remap.has(j)).map(([j, w]) => [remap.get(j), w]); }); keep.forEach((n, k) => n.i = k);
    this.nodes = keep;
    if (!keep.length) return;
    const far = s => { const d = this.dijkstra(s); let k = s; d.forEach((v, i) => { if (isFinite(v) && v > d[k]) k = i; }); return k; };
    const A = far(0), dA = this.dijkstra(A); let B = A; dA.forEach((v, i) => { if (isFinite(v) && v > dA[B]) B = i; });
    const dB = this.dijkstra(B), r = Math.max(3, Math.min(6, dA[B] / 5));
    this.spawn = [keep.filter(n => dA[n.i] < r).map(n => n.i), keep.filter(n => dB[n.i] < r).map(n => n.i)]; this.span = dA[B];
  }
  dijkstra(s) {
    const N = this.nodes, d = new Float64Array(N.length).fill(Infinity), q = [[0, s]]; d[s] = 0;
    while (q.length) { let bi = 0; for (let i = 1; i < q.length; i++) if (q[i][0] < q[bi][0]) bi = i; const [dist, k] = q.splice(bi, 1)[0]; if (dist > d[k]) continue;
      for (const [j, w] of N[k].nb) if (dist + w < d[j]) { d[j] = dist + w; q.push([d[j], j]); } }
    return d;
  }
  nearest(p) { let best = 0, bd = Infinity; for (const n of this.nodes) { const d = n.p.distanceToSquared(p); if (d < bd) { bd = d; best = n.i; } } return best; }
  astar(s, t) {
    const N = this.nodes, g = new Float64Array(N.length).fill(Infinity), from = new Int32Array(N.length).fill(-1), open = new Map(); g[s] = 0; open.set(s, N[s].p.distanceTo(N[t].p));
    while (open.size) { let k = -1, kf = Infinity; for (const [i, f] of open) if (f < kf) { kf = f; k = i; } open.delete(k);
      if (k === t) { const path = []; for (let c = t; c >= 0; c = from[c]) path.push(c); return path.reverse(); }
      for (const [j, w] of N[k].nb) { const ng = g[k] + w; if (ng < g[j]) { g[j] = ng; from[j] = k; open.set(j, ng + N[j].p.distanceTo(N[t].p)); } } }
    return [s];
  }
}
const _seg = new THREE.Line3(), _box = new THREE.Box3(), _tp = new THREE.Vector3(), _cp = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);

/* ── a player: state, one command of movement, the weapon ─────────────────────────────────────────────────────── */
export function newPlayer() {
  return { pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, duck: 0, onGround: false, jumpHeld: false,
           hp: 100, alive: true, mag: MAG, res: RESERVE, reloadAt: 0, nextShot: 0, spray: 0, lastShot: -9, punchX: 0, punchY: 0,
           acc: 0, tag: 0, stamina: 0, landed: false, w: "ak", prim: "ak", last: "knife", zoom: 0, deployUntil: 0, zoomHeld: false,
           sec: "glock", pa: [0, 0], sa: [20, 120], c4: false, zeus: false, burstOn: false, burstLeft: 0, trig: false, cock: 0, nades: { he: 0, flash: 0, smoke: 0, molotov: 0, decoy: 0 },
           armor: 0, helmet: false };
}
export const wpn = s => WEAPONS[s.w] || WEAPONS.knife;
/* a fresh primary in hand (spawn, pickup): its own full ammunition unless given */
/* the gun in hand keeps its ammunition in s.mag/s.res; a holstered primary keeps it in s.pa, a holstered pistol in s.sa */
export function stow(s) { if (s.w && s.w === s.prim) s.pa = [s.mag, s.res]; else if (s.w && s.w === s.sec) s.sa = [s.mag, s.res]; }
export function held(s, id) { return id === s.w ? [s.mag, s.res] : id === s.prim ? s.pa.slice() : id === s.sec ? s.sa.slice() : [0, 0]; }
/* take another weapon out: the one in hand is holstered with its ammunition, a cocked grenade is put back */
export function draw(s, want, t) {
  stow(s); s.last = s.w; s.w = want; s.zoom = 0; s.reloadAt = 0; s.cock = 0; s.burstLeft = 0; s.deployUntil = t + WEAPONS[want].deploy;
  if (want === s.prim) [s.mag, s.res] = s.pa; else if (want === s.sec) [s.mag, s.res] = s.sa; else if (want === "zeus") { s.mag = 1; s.res = 0; } else { s.mag = 0; s.res = 0; }
}
/* a fresh gun in hand (spawn, pickup), in its own slot: its full ammunition unless given */
export function equip(s, id, mag, res) {
  const W1 = WEAPONS[id]; stow(s);
  if (W1.slot === "s") s.sec = id; else s.prim = id;
  s.last = s.w === id ? s.last : s.w; s.w = id; s.mag = mag ?? W1.mag; s.res = res ?? W1.res;
  s.zoom = 0; s.reloadAt = 0; s.spray = 0; s.acc = 0; s.cock = 0;
}
/* the next grenade the player carries after the one in hand, in CS's order; null if none */
export function nextNade(s) {
  const i = NADES.indexOf(s.w);
  for (let k = 1; k <= NADES.length; k++) { const n = NADES[(i + k + NADES.length) % NADES.length]; if (n !== s.w && s.nades[n] > 0) return n; }
  return null;
}
export const TAG_REC = .6;
export const STAMINA = { jump: .08, land: .05, max: 80, rec: 60 };
export const height = s => C.stand + (C.crouch - C.stand) * s.duck;
export const eye = s => C.eyeStand + (C.eyeCrouch - C.eyeStand) * s.duck;
export function copyPlayer(dst, src) {
  dst.pos.copy(src.pos); dst.vel.copy(src.vel);
  for (const k of ["yaw", "pitch", "duck", "onGround", "jumpHeld", "hp", "alive", "mag", "res", "reloadAt", "nextShot", "spray", "lastShot", "punchX", "punchY", "acc", "tag", "w", "prim", "last", "zoom", "deployUntil", "zoomHeld", "sec", "trig", "cock", "armor", "helmet", "stamina", "landed", "c4", "zeus", "burstOn", "burstLeft"]) dst[k] = src[k];
  dst.pa = src.pa.slice(); dst.sa = src.sa.slice(); dst.nades = { ...src.nades }; for (const n of NADES) dst.nades[n] = dst.nades[n] || 0;   // copies, never shared: prediction mutates them
  return dst;
}
/* a command: { f, s (-1..1), jump, duck, walk, fire, reload, yaw, pitch, seq, vt (the view time it was aimed in) } */
export function move(w, s, cmd, dt = DT) {
  s.yaw = cmd.yaw; s.pitch = cmd.pitch;
  if (!s.alive) return;
  const d0 = s.duck;
  if (cmd.duck && s.duck < 1) s.duck = Math.min(1, s.duck + dt / .12);
  else if (!cmd.duck && s.duck > 0) { const o = s.pos.clone(); o.y += height(s); if (!w.first(o, UP, C.stand - height(s) + .02)) s.duck = Math.max(0, s.duck - dt / .12); }
  // crouch-jump (2026-11-14): crouching in the air pulls the feet up and keeps the eyes where they were, as in CS, so a
  // crouch at the top of a jump clears a higher ledge; standing up in the air lets the feet down again
  if (!s.onGround && s.duck !== d0) s.pos.y += (C.stand - C.crouch) * (s.duck - d0);
  const fw = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw)), rt = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
  const wd = fw.multiplyScalar(cmd.f).add(rt.multiplyScalar(cmd.s)), has = wd.lengthSq() > 0; if (has) wd.normalize();
  const W0 = wpn(s), spd = (s.zoom && W0.zoomSpeed ? W0.zoomSpeed : W0.speed) * U;
  let ws = has ? spd : 0; if (s.duck > .5) ws *= C.duck; else if (cmd.walk) ws *= C.walk;
  if (s.onGround && s.stamina > 0) ws *= 1 - s.stamina / 100;    // landing slowdown, still wearing off
  // tagging (2026-11-14): a hit slows you, as in CS; it wears off at TAG_REC a second
  if (s.tag > 0) { ws *= 1 - s.tag; s.tag = Math.max(0, s.tag - TAG_REC * dt); }
  const jumpNow = cmd.jump && !s.jumpHeld; s.jumpHeld = !!cmd.jump;
  if (s.onGround) {
    if (jumpNow) { s.vel.y = C.jump; s.onGround = false; s.landed = false; s.stamina = Math.min(STAMINA.max, (s.stamina || 0) + STAMINA.jump * C.jump / U); }
    else {
      if (s.landed) { const k = 1 - s.stamina / 100; s.vel.x *= k; s.vel.z *= k; s.landed = false; }   // the first step on the ground after a landing pays for it
      const sp = Math.hypot(s.vel.x, s.vel.z);
      if (sp < .01) { s.vel.x = s.vel.z = 0; } else { const k = Math.max(sp - Math.max(sp, C.stopspeed) * C.friction * dt, 0) / sp; s.vel.x *= k; s.vel.z *= k; }
      const cur = s.vel.x * wd.x + s.vel.z * wd.z, add = ws - cur; if (add > 0) { const acc = Math.min(C.accel * dt * ws, add); s.vel.x += acc * wd.x; s.vel.z += acc * wd.z; }
    }
  }
  if (!s.onGround) { const cur = s.vel.x * wd.x + s.vel.z * wd.z, add = Math.min(ws, C.aircap) - cur; if (add > 0) { const acc = Math.min(C.airaccel * ws * dt, add); s.vel.x += acc * wd.x; s.vel.z += acc * wd.z; } }
  s.vel.y -= C.gravity * dt;
  const was = s.onGround, prev = s.pos.clone(), vy0 = s.vel.y;
  s.pos.addScaledVector(s.vel, dt);
  { const o = s.pos.clone(); o.y += .5; if (!w.first(o, DOWN, 6.5)) { s.pos.x = prev.x; s.pos.z = prev.z; s.vel.x = s.vel.z = 0; } }
  const delta = w.collide(s.pos, C.radius, height(s));
  s.onGround = delta.y > Math.abs(dt * s.vel.y * .25) && delta.y > 0;
  const off = Math.max(0, delta.length() - 1e-5); if (off > 0) { const n = delta.clone().normalize(); s.pos.addScaledVector(n, off); const vn = s.vel.dot(n); if (vn < 0) s.vel.addScaledVector(n, -vn); }
  if (s.onGround && s.vel.y < 0) s.vel.y = 0;
  // CS's stamina (2026-11-14): a jump costs 0.08 x its speed, a landing 0.05 x the fall speed (units a second), at most
  // 80; the first step on the ground after a landing loses that share of the run, and it caps the run while it wears off
  // at 60 a second. A jump on the very tick of landing never touches the ground, so it skips the loss: CS's bunny hop
  if (s.onGround && !was) { s.stamina = Math.min(STAMINA.max, (s.stamina || 0) + STAMINA.land * Math.max(0, -vy0) / U); s.landed = true; }   // paid on the first ground step (a jump on that very tick skips it, as in CS)
  else if (s.onGround && s.stamina > 0) s.stamina = Math.max(0, s.stamina - STAMINA.rec * dt);
  if (was && !s.onGround && s.vel.y <= 0) { const o = s.pos.clone(); o.y += .3; const g = w.first(o, DOWN, .62); if (g && Math.abs(g.face.normal.y) > .7) { s.pos.y = g.point.y; s.vel.y = 0; s.onGround = true; } }
}
/* players block each other (2026-11-22), as in CS: after its move, a player standing in another's capsule is pushed out
   sideways and loses the speed it had into them. The server runs it for everyone after each move, the client for itself
   against where it draws the others, so the two agree but for the others' interpolation delay. others: [{ pos, duck }] */
export function block(s, others) {
  if (!s.alive) return;
  const hs = height(s), R2 = C.radius * 2;
  for (const o of others) {
    if (s.pos.y >= o.pos.y + C.stand + (C.crouch - C.stand) * (o.duck || 0) - .05 || o.pos.y >= s.pos.y + hs - .05) continue;   // one above the other
    let dx = s.pos.x - o.pos.x, dz = s.pos.z - o.pos.z, d = Math.hypot(dx, dz); if (d >= R2) continue;
    if (d < 1e-4) { dx = 1; dz = 0; d = 1; }
    const nx = dx / d, nz = dz / d, push = R2 - d; s.pos.x += nx * push; s.pos.z += nz * push;
    const vn = s.vel.x * nx + s.vel.z * nz; if (vn < 0) { s.vel.x -= vn * nx; s.vel.z -= vn * nz; }
  }
}
export function inaccuracy(s) {
  const W0 = wpn(s); if (W0.melee || W0.nade || W0.c4) return 0;
  const sp = Math.hypot(s.vel.x, s.vel.z), wmax = W0.speed * U;
  let a = s.zoom && W0.scoped != null ? W0.scoped : W0.base[s.duck > .5 ? 1 : 0];
  a += clamp((sp - .34 * wmax) / (.66 * wmax), 0, 1) * W0.move; if (!s.onGround) a += W0.air;
  a += (s.acc || 0) * (s.zoom && W0.scoped != null ? .5 : 1);    // the spray's own spread, halved when scoped
  return a * DEG;
}
export const viewDir = (yaw, pitch) => new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
/* one command of the weapon at time t: switching, zoom, reload, firing, grenades. Returns a shot { dir, dirs?, melee }
   or a throw { nade, str, dir }, or null; the client predicts with this and the server decides with it, so ammo, zoom,
   grenades and the spread agree on both ends */
export function weapon(s, cmd, t, seed) {
  // switching: 1 primary, 2 pistol, 3 knife, 4 the next grenade, Q the last one; a fresh draw cannot fire until it is up
  const want = cmd.slot === "p" ? s.prim : cmd.slot === "s" ? s.sec : cmd.slot === "k" ? (s.w === "knife" && s.zeus ? "zeus" : "knife") : cmd.slot === "g" ? nextNade(s) : cmd.slot === "c" ? (s.c4 ? "c4" : null) : cmd.slot === "q" ? s.last : null;
  if (want && want !== s.w && WEAPONS[want] && (want === "knife" || want === s.prim || want === s.sec || (WEAPONS[want].nade && s.nades[want] > 0) || (want === "c4" && s.c4) || (want === "zeus" && s.zeus))) draw(s, want, t);
  const W0 = wpn(s), pull = !!cmd.fire && !s.trig; s.trig = !!cmd.fire;
  if (s.acc > 0) s.acc = s.acc < 1e-3 ? 0 : s.acc * Math.exp(-DT / (W0.tau || .15));
  // reloading: a whole magazine at once, or a shotgun one shell at a time
  if (s.reloadAt && t >= s.reloadAt) {
    if (W0.shell) { if (s.res > 0 && s.mag < W0.mag) { s.mag++; s.res--; } s.reloadAt = s.mag < W0.mag && s.res > 0 ? t + W0.shell : 0; }
    else { const n = Math.min(W0.mag - s.mag, s.res); s.mag += n; s.res -= n; s.reloadAt = 0; }
  }
  if (t - s.lastShot > (W0.rate || .1)) { s.spray *= Math.exp(-DT * 4.06 / (W0.rec || .42)); if (s.spray < .5) s.spray = 0;   /* curve, not a line (2026-11-23): a full spray still resets in rec, but a 3-shot burst needs ~.45 rec (AK ~.2 s), so fast taps climb */ const k = Math.exp(-DT * (W0.pr || 9)); s.punchX *= k; s.punchY *= k; }
  if (!s.alive) return null;
  if (W0.c4) { s.zoomHeld = !!cmd.zoom; return null; }   // the bomb: holding fire on a site plants it, which the server decides
  // a grenade: left click cocks a full throw, right click a lob, both together a medium one; it flies on release
  if (W0.nade) {
    const zp0 = !!cmd.zoom; s.zoomHeld = zp0;
    if (t < s.deployUntil || s.nades[s.w] <= 0) return null;
    if (!s.cock) { if (cmd.fire) s.cock = 1; else if (cmd.zoom) s.cock = 2; return null; }
    if (s.cock === 1 ? cmd.fire : cmd.zoom) return null;
    const str = s.cock === 1 ? (cmd.zoom ? .5 : 1) : (cmd.fire ? .5 : 0), kind = s.w;
    s.nades[kind]--; s.cock = 0; s.lastShot = t;
    const back = [s.last, s.prim, s.sec, "knife"].find(x => x && x !== kind && (x === "knife" || x === s.prim || x === s.sec)) || "knife";
    draw(s, back, t);
    return { nade: kind, str, dir: viewDir(s.yaw, s.pitch) };
  }
  // zoom: each right click steps to the next level, round to none
  const zp = !!cmd.zoom && !s.zoomHeld; s.zoomHeld = !!cmd.zoom;
  if (zp && W0.zoom && !s.reloadAt) s.zoom = (s.zoom + 1) % W0.zoom.length;
  if (zp && W0.burst) { s.burstOn = !s.burstOn; s.burstLeft = 0; }   // the Glock and FAMAS: right click for three-round bursts
  if (W0.melee) {
    if (!cmd.fire || t < s.nextShot - 1e-6 || t < s.deployUntil) return null;
    s.nextShot = t + W0.rate; s.lastShot = t;
    return { melee: true, dir: viewDir(s.yaw, s.pitch) };
  }
  if (cmd.reload && !s.reloadAt && s.mag < W0.mag && s.res > 0) { s.reloadAt = t + (W0.shell || W0.reload); s.zoom = 0; }
  if (cmd.fire && W0.shell && s.reloadAt && s.mag > 0) s.reloadAt = 0;      // a shotgun fires between shells
  let trigger = !!cmd.fire && (W0.auto !== false || pull);
  if (W0.burst && s.burstOn) { if (pull && !s.burstLeft && t >= s.nextShot - 1e-6 && t >= s.deployUntil) s.burstLeft = Math.min(3, s.mag); trigger = s.burstLeft > 0; }
  if (!trigger || s.reloadAt || t < s.nextShot - 1e-6 || t < s.deployUntil) return null;
  if (s.mag <= 0) { s.burstLeft = 0; if (s.res > 0) { s.reloadAt = t + (W0.shell || W0.reload); s.zoom = 0; } return null; }
  s.mag--; s.nextShot = t + W0.rate; s.lastShot = t;
  if (s.burstLeft > 0) { s.burstLeft--; s.nextShot = t + (s.burstLeft > 0 ? .055 : W0.burstDelay || .4); }
  const cone = inaccuracy(s) * (W0.burst && s.burstOn ? 1.6 : 1);
  if (W0.fire) s.acc = Math.min(W0.accMax || 3, (s.acc || 0) + W0.fire);
  if (W0.spray) { const sp = W0.spray[Math.min(Math.floor(s.spray), W0.spray.length - 1)]; s.spray = Math.min(s.spray + 1, W0.spray.length - 1); s.punchX = sp[0] * DEG; s.punchY = sp[1] * DEG; }
  else { s.punchX = 0; s.punchY = (W0.kick || 0) * DEG; }
  const R = rng(seed), r = Math.sqrt(R()) * cone, th = R() * Math.PI * 2, aimX = W0.spray ? s.punchX : 0, aimY = W0.spray ? s.punchY : 0;
  const yaw = s.yaw - (aimX + r * Math.cos(th)), pitch = s.pitch + (aimY + r * Math.sin(th));
  const out = { dir: viewDir(yaw, pitch), z: s.zoom, w: s.w };   // z: the zoom it was fired at (an AWP unzooms right after); w: the gun
  if (W0.unzoom) s.zoom = 0;
  if (s.w === "zeus") { s.zeus = false; draw(s, s.prim || s.sec || "knife", t); }   // one charge: the Zeus is gone once fired
  if (W0.pellets) {   // each pellet its own way inside the cone, around where the shot went
    out.dirs = [];
    for (let k = 0; k < W0.pellets; k++) { const pr = Math.sqrt(R()) * W0.pcone * DEG, pt = R() * Math.PI * 2; out.dirs.push(viewDir(yaw - pr * Math.cos(pt), pitch + pr * Math.sin(pt))); }
  }
  return out;
}
/* ── grenades: CS's throw and bounce. The server flies them; the numbers live here with the weapons ─────────────── */
export const NADE = { grav: 320 * U, bounce: .45, fuse: { he: 1.5, flash: 1.5, molotov: 2 }, smokeTime: 18, smokeR: 3.6, fireTime: 7, fireR: 2.6, fireDps: 40, decoyTime: 15 };
/* where a throw starts and how fast: CS adds up to 10 degrees upward (most when level), speed 750 u/s x (0.3 + 0.7 x
   strength: 1 full, 0.5 medium, 0 lob), plus 1.25 x the thrower's own velocity */
export function throwFrom(w, s, str) {
  const pd = s.pitch / DEG, up = (pd + 10 * (90 - Math.abs(pd)) / 90) * DEG, d = viewDir(s.yaw, up);
  const v = d.clone().multiplyScalar(750 * U * (.3 + .7 * str)).addScaledVector(s.vel, 1.25);
  const o = eyePos(s), fwd = w.first(o, d, .35), p = fwd ? o : o.clone().addScaledVector(d, .3);
  return { p, v };
}
/* one tick of a flying grenade g { p, v, rest }: gravity, then the move swept against the map; a hit reflects it at
   CS's 0.45 restitution. Returns the hit ({ point, normal }) or null; a slow grenade on a floor comes to rest */
export function nadeStep(w, g, dt = DT) {
  if (g.rest) return null;
  g.v.y -= NADE.grav * dt;
  const d = g.v.clone().multiplyScalar(dt), L = d.length(); if (L < 1e-6) return null;
  const dir = d.clone().divideScalar(L), h = w.first(g.p, dir, L + .03);
  if (!h) { g.p.add(d); return null; }
  const n = h.face.normal.clone(); if (n.dot(dir) > 0) n.negate();
  g.p.copy(h.point).addScaledVector(n, .03);
  g.v.addScaledVector(n, -2 * g.v.dot(n)).multiplyScalar(NADE.bounce);
  if (n.y > .7 && g.v.length() < .5) { g.v.set(0, 0, 0); g.rest = true; }
  return { point: h.point.clone(), normal: n };
}
/* a wallbang (2026-11-14): the entry is wh (distance wd along dir); the exit is found by casting back from pen past the
   entry. A wall thinner than pen lets the bullet on, weaker the thicker it was ({ lo, hi, pm }: a target counts between lo
   and hi, its damage times pm); one wall at most, the next surface stops it. null: too thick, or nothing to pass */
export function penetrate(w, o, dir, wd, pen, far) {
  if (!pen) return null;
  // back-cast short of the entry: a wall thicker than pen leaves the back point inside it, and the only face found is
  // the entry itself, at pen - so that is excluded and means "too thick". A zero-thickness surface counts the same
  const x = w.first(o.clone().addScaledVector(dir, wd + pen), dir.clone().negate(), pen - 1e-3);
  if (!x) return null; const th = pen - x.distance;
  const exitD = wd + th, nx = w.first(o.clone().addScaledVector(dir, exitD + .01), dir, far - exitD);
  return { lo: exitD, hi: nx ? exitD + .01 + nx.distance : far, pm: clamp(1 - th / pen, 0, 1) * .5 + .25, th };
}
export function eyePos(s) { return new THREE.Vector3(s.pos.x, s.pos.y + eye(s), s.pos.z); }

/* ── hit boxes, from a position and a crouch amount (so rewound states can be tested too) ─────────────────────── */
function raySphere(o, d, c, r) { const oc = o.clone().sub(c), b = oc.dot(d), q = oc.lengthSq() - r * r, h = b * b - q; if (h < 0) return null; const t = -b - Math.sqrt(h); return t > 0 ? t : null; }
function rayCapsule(o, d, a, b, r) {
  const ab = b.clone().sub(a), ao = o.clone().sub(a), abab = ab.dot(ab), abd = ab.dot(d), abao = ab.dot(ao), den = abab - abd * abd;
  let t = den > 1e-8 ? (abd * abao - abab * d.dot(ao)) / den : 0; if (t < 0) t = 0;
  for (let k = 0; k < 2; k++) { const p = o.clone().addScaledVector(d, t), u = clamp(ab.dot(p.clone().sub(a)) / abab, 0, 1), c = a.clone().addScaledVector(ab, u), h = raySphere(o, d, c, r); if (h != null) return h; t += r; }
  return null;
}
/* hit boxes that follow the body (2026-11-22), as CS poses its hit boxes from the same animation the players see: the
   Hunyuan 3D fighters share one skeleton (models.js fits them all to 1.78 m), so its joints are rebuilt here from what
   both ends know, the aim pitch, the crouch, the facing, the walk's direction and its phase, with models.js's own pose
   rules: the chest leans 0.55 of the pitch about the spine, the head a further 0.45 about the neck, the hips drop 0.45 m
   in a crouch, each thigh swings 0.6 rad in the stride and the knees bend. Measured against the drawn bones (all ten
   fighters agree within 2 cm). pose: { pitch, ph (walk phase), sp (speed m/s), mv (walk direction from the facing),
   air (0..1, off the ground: the knees tuck up, 2026-11-22) } */
export const GAIT = 3.2;   // walk phase per metre walked (models.js steps one leg each half turn)
export const AIR = { thigh: .55, shin: 1.1 };   // the jump tuck, models.js poses the same
const BODY = { spine: 1.067, neck: 1.438, head: .222, hips: .89, thigh: .39, shin: .41, legX: .152 };
export function hitShapes(pos, duck, yaw, pose = {}) {
  const pitch = pose.pitch || 0, sp = pose.sp || 0, k = Math.min(1, sp / 4.5);
  let mv = pose.mv || 0, dir = 1; if (Math.abs(mv) > Math.PI / 2) { mv -= Math.sign(mv) * Math.PI; dir = -1; }
  const ph = (pose.ph || 0) * dir, legYaw = sp > .3 ? clamp(mv, -1.05, 1.05) * Math.min(1, sp / 1.5) : 0;
  const drop = duck * .45 + Math.abs(Math.sin(ph)) * .025 * k, lean = pitch * .55, cy = Math.cos(yaw ?? 0), sy = Math.sin(yaw ?? 0);
  const W = (x, y, z) => new THREE.Vector3(pos.x + x * cy + z * sy, pos.y + y, pos.z - x * sy + z * cy);   // the body's frame (forward -Z) to the world
  const lc = Math.cos(lean), ls = Math.sin(lean), pv = BODY.spine - drop;
  const upL = (x, y, z) => { const r = y - pv; return r <= 0 ? [x, y, z] : [x, pv + r * lc - z * ls, r * ls + z * lc]; };   // leant with the chest
  const up = (x, y, z) => W(...upL(x, y, z));
  const out = [];
  // the head: the neck leans with the chest, the head turns the rest of the pitch about the neck
  const [, ny, nz] = upL(0, BODY.neck - drop, 0), ha = lean + pitch * .45;
  out.push({ part: "head", a: W(0, ny + BODY.head * Math.cos(ha), nz + BODY.head * Math.sin(ha)), r: .13 });
  // the torso in two: the chest, and the stomach below it, which CS hurts a quarter more (2026-11-14)
  out.push({ part: "body", a: up(0, 1.14 - drop, 0), b: up(0, 1.42 - drop, 0), r: .24 });
  out.push({ part: "stomach", a: up(0, .95 - drop, 0), b: up(0, 1.14 - drop, 0), r: .23 });
  // the arms (2026-11-14): CS's arm hit zone, from each shoulder to the hands on the gun, which rides the chest
  if (yaw != null) { out.push({ part: "arm", a: up(.17, 1.40 - drop, 0), b: up(.1, 1.25 - drop, -.2), r: .065 }); out.push({ part: "arm", a: up(-.17, 1.40 - drop, 0), b: up(.07, 1.26 - drop, -.56), r: .065 }); }
  // the legs: each a thigh and a shin, swung by the stride, bent by the crouch, turned with the hips toward the walk
  const hy = BODY.hips - drop, cl = Math.cos(legYaw), sl = Math.sin(legYaw), sw = Math.sin(ph) * .6 * k;
  const L = (x, y, z) => W(x * cl + z * sl, y, -x * sl + z * cl);
  for (const [x, sgn, off] of [[BODY.legX, 1, 0], [-BODY.legX, -1, Math.PI]]) {
    const air = pose.air || 0, a1 = sgn * sw * (1 - air * .7) + duck * 1.15 + air * AIR.thigh, a2 = a1 - (Math.max(0, Math.sin(ph + 1.2 + off)) * .9 * k * (1 - air * .7) + duck * 2.2 + air * AIR.shin);
    const ky = hy - BODY.thigh * Math.cos(a1), kz = -BODY.thigh * Math.sin(a1), fy = Math.max(.05, ky - BODY.shin * Math.cos(a2)), fz = kz - BODY.shin * Math.sin(a2);
    out.push({ part: "leg", a: L(x, hy, 0), b: L(x, ky, kz), r: .1 }); out.push({ part: "leg", a: L(x, ky, kz), b: L(x, fy, fz), r: .08 });
  }
  return out;
}
export function hitBox(pos, duck, o, d, yaw = null, pose = {}) {
  let best = null;
  for (const h of hitShapes(pos, duck, yaw, pose)) { const t = h.b ? rayCapsule(o, d, h.a, h.b, h.r) : raySphere(o, d, h.a, h.r); if (t != null && (!best || t < best.t)) best = { t, part: h.part }; }
  return best;
}
