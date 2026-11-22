/* grenades, smoke and fire as the server reports them, their sounds, footsteps, and the hit-direction arc (split out of game.js 2026-11-22) */
import * as THREE from "three";
import { dotTex } from "./fx.js";
import { NADE, NADES, clamp } from "../sim.js";
import { scene, nowS, $, camera } from "./core.js";
import { gunModel } from "../models.js";
import { AC, dest, CLIPS, playClip } from "./audio.js";
import { others, me } from "../game.js";
/* ── grenades, smoke and fire (2026-11-14): drawn from the server's lists in every update ───────────────────────── */
let blindLeft = 0; const setBlind = v => { blindLeft = v; };   // seconds of flashbang blindness left
const FX = { ng: new Map(), sm: new Map(), fi: new Map() };
function makeSmoke(x, y, z) {
  const g = new THREE.Group(); g.position.set(x, y, z);
  for (let i = 0; i < 36; i++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xbdbcb6, transparent: true, depthWrite: false, opacity: 0 }));
    const r = NADE.smokeR * .8 * Math.cbrt(Math.random()), th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    sp.position.set(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * .65, r * Math.sin(ph) * Math.sin(th)); sp.userData = { s: 2.8 + Math.random() * 1.6 }; g.add(sp); }
  scene.add(g); return { g, born: nowS(), left: NADE.smokeTime };
}
function makeFire(x, y, z) {
  const g = new THREE.Group(); g.position.set(x, y + .05, z);
  for (let i = 0; i < 24; i++) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: i % 3 ? 0xff7a1a : 0xffc04a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: .8 }));
    const r = NADE.fireR * Math.sqrt(Math.random()), th = Math.random() * Math.PI * 2; sp.position.set(r * Math.cos(th), .3 + Math.random() * .5, r * Math.sin(th)); sp.userData = { s: .7 + Math.random() * .7, y: sp.position.y }; g.add(sp); }
  scene.add(g); return { g, left: NADE.fireTime };
}
const dropFx = o => { scene.remove(o.g); o.g.traverse(c => { if (c.material && !c.material.userData.shared) c.material.dispose(); if (c.isMesh && c.geometry) c.geometry.dispose(); }); };
function syncFx(m) {
  const sync = (map, rows, make, upd) => { const seen = new Set();
    for (const r of rows || []) { let o = map.get(r[0]); if (!o) { o = make(r); map.set(r[0], o); } upd(o, r); seen.add(r[0]); }
    for (const [id, o] of map) if (!seen.has(id)) { dropFx(o); map.delete(id); } };
  sync(FX.ng, m.ng, r => { const g = gunModel(NADES[r[1]]); g.traverse(c => { c.castShadow = false; }); g.scale.setScalar(1.3); g.position.set(r[2], r[3], r[4]); scene.add(g); return { g, to: new THREE.Vector3(r[2], r[3], r[4]) }; }, (o, r) => o.to.set(r[2], r[3], r[4]));
  sync(FX.sm, m.sm, r => makeSmoke(r[1], r[2], r[3]), (o, r) => { o.left = r[4]; });
  sync(FX.fi, m.fi, r => makeFire(r[1], r[2], r[3]), (o, r) => { o.left = r[4]; });
}
function tickFx(dt) {
  for (const o of FX.ng.values()) { o.g.position.lerp(o.to, Math.min(1, dt * 18)); o.g.rotation.x += dt * 7; o.g.rotation.z += dt * 5; }
  for (const c of FX.sm.values()) { c.left -= dt; const grow = clamp((nowS() - c.born) / .9, .05, 1), fade = clamp(c.left / 2, 0, 1);
    for (const sp of c.g.children) { sp.scale.setScalar(sp.userData.s * grow); sp.material.opacity = .88 * fade; } }
  for (const f of FX.fi.values()) { f.left -= dt; const fade = clamp(f.left / 1, 0, 1);
    for (const sp of f.g.children) { const k = .75 + Math.random() * .5; sp.scale.setScalar(sp.userData.s * k); sp.position.y = sp.userData.y + Math.random() * .08; sp.material.opacity = (.55 + Math.random() * .35) * fade; } }
  blindLeft = Math.max(0, blindLeft - dt); $("flashw").style.opacity = blindLeft > 1.3 ? 1 : (blindLeft / 1.3).toFixed(3);
}
/* a point inside a live smoke cloud, as the server counts it, blocks a line of sight: no name tag through smoke */
const smokeBetween = (a, b) => { for (const c of FX.sm.values()) { const ab = b.clone().sub(a), u = clamp(c.g.position.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1); if (a.clone().addScaledVector(ab, u).distanceTo(c.g.position) < NADE.smokeR * .9) return true; } return false; };
/* grenade sounds: an HE's blast, a flashbang's crack and ring, a smoke's long hiss, fire catching */
function noiseHit(vol, secs, lp, decay = 2) { if (!AC || vol < .02) return; const t = AC.currentTime, n = AC.sampleRate * secs | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
  const src = AC.createBufferSource(); src.buffer = b; const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp; const g = AC.createGain(); g.gain.value = vol; src.connect(f).connect(g).connect(dest()); src.start(t); }
function boomSound(vol) { if (CLIPS.boom1) { playClip("boom" + (1 + Math.random() * 3 | 0), 1.3 * vol, .85 + Math.random() * .1); noiseHit(.5 * vol, 1.4, 260, 1.4); } else noiseHit(1.4 * vol, .9, 700, 2.2); if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(30, t + .6); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + .7); o.connect(g).connect(dest()); o.start(t); o.stop(t + .72); }
function flashSound(vol) { if (!playClip("pop", 1.2 * vol, 1.15)) noiseHit(1.1 * vol, .25, 6000, 3); }
const fxVol = p => clamp(1 - new THREE.Vector3(...p).distanceTo(camera.position) / 60, .05, 1);

/* footsteps: a dull thud every stride at running speed (walking and crouching are silent, as in CS), quieter far away */
function step(vol, heavy) { if (!AC || vol < .02) return;
  if (CLIPS.step1) { playClip("step" + (1 + Math.random() * 6 | 0), vol * (heavy ? 1.1 : .8), (heavy ? .82 : .92) + Math.random() * .16); if (heavy) playClip("step" + (1 + Math.random() * 6 | 0), vol * .6, .7); return; }   // recorded steps on stone (2026-11-16)
  const t = AC.currentTime, n = AC.sampleRate * .07 | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 4);
  const s = AC.createBufferSource(); s.buffer = b; const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 500 + Math.random() * 200; const g = AC.createGain(); g.gain.value = .45 * vol; s.connect(f).connect(g).connect(dest()); s.start(t); }
const stepVol = p => clamp(1 - p.distanceTo(camera.position) / 32, 0, 1);
/* where a hit came from: a red arc around the crosshair, pointing at the shooter */
function hurtFrom(id) { const o = others.get(id); if (!o) return; const d = o.model.g.position.clone().sub(me.pos), a = Math.atan2(-d.x, -d.z) - me.yaw;
  const el = $("dmgdir"); el.style.transform = `translate(-50%,-50%) rotate(${-a}rad)`; el.style.opacity = 1; clearTimeout(el._t); el._t = setTimeout(() => el.style.opacity = 0, 900); }
export { blindLeft, setBlind, FX, makeSmoke, makeFire, dropFx, syncFx, tickFx, smokeBetween, noiseHit, boomSound, flashSound, fxVol, step, stepVol, hurtFrom };
