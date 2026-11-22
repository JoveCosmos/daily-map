/* talking: chat (Y everyone, U team), the radio (Z) and map pings (middle click) (split out of game.js 2026-11-22) */
import * as THREE from "three";
import { $, TOUCH, camera, scene, nowS } from "./core.js";
import { onTap, beep } from "./comp.js";
import { at, tink } from "./audio.js";
import { keys, releaseMouse, ws, esc, W, me, roster, nameOf } from "../game.js";
/* ── talking (2026-11-14): chat (Y everyone, U team), the radio (Z, then a number), a ping (middle click) ─────── */
const RADIO = ["Enemy spotted", "Need backup", "Cover me", "Go, go, go", "Fall back", "Hold this position", "Affirmative", "Negative", "Sector clear", "I'm in position"];
const CHAT = { team: false, radio: false }, PINGS = [];
function chatLine(html) { const d = document.createElement("div"); d.innerHTML = html; $("chat").appendChild(d); while ($("chat").children.length > 7) $("chat").firstChild.remove(); setTimeout(() => d.classList.add("old"), 9000); }
function openChat(team) { CHAT.team = team; for (const k in keys) keys[k] = false; releaseMouse(); const i = $("chatin"); i.hidden = false; i.placeholder = team ? "Team: say something, Enter to send" : "Everyone: say something, Enter to send"; i.value = ""; i.focus(); }
function closeChat() { const i = $("chatin"); i.hidden = true; i.blur(); }
$("chatin").addEventListener("keydown", e => { e.stopPropagation();
  if (e.key === "Enter") { const t = $("chatin").value.trim(); if (t && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "say", m: t.slice(0, 120), team: CHAT.team })); closeChat(); e.preventDefault(); }
  else if (e.key === "Escape") closeChat(); });
function radioMenu(on) { CHAT.radio = on; const el = $("radio"); el.hidden = !on; if (!on) return;
  el.innerHTML = `<h4>Radio</h4>` + RADIO.map((r, i) => `<button type="button" data-n="${i}"><kbd>${(i + 1) % 10}</kbd><span>${esc(r)}</span></button>`).join("") +
    (TOUCH ? `<button type="button" data-n="chat"><kbd></kbd><span>Type a message</span></button>` : "") + `<p>${TOUCH ? "Tap Radio to close" : "Z or Esc to close"}</p>`; }
onTap($("radio"), b => { if (b.dataset.n === "chat") { radioMenu(false); openChat(true); } else sendRadio(+b.dataset.n); });
function sendRadio(n) { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "radio", n })); radioMenu(false); }
function sendPing() {
  if (!W || !me.alive) return; const d = new THREE.Vector3(); camera.getWorldDirection(d); const h = W.first(camera.position, d, 150);
  const p = h ? h.point : camera.position.clone().addScaledVector(d, 30); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "ping", p: [p.x, p.y, p.z] }));
}
const pingTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const x = c.getContext("2d"); x.translate(32, 32); x.rotate(Math.PI / 4);
  x.strokeStyle = "#ffb02e"; x.lineWidth = 6; x.strokeRect(-14, -14, 28, 28); x.fillStyle = "rgba(255,210,90,.35)"; x.fillRect(-14, -14, 28, 28); return new THREE.CanvasTexture(c); })();
function showPing(e) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: pingTex, transparent: true, depthTest: false, depthWrite: false })); sp.position.set(e.p[0], e.p[1] + .4, e.p[2]); sp.scale.setScalar(.7); sp.renderOrder = 10; scene.add(sp);
  PINGS.push({ sp, x: e.p[0], z: e.p[2], until: nowS() + 4 }); at(sp.position, () => beep(1500, .07, .3));
  chatLine(`<b class="${(roster.get(e.id) || {}).team ? "t" : "ct"}">${esc(nameOf(e.id))}</b> <small>marked a spot</small>`);
}
function tickTalk() { const n = nowS(); for (let i = PINGS.length - 1; i >= 0; i--) { const q = PINGS[i]; if (n > q.until) { scene.remove(q.sp); q.sp.material.dispose(); PINGS.splice(i, 1); } else q.sp.material.opacity = Math.min(1, (q.until - n) / .8); } }
function onTalk(e) {
  const who = `<b class="${(roster.get(e.id) || {}).team ? "t" : "ct"}">${esc(nameOf(e.id))}</b>`;
  if (e.k === "say") { chatLine(`${e.dead ? "<small>dead</small> " : ""}${e.tm ? "<small>team</small> " : ""}${who}: ${esc(e.m)}`); tink(e.tm ? 1300 : 1100); }
  else if (e.k === "radio") { chatLine(`<small>radio</small> ${who}: ${esc(RADIO[e.n] || "")}`); beep(880, .05, .25); setTimeout(() => beep(1320, .05, .25), 70); }
  else if (e.k === "ping") showPing(e);
}

export { RADIO, CHAT, PINGS, chatLine, openChat, closeChat, radioMenu, sendRadio, sendPing, pingTex, showPing, tickTalk, onTalk };
