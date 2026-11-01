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
export const SPRAY = [[0,0],[0,.45],[.1,1.15],[.2,2.05],[.1,3.0],[-.2,3.9],[-.45,4.7],[-.1,5.35],[.55,5.85],[1.4,6.15],[2.1,6.3],[1.8,6.45],
  [.6,6.55],[-.8,6.6],[-1.9,6.7],[-2.6,6.85],[-2.2,6.95],[-.9,7.05],[.6,7.1],[1.8,7.2],[2.6,7.25],[2.2,7.3],[1.0,7.35],[-.6,7.4],
  [-1.9,7.45],[-2.7,7.55],[-2.3,7.6],[-.9,7.65],[.6,7.7],[1.9,7.75]];
/* the weapons, after CS:GO's numbers: speed in Source units a second, damage after armour, inaccuracy in degrees
   (base standing/crouched, added at full run, added in the air), zoom as field-of-view multipliers per level */
const SPRAY_M4 = SPRAY.map(([x, y]) => [-x * .72, y * .82]), SPRAY_AUG = SPRAY.map(([x, y]) => [x * .6, y * .7]);
export const WEAPONS = {
  knife: { name: "Knife", slot: "k", melee: true, range: 1.7, rate: .4, speed: 250, deploy: .4, dmg: { head: 55, body: 40, leg: 30 } },
  ak:  { name: "AK-47", slot: "p", rate: .1, mag: 30, res: 90, speed: 215, deploy: .9, reload: 2.0, spray: SPRAY, base: [.38, .22], move: 5.5, air: 9, dmg: { head: 111, body: 28, leg: 27 } },
  m4:  { name: "M4A1", slot: "p", rate: .09, mag: 30, res: 90, speed: 225, deploy: .9, reload: 2.2, spray: SPRAY_M4, base: [.32, .2], move: 5, air: 9, dmg: { head: 92, body: 23, leg: 25 } },
  aug: { name: "AUG", slot: "p", rate: .09, mag: 30, res: 90, speed: 220, deploy: .9, reload: 2.4, spray: SPRAY_AUG, base: [.4, .25], scoped: .12, zoom: [1, .5], zoomSpeed: 150, move: 5, air: 9, dmg: { head: 109, body: 27, leg: 26 } },
  awp: { name: "AWP", slot: "p", rate: 1.46, mag: 10, res: 30, speed: 200, deploy: 1.15, reload: 2.6, base: [8, 8], scoped: .05, zoom: [1, .27, .11], zoomSpeed: 100, move: 12, air: 18, unzoom: true, kick: 2.2, dmg: { head: 448, body: 112, leg: 85 } }
};
export const WIDS = Object.keys(WEAPONS);                     // index <-> id on the wire
export const DMG = WEAPONS.ak.dmg, FIRE_INTERVAL = .1, RELOAD = 2.43, MAG = 30, RESERVE = 90;
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

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
           w: "ak", prim: "ak", last: "knife", zoom: 0, deployUntil: 0, zoomHeld: false };
}
export const wpn = s => WEAPONS[s.w] || WEAPONS.knife;
/* a fresh primary in hand (spawn, pickup): its own full ammunition unless given */
export function equip(s, id, mag, res) { s.prim = id; s.mag = mag ?? WEAPONS[id].mag; s.res = res ?? WEAPONS[id].res; s.last = s.w === id ? s.last : s.w; s.w = id; s.zoom = 0; s.reloadAt = 0; s.spray = 0; }
export const height = s => C.stand + (C.crouch - C.stand) * s.duck;
export const eye = s => C.eyeStand + (C.eyeCrouch - C.eyeStand) * s.duck;
export function copyPlayer(dst, src) {
  dst.pos.copy(src.pos); dst.vel.copy(src.vel);
  for (const k of ["yaw", "pitch", "duck", "onGround", "jumpHeld", "hp", "alive", "mag", "res", "reloadAt", "nextShot", "spray", "lastShot", "punchX", "punchY", "w", "prim", "last", "zoom", "deployUntil", "zoomHeld"]) dst[k] = src[k];
  return dst;
}
/* a command: { f, s (-1..1), jump, duck, walk, fire, reload, yaw, pitch, seq, vt (the view time it was aimed in) } */
export function move(w, s, cmd, dt = DT) {
  s.yaw = cmd.yaw; s.pitch = cmd.pitch;
  if (!s.alive) return;
  if (cmd.duck && s.duck < 1) s.duck = Math.min(1, s.duck + dt / .12);
  else if (!cmd.duck && s.duck > 0) { const o = s.pos.clone(); o.y += height(s); if (!w.first(o, UP, C.stand - height(s) + .02)) s.duck = Math.max(0, s.duck - dt / .12); }
  const fw = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw)), rt = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
  const wd = fw.multiplyScalar(cmd.f).add(rt.multiplyScalar(cmd.s)), has = wd.lengthSq() > 0; if (has) wd.normalize();
  const W0 = wpn(s), spd = (s.zoom && W0.zoomSpeed ? W0.zoomSpeed : W0.speed) * U;
  let ws = has ? spd : 0; if (s.duck > .5) ws *= C.duck; else if (cmd.walk) ws *= C.walk;
  const jumpNow = cmd.jump && !s.jumpHeld; s.jumpHeld = !!cmd.jump;
  if (s.onGround) {
    if (jumpNow) { s.vel.y = C.jump; s.onGround = false; }
    else {
      const sp = Math.hypot(s.vel.x, s.vel.z);
      if (sp < .01) { s.vel.x = s.vel.z = 0; } else { const k = Math.max(sp - Math.max(sp, C.stopspeed) * C.friction * dt, 0) / sp; s.vel.x *= k; s.vel.z *= k; }
      const cur = s.vel.x * wd.x + s.vel.z * wd.z, add = ws - cur; if (add > 0) { const acc = Math.min(C.accel * dt * ws, add); s.vel.x += acc * wd.x; s.vel.z += acc * wd.z; }
    }
  }
  if (!s.onGround) { const cur = s.vel.x * wd.x + s.vel.z * wd.z, add = Math.min(ws, C.aircap) - cur; if (add > 0) { const acc = Math.min(C.airaccel * ws * dt, add); s.vel.x += acc * wd.x; s.vel.z += acc * wd.z; } }
  s.vel.y -= C.gravity * dt;
  const was = s.onGround, prev = s.pos.clone();
  s.pos.addScaledVector(s.vel, dt);
  { const o = s.pos.clone(); o.y += .5; if (!w.first(o, DOWN, 6.5)) { s.pos.x = prev.x; s.pos.z = prev.z; s.vel.x = s.vel.z = 0; } }
  const delta = w.collide(s.pos, C.radius, height(s));
  s.onGround = delta.y > Math.abs(dt * s.vel.y * .25) && delta.y > 0;
  const off = Math.max(0, delta.length() - 1e-5); if (off > 0) { const n = delta.clone().normalize(); s.pos.addScaledVector(n, off); const vn = s.vel.dot(n); if (vn < 0) s.vel.addScaledVector(n, -vn); }
  if (s.onGround && s.vel.y < 0) s.vel.y = 0;
  if (was && !s.onGround && s.vel.y <= 0) { const o = s.pos.clone(); o.y += .3; const g = w.first(o, DOWN, .62); if (g && Math.abs(g.face.normal.y) > .7) { s.pos.y = g.point.y; s.vel.y = 0; s.onGround = true; } }
}
export function inaccuracy(s) {
  const W0 = wpn(s); if (W0.melee) return 0;
  const sp = Math.hypot(s.vel.x, s.vel.z), wmax = W0.speed * U;
  let a = s.zoom && W0.scoped != null ? W0.scoped : W0.base[s.duck > .5 ? 1 : 0];
  a += clamp((sp - .34 * wmax) / (.66 * wmax), 0, 1) * W0.move; if (!s.onGround) a += W0.air;
  return a * DEG;
}
/* one command of the weapon at time t: switching, zoom, reload, firing. Returns a shot { dir, melee } or null; the
   client predicts with this and the server decides with it, so ammo, zoom and the spread agree on both ends */
export function weapon(s, cmd, t, seed) {
  // switching: 1 = primary, 3 = knife, Q = the last one; a fresh draw cannot fire until it is up
  let want = cmd.slot === "p" ? s.prim : cmd.slot === "k" ? "knife" : cmd.slot === "q" ? s.last : null;
  if (want && want !== s.w && WEAPONS[want] && (want === "knife" || want === s.prim)) { s.last = s.w; s.w = want; s.zoom = 0; s.reloadAt = 0; s.deployUntil = t + WEAPONS[want].deploy; }
  const W0 = wpn(s);
  if (s.reloadAt && t >= s.reloadAt) { const n = Math.min(W0.mag - s.mag, s.res); s.mag += n; s.res -= n; s.reloadAt = 0; }
  if (t - s.lastShot > (W0.rate || .1)) { s.spray = Math.max(0, s.spray - DT * 30 / .42); const k = Math.exp(-DT * 9); s.punchX *= k; s.punchY *= k; }
  if (!s.alive) return null;
  // zoom: each right click steps to the next level, round to none
  const zp = !!cmd.zoom && !s.zoomHeld; s.zoomHeld = !!cmd.zoom;
  if (zp && W0.zoom && !s.reloadAt) s.zoom = (s.zoom + 1) % W0.zoom.length;
  if (W0.melee) {
    if (!cmd.fire || t < s.nextShot - 1e-6 || t < s.deployUntil) return null;
    s.nextShot = t + W0.rate; s.lastShot = t;
    return { melee: true, dir: new THREE.Vector3(-Math.sin(s.yaw) * Math.cos(s.pitch), Math.sin(s.pitch), -Math.cos(s.yaw) * Math.cos(s.pitch)) };
  }
  if (cmd.reload && !s.reloadAt && s.mag < W0.mag && s.res > 0) { s.reloadAt = t + W0.reload; s.zoom = 0; }
  if (!cmd.fire || s.reloadAt || t < s.nextShot - 1e-6 || t < s.deployUntil) return null;
  if (s.mag <= 0) { if (s.res > 0) { s.reloadAt = t + W0.reload; s.zoom = 0; } return null; }
  s.mag--; s.nextShot = t + W0.rate; s.lastShot = t;
  const cone = inaccuracy(s);
  if (W0.spray) { const sp = W0.spray[Math.min(Math.floor(s.spray), W0.spray.length - 1)]; s.spray = Math.min(s.spray + 1, W0.spray.length - 1); s.punchX = sp[0] * DEG; s.punchY = sp[1] * DEG; }
  else { s.punchX = 0; s.punchY = (W0.kick || 0) * DEG; }
  const R = rng(seed), r = Math.sqrt(R()) * cone, th = R() * Math.PI * 2, aimX = W0.spray ? s.punchX : 0, aimY = W0.spray ? s.punchY : 0;
  const yaw = s.yaw - (aimX + r * Math.cos(th)), pitch = s.pitch + (aimY + r * Math.sin(th));
  if (W0.unzoom) s.zoom = 0;
  return { dir: new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)) };
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
export function hitBox(pos, duck, o, d) {
  const k = (C.stand + (C.crouch - C.stand) * duck) / C.stand, y = pos.y, cands = [];
  const head = raySphere(o, d, new THREE.Vector3(pos.x, y + (C.eyeStand + (C.eyeCrouch - C.eyeStand) * duck) + .04, pos.z), .13); if (head != null) cands.push({ t: head, part: "head" });
  const ch = rayCapsule(o, d, new THREE.Vector3(pos.x, y + .95 * k, pos.z), new THREE.Vector3(pos.x, y + 1.45 * k, pos.z), .24); if (ch != null) cands.push({ t: ch, part: "body" });
  const lg = rayCapsule(o, d, new THREE.Vector3(pos.x, y + .15, pos.z), new THREE.Vector3(pos.x, y + .9 * k, pos.z), .17); if (lg != null) cands.push({ t: lg, part: "leg" });
  if (!cands.length) return null; cands.sort((a, b) => a.t - b.t); return cands[0];
}
