/* Newground, multiplayer client. The server decides everything; this page predicts its own player so input
   feels instant (move and shoot locally, then reconcile with each snapshot by replaying the commands the server has
   not confirmed), and draws everyone else 100 ms in the past, interpolated between snapshots. Shots carry the
   view time they were aimed in, so the server can rewind the others to what this screen showed (lag compensation). */
import * as THREE from "three";
import { World, C, block, GAIT, DT, U, DEG, clamp, newPlayer, move, weapon, eye, inaccuracy, standinParts, gltfGeometries, WEAPONS, WIDS, wpn, NADES, NADE, viewDir } from "./sim.js";
import { gunModel, soldier, MUZZLE, sleeveMaterial, applyFinish, FINISHES, loadGunModels, loadArms, makeArms, loadFighters, BUST } from "./models.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { gltf, $, params, AUTO, TEAM, TEAMCOL, renderer, PHONE, scene, camera, sun, TOUCH, nowS, pointerLock } from "./client/core.js";
import { dryFire, MG, audio, AC, OUT, at, tink, dest, CLIPS, playClip, deathSound, muffle, gunSound, SUBSONIC, whiz, crack, impactSound, swish, reloadSound, pinSound, bodyHit, headDink, dmgNum, clack, probeEnv, tickDmg, ENV } from "./client/audio.js";
import { dotTex, tracer, flashAt, puff, parts, decal, sparks, impact, ejectOther, ejectShell, muzzleLight, tickParts, tickShells, flyStreaks, tracers, streaks, sparkN, shells, decals } from "./client/fx.js";
import { buyMenu, BUY, buyKey, onTap, beep, SITES_C, bombObj, setLineups, setSites, TMO, syncComp, itemName, drawBuy, tickComp, tickLineups, LU } from "./client/comp.js";
import { radarMap, drawRadar } from "./client/radar.js";
import { openChat, radioMenu, CHAT, sendRadio, sendPing, onTalk, chatLine, tickTalk, PINGS } from "./client/talk.js";
import { setBlind, syncFx, fxVol, flashSound, boomSound, blindLeft, noiseHit, hurtFrom, smokeBetween, step, stepVol, tickFx, FX } from "./client/nades.js";
import { initViews, rebuildViews, sleeve, gunTip, VIEW, gun, GUNPOS, muzzle, ARMS, poseArms } from "./client/viewmodel.js";
import { KC, specNext, kcGot, hlGot, kcBegin, kcActive, kcEnd, spectating, kcCamera, kcBodies, specList } from "./client/killcam.js";

let interp = .1; const ests = [];

let PR = Math.min(devicePixelRatio, PHONE ? 1.25 : 1.5);
let shadowT = 0;
/* ── the map's look (the server says which map; its collision comes from sim.js, the same on both ends) ──────── */
function canvasTex(draw) { const c = document.createElement("canvas"); c.width = c.height = 256; draw(c.getContext("2d"), 256, 256); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }
function noise(g, w, h, base, spread, n = 9000) { g.fillStyle = base; g.fillRect(0, 0, w, h); for (let i = 0; i < n; i++) { const v = (Math.random() - .5) * spread; g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); } }
function standinLook(parts) {
  const mats = {
    stone: new THREE.MeshStandardMaterial({ map: canvasTex((g, w, h) => { noise(g, w, h, "#c9b48c", .16); g.strokeStyle = "rgba(90,70,40,.35)"; g.lineWidth = 2; for (let y = 0; y < h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); for (let x = (y / 32) % 2 ? 0 : 32; x < w; x += 64) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 32); g.stroke(); } } }), roughness: .92 }),
    floor: new THREE.MeshStandardMaterial({ map: canvasTex((g, w, h) => { noise(g, w, h, "#b09a74", .12); g.strokeStyle = "rgba(60,45,25,.3)"; for (let i = 0; i <= w; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); } }), roughness: .95 }),
    wood: new THREE.MeshStandardMaterial({ map: canvasTex((g, w, h) => { noise(g, w, h, "#8a6136", .18, 5000); g.strokeStyle = "rgba(40,22,8,.55)"; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6); g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.moveTo(w, 0); g.lineTo(0, h); g.stroke(); }), roughness: .8 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x6e604c, roughness: .95 })
  };
  const g = new THREE.Group(); for (const k in parts) if (parts[k].length) { const m = new THREE.Mesh(mergeGeometries(parts[k]), mats[k]); m.castShadow = m.receiveShadow = true; g.add(m); }
  /* decoration the server never sees: all of it on top of walls or above head height, so collision is unchanged */
  const deco = [], cap = new THREE.MeshStandardMaterial({ color: 0x9c8a66, roughness: .9 });
  const capBox = (x, y, z, sx, sz) => { const b = new THREE.BoxGeometry(sx + .2, .22, sz + .2); b.translate(x, y + .11, z); deco.push(b); };
  capBox(0, 6, -19.5, 54, 1); capBox(0, 6, 19.5, 54, 1); capBox(-26.5, 6, 0, 1, 38); capBox(26.5, 6, 0, 1, 38);
  for (const [z0, z1] of [[-19, -11], [-7, -1.6], [1.6, 7], [11, 19]]) capBox(0, 4, (z0 + z1) / 2, 1.2, z1 - z0);
  const cm = new THREE.Mesh(mergeGeometries(deco), cap); cm.castShadow = cm.receiveShadow = true; g.add(cm);
  const cloths = [0xb5432f, 0x2f6f73, 0xc99a2e, 0x6d3f7a];
  [[-18, -18.9, 0], [6, -18.9, 0], [16, 18.9, Math.PI], [-6, 18.9, Math.PI], [25.9, -4, -Math.PI / 2], [-25.9, 8, Math.PI / 2]].forEach(([x, z, ry], i) => {
    const a = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.8, 6, 2), new THREE.MeshStandardMaterial({ color: cloths[i % 4], roughness: .95, side: THREE.DoubleSide }));
    const pos = a.geometry.attributes.position; for (let k = 0; k < pos.count; k++) pos.setZ(k, Math.sin((pos.getX(k) + 2.1) / 4.2 * Math.PI) * .12);
    a.geometry.computeVertexNormals(); a.position.set(x, 3.4, z); a.rotation.set(-.55, ry, 0); a.translateZ(.85); a.castShadow = true; g.add(a); });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffd98a, emissive: 0xffb84d, emissiveIntensity: 1.2 }), iron = new THREE.MeshStandardMaterial({ color: 0x2b2622, roughness: .6, metalness: .5 });
  for (const [x, z] of [[-9.6, -2.6], [-9.6, 2.6], [.7, -12], [.7, 12], [17, -6.9]]) { const lamp = new THREE.Mesh(new THREE.SphereGeometry(.13, 10, 8), lampMat); lamp.position.set(x, 3.3, z); g.add(lamp);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(.015, .015, .5, 6), iron); rod.position.set(x, 3.65, z); g.add(rod); }
  return g;
}
/* map download progress, shown on the menu while you wait (collision first, then the look) */
let mapPct = 0; const prog = part => e => { if (e.total) { mapPct = Math.round((part ? 15 + 85 * e.loaded / e.total : 15 * e.loaded / e.total)); if (!connected && ws) $("load").textContent = "Loading the map " + mapPct + "%"; } };
/* today's map starts downloading the moment the menu opens, so Play is usually instant */
let preload = null; const getMap = id => { if (!preload) preload = { id, p: loadMap(id) }; return preload.id === id ? preload.p : null; };
async function loadMap(id) {
  const m = await fetch("maps/" + id + ".json", { cache: "no-store" }).then(r => r.json());
  let geoms;
  if (m.kind === "procedural") { const parts = standinParts(); scene.add(standinLook(parts)); geoms = Object.values(parts).flat(); }
  else {
    const gl = await gltf().loadAsync("maps/" + m.collision + BUST, prog(0)); geoms = gltfGeometries(gl.scene, m);
    if (m.visual) { const v = await gltf().loadAsync("maps/" + (TOUCH && m.visualMobile || m.visual) + BUST, prog(1));   // phones get a lighter cut of the same world v.scene.traverse(o => { if (o.isMesh) { const tx = o.material && o.material.map; o.material = new THREE.MeshBasicMaterial({ map: tx || null, vertexColors: !tx && !!o.geometry.attributes.color, side: THREE.DoubleSide, toneMapped: false }); } });   // its colours are already final: no second tone mapping
      v.scene.position.set(...(m.offset || [0, 0, 0])); v.scene.quaternion.setFromEuler(new THREE.Euler(...(m.rotate || [0, 0, 0]).map(d => d * DEG), "XYZ")); v.scene.scale.setScalar(m.scale || 1); scene.add(v.scene); }
    if (m.sky) scene.background = new THREE.Color(m.sky);
  }
  const w = new World(geoms), b = w.bounds, cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2, R = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * .6;
  // the sun's shadow covers the whole map
  sun.position.set(cx + 30, b.max.y + 60, cz + 20); sun.target.position.set(cx, 0, cz); const sc = sun.shadow.camera; sc.left = sc.bottom = -R; sc.right = sc.top = R; sc.near = 1; sc.far = 200; sc.updateProjectionMatrix();
  if (!scene.getObjectByName("sun-disc")) { const d = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xfff3d0, fog: false, depthWrite: false, transparent: true })); d.name = "sun-disc"; d.scale.setScalar(26);
    d.position.copy(sun.position.clone().sub(sun.target.position).normalize().multiplyScalar(240).add(sun.target.position)); scene.add(d); }
  return w;
}

/* ── people: one model for everyone, team-coloured, a name above the head ───── */
function label(text, col) {
  const c = document.createElement("canvas"); c.width = 256; c.height = 80; const g = c.getContext("2d"), tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })); s.scale.set(1.1, .34, 1); s.position.y = 2.05; s.renderOrder = 10;
  s.userData.draw = hp => { if (s.userData.hp === hp) return; s.userData.hp = hp; g.clearRect(0, 0, 256, 80);
    g.font = "600 30px ui-sans-serif,system-ui,sans-serif"; g.textAlign = "center"; g.lineWidth = 6; g.strokeStyle = "rgba(0,0,0,.7)"; g.strokeText(text, 128, 36); g.fillStyle = col; g.fillText(text, 128, 36);
    if (hp != null) { g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(58, 52, 140, 14); g.fillStyle = hp > 60 ? "#5fd38a" : hp > 30 ? "#f2c14e" : "#ef5b4b"; g.fillRect(60, 54, 136 * Math.min(100, Math.max(0, hp)) / 100, 10); if (hp > 100) { g.fillStyle = "#7fb6ff"; g.fillRect(60, 54, 136 * (hp - 100) / 100, 10); } }
    tex.needsUpdate = true; };
  s.userData.draw(100); return s;
}
/* names: a teammate's shows through walls (as in CS); an enemy's only while the crosshair is on them with a clear
   line of sight, and never through a wall (tags gave away enemies behind walls) */
function person(team, name) {
  const sd = soldier(team, name), tag = label(name, team ? "#ffd27a" : "#9cc6ff"); tag.position.y = 2.05; sd.root.add(tag);
  tag.userData.enemy = team !== myTeam; if (tag.userData.enemy) { tag.material.depthTest = true; tag.visible = false; }
  scene.add(sd.root); return { g: sd.root, sd, tag, phase: 0, last: null };
}
/* the generated fighters load after the page: whoever already stands in the code-built body gets theirs */
function reskin(m, team, name) {
  const sd = soldier(team, name), old = m.g; sd.root.position.copy(old.position); sd.root.rotation.copy(old.rotation); sd.root.visible = old.visible;
  old.remove(m.tag); sd.root.add(m.tag); scene.remove(old); dispose(old); scene.add(sd.root); m.g = sd.root; m.sd = sd;
}
/* ── pickups: weapons turning in the air, ammo crates ─────────────────────────── */
const pickups = new Map(); let nearPick = null;
const GHOST = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .14, depthWrite: false }); GHOST.userData.shared = true;
function pickupMesh(kind, w) {
  const g = new THREE.Group();
  if (kind === 2) {   // a kevlar vest standing on the floor
    const vm = new THREE.MeshStandardMaterial({ color: 0x3d4a55, roughness: .8 }), st = new THREE.MeshStandardMaterial({ color: 0x1f2428, roughness: .8 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(.42, .5, .14), vm); body.position.y = .45; g.add(body);
    for (const x of [-.14, .14]) { const sh = new THREE.Mesh(new THREE.BoxGeometry(.1, .12, .14), vm); sh.position.set(x, .76, 0); g.add(sh); }
    for (const y of [.33, .48]) { const sp = new THREE.Mesh(new THREE.BoxGeometry(.44, .04, .15), st); sp.position.y = y; g.add(sp); }
    const ring = new THREE.Mesh(new THREE.RingGeometry(.35, .42, 32), new THREE.MeshBasicMaterial({ color: 0x7fb6ff, transparent: true, opacity: .55, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .03; g.add(ring);
    const turn = new THREE.Group(); for (const c of [...g.children]) if (c !== ring) turn.add(c); g.add(turn); g.userData.spin = turn; scene.add(g); return g; }
  if (kind === 3) {   // a bandage box with a red cross
    const turn = new THREE.Group(), w = new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: .6 }), r = new THREE.MeshStandardMaterial({ color: 0xd2302c, roughness: .5 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(.36, .24, .24), w); turn.add(b);
    for (const z of [.121, -.121]) { const c1 = new THREE.Mesh(new THREE.BoxGeometry(.16, .05, .005), r), c2 = new THREE.Mesh(new THREE.BoxGeometry(.05, .16, .005), r); c1.position.z = c2.position.z = z; turn.add(c1, c2); }
    turn.position.y = .55; g.add(turn);
    const ring = new THREE.Mesh(new THREE.RingGeometry(.35, .42, 32), new THREE.MeshBasicMaterial({ color: 0xef5b4b, transparent: true, opacity: .55, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .03; g.add(ring);
    g.userData.spin = turn; scene.add(g); return g; }
  if (kind === 1) { const b = new THREE.Mesh(new THREE.BoxGeometry(.5, .32, .34), new THREE.MeshStandardMaterial({ color: 0x4d6b3a, roughness: .8 })); b.position.y = .16; g.add(b);
    const l = new THREE.Mesh(new THREE.BoxGeometry(.52, .06, .36), new THREE.MeshStandardMaterial({ color: 0xd9c25a, roughness: .6 })); l.position.y = .26; g.add(l); }
  else { const m = gunModel(w); m.traverse(o => { o.castShadow = false; }); m.scale.setScalar(1.25); m.rotation.y = Math.PI / 2; m.position.y = .85; g.add(m);
    const ring = new THREE.Mesh(new THREE.RingGeometry(.35, .42, 32), new THREE.MeshBasicMaterial({ color: w === "awp" ? 0xffb02e : 0x3fd0b0, transparent: true, opacity: .6, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = .03; g.add(ring); }
  g.userData.spin = kind === 0 ? g.children[0] : null; scene.add(g); return g;
}
function syncPickups(list) {
  const seen = new Set();
  for (const [id, kind, wi, x, y, z, wait] of list) { seen.add(id); let p = pickups.get(id); if (!p) { p = { id, kind, w: WIDS[wi], mesh: pickupMesh(kind, WIDS[wi]) }; pickups.set(id, p); } p.mesh.position.set(x, y, z); p.pos = p.mesh.position;
    // a taken pickup stays as a faint outline until it comes back
    const away = (wait || 0) > 0; if (p.away !== away) { p.away = away; p.mesh.traverse(o => { if (o.isMesh) { if (!o.userData.mat) o.userData.mat = o.material; o.material = away ? GHOST : o.userData.mat; } }); } }
  for (const [id, p] of pickups) if (!seen.has(id)) { scene.remove(p.mesh); p.mesh.traverse(o => { if (o.userData.mat) o.material = o.userData.mat; }); dispose(p.mesh); pickups.delete(id); }
}

/* removal frees the GPU memory too: geometries always, materials and textures unless marked shared */
function dispose(o) { o.traverse(x => { if (x.geometry && !x.geometry.userData.shared) x.geometry.dispose(); const ms = x.material ? (Array.isArray(x.material) ? x.material : [x.material]) : [];
  for (const m of ms) if (!m.userData.shared) { if (m.map && !m.map.userData.shared) m.map.dispose(); m.dispose(); } }); }
/* ── state ───────────────────────────────────────────────────────────────────── */
let W = null, ws = null, myId = 0, myTeam = 0, seq = 0, pending = [], connected = false;
const me = newPlayer(); me.clock = 0;
const others = new Map(), roster = new Map();
let srvOffset = null, ping = 0, respawnIn = 0, protect = 0, hitmark = 0, lastFire = 0;
const smooth = new THREE.Vector3();               // the visual correction after a reconcile, decayed away
/* a step up or down (audit 2026-11-23: the body now walks up 18 units in one tick, as in CS) moves the eye over a tenth of
   a second, as CS smooths it; a ramp climbs less than 10 cm a tick and is followed as it is */
let stepY = 0;
const keys = {}; let mouseDown = false, rmb = false, locked = false, reloadQ = false, slotQ = null, DEBUG = params.has("debug");
const releaseMouse = () => { mouseDown = rmb = false; };   // the buttons let go (chat, the buy menu)
addEventListener("contextmenu", e => e.preventDefault());
addEventListener("keydown", e => { if (e.target && e.target.id === "name") return;
  if (!$("chatin").hidden) return;
  if ((e.code === "KeyY" || e.code === "KeyU") && connected) { e.preventDefault(); openChat(e.code === "KeyU"); return; }
  if (e.code === "KeyZ" && connected) { radioMenu(!CHAT.radio); return; }
  if (CHAT.radio && (/^Digit[0-9]$/.test(e.code) || e.code === "Escape")) { if (e.code === "Escape") radioMenu(false); else sendRadio((+e.code.slice(5) + 9) % 10); e.preventDefault(); return; }
  if (e.code === "KeyB" && GM && compLike(GM.m)) { buyMenu(!BUY.open); return; }
  if (BUY.open && (/^Digit[0-9]$/.test(e.code) || e.code === "Escape" || e.code === "Backspace")) { buyKey(e.code); e.preventDefault(); return; }
  if (e.code === "Digit5") slotQ = "c";
  if (e.code === "KeyF" && me.alive) inspectT = 2.2; if ((e.code === "F1" || e.code === "F2") && VOTEON) { e.preventDefault(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "vote", y: e.code === "F1" })); VOTEON = false; $("vote").innerHTML += `<p>You voted ${e.code === "F1" ? "yes" : "no"}</p>`; return; }
  if (e.code === "F1") { e.preventDefault(); DEBUG = !DEBUG; return; } if (e.code === "Tab") e.preventDefault(); keys[e.code] = true; if (e.code === "KeyR") reloadQ = true; if (e.code === "Digit1") slotQ = "p"; if (e.code === "Digit2") slotQ = "s"; if (e.code === "Digit3") slotQ = "k"; if (e.code === "Digit4") slotQ = "g"; if (e.code === "KeyQ") slotQ = "q"; if (e.code === "KeyK" && !e.repeat) unstuck(); if (["Space", "ControlLeft"].includes(e.code)) e.preventDefault(); });
addEventListener("keyup", e => { keys[e.code] = false; });
addEventListener("mousedown", e => { if (BUY.free) { if (e.target === renderer.domElement) buyMenu(false); return; } if (!(locked || AUTO)) return; if (e.button === 1) { e.preventDefault(); sendPing(); return; } if (e.button === 0 && KC.on) { KC.skip = true; return; } if (e.button === 0 && SPEC.id) { specNext(); return; } if (e.button === 0) { mouseDown = true; dryFire(); } if (e.button === 2) rmb = true; });
addEventListener("mouseup", e => { if (e.button === 0) mouseDown = false; if (e.button === 2) rmb = false; });
addEventListener("wheel", e => { if (locked) slotQ = slotQ || "q"; }, { passive: true });
let swayX = 0, swayY = 0;
addEventListener("mousemove", e => { if (!locked || !connected || BUY.free) return; swayX = clamp(swayX + e.movementX * .00025, -.03, .03); swayY = clamp(swayY + e.movementY * .00025, -.03, .03); const k = SET.sens * .022 * DEG * zoomMul(); me.yaw -= e.movementX * k; me.pitch = clamp(me.pitch - (SET.inv ? -1 : 1) * e.movementY * k, -89 * DEG, 89 * DEG); });
/* player settings (2026-11-01, group feedback: "need settings like mouse sens, fov"): kept per browser.
   Sensitivity is on CS's own scale (0.022 degrees per mouse count x sens), so a CS player types their number;
   5.7 matches the original feel. FOV is vertical degrees (74 = CS's 90 on a 4:3 screen, seen at 16:9). */
const SET = Object.assign({ dmg: true, dink: true, kcam: true, hl: true, sens: 5.7, tsens: 1, fov: 74, vol: 80, inv: false, xh: "#5cff8a", crouch: "c", fin: "factory" },
  (() => { try { return JSON.parse(localStorage.getItem("fps-settings") || "{}"); } catch (e) { return {}; } })());
const saveSet = () => { try { localStorage.setItem("fps-settings", JSON.stringify(SET)); } catch (e) {} };
const zoomMul = () => { const W0 = wpn(me); return W0.zoom && me.zoom ? W0.zoom[me.zoom] : 1; };
addEventListener("blur", () => { for (const k in keys) keys[k] = false; mouseDown = rmb = false; });
/* the Settings panel: every control writes SET, saves it and takes effect at once */
(function(){
  const sens = $("setSens"), sensN = $("setSensN"), ts = $("setTsens"), fov = $("setFov"), vol = $("setVol"), inv = $("setInv"), xh = $("setXh");
  if (!sens) return;
  const paint = () => { sens.value = SET.sens; sensN.value = (+SET.sens).toFixed(2); ts.value = SET.tsens; $("setTsensV").textContent = (+SET.tsens).toFixed(2) + "x";
    fov.value = SET.fov; $("setFovV").textContent = SET.fov + "\u00b0"; vol.value = SET.vol; $("setVolV").textContent = SET.vol + "%";
    inv.setAttribute("aria-pressed", SET.inv); inv.textContent = SET.inv ? "On" : "Off";
    $("setCrouch").textContent = SET.crouch === "ctrl" ? "Ctrl" : "C"; const ck = $("kCrouch"); if (ck) ck.textContent = SET.crouch === "ctrl" ? "Ctrl" : "C";
    for (const b of xh.children) b.classList.toggle("on", b.dataset.c === SET.xh);
    for (const b of $("setFin").children) b.classList.toggle("on", b.dataset.f === SET.fin);
    document.documentElement.style.setProperty("--xh", SET.xh); };
  const put = (k, v) => { SET[k] = v; saveSet(); paint(); if (k === "vol" && MG) MG.gain.value = v / 100;
    if (k === "fin") { rebuildViews(); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "fin", f: v })); } };
  sens.addEventListener("input", () => put("sens", +sens.value));
  sensN.addEventListener("change", () => { const v = parseFloat(sensN.value); if (v > 0 && v <= 30) put("sens", Math.round(v * 100) / 100); else paint(); });
  ts.addEventListener("input", () => put("tsens", +ts.value));
  fov.addEventListener("input", () => put("fov", +fov.value));
  vol.addEventListener("input", () => put("vol", +vol.value));
  inv.addEventListener("click", () => put("inv", !SET.inv));
  // on/off switches for the 2026-11-17 additions: damage numbers, the headshot sound, the killcam, round highlights
  for (const b of document.querySelectorAll("[data-set]")) { const k = b.dataset.set, show = () => { b.setAttribute("aria-pressed", !!SET[k]); b.textContent = SET[k] ? "On" : "Off"; b.classList.toggle("on", !!SET[k]); };
    show(); b.addEventListener("click", () => { SET[k] = !SET[k]; saveSet(); show(); }); }
  $("setCrouch").addEventListener("click", () => put("crouch", SET.crouch === "ctrl" ? "c" : "ctrl"));
  xh.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) put("xh", b.dataset.c); });
  $("setFin").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) put("fin", b.dataset.f); });
  for (const el of [sens, sensN, ts, fov, vol]) el.addEventListener("keydown", ev => ev.stopPropagation());   // typing a number is not moving
  paint();
})();
/* ── phones: a floating stick under the left thumb, drag the right side to look, buttons for the rest ── */
function touchPlay(on) {
  setLocked(on); if (!on) return;
  try { const el = document.documentElement, fs = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fs && !document.fullscreenElement) Promise.resolve(fs.call(el, { navigationUI: "hide" })).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape")).catch(() => {}); } catch (e) {}
}
if (TOUCH) {
  const T = $("touch"), stick = $("stick"), knob = stick.firstElementChild, R = 50, SENS = .0052;
  let stickId = null, sx = 0, sy = 0; const look = new Map();   // touch id -> last x, y
  const press = (code, down) => { keys[code] = down; if (down && code === "KeyR") reloadQ = true; if (down && code === "KeyQ") slotQ = "q"; if (down && code === "Digit4") slotQ = "g"; if (down && code === "Digit2") slotQ = "s";
    if (down && code === "Digit5") slotQ = "c"; if (down && code === "Digit3") slotQ = "k"; if (down && code === "KeyF" && me.alive) inspectT = 2.2; if (down && code === "KeyB" && GM && compLike(GM.m)) buyMenu(!BUY.open); if (down && code === "KeyZ") radioMenu(!CHAT.radio); };
  const setStick = (dx, dy) => { const m = Math.hypot(dx, dy), k = m > R ? R / m : 1; dx *= k; dy *= k; knob.style.transform = `translate(${dx}px,${dy}px)`;
    const t = R * .3; keys.KeyW = dy < -t; keys.KeyS = dy > t; keys.KeyA = dx < -t; keys.KeyD = dx > t; keys.ShiftLeft = m > t && m < R * .7; };
  T.addEventListener("touchstart", ev => { ev.preventDefault(); audio(); touchesSeen++;
    for (const t of ev.changedTouches) { const b = t.target.closest && t.target.closest(".tb");
      if (b) { b.classList.add("dn");
        if (b.id === "tFire") { mouseDown = true; dryFire(); look.set(t.identifier, [t.clientX, t.clientY]); }
        else if (b.id === "tMenu") touchPlay(false);
        else if (b.dataset.toggle) { const c = b.dataset.toggle; keys[c] = !keys[c]; b.classList.toggle("on", keys[c]); }
        else if (b.dataset.zoom) rmb = true;
        else if (b.dataset.key) press(b.dataset.key, true);
        b._tid = t.identifier; continue; }
      if (t.clientX < innerWidth * .4 && stickId === null) { stickId = t.identifier; sx = t.clientX; sy = t.clientY; stick.style.left = sx + "px"; stick.style.top = sy + "px"; stick.classList.add("on"); setStick(0, 0); }
      else look.set(t.identifier, [t.clientX, t.clientY]); } }, { passive: false });
  T.addEventListener("touchmove", ev => { ev.preventDefault();
    for (const t of ev.changedTouches) {
      if (t.identifier === stickId) setStick(t.clientX - sx, t.clientY - sy);
      const l = look.get(t.identifier); if (l && connected) { const dx = t.clientX - l[0], dy = t.clientY - l[1], k = SENS * SET.tsens * zoomMul(); me.yaw -= dx * k; me.pitch = clamp(me.pitch - (SET.inv ? -1 : 1) * dy * k, -89 * DEG, 89 * DEG); swayX = clamp(swayX + dx * .0004, -.03, .03); l[0] = t.clientX; l[1] = t.clientY; } } }, { passive: false });
  const end = ev => { for (const t of ev.changedTouches) {
      if (t.identifier === stickId) { stickId = null; stick.classList.remove("on"); keys.KeyW = keys.KeyS = keys.KeyA = keys.KeyD = keys.ShiftLeft = false; }
      look.delete(t.identifier);
      for (const b of T.querySelectorAll(".tb.dn")) if (b._tid === t.identifier) { b.classList.remove("dn");
        if (b.id === "tFire") mouseDown = false; else if (b.dataset.zoom) rmb = false; else if (b.dataset.key) press(b.dataset.key, false); } } };
  T.addEventListener("touchend", end); T.addEventListener("touchcancel", end);
  // leaving the game (menu, rotate, app switch) lets go of everything held
  document.addEventListener("visibilitychange", () => { if (document.hidden && locked) touchPlay(false); });
}
/* "locked" = playing with input captured: the mouse locked on a computer, the touch controls up on a phone */
function setLocked(on) { $("play").textContent = connected ? "Resume" : "Continue"; $("play").hidden = !ws; $("priv").hidden = !!ws; $("leave").hidden = !connected; $("unstuck").hidden = !connected; $("share").hidden = !(connected && currentRoom !== "DAILY"); if (!on) { for (const k in keys) keys[k] = false; rmb = false; mouseDown = false; for (const b of document.querySelectorAll(".tb.on,.tb.dn")) b.classList.remove("on", "dn"); } locked = on; if (locked && connected) $("load").textContent = ""; $("start").style.display = (locked && connected) || AUTO ? "none" : ""; if (!locked) mouseDown = false;  document.body.classList.toggle("playing", locked && connected); }
document.addEventListener("pointerlockchange", () => { if (TOUCH) return; const on = document.pointerLockElement === renderer.domElement; if (!on && BUY.free && BUY.open) return; setLocked(on); });   // the buy menu frees the mouse without pausing

let SPOTTED = [], DECOYDOTS = [];   // from each snapshot: enemies a teammate sees, decoys (drawn by client/radar.js)
let lastStrip = "";   // the grenade strip as last written (render)
let killerId = 0, myStep = 0, myDeath = null, wasAlive = true, diedAt = -9, deathEye = 1.6, deathRoll = .4;
/* dying: the view drops and rolls to the floor, colour drains, sound muffles, then the camera finds the killer and a card
   says who, with what, and how the fight went; on respawn the world fades back in from black and the card stays a moment,
   fading, so it can be read without a longer respawn (operator, 2026-11-15: "keep 3 and card up") */
const KC_AFTER = 2000;
let kcTimer = 0;
/* the fight with your killer in one line: what you did to them, and what they had left */
function dmgLine(kid, hp) {
  const g = (LIFE.given.get(kid) || { d: 0 }).d;
  return `<div class="km"><span>You hit them <b>${g}</b>${hp != null ? `, they have <b>${hp}</b> left` : ""}</span></div>`;
}
function onDeath() {
  diedAt = nowS(); deathEye = eye(me) || 1.6; deathRoll = (Math.random() < .5 ? -1 : 1) * (.35 + Math.random() * .2);
  deathSound(); muffle(true); document.body.classList.add("dead");
  const hu = $("hurt"); hu.style.transition = "box-shadow .12s"; hu.style.boxShadow = "inset 0 0 220px rgba(210,25,15,.85)";
  setTimeout(() => { hu.style.transition = "box-shadow 1.2s"; hu.style.boxShadow = "inset 0 0 260px rgba(0,0,0,.92)"; }, 180);
  const e = myDeath && myDeath.id === myId ? myDeath : null, kid = e ? e.by : killerId, ktm = (roster.get(kid) || {}).team, wn = e ? (WEAPONS[WIDS[e.g]] || {}).name || "" : "";
  const self = kid === myId, hp = e && e.kh != null ? e.kh : null;
  clearTimeout(kcTimer); $("kc").classList.remove("after");
  $("kc").innerHTML = `<span class="kl">${self ? "You died" : "Killed by"}</span>
    <div class="kn ${ktm ? "t" : "ct"}">${esc(self ? "Your own hand" : nameOf(kid))}${e && e.h ? '<span class="hs">Headshot</span>' : ""}</div>
    ${e && !self ? `<div class="km"><span><b>${esc(wn)}</b>, ${e.kd} m</span></div>` : ""}
    ${!self ? dmgLine(kid, hp) : ""}
    <div class="rs"><span id="kcrt">Respawning</span><span class="bar2"><i id="kcr"></i></span></div>`;
  $("kc").hidden = !!(GM && !dmLike(GM.m)); myDeath = null;
}
function onRespawn() {
  muffle(false); document.body.classList.remove("dead");
  const kc = $("kc"); if (!kc.hidden) { kc.classList.add("after"); clearTimeout(kcTimer); kcTimer = setTimeout(() => { kc.hidden = true; kc.classList.remove("after"); }, KC_AFTER); }
  const hu = $("hurt"); hu.style.transition = "box-shadow .4s"; hu.style.boxShadow = "";
  const f = $("fade"); f.style.transition = "none"; f.style.opacity = .85; requestAnimationFrame(() => requestAnimationFrame(() => { f.style.transition = "opacity .45s ease-out"; f.style.opacity = 0; }));
}
function feed(html, cls = "") { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; $("feed").prepend(d); setTimeout(() => d.remove(), 5000); while ($("feed").children.length > 6) $("feed").lastChild.remove(); }
const nameOf = id => id === myId ? "You" : (roster.get(id) || {}).name || "#" + id;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let KICKW = {}, flash = 0, kick = 0, bob = 0, swing = 0, shake = 0, fovPunch = 0;
const recoilFx = (f, k) => { flash = f; kick = k(kick); };   // a shot's muzzle flash and kick (the killcam's gun)
let DRAWK = 0;   // the draw's progress, 1 at its start to 0 when the gun is up
/* ── the network ─────────────────────────────────────────────────────────────── */
const serverNow = () => srvOffset == null ? 0 : nowS() + srvOffset;      // the server's clock, estimated
const viewTime = () => serverNow() - interp;                              // the moment the others are drawn at
function connect(q) {
  // relative to the page, so the game works at / or under a sub-path such as /play/ behind a reverse proxy
  const wsu = new URL("ws?" + new URLSearchParams(q), location.href); wsu.protocol = wsu.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(wsu.href);
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === "s") onSnap(m); else if (m.t === "kc") kcGot(m); else if (m.t === "hl") hlGot(m); else if (m.t === "dcres") onDcResult(m); else if (m.t === "w") onWelcome(m); else if (m.t === "r") onRoster(m.r); else if (m.t === "x") refused = m.why; else if (m.t === "newmap") { movingTo = m.why; $("big").innerHTML = `New map<small>${esc(m.why)}, loading${m.best ? `<br>Top of the last map: ${esc(m.best.name)}, ${m.best.k} kills` : ""}</small>`;
    try { sessionStorage.setItem("rejoin", JSON.stringify({ room: currentRoom, team, t: Date.now() })); } catch (e) {} setTimeout(() => location.reload(), m.best ? 3500 : 1500); } else if (m.t === "P") { ping = Math.round((nowS() - m.n) * 1000); ws.send(JSON.stringify({ t: "q", ms: ping })); } };
  ws.onclose = () => { if (!connected) { $("load").textContent = refused || "Could not join that room"; ws = null; refused = ""; $("start").style.display = ""; document.exitPointerLock && document.exitPointerLock(); return; }
    connected = false; if (movingTo) return;
    $("msg").innerHTML = "Connection lost<small>rejoining</small>";   // the server restarted or the network dropped: come straight back
    try { sessionStorage.setItem("rejoin", JSON.stringify({ room: currentRoom, team, t: Date.now(), lost: 1 })); } catch (e) {} setTimeout(() => location.reload(), 2000); };
}
let roomNoteUntil = 0, rejoined = false, currentRoom = "DAILY", movingTo = "", refused = "", GM = null, lastBoard = [], lastSpawn = 0, rosterRaw = null, mapLoadedFor = null;
async function onWelcome(m) {
  const sock = ws;
  myId = m.id; myTeam = m.team; LADDER = m.ladder || null; setLineups(m.lineups); srvOffset = m.tm - nowS(); if (m.radar) radarMap(m.radar); setSites(m.sites); { const cm = sleeveMaterial(myTeam); sleeve.map = cm.map; sleeve.bumpMap = cm.bumpMap; sleeve.bumpScale = cm.bumpScale; sleeve.color.set(0xffffff); sleeve.needsUpdate = true; }   // your own sleeves in your team\'s camouflage
  currentRoom = m.room;
  $("roomtag").textContent = m.room === "DAILY" ? m.title.toUpperCase() : "ROOM " + m.room; $("rcode").textContent = m.room;
  if (m.room !== "DAILY") { roomNoteUntil = nowS() + 8; if (!locked) $("share").hidden = false; } history.replaceState(null, "", m.room === "DAILY" ? "./" : "?room=" + m.room);
  if (mapLoadedFor !== m.map) { const pm = getMap(m.map);
    if (!pm) { try { sessionStorage.setItem("rejoin", JSON.stringify({ room: currentRoom, team, t: Date.now(), lost: 1, map: m.map })); } catch (e) {} location.reload(); return; }
    $("load").textContent = "Loading the map " + mapPct + "%"; W = await pm; mapLoadedFor = m.map; $("load").textContent = ""; }
  if (ws !== sock || !sock || sock.readyState !== 1) return;   // closed while loading: stay on the menu
  if (rejoined) { $("load").textContent = (rejoined === "lost" ? "Reconnected" : "New map: " + m.title) + ". Press Play to continue."; rejoined = false; }
  connected = true; setLocked(locked); if (locked) { $("start").style.display = "none"; document.body.classList.add("playing"); } $("team").textContent = TEAM[myTeam]; $("team").className = myTeam ? "t" : "ct"; $("team").textContent = TEAM[myTeam];
  setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "p", n: nowS() })), 1000);
}
function hpCell(x) {
  // others' alive is the snapshot's 0/1 (it was tested against false, so the board never showed anyone else dead)
  const o = others.get(x.id), alive = x.id === myId ? me.alive : o && o.alive != null ? !!o.alive : true, hp = x.id === myId ? me.hp : o ? o.hp : null;
  if (!alive) return '<small>dead</small>';
  return x.team === myTeam ? (hp ?? 100) : '<small>alive</small>';
}
function onRoster(r) {
  rosterRaw = r;
  roster.clear(); for (const [id, name, team, bot, k, d, p, a, dm, fin, gl] of r) roster.set(id, { id, name, team, bot, k, d, p, a: a || 0, dm: dm || 0, fin: FINISHES[fin] || "factory", gl });
  const rows = [...roster.values()].sort((a, b) => a.team - b.team || b.k - a.k);
  $("board").innerHTML = (GM && GM.ph === "over" ? `<h3>${esc(GM.msg)}</h3>` : "") + `<table><tr><th>Atlas / Ember</th><th>HP</th><th>K</th><th>A</th><th>D</th><th>DMG</th>${GM && compLike(GM.m) && GM.m !== "rt" ? "<th>$</th>" : ""}${GM && GM.m === "gg" ? "<th>LVL</th>" : ""}<th>ping</th></tr>` + rows.map(x => `<tr class="${x.team ? "t" : "ct"}${x.id === myId ? " me" : ""}"><td>${esc(x.name)}${x.bot ? " <small>bot</small>" : ""}</td><td>${hpCell(x)}</td><td>${x.k}</td><td>${x.a}</td><td>${x.d}</td><td>${x.dm}</td>${GM && compLike(GM.m) && GM.m !== "rt" ? `<td>${x.team === myTeam && TMO.has(x.id) ? "$" + TMO.get(x.id) : ""}</td>` : ""}${GM && GM.m === "gg" ? `<td>${(x.gl || 0) + 1}</td>` : ""}<td>${x.bot ? "" : x.p}</td></tr>`).join("") + "</table>";
  lastBoard = rows;
  for (const o of others.values()) if (roster.get(o.id) && o.named !== roster.get(o.id).name) { o.model.g.remove(o.model.tag); dispose(o.model.tag); o.model.tag = label(roster.get(o.id).name, o.team ? "#ffd27a" : "#9cc6ff"); o.model.tag.position.y = 2.05; o.model.tag.userData.enemy = o.team !== myTeam; if (o.model.tag.userData.enemy) o.model.tag.material.depthTest = true; o.model.tag.userData.draw(o.hp ?? 100); o.model.g.add(o.model.tag); o.named = roster.get(o.id).name; }
}
let snapN = 0;
function onSnap(m) {
  if (!W) return; snapN++;
  // the server's clock: follow the newest estimate smoothly; a jump of half a second or more is taken at once
  // the server clock: the least-delayed packets of the last two seconds say it best; follow them slowly, so a
  // jittery connection does not shake everyone else on screen. The interpolation delay grows with the jitter
  const est = m.tm - nowS(); ests.push(est); if (ests.length > 128) ests.shift();   // the last two seconds
  const hi = Math.max(...ests), lo = Math.min(...ests);
  if (srvOffset == null || Math.abs(hi - srvOffset) > .3) srvOffset = hi; else srvOffset += clamp(hi - srvOffset, -.002, .002);
  /* two updates' spacing plus the jitter seen (audit 2026-11-23; was at least 100 ms, three times CS's 31): the others
     are drawn about as late as CS draws them, so someone peeking you shows up some 70 ms sooner than before */
  interp = clamp(2 / 64 + (hi - lo) + .004, .035, .25);
  // reconcile: the server's state after the last command it ran, then the commands still in flight replayed on top
  // your own state comes every other update (the others every one): only then is there anything to reconcile
  const y = m.me; if (y) { const before = me.pos.clone();
  me.pos.set(y.p[0], y.p[1], y.p[2]); me.vel.set(y.v[0], y.v[1], y.v[2]); me.duck = y.d; me.onGround = y.g; me.jumpHeld = y.j; me.hp = y.h; me.alive = y.al;
  me.mag = y.m; me.res = y.r; me.reloadAt = y.ra; me.nextShot = y.ns; me.spray = y.sp; me.lastShot = y.ls; me.punchX = y.px; me.punchY = y.py; me.acc = y.ac || 0; me.tag = y.tg || 0; me.stamina = y.st || 0; me.landed = !!y.ld; me.clock = y.ck;
  respawnIn = y.ra2 || 0; protect = y.pr || 0;
  if (y.sn && y.sn !== lastSpawn) { lastSpawn = y.sn; me.yaw = y.syw; me.pitch = 0; }
  me.w = y.w; me.prim = y.pm; me.last = y.la; me.zoom = y.z; me.deployUntil = y.du; me.zoomHeld = y.zh;
  if (y.sc !== undefined) { me.sec = y.sc; me.pa = y.pa.slice(); me.sa = y.sa.slice(); me.trig = !!y.tr; me.cock = y.co || 0; NADES.forEach((n, i) => { me.nades[n] = y.nd[i]; });
    me.armor = y.ar || 0; me.helmet = !!y.hm; setBlind(y.bl || 0);
    me.zeus = !!y.zs; me.burstOn = !!y.bo; me.burstLeft = y.bl2 || 0; me.mo = y.mo; me.kit = !!y.kit; me.c4 = !!y.c4; me.ib = !!y.ib; me.pp = y.pp || 0; me.dp = y.dp || 0;
    if (y.te !== undefined && y.te !== myTeam) { myTeam = y.te; const cm = sleeveMaterial(myTeam); sleeve.map = cm.map; sleeve.bumpMap = cm.bumpMap; sleeve.needsUpdate = true;   // sides swapped at halftime
      $("team").textContent = TEAM[myTeam]; $("team").className = myTeam ? "t" : "ct"; for (const o of others.values()) if (o.model.tag) o.model.tag.userData.enemy = o.team !== myTeam; } }
  pending = pending.filter(c => c.seq > m.a);
  const yaw = me.yaw, pitch = me.pitch;   // (a spawn turn above already set these)
  const bl = blockers(); for (const c of pending) { me.clock += DT; move(W, me, c); block(me, bl); weapon(me, c, me.clock, 0); }
  me.yaw = yaw; me.pitch = pitch;
  const err = before.sub(me.pos); if (err.lengthSq() < 4) smooth.add(err); else smooth.set(0, 0, 0); corrMax = Math.max(corrMax, err.length()); }
  if (m.pk) syncPickups(m.pk);   // pickups when they changed, grenades every update; the rest with your own state
  syncFx(m); if (m.sp) SPOTTED = m.sp; if (m.dc) DECOYDOTS = m.dc; syncComp(m); for (const e of m.pv || []) onTalk(e);
  // everyone else: snapshots kept to draw between
  const seen = new Set();
  for (const [id, team, , x, yy, z, yw, pt, dk, al, vx, vz, wi, hp, vis, ga, air] of m.e) {
    if (id === myId) continue; seen.add(id);
    let o = others.get(id); if (!o) { o = { id, team, model: person(team, nameOf(id)), named: nameOf(id), buf: [] }; others.set(id, o); }
    if (o.gone) { o.gone = false; o.buf.length = 0; o.model.last = null; }   // back in view: start fresh, no slide from where it vanished
    o.vis = vis !== 0;
    o.buf.push({ tm: m.tm, x, y: yy, z, yaw: yw, pitch: pt, duck: dk, alive: al, vx, vz, ga, air: air || 0 }); if (o.buf.length > 40) o.buf.shift();
    o.model.sd.setWeapon(WIDS[wi] || "ak", (roster.get(id) || {}).fin || "factory"); o.w = WIDS[wi] || "ak"; o.hp = hp; o.model.tag.userData.draw(hp ?? null);
  }
  // someone not in this update is out of sight (kept, hidden) or has left the room (removed once the roster drops them)
  for (const [id, o] of others) if (!seen.has(id)) { if (rosterRaw && !roster.has(id) && o.gone) { scene.remove(o.model.g); dispose(o.model.g); others.delete(id); } else { o.gone = true; o.vis = false; } }
  if (m.gm) { const ph = GM && GM.ph; GM = m.gm; if (ph !== GM.ph && rosterRaw) onRoster(rosterRaw); }
  for (const e of m.ev) onEvent(e);
}
/* this life's damage, given and taken, by player: the death card reports it (2026-11-14) */
const LIFE = { given: new Map(), taken: new Map() };
function onEvent(e) {
  if (e.k === "hit" && (e.by === myId) !== (e.id === myId)) { const b = e.by === myId ? LIFE.given : LIFE.taken, who = e.by === myId ? e.id : e.by, r = b.get(who) || { d: 0, n: 0 }; r.d += e.d; r.n++; b.set(who, r); }
  if (e.k === "spawn" && e.id === myId) { LIFE.given.clear(); LIFE.taken.clear(); }
  if (e.k === "shot" && e.id !== myId) { const a = new THREE.Vector3(...e.f), b = new THREE.Vector3(...e.t); const aw = WIDS[e.g] === "awp"; tracer(a.clone().lerp(b, .02), b, WIDS[e.g]); at(a, () => gunSound(WIDS[e.g], clamp(1 - a.distanceTo(camera.position) / (aw ? 120 : 60), aw ? .25 : .08, .8), a.distanceTo(camera.position) < 18)); if (aw && a.distanceTo(camera.position) < 25) shake = Math.max(shake, .25);
    flashAt(a.clone().lerp(b, Math.min(.9, .7 / Math.max(.7, a.distanceTo(b)))));
    // their bullet holes and sparks by calibre (2026-11-24: a puff alone before), and their gun throws its case
    if (e.w) { const dv = b.clone().sub(a), L = dv.length(); dv.divideScalar(L || 1); const h = b.distanceTo(camera.position) < 40 && W.first(a, dv, L + .5); if (h) impact(h, dv, WIDS[e.g]); else puff(b, 0xb8a888, 6, .1); }
    { const sh = others.get(e.id), last = sh && sh.buf[sh.buf.length - 1]; if (sh && sh.model.g.visible) ejectOther(e.id, WIDS[e.g], a, b, last ? new THREE.Vector3(last.vx, 0, last.vz) : null); }
    if (me.alive) { const ab = b.clone().sub(a), L = ab.length(); if (L > 1) { ab.divideScalar(L); const c = camera.position, tt = clamp(c.clone().sub(a).dot(ab), 0, L), pc = a.clone().addScaledVector(ab, tt), miss = pc.distanceTo(c);
      if (tt > .5 && tt < L - .3 && miss < 2.5) { const v = clamp(1 - miss / 2.5, .15, 1); at(pc, () => (SUBSONIC.has(WIDS[e.g]) ? whiz : crack)(v)); } } }   // it passed you
    if (e.w && b.distanceTo(camera.position) < 14) at(b, () => impactSound(clamp(1 - b.distanceTo(camera.position) / 14, .1, 1))); }
  else if (e.k === "melee" && e.id !== myId) { swish(clamp(1 - new THREE.Vector3(...e.f).distanceTo(camera.position) / 20, .05, .8)); }
  else if (e.k === "ammo" && e.id === myId) { tink(1000); feed("Ammo refilled"); }
  else if (e.k === "pick" && e.id === myId) { tink(1400); }
  else if (e.k === "kevlar" && e.id === myId) { tink(1200); feed("Kevlar and helmet"); }
  else if (e.k === "buy" && e.id === myId) { tink(1700); feed("Bought " + esc(itemName(e.i))); drawBuy(); }
  else if (e.k === "plantStart" || e.k === "defuseStart") { const o = e.id === myId ? null : others.get(e.id); if (o) act(o, e.k === "plantStart" ? "plant" : "defuse", e.k === "plantStart" ? 3.2 : e.kit ? 5 : 10); at(o ? o.model.g.position : camera.position, () => beep(e.k === "plantStart" ? 1800 : 1200, .08, .3)); }
  else if (e.k === "planted") { feed(`The bomb has been planted at <b>${esc((SITES_C[e.site] || [])[0] || "")}</b>`, "mine"); beep(2600, .12, .5); }
  else if (e.k === "defused") { feed(`${esc(nameOf(e.id))} defused the bomb`, "mine"); beep(900, .3, .4); }
  else if (e.k === "bombDrop" && myTeam === 1) feed("The bomb has been dropped");
  else if (e.k === "bombPick" && myTeam === 1) feed(`${esc(nameOf(e.id))} picked up the bomb`);
  else if (e.k === "reload" && e.id !== myId) { const o = others.get(e.id); if (o) act(o, "reload", (WEAPONS[WIDS[e.w]] || {}).reload || 2.2); if (o && o.vis !== false) { const d = o.model.g.position.distanceTo(camera.position); if (d < 22) at(o.model.g.position, () => reloadSound(clamp(1 - d / 22, .05, .6), WIDS[e.w])); } }
  else if (e.k === "pin" && e.id !== myId) { const o = others.get(e.id); if (o) act(o, "cock", .35, 6); if (o) { const d = o.model.g.position.distanceTo(camera.position); if (d < 15) at(o.model.g.position, () => pinSound(clamp(1 - d / 15, .1, 1))); } }
  else if (e.k === "throw" && e.id !== myId && others.get(e.id)) act(others.get(e.id), "throw", .45);
  if (e.k === "throw" && e.id !== myId && (roster.get(e.id) || {}).team === myTeam) { chatLine(`<small>radio</small> <b class="${myTeam ? "t" : "ct"}">${esc(nameOf(e.id))}</b>: ${["Fire in the hole!", "Flashbang out!", "Smoke out!", "Molotov out!"][e.n] || "Grenade out!"}`); beep(880, .04, .2); }
  else if (e.k === "decoy") { const p = new THREE.Vector3(...e.p), d = p.distanceTo(camera.position); if (d < 70) at(p, () => gunSound(WIDS[e.g], clamp(1 - d / 70, .06, .7), false)); }
  else if (e.k === "voteStart") { const mine = e.team < 0 ? e.t !== myId : e.team === myTeam;
    const what = e.kind === "kick" ? `Kick <b>${esc(nameOf(e.t))}</b> from the room?` : `${esc(TEAM[e.team] || "")}: surrender the match?`;
    chatLine(`<small>vote</small> ${esc(nameOf(e.by))} called a vote: ${what}`);
    if (mine) { VOTEON = e.by !== myId; $("vote").hidden = false; $("vote").innerHTML = `<h4>${what}</h4>` + (VOTEON ? `<div class="vb"><button type="button" data-y="1">Yes${TOUCH ? "" : " <kbd>F1</kbd>"}</button><button type="button" data-y="0">No${TOUCH ? "" : " <kbd>F2</kbd>"}</button></div>` : `<p>You called this vote</p>`); clearTimeout(voteTimer); voteTimer = setTimeout(() => { $("vote").hidden = true; VOTEON = false; }, 21000); } }
  else if (e.k === "voteEnd") { VOTEON = false; $("vote").hidden = true; clearTimeout(voteTimer); chatLine(`<small>vote</small> ${e.pass ? "Passed" : "Failed"}${e.kind === "kick" ? `: kick ${esc(nameOf(e.t))}` : ": surrender"}`); }
  else if (e.k === "moved" && e.id === myId) chatLine(`<small>teams</small> You were moved to ${esc(TEAM[e.team] || "")} to balance the teams`);
  else if (e.k === "half") { feed("Halftime: switching sides", "mine"); tink(1000); }
  else if (e.k === "boom") { const p = new THREE.Vector3(...e.p), v = fxVol(e.p), near = clamp(1 - p.distanceTo(camera.position) / 14, 0, 1);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: e.n ? 0xffffff : 0xffb25a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sp.position.copy(p); sp.scale.setScalar(e.n === 2 ? 14 : e.n === 3 ? .8 : e.n ? 2.4 : 3.2); sp.userData = { v: new THREE.Vector3(), life: e.n === 2 ? .4 : e.n ? .08 : .14, age: 0, flash: true }; scene.add(sp); parts.push(sp);
    if (e.n !== 1) { puff(p, 0x6b625a, e.n === 2 ? 40 : 14, e.n === 2 ? 1.6 : .6, 1.4); shake = Math.max(shake, e.n === 2 ? 1 : near); } at(p, () => (e.n === 1 ? flashSound : boomSound)(e.n === 2 ? 1.6 : v)); }
  else if (e.k === "flashed" && e.id === myId) { setBlind(Math.max(blindLeft, e.d)); tink(3100); }
  else if (e.k === "smoke") at(new THREE.Vector3(...e.p), () => noiseHit(.5 * fxVol(e.p), 2.2, 1800, .6));
  else if (e.k === "fire") at(new THREE.Vector3(...e.p), () => noiseHit(.7 * fxVol(e.p), .7, 1200, 1.2));
  else if (e.k === "fizzle") at(new THREE.Vector3(...e.p), () => noiseHit(.4 * fxVol(e.p), .5, 3000, 1.5));
  else if (e.k === "bounce") { if (new THREE.Vector3(...e.p).distanceTo(camera.position) < 25) at(new THREE.Vector3(...e.p), () => tink(e.n === 3 ? 700 : 1400)); }
  else if (e.k === "bandage" && e.id === myId) { tink(1500); feed("Bandaged, +40 health"); }
  else if (e.k === "roundEnd") tink(e.w === myTeam ? 1600 : 500);
  else if (e.k === "match") tink(e.w === myTeam ? 2000 : 400);
  else if (e.k === "hit") { const v = others.get(e.id); if (v) { const dk = v.vd || 0, hy = e.h ? C.eyeStand + (C.eyeCrouch - C.eyeStand) * dk + .04 : 1.2 * (C.stand + (C.crouch - C.stand) * dk) / C.stand;   // where the hit box is, crouched or not
    puff(v.model.g.position.clone().setY(v.model.g.position.y + hy), 0x9a1010, 8, .1, .4); }
    if (e.id === myId) { hurtFrom(e.by); $("hurt").style.boxShadow = "inset 0 0 140px rgba(255,40,30,.55)"; setTimeout(() => $("hurt").style.boxShadow = "", 160); bodyHit(!!e.h); } else if (e.by === myId) { if (e.h && SET.dink) headDink(); else tink(e.h ? 2200 : 1300); if (SET.dmg) dmgNum(e); hitmark = performance.now() + 120; window.__hits = (window.__hits || 0) + 1; } }
  else if (e.k === "level") { const r = roster.get(e.id); if (r) r.gl = e.l;
    if (e.id === myId && LADDER) { const w = LADDER[Math.min(e.l, LADDER.length - 1)]; feed(e.down ? `Knifed: down to level ${e.l + 1}` : w === "knife" ? "Last level: the knife" : `Level ${e.l + 1}: ${esc((WEAPONS[w] || {}).name || w)}`); if (!e.down) tink(1500); } }
  else if (e.k === "kill") { const hs = e.h ? " hs" : ""; if (e.id === myId) { killerId = e.by; myDeath = e; }
    const tags = [e.bl && "blind", e.ns && "no scope", e.sm && "through smoke", e.pn && "wallbang"].filter(Boolean).map(t => `<small class="tg">${t}</small>`).join(" ");
    feed(`${esc(nameOf(e.by))}${e.a ? ` <small>+</small> ${esc(nameOf(e.a))}${e.fa ? " <small>(flash)</small>" : ""}` : ""} <small>${esc((WEAPONS[WIDS[e.g]] || {}).name || "")}</small> ${tags} <b>${e.h ? "&#9673;" : "&#8594;"}</b> ${esc(nameOf(e.id))}`, (e.by === myId || e.id === myId || e.a === myId ? "mine" : "") + hs); }
}

/* ── the client's own ticks: input to a command, predicted at once, sent in batches ─ */
let acc = 0, last = nowS(), outbox = [];
function tickInput() {
  const cmd = { seq: ++seq, f: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), jump: !!keys.Space, duck: !!(keys.TouchDuck || (SET.crouch === "ctrl" ? (keys.ControlLeft || keys.ControlRight) : keys.KeyC)),   /* the phone button has its own key, whatever the keyboard uses (it toggled Ctrl after the switch to C, 2026-11-17) */
    walk: !!keys.ShiftLeft, fire: mouseDown && (locked || AUTO), reload: reloadQ, yaw: me.yaw, pitch: me.pitch, vt: +viewTime().toFixed(4),
    slot: slotQ, zoom: rmb && (locked || AUTO), use: !!keys.KeyE };
  if (GM && GM.fz) { cmd.f = cmd.s = 0; cmd.jump = cmd.fire = false; }
  reloadQ = false; slotQ = null; me.clock += DT;
  const fy0 = me.pos.y, g0 = me.onGround;
  move(W, me, cmd); block(me, blockers());
  { const dy = me.pos.y - fy0; if (g0 && me.onGround && Math.abs(dy) > .1 && Math.abs(dy) < .6) stepY -= dy; }   // a step: the eye follows over a moment (render)
  const s = weapon(me, cmd, me.clock, (myId * 100003 + cmd.seq) >>> 0);
  if (s && s.nade) { swish(.8); swing = 1; lastFire = performance.now(); }
  else if (s && s.melee) { swish(1); swing = 1; lastFire = performance.now(); }
  else if (s) {   // the predicted shot: tracer, decal and sound now; the damage is the server's to decide
    const o = new THREE.Vector3(me.pos.x, me.pos.y + eye(me), me.pos.z), aw = me.w === "awp";
    for (const d of s.dirs || [s.dir]) { const h = W.first(o, d, 300); tracer(gunTip(), o.clone().addScaledVector(d, h ? h.distance : 300), me.w); if (h) impact(h, d, me.w); } gunSound(me.w, 1);
    ejectShell(me.w); if (muzzleLight) { muzzleLight.position.copy(gunTip()); muzzleLight.intensity = aw ? 60 : 30; } { const F = WEAPONS[me.w] || {}; flash = F.fl ?? .045; kick = F.vk ?? 1; KICKW = F; } if (aw) { shake = 1; fovPunch = 1; $("hurt").style.transition = "none"; $("hurt").style.boxShadow = "inset 0 0 160px rgba(255,236,200,.35)"; setTimeout(() => { $("hurt").style.transition = "box-shadow .3s"; if (me.alive) $("hurt").style.boxShadow = ""; }, 60); } lastFire = performance.now();
  }
  pending.push(cmd); outbox.push(cmd); if (pending.length > 256) pending.shift();
}
let qT = 0, qN = 0, qLevel = PHONE ? 2 : 0, qLast = nowS();
/* diagnostics: phones cannot be debugged from here, so the page reports what it sees (once ~8 s into a game, and on errors) */
const diagStart = nowS(); let fpsNow = 0, cmdsSent = 0, diagSent = false, touchesSeen = 0;
function diag(kind, extra = {}) { try { const gl = renderer.getContext(), dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const body = JSON.stringify({ kind, ua: navigator.userAgent, touch: TOUCH, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, fps: +fpsNow.toFixed(1), q: qLevel, connected, locked,
    playing: document.body.classList.contains("playing"), alive: me.alive, pos: [+me.pos.x.toFixed(1), +me.pos.y.toFixed(1), +me.pos.z.toFixed(1)], yaw: +me.yaw.toFixed(2), cmds: cmdsSent, touches: touchesSeen,
    pending: pending.length, gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?", lost: gl.isContextLost(), up: +(nowS() - diagStart).toFixed(1), ...extra });
  navigator.sendBeacon ? navigator.sendBeacon("diag", body) : fetch("diag", { method: "POST", body, keepalive: true }); } catch (e) {} }
addEventListener("error", e => diag("error", { msg: String(e.message).slice(0, 300), at: (e.filename || "").split("/").pop() + ":" + e.lineno }));
addEventListener("unhandledrejection", e => diag("reject", { msg: String(e.reason && (e.reason.stack || e.reason)).slice(0, 300) }));
/* a phone that runs out of graphics memory loses the context: the screen froze broken (2026-11-22). Ask for it back, and if
   it does not come back within 4 s, reload the page (the rejoin note puts the player straight back in the match) */
let lostTimer = 0;
renderer.domElement.addEventListener("webglcontextlost", e => { e.preventDefault(); diag("contextlost"); clearTimeout(lostTimer); lostTimer = setTimeout(() => { try { if (connected) sessionStorage.setItem("rejoin", JSON.stringify({ room: currentRoom, team, t: Date.now(), lost: 1 })); } catch (e) {} location.reload(); }, 4000); });
renderer.domElement.addEventListener("webglcontextrestored", () => { clearTimeout(lostTimer); diag("contextrestored"); });
function quality(dt) {
  qT += dt; qN++; if (qT < 2) return; const fps = qN / qT; fpsNow = fps; qT = 0; qN = 0;
  if (fps >= 50 || qLevel >= 3) return; qLevel++;
  if (qLevel === 1) { PR = 1; renderer.setPixelRatio(PR); }
  else if (qLevel === 2) { renderer.shadowMap.enabled = false; scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); }
  else { PR = .75; renderer.setPixelRatio(PR); }
  console.log("quality step", qLevel, "at", fps.toFixed(0), "fps");
}
function frame() {
  const t = nowS(), dt = Math.min(t - last, .1); last = t; if (connected) quality(Math.min(t - qLast, 2)); qLast = t;
  if (connected) { acc += dt; while (acc >= DT) { tickInput(); acc -= DT; } if (outbox.length && ws.readyState === 1) { cmdsSent += outbox.length; ws.send(JSON.stringify({ t: "c", c: outbox })); outbox = []; }
    if (!diagSent && locked && nowS() - diagStart > 8 && W) { diagSent = true; setTimeout(() => diag("8s"), 8000); } }
  render(dt); requestAnimationFrame(frame);
}

/* ── drawing ─────────────────────────────────────────────────────────────────── */
const lerpAng = (a, b, k) => a + ((((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * k;
let aimedAt = null;
function findAimed() {
  aimedAt = null; if (!W || !me.alive) return;
  const o = camera.position.clone(), d = new THREE.Vector3(); camera.getWorldDirection(d); let best = 60;
  for (const x of others.values()) { if (x.team === myTeam || !x.alive || !x.vis || x.gone) continue;
    const c = x.model.g.position.clone(); c.y += 1.2; const t = c.clone().sub(o).dot(d); if (t <= 0 || t > best) continue;
    if (o.clone().addScaledVector(d, t).distanceTo(c) > .55 || smokeBetween(o, c)) continue;
    if (W.first(o, c.clone().sub(o).normalize(), c.distanceTo(o) - .3)) continue;
    best = t; aimedAt = x; }
}
/* what another player is doing with their hands (2026-11-22), from the server's events: k, its start, how long it takes,
   and for a held pose (a grenade cocked) how long it may be held before it is let go */
const ACTN = {};   // how many of each were seen (debug, tests)
function act(o, k, dur, hold = 0) { o.model.act = { k, t0: nowS(), dur, hold }; ACTN[k] = (ACTN[k] || 0) + 1; }
function actNow(o, s1, speed) {
  const a = o.model.act; if (!a) return null;
  const t = nowS() - a.t0, p = t / a.dur;
  // a plant or defuse ends when they move off it or it is done; a cocked grenade stays back until thrown (or a time-out)
  if (!s1.alive || ((a.k === "plant" || a.k === "defuse") && speed > .8) || t > a.dur + a.hold) { o.model.act = null; return null; }
  return { k: a.k, p: Math.min(1, p) };
}
/* the others as the client draws them, for block() (sim.js) */
function blockers() { const l = []; for (const o of others.values()) if (o.alive && !o.gone && o.model.last) l.push({ pos: o.model.last, duck: o.vd || 0 }); return l; }
function drawOthers() {
  const rt = viewTime(); findAimed();
  for (const o of others.values()) {
    const b = o.buf; if (!b.length || o.gone) { o.model.g.visible = false; continue; }
    let s0 = b[b.length - 1], s1 = s0, k = 0;
    for (let i = b.length - 1; i > 0; i--) if (b[i - 1].tm <= rt) { s0 = b[i - 1]; s1 = b[i]; k = clamp((rt - s0.tm) / Math.max(1e-6, s1.tm - s0.tm), 0, 1); break; }
    if (s0.alive !== s1.alive || Math.hypot(s1.x - s0.x, s1.z - s0.z) > 2) k = 1;   // a respawn or a jump: no slide between the two places
    let x = s0.x + (s1.x - s0.x) * k, y = s0.y + (s1.y - s0.y) * k, z = s0.z + (s1.z - s0.z) * k;
    if (rt > s1.tm && s1.alive) { const ex = Math.min(rt - s1.tm, .25); x += s1.vx * ex; z += s1.vz * ex; }   // a late snapshot: carry on briefly
    const g = o.model.g, duck = s0.duck + (s1.duck - s0.duck) * k, pitch = s0.pitch + (s1.pitch - s0.pitch) * k;
    const pos = new THREE.Vector3(x, y, z), moved = o.model.last ? Math.hypot(pos.x - o.model.last.x, pos.z - o.model.last.z) : 0; o.model.last = pos;
    const was = o.model.phase; o.model.phase += moved * GAIT; const speed = Math.hypot(s1.vx, s1.vz);
    if (speed > 3.5 && s1.alive && Math.floor(was / Math.PI) !== Math.floor(o.model.phase / Math.PI)) at(o.model.g.position, () => step(stepVol(o.model.g.position)));
    g.visible = !!o.vis && !o.gone && o.id !== SPEC.id; g.position.set(x, y, z); g.rotation.y = lerpAng(s0.yaw, s1.yaw, k);
    o.vy = g.rotation.y; o.vp = pitch; o.vd = duck;   // their view, for spectating
    // the walk's direction from the facing, for the legs; a death plays over 0.8 s: the knees fold, then the body tips over
    // backwards with a little twist of its own (by id), falling faster as it goes, as a body does
    const fy = g.rotation.y, mvA = speed > .3 ? Math.atan2(s1.vx * Math.cos(fy) - s1.vz * Math.sin(fy), -s1.vx * Math.sin(fy) - s1.vz * Math.cos(fy)) : 0;
    if (!s1.alive) { if (o.model.diedT == null) o.model.diedT = o.alive != null && !o.alive ? -9 : nowS(); } else o.model.diedT = null;   // dead already in the frame before (a body just swapped by reskin): lying, no second fall
    const dd = o.model.diedT == null ? 0 : clamp((nowS() - o.model.diedT) / .8, 0, 1), tip = clamp((dd - .3) / .7, 0, 1) ** 2;
    // the stride is the server's (2026-11-22): its walk phase, so the legs are drawn where the leg hit boxes are
    const gd = s1.ga != null && s0.ga != null ? Math.atan2(Math.sin(s1.ga - s0.ga), Math.cos(s1.ga - s0.ga)) : 0, gph = s1.ga != null ? (s0.ga ?? s1.ga) + gd * k : o.model.phase;
    // in the air from the server's own flag, as the leg hit boxes are; a landing gives at the knees for a quarter second
    const air = s1.alive ? s0.air + (s1.air - s0.air) * k : 0;
    if (o.model.air > .5 && air <= .5) { o.model.landT = nowS(); ACTN.land = (ACTN.land || 0) + 1; if (s1.alive) at(o.model.g.position, () => step(Math.min(1, stepVol(o.model.g.position) * 1.4), true)); }   // their landing is heard, as in CS (audit 2026-11-23; it was silent)
    o.model.air = air; const land = o.model.landT ? Math.max(0, 1 - (nowS() - o.model.landT) / .25) : 0;
    o.model.sd.pose(s1.alive ? speed : 0, gph, duck, s1.alive ? pitch : 0, { move: mvA, dead: dd, air, land: Math.sin(land * Math.PI), act: actNow(o, s1, speed) });
    if (o.model.sd.rim) o.model.sd.rim(1 - Math.min(1, dd * 2));   // the team's rim light goes out as they fall (models.js RIM)
    if (!s1.alive) { g.rotation.x = -Math.PI / 2 * .94 * tip; g.rotation.z = ((o.id * 37) % 7 - 3) * .06 * tip; g.position.y = y + .12 * tip; o.model.tag.visible = false; } else { g.rotation.x = 0; g.rotation.z = 0; o.model.tag.visible = !o.model.tag.userData.enemy || o === aimedAt; }
    o.alive = s1.alive;
  }
}
let VOTEON = false, voteTimer = 0, corrMax = 0;
onTap($("vote"), b => { if (!VOTEON) return; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "vote", y: b.dataset.y === "1" })); VOTEON = false; $("vote").innerHTML += `<p>You voted ${b.dataset.y === "1" ? "yes" : "no"}</p>`; });   // corrMax: the largest prediction correction seen (debug, tests)   // a vote you can answer: F1 yes, F2 no (CS)
const SNDST = { last: "" }; let inspectT = 0;   // F: the weapon turned over in hand for a look, as in CS   // the last state the mechanical sounds were played for
/* spectating (2026-11-14): dead in a round mode, after the death cam, you watch a living teammate through their eyes;
   a click moves to the next one, as in CS */
/* Gun Game (2026-11-17): the ladder from the server, your level from the roster (and the level events between) */
const dmLike = m => m === "dm" || m === "gg", compLike = m => m === "comp" || m === "wing" || m === "rt";
let LADDER = null; const myLevel = () => ((roster.get(myId) || {}).gl) || 0;
const SPEC = { id: 0 };
function render(dt) {
  smooth.multiplyScalar(Math.exp(-dt * 12)); stepY *= Math.exp(-dt * 14); if (!me.alive) stepY = 0;
  if (wasAlive && !me.alive) { onDeath(); kcBegin(); } else if (!wasAlive && me.alive) { onRespawn(); SPEC.id = 0; } wasAlive = me.alive;
  const kc = kcActive(); if (!kc && KC.on) kcEnd(); KC.on = kc; let kcT = null;
  const spec = spectating() ? (others.get(SPEC.id) && others.get(SPEC.id).alive && others.get(SPEC.id).team === myTeam ? others.get(SPEC.id) : (specNext(), others.get(SPEC.id))) : null;
  if (!spec) SPEC.id = 0;
  const dk = me.alive ? 0 : clamp((nowS() - diedAt) / .6, 0, 1), de = 1 - Math.pow(1 - dk, 3);   // the fall, eased
  camera.position.set(me.pos.x + smooth.x, me.pos.y + smooth.y + stepY + (me.alive ? eye(me) : deathEye + (.32 - deathEye) * de), me.pos.z + smooth.z);
  camera.rotation.order = "YXZ"; camera.rotation.z = me.alive ? 0 : deathRoll * de * (nowS() - diedAt > 1.1 ? .55 : 1);
  if (!me.alive && nowS() - diedAt < 1.1) { camera.rotation.y = me.yaw; camera.rotation.x = me.pitch + (-.25 - me.pitch) * de; }
  else if (!me.alive && others.get(killerId)) { const d = others.get(killerId).model.g.position.clone().sub(camera.position); d.y += 1.2; camera.rotation.y = lerpAng(camera.rotation.y, Math.atan2(-d.x, -d.z), Math.min(1, dt * 4)); camera.rotation.x += (Math.atan2(d.y, Math.hypot(d.x, d.z)) - camera.rotation.x) * Math.min(1, dt * 4); }
  else { camera.rotation.y = me.yaw - me.punchX * .45; camera.rotation.x = me.pitch + me.punchY * .45; }
  if (spec) { const p = spec.model.g.position; camera.position.set(p.x, p.y + 1.62 - (spec.vd || 0) * .45, p.z); camera.rotation.set(spec.vp || 0, spec.vy || 0, 0); }
  if (kc) { const r = kcCamera(); kcT = r.t; KC.w = r.K.w; }
  document.body.classList.toggle("kcam", kc); document.body.classList.toggle("hlcam", kc && !!KC.hl);
  const watch = !!spec || kc;
  if (watch !== !!SPEC.was) { SPEC.was = watch; document.body.classList.toggle("dead", !me.alive && !watch); muffle(!me.alive && !watch); }   // their view in full colour and sound, as in CS
  $("ammo").style.visibility = spec || kc ? "hidden" : "";
  $("spec").hidden = !spec && !kc; if (kc && KC.hl) $("spec").innerHTML = `<small>Highlight</small> ${esc(nameOf(KC.rec.by))} <span>${esc(KC.hl.title)}</span>`; else if (kc) $("spec").innerHTML = `<small>Killcam</small> ${esc(nameOf(KC.rec.by))} <span>${esc((WEAPONS[KC.w] || {}).name || "")}</span>`; else if (spec) $("spec").innerHTML = `<small>Spectating</small> ${esc(nameOf(spec.id))} <span>${spec.hp ?? ""}${spec.hp != null ? " HP" : ""}</span> <span>${esc((WEAPONS[spec.w] || {}).name || "")}</span>`;
  if (shake > 0) { const a = shake * shake * .035; camera.rotation.x += (Math.random() - .3) * a; camera.rotation.y += (Math.random() - .5) * a; camera.rotation.z += (Math.random() - .5) * a * .6; shake = Math.max(0, shake - dt * 3.2); }
  const sp = Math.hypot(me.vel.x, me.vel.z); bob += dt * sp * 1.7; kick = Math.max(0, kick - dt * (KICKW.vkr ?? (kick > 1.5 ? 9 : 14))); fovPunch = Math.max(0, fovPunch - dt * 6); flash = Math.max(0, flash - dt);
  const W0 = wpn(me), scoped = !!(W0.zoom && me.zoom), deploying = me.clock < me.deployUntil;
  for (const w of WIDS) VIEW[w].visible = w === (kc ? KC.w : spec ? spec.w : me.w);
  swing = Math.max(0, swing - dt * 5);
  gun.position.set(GUNPOS.x + Math.cos(bob) * .006 * (me.onGround ? 1 : 0) - swing * .06, GUNPOS.y + Math.abs(Math.sin(bob)) * .007, GUNPOS.z + kick * .03 - swing * .1);
  muzzle.position.set(GUNPOS.x, GUNPOS.y + .025, GUNPOS.z - (MUZZLE[me.w] || .6) * .62);
  swayX *= Math.exp(-dt * 8); swayY *= Math.exp(-dt * 8);
  const rl = me.reloadAt ? clamp((me.reloadAt - me.clock) / (W0.reload || 2), 0, 1) : 0, dip = Math.sin(rl * Math.PI);   // the reload: down, tilted, back up
  gun.position.x -= swayX; gun.position.y += swayY - dip * .09;
  gun.rotation.set(swing * .9 + dip * .5 + kick * (KICKW.rise ?? (kick > 1.5 ? .07 : 0)), swing * .6 - swayX * 2, dip * .6 + kick * (KICKW.roll || 0));   // each gun its own climb and twist (sim.js FEEL)
  /* the draw (2026-11-22): the gun comes up from below the screen, muzzle low and rolled in, and settles; the hands close
     on it as it arrives (poseArms reads DRAWK). Was a fixed 12 cm drop for the whole deploy time */
  DRAWK = deploying && !kc && !spec ? clamp((me.deployUntil - me.clock) / ((W0.deploy || .5) * .9), 0, 1) : 0;
  if (DRAWK) { const e = DRAWK * DRAWK * (3 - 2 * DRAWK); gun.position.y -= e * .26; gun.position.z += e * .06; gun.rotation.x -= e * .7; gun.rotation.z += e * .45; }
  if (inspectT > 0) { inspectT = Math.max(0, inspectT - dt); const k = Math.sin((1 - inspectT / 2.2) * Math.PI); gun.rotation.y += k * 1.1; gun.rotation.z += k * .5; gun.position.x -= k * .05; gun.position.y += k * .03; }
  if (me.alive) { const st = me.w + "|" + (me.reloadAt ? 1 : 0) + "|" + (me.cock ? 1 : 0) + "|" + (me.landed ? 1 : 0), p0 = SNDST.last.split("|");
    if (SNDST.last && p0[0] !== me.w) { if (me.w === "knife" && CLIPS.knife_draw) playClip("knife_draw", .45, 1); else clack(.3, 3200); }                                  // a draw
    if (SNDST.last && p0[1] === "0" && me.reloadAt) reloadSound(.55, me.w);
    if (SNDST.last && p0[2] === "0" && me.cock) pinSound(1);
    if (SNDST.last && p0[3] === "0" && me.landed) step(.75, true);                          // the landing
    SNDST.last = st; }
  if (me.alive && me.onGround && sp > 3.5) { myStep += sp * dt * 3.2; if (myStep > Math.PI) { myStep -= Math.PI; step(.5); } }
  tickParts(dt); tickShells(dt); probeEnv(); if (muzzleLight && muzzleLight.intensity > 0) muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 700); tickFx(dt); tickDmg(); drawRadar(); tickComp(dt); tickTalk();
  gun.visible = ((me.alive || nowS() - diedAt < .45) && !scoped) || !!spec || kc; if (!me.alive && !kc) { gun.position.y -= de * .5; gun.rotation.z += de * 1.1; } muzzle.visible = flash > 0 && (kc ? !(WEAPONS[KC.w] || {}).melee : !W0.melee && !scoped); muzzle.material.rotation = Math.random() * 6;
  const kcam = !spec && !kc && !me.alive && nowS() - diedAt > 1.1 && others.get(killerId), fov = kcam ? 46 : (scoped ? 2 * Math.atan(Math.tan(SET.fov / 2 * DEG) * W0.zoom[me.zoom]) / DEG : SET.fov) + fovPunch * 5;
  if (Math.abs(camera.fov - fov) > .01) { camera.fov = kcam ? camera.fov + (fov - camera.fov) * Math.min(1, dt * 2.5) : fov; camera.updateProjectionMatrix(); }
  $("scope").style.display = scoped && me.alive ? "block" : "none";
  $("xh").style.display = scoped || me.w === "awp" || !me.alive ? "none" : "block";
  nearPick = null; let bd = 1.6;
  for (const p of pickups.values()) { if (p.mesh.userData.spin) p.mesh.userData.spin.rotation.y += dt * 1.5;
    if (p.kind === 0 && me.alive && !p.away) { const d = Math.hypot(me.pos.x - p.pos.x, me.pos.z - p.pos.z); if (d < bd && Math.abs(me.pos.y - p.pos.y) < 1.3) { bd = d; nearPick = p; } } }
  if (TOUCH) { const defuseHere = !!(GM && compLike(GM.m) && GM.bp && myTeam === 0 && me.alive && Math.hypot(me.pos.x - GM.bp[0], me.pos.z - GM.bp[2]) < 1.4);
    $("tUse").hidden = !nearPick && !defuseHere; $("tUse").textContent = defuseHere ? "Defuse" : "Pick up";
    $("tZoom").hidden = !(W0.zoom || W0.burst || W0.nade); $("tZoom").textContent = W0.nade ? "Lob" : W0.burst ? "Burst" : "Zoom";
    $("tKnife").textContent = me.w === "knife" && me.zeus ? "Zeus" : "Knife"; }   // the knife key: a second tap brings out the Zeus
  const mine = nearPick ? (WEAPONS[nearPick.w].slot === "s" ? me.sec : me.prim) : null;
  $("prompt").textContent = nearPick ? "E  pick up " + WEAPONS[nearPick.w].name + (mine ? " (drops your " + WEAPONS[mine].name + ")" : "") : ""; { const lu = tickLineups(); if (lu && !nearPick) $("prompt").textContent = lu; }
  $("wname").textContent = W0.name + (GM && GM.m === "gg" && LADDER && myLevel() < LADDER.length - 1 ? "  next " + ((WEAPONS[LADDER[myLevel() + 1]] || {}).name || "") : "") + (scoped ? "  x" + Math.round(1 / W0.zoom[me.zoom]) : "") + (W0.burst && me.burstOn ? "  burst" : "");
  drawOthers(); if (kc) kcBodies(kcT);
  const pn = performance.now(); flyStreaks(pn); for (let i = tracers.length - 1; i >= 0; i--) if (pn > tracers[i].userData.t) { scene.remove(tracers[i]); tracers[i].geometry.dispose(); tracers.splice(i, 1); }
  const hpShown = SPEC.id && others.get(SPEC.id) ? others.get(SPEC.id).hp ?? 0 : me.hp;
  $("hpv").textContent = hpShown; $("hpv").style.color = hpShown > 100 ? "#7fb6ff" : hpShown <= 30 ? "#ef5b4b" : ""; const noAmmo = W0.melee || W0.nade || W0.c4; $("mag").textContent = W0.nade ? me.nades[me.w] : W0.melee || W0.c4 ? "-" : me.reloadAt ? "--" : me.mag; { const full = (WEAPONS[me.w] || {}).mag || 30, lowA = !noAmmo && !me.reloadAt && me.mag <= Math.max(1, Math.floor(full * .3));
    $("mag").style.color = noAmmo || me.reloadAt ? "" : me.mag === 0 ? "#ef5b4b" : lowA ? "#f2c14e" : "";
    $("rldp").textContent = !noAmmo && me.alive && !me.reloadAt && me.mag === 0 ? (me.res > 0 ? (TOUCH ? "reload" : "R  reload") : "no ammo") : "";
    $("arv").textContent = me.armor; $("arw").hidden = !me.armor; $("hmv").hidden = !me.helmet;
    { const strip = NADES.map(n => `<span class="${me.nades[n] ? "" : "z"}${me.w === n ? " on" : ""}">${{ he: "HE", flash: "FLASH", smoke: "SMOKE", molotov: "MOLOTOV", decoy: "DECOY" }[n]}</span>`).join("");
      const extra = (me.c4 ? `<span class="${me.w === "c4" ? "on" : ""} c4">C4</span>` : "") + (me.kit ? `<span class="kit">KIT</span>` : "") + (me.zeus ? `<span class="${me.w === "zeus" ? "on" : ""}">ZEUS</span>` : "");
      if (strip + extra !== lastStrip) { lastStrip = strip + extra; $("nades").innerHTML = strip + extra; } }
    const ring = $("rldr"), on = !!me.reloadAt && me.alive && !noAmmo; ring.style.opacity = on ? 1 : 0;
    if (on) ring.querySelector("circle.f").style.strokeDashoffset = (113.1 * clamp((me.reloadAt - me.clock) / (W0.reload || 2), 0, 1)).toFixed(1); } $("res").textContent = W0.melee || W0.nade || W0.c4 ? "" : "/ " + me.res; $("ping").textContent = ping + " ms";
  if (connected && GM) {
    const mm = t => Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"), rounds = !dmLike(GM.m);
    if (!me.alive && !rounds && $("kcr")) { const left = Math.max(0, respawnIn); $("kcr").style.width = (100 * (1 - left / 3)).toFixed(1) + "%"; $("kcrt").textContent = left > .05 ? "Back in " + left.toFixed(1) + " s" : "Back in"; }
    $("clock").textContent = GM.dc ? fmtT(GM.dc.el + GM.dc.d * GM.dc.pen) : GM.bp && GM.ph === "live" ? (GM.bl > 0 ? "BOMB " + Math.ceil(GM.bl) : "BOMB") : mm(GM.tl); $("clock").classList.toggle("bomb", !!(GM.bp && GM.ph === "live")); $("sct").textContent = GM.sc[0]; $("st").textContent = GM.sc[1]; $("rnd").textContent = GM.dc ? "KILLS " + GM.dc.k + "/" + GM.dc.need : rounds ? "ROUND " + GM.rn : GM.m === "gg" && LADDER ? "LEVEL " + Math.min(myLevel() + 1, LADDER.length) + "/" + LADDER.length : "DM";
    $("big").innerHTML = GM.ph === "over" ? `${esc(GM.msg)}<small>${GM.dc ? "your result is on the menu" : `next match in ${GM.tl} s`}</small>` : GM.ph === "end" ? `${esc(GM.msg)}` : GM.ph === "freeze" ? (GM.dc ? `${GM.dc.need} kills, fast<small>starts in ${GM.tl}</small>` : GM.rs ? `${myTeam ? "Hold" : "Retake"} ${esc(GM.rs)}<small>the bomb is down, starts in ${GM.tl}</small>` : `Round ${GM.rn}<small>starts in ${GM.tl}</small>`) : ""; $("msg").classList.toggle("low", !!$("big").innerHTML);   // a round message above: the note steps down below it
    $("board").style.display = GM.ph === "over" || keys.Tab ? "block" : "none"; document.body.classList.toggle("boardon", $("board").style.display === "block"); if (TOUCH) document.body.classList.toggle("tpanel", !me.alive || $("board").style.display === "block" || BUY.open || CHAT.radio || VOTEON || !$("chatin").hidden);   // one writer for the phone panel state
    $("msg").innerHTML = !me.alive ? (rounds ? (GM.ph === "live" ? "You are dead<small>you play again next round</small>" : "") : "") : nowS() < roomNoteUntil ? `Room ${currentRoom}<small>${TOUCH ? "Pause" : "Esc"} for the invite link</small>` : protect > 0 ? `<small>spawn protection ${protect.toFixed(1)} s</small>` : "";
  }
  const gap = 3 + inaccuracy(me) / DEG * 3.2 + (pn - lastFire < 120 ? 3 : 0), len = 7, th = 2, [l, r, u, d] = $("xh").children;
  l.style.cssText = `left:${-gap - len}px;top:${-th / 2}px;width:${len}px;height:${th}px`; r.style.cssText = `left:${gap}px;top:${-th / 2}px;width:${len}px;height:${th}px`;
  u.style.cssText = `left:${-th / 2}px;top:${-gap - len}px;width:${th}px;height:${len}px`; d.style.cssText = `left:${-th / 2}px;top:${gap}px;width:${th}px;height:${len}px`;
  $("xh").classList.toggle("hit", pn < hitmark);
  $("dbg").textContent = DEBUG ? `quality step ${qLevel}  ping ${ping} ms  interp ${Math.round(interp * 1000)} ms  unconfirmed commands ${pending.length}\nspeed ${(sp / U).toFixed(0)} u/s ${me.onGround ? "ground" : "air"}\npos ${me.pos.x.toFixed(1)} ${me.pos.y.toFixed(2)} ${me.pos.z.toFixed(1)}  correction ${(smooth.length() * 100).toFixed(1)} cm\nothers ${others.size}` : "";
  shadowT += dt; if (shadowT > .05) { shadowT = 0; renderer.shadowMap.needsUpdate = true; }
  if (ARMS) poseArms(KC.on ? KC.w : SPEC.id && others.get(SPEC.id) ? others.get(SPEC.id).w : me.w);
  renderer.render(scene, camera);
}

/* HUD writes only when the value changes (2026-11-17): render() sets about twenty HUD texts every frame, and each write
   makes the browser restyle even when the text is the same. These elements get a setter that skips an unchanged value. */
{ const P = Object.getOwnPropertyDescriptor(Node.prototype, "textContent"), H = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const keep = (el, prop, d) => Object.defineProperty(el, prop, { configurable: true, get() { return d.get.call(this); }, set(v) { v = String(v); if (this["_" + prop] === v) return; this["_" + prop] = v; d.set.call(this, v); } });
  for (const id of ["prompt", "wname", "tZoom", "tUse", "tKnife", "st", "sct", "rnd", "rldp", "res", "ping", "mag", "hpv", "clock", "arv", "dbg"]) if ($(id)) keep($(id), "textContent", P);
  for (const id of ["spec", "nades", "msg", "big"]) if ($(id)) keep($(id), "innerHTML", H); }
initViews();   // the guns in hand (client/viewmodel.js), now that the settings and your team exist
/* ── boot ────────────────────────────────────────────────────────────────────── */
const saved = (() => { try { return localStorage.getItem("fps-name"); } catch (e) { return null; } })();
$("name").value = params.get("name") || saved || "";   // empty shows the placeholder; Play picks a name if none is typed
let team = "auto", room = (params.get("room") || "DAILY").toUpperCase(), withBots = true;
/* the menu (2026-11-17, operator: "one flow, as CS"): a card per mode opens its setup popup with just the settings that
   mode has (side for all; bots, their skill and freeze time where they apply) and one button that starts it */
let gameMode = "dm", botDiff = "normal", botN = 3, frzS = 5, dcInfo = null;
const FRZ = [0, 3, 5, 8, 10, 15];
const MODEINFO = {
  public: { t: "Today's match", d: "Deathmatch on today's map with everyone who is online. Respawn, play as long as you like.", go: "Join the match", rows: [] },
  comp: { t: "Competitive", d: "5 v 5 with the bomb and money, as CS: first to 9 rounds, sides swap at halftime.", go: "Create room", rows: ["bots", "botn", "diff", "frz"] },
  wing: { t: "Wingman", d: "2 v 2 on one bomb site, 1:30 rounds, first to 9. Bots fill the empty places.", go: "Create room", rows: ["bots", "diff", "frz"] },
  gg: { t: "Gun Game", d: "Every kill hands you the next of 13 guns; the knife is last. A knife kill also takes a level off the victim.", go: "Create room", rows: ["bots", "botn", "diff"] },
  rt: { t: "Retakes", d: "Every round starts with the bomb planted on a site. Ember hold it, Atlas retake it and defuse before it blows. Set loadouts, no buying; first to 8.", go: "Create room", rows: ["bots", "botn", "diff", "frz"] },
  dm: { t: "Deathmatch", d: "Your own room on today's map. Share the invite link with friends.", go: "Create room", rows: ["bots", "botn", "diff"] },
  dc: { t: "Daily challenge", d: "Alone against four hard bots on the day's challenge map: 8 kills as fast as you can, each death adds 10 s. Your first finished run each day counts.", go: "Start the challenge", rows: [] },
  join: { t: "Join a room", d: "", go: "Join", rows: [] }
};
const seg = (id, attr, val) => { for (const x of $(id).children) { const on = x.dataset[attr] === val; x.classList.toggle("on", on); x.setAttribute("aria-pressed", on); } };
const setBots = n => { botN = Math.max(1, Math.min(5, n)); $("botv").textContent = botN; const [dn, up] = $("botn").querySelectorAll("button"); dn.disabled = botN <= 1; up.disabled = botN >= 5; };
const setFrz = v => { frzS = v; $("frzv").textContent = v; const [dn, up] = $("frz").querySelectorAll("button"); dn.disabled = v <= FRZ[0]; up.disabled = v >= FRZ[FRZ.length - 1]; };
function msRows() { const r = MODEINFO[gameMode].rows; for (const [k, id] of [["bots", "msBots"], ["botn", "msBotn"], ["diff", "msDiff"], ["frz", "msFrz"]]) $(id).hidden = !r.includes(k) || (k !== "bots" && k !== "frz" && !withBots); }
function msOpen(mode, note = "") {
  gameMode = mode; const M = MODEINFO[mode]; $("msTitle").textContent = M.t; $("msDesc").textContent = mode === "join" ? `Room ${joinCode}` : M.d; $("msGo").textContent = M.go; $("msNote").textContent = note;
  if (mode === "dc") fetch("challenge", { cache: "no-store" }).then(x => x.json()).then(r => { dcInfo = r; if (gameMode === "dc" && !note) $("msNote").textContent = `#${r.day} on ${r.map}${r.top && r.top[0] ? `. Fastest today: ${r.top[0].name}, ${fmtT(r.top[0].t)}` : ""}`; }).catch(() => {});
  msRows(); $("msetup").hidden = false; $("msGo").focus();
}
const msClose = () => { $("msetup").hidden = true; };
$("mgrid").addEventListener("click", ev => { const b = ev.target.closest(".mcard"); if (b) msOpen(b.dataset.m); });
$("msBack").addEventListener("click", msClose);
$("msetup").addEventListener("click", ev => { if (ev.target === $("msetup")) msClose(); });
$("msetup").addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Escape") msClose(); });
$("teams").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) { team = b.dataset.team; seg("teams", "team", team); } });
$("bots").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) { withBots = b.dataset.b === "1"; seg("bots", "b", b.dataset.b); msRows(); } });
$("bdiff").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) { botDiff = b.dataset.d; seg("bdiff", "d", botDiff); } });
$("botn").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) setBots(botN + +b.dataset.d); }); setBots(3);
$("frz").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) setFrz(FRZ[Math.max(0, Math.min(FRZ.length - 1, FRZ.indexOf(frzS) + +b.dataset.d))]); }); setFrz(5);
let joinCode = "";
$("msGo").addEventListener("click", () => {
  const nm = ($("name").value.trim() || "player") + "'s room";
  if (gameMode === "public") { msClose(); return start({ room: "DAILY" }); }
  if (gameMode === "join") { msClose(); return start({ room: joinCode }); }
  if (gameMode === "dc") {   // the page holds one map: if another is loaded, reload with the challenge's first, then Start again
    if (dcInfo && preload && preload.id !== dcInfo.id) { try { const n = $("name").value.trim().slice(0, 16); if (n) localStorage.setItem("fps-name", n); sessionStorage.setItem("dcqueue", JSON.stringify({ map: dcInfo.id, team, t: Date.now() })); } catch (e) {} location.reload(); return; }
    DCRES = null; try { sessionStorage.removeItem("dcres"); } catch (e) {} if (dcInfo) getMap(dcInfo.id); msClose(); return start({ create: "1", mode: "dc", title: "Daily challenge" }); }
  msClose(); start({ create: "1", mode: gameMode, frz: frzS, diff: botDiff, bots: withBots ? "1" : "0", bpt: botN, title: nm });
});
/* today's map: its picture behind the menu, its name, the next one and when */
const span = t => t >= 3600 ? Math.floor(t / 3600) + " h " + Math.floor(t % 3600 / 60) + " min" : Math.max(1, Math.floor(t / 60)) + " min";
async function loadToday() {
  let r = null; try { r = (await fetch("rooms", { cache: "no-store" }).then(x => x.json()))[0]; } catch (e) {}
  if (!r) return;
  if (r.map) getMap(r.map);
  $("skipmap").hidden = !r.skip; $("mapname").textContent = r.title; if (r.next) { nextName = r.next.map.replace(/, HY-World$/, ""); nextAt = Date.now() + r.next.in * 1000; tickNext(); }
  // today's best on this map, and the last maps with whoever topped them
  const rows = (r.board || []).map((b, i) => `<li><i>${i + 1}</i><b>${esc(b.name)}</b><span>${b.k}<small>K</small></span><span>${b.d}<small>D</small></span></li>`).join("");
  $("lbtop").innerHTML = rows || `<li class="none">No kills yet</li>`;
  $("lbpast").innerHTML = (r.past || []).map(p => `<figure><span class="th" style="background-image:url(${esc(p.preview)})"></span><figcaption><b>${esc(p.map)}</b>${p.best ? `<small>${esc(p.best.name)}, ${p.best.k} kills</small>` : `<small>No winner</small>`}</figcaption></figure>`).join("");
  $("lbpastw").hidden = !(r.past || []).length;
  $("online").textContent = r.online + " playing";
  const bg = $("bg"), url = r.preview; if (bg.dataset.src !== url) { bg.dataset.src = url; const im = new Image(); im.onload = () => { bg.style.backgroundImage = `url(${url})`; requestAnimationFrame(() => bg.classList.add("in")); }; im.src = url; }
}
/* the board's tabs (2026-11-17); Stats shows the lifetime numbers for the name in the box, and the all-time top */
$("lbtabs").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return;
  for (const x of $("lbtabs").children) { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); $(x.dataset.p).hidden = x !== b; }
  if (b.dataset.p === "lbStats") loadStats(); if (b.dataset.p === "lbDc" && window.loadDc) window.loadDc(); });
async function loadStats() {
  const nm = $("name").value.trim(); let r = null; try { r = await fetch("stats?name=" + encodeURIComponent(nm), { cache: "no-store" }).then(x => x.json()); } catch (e) {}
  const el = $("lbStats"); if (!r) { el.innerHTML = `<p class="none">Stats are not available right now</p>`; return; }
  const m = r.me, cell = (v, l) => `<div><b>${v}</b><small>${l}</small></div>`;
  el.innerHTML = (m ? `<span class="eyebrow">${esc(m.name)}, #${m.rank} of ${m.players}</span>
    <div class="stg">${cell(m.k, "Kills")}${cell(m.d, "Deaths")}${cell(m.kd, "K/D")}${cell(m.hs + "%", "Headshots")}${cell(m.acc + "%", "Accuracy")}${cell(m.a, "Assists")}</div>
    <div class="stl">${m.gun ? `<span>Favourite gun <small>${esc(m.gun.name)}, ${m.gun.k} kills</small></span>` : ""}${m.map ? `<span>Best map <small>${esc(m.map.name)}, ${m.map.k} kills</small></span>` : ""}<span>Damage dealt <small>${m.dmg}</small></span></div>`
    : `<p class="none">${nm ? `No stats for ${esc(nm)} yet. Play a game under this name and they start counting.` : "Type your name to see your stats."}</p>`)
    + `<span class="eyebrow">All time</span><ol>${(r.top || []).map((t, i) => `<li><i>${i + 1}</i><b>${esc(t.name)}</b><span>${t.k}<small>K</small></span><span>${t.kd}<small>KD</small></span></li>`).join("") || `<li class="none">Nobody yet</li>`}</ol>`;
}
/* the daily challenge (2026-11-17): the tab shows the day's map, the rules, today's fastest and your counted run; after a
   run the page comes back here with the result and a Share button (the phone's share sheet, else the clipboard) */
const fmtT = t => t == null ? "-" : Math.floor(t / 60) + ":" + (t % 60).toFixed(1).padStart(4, "0");
let DCRES = (() => { try { const r = JSON.parse(sessionStorage.getItem("dcres") || "null"); return r && Date.now() - r.at < 600000 ? r : null; } catch (e) { return null; } })();
function dcShareText(r) { return `Newground challenge #${r.day}, ${r.map}\n${fmtT(r.t)} (${r.k} kills, ${r.d} ${r.d === 1 ? "death" : "deaths"}, ${r.hs} headshots)\n${r.counted ? `#${r.rank} of ${r.of} today` : "practice run"}\n${location.origin + location.pathname}`; }
async function loadDc() {
  const nm = $("name").value.trim(); let r = null; try { r = await fetch("challenge?name=" + encodeURIComponent(nm), { cache: "no-store" }).then(x => x.json()); } catch (e) {}
  const el = $("lbDc"); if (!r) { el.innerHTML = `<p class="none">The challenge is not available right now</p>`; return; }
  const res = DCRES && DCRES.day === r.day ? DCRES : null;
  el.innerHTML = (res ? `<div class="dcres"><span class="eyebrow">${res.done ? "Your run" : "Out of time"}</span>${res.done ? `<b>${fmtT(res.t)}</b><small>${res.k} kills, ${res.d} ${res.d === 1 ? "death" : "deaths"} (+${res.d * r.penalty} s), ${res.hs} headshots. ${res.counted ? `#${res.rank} of ${res.of} today` : `Practice: your counted time is ${fmtT(res.best)}`}</small>
      <div class="dcrow"><button type="button" class="dcgo" id="dcshare">Share result</button><button type="button" class="dcgo sec" id="dcagain">Again</button></div><small id="dcsharehint"></small>` : `<small>${res.k} of ${r.kills} kills in 10 minutes</small><button type="button" class="dcgo" id="dcagain">Try again</button>`}</div>`
    : `<span class="eyebrow">Daily challenge #${r.day}</span><span class="dcmap">${esc(r.map)}</span>
       <p class="dcrule">Alone against four hard bots that keep coming back. ${r.kills} kills as fast as you can; each death adds ${r.penalty} s. Your first finished run today counts.</p>
       ${r.me ? `<small class="dcrule">Your time today: <b>${fmtT(r.me.t)}</b>. Another run is practice.</small>` : ""}
       <button type="button" class="dcgo" id="dcgo">${r.me ? "Practice run" : "Start the challenge"}</button>`)
    + `<span class="eyebrow">Today's fastest${r.players ? `, ${r.players} played` : ""}</span><ol>${(r.top || []).map((t, i) => `<li><i>${i + 1}</i><b>${esc(t.name)}</b><span>${fmtT(t.t)}</span><span>${t.d}<small>D</small></span></li>`).join("") || `<li class="none">Nobody yet. Be the first</li>`}</ol>`;
  // Start and Again go through the mode popup like every other game (it reloads first if the challenge map is not loaded)
  const viaMenu = () => { DCRES = null; try { sessionStorage.removeItem("dcres"); } catch (e) {} dcInfo = r; msOpen("dc"); };
  if ($("dcgo")) $("dcgo").addEventListener("click", viaMenu); if ($("dcagain")) $("dcagain").addEventListener("click", viaMenu);
  if ($("dcshare")) $("dcshare").addEventListener("click", async () => { const text = dcShareText(res);
    try { if (TOUCH && navigator.share) { await navigator.share({ text }); return; } } catch (e) {}
    let ok = false; try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {} $("dcsharehint").textContent = ok ? "Copied. Paste it in your group" : text; });
}
window.loadDc = loadDc;
function onDcResult(m) { DCRES = { ...m, t: m.tt, at: Date.now() }; try { sessionStorage.setItem("dcres", JSON.stringify(DCRES)); sessionStorage.removeItem("rejoin"); } catch (e) {}
  setTimeout(() => { movingTo = "leave"; try { ws && ws.close(); } catch (e) {} location.href = location.pathname; }, 1800); }
if (DCRES) setTimeout(() => document.querySelector('#lbtabs [data-p="lbDc"]').click(), 0);
let nextAt = 0, nextName = "";
/* TEMPORARY, for testing: the arrow moves the public room on to the next map now (server.js MAP_SKIP); the menu then
   reloads so it shows and preloads that map */
$("skipmap").addEventListener("click", async () => { const b = $("skipmap"); b.disabled = true;
  try { const r = await fetch("skipmap", { method: "POST" }).then(x => x.json()); if (r.ok) { location.reload(); return; } } catch (e) {}
  setTimeout(() => { b.disabled = false; }, 2000); });
/* the countdown to the next world ticks every second */
function tickNext() { if (!nextAt) return; const t = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  $("nextmap").textContent = "Next: " + nextName + " in " + (t >= 3600 ? span(t) : Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0")); }
setInterval(tickNext, 1000);
loadToday(); setInterval(() => { if (!connected) loadToday(); }, 15000);
/* pointer lock needs a click; a refusal (no click yet) is not an error */
function lockMouse() { if (TOUCH) return touchPlay(true); try { const p = pointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
function start(q) {
  const n = $("name").value.trim().slice(0, 16) || "player" + (Math.random() * 900 + 100 | 0); if ($("name").value.trim()) try { localStorage.setItem("fps-name", n); } catch (e) {}
  if (ws && ws.readyState > 1) ws = null;   // a dead socket never blocks Play
  if (ws) { if (connected) { audio(); lockMouse(); } return; }
  $("load").textContent = "connecting"; audio(); connect({ name: n, team, fin: SET.fin, ...q }); if (!AUTO && !q.quiet) lockMouse();
}
let DCQ = (() => { try { const q = JSON.parse(sessionStorage.getItem("dcqueue") || "null"); sessionStorage.removeItem("dcqueue"); return q && Date.now() - q.t < 60000 ? q : null; } catch (e) { return null; } })();
if (DCQ) { getMap(DCQ.map); team = DCQ.team || team; seg("teams", "team", team); dcInfo = { id: DCQ.map }; setTimeout(() => msOpen("dc", "The challenge map is loaded. Start when you are ready"), 0); }
$("play").addEventListener("click", () => start({ room }));   // Resume (or continue after a reconnect); new games start from the mode cards
/* unstuck: respawn now (a self-kill; the server allows one every 10 s) - K, or the pause menu's button */
function unstuck() { if (ws && ws.readyState === 1 && connected && me.alive) ws.send(JSON.stringify({ t: "u" })); }
$("unstuck").addEventListener("click", () => { unstuck(); lockMouse(); });
/* leave: back to a fresh menu (no rejoin), out of any private room */
$("leave").addEventListener("click", () => { movingTo = "leave"; try { sessionStorage.removeItem("rejoin"); ws && ws.close(); } catch (e) {} location.href = location.pathname; });
const invite = () => location.origin + location.pathname + "?room=" + currentRoom;
$("copylink").addEventListener("click", async () => { let ok = false; try { await navigator.clipboard.writeText(invite()); ok = true; } catch (e) {}
  $("sharehint").textContent = ok ? "Copied. Send it to your friends" : invite(); });
const openJoin = c => { joinCode = c; msOpen("join", "Pick your side, then join"); };
$("joincode").addEventListener("click", () => { const c = $("code").value.trim().toUpperCase(); if (!/^[A-Z]{4}$/.test(c)) { $("load").textContent = "A room code is 4 letters"; return; } openJoin(c); });
for (const id of ["name", "code"]) $(id).addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Enter" && id === "code") $("joincode").click(); });
let rejoining = false;
{ let rj = null; try { rj = JSON.parse(sessionStorage.getItem("rejoin") || "null"); sessionStorage.removeItem("rejoin"); } catch (e) {}
  if (rj && Date.now() - rj.t < 30000) { if (rj.map) getMap(rj.map);   /* the map this room needs, before today's takes the one slot (2026-11-17) */ team = rj.team || "auto"; room = rj.room; rejoined = rj.lost ? "lost" : "map"; rejoining = true; start({ room, quiet: 1 }); } }
if (room !== "DAILY" && !AUTO && !rejoining) { $("code").value = room; openJoin(room); }   // an invite link opens its join popup
if (AUTO) { $("start").style.display = "none"; team = params.get("team") || "auto"; start(params.get("create") ? { create: "1", mode: params.get("mode") || "dm", frz: params.get("frz") || "", diff: params.get("diff") || "normal", bots: params.get("bots") || "1", bpt: params.get("bpt") || "", title: "test" } : { room }); }
if (AUTO || DEBUG) window.__g = { cam: () => +camera.position.y.toFixed(3), rim: () => [...others.values()].map(o => ({ team: o.team, alive: o.alive, k: o.model.sd.rim ? +o.model.sd.rim.u.value.toFixed(2) : null, mats: (() => { let n = 0, r = 0; o.model.g.traverse(x => { if (x.isMesh && x.material) { n++; if (x.material.onBeforeCompile && x.material.onBeforeCompile.name === "rimShader") r++; } }); return [r, n]; })() })),lu: () => ({ n: LU.list.length, shown: LU.marks.filter(m => m.visible).length, w: me.w, team: myTeam }), kc: () => ({ hls: KC.hls, hl: KC.hl && KC.hl.title, msgs: KC.msgs, deaths: KC.deaths, played: KC.played, fps: +fpsNow.toFixed(1), on: KC.on, rec: !!KC.rec, n: KC.rec ? KC.rec.h.size : 0, temps: KC.temps.size }), acts: () => ACTN, tracer, streaks, corr: (reset) => { const v = corrMax; if (reset) corrMax = 0; return v; }, spec: () => ({ id: SPEC.id, n: specList().length, on: spectating(), mode: GM && GM.m, since: +(nowS() - diedAt).toFixed(1), team: myTeam, mates: [...others.values()].map(o => [o.id, o.team, o.alive, !!o.gone, o.buf.length]) }), ws: () => ws, snaps: () => snapN, snd: { crack, whiz, impactSound, bodyHit, reloadSound, boomSound, flashSound, step, gunSound, audio, ctx: () => AC && AC.state }, fx: () => ({ roomy: +ENV.roomy.toFixed(2), clips: Object.keys(CLIPS).length, sparks: sparkN, streaks: streaks.length, shells: shells.length, parts: parts.length, decals: decals.length, light: muzzleLight ? +muzzleLight.intensity.toFixed(1) : null }), start,me, others, roster, keys, pending: () => pending, ping: () => ping, setMouse: v => { mouseDown = v; }, connected: () => connected, W: () => W, myId: () => myId, smooth, viewTime };
requestAnimationFrame(frame);
export { DECOYDOTS, DRAWK, FX, GM, GUNPOS, KC, PINGS, SET, SPEC, SPOTTED, W, compLike, connected, diedAt, dispose, dmLike, esc, keys, label, lerpAng, locked, me, myId, myTeam, nameOf, noiseHit, others, person, recoilFx, releaseMouse, reskin, roster, setLocked, ws };   // for client/*.js
