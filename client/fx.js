/* effects: bullet holes, flying tracers, dust and blood puffs, muzzle flashes, sparks, brass (split out of game.js 2026-11-22) */
import * as THREE from "three";
import { scene, camera, TOUCH } from "./core.js";
import { AC, at, dest } from "./audio.js";
import { W, GUNPOS, me } from "../game.js";
/* ── effects ─────────────────────────────────────────────────────────────────── */
const tracers = [], decals = [];
/* a bullet hole (2026-11-16): a dark scorched core in a rough ring of chipped surface, drawn once, not a flat disc */
const holeTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
  for (let i = 0; i < 26; i++) { const a = Math.random() * Math.PI * 2, r = 10 + Math.random() * 16; g.fillStyle = `rgba(40,32,24,${.1 + Math.random() * .25})`; g.beginPath(); g.arc(32 + Math.cos(a) * r * .6, 32 + Math.sin(a) * r * .6, 2 + Math.random() * 5, 0, 7); g.fill(); }
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 20); gr.addColorStop(0, "rgba(8,6,5,1)"); gr.addColorStop(.35, "rgba(20,15,11,.95)"); gr.addColorStop(.6, "rgba(70,55,40,.45)"); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, 20, 0, 7); g.fill(); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
const decalGeo = new THREE.PlaneGeometry(.085, .085), decalMat = new THREE.MeshBasicMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
/* tracers (2026-11-22): a glowing streak that flies down the bullet's path, a hot head and a tail that fades, turned to face
   the eye and never thinner than about a pixel, in place of the first version's one-pixel line shown for 50 ms. The AWP's is
   longer, faster and white, with its smoke trail and a faint line along the whole shot */
const streaks = [], streakGeo = new THREE.PlaneGeometry(1, 1).translate(-.5, 0, 0);   // the head at the origin, the tail along -X
const streakTex = (() => { const c = document.createElement("canvas"); c.width = 128; c.height = 16; const g = c.getContext("2d");
  const h = g.createLinearGradient(0, 0, 128, 0); h.addColorStop(0, "rgba(255,255,255,0)"); h.addColorStop(.7, "rgba(255,255,255,.55)"); h.addColorStop(1, "rgba(255,255,255,1)");
  g.fillStyle = h; g.fillRect(0, 0, 128, 16); g.globalCompositeOperation = "destination-in";
  const v = g.createLinearGradient(0, 0, 0, 16); v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(.5, "rgba(0,0,0,1)"); v.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = v; g.fillRect(0, 0, 128, 16);
  return new THREE.CanvasTexture(c); })();
const streakMat = [0xffc46a, 0xfff4dc].map(color => { const m = new THREE.MeshBasicMaterial({ map: streakTex, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false }); m.userData.shared = true; return m; });
/* by calibre (2026-11-24): a pistol's slower, shorter and finer, a shotgun's pellets finest, the SSG 08's long and quick */
const TRACE = { p: { spd: 380, len: 1.5, w: .012 }, r: { spd: 600, len: 2.6, w: .016 }, s: { spd: 800, len: 4, w: .02 }, awp: { spd: 1100, len: 7, w: .03 }, g: { spd: 420, len: 1.1, w: .01 } };
function kindOf(w) { if (w === true || w === "awp") return "awp"; const k = CAL[w] || "r556"; return k === "g12" ? "g" : k === "r308" ? "s" : k[0] === "p" ? "p" : "r"; }
function tracer(a, b, gun) {   // gun: the weapon's id
  const dist = a.distanceTo(b); if (dist < .3) return;
  const T = TRACE[kindOf(gun)], heavy = T === TRACE.awp;
  const m = new THREE.Mesh(streakGeo, streakMat[heavy ? 1 : 0]); m.frustumCulled = false; m.renderOrder = 5;
  m.userData = { a: a.clone(), dir: b.clone().sub(a).normalize(), dist, t0: performance.now(), spd: T.spd, len: T.len, w: T.w };
  scene.add(m); streaks.push(m); if (streaks.length > 48) { const o = streaks.shift(); scene.remove(o); }
  if (heavy) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), tracerHeavy); l.userData.t = performance.now() + 220; scene.add(l); tracers.push(l); }
  if (heavy) { const n = Math.min(26, Math.max(6, a.distanceTo(b) / 1.2 | 0)); for (let i = 1; i <= n; i++) { const p = a.clone().lerp(b, i / (n + 1)); puff(p, 0xd8d4cc, 1, .16, .05); } } }
const tracerHeavy = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95 }); tracerHeavy.userData.shared = true;
const _sx = new THREE.Vector3(), _sy = new THREE.Vector3(), _sz = new THREE.Vector3(), _sm = new THREE.Matrix4();
function flyStreaks(pn) {
  for (let i = streaks.length - 1; i >= 0; i--) {
    const m = streaks[i], u = m.userData, d = (pn - u.t0) / 1000 * u.spd;
    if (d - u.len >= u.dist) { scene.remove(m); streaks.splice(i, 1); continue; }
    const head = Math.min(d, u.dist), tail = Math.max(0, d - u.len);
    m.position.copy(u.a).addScaledVector(u.dir, head);
    // along the path, its face turned to the eye; wider with distance so a far one stays about a pixel and a half
    _sz.copy(camera.position).sub(m.position); const far = _sz.length(); _sz.addScaledVector(u.dir, -u.dir.dot(_sz)).normalize();
    _sx.copy(u.dir); _sy.crossVectors(_sz, _sx); _sm.makeBasis(_sx, _sy, _sz); m.quaternion.setFromRotationMatrix(_sm);
    m.scale.set(Math.max(.01, head - tail), Math.max(u.w, far * .0016), 1);
  }
}
/* what a bullet does where it strikes, by calibre: the hole's size, the dust and the sparks */
const HIT = { p: [.8, 5, .09, 4], r: [1, 6, .1, 5], s: [1.25, 10, .15, 8], awp: [1.5, 14, .18, 10], g: [.55, 3, .07, 2] };
function impact(h, dir, gun) { const [hs, pn, ps, sn] = HIT[kindOf(gun)]; decal(h, dir, hs); puff(h.point, 0xb8a888, pn, ps); const nrm = h.face.normal.clone(); if (nrm.dot(dir) > 0) nrm.negate(); sparks(h.point, nrm, sn); }
function decal(h, dir, s = 1) { const d = new THREE.Mesh(decalGeo, decalMat); d.scale.setScalar(s); d.position.copy(h.point); const n = h.face.normal.clone(); if (n.dot(dir) > 0) n.negate(); d.position.addScaledVector(n, .005); d.lookAt(h.point.clone().add(n)); d.rotateZ(Math.random() * Math.PI * 2); scene.add(d); decals.push(d); if (decals.length > 40) scene.remove(decals.shift()); }
/* small effects: dust and blood puffs, other players' muzzle flashes */
const parts = [], dotTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 32; const g = c.getContext("2d"), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();
function puff(pos, color, n = 7, size = .12, up = 1) {
  for (let i = 0; i < n && parts.length < 160; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color, transparent: true, depthWrite: false, opacity: .8 })); sp.position.copy(pos); sp.scale.setScalar(size * (.6 + Math.random() * .8));
    sp.userData = { v: new THREE.Vector3((Math.random() - .5) * 1.6, Math.random() * 1.4 * up, (Math.random() - .5) * 1.6), life: .45 + Math.random() * .3, age: 0 }; scene.add(sp); parts.push(sp); }
}
function flashAt(pos) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xffc070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sp.position.copy(pos); sp.scale.setScalar(.35); sp.userData = { v: new THREE.Vector3(), life: .05, age: 0, flash: true }; scene.add(sp); parts.push(sp); }
/* sparks where a bullet strikes (2026-11-16): hot points thrown off the surface, falling fast and burning out */
let sparkN = 0;
function sparks(pos, normal, n = 6) { sparkN += n; for (let i = 0; i < n && parts.length < 200; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xffd38a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sp.position.copy(pos); sp.scale.setScalar(.025 + Math.random() * .02);
  const v = normal.clone().multiplyScalar(2 + Math.random() * 3).add(new THREE.Vector3((Math.random() - .5) * 3, Math.random() * 2.2, (Math.random() - .5) * 3));
  sp.userData = { v, life: .12 + Math.random() * .16, age: 0, spark: true }; scene.add(sp); parts.push(sp); } }
/* empty cases by calibre (2026-11-24; one shared brass case before): each gun throws its own round's case (9 mm, .45,
   5.7 mm, .50, 5.56, the AK's 7.62 in lacquered steel, .308, the AWP's .338, a shotgun's red hull on a brass head),
   harder from a rifle than from a pistol, and each lands with its own sound. A bolt or pump gun throws it when the bolt
   or the pump works (AWP and SSG 08 as the bolt comes back, the Nova on its pump), the rest at the shot; other players'
   guns throw theirs too. One instanced mesh a kind: a firefight's rain of brass costs a few draw calls, not one a case */
const CASES = { p9: { r: .0049, l: .019, tick: 6200 }, p45: { r: .006, l: .023, tick: 5600 }, p57: { r: .004, l: .028, tick: 6600, neck: 1 },
  p50: { r: .0068, l: .033, tick: 4800, v: .9 }, r556: { r: .0048, l: .045, tick: 5200, v: 1.25, neck: 1 }, r762: { r: .0057, l: .039, tick: 4300, v: 1.25, neck: 1, steel: 1 },
  r308: { r: .006, l: .051, tick: 4500, v: .55, neck: 1 }, r338: { r: .0074, l: .069, tick: 3900, v: .5, neck: 1 }, g12: { r: .0105, l: .065, v: .9, hull: 1 } };
const CAL = { glock: "p9", p250: "p9", tec9: "p9", cz75: "p9", mp9: "p9", usp: "p45", ump: "p45", mac10: "p45", fiveseven: "p57", p90: "p57", mp7: "p57", deagle: "p50",
  ak: "r762", m4: "r556", m4a1s: "r556", famas: "r556", galil: "r556", aug: "r556", sg553: "r556", negev: "r556", ssg08: "r308", awp: "r338", nova: "g12", xm1014: "g12" };
const CYCLE = { awp: .42, ssg08: .42, nova: .3 }, PISTOL = new Set(["glock", "usp", "deagle", "p250", "fiveseven", "tec9", "cz75"]);   // seconds from the shot to the bolt or pump
const shells = [], CASEMAX = TOUCH ? 16 : 40, caseMesh = {};
for (const [k, C] of Object.entries(CASES)) {
  let g = new THREE.CylinderGeometry(C.neck ? C.r * .78 : C.r, C.r, C.l, 6, C.hull ? 4 : 1), mat;
  if (C.hull) {   // red plastic over the bottom quarter's brass head, each triangle one colour so the line stays sharp
    g = g.toNonIndexed(); const P = g.attributes.position, col = new Float32Array(P.count * 3), red = new THREE.Color(0xb3262a), brass = new THREE.Color(0xc8a050);
    for (let i = 0; i < P.count; i += 3) { const y = (P.getY(i) + P.getY(i + 1) + P.getY(i + 2)) / 3; for (let j = 0; j < 3; j++) (y < -C.l / 4 ? brass : red).toArray(col, (i + j) * 3); }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3)); mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: .25, roughness: .55 });
  } else mat = new THREE.MeshStandardMaterial({ color: C.steel ? 0x5f6152 : 0xc8a050, metalness: C.steel ? .55 : .9, roughness: C.steel ? .55 : .35 });
  const m = new THREE.InstancedMesh(g, mat, CASEMAX); m.count = 0; m.frustumCulled = false; caseMesh[k] = m; scene.add(m);
}
function addCase(k, p, v, own) { if (shells.length >= CASEMAX) { const i = shells.findIndex(u => !u.own); shells.splice(i >= 0 ? i : 0, 1); }   // full: others' oldest goes first, yours stay
  const ground = W.first(p, new THREE.Vector3(0, -1, 0), 4);
  shells.push({ k, own, p: p.clone(), v, r: new THREE.Euler(Math.random() * 3, Math.random() * 3, 0), spin: new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20),
    floor: ground ? ground.point.y + CASES[k].r : p.y - 1.6, bounced: false, rest: false, age: 0 }); }
/* yours: out of the port on the right of the gun in your hands, with your own speed added */
function ejectShell(w = me.w) { const k = CAL[w]; if (!W || !k) return;
  const go = () => { if (me.w !== w || !me.alive) return;   // switched away before the bolt or pump: no case (CS chambers the round on the draw)
    const s = CASES[k].v || 1, p = camera.localToWorld(GUNPOS.clone().add(new THREE.Vector3(.025, .045, PISTOL.has(w) ? -.1 : -.16))), r = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    addCase(k, p, r.multiplyScalar((1.4 + Math.random() * .6) * s).addScaledVector(u, (1.2 + Math.random() * .5) * s).add(new THREE.Vector3(me.vel.x, 0, me.vel.z)), true); };
  if (CYCLE[w]) setTimeout(go, CYCLE[w] * 1000); else go(); }
/* someone else's: from their gun, below and right of the eye the shot left from; a shotgun's pellets throw one hull */
const lastCase = new Map();
function ejectOther(id, w, a, b, vel) { const k = CAL[w], now = performance.now(); if (!W || !k || a.distanceTo(camera.position) > 25 || now - (lastCase.get(id) || 0) < 40) return; lastCase.set(id, now);
  const go = () => { const d = b.clone().sub(a).setY(0).normalize(), right = new THREE.Vector3(-d.z, 0, d.x), s = CASES[k].v || 1, p = a.clone().addScaledVector(d, .3).addScaledVector(right, .1); p.y -= .2;
    addCase(k, p, right.multiplyScalar((1.4 + Math.random() * .6) * s).add(new THREE.Vector3(0, (1.2 + Math.random() * .5) * s, 0)).add(vel || new THREE.Vector3()), false); };
  if (CYCLE[w]) setTimeout(go, CYCLE[w] * 1000); else go(); }
const _cm = new THREE.Matrix4(), _cq = new THREE.Quaternion(), _c1 = new THREE.Vector3(1, 1, 1), _cn = {}, _cu = new THREE.Vector3(), _cd = new THREE.Vector3(0, -1, 0);
function tickShells(dt) {
  for (let i = shells.length - 1; i >= 0; i--) { const u = shells[i]; u.age += dt;
    if (u.age > 6) { shells.splice(i, 1); continue; }
    if (u.rest) continue; u.v.y -= 9.8 * dt; u.p.addScaledVector(u.v, dt); u.r.x += u.spin.x * dt; u.r.y += u.spin.y * dt; u.r.z += u.spin.z * dt;
    if ((u.fl = (u.fl || 0) - dt) <= 0) { u.fl = .08; const g = W && W.first(_cu.set(u.p.x, u.p.y + .3, u.p.z), _cd, 4); if (g) u.floor = g.point.y + CASES[u.k].r; }   // the floor under it now, not under the gun: generated ground is uneven
    if (u.p.y <= u.floor) { u.p.y = u.floor; if (!u.bounced && u.v.y < -1.2) { u.bounced = true; u.v.y *= -.32; u.v.x *= .5; u.v.z *= .5; u.spin.multiplyScalar(.5); landSound(u); }
      else { u.rest = true; u.r.x = Math.PI / 2; } } }
  for (const k in caseMesh) _cn[k] = 0;
  for (const u of shells) { _cm.compose(u.p, _cq.setFromEuler(u.r), _c1); caseMesh[u.k].setMatrixAt(_cn[u.k]++, _cm); }
  for (const k in caseMesh) { const m = caseMesh[k]; if (m.count || _cn[k]) { m.count = _cn[k]; m.instanceMatrix.needsUpdate = true; } m.visible = m.count > 0; } }   // an empty kind draws nothing
/* a case landing, from where it lands: brass a short bright tick pitched by its size, the AK's steel duller, a shotgun's
   plastic hull a soft tock; quiet enough for an automatic's rain of them, unheard beyond 10 m */
function landSound(u) { const d = u.p.distanceTo(camera.position); if (!AC || d > 10) return; at(u.p, () => brassTick(CASES[u.k], (u.own ? 1 : .7) * (1 - d / 10))); }
function brassTick(C = CASES.r556, vol = 1) { if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain();
  if (C.hull) { o.type = "sine"; o.frequency.value = 700 + Math.random() * 300; g.gain.setValueAtTime(.05 * vol, t); g.gain.exponentialRampToValueAtTime(.0005, t + .045); }
  else { o.type = "triangle"; o.frequency.value = C.tick - (C.steel ? 300 : 0) + Math.random() * 1200; g.gain.setValueAtTime(.035 * vol, t); g.gain.exponentialRampToValueAtTime(.0005, t + (C.steel ? .045 : .06)); }
  o.connect(g).connect(dest()); o.start(t); o.stop(t + .07); }
/* the muzzle lights its surroundings for a frame or two (desktop only: a phone keeps its frame rate) */
const muzzleLight = TOUCH ? null : new THREE.PointLight(0xffb45a, 0, 7, 2); if (muzzleLight) scene.add(muzzleLight);
function tickParts(dt) { for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i], u = p.userData; u.age += dt; if (u.age > u.life) { scene.remove(p); p.material.dispose(); parts.splice(i, 1); continue; }
  if (u.spark) { u.v.y -= 9.8 * dt; p.position.addScaledVector(u.v, dt); p.material.opacity = 1 - u.age / u.life; continue; }
  if (!u.flash) { u.v.y -= 2.5 * dt; p.position.addScaledVector(u.v, dt); p.material.opacity = .8 * (1 - u.age / u.life); p.scale.multiplyScalar(1 + dt * 1.5); } } }
export { tracers, decals, holeTex, decalGeo, decalMat, streaks, streakGeo, streakTex, streakMat, tracer, tracerHeavy, _sx, _sy, _sz, _sm, flyStreaks, decal, parts, dotTex, puff, flashAt, sparkN, sparks, shells, CASES, CAL, caseMesh, impact, ejectShell, ejectOther, tickShells, brassTick, muzzleLight, tickParts };
