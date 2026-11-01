/* Daily Map PoC, multiplayer client. The server decides everything; this page predicts its own player so input
   feels instant (move and shoot locally, then reconcile with each snapshot by replaying the commands the server has
   not confirmed), and draws everyone else 100 ms in the past, interpolated between snapshots. Shots carry the
   view time they were aimed in, so the server can rewind the others to what this screen showed (lag compensation). */
import * as THREE from "three";
import { World, DT, U, DEG, clamp, newPlayer, move, weapon, eye, inaccuracy, standinParts, gltfGeometries, WEAPONS, WIDS, wpn } from "./sim.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
const gltf = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);   // map files are meshopt-compressed, about 17x smaller
import { gunModel, soldier, MUZZLE, sleeveMaterial } from "./models.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

let interp = .1; const ests = [], $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
const AUTO = params.has("autoplay"), TEAM = ["ATLAS", "EMBER"], TEAMCOL = [0x4f86d9, 0xd09440];

/* ── renderer ────────────────────────────────────────────────────────────────── */
const renderer = new THREE.WebGLRenderer({ antialias: devicePixelRatio < 1.5, powerPreference: "high-performance" });   // dense screens need no multi-sampling
const PHONE = matchMedia("(pointer: coarse)").matches || new URLSearchParams(location.search).has("touch");
let PR = Math.min(devicePixelRatio, PHONE ? 1.25 : 1.5); renderer.setPixelRatio(PR); renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = !PHONE;   // phones: no shadow pass at all
 renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;   // redrawn 20 times a second, in render()
let shadowT = 0;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
{ const c = document.createElement("canvas"); c.width = 2; c.height = 256; const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, "#5f8fc4"); gr.addColorStop(.55, "#a9c8e2"); gr.addColorStop(1, "#e9e4d6"); g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; scene.background = t; }
scene.fog = new THREE.Fog(0xd6dfe4, 70, 260);
{ const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), .04).texture; scene.environmentIntensity = .45; pm.dispose(); }   // reflections on metal, wood and cloth, computed once
const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, .03, 600); scene.add(camera);
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8a7458, 1.1));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.1); sun.position.set(30, 60, 20); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -.0004; sun.shadow.normalBias = .03; scene.add(sun); scene.add(sun.target);
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

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
    const gl = await gltf().loadAsync("maps/" + m.collision, prog(0)); geoms = gltfGeometries(gl.scene, m);
    if (m.visual) { const v = await gltf().loadAsync("maps/" + (TOUCH && m.visualMobile || m.visual), prog(1));   // phones get a lighter cut of the same world v.scene.traverse(o => { if (o.isMesh) { const tx = o.material && o.material.map; o.material = new THREE.MeshBasicMaterial({ map: tx || null, vertexColors: !tx && !!o.geometry.attributes.color, side: THREE.DoubleSide, toneMapped: false }); } });   // its colours are already final: no second tone mapping
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
  const sd = soldier(team), tag = label(name, team ? "#ffd27a" : "#9cc6ff"); tag.position.y = 2.05; sd.root.add(tag);
  tag.userData.enemy = team !== myTeam; if (tag.userData.enemy) { tag.material.depthTest = true; tag.visible = false; }
  scene.add(sd.root); return { g: sd.root, sd, tag, phase: 0, last: null };
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
function dispose(o) { o.traverse(x => { if (x.geometry) x.geometry.dispose(); const ms = x.material ? (Array.isArray(x.material) ? x.material : [x.material]) : [];
  for (const m of ms) if (!m.userData.shared) { if (m.map && !m.map.userData.shared) m.map.dispose(); m.dispose(); } }); }
/* ── state ───────────────────────────────────────────────────────────────────── */
let W = null, ws = null, myId = 0, myTeam = 0, seq = 0, pending = [], connected = false;
const me = newPlayer(); me.clock = 0;
const others = new Map(), roster = new Map();
let srvOffset = null, ping = 0, respawnIn = 0, protect = 0, hitmark = 0, lastFire = 0;
const smooth = new THREE.Vector3();               // the visual correction after a reconcile, decayed away
const keys = {}; let mouseDown = false, rmb = false, locked = false, reloadQ = false, slotQ = null, DEBUG = params.has("debug");
addEventListener("contextmenu", e => e.preventDefault());
addEventListener("keydown", e => { if (e.target && e.target.id === "name") return; if (e.code === "F1") { e.preventDefault(); DEBUG = !DEBUG; return; } if (e.code === "Tab") e.preventDefault(); keys[e.code] = true; if (e.code === "KeyR") reloadQ = true; if (e.code === "Digit1") slotQ = "p"; if (e.code === "Digit3") slotQ = "k"; if (e.code === "KeyQ") slotQ = "q"; if (e.code === "KeyK" && !e.repeat) unstuck(); if (["Space", "ControlLeft"].includes(e.code)) e.preventDefault(); });
addEventListener("keyup", e => { keys[e.code] = false; });
addEventListener("mousedown", e => { if (!(locked || AUTO)) return; if (e.button === 0) mouseDown = true; if (e.button === 2) rmb = true; });
addEventListener("mouseup", e => { if (e.button === 0) mouseDown = false; if (e.button === 2) rmb = false; });
addEventListener("wheel", e => { if (locked) slotQ = slotQ || "q"; }, { passive: true });
let swayX = 0, swayY = 0;
addEventListener("mousemove", e => { if (!locked || !connected) return; swayX = clamp(swayX + e.movementX * .00025, -.03, .03); swayY = clamp(swayY + e.movementY * .00025, -.03, .03); const k = SET.sens * .022 * DEG * zoomMul(); me.yaw -= e.movementX * k; me.pitch = clamp(me.pitch - (SET.inv ? -1 : 1) * e.movementY * k, -89 * DEG, 89 * DEG); });
/* player settings (2026-11-01, group feedback: "need settings like mouse sens, fov"): kept per browser.
   Sensitivity is on CS's own scale (0.022 degrees per mouse count x sens), so a CS player types their number;
   5.7 matches the original feel. FOV is vertical degrees (74 = CS's 90 on a 4:3 screen, seen at 16:9). */
const SET = Object.assign({ sens: 5.7, tsens: 1, fov: 74, vol: 80, inv: false, xh: "#5cff8a", crouch: "c" },
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
    document.documentElement.style.setProperty("--xh", SET.xh); };
  const put = (k, v) => { SET[k] = v; saveSet(); paint(); if (k === "vol" && MG) MG.gain.value = v / 100; };
  sens.addEventListener("input", () => put("sens", +sens.value));
  sensN.addEventListener("change", () => { const v = parseFloat(sensN.value); if (v > 0 && v <= 30) put("sens", Math.round(v * 100) / 100); else paint(); });
  ts.addEventListener("input", () => put("tsens", +ts.value));
  fov.addEventListener("input", () => put("fov", +fov.value));
  vol.addEventListener("input", () => put("vol", +vol.value));
  inv.addEventListener("click", () => put("inv", !SET.inv));
  $("setCrouch").addEventListener("click", () => put("crouch", SET.crouch === "ctrl" ? "c" : "ctrl"));
  xh.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) put("xh", b.dataset.c); });
  for (const el of [sens, sensN, ts, fov, vol]) el.addEventListener("keydown", ev => ev.stopPropagation());   // typing a number is not moving
  paint();
})();
/* ── phones: a floating stick under the left thumb, drag the right side to look, buttons for the rest ── */
const TOUCH = params.has("touch") || matchMedia("(pointer: coarse)").matches;
if (TOUCH) document.body.classList.add("touch");
function touchPlay(on) {
  setLocked(on); if (!on) return;
  try { const el = document.documentElement, fs = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fs && !document.fullscreenElement) Promise.resolve(fs.call(el, { navigationUI: "hide" })).then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape")).catch(() => {}); } catch (e) {}
}
if (TOUCH) {
  const T = $("touch"), stick = $("stick"), knob = stick.firstElementChild, R = 50, SENS = .0052;
  let stickId = null, sx = 0, sy = 0; const look = new Map();   // touch id -> last x, y
  const press = (code, down) => { keys[code] = down; if (down && code === "KeyR") reloadQ = true; if (down && code === "KeyQ") slotQ = "q"; };
  const setStick = (dx, dy) => { const m = Math.hypot(dx, dy), k = m > R ? R / m : 1; dx *= k; dy *= k; knob.style.transform = `translate(${dx}px,${dy}px)`;
    const t = R * .3; keys.KeyW = dy < -t; keys.KeyS = dy > t; keys.KeyA = dx < -t; keys.KeyD = dx > t; keys.ShiftLeft = m > t && m < R * .7; };
  T.addEventListener("touchstart", ev => { ev.preventDefault(); audio(); touchesSeen++;
    for (const t of ev.changedTouches) { const b = t.target.closest && t.target.closest(".tb");
      if (b) { b.classList.add("dn");
        if (b.id === "tFire") { mouseDown = true; look.set(t.identifier, [t.clientX, t.clientY]); }
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
function setLocked(on) { $("play").textContent = connected ? "Resume" : "Play"; $("priv").hidden = connected; $("leave").hidden = !connected; $("unstuck").hidden = !connected; $("share").hidden = !(connected && currentRoom !== "DAILY"); if (!on) { for (const k in keys) keys[k] = false; rmb = false; mouseDown = false; for (const b of document.querySelectorAll(".tb.on,.tb.dn")) b.classList.remove("on", "dn"); } locked = on; if (locked && connected) $("load").textContent = ""; $("start").style.display = (locked && connected) || AUTO ? "none" : ""; if (!locked) mouseDown = false;  document.body.classList.toggle("playing", locked && connected); }
document.addEventListener("pointerlockchange", () => { if (!TOUCH) setLocked(document.pointerLockElement === renderer.domElement); });

/* ── sound ───────────────────────────────────────────────────────────────────── */
let AC = null, OUT = null, MG = null; function audio() { if (!AC) try { AC = new AudioContext(); OUT = AC.createBiquadFilter(); OUT.type = "lowpass"; OUT.frequency.value = 20000; MG = AC.createGain(); MG.gain.value = SET.vol / 100; OUT.connect(MG).connect(AC.destination); } catch (e) {} if (AC && AC.state === "suspended") AC.resume(); }
/* where a sound comes from: other players' shots and steps are panned left/right by their bearing and dulled when
   behind you, so you can hear where a fight or a footstep is. at(pos, fn) routes every sound fn makes through a
   panner + low-pass placed for pos; your own sounds stay centred */
let SND = null; const dest = () => SND || OUT;
function at(pos, fn) { if (!AC || !pos) return fn(); const rel = pos.clone().sub(camera.position); rel.y = 0; const d = rel.length() || 1, y = camera.rotation.y;
  const right = (rel.x * Math.cos(y) - rel.z * Math.sin(y)) / d, ahead = (-rel.x * Math.sin(y) - rel.z * Math.cos(y)) / d;
  const pan = AC.createStereoPanner(), lp = AC.createBiquadFilter(); pan.pan.value = clamp(right * .9, -.9, .9); lp.type = "lowpass"; lp.frequency.value = ahead >= 0 ? 20000 : 20000 - 17500 * Math.min(1, -ahead);
  pan.connect(lp).connect(OUT); SND = pan; try { fn(); } finally { SND = null; } setTimeout(() => { try { pan.disconnect(); lp.disconnect(); } catch (e) {} }, 3000); }
const muffle = on => { if (OUT) OUT.frequency.setTargetAtTime(on ? 420 : 20000, AC.currentTime, on ? .06 : .3); };
/* dying: a body-fall thud, a low drop, and a thin ringing in the ears that the muffling does not touch */
function deathSound() { if (!AC) return; const t = AC.currentTime;
  { const n = AC.sampleRate * .4 | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 5);
    const s = AC.createBufferSource(); s.buffer = b; const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 160; const g = AC.createGain(); g.gain.value = 1.4; s.connect(f).connect(g).connect(MG || AC.destination); s.start(t + .32); }
  { const o = AC.createOscillator(), g = AC.createGain(); o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(45, t + .7); g.gain.setValueAtTime(.35, t); g.gain.exponentialRampToValueAtTime(.001, t + .8); o.connect(g).connect(MG || AC.destination); o.start(t); o.stop(t + .82); }
  { const o = AC.createOscillator(), g = AC.createGain(); o.frequency.value = 3100; g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.035, t + .15); g.gain.exponentialRampToValueAtTime(.0001, t + 2.6); o.connect(g).connect(MG || AC.destination); o.start(t); o.stop(t + 2.7); } }
function shot(vol = 1, tone = 1) { if (!AC) return; const t = AC.currentTime, n = AC.sampleRate * .18 | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  const s = AC.createBufferSource(); s.buffer = b; const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 2400 * tone; const g = AC.createGain(); g.gain.setValueAtTime(.5 * vol, t); g.gain.exponentialRampToValueAtTime(.001, t + .17); s.connect(f).connect(g).connect(dest()); s.start(t); }
const TONE = { ak: [1, 1], m4: [.85, 1.25], aug: [.9, 1.1], awp: [1.6, .55], knife: [.5, 3] };
function gunSound(w, vol = 1, near = true) { const t = TONE[w] || TONE.ak; if (w === "knife") return swish(vol); if (w === "awp") return sniperSound(vol, near); shot(vol * t[0], t[1]); }
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
function tink(freq = 1800) { if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g = AC.createGain(); o.frequency.value = freq; g.gain.setValueAtTime(.15, t); g.gain.exponentialRampToValueAtTime(.001, t + .12); o.connect(g).connect(dest()); o.start(t); o.stop(t + .13); }

/* ── effects ─────────────────────────────────────────────────────────────────── */
const tracers = [], decals = [], tracerMat = new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: .8 });
const decalGeo = new THREE.CircleGeometry(.035, 8), decalMat = new THREE.MeshBasicMaterial({ color: 0x1a1612, transparent: true, opacity: .85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
function tracer(a, b, heavy = false) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), heavy ? tracerHeavy : tracerMat); l.userData.t = performance.now() + (heavy ? 220 : 50); scene.add(l); tracers.push(l);
  if (heavy) { const n = Math.min(26, Math.max(6, a.distanceTo(b) / 1.2 | 0)); for (let i = 1; i <= n; i++) { const p = a.clone().lerp(b, i / (n + 1)); puff(p, 0xd8d4cc, 1, .16, .05); } } }
const tracerHeavy = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95 }); tracerHeavy.userData.shared = true;
function decal(h, dir) { const d = new THREE.Mesh(decalGeo, decalMat); d.position.copy(h.point); const n = h.face.normal.clone(); if (n.dot(dir) > 0) n.negate(); d.position.addScaledVector(n, .005); d.lookAt(h.point.clone().add(n)); scene.add(d); decals.push(d); if (decals.length > 40) scene.remove(decals.shift()); }
/* small effects: dust and blood puffs, other players' muzzle flashes */
const parts = [], dotTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 32; const g = c.getContext("2d"), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); })();
function puff(pos, color, n = 7, size = .12, up = 1) {
  for (let i = 0; i < n && parts.length < 160; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color, transparent: true, depthWrite: false, opacity: .8 })); sp.position.copy(pos); sp.scale.setScalar(size * (.6 + Math.random() * .8));
    sp.userData = { v: new THREE.Vector3((Math.random() - .5) * 1.6, Math.random() * 1.4 * up, (Math.random() - .5) * 1.6), life: .45 + Math.random() * .3, age: 0 }; scene.add(sp); parts.push(sp); }
}
function flashAt(pos) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: 0xffc070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sp.position.copy(pos); sp.scale.setScalar(.35); sp.userData = { v: new THREE.Vector3(), life: .05, age: 0, flash: true }; scene.add(sp); parts.push(sp); }
function tickParts(dt) { for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i], u = p.userData; u.age += dt; if (u.age > u.life) { scene.remove(p); p.material.dispose(); parts.splice(i, 1); continue; }
  if (!u.flash) { u.v.y -= 2.5 * dt; p.position.addScaledVector(u.v, dt); p.material.opacity = .8 * (1 - u.age / u.life); p.scale.multiplyScalar(1 + dt * 1.5); } } }
/* footsteps: a dull thud every stride at running speed (walking and crouching are silent, as in CS), quieter far away */
function step(vol) { if (!AC || vol < .02) return; const t = AC.currentTime, n = AC.sampleRate * .07 | 0, b = AC.createBuffer(1, n, AC.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 4);
  const s = AC.createBufferSource(); s.buffer = b; const f = AC.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 500 + Math.random() * 200; const g = AC.createGain(); g.gain.value = .45 * vol; s.connect(f).connect(g).connect(dest()); s.start(t); }
const stepVol = p => clamp(1 - p.distanceTo(camera.position) / 32, 0, 1);
/* where a hit came from: a red arc around the crosshair, pointing at the shooter */
function hurtFrom(id) { const o = others.get(id); if (!o) return; const d = o.model.g.position.clone().sub(me.pos), a = Math.atan2(-d.x, -d.z) - me.yaw;
  const el = $("dmgdir"); el.style.transform = `translate(-50%,-50%) rotate(${-a}rad)`; el.style.opacity = 1; clearTimeout(el._t); el._t = setTimeout(() => el.style.opacity = 0, 900); }
let killerId = 0, myStep = 0, myDeath = null, wasAlive = true, diedAt = -9, deathEye = 1.6, deathRoll = .4;
/* dying: the view drops and rolls to the floor, colour drains, sound muffles, then the camera finds the killer and a card
   says who, with what, from how far and how hurt they are; on respawn the world fades back in from black */
function onDeath() {
  diedAt = nowS(); deathEye = eye(me) || 1.6; deathRoll = (Math.random() < .5 ? -1 : 1) * (.35 + Math.random() * .2);
  deathSound(); muffle(true); document.body.classList.add("dead");
  const hu = $("hurt"); hu.style.transition = "box-shadow .12s"; hu.style.boxShadow = "inset 0 0 220px rgba(210,25,15,.85)";
  setTimeout(() => { hu.style.transition = "box-shadow 1.2s"; hu.style.boxShadow = "inset 0 0 260px rgba(0,0,0,.92)"; }, 180);
  const e = myDeath && myDeath.id === myId ? myDeath : null, kid = e ? e.by : killerId, ktm = (roster.get(kid) || {}).team, wn = e ? (WEAPONS[WIDS[e.g]] || {}).name || "" : "";
  const self = kid === myId, hp = e && e.kh != null ? e.kh : null, hpc = hp > 60 ? "#5fd38a" : hp > 30 ? "#f2c14e" : "#ef5b4b";
  $("kc").innerHTML = `<span class="kl">${self ? "You died" : "Killed by"}</span>
    <div class="kn ${ktm ? "t" : "ct"}">${esc(self ? "Your own hand" : nameOf(kid))}${e && e.h ? '<span class="hs">Headshot</span>' : ""}</div>
    ${e && !self ? `<div class="km"><span><b>${esc(wn)}</b></span><span><b>${e.kd}</b> m away</span></div>` : ""}
    ${hp != null && !self ? `<div class="khp"><span>${hp} HP left</span><span class="bar2"><i style="width:${Math.min(100, hp)}%;background:${hpc}"></i></span></div>` : ""}
    <div class="rs"><span id="kcrt">Respawning</span><span class="bar2"><i id="kcr"></i></span></div>`;
  $("kc").hidden = !!(GM && GM.m === "rounds"); myDeath = null;
}
function onRespawn() {
  muffle(false); document.body.classList.remove("dead"); $("kc").hidden = true;
  const hu = $("hurt"); hu.style.transition = "box-shadow .4s"; hu.style.boxShadow = "";
  const f = $("fade"); f.style.transition = "none"; f.style.opacity = .85; requestAnimationFrame(() => requestAnimationFrame(() => { f.style.transition = "opacity .45s ease-out"; f.style.opacity = 0; }));
}
function feed(html, cls = "") { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; $("feed").prepend(d); setTimeout(() => d.remove(), 5000); while ($("feed").children.length > 6) $("feed").lastChild.remove(); }
const nameOf = id => id === myId ? "You" : (roster.get(id) || {}).name || "#" + id;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── the weapon in hand: the real model, gloved hands and forearms holding it ── */
const glove = new THREE.MeshStandardMaterial({ color: 0x2a2520, roughness: .85 }), sleeve = new THREE.MeshStandardMaterial({ color: 0x3b4a5f, roughness: .85 });
const HOLD = { knife: [0, null], ak: [0, .37], m4: [0, .37], aug: [0, .17], awp: [0, .3] };   // where the left hand rests, forward of the grip
function handAt(g, x, y, z, back) {
  const h = new THREE.Mesh(new THREE.SphereGeometry(.045, 14, 10), glove); h.position.set(x, y, z); g.add(h);
  const a = new THREE.Mesh(new THREE.CapsuleGeometry(.045, .3, 4, 10), sleeve); a.position.set(x + back[0], y + back[1], z + back[2]); a.lookAt(new THREE.Vector3(x, y, z).add(new THREE.Vector3(...back).multiplyScalar(3))); a.rotateX(Math.PI / 2); g.add(a);
}
function viewModel(w) {
  const g = new THREE.Group(), m = gunModel(w); g.add(m);
  // the weapon faces away from the sun: a little of its own light instead of a lamp (point lights cost every surface)
  m.traverse(o => { o.castShadow = false; if (o.isMesh) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(0x2a2a2a); } });
  handAt(g, 0, -.03, .0, [.05, -.12, .2]);
  if (HOLD[w][1] != null) handAt(g, -.01, -.01, -HOLD[w][1], [-.1, -.13, .14]);
  return g;
}
const gun = new THREE.Group(); camera.add(gun); gun.scale.setScalar(.62);
const VIEW = {}; for (const w of WIDS) { VIEW[w] = viewModel(w); VIEW[w].visible = false; gun.add(VIEW[w]); }
const muzzle = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,240,200,1)"); gr.addColorStop(.35, "rgba(255,180,80,.8)"); gr.addColorStop(1, "rgba(255,120,30,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sp.scale.setScalar(.12); camera.add(sp); return sp; })();
let flash = 0, kick = 0, bob = 0, swing = 0, shake = 0, fovPunch = 0;
const GUNPOS = new THREE.Vector3(.2, -.2, -.42);
const gunTip = () => camera.localToWorld(GUNPOS.clone().add(new THREE.Vector3(0, .036 * .62, -(MUZZLE[me.w] || .6) * .62)));

/* ── the network ─────────────────────────────────────────────────────────────── */
const nowS = () => performance.now() / 1000;
const serverNow = () => srvOffset == null ? 0 : nowS() + srvOffset;      // the server's clock, estimated
const viewTime = () => serverNow() - interp;                              // the moment the others are drawn at
function connect(q) {
  // relative to the page, so the game works at / or under a sub-path such as /play/ behind a reverse proxy
  const wsu = new URL("ws?" + new URLSearchParams(q), location.href); wsu.protocol = wsu.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(wsu.href);
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === "s") onSnap(m); else if (m.t === "w") onWelcome(m); else if (m.t === "r") onRoster(m.r); else if (m.t === "x") refused = m.why; else if (m.t === "newmap") { movingTo = m.why; $("big").innerHTML = `New map<small>${esc(m.why)}, loading${m.best ? `<br>Top of the last map: ${esc(m.best.name)}, ${m.best.k} kills` : ""}</small>`;
    try { sessionStorage.setItem("rejoin", JSON.stringify({ room: currentRoom, team, t: Date.now() })); } catch (e) {} setTimeout(() => location.reload(), m.best ? 3500 : 1500); } else if (m.t === "P") { ping = Math.round((nowS() - m.n) * 1000); ws.send(JSON.stringify({ t: "q", ms: ping })); } };
  ws.onclose = () => { if (!connected) { $("load").textContent = refused || "Could not join that room"; ws = null; refused = ""; $("start").style.display = ""; document.exitPointerLock && document.exitPointerLock(); return; }
    connected = false; if (movingTo) return;
    $("msg").innerHTML = "Connection lost<small>rejoining</small>";   // the server restarted or the network dropped: come straight back
    try { sessionStorage.setItem("rejoin", JSON.stringify({ room: currentRoom, team, t: Date.now(), lost: 1 })); } catch (e) {} setTimeout(() => location.reload(), 2000); };
}
let roomNoteUntil = 0, rejoined = false, currentRoom = "DAILY", movingTo = "", refused = "", GM = null, lastBoard = [], lastSpawn = 0, rosterRaw = null, mapLoadedFor = null;
async function onWelcome(m) {
  const sock = ws;
  myId = m.id; myTeam = m.team; srvOffset = m.tm - nowS(); { const cm = sleeveMaterial(myTeam); sleeve.map = cm.map; sleeve.bumpMap = cm.bumpMap; sleeve.bumpScale = cm.bumpScale; sleeve.color.set(0xffffff); sleeve.needsUpdate = true; }   // your own sleeves in your team\'s camouflage
  currentRoom = m.room;
  $("roomtag").textContent = m.room === "DAILY" ? m.title.toUpperCase() : "ROOM " + m.room; $("rcode").textContent = m.room;
  if (m.room !== "DAILY") { roomNoteUntil = nowS() + 8; if (!locked) $("share").hidden = false; } history.replaceState(null, "", m.room === "DAILY" ? "./" : "?room=" + m.room);
  if (mapLoadedFor !== m.map) { const pm = getMap(m.map);
    if (!pm) { try { sessionStorage.setItem("rejoin", JSON.stringify({ room: currentRoom, team, t: Date.now(), lost: 1 })); } catch (e) {} location.reload(); return; }
    $("load").textContent = "Loading the map " + mapPct + "%"; W = await pm; mapLoadedFor = m.map; $("load").textContent = ""; }
  if (ws !== sock || !sock || sock.readyState !== 1) return;   // closed while loading: stay on the menu
  if (rejoined) { $("load").textContent = (rejoined === "lost" ? "Reconnected" : "New map: " + m.title) + ". Press Play to continue."; rejoined = false; }
  connected = true; if (locked) { $("start").style.display = "none"; document.body.classList.add("playing"); } $("team").textContent = TEAM[myTeam]; $("team").className = myTeam ? "t" : "ct"; $("team").textContent = TEAM[myTeam];
  setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "p", n: nowS() })), 1000);
}
function hpCell(x) {
  const o = others.get(x.id), alive = x.id === myId ? me.alive : o ? o.alive !== false : true, hp = x.id === myId ? me.hp : o ? o.hp : null;
  if (!alive) return '<small>dead</small>';
  return x.team === myTeam ? (hp ?? 100) : '<small>alive</small>';
}
function onRoster(r) {
  rosterRaw = r;
  roster.clear(); for (const [id, name, team, bot, k, d, p] of r) roster.set(id, { id, name, team, bot, k, d, p });
  const rows = [...roster.values()].sort((a, b) => a.team - b.team || b.k - a.k);
  $("board").innerHTML = (GM && GM.ph === "over" ? `<h3>${esc(GM.msg)}</h3>` : "") + `<table><tr><th>Atlas / Ember</th><th>HP</th><th>Kills</th><th>Deaths</th><th>ping</th></tr>` + rows.map(x => `<tr class="${x.team ? "t" : "ct"}${x.id === myId ? " me" : ""}"><td>${esc(x.name)}${x.bot ? " <small>bot</small>" : ""}</td><td>${hpCell(x)}</td><td>${x.k}</td><td>${x.d}</td><td>${x.bot ? "" : x.p}</td></tr>`).join("") + "</table>";
  lastBoard = rows;
  for (const o of others.values()) if (roster.get(o.id) && o.named !== roster.get(o.id).name) { o.model.g.remove(o.model.tag); dispose(o.model.tag); o.model.tag = label(roster.get(o.id).name, o.team ? "#ffd27a" : "#9cc6ff"); o.model.tag.position.y = 2.05; o.model.tag.userData.enemy = o.team !== myTeam; if (o.model.tag.userData.enemy) o.model.tag.material.depthTest = true; o.model.tag.userData.draw(o.hp ?? 100); o.model.g.add(o.model.tag); o.named = roster.get(o.id).name; }
}
let snapN = 0;
function onSnap(m) {
  if (!W) return; snapN++;
  // the server's clock: follow the newest estimate smoothly; a jump of half a second or more is taken at once
  // the server clock: the least-delayed packets of the last two seconds say it best; follow them slowly, so a
  // jittery connection does not shake everyone else on screen. The interpolation delay grows with the jitter
  const est = m.tm - nowS(); ests.push(est); if (ests.length > 64) ests.shift();
  const hi = Math.max(...ests), lo = Math.min(...ests);
  if (srvOffset == null || Math.abs(hi - srvOffset) > .3) srvOffset = hi; else srvOffset += clamp(hi - srvOffset, -.002, .002);
  interp = clamp(.075 + (hi - lo), .1, .25);
  // reconcile: the server's state after the last command it ran, then the commands still in flight replayed on top
  const before = me.pos.clone(), y = m.me;
  me.pos.set(y.p[0], y.p[1], y.p[2]); me.vel.set(y.v[0], y.v[1], y.v[2]); me.duck = y.d; me.onGround = y.g; me.jumpHeld = y.j; me.hp = y.h; me.alive = y.al;
  me.mag = y.m; me.res = y.r; me.reloadAt = y.ra; me.nextShot = y.ns; me.spray = y.sp; me.lastShot = y.ls; me.punchX = y.px; me.punchY = y.py; me.clock = y.ck;
  respawnIn = y.ra2 || 0; protect = y.pr || 0;
  if (y.sn && y.sn !== lastSpawn) { lastSpawn = y.sn; me.yaw = y.syw; me.pitch = 0; }
  me.w = y.w; me.prim = y.pm; me.last = y.la; me.zoom = y.z; me.deployUntil = y.du; me.zoomHeld = y.zh;
  if (m.pk) syncPickups(m.pk);
  pending = pending.filter(c => c.seq > m.a);
  const yaw = me.yaw, pitch = me.pitch;   // (a spawn turn above already set these)
  for (const c of pending) { me.clock += DT; move(W, me, c); weapon(me, c, me.clock, 0); }
  me.yaw = yaw; me.pitch = pitch;
  const err = before.sub(me.pos); if (err.lengthSq() < 4) smooth.add(err); else smooth.set(0, 0, 0);
  // everyone else: snapshots kept to draw between
  const seen = new Set();
  for (const [id, team, , x, yy, z, yw, pt, dk, al, vx, vz, wi, hp, vis] of m.e) {
    if (id === myId) continue; seen.add(id);
    let o = others.get(id); if (!o) { o = { id, team, model: person(team, nameOf(id)), named: nameOf(id), buf: [] }; others.set(id, o); }
    if (o.gone) { o.gone = false; o.buf.length = 0; o.model.last = null; }   // back in view: start fresh, no slide from where it vanished
    o.vis = vis !== 0;
    o.buf.push({ tm: m.tm, x, y: yy, z, yaw: yw, pitch: pt, duck: dk, alive: al, vx, vz }); if (o.buf.length > 40) o.buf.shift();
    o.model.sd.setWeapon(WIDS[wi] || "ak"); o.hp = hp; o.model.tag.userData.draw(hp ?? null);
  }
  // someone not in this update is out of sight (kept, hidden) or has left the room (removed once the roster drops them)
  for (const [id, o] of others) if (!seen.has(id)) { if (rosterRaw && !roster.has(id) && o.gone) { scene.remove(o.model.g); dispose(o.model.g); others.delete(id); } else { o.gone = true; o.vis = false; } }
  if (m.gm) { const ph = GM && GM.ph; GM = m.gm; if (ph !== GM.ph && rosterRaw) onRoster(rosterRaw); }
  for (const e of m.ev) onEvent(e);
}
function onEvent(e) {
  if (e.k === "shot" && e.id !== myId) { const a = new THREE.Vector3(...e.f), b = new THREE.Vector3(...e.t); const aw = WIDS[e.g] === "awp"; tracer(a.clone().lerp(b, .02), b, aw); at(a, () => gunSound(WIDS[e.g], clamp(1 - a.distanceTo(camera.position) / (aw ? 120 : 60), aw ? .25 : .08, .8), false)); if (aw && a.distanceTo(camera.position) < 25) shake = Math.max(shake, .25);
    flashAt(a.clone().lerp(b, Math.min(.9, .7 / Math.max(.7, a.distanceTo(b))))); if (e.w) puff(b, 0xb8a888, 6, .1); }
  else if (e.k === "melee" && e.id !== myId) { swish(clamp(1 - new THREE.Vector3(...e.f).distanceTo(camera.position) / 20, .05, .8)); }
  else if (e.k === "ammo" && e.id === myId) { tink(1000); feed("Ammo refilled"); }
  else if (e.k === "pick" && e.id === myId) { tink(1400); }
  else if (e.k === "kevlar" && e.id === myId) { tink(1200); feed("Kevlar, +50 health"); }
  else if (e.k === "bandage" && e.id === myId) { tink(1500); feed("Bandaged, +40 health"); }
  else if (e.k === "roundEnd") tink(e.w === myTeam ? 1600 : 500);
  else if (e.k === "match") tink(e.w === myTeam ? 2000 : 400);
  else if (e.k === "hit") { const v = others.get(e.id); if (v) puff(v.model.g.position.clone().setY(v.model.g.position.y + (e.h ? 1.65 : 1.2)), 0x9a1010, 8, .1, .4);
    if (e.id === myId) { hurtFrom(e.by); $("hurt").style.boxShadow = "inset 0 0 140px rgba(255,40,30,.55)"; setTimeout(() => $("hurt").style.boxShadow = "", 160); if (e.h) tink(900); } else if (e.by === myId) { tink(e.h ? 2200 : 1300); hitmark = performance.now() + 120; window.__hits = (window.__hits || 0) + 1; } }
  else if (e.k === "kill") { const hs = e.h ? " hs" : ""; if (e.id === myId) { killerId = e.by; myDeath = e; }
    feed(`${esc(nameOf(e.by))} <small>${esc((WEAPONS[WIDS[e.g]] || {}).name || "")}</small> <b>${e.h ? "&#9673;" : "&#8594;"}</b> ${esc(nameOf(e.id))}`, (e.by === myId || e.id === myId ? "mine" : "") + hs); }
}

/* ── the client's own ticks: input to a command, predicted at once, sent in batches ─ */
let acc = 0, last = nowS(), outbox = [];
function tickInput() {
  const cmd = { seq: ++seq, f: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), jump: !!keys.Space, duck: !!(SET.crouch === "ctrl" ? (keys.ControlLeft || keys.ControlRight) : keys.KeyC),
    walk: !!keys.ShiftLeft, fire: mouseDown && (locked || AUTO), reload: reloadQ, yaw: me.yaw, pitch: me.pitch, vt: +viewTime().toFixed(4),
    slot: slotQ, zoom: rmb && (locked || AUTO), use: !!keys.KeyE };
  if (GM && GM.fz) { cmd.f = cmd.s = 0; cmd.jump = cmd.fire = false; }
  reloadQ = false; slotQ = null; me.clock += DT;
  move(W, me, cmd);
  const s = weapon(me, cmd, me.clock, (myId * 100003 + cmd.seq) >>> 0);
  if (s && s.melee) { swish(1); swing = 1; lastFire = performance.now(); }
  else if (s) {   // the predicted shot: tracer, decal and sound now; the damage is the server's to decide
    const o = new THREE.Vector3(me.pos.x, me.pos.y + eye(me), me.pos.z), h = W.first(o, s.dir, 300);
    const aw = me.w === "awp"; tracer(gunTip(), o.clone().addScaledVector(s.dir, h ? h.distance : 300), aw); if (h) { decal(h, s.dir); puff(h.point, 0xb8a888, aw ? 14 : 6, aw ? .18 : .1); } gunSound(me.w, 1); flash = aw ? .09 : .045; kick = aw ? 4 : 1; if (aw) { shake = 1; fovPunch = 1; $("hurt").style.transition = "none"; $("hurt").style.boxShadow = "inset 0 0 160px rgba(255,236,200,.35)"; setTimeout(() => { $("hurt").style.transition = "box-shadow .3s"; if (me.alive) $("hurt").style.boxShadow = ""; }, 60); } lastFire = performance.now();
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
renderer.domElement.addEventListener("webglcontextlost", () => diag("contextlost"));
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
    if (o.clone().addScaledVector(d, t).distanceTo(c) > .55) continue;
    if (W.first(o, c.clone().sub(o).normalize(), c.distanceTo(o) - .3)) continue;
    best = t; aimedAt = x; }
}
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
    const was = o.model.phase; o.model.phase += moved * 3.2; const speed = Math.hypot(s1.vx, s1.vz);
    if (speed > 3.5 && s1.alive && Math.floor(was / Math.PI) !== Math.floor(o.model.phase / Math.PI)) at(o.model.g.position, () => step(stepVol(o.model.g.position)));
    g.visible = !!o.vis && !o.gone; g.position.set(x, y, z); g.rotation.y = lerpAng(s0.yaw, s1.yaw, k);
    o.model.sd.pose(s1.alive ? speed : 0, o.model.phase, duck, s1.alive ? pitch : 0);
    if (!s1.alive) { g.rotation.x = Math.max(g.rotation.x - .1, -Math.PI / 2); g.position.y = y + .2; o.model.tag.visible = false; } else { g.rotation.x = 0; o.model.tag.visible = !o.model.tag.userData.enemy || o === aimedAt; }
    o.alive = s1.alive;
  }
}
function render(dt) {
  smooth.multiplyScalar(Math.exp(-dt * 12));
  if (wasAlive && !me.alive) onDeath(); else if (!wasAlive && me.alive) onRespawn(); wasAlive = me.alive;
  const dk = me.alive ? 0 : clamp((nowS() - diedAt) / .6, 0, 1), de = 1 - Math.pow(1 - dk, 3);   // the fall, eased
  camera.position.set(me.pos.x + smooth.x, me.pos.y + smooth.y + (me.alive ? eye(me) : deathEye + (.32 - deathEye) * de), me.pos.z + smooth.z);
  camera.rotation.order = "YXZ"; camera.rotation.z = me.alive ? 0 : deathRoll * de * (nowS() - diedAt > 1.1 ? .55 : 1);
  if (!me.alive && nowS() - diedAt < 1.1) { camera.rotation.y = me.yaw; camera.rotation.x = me.pitch + (-.25 - me.pitch) * de; }
  else if (!me.alive && others.get(killerId)) { const d = others.get(killerId).model.g.position.clone().sub(camera.position); d.y += 1.2; camera.rotation.y = lerpAng(camera.rotation.y, Math.atan2(-d.x, -d.z), Math.min(1, dt * 4)); camera.rotation.x += (Math.atan2(d.y, Math.hypot(d.x, d.z)) - camera.rotation.x) * Math.min(1, dt * 4); }
  else { camera.rotation.y = me.yaw - me.punchX * .45; camera.rotation.x = me.pitch + me.punchY * .45; }
  if (shake > 0) { const a = shake * shake * .035; camera.rotation.x += (Math.random() - .3) * a; camera.rotation.y += (Math.random() - .5) * a; camera.rotation.z += (Math.random() - .5) * a * .6; shake = Math.max(0, shake - dt * 3.2); }
  const sp = Math.hypot(me.vel.x, me.vel.z); bob += dt * sp * 1.7; kick = Math.max(0, kick - dt * (kick > 1.5 ? 9 : 14)); fovPunch = Math.max(0, fovPunch - dt * 6); flash = Math.max(0, flash - dt);
  const W0 = wpn(me), scoped = !!(W0.zoom && me.zoom), deploying = me.clock < me.deployUntil;
  for (const w of WIDS) VIEW[w].visible = w === me.w;
  swing = Math.max(0, swing - dt * 5);
  gun.position.set(GUNPOS.x + Math.cos(bob) * .006 * (me.onGround ? 1 : 0) - swing * .06, GUNPOS.y + Math.abs(Math.sin(bob)) * .007 - (deploying ? .12 : 0), GUNPOS.z + kick * .03 - swing * .1);
  muzzle.position.set(GUNPOS.x, GUNPOS.y + .025, GUNPOS.z - (MUZZLE[me.w] || .6) * .62);
  swayX *= Math.exp(-dt * 8); swayY *= Math.exp(-dt * 8);
  const rl = me.reloadAt ? clamp((me.reloadAt - me.clock) / (W0.reload || 2), 0, 1) : 0, dip = Math.sin(rl * Math.PI);   // the reload: down, tilted, back up
  gun.position.x -= swayX; gun.position.y += swayY - dip * .09;
  gun.rotation.set(swing * .9 + dip * .5 + (kick > 1.5 ? kick * .07 : 0), swing * .6 - swayX * 2, dip * .6);
  if (me.alive && me.onGround && sp > 3.5) { myStep += sp * dt * 3.2; if (myStep > Math.PI) { myStep -= Math.PI; step(.5); } }
  tickParts(dt);
  gun.visible = (me.alive || nowS() - diedAt < .45) && !scoped; if (!me.alive) { gun.position.y -= de * .5; gun.rotation.z += de * 1.1; } muzzle.visible = flash > 0 && !W0.melee && !scoped; muzzle.material.rotation = Math.random() * 6;
  const kcam = !me.alive && nowS() - diedAt > 1.1 && others.get(killerId), fov = kcam ? 46 : (scoped ? 2 * Math.atan(Math.tan(SET.fov / 2 * DEG) * W0.zoom[me.zoom]) / DEG : SET.fov) + fovPunch * 5;
  if (Math.abs(camera.fov - fov) > .01) { camera.fov = kcam ? camera.fov + (fov - camera.fov) * Math.min(1, dt * 2.5) : fov; camera.updateProjectionMatrix(); }
  $("scope").style.display = scoped && me.alive ? "block" : "none";
  $("xh").style.display = scoped || me.w === "awp" || !me.alive ? "none" : "block";
  nearPick = null; let bd = 1.6;
  for (const p of pickups.values()) { if (p.mesh.userData.spin) p.mesh.userData.spin.rotation.y += dt * 1.5;
    if (p.kind === 0 && me.alive && !p.away) { const d = Math.hypot(me.pos.x - p.pos.x, me.pos.z - p.pos.z); if (d < bd && Math.abs(me.pos.y - p.pos.y) < 1.3) { bd = d; nearPick = p; } } }
  if (TOUCH) { $("tUse").hidden = !nearPick; $("tZoom").hidden = !W0.zoom; }
  $("prompt").textContent = nearPick ? "E  pick up " + WEAPONS[nearPick.w].name + (me.prim ? " (drops your " + WEAPONS[me.prim].name + ")" : "") : "";
  $("wname").textContent = W0.name + (scoped ? "  x" + Math.round(1 / W0.zoom[me.zoom]) : "");
  drawOthers();
  const pn = performance.now(); for (let i = tracers.length - 1; i >= 0; i--) if (pn > tracers[i].userData.t) { scene.remove(tracers[i]); tracers[i].geometry.dispose(); tracers.splice(i, 1); }
  $("hpv").textContent = me.hp; $("hpv").style.color = me.hp > 100 ? "#7fb6ff" : me.hp <= 30 ? "#ef5b4b" : ""; $("mag").textContent = W0.melee ? "-" : me.reloadAt ? "--" : me.mag; { const full = (WEAPONS[me.w] || {}).mag || 30, lowA = !W0.melee && !me.reloadAt && me.mag <= Math.max(1, Math.floor(full * .3));
    $("mag").style.color = W0.melee || me.reloadAt ? "" : me.mag === 0 ? "#ef5b4b" : lowA ? "#f2c14e" : "";
    $("rldp").textContent = !W0.melee && me.alive && !me.reloadAt && me.mag === 0 ? (me.res > 0 ? (TOUCH ? "reload" : "R  reload") : "no ammo") : "";
    const ring = $("rldr"), on = !!me.reloadAt && me.alive && !W0.melee; ring.style.opacity = on ? 1 : 0;
    if (on) ring.querySelector("circle.f").style.strokeDashoffset = (113.1 * clamp((me.reloadAt - me.clock) / (W0.reload || 2), 0, 1)).toFixed(1); } $("res").textContent = W0.melee ? "" : "/ " + me.res; $("ping").textContent = ping + " ms";
  if (connected && GM) {
    const mm = t => Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"), rounds = GM.m === "rounds";
    if (!me.alive && !rounds && $("kcr")) { const left = Math.max(0, respawnIn); $("kcr").style.width = (100 * (1 - left / 3)).toFixed(1) + "%"; $("kcrt").textContent = left > .05 ? "Back in " + left.toFixed(1) + " s" : "Back in"; }
    $("clock").textContent = mm(GM.tl); $("sct").textContent = GM.sc[0]; $("st").textContent = GM.sc[1]; $("rnd").textContent = rounds ? "ROUND " + GM.rn : "DM";
    $("big").innerHTML = GM.ph === "over" ? `${esc(GM.msg)}<small>next match in ${GM.tl} s</small>` : GM.ph === "end" ? `${esc(GM.msg)}` : GM.ph === "freeze" ? `Round ${GM.rn}<small>starts in ${GM.tl}</small>` : "";
    $("board").style.display = GM.ph === "over" || keys.Tab ? "block" : "none";
    $("msg").innerHTML = !me.alive ? (rounds ? (GM.ph === "live" ? "You are dead<small>you play again next round</small>" : "") : "") : nowS() < roomNoteUntil ? `Room ${currentRoom}<small>Esc for the invite link</small>` : protect > 0 ? `<small>spawn protection ${protect.toFixed(1)} s</small>` : "";
  }
  const gap = 3 + inaccuracy(me) / DEG * 3.2 + (pn - lastFire < 120 ? 3 : 0), len = 7, th = 2, [l, r, u, d] = $("xh").children;
  l.style.cssText = `left:${-gap - len}px;top:${-th / 2}px;width:${len}px;height:${th}px`; r.style.cssText = `left:${gap}px;top:${-th / 2}px;width:${len}px;height:${th}px`;
  u.style.cssText = `left:${-th / 2}px;top:${-gap - len}px;width:${th}px;height:${len}px`; d.style.cssText = `left:${-th / 2}px;top:${gap}px;width:${th}px;height:${len}px`;
  $("xh").classList.toggle("hit", pn < hitmark);
  $("dbg").textContent = DEBUG ? `quality step ${qLevel}  ping ${ping} ms  interp ${Math.round(interp * 1000)} ms  unconfirmed commands ${pending.length}\nspeed ${(sp / U).toFixed(0)} u/s ${me.onGround ? "ground" : "air"}\npos ${me.pos.x.toFixed(1)} ${me.pos.y.toFixed(2)} ${me.pos.z.toFixed(1)}  correction ${(smooth.length() * 100).toFixed(1)} cm\nothers ${others.size}` : "";
  shadowT += dt; if (shadowT > .05) { shadowT = 0; renderer.shadowMap.needsUpdate = true; }
  renderer.render(scene, camera);
}

/* ── boot ────────────────────────────────────────────────────────────────────── */
const saved = (() => { try { return localStorage.getItem("fps-name"); } catch (e) { return null; } })();
$("name").value = params.get("name") || saved || "";   // empty shows the placeholder; Play picks a name if none is typed
let team = "auto", room = (params.get("room") || "DAILY").toUpperCase(), withBots = true;
$("teams").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return; team = b.dataset.team; for (const x of $("teams").children) x.classList.toggle("on", x === b); });
$("bots").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return; withBots = b.dataset.b === "1"; $("botn").classList.toggle("off", !withBots);
  for (const x of $("bots").children) { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); } });
document.querySelector(".priv .tabs").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return;
  for (const x of b.parentNode.children) { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); $(x.dataset.tab).hidden = x !== b; }
  if (b.dataset.tab === "jn") $("code").focus(); });
let botN = 3; const setBots = n => { botN = Math.max(1, Math.min(5, n)); $("botv").textContent = botN; const [dn, up] = $("botn").querySelectorAll("button"); dn.disabled = botN <= 1; up.disabled = botN >= 5; };
$("botn").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) setBots(botN + +b.dataset.d); }); setBots(3);
const showJoin = () => document.querySelector('.priv .tabs [data-tab="jn"]').click();
/* today's map: its picture behind the menu, its name, the next one and when */
const span = t => t >= 3600 ? Math.floor(t / 3600) + " h " + Math.floor(t % 3600 / 60) + " min" : Math.max(1, Math.floor(t / 60)) + " min";
async function loadToday() {
  let r = null; try { r = (await fetch("rooms", { cache: "no-store" }).then(x => x.json()))[0]; } catch (e) {}
  if (!r) return;
  if (r.map) getMap(r.map);
  $("mapname").textContent = r.title; if (r.next) { nextName = r.next.map.replace(/, HY-World$/, ""); nextAt = Date.now() + r.next.in * 1000; tickNext(); }
  // today's best on this map, and the last maps with whoever topped them
  const rows = (r.board || []).map((b, i) => `<li><i>${i + 1}</i><b>${esc(b.name)}</b><span>${b.k}<small>K</small></span><span>${b.d}<small>D</small></span></li>`).join("");
  $("lbtop").innerHTML = rows || `<li class="none">No kills yet</li>`;
  $("lbpast").innerHTML = (r.past || []).map(p => `<figure><span class="th" style="background-image:url(${esc(p.preview)})"></span><figcaption><b>${esc(p.map)}</b>${p.best ? `<small>${esc(p.best.name)}, ${p.best.k} kills</small>` : `<small>No winner</small>`}</figcaption></figure>`).join("");
  $("lbpastw").hidden = !(r.past || []).length;
  $("online").textContent = r.online + " playing";
  const bg = $("bg"), url = r.preview; if (bg.dataset.src !== url) { bg.dataset.src = url; const im = new Image(); im.onload = () => { bg.style.backgroundImage = `url(${url})`; requestAnimationFrame(() => bg.classList.add("in")); }; im.src = url; }
}
let nextAt = 0, nextName = "";
/* the countdown to the next world ticks every second */
function tickNext() { if (!nextAt) return; const t = Math.max(0, Math.round((nextAt - Date.now()) / 1000));
  $("nextmap").textContent = "Next: " + nextName + " in " + (t >= 3600 ? span(t) : Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0")); }
setInterval(tickNext, 1000);
loadToday(); setInterval(() => { if (!connected) loadToday(); }, 15000);
/* pointer lock needs a click; a refusal (no click yet) is not an error */
function lockMouse() { if (TOUCH) return touchPlay(true); try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
function start(q) {
  const n = $("name").value.trim().slice(0, 16) || "player" + (Math.random() * 900 + 100 | 0); if ($("name").value.trim()) try { localStorage.setItem("fps-name", n); } catch (e) {}
  if (ws && ws.readyState > 1) ws = null;   // a dead socket never blocks Play
  if (ws) { if (connected) { audio(); lockMouse(); } return; }
  $("load").textContent = "connecting"; audio(); connect({ name: n, team, ...q }); if (!AUTO && !q.quiet) lockMouse();
}
$("play").addEventListener("click", () => start({ room }));
/* unstuck: respawn now (a self-kill; the server allows one every 10 s) - K, or the pause menu's button */
function unstuck() { if (ws && ws.readyState === 1 && connected && me.alive) ws.send(JSON.stringify({ t: "u" })); }
$("unstuck").addEventListener("click", () => { unstuck(); lockMouse(); });
/* leave: back to a fresh menu (no rejoin), out of any private room */
$("leave").addEventListener("click", () => { movingTo = "leave"; try { sessionStorage.removeItem("rejoin"); ws && ws.close(); } catch (e) {} location.href = location.pathname; });
const invite = () => location.origin + location.pathname + "?room=" + currentRoom;
$("copylink").addEventListener("click", async () => { let ok = false; try { await navigator.clipboard.writeText(invite()); ok = true; } catch (e) {}
  $("sharehint").textContent = ok ? "Copied. Send it to your friends" : invite(); });
if (room !== "DAILY" && !AUTO) { showJoin(); $("code").value = room; $("load").textContent = "Invited to room " + room + ". Press Play to join"; }
$("create").addEventListener("click", () => start({ create: "1", bots: withBots ? "1" : "0", bpt: botN, title: ($("name").value.trim() || "player") + "'s room" }));
$("joincode").addEventListener("click", () => { const c = $("code").value.trim().toUpperCase(); if (c.length !== 4) { $("load").textContent = "A room code is 4 letters"; return; } start({ room: c }); });
for (const id of ["name", "code"]) $(id).addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Enter") (id === "code" ? $("joincode") : $("play")).click(); });
{ let rj = null; try { rj = JSON.parse(sessionStorage.getItem("rejoin") || "null"); sessionStorage.removeItem("rejoin"); } catch (e) {}
  if (rj && Date.now() - rj.t < 30000) { team = rj.team || "auto"; room = rj.room; rejoined = rj.lost ? "lost" : "map"; start({ room, quiet: 1 }); } }
if (AUTO) { $("start").style.display = "none"; team = params.get("team") || "auto"; start(params.get("create") ? { create: "1", bots: params.get("bots") || "1", bpt: params.get("bpt") || "", title: "test" } : { room }); }
if (AUTO || DEBUG) window.__g = { ws: () => ws, snaps: () => snapN, start,me, others, roster, keys, pending: () => pending, ping: () => ping, setMouse: v => { mouseDown = v; }, connected: () => connected, W: () => W, myId: () => myId, smooth, viewTime };
requestAnimationFrame(frame);
