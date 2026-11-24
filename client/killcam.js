/* the killcam and round highlights: the recorded last moments replayed through the killer's eyes, and spectating (split out of game.js 2026-11-22) */
import { nowS, scene, camera } from "./core.js";
import { clamp, WIDS } from "../sim.js";
import { gunSound } from "./audio.js";
import { SET, diedAt, GM, dmLike, lerpAng, me, dispose, recoilFx, others, myId, person, nameOf, myTeam, SPEC } from "../game.js";
/* the killcam (2026-11-17): soon after you die, the last moments again through your killer's eyes, their gun, their shots
   and their sound, with you (and whoever was near) where you were. The server sends the record to the dead player only.
   Rounds: 3 s, then spectating. Deathmatch: the part that fits before the 3 s respawn. A click skips it. */
const KC = { hl: null, hls: 0, msgs: 0, deaths: 0, played: 0, rec: null, got: -9, start: 0, dur: 0, on: false, temps: new Map(), shot: 0, skip: false };
const KC_DELAY = .5;
function kcGot(m) { const h = new Map(); for (const [id, team, rows] of m.h) if (rows.length) h.set(id, { team, rows }); KC.rec = { by: m.by, at: m.at, h }; KC.got = nowS(); KC.msgs++; }
function kcBegin() {   // at the death: take the record that came with it, if any
  KC.deaths++; if (KC.hl && kcActive()) return; KC.hl = null; KC.skip = false; KC.on = false; if (!SET.kcam || !KC.rec || nowS() - KC.got > 3 || !KC.rec.h.has(KC.rec.by)) { KC.rec = null; return; }
  KC.start = diedAt + KC_DELAY; KC.dur = GM && !dmLike(GM.m) ? 3 : 3 - KC_DELAY - .1; KC.shot = KC.rec.at - KC.dur; KC.played++;
}
/* a recorded state at time t, between its two rows; shots counted in (from, t] */
function kcAt(rows, t) {
  let i = rows.findIndex(r => r[0] >= t); if (i < 0) i = rows.length - 1; const b = rows[i], a = rows[Math.max(0, i - 1)];
  const k = b[0] > a[0] ? clamp((t - a[0]) / (b[0] - a[0]), 0, 1) : 1, L = (u, v) => u + (v - u) * k;
  return { x: L(a[1], b[1]), y: L(a[2], b[2]), z: L(a[3], b[3]), yaw: lerpAng(a[4], b[4], k), pitch: L(a[5], b[5]), duck: L(a[6], b[6]), alive: (k < .5 ? a : b)[7], w: WIDS[(k < .5 ? a : b)[8]] || "ak",
    speed: b[0] > a[0] ? Math.hypot(b[1] - a[1], b[3] - a[3]) / (b[0] - a[0]) : 0 };
}
const kcShots = (rows, t0, t1) => rows.reduce((n, r) => n + (r[0] > t0 && r[0] <= t1 ? r[9] : 0), 0);
function kcActive() { return !!KC.rec && (!!KC.hl || !me.alive) && !KC.skip && nowS() >= KC.start && nowS() < KC.start + KC.dur; }
/* a round's highlight (2026-11-17): the same player as the killcam, for everyone, alive or not, through the eyes of the
   round's best player, with what they did as its title */
function hlGot(m) { if (!SET.hl) return; const h = new Map(); for (const [id, team, rows] of m.h) if (rows.length) h.set(id, { team, rows }); if (!h.has(m.by)) return;
  KC.rec = { by: m.by, at: m.t1, h }; KC.hl = { title: m.title }; KC.skip = false; KC.start = nowS() + .2; KC.dur = m.t1 - m.t0; KC.shot = m.t0; KC.hls++; }
function kcEnd() { for (const g of KC.temps.values()) { scene.remove(g.g); dispose(g.g); } KC.temps.clear(); KC.on = false; KC.hl = null; }
/* the camera through the killer's eyes, their gun in hand; returns the replay time */
function kcCamera() {
  const t = KC.rec.at - KC.dur + (nowS() - KC.start), K = kcAt(KC.rec.h.get(KC.rec.by).rows, t);
  camera.position.set(K.x, K.y + 1.62 - K.duck * .45, K.z); camera.rotation.order = "YXZ"; camera.rotation.set(K.pitch, K.yaw, 0);
  const fired = kcShots(KC.rec.h.get(KC.rec.by).rows, KC.shot, t); KC.shot = t;
  if (fired) { gunSound(K.w, .9); recoilFx(.05, k => Math.min(3, k + 1)); }
  return { t, K };
}
/* everyone in the record where they were then; those not in it are hidden for the replay */
function kcBodies(t) {
  for (const o of others.values()) o.model.g.visible = false;
  for (const [id, r] of KC.rec.h) { if (id === KC.rec.by) continue;
    let m = id !== myId && others.get(id) ? others.get(id).model : null;
    if (!m) { m = KC.temps.get(id); if (!m) { m = person(r.team, nameOf(id)); KC.temps.set(id, m); } }
    const S = kcAt(r.rows, t), g = m.g; g.visible = true; g.position.set(S.x, S.y, S.z); g.rotation.y = S.yaw;
    m.phase = (m.phase || 0) + S.speed * .016 * 3.2; m.sd.pose(S.alive ? S.speed : 0, m.phase, S.duck, S.alive ? S.pitch : 0); if (m.sd.rim) m.sd.rim(S.alive ? 1 : 0);
    g.rotation.x = S.alive ? 0 : -Math.PI / 2; if (m.tag) m.tag.visible = !S.alive ? false : r.team === myTeam; }
}
const specList = () => [...others.values()].filter(o => o.team === myTeam && o.alive && !o.gone && o.buf.length).sort((a, b) => a.id - b.id);
const spectating = () => !me.alive && GM && !dmLike(GM.m) && nowS() - diedAt > 3 && !kcActive() && specList().length > 0;
function specNext() { const L = specList(); if (!L.length) { SPEC.id = 0; return; } const i = L.findIndex(o => o.id === SPEC.id); SPEC.id = L[(i + 1) % L.length].id; }
export { KC, KC_DELAY, kcGot, kcBegin, kcAt, kcShots, kcActive, hlGot, kcEnd, kcCamera, kcBodies, specList, spectating, specNext };
