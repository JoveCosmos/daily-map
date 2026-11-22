/* effects: bullet holes, flying tracers, dust and blood puffs, muzzle flashes, sparks, brass (split out of game.js 2026-11-22) */
import * as THREE from "three";
import { scene, camera, TOUCH } from "./core.js";
import { AC, OUT } from "./audio.js";
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
function tracer(a, b, heavy = false) {
  const dist = a.distanceTo(b); if (dist < .3) return;
  const m = new THREE.Mesh(streakGeo, streakMat[heavy ? 1 : 0]); m.frustumCulled = false; m.renderOrder = 5;
  m.userData = { a: a.clone(), dir: b.clone().sub(a).normalize(), dist, t0: performance.now(), spd: heavy ? 1100 : 600, len: heavy ? 7 : 2.6, w: heavy ? .03 : .016 };
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
function decal(h, dir) { const d = new THREE.Mesh(decalGeo, decalMat); d.position.copy(h.point); const n = h.face.normal.clone(); if (n.dot(dir) > 0) n.negate(); d.position.addScaledVector(n, .005); d.lookAt(h.point.clone().add(n)); d.rotateZ(Math.random() * Math.PI * 2); scene.add(d); decals.push(d); if (decals.length > 40) scene.remove(decals.shift()); }
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
/* brass (2026-11-16): each round your gun fires throws its case out to the right; it tumbles, bounces once and lies a while */
const shells = [], shellGeo = new THREE.CylinderGeometry(.0055, .0055, .022, 6), shellMat = new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: .9, roughness: .35 });
function ejectShell() { if (!W) return; const m = shells.length >= 24 ? shells.shift() : new THREE.Mesh(shellGeo, shellMat);
  const p = camera.localToWorld(GUNPOS.clone().add(new THREE.Vector3(.025, .045, -.16))), r = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  m.position.copy(p); m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
  const ground = W.first(p, new THREE.Vector3(0, -1, 0), 4);
  m.userData = { v: r.multiplyScalar(1.4 + Math.random() * .6).addScaledVector(u, 1.2 + Math.random() * .5).add(new THREE.Vector3(me.vel.x, 0, me.vel.z)), spin: new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20),
    floor: ground ? ground.point.y + .006 : p.y - 1.6, bounced: false, age: 0 };
  if (!m.parent) scene.add(m); shells.push(m); }
function tickShells(dt) { for (let i = shells.length - 1; i >= 0; i--) { const m = shells[i], u = m.userData; u.age += dt;
  if (u.age > 6) { scene.remove(m); shells.splice(i, 1); continue; }
  if (u.rest) continue; u.v.y -= 9.8 * dt; m.position.addScaledVector(u.v, dt); m.rotation.x += u.spin.x * dt; m.rotation.y += u.spin.y * dt; m.rotation.z += u.spin.z * dt;
  if (m.position.y <= u.floor) { m.position.y = u.floor; if (!u.bounced && u.v.y < -1.2) { u.bounced = true; u.v.y *= -.32; u.v.x *= .5; u.v.z *= .5; u.spin.multiplyScalar(.5); brassTick(); }
    else { u.rest = true; m.rotation.x = Math.PI / 2; } } } }
/* a case landing: a short, quiet metallic tick, soft enough for an automatic's rain of them */
function brassTick() { if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain(); o.type = "triangle"; o.frequency.value = 5200 + Math.random() * 1400; g.gain.setValueAtTime(.035, t); g.gain.exponentialRampToValueAtTime(.0005, t + .06); o.connect(g).connect(OUT); o.start(t); o.stop(t + .07); }
/* the muzzle lights its surroundings for a frame or two (desktop only: a phone keeps its frame rate) */
const muzzleLight = TOUCH ? null : new THREE.PointLight(0xffb45a, 0, 7, 2); if (muzzleLight) scene.add(muzzleLight);
function tickParts(dt) { for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i], u = p.userData; u.age += dt; if (u.age > u.life) { scene.remove(p); p.material.dispose(); parts.splice(i, 1); continue; }
  if (u.spark) { u.v.y -= 9.8 * dt; p.position.addScaledVector(u.v, dt); p.material.opacity = 1 - u.age / u.life; continue; }
  if (!u.flash) { u.v.y -= 2.5 * dt; p.position.addScaledVector(u.v, dt); p.material.opacity = .8 * (1 - u.age / u.life); p.scale.multiplyScalar(1 + dt * 1.5); } } }
export { tracers, decals, holeTex, decalGeo, decalMat, streaks, streakGeo, streakTex, streakMat, tracer, tracerHeavy, _sx, _sy, _sz, _sm, flyStreaks, decal, parts, dotTex, puff, flashAt, sparkN, sparks, shells, shellGeo, shellMat, ejectShell, tickShells, brassTick, muzzleLight, tickParts };
