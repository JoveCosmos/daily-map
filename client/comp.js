/* Competitive: the buy menu, grenade lineups, the bomb sites and the bomb (split out of game.js 2026-11-22) */
import * as THREE from "three";
import { WEAPONS, viewDir, clamp, OFF } from "../sim.js";
import { TOUCH, renderer, $, scene, camera, nowS, pointerLock } from "./core.js";
import { dotTex } from "./fx.js";
import { AC, dest, at } from "./audio.js";
import { myTeam, me, GM, compLike, releaseMouse, locked, connected, setLocked, esc, ws, dispose, label } from "../game.js";
/* ── Competitive (2026-11-14): the buy menu (B, then number keys, as CS's classic menu; or a click/tap), money, the
   bomb's sites, plant and defuse progress, the bomb in the world and on the radar, its beeps ───────────────────────── */
const PRICE = { glock: [200, 1], usp: [200, 0], p250: [300], fiveseven: [500, 0], tec9: [500, 1], cz75: [500], deagle: [700],
                mp9: [1250, 0], mac10: [1050, 1], mp7: [1500], ump: [1200], p90: [2350], nova: [1050], xm1014: [2000], negev: [1700],
                galil: [1800, 1], famas: [2050, 0], ak: [2700, 1], m4: [3100, 0], m4a1s: [2900, 0], sg553: [3000, 1], aug: [3300, 0], ssg08: [1700], awp: [4750],
                vest: [650], vesthelm: [1000], he: [300], flash: [200], smoke: [300], molotov: [400, 1], incendiary: [600, 0], decoy: [50], kit: [400, 0], zeus: [200] };   // same as server.js
const BUYCATS = [["Pistols", ["usp", "glock", "p250", "fiveseven", "tec9", "cz75", "deagle"]], ["SMGs", ["mp9", "mac10", "mp7", "ump", "p90"]], ["Heavy", ["nova", "xm1014", "negev"]],
                 ["Rifles", ["famas", "galil", "m4", "m4a1s", "ak", "sg553", "aug", "ssg08", "awp"]], ["Gear", ["vest", "vesthelm", "kit", "zeus"]], ["Grenades", ["flash", "smoke", "he", "molotov", "decoy"]]].map(([c, l]) => [c, l.filter(w => !OFF.has(w))]).filter(([, l]) => l.length);   // guns switched off (sim.js OFF) left out
const BUY = { open: false, cat: -1, free: false };
let SITES_C = [], lastMo = null, moFlash = 0, lastBeep = 0;
const itemName = it => ({ vest: "Kevlar", vesthelm: "Kevlar + helmet", kit: "Defuse kit", molotov: myTeam === 0 ? "Incendiary" : "Molotov" })[it] || (WEAPONS[it] || {}).name || it;
function itemPrice(it) { const P = PRICE[it === "molotov" && myTeam === 0 ? "incendiary" : it]; if (!P) return null;
  if (P[1] != null && P[1] !== myTeam) return null; if (it === "vesthelm" && me.armor >= 100 && !me.helmet) return 350; return P[0]; }
/* on a computer the menu frees the mouse, as CS does: the cursor shows, a click buys, the view holds still, and closing
   it captures the mouse again (2026-11-17: it was keyboard only). Moving with the keys still works while it is open. */
function buyMenu(on) { const was = BUY.open; BUY.open = on && GM && compLike(GM.m) && GM.m !== "rt"; BUY.cat = -1; drawBuy();
  if (TOUCH || was === BUY.open) return;
  if (BUY.open) { BUY.free = true; releaseMouse(); if (document.pointerLockElement) document.exitPointerLock(); }
  else if (BUY.free) { BUY.free = false; if (locked && connected && !document.pointerLockElement) relock(); } }
/* capture the mouse again after the menu; if the browser refuses (no click or key behind it), the pause menu shows, as on Esc */
function relock() { let p; try { p = pointerLock(); } catch (e) { return setLocked(false); }
  if (p && p.catch) p.catch(() => { if (!document.pointerLockElement) setLocked(false); }); }
function drawBuy() {
  const el = $("buy"); el.hidden = !BUY.open; if (!BUY.open) return;
  const money = me.mo || 0, row = (n, label, price, ok) => `<button type="button" data-n="${n}" class="${ok ? "" : "no"}"><kbd>${n}</kbd><span>${esc(label)}</span>${price != null ? `<b>$${price}</b>` : ""}</button>`;
  // phones get real buttons to go back and to close (2026-11-16: the keyboard hints left a phone no way out)
  const foot = back => TOUCH ? `<div class="bf">${back ? `<button type="button" data-n="0">Back</button>` : ""}<button type="button" data-n="close">Close</button></div>` : "";
  if (BUY.cat < 0) el.innerHTML = `<h4>Buy <small>$${money}</small></h4>` + BUYCATS.map((c, i) => row(i + 1, c[0], null, true)).join("") + (TOUCH && me.ib ? "" : `<p>${me.ib ? "B or Esc to close" : "Buying is over for this round"}</p>`) + foot(false);
  else { const items = BUYCATS[BUY.cat][1].filter(it => itemPrice(it) != null);
    el.innerHTML = `<h4>${esc(BUYCATS[BUY.cat][0])} <small>$${money}</small></h4>` + items.map((it, i) => { const p = itemPrice(it); return row(i + 1, itemName(it), p, me.ib && p <= money); }).join("") + (TOUCH ? foot(true) : `<p>0 back, B or Esc to close</p>`); }
}
function buyKey(code) {
  if (code === "Escape") return buyMenu(false);
  const n = code === "Backspace" ? 0 : +code.slice(5);
  if (BUY.cat < 0) { if (n >= 1 && n <= BUYCATS.length) { BUY.cat = n - 1; drawBuy(); } return; }
  if (n === 0) { BUY.cat = -1; drawBuy(); return; }
  const items = BUYCATS[BUY.cat][1].filter(it => itemPrice(it) != null), it = items[n - 1];
  if (it && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "b", i: it }));
}
/* a button in a panel answers a click, or a tap directly (a phone's tap then skips its click, so nothing runs twice) */
function onTap(el, fn) { el.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) fn(b); });
  el.addEventListener("touchend", ev => { const b = ev.target.closest("button"); if (b) { ev.preventDefault(); fn(b); } }); }
onTap($("buy"), b => b.dataset.n === "close" ? buyMenu(false) : buyKey("Digit" + b.dataset.n));
/* grenade lineups (2026-11-17): with a smoke in hand on the attacking side, a ring marks each spot the server found a
   smoke from (its site written over it); standing in one, a dot shows where to look, a circle where it will land, and
   the prompt says which click (left: full, right: a lob, both: medium) */
const LU = { list: [], marks: [], aim: null, land: null };
function setLineups(list) {
  for (const o of LU.marks) { scene.remove(o); dispose(o); } LU.marks = []; LU.list = list || [];
  if (!LU.aim) { LU.aim = new THREE.Mesh(new THREE.SphereGeometry(.05, 12, 8), new THREE.MeshBasicMaterial({ color: 0x5ff0ff, depthTest: false, transparent: true }));
    LU.aim.renderOrder = 9; LU.aim.visible = false; scene.add(LU.aim);
    LU.land = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.3, 40), new THREE.MeshBasicMaterial({ color: 0x5ff0ff, transparent: true, opacity: .55, side: THREE.DoubleSide, depthWrite: false }));
    LU.land.rotation.x = -Math.PI / 2; LU.land.visible = false; scene.add(LU.land); }
  for (const l of LU.list) { const g = new THREE.Group(); g.position.set(l.p[0], l.p[1] + .03, l.p[2]);
    const ring = new THREE.Mesh(new THREE.RingGeometry(.32, .42, 32), new THREE.MeshBasicMaterial({ color: 0x5ff0ff, transparent: true, opacity: .8, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; g.add(ring);
    const tag = label("Smoke " + l.site, "#5ff0ff"); tag.position.y = 1.2; g.add(tag); g.visible = false; scene.add(g); LU.marks.push(g); }
}
function tickLineups() {
  if (!LU.aim) return "";
  const on = !!(GM && compLike(GM.m) && me.alive && me.w === "smoke" && myTeam === 1 && LU.list.length); let here = null;
  LU.list.forEach((l, i) => { LU.marks[i].visible = on; if (on && Math.hypot(me.pos.x - l.p[0], me.pos.z - l.p[2]) < .45 && Math.abs(me.pos.y - l.p[1]) < 1) here = l; });
  LU.aim.visible = LU.land.visible = !!here; if (!here) return "";
  const e = camera.position; LU.aim.position.copy(e).addScaledVector(viewDir(here.yaw, here.pitch), 6); LU.land.position.set(here.land[0], here.land[1] + .05, here.land[2]);
  return `Smoke ${here.site}: put the crosshair on the blue dot, stand still, then ${here.str === 1 ? "left click" : here.str === 0 ? "right click" : "hold both buttons"}`;
}
/* the two sites, marked in the world by a faint ring on the ground (their letters are on the radar, as in CS) */
const siteMarks = [];
function setSites(list) {
  for (const o of siteMarks) { scene.remove(o); dispose(o); } siteMarks.length = 0; SITES_C = list || [];
  for (const [name, x, y, z, r] of SITES_C) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - .08, r, 48), new THREE.MeshBasicMaterial({ color: 0xffb02e, transparent: true, opacity: .35, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(x, y + .04, z); scene.add(ring); siteMarks.push(ring); }
}
/* the bomb: a small charge with a blinking light when planted; the dropped bomb, which only Ember is told about */
const bombObj = (() => { const g = new THREE.Group(); const b = new THREE.Mesh(new THREE.BoxGeometry(.32, .1, .22), new THREE.MeshStandardMaterial({ color: 0x3d4a2c, roughness: .8 })); b.position.y = .05; g.add(b);
  const k = new THREE.Mesh(new THREE.BoxGeometry(.1, .02, .08), new THREE.MeshStandardMaterial({ color: 0x15181a })); k.position.set(.06, .11, 0); g.add(k);
  const led = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xff2a1a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); led.scale.setScalar(.35); led.position.set(-.08, .14, 0); g.add(led); g.userData.led = led;
  g.visible = false; scene.add(g); return g; })();
function syncComp(m) {
  if (!m.me) return;   // the in-between updates carry only the others (audit 2026-11-23)
  if (!GM || !compLike(GM.m)) { bombObj.visible = false; return; }
  const bp = GM.bp, bd = m.me && m.me.bd;
  if (bp) { bombObj.visible = true; bombObj.position.set(bp[0], bp[1], bp[2]); } else if (bd) { bombObj.visible = true; bombObj.position.set(bd[0], bd[1], bd[2]); } else bombObj.visible = false;
  bombObj.userData.planted = !!bp;
  if (m.me && m.me.tmo) TMO = new Map(m.me.tmo);
}
let TMO = new Map();
function beep(f = 2200, len = .06, vol = .35) { if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g2 = AC.createGain(); o.frequency.value = f; g2.gain.setValueAtTime(vol, t); g2.gain.exponentialRampToValueAtTime(.001, t + len); o.connect(g2).connect(dest()); o.start(t); o.stop(t + len + .01); }
function tickComp(dt) {
  const comp = !!(GM && compLike(GM.m)); document.body.classList.toggle("comp", comp); document.body.classList.toggle("rt", !!(GM && GM.m === "rt"));
  if (!comp) { if (BUY.open) buyMenu(false); return; }
  // money, with what just came in or went out
  const mo = me.mo || 0; if (lastMo != null && mo !== lastMo) { $("modelta").textContent = (mo > lastMo ? "+$" : "-$") + Math.abs(mo - lastMo); $("modelta").className = mo > lastMo ? "up" : "dn"; moFlash = 1.6; } lastMo = mo;
  moFlash = Math.max(0, moFlash - dt); $("modelta").style.opacity = Math.min(1, moFlash).toFixed(2); $("mov").textContent = "$" + mo;
  $("bhint").hidden = !(me.ib && !BUY.open && me.alive); if (BUY.open && !me.ib && BUY.cat >= 0) drawBuy();
  // planting and defusing: a bar under the crosshair
  const pr = me.pp || me.dp || 0, bar = $("bprog"); bar.hidden = !(pr > 0); if (pr > 0) { bar.querySelector("i").style.width = (100 * Math.min(1, pr)).toFixed(1) + "%"; bar.querySelector("span").textContent = me.pp ? "Planting the bomb" : "Defusing" + (me.kit ? " (kit)" : ""); }
  // the planted bomb blinks and beeps faster as it runs down
  if (bombObj.visible) { const on = bombObj.userData.planted ? (nowS() * (GM.bl > 0 && GM.bl < 10 ? 4 : 1.2)) % 1 < .5 : false; bombObj.userData.led.visible = on; }
  if (GM.bp && GM.bl > 0) { const gap = clamp(GM.bl / 40, .1, 1), n = nowS(); if (n - lastBeep > gap) { lastBeep = n; at(new THREE.Vector3(GM.bp[0], GM.bp[1], GM.bp[2]), () => beep(2600, .05, .45)); } }
  if (TOUCH) { $("tBuy").hidden = !me.ib; $("tC4").hidden = !me.c4; }
}

export { PRICE, BUYCATS, BUY, SITES_C, lastMo, moFlash, lastBeep, itemName, itemPrice, buyMenu, relock, drawBuy, buyKey, onTap, LU, setLineups, tickLineups, siteMarks, setSites, bombObj, syncComp, TMO, beep, tickComp };
