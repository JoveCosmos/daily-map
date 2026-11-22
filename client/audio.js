/* sound: the audio graph, placed 3D sound, echo, recorded clips, every gun, reload, hit and bullet sound, damage numbers (split out of game.js 2026-11-22) */
import * as THREE from "three";
import { camera, TOUCH, nowS, $ } from "./core.js";
import { clamp, WEAPONS } from "../sim.js";
import { SET, W, noiseHit, others, me } from "../game.js";
/* ── sound ───────────────────────────────────────────────────────────────────── */
let AC = null, OUT = null, MG = null; function audio() { if (!AC) try { AC = new AudioContext(); OUT = AC.createBiquadFilter(); OUT.type = "lowpass"; OUT.frequency.value = 20000; MG = AC.createGain(); MG.gain.value = SET.vol / 100; OUT.connect(MG).connect(AC.destination); VERB = AC.createGain(); for (const k of ["open", "room"]) { const c = AC.createConvolver(); c.buffer = echoTail(k); ENV[k] = AC.createGain(); ENV[k].gain.value = k === "open" ? .55 : 0; VERB.connect(ENV[k]).connect(c).connect(OUT); } loadClips(); } catch (e) {} if (AC && AC.state === "suspended") AC.resume(); }
/* where a sound comes from: other players' shots and steps are panned left/right by their bearing and dulled when
   behind you, so you can hear where a fight or a footstep is. at(pos, fn) routes every sound fn makes through a
   panner + low-pass placed for pos; your own sounds stay centred */
/* 2026-11-16: placed in 3D (HRTF on a desktop, so in front, behind and above are heard; plain panning on a phone, which
   saves its battery), muffled when a wall stands between you and it, and sent to a short echo that grows with distance */
let SND = null, VERB = null; const dest = () => SND || OUT, ENV = { open: null, room: null, roomy: 0, next: 0 };
/* sound takes time to arrive (343 m/s: a shot 100 m off is heard 0.3 s after it is seen) and the air dulls its top end
   with distance (2026-11-16) */
/* a budget for placed sounds (2026-11-17): a fight with bots made dozens a second, each with its own HRTF panner (the
   costliest kind), a wall ray and nodes kept 4.5 s. Now HRTF only for near sounds (six at most), cheap stereo for the
   rest, far sounds dropped when many are playing, walls tested within 60 m, nodes freed when the sound is over */
const AT = { live: 0, hrtf: 0 };
function at(pos, fn) { if (!AC || !pos) return fn(); const rel = pos.clone().sub(camera.position), dist = rel.length() || 1;
  if (AT.live > 28 && dist > 25) return; rel.y = 0; const d = rel.length() || 1, y = camera.rotation.y;
  const right = (rel.x * Math.cos(y) - rel.z * Math.sin(y)) / d, ahead = (-rel.x * Math.sin(y) - rel.z * Math.cos(y)) / d;
  const pan = AC.createPanner(), lp = AC.createBiquadFilter(), wet = AC.createGain(), hrtf = !TOUCH && dist < 18 && AT.hrtf < 6; pan.panningModel = hrtf ? "HRTF" : "equalpower"; AT.live++; if (hrtf) AT.hrtf++; pan.distanceModel = "linear"; pan.rolloffFactor = 0;
  if (pan.positionX) { pan.positionX.value = right; pan.positionZ.value = -ahead; } else pan.setPosition(right, 0, -ahead);
  const walled = W && dist > 1.5 && dist < 60 && W.first(camera.position, pos.clone().sub(camera.position).normalize(), dist - .6);
  lp.type = "lowpass"; lp.frequency.value = Math.min(walled ? 1300 : ahead >= 0 ? 20000 : 20000 - 9000 * Math.min(1, -ahead), 20000 / (1 + dist / 30));
  wet.gain.value = clamp(dist / 70, .05, .4) * (walled ? 1.4 : 1); pan.connect(lp).connect(OUT); lp.connect(wet); if (VERB) wet.connect(VERB);
  const late = dist > 6 ? AC.createDelay(1) : null; if (late) { late.delayTime.value = Math.min(.99, dist / 343); late.connect(pan); }
  SND = late || pan; try { fn(); } finally { SND = null; } setTimeout(() => { AT.live--; if (hrtf) AT.hrtf--; try { if (late) late.disconnect(); pan.disconnect(); lp.disconnect(); wet.disconnect(); } catch (e) {} }, 3200 + (late ? dist / .343 : 0)); }
/* the surroundings (2026-11-16): nine rays from the listener (eight around, one up) say how enclosed it is, and the echo
   follows: a street or square answers a shot with a few late slaps off far walls, a room or corridor with a dense
   reverb. Probed a few times a second; the two tails cross-fade */
function probeEnv() { if (!AC || !W || !ENV.open) return; const now = AC.currentTime; if (now < ENV.next) return; ENV.next = now + .3;
  let near = 0, sum = 0; const o = camera.position, v = new THREE.Vector3();
  for (let k = 0; k < 8; k++) { v.set(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4)); const h = W.first(o, v, 30), dd = h ? h.distance : 30; sum += dd; if (dd < 8) near++; }
  const roof = W.first(o, v.set(0, 1, 0), 12), roomy = clamp(near / 8 * .7 + (roof ? .45 : 0) - sum / 8 / 60, 0, 1);
  ENV.roomy = roomy; ENV.room.gain.setTargetAtTime(roomy * .9, now, .4); ENV.open.gain.setTargetAtTime((1 - roomy) * .55, now, .4); }
/* the echo: stereo noise falling away over len seconds, with a few early reflections, as a street or yard answers a shot */
function echoTail(kind) { const room = kind === "room", len = room ? 1.3 : .9, n = AC.sampleRate * len | 0, b = AC.createBuffer(2, n, AC.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c);
    if (room) { for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.6) * .45;   // a room: dense, close reflections
      for (const [at0, g] of [[.011, .6], [.019, .5], [.029, .4], [.041, .3]]) { const i = (at0 + c * .003) * AC.sampleRate | 0; for (let k = 0; k < 30; k++) d[i + k] += (Math.random() * 2 - 1) * g * (1 - k / 30); } }
    else { for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 6) * .06;   // the open: little diffuse sound, but slaps off far walls
      for (const [at0, g] of [[.09, .32], [.17, .22], [.26, .15], [.41, .09]]) { const i = (at0 + c * .013) * AC.sampleRate | 0; for (let k = 0; k < 220; k++) d[i + k] += (Math.random() * 2 - 1) * g * Math.pow(1 - k / 220, 2); } } }
  return b; }
/* recorded sound (2026-11-16): real gunshots from The Free Firearm Sound Library and airsoft reloads, both CC0 (SOUNDS.md).
   Each class of gun has two near takes (your own and close shots) and two far ones (the range's echo kept); a shot picks one
   and varies its pitch a little, so an automatic never repeats itself. Until a clip is in, the synthesized sound plays */
const CLIPS = {}, CLIP_BASE = ["rifle_ak", "rifle_m4", "pistol_9", "pistol_45", "pistol_380", "smg_9", "smg_ppsh", "shotgun_nova", "shotgun_cd", "sniper_3006", "sniper_300"];
const CLIP_NAMES = [...CLIP_BASE.flatMap(b => [b + "_near1", b + "_near2", b + "_far1", b + "_far2"]), "mag_out", "mag_in", "slide", "charge", "bolt_back", "bolt_fwd", "click",
  "step1", "step2", "step3", "step4", "step5", "step6", "boom1", "boom2", "boom3", "pop"];
let clipsAsked = false;
function loadClips() { if (clipsAsked || !AC) return; clipsAsked = true;
  for (const n of CLIP_NAMES) fetch("sounds/" + n + ".mp3").then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then(b => AC.decodeAudioData(b)).then(buf => { CLIPS[n] = buf; }).catch(() => {}); }
/* which recording each gun uses and at what pitch: one recording per class, pitched apart so guns of a class differ */
const GUNCLIP = { ak: ["rifle_ak", 1], galil: ["rifle_ak", 1.06], sg553: ["rifle_ak", .96], negev: ["rifle_ak", .88], m4: ["rifle_m4", 1], famas: ["rifle_m4", 1.07], aug: ["rifle_m4", .95],
  glock: ["pistol_9", 1.04], p250: ["pistol_9", .94], tec9: ["pistol_9", 1.1], cz75: ["pistol_380", .97], fiveseven: ["pistol_380", 1.08], deagle: ["pistol_45", .8],
  mp9: ["smg_9", 1.07], mp7: ["smg_9", 1.13], p90: ["smg_9", 1.18], mac10: ["smg_ppsh", 1.05], ump: ["smg_ppsh", .92],
  nova: ["shotgun_nova", 1], xm1014: ["shotgun_cd", 1.04], awp: ["sniper_3006", .94], ssg08: ["sniper_300", 1.06] };
function playClip(name, vol, rate = 1, to = dest()) { const b = CLIPS[name]; if (!AC || !b) return false;
  const s = AC.createBufferSource(); s.buffer = b; s.playbackRate.value = rate; const g = AC.createGain(); g.gain.value = vol; s.connect(g).connect(to); s.start(); return true; }
function gunClip(w, vol, near) { const c = GUNCLIP[w]; if (!c) return false; const k = c[0] + (near ? "_near" : "_far") + (Math.random() < .5 ? 1 : 2);
  const name = CLIPS[k] ? k : c[0] + (near ? "_near" : "_far") + 1;
  if (!playClip(name, vol * (near ? .85 : 1.05), c[1] * (.97 + Math.random() * .06))) return false;
  if (!SND && VERB) playClip(name, vol * .12, c[1], VERB);   // your own shot rings off the street a little too
  if (c[0].startsWith("sniper")) sniperWeight(name, vol, near, c[1]);
  return true; }
/* the heavy sniper (2026-11-22): the recording alone is a short crack, so it gets a chest punch, its own echo rolling back
   from the far walls (the shot itself through a darkening feedback delay, panned side to side) and a long low rumble,
   about three seconds in all; a far shot is mostly echo and rumble */
let RUMBLE = null;
function sniperWeight(name, vol, near, rate) { if (!AC) return; const t = AC.currentTime, out = AC.createGain(); out.gain.value = vol; out.connect(dest());
  if (near) { const o = AC.createOscillator(), g = AC.createGain(); o.type = "sine"; o.frequency.setValueAtTime(72, t); o.frequency.exponentialRampToValueAtTime(30, t + .35);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.9, t + .006); g.gain.exponentialRampToValueAtTime(.001, t + .45); o.connect(g).connect(out); o.start(t); o.stop(t + .5); }
  { const s = AC.createBufferSource(); s.buffer = CLIPS[name]; s.playbackRate.value = rate * .97; const send = AC.createGain(); send.gain.value = near ? .5 : .75;
    const fb = AC.createGain(); fb.gain.value = .42; const lp = AC.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1500;
    const dl = AC.createDelay(1.5), dr = AC.createDelay(1.5); dl.delayTime.value = .29; dr.delayTime.value = .41;
    const pl = AC.createStereoPanner(), pr = AC.createStereoPanner(); pl.pan.value = -.7; pr.pan.value = .7;
    s.connect(send).connect(dl); dl.connect(lp); lp.connect(dr); dr.connect(fb).connect(dl); dl.connect(pl).connect(out); dr.connect(pr).connect(out);
    s.start(t); setTimeout(() => { try { fb.disconnect(); dl.disconnect(); dr.disconnect(); } catch (e) {} }, 4200); }
  if (!RUMBLE) { const n = AC.sampleRate * 3 | 0; RUMBLE = AC.createBuffer(2, n, AC.sampleRate);
    for (let c = 0; c < 2; c++) { const d = RUMBLE.getChannelData(c); let y = 0; for (let i = 0; i < n; i++) { const x = i / n; y += ((Math.random() * 2 - 1) - y) * .035;
      d[i] = y * Math.pow(1 - x, 2.2) * Math.min(1, i / (AC.sampleRate * .04)) * (1 + .35 * Math.sin(x * 19 + c)); } } }
  { const s = AC.createBufferSource(); s.buffer = RUMBLE; const g = AC.createGain(); g.gain.value = near ? 2 : 3; s.connect(g).connect(out); s.start(t + .03); } }
const muffle = on => { if (OUT) OUT.frequency.setTargetAtTime(on ? 420 : 20000, AC.currentTime, on ? .06 : .3); };
/* dying: a body-fall thud, a low drop, and a thin ringing in the ears that the muffling does not touch */
function deathSound() { if (!AC) return; const t = AC.currentTime;
  { const n = AC.sampleRate * .4 | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 5);
    const s = AC.createBufferSource(); s.buffer = b; const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 160; const g = AC.createGain(); g.gain.value = 1.4; s.connect(f).connect(g).connect(MG || AC.destination); s.start(t + .32); }
  { const o = AC.createOscillator(), g = AC.createGain(); o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(45, t + .7); g.gain.setValueAtTime(.35, t); g.gain.exponentialRampToValueAtTime(.001, t + .8); o.connect(g).connect(MG || AC.destination); o.start(t); o.stop(t + .82); }
  { const o = AC.createOscillator(), g = AC.createGain(); o.frequency.value = 3100; g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.035, t + .15); g.gain.exponentialRampToValueAtTime(.0001, t + 2.6); o.connect(g).connect(MG || AC.destination); o.start(t); o.stop(t + 2.7); } }
function shot(vol = 1, tone = 1) { if (!AC) return; const t = AC.currentTime, n = AC.sampleRate * .18 | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  const s = AC.createBufferSource(); s.buffer = b; const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 2400 * tone; const g = AC.createGain(); g.gain.setValueAtTime(.5 * vol, t); g.gain.exponentialRampToValueAtTime(.001, t + .17); s.connect(f).connect(g).connect(dest()); s.start(t); }
const TONE = { galil: [.95, 1.05], famas: [.85, 1.2], sg553: [.95, 1.05], ak: [1, 1], m4: [.85, 1.25], aug: [.9, 1.1], awp: [1.6, .55], knife: [.5, 3], glock: [.55, 1.6], usp: [.22, 2.4], deagle: [1.25, .75], mp9: [.6, 1.5], mac10: [.6, 1.4], nova: [1.45, .65] };
/* each class of gun its own report (2026-11-14): a rifle's crack and body, a pistol's short snap, the Deagle's boom, the
   suppressed USP-S's thud, an SMG's light chatter, the Nova's long roar */
const GUNSND = { m4a1s: { len: .12, lp: 1100, gain: .38, thump: 90 }, zeus: { len: .22, lp: 6000, gain: .5, thump: 0 },
                 p250: { len: .11, lp: 3000, gain: .62, thump: 140 }, cz75: { len: .1, lp: 3200, gain: .58, thump: 150 }, fiveseven: { len: .1, lp: 3600, gain: .55, thump: 150 }, tec9: { len: .1, lp: 3100, gain: .6, thump: 140 },
                 mp7: { len: .09, lp: 3200, gain: .58, thump: 150 }, ump: { len: .11, lp: 2300, gain: .7, thump: 120 }, p90: { len: .08, lp: 3400, gain: .55, thump: 160 },
                 xm1014: { len: .3, lp: 1400, gain: 1.4, thump: 65 }, negev: { len: .12, lp: 2200, gain: .9, thump: 100 }, ssg08: { len: .2, lp: 2600, gain: 1.15, thump: 85 },
                 usp: { len: .09, lp: 900, gain: .32, thump: 0 }, glock: { len: .1, lp: 3400, gain: .55, thump: 160 }, deagle: { len: .26, lp: 1700, gain: 1.3, thump: 75 },
                 mp9: { len: .09, lp: 3000, gain: .6, thump: 150 }, mac10: { len: .09, lp: 2700, gain: .62, thump: 140 }, nova: { len: .34, lp: 1300, gain: 1.5, thump: 60 } };
function gunSound(w, vol = 1, near = true) { const t = TONE[w] || TONE.ak; if (WEAPONS[w] && (WEAPONS[w].nade || WEAPONS[w].c4)) return; if (w === "knife") return swish(vol);
  if (gunClip(w, vol, near)) { if ((w === "awp" || w === "ssg08") && near && !SND) { setTimeout(() => playClip("bolt_back", .55, 1), 420); setTimeout(() => playClip("bolt_fwd", .55, 1), 640); } return; }   // the bolt after your own shot
  if (w === "awp") return sniperSound(vol, near);
  const P = GUNSND[w]; if (!P) return shot(vol * t[0], t[1]);
  if (!AC) return; const at0 = AC.currentTime, n = AC.sampleRate * P.len | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  const s = AC.createBufferSource(); s.buffer = b; const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = P.lp; const g2 = AC.createGain(); g2.gain.setValueAtTime(P.gain * vol, at0); g2.gain.exponentialRampToValueAtTime(.001, at0 + P.len);
  s.connect(f).connect(g2).connect(dest()); s.start(at0);
  if (P.thump) { const o = AC.createOscillator(), og = AC.createGain(); o.frequency.setValueAtTime(P.thump, at0); o.frequency.exponentialRampToValueAtTime(P.thump * .5, at0 + P.len); og.gain.setValueAtTime(.5 * P.gain * vol, at0); og.gain.exponentialRampToValueAtTime(.001, at0 + P.len); o.connect(og).connect(dest()); o.start(at0); o.stop(at0 + P.len + .02); }
}
/* small mechanical sounds: a magazine out and in, a grenade's pin, a draw, a landing (2026-11-14) */
function clack(vol = .5, f = 2600) { noiseHit(vol, .035, f, 5); }
/* reloads (2026-11-16): the real parts of a real reload, close and dry (a handgun's magazine out and in and its slide,
   a rifle bolt's clicks), sequenced for each kind of gun over its own reload time and pitched for its size: a pistol's
   slide, a rifle's charging handle, a sniper's bolt, a shotgun's shells one by one and then the pump */
const RELOADS = { pistol: [["mag_out", .06, 1.08], ["mag_in", .55, 1.08], ["slide", .8, 1.06]], rifle: [["mag_out", .08, .88], ["mag_in", .52, .86], ["charge", .82, .95]],
  smg: [["mag_out", .08, 1], ["mag_in", .55, .98], ["charge", .82, 1.12]], sniper: [["mag_out", .08, .9], ["mag_in", .45, .88], ["bolt_back", .72, 1], ["bolt_fwd", .84, 1]],
  heavy: [["click", .05, .7], ["mag_out", .15, .75], ["mag_in", .6, .72], ["charge", .85, .8]] };
const RELOADKIND = { glock: "pistol", usp: "pistol", p250: "pistol", cz75: "pistol", fiveseven: "pistol", tec9: "pistol", deagle: "pistol", mp9: "smg", mac10: "smg", mp7: "smg", ump: "smg", p90: "smg",
  awp: "sniper", ssg08: "sniper", negev: "heavy" };
function reloadSound(vol, w) { const W0 = WEAPONS[w] || {}, r = W0.reload || 2, to = dest();
  if (!CLIPS.mag_in) { clack(vol, 2200); setTimeout(() => clack(vol * 1.1, 1800), r * 550); return; }
  if (W0.shell) { const n = Math.min(4, W0.mag || 4); for (let i = 0; i < n; i++) setTimeout(() => playClip("mag_in", vol * .8, 1.4 + Math.random() * .1, to), 150 + i * W0.shell * 1000);
    setTimeout(() => playClip("slide", vol, .72, to), 150 + n * W0.shell * 1000); return; }
  for (const [c, at0, pitch] of RELOADS[RELOADKIND[w] || "rifle"]) setTimeout(() => playClip(c, vol, pitch * (.98 + Math.random() * .04), to), at0 * r * 1000); }
function pinSound(vol) { if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g2 = AC.createGain(); o.type = "triangle"; o.frequency.setValueAtTime(3800, t); o.frequency.exponentialRampToValueAtTime(2100, t + .05); g2.gain.setValueAtTime(.18 * vol, t); g2.gain.exponentialRampToValueAtTime(.001, t + .08); o.connect(g2).connect(dest()); o.start(t); o.stop(t + .09); }
/* the sniper: a supersonic crack, a deep chest boom, an echo rolling off the walls, and (for the shooter) the bolt cycling */
const noiseBuf = (secs, shape) => { const n = AC.sampleRate * secs | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * shape(i / n); return b; };
function sniperSound(vol = 1, near = true) { if (!AC) return; const t = AC.currentTime, src = (b, at) => { const s = AC.createBufferSource(); s.buffer = b; s.start(at); return s; };
  const out = AC.createGain(); out.gain.value = vol; out.connect(dest());
  { const f = AC.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 1800; const g = AC.createGain(); g.gain.value = .9; src(noiseBuf(.05, x => Math.pow(1 - x, 2)), t).connect(f).connect(g).connect(out); }
  { const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 900; const g = AC.createGain(); g.gain.setValueAtTime(1.3, t); g.gain.exponentialRampToValueAtTime(.001, t + .55); src(noiseBuf(.55, x => Math.pow(1 - x, 2.2)), t).connect(f).connect(g).connect(out); }
  { const o = AC.createOscillator(), g = AC.createGain(); o.type = "sine"; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(38, t + .45); g.gain.setValueAtTime(near ? 1.1 : .5, t); g.gain.exponentialRampToValueAtTime(.001, t + .5); o.connect(g).connect(out); o.start(t); o.stop(t + .52); }
  { const d = AC.createDelay(1), fb = AC.createGain(), f = AC.createBiquadFilter(), g = AC.createGain(); d.delayTime.value = .19; fb.gain.value = .42; f.type = "lowpass"; f.frequency.value = 650; g.gain.value = .5;
    src(noiseBuf(.3, x => Math.pow(1 - x, 3)), t + .02).connect(f); f.connect(d); d.connect(fb).connect(d); d.connect(g).connect(out); setTimeout(() => { try { fb.disconnect(); d.disconnect(); } catch (e) {} }, 2500); }
  if (near) for (const [at, fr] of [[.62, 2600], [.78, 1900]]) { const f = AC.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = fr; f.Q.value = 6; const g = AC.createGain(); g.gain.value = .5; src(noiseBuf(.035, x => Math.pow(1 - x, 4)), t + at).connect(f).connect(g).connect(dest()); }
}
function swish(vol = 1) { if (!AC) return; const t = AC.currentTime, n = AC.sampleRate * .12 | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / n);
  const s = AC.createBufferSource(); s.buffer = b; const f = AC.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 2500; const g = AC.createGain(); g.gain.value = .35 * vol; s.connect(f).connect(g).connect(dest()); s.start(t); }
/* what bullets sound like around you (2026-11-16), made from their physics: a rifle round passing close is supersonic
   and cracks (a sharp pressure wave, then a hiss); a pistol or SMG round whizzes past (filtered air falling in pitch
   as it goes); a round striking near you chips the surface, and now and then whines off it; a hit on you is a dull
   thud, on the helmet a ring of metal */
const SUBSONIC = new Set(["glock", "usp", "p250", "cz75", "fiveseven", "tec9", "deagle", "mp9", "mac10", "mp7", "ump", "p90", "nova", "xm1014"]);
function noiseBuf2(secs, shape) { const n = AC.sampleRate * secs | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * shape(i / n); return b; }
function crack(vol) { if (!AC) return; const t = AC.currentTime, s = AC.createBufferSource(), n = AC.sampleRate * .004 | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = i < n / 2 ? 1 - i / (n / 2) * 2 : -1 + (i - n / 2) / (n / 2);   // an N-wave
  s.buffer = b; const g = AC.createGain(); g.gain.value = .9 * vol; s.connect(g).connect(dest()); s.start(t);
  const h = AC.createBufferSource(); h.buffer = noiseBuf2(.09, x => Math.pow(1 - x, 4)); const f = AC.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 2500; const g2 = AC.createGain(); g2.gain.value = .35 * vol; h.connect(f).connect(g2).connect(dest()); h.start(t + .003); }
function whiz(vol) { if (!AC) return; const t = AC.currentTime, s = AC.createBufferSource(); s.buffer = noiseBuf2(.22, x => Math.sin(Math.PI * Math.pow(x, .6)));
  const f = AC.createBiquadFilter(); f.type = "bandpass"; f.Q.value = 3.5; f.frequency.setValueAtTime(3600, t); f.frequency.exponentialRampToValueAtTime(1300, t + .22);
  const g = AC.createGain(); g.gain.value = .55 * vol; s.connect(f).connect(g).connect(dest()); s.start(t); }
function impactSound(vol) { if (!AC) return; const t = AC.currentTime;
  { const s = AC.createBufferSource(); s.buffer = noiseBuf2(.03, x => Math.pow(1 - x, 3)); const f = AC.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 2600 + Math.random() * 1500; f.Q.value = 1.2; const g = AC.createGain(); g.gain.value = .5 * vol; s.connect(f).connect(g).connect(dest()); s.start(t); }
  { const s = AC.createBufferSource(); s.buffer = noiseBuf2(.07, x => Math.pow(1 - x, 4)); const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 500; const g = AC.createGain(); g.gain.value = .4 * vol; s.connect(f).connect(g).connect(dest()); s.start(t); }
  if (Math.random() < .18) { const o = AC.createOscillator(), g = AC.createGain(), f0 = 2200 + Math.random() * 1600; o.type = "sine"; o.frequency.setValueAtTime(f0, t + .01); o.frequency.exponentialRampToValueAtTime(f0 * .45, t + .32);
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.09 * vol, t + .03); g.gain.exponentialRampToValueAtTime(.0005, t + .34); o.connect(g).connect(dest()); o.start(t); o.stop(t + .36); } }   // a ricochet
function bodyHit(head) { if (!AC) return; const t = AC.currentTime, s = AC.createBufferSource(); s.buffer = noiseBuf2(.1, x => Math.pow(1 - x, 3)); const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 380; const g = AC.createGain(); g.gain.value = .9; s.connect(f).connect(g).connect(MG || OUT); s.start(t);
  if (head) for (const [fr, a] of [[2350, .12], [3910, .07], [5480, .05]]) { const o = AC.createOscillator(), g2 = AC.createGain(); o.frequency.value = fr; g2.gain.setValueAtTime(a, t); g2.gain.exponentialRampToValueAtTime(.0005, t + .45); o.connect(g2).connect(MG || OUT); o.start(t); o.stop(t + .46); } }   // the helmet rings
/* the headshot "dink" you hear when your shot finds a head (2026-11-17): a bright metallic snap, shorter and higher than
   the helmet's ring the victim hears */
function headDink() { if (!AC) return; const t = AC.currentTime, s = AC.createBufferSource(); s.buffer = noiseBuf2(.03, x => Math.pow(1 - x, 4)); const f = AC.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 2500;
  const g = AC.createGain(); g.gain.value = .35; s.connect(f).connect(g).connect(dest()); s.start(t);
  for (const [fr, a] of [[3150, .2], [4720, .1], [6900, .05]]) { const o = AC.createOscillator(), g2 = AC.createGain(); o.frequency.value = fr; g2.gain.setValueAtTime(a, t); g2.gain.exponentialRampToValueAtTime(.0005, t + .2); o.connect(g2).connect(dest()); o.start(t); o.stop(t + .21); } }
/* damage numbers (2026-11-17): what your hit took, rising off the body; hits on the same player in quick succession add
   up in one number, as the CS damage-number mods do; a headshot's is gold */
const DMGN = [];
function dmgNum(e) { const v = others.get(e.id); if (!v || !e.d) return;
  const p = v.model.g.position.clone(); p.y += e.h ? 1.8 : 1.3; const now = nowS(), last = DMGN.find(n => n.id === e.id && now - n.t0 < .5);
  if (last) { last.d += e.d; last.h = last.h || !!e.h; last.t0 = now; last.p.copy(p); last.el.textContent = last.d; last.el.classList.toggle("h", last.h); return; }
  const el = document.createElement("span"); el.textContent = e.d; if (e.h) el.className = "h"; $("dmgn").appendChild(el); DMGN.push({ id: e.id, d: e.d, h: !!e.h, t0: now, p, el }); }
function tickDmg() { const now = nowS(), w = innerWidth, h = innerHeight, V = new THREE.Vector3();
  for (let i = DMGN.length - 1; i >= 0; i--) { const n = DMGN[i], a = (now - n.t0) / .9; if (a >= 1) { n.el.remove(); DMGN.splice(i, 1); continue; }
    V.copy(n.p).project(camera); const vis = V.z < 1; n.el.style.opacity = vis ? (1 - a * a).toFixed(2) : 0;
    n.el.style.transform = `translate(${((V.x + 1) / 2 * w).toFixed(0)}px,${((1 - V.y) / 2 * h - a * 34).toFixed(0)}px) translate(-50%,-50%) scale(${(1.15 - Math.min(a * 3, 1) * .15).toFixed(2)})`; } }
/* pulling the trigger on an empty gun: the hammer falls on nothing */
let dryAt = 0; function dryFire() { const W0 = WEAPONS[me.w] || {}; if (!AC || !me.alive || me.mag > 0 || me.reloadAt || W0.melee || W0.nade || W0.c4 || nowS() - dryAt < .25) return; dryAt = nowS(); playClip("click", .55, 1.5); }
function tink(freq = 1800) { if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain(); o.frequency.value = freq; g.gain.setValueAtTime(.15, t); g.gain.exponentialRampToValueAtTime(.001, t + .12); o.connect(g).connect(dest()); o.start(t); o.stop(t + .13); }

export { AC, OUT, MG, audio, SND, VERB, dest, ENV, AT, at, probeEnv, echoTail, CLIPS, CLIP_BASE, CLIP_NAMES, clipsAsked, loadClips, GUNCLIP, playClip, gunClip, RUMBLE, sniperWeight, muffle, deathSound, shot, TONE, GUNSND, gunSound, clack, RELOADS, RELOADKIND, reloadSound, pinSound, noiseBuf, sniperSound, swish, SUBSONIC, noiseBuf2, crack, whiz, impactSound, bodyHit, headDink, DMGN, dmgNum, tickDmg, dryAt, dryFire, tink };
