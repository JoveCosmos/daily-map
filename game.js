/* Daily Map PoC, multiplayer client. The server decides everything; this page predicts its own player so input
   feels instant (move and shoot locally, then reconcile with each snapshot by replaying the commands the server has
   not confirmed), and draws everyone else 100 ms in the past, interpolated between snapshots. Shots carry the
   view time they were aimed in, so the server can rewind the others to what this screen showed (lag compensation). */
import * as THREE from "three";
import { World, DT, U, DEG, clamp, newPlayer, move, weapon, eye, inaccuracy, standinParts, gltfGeometries, WEAPONS, WIDS, wpn, NADES, NADE, viewDir } from "./sim.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
const gltf = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);   // map files are meshopt-compressed, about 17x smaller
import { gunModel, soldier, MUZZLE, sleeveMaterial, applyFinish, FINISHES, loadGunModels, loadArms, makeArms } from "./models.js";
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
function dispose(o) { o.traverse(x => { if (x.geometry && !x.geometry.userData.shared) x.geometry.dispose(); const ms = x.material ? (Array.isArray(x.material) ? x.material : [x.material]) : [];
  for (const m of ms) if (!m.userData.shared) { if (m.map && !m.map.userData.shared) m.map.dispose(); m.dispose(); } }); }
/* ── state ───────────────────────────────────────────────────────────────────── */
let W = null, ws = null, myId = 0, myTeam = 0, seq = 0, pending = [], connected = false;
const me = newPlayer(); me.clock = 0;
const others = new Map(), roster = new Map();
let srvOffset = null, ping = 0, respawnIn = 0, protect = 0, hitmark = 0, lastFire = 0;
const smooth = new THREE.Vector3();               // the visual correction after a reconcile, decayed away
const keys = {}; let mouseDown = false, rmb = false, locked = false, reloadQ = false, slotQ = null, DEBUG = params.has("debug");
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
function setLocked(on) { $("play").textContent = connected ? "Resume" : "Play"; $("priv").hidden = connected; $("leave").hidden = !connected; $("unstuck").hidden = !connected; $("share").hidden = !(connected && currentRoom !== "DAILY"); if (!on) { for (const k in keys) keys[k] = false; rmb = false; mouseDown = false; for (const b of document.querySelectorAll(".tb.on,.tb.dn")) b.classList.remove("on", "dn"); } locked = on; if (locked && connected) $("load").textContent = ""; $("start").style.display = (locked && connected) || AUTO ? "none" : ""; if (!locked) mouseDown = false;  document.body.classList.toggle("playing", locked && connected); }
document.addEventListener("pointerlockchange", () => { if (TOUCH) return; const on = document.pointerLockElement === renderer.domElement; if (!on && BUY.free && BUY.open) return; setLocked(on); });   // the buy menu frees the mouse without pausing

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
function at(pos, fn) { if (!AC || !pos) return fn(); const rel = pos.clone().sub(camera.position), dist = rel.length() || 1; rel.y = 0; const d = rel.length() || 1, y = camera.rotation.y;
  const right = (rel.x * Math.cos(y) - rel.z * Math.sin(y)) / d, ahead = (-rel.x * Math.sin(y) - rel.z * Math.cos(y)) / d;
  const pan = AC.createPanner(), lp = AC.createBiquadFilter(), wet = AC.createGain(); pan.panningModel = TOUCH ? "equalpower" : "HRTF"; pan.distanceModel = "linear"; pan.rolloffFactor = 0;
  if (pan.positionX) { pan.positionX.value = right; pan.positionZ.value = -ahead; } else pan.setPosition(right, 0, -ahead);
  const walled = W && dist > 1.5 && W.first(camera.position, pos.clone().sub(camera.position).normalize(), dist - .6);
  lp.type = "lowpass"; lp.frequency.value = Math.min(walled ? 1300 : ahead >= 0 ? 20000 : 20000 - 9000 * Math.min(1, -ahead), 20000 / (1 + dist / 30));
  wet.gain.value = clamp(dist / 70, .05, .4) * (walled ? 1.4 : 1); pan.connect(lp).connect(OUT); lp.connect(wet); if (VERB) wet.connect(VERB);
  const late = dist > 6 ? AC.createDelay(1) : null; if (late) { late.delayTime.value = Math.min(.99, dist / 343); late.connect(pan); }
  SND = late || pan; try { fn(); } finally { SND = null; } setTimeout(() => { try { if (late) late.disconnect(); pan.disconnect(); lp.disconnect(); wet.disconnect(); } catch (e) {} }, 4500); }
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
  return true; }
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

/* ── effects ─────────────────────────────────────────────────────────────────── */
const tracers = [], decals = [], tracerMat = new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: .8 });
/* a bullet hole (2026-11-16): a dark scorched core in a rough ring of chipped surface, drawn once, not a flat disc */
const holeTex = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
  for (let i = 0; i < 26; i++) { const a = Math.random() * Math.PI * 2, r = 10 + Math.random() * 16; g.fillStyle = `rgba(40,32,24,${.1 + Math.random() * .25})`; g.beginPath(); g.arc(32 + Math.cos(a) * r * .6, 32 + Math.sin(a) * r * .6, 2 + Math.random() * 5, 0, 7); g.fill(); }
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 20); gr.addColorStop(0, "rgba(8,6,5,1)"); gr.addColorStop(.35, "rgba(20,15,11,.95)"); gr.addColorStop(.6, "rgba(70,55,40,.45)"); gr.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gr; g.beginPath(); g.arc(32, 32, 20, 0, 7); g.fill(); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
const decalGeo = new THREE.PlaneGeometry(.085, .085), decalMat = new THREE.MeshBasicMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
function tracer(a, b, heavy = false) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), heavy ? tracerHeavy : tracerMat); l.userData.t = performance.now() + (heavy ? 220 : 50); scene.add(l); tracers.push(l);
  if (heavy) { const n = Math.min(26, Math.max(6, a.distanceTo(b) / 1.2 | 0)); for (let i = 1; i <= n; i++) { const p = a.clone().lerp(b, i / (n + 1)); puff(p, 0xd8d4cc, 1, .16, .05); } } }
const tracerHeavy = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: .95 }); tracerHeavy.userData.shared = true;
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
/* ── talking (2026-11-14): chat (Y everyone, U team), the radio (Z, then a number), a ping (middle click) ─────── */
const RADIO = ["Enemy spotted", "Need backup", "Cover me", "Go, go, go", "Fall back", "Hold this position", "Affirmative", "Negative", "Sector clear", "I'm in position"];
const CHAT = { team: false, radio: false }, PINGS = [];
function chatLine(html) { const d = document.createElement("div"); d.innerHTML = html; $("chat").appendChild(d); while ($("chat").children.length > 7) $("chat").firstChild.remove(); setTimeout(() => d.classList.add("old"), 9000); }
function openChat(team) { CHAT.team = team; for (const k in keys) keys[k] = false; mouseDown = rmb = false; const i = $("chatin"); i.hidden = false; i.placeholder = team ? "Team: say something, Enter to send" : "Everyone: say something, Enter to send"; i.value = ""; i.focus(); }
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

/* ── Competitive (2026-11-14): the buy menu (B, then number keys, as CS's classic menu; or a click/tap), money, the
   bomb's sites, plant and defuse progress, the bomb in the world and on the radar, its beeps ───────────────────────── */
const PRICE = { glock: [200, 1], usp: [200, 0], p250: [300], fiveseven: [500, 0], tec9: [500, 1], cz75: [500], deagle: [700],
                mp9: [1250, 0], mac10: [1050, 1], mp7: [1500], ump: [1200], p90: [2350], nova: [1050], xm1014: [2000], negev: [1700],
                galil: [1800, 1], famas: [2050, 0], ak: [2700, 1], m4: [3100, 0], m4a1s: [2900, 0], sg553: [3000, 1], aug: [3300, 0], ssg08: [1700], awp: [4750],
                vest: [650], vesthelm: [1000], he: [300], flash: [200], smoke: [300], molotov: [400, 1], incendiary: [600, 0], decoy: [50], kit: [400, 0], zeus: [200] };   // same as server.js
const BUYCATS = [["Pistols", ["usp", "glock", "p250", "fiveseven", "tec9", "cz75", "deagle"]], ["SMGs", ["mp9", "mac10", "mp7", "ump", "p90"]], ["Heavy", ["nova", "xm1014", "negev"]],
                 ["Rifles", ["famas", "galil", "m4", "m4a1s", "ak", "sg553", "aug", "ssg08", "awp"]], ["Gear", ["vest", "vesthelm", "kit", "zeus"]], ["Grenades", ["flash", "smoke", "he", "molotov", "decoy"]]];
const BUY = { open: false, cat: -1, free: false };
let SITES_C = [], lastMo = null, moFlash = 0, lastBeep = 0;
const itemName = it => ({ vest: "Kevlar", vesthelm: "Kevlar + helmet", kit: "Defuse kit", molotov: myTeam === 0 ? "Incendiary" : "Molotov" })[it] || (WEAPONS[it] || {}).name || it;
function itemPrice(it) { const P = PRICE[it === "molotov" && myTeam === 0 ? "incendiary" : it]; if (!P) return null;
  if (P[1] != null && P[1] !== myTeam) return null; if (it === "vesthelm" && me.armor >= 100 && !me.helmet) return 350; return P[0]; }
/* on a computer the menu frees the mouse, as CS does: the cursor shows, a click buys, the view holds still, and closing
   it captures the mouse again (2026-11-17: it was keyboard only). Moving with the keys still works while it is open. */
function buyMenu(on) { const was = BUY.open; BUY.open = on && GM && compLike(GM.m); BUY.cat = -1; drawBuy();
  if (TOUCH || was === BUY.open) return;
  if (BUY.open) { BUY.free = true; mouseDown = false; rmb = false; if (document.pointerLockElement) document.exitPointerLock(); }
  else if (BUY.free) { BUY.free = false; if (locked && connected && !document.pointerLockElement) relock(); } }
/* capture the mouse again after the menu; if the browser refuses (no click or key behind it), the pause menu shows, as on Esc */
function relock() { let p; try { p = renderer.domElement.requestPointerLock(); } catch (e) { return setLocked(false); }
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
  if (!GM || !compLike(GM.m)) { bombObj.visible = false; return; }
  const bp = GM.bp, bd = m.me && m.me.bd;
  if (bp) { bombObj.visible = true; bombObj.position.set(bp[0], bp[1], bp[2]); } else if (bd) { bombObj.visible = true; bombObj.position.set(bd[0], bd[1], bd[2]); } else bombObj.visible = false;
  bombObj.userData.planted = !!bp;
  if (m.me && m.me.tmo) TMO = new Map(m.me.tmo);
}
let TMO = new Map();
function beep(f = 2200, len = .06, vol = .35) { if (!AC) return; const t = AC.currentTime, o = AC.createOscillator(), g2 = AC.createGain(); o.frequency.value = f; g2.gain.setValueAtTime(vol, t); g2.gain.exponentialRampToValueAtTime(.001, t + len); o.connect(g2).connect(dest()); o.start(t); o.stop(t + len + .01); }
function tickComp(dt) {
  const comp = !!(GM && compLike(GM.m)); document.body.classList.toggle("comp", comp);
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

/* ── the radar (2026-11-14): the map's walkable ground from the server, turned so forward is up; teammates always,
   enemies while you or a teammate can see them (CS's rule), smokes and fires ──────────────────────────────────── */
let RMAP = null, SPOTTED = [], DECOYDOTS = [];
const RPPM = 3.2;   // radar pixels a metre, before the canvas's own 2x
function radarMap(r) {
  const pts = r.pts.map(([x, z]) => [x / 10, z / 10]); if (!pts.length) { RMAP = null; return; }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const pad = 2, c = document.createElement("canvas"); c.width = Math.ceil((x1 - x0 + 2 * pad) * RPPM * 2); c.height = Math.ceil((z1 - z0 + 2 * pad) * RPPM * 2);
  const g = c.getContext("2d"), cs = r.cell * RPPM * 2 * 1.15; g.fillStyle = "rgba(205,214,206,.34)";
  for (const [x, z] of pts) g.fillRect((x - x0 + pad) * RPPM * 2 - cs / 2, (z - z0 + pad) * RPPM * 2 - cs / 2, cs, cs);
  RMAP = { c, x0: x0 - pad, z0: z0 - pad };
}
function drawRadar() {
  const cv = $("radar"); if (!cv) return; const g = cv.getContext("2d"), W2 = cv.width, H2 = cv.height, k = RPPM * 2;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W2, H2);
  if (!RMAP || !connected) return;
  const sp0 = SPEC.id && others.get(SPEC.id), y = sp0 ? sp0.vy || 0 : me.yaw, cy = Math.cos(y), sy = Math.sin(y), mx = sp0 ? sp0.model.g.position.x : me.pos.x, mz = sp0 ? sp0.model.g.position.z : me.pos.z;
  const at = (x, z) => { const dx = (x - mx) * k, dz = (z - mz) * k; return [W2 / 2 + dx * cy - dz * sy, H2 / 2 + dx * sy + dz * cy]; };
  g.save(); g.translate(W2 / 2, H2 / 2); g.transform(cy, sy, -sy, cy, 0, 0); g.translate(-(mx - RMAP.x0) * k, -(mz - RMAP.z0) * k); g.drawImage(RMAP.c, 0, 0); g.restore();
  const dot = (x, z, col, r = 7) => { const [a, b] = at(x, z); g.beginPath(); g.arc(a, b, r, 0, Math.PI * 2); g.fillStyle = col; g.fill(); };
  for (const c of FX.sm.values()) dot(c.g.position.x, c.g.position.z, "rgba(190,190,186,.55)", NADE.smokeR * k);
  for (const f of FX.fi.values()) dot(f.g.position.x, f.g.position.z, "rgba(255,120,30,.5)", NADE.fireR * k);
  for (const [name, x, y, z] of SITES_C) { const [a, b] = at(x, z); g.font = "700 30px ui-sans-serif,system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "rgba(255,176,46,.95)"; g.fillText(name, a, b); }
  for (const q of PINGS) dot(q.x, q.z, "#ffb02e", 6);
  if (GM && GM.bp) dot(GM.bp[0], GM.bp[2], nowS() % 1 < .5 ? "#ff5a4a" : "#7a1f17", 9);
  else if (bombObj.visible) dot(bombObj.position.x, bombObj.position.z, "#ffb02e", 8);
  const shown = new Set();
  for (const [id, o] of others) { if (!o.alive || o.gone) continue; const p = o.model.g.position;
    if (o.team === myTeam) dot(p.x, p.z, o.id === SPEC.id ? "#ffffff" : "#5aa2ff"); else if (o.vis && me.alive) { dot(p.x, p.z, "#ff5a4a"); shown.add(id); } }
  for (const [id, x, z] of SPOTTED) if (!shown.has(id)) dot(x, z, "#ff5a4a");
  for (const [, x, z] of DECOYDOTS) dot(x, z, "#ff5a4a");   // an enemy decoy looks like an enemy, as in CS
  g.beginPath(); g.moveTo(W2 / 2, H2 / 2 - 11); g.lineTo(W2 / 2 + 8, H2 / 2 + 8); g.lineTo(W2 / 2, H2 / 2 + 4); g.lineTo(W2 / 2 - 8, H2 / 2 + 8); g.closePath(); g.fillStyle = me.alive ? "#ffffff" : "rgba(255,255,255,.35)"; g.fill();
}

/* ── grenades, smoke and fire (2026-11-14): drawn from the server's lists in every update ───────────────────────── */
let blindLeft = 0, lastStrip = "";
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

/* ── the weapon in hand: the real model, gloved hands and forearms holding it ── */
let ARMS = null;   // the rigged arms once loaded (below); until then the old hands
const glove = new THREE.MeshStandardMaterial({ color: 0x2a2520, roughness: .85 }), sleeve = new THREE.MeshStandardMaterial({ color: 0x3b4a5f, roughness: .85 });
const HOLD = { knife: [0, null], ak: [0, .37], m4: [0, .37], aug: [0, .17], awp: [0, .3], glock: [0, .02], usp: [0, .02], deagle: [0, .02], mp9: [0, .13], mac10: [0, .1], nova: [0, .4],
               he: [0, null], flash: [0, null], smoke: [0, null], molotov: [0, null], c4: [0, null], decoy: [0, null], zeus: [0, null],
               p250: [0, .02], cz75: [0, .02], fiveseven: [0, .02], tec9: [0, .1], mp7: [0, .13], ump: [0, .14], p90: [0, .12], galil: [0, .37], famas: [0, .17],
               m4a1s: [0, .37], sg553: [0, .17], ssg08: [0, .28], xm1014: [0, .4], negev: [0, .45] };   // where the left hand rests, forward of the grip
function handAt(g, x, y, z, back) {
  const h = new THREE.Mesh(new THREE.SphereGeometry(.045, 14, 10), glove); h.position.set(x, y, z); g.add(h);
  const a = new THREE.Mesh(new THREE.CapsuleGeometry(.045, .3, 4, 10), sleeve); a.position.set(x + back[0], y + back[1], z + back[2]); a.lookAt(new THREE.Vector3(x, y, z).add(new THREE.Vector3(...back).multiplyScalar(3))); a.rotateX(Math.PI / 2); g.add(a);
}
function viewModel(w) {
  const g = new THREE.Group(), m = applyFinish(gunModel(w), SET.fin); g.add(m);
  // the weapon faces away from the sun: a little of its own light instead of a lamp (point lights cost every surface)
  m.traverse(o => { o.castShadow = false; if (o.isMesh) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(0x2a2a2a); } });
  if (!ARMS) { handAt(g, 0, -.03, .0, [.05, -.12, .2]); if (HOLD[w][1] != null) handAt(g, -.01, -.01, -HOLD[w][1], [-.1, -.13, .14]); }   // the old hands until the arms are in
  return g;
}
const gun = new THREE.Group(); camera.add(gun); gun.scale.setScalar(.62);
const VIEW = {}; for (const w of WIDS) { VIEW[w] = viewModel(w); VIEW[w].visible = false; gun.add(VIEW[w]); }
function rebuildViews() { for (const w of WIDS) { const was = VIEW[w].visible; gun.remove(VIEW[w]); dispose(VIEW[w]); VIEW[w] = viewModel(w); VIEW[w].visible = was; gun.add(VIEW[w]); } }
/* the arms (2026-11-16, models.js makeArms): one rig on the camera, its hands put on whatever gun is out every frame, so
   they follow recoil, bob and sway. The shoulders sit forward under the gun, out of sight: the gun is drawn at .62 of
   its size .42 m ahead, and arms of the same scale only reach it from there (the usual viewmodel trick) */
const ARMSET = { scale: .72, at: new THREE.Vector3(.06, -.36, -.33), yaw: .35, right: [.03, -.07, .06],
  rifle: { fingers: [1, .25, 0], palm: [0, 1, 0], at: hold => [-.045, -.045, -hold] }, pistol: { fingers: [.3, -.3, -1], palm: [1, 0, 0], at: () => [-.04, -.08, .03] } };
/* reload keyframes for the left hand, [time 0..1 of the reload, "home" or { at, fingers, palm }] in the gun's space: a
   rifle's hand goes to the magazine, pulls it out of sight, brings one up, seats it, works the charging handle, goes
   back; a pistol's support hand drops, brings a magazine to the grip, racks the slide; a shotgun's thumbs a shell in */
{ const mag = { at: [-.03, -.13, -.13], fingers: [.2, 1, -.3], palm: [1, 0, 0] }, low = { at: [-.08, -.5, -.02], fingers: [.2, 1, 0], palm: [1, 0, 0] };
  ARMSET.rifleReload = [[0, "home"], [.14, mag], [.3, low], [.48, low], [.62, mag], [.72, mag], [.82, { at: [.05, .07, .04], fingers: [-1, 0, -.2], palm: [-1, 0, 0] }], [.94, "home"], [1, "home"]];
  ARMSET.pistolReload = [[0, "home"], [.15, { at: [-.06, -.45, .06], fingers: [0, 1, 0], palm: [1, 0, 0] }], [.45, { at: [-.04, -.3, .05], fingers: [0, 1, 0], palm: [1, 0, 0] }],
    [.6, { at: [-.02, -.15, .03], fingers: [0, 1, -.2], palm: [1, 0, 0] }], [.76, { at: [-.03, .05, .09], fingers: [0, -.3, -1], palm: [1, 0, 0] }], [.86, { at: [-.03, .05, .02], fingers: [0, -.3, -1], palm: [1, 0, 0] }], [1, "home"]];
  ARMSET.shells = [[0, "home"], [.35, { at: [-.03, -.08, -.08], fingers: [.3, .6, -.6], palm: [1, .3, 0] }], [.6, { at: [-.01, -.05, -.02], fingers: [.3, .6, -.6], palm: [1, .3, 0] }], [1, "home"]]; }
if (!params.has("codeguns")) loadGunModels(gltf()).then(got => { if (got.length) rebuildViews(); });
loadArms(gltf()).then(ok => { if (!ok) return; ARMS = makeArms(sleeve); if (!ARMS) return;
  ARMS.root.position.copy(ARMSET.at); ARMS.root.rotation.set(0, Math.PI + ARMSET.yaw, 0); ARMS.root.scale.setScalar(ARMSET.scale); ARMS.root.visible = false; camera.add(ARMS.root); rebuildViews(); });
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _cq = new THREE.Quaternion();
function poseArms(w) {
  const vm = VIEW[w]; ARMS.root.visible = gun.visible && !!vm && vm.visible; if (!ARMS.root.visible) return;
  vm.updateWorldMatrix(true, false); vm.getWorldQuaternion(_q); camera.getWorldQuaternion(_cq);
  const gd = a => new THREE.Vector3(...a).applyQuaternion(_q), cd = a => new THREE.Vector3(...a).applyQuaternion(_cq), hold = HOLD[w] && HOLD[w][1];
  const kind = hold == null ? null : hold < .06 ? ARMSET.pistol : ARMSET.rifle, W0 = WEAPONS[w] || {};
  let lp = kind && kind.at(hold), lf = kind && kind.fingers, ln = kind && kind.palm;
  // a reload (2026-11-16): the left hand works the gun along keyframes over the gun's own reload time
  if (kind && me.reloadAt && me.w === w) { const r = W0.shell || W0.reload || 2, p = W0.shell ? 1 - ((me.reloadAt - me.clock) / r % 1 + 1) % 1 : clamp(1 - (me.reloadAt - me.clock) / r, 0, 1);
    const keys = W0.shell ? ARMSET.shells : kind === ARMSET.pistol ? ARMSET.pistolReload : ARMSET.rifleReload, home = { at: lp, fingers: lf, palm: ln };
    let i = 0; while (i < keys.length - 1 && keys[i + 1][0] <= p) i++;
    const A = keys[i], B = keys[Math.min(i + 1, keys.length - 1)], k = B[0] > A[0] ? THREE.MathUtils.smoothstep(p, A[0], B[0]) : 1;
    const pick = (K, f) => K[1] === "home" ? home[f] : K[1][f], mix = f => pick(A, f).map((x, j) => x + (pick(B, f)[j] - x) * k);
    lp = mix("at"); lf = mix("fingers"); ln = mix("palm"); }
  const left = kind ? { at: vm.localToWorld(_v.set(...lp).clone()), fingers: gd(lf), palm: gd(ln), pole: cd([-1, -1, .2]) }
    : { at: camera.localToWorld(new THREE.Vector3(-.3, -.75, -.25)), fingers: cd([0, -1, 0]), palm: cd([1, 0, 0]), pole: cd([-1, -1, 0]) };   // one-handed: the left arm drops out of sight
  ARMS.pose({ at: vm.localToWorld(_v.set(...ARMSET.right).clone()), fingers: gd([-.25, -.15, -1]), palm: gd([-1, 0, 0]), pole: cd([1, -1, .2]) }, left,
    { curl: (WEAPONS[w] || {}).melee ? 1.05 : .9, thumb: .4, curlL: .8, thumbL: .3 });
}   // the imported guns, once they are in (models.js IMPORTED); ?codeguns compares the old ones
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
  roster.clear(); for (const [id, name, team, bot, k, d, p, a, dm, fin, gl] of r) roster.set(id, { id, name, team, bot, k, d, p, a: a || 0, dm: dm || 0, fin: FINISHES[fin] || "factory", gl });
  const rows = [...roster.values()].sort((a, b) => a.team - b.team || b.k - a.k);
  $("board").innerHTML = (GM && GM.ph === "over" ? `<h3>${esc(GM.msg)}</h3>` : "") + `<table><tr><th>Atlas / Ember</th><th>HP</th><th>K</th><th>A</th><th>D</th><th>DMG</th>${GM && compLike(GM.m) ? "<th>$</th>" : ""}<th>ping</th></tr>` + rows.map(x => `<tr class="${x.team ? "t" : "ct"}${x.id === myId ? " me" : ""}"><td>${esc(x.name)}${x.bot ? " <small>bot</small>" : ""}</td><td>${hpCell(x)}</td><td>${x.k}</td><td>${x.a}</td><td>${x.d}</td><td>${x.dm}</td>${GM && compLike(GM.m) ? `<td>${x.team === myTeam && TMO.has(x.id) ? "$" + TMO.get(x.id) : ""}</td>` : ""}<td>${x.bot ? "" : x.p}</td></tr>`).join("") + "</table>";
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
  me.mag = y.m; me.res = y.r; me.reloadAt = y.ra; me.nextShot = y.ns; me.spray = y.sp; me.lastShot = y.ls; me.punchX = y.px; me.punchY = y.py; me.acc = y.ac || 0; me.tag = y.tg || 0; me.stamina = y.st || 0; me.landed = !!y.ld; me.clock = y.ck;
  respawnIn = y.ra2 || 0; protect = y.pr || 0;
  if (y.sn && y.sn !== lastSpawn) { lastSpawn = y.sn; me.yaw = y.syw; me.pitch = 0; }
  me.w = y.w; me.prim = y.pm; me.last = y.la; me.zoom = y.z; me.deployUntil = y.du; me.zoomHeld = y.zh;
  if (y.sc !== undefined) { me.sec = y.sc; me.pa = y.pa.slice(); me.sa = y.sa.slice(); me.trig = !!y.tr; me.cock = y.co || 0; NADES.forEach((n, i) => { me.nades[n] = y.nd[i]; });
    me.armor = y.ar || 0; me.helmet = !!y.hm; blindLeft = y.bl || 0;
    me.zeus = !!y.zs; me.burstOn = !!y.bo; me.burstLeft = y.bl2 || 0; me.mo = y.mo; me.kit = !!y.kit; me.c4 = !!y.c4; me.ib = !!y.ib; me.pp = y.pp || 0; me.dp = y.dp || 0;
    if (y.te !== undefined && y.te !== myTeam) { myTeam = y.te; const cm = sleeveMaterial(myTeam); sleeve.map = cm.map; sleeve.bumpMap = cm.bumpMap; sleeve.needsUpdate = true;   // sides swapped at halftime
      $("team").textContent = TEAM[myTeam]; $("team").className = myTeam ? "t" : "ct"; for (const o of others.values()) if (o.model.tag) o.model.tag.userData.enemy = o.team !== myTeam; } }
  if (m.pk) syncPickups(m.pk);
  syncFx(m); SPOTTED = m.sp || []; DECOYDOTS = m.dc || []; syncComp(m); for (const e of m.pv || []) onTalk(e);
  pending = pending.filter(c => c.seq > m.a);
  const yaw = me.yaw, pitch = me.pitch;   // (a spawn turn above already set these)
  for (const c of pending) { me.clock += DT; move(W, me, c); weapon(me, c, me.clock, 0); }
  me.yaw = yaw; me.pitch = pitch;
  const err = before.sub(me.pos); if (err.lengthSq() < 4) smooth.add(err); else smooth.set(0, 0, 0); corrMax = Math.max(corrMax, err.length());
  // everyone else: snapshots kept to draw between
  const seen = new Set();
  for (const [id, team, , x, yy, z, yw, pt, dk, al, vx, vz, wi, hp, vis] of m.e) {
    if (id === myId) continue; seen.add(id);
    let o = others.get(id); if (!o) { o = { id, team, model: person(team, nameOf(id)), named: nameOf(id), buf: [] }; others.set(id, o); }
    if (o.gone) { o.gone = false; o.buf.length = 0; o.model.last = null; }   // back in view: start fresh, no slide from where it vanished
    o.vis = vis !== 0;
    o.buf.push({ tm: m.tm, x, y: yy, z, yaw: yw, pitch: pt, duck: dk, alive: al, vx, vz }); if (o.buf.length > 40) o.buf.shift();
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
  if (e.k === "shot" && e.id !== myId) { const a = new THREE.Vector3(...e.f), b = new THREE.Vector3(...e.t); const aw = WIDS[e.g] === "awp"; tracer(a.clone().lerp(b, .02), b, aw); at(a, () => gunSound(WIDS[e.g], clamp(1 - a.distanceTo(camera.position) / (aw ? 120 : 60), aw ? .25 : .08, .8), a.distanceTo(camera.position) < 18)); if (aw && a.distanceTo(camera.position) < 25) shake = Math.max(shake, .25);
    flashAt(a.clone().lerp(b, Math.min(.9, .7 / Math.max(.7, a.distanceTo(b))))); if (e.w) puff(b, 0xb8a888, 6, .1);
    if (me.alive) { const ab = b.clone().sub(a), L = ab.length(); if (L > 1) { ab.divideScalar(L); const c = camera.position, tt = clamp(c.clone().sub(a).dot(ab), 0, L), pc = a.clone().addScaledVector(ab, tt), miss = pc.distanceTo(c);
      if (tt > .5 && tt < L - .3 && miss < 2.5) { const v = clamp(1 - miss / 2.5, .15, 1); at(pc, () => (SUBSONIC.has(WIDS[e.g]) ? whiz : crack)(v)); } } }   // it passed you
    if (e.w && b.distanceTo(camera.position) < 14) at(b, () => impactSound(clamp(1 - b.distanceTo(camera.position) / 14, .1, 1))); }
  else if (e.k === "melee" && e.id !== myId) { swish(clamp(1 - new THREE.Vector3(...e.f).distanceTo(camera.position) / 20, .05, .8)); }
  else if (e.k === "ammo" && e.id === myId) { tink(1000); feed("Ammo refilled"); }
  else if (e.k === "pick" && e.id === myId) { tink(1400); }
  else if (e.k === "kevlar" && e.id === myId) { tink(1200); feed("Kevlar and helmet"); }
  else if (e.k === "buy" && e.id === myId) { tink(1700); feed("Bought " + esc(itemName(e.i))); drawBuy(); }
  else if (e.k === "plantStart" || e.k === "defuseStart") { const o = e.id === myId ? null : others.get(e.id); at(o ? o.model.g.position : camera.position, () => beep(e.k === "plantStart" ? 1800 : 1200, .08, .3)); }
  else if (e.k === "planted") { feed(`The bomb has been planted at <b>${esc((SITES_C[e.site] || [])[0] || "")}</b>`, "mine"); beep(2600, .12, .5); }
  else if (e.k === "defused") { feed(`${esc(nameOf(e.id))} defused the bomb`, "mine"); beep(900, .3, .4); }
  else if (e.k === "bombDrop" && myTeam === 1) feed("The bomb has been dropped");
  else if (e.k === "bombPick" && myTeam === 1) feed(`${esc(nameOf(e.id))} picked up the bomb`);
  else if (e.k === "reload" && e.id !== myId) { const o = others.get(e.id); if (o && o.vis !== false) { const d = o.model.g.position.distanceTo(camera.position); if (d < 22) at(o.model.g.position, () => reloadSound(clamp(1 - d / 22, .05, .6), WIDS[e.w])); } }
  else if (e.k === "pin" && e.id !== myId) { const o = others.get(e.id); if (o) { const d = o.model.g.position.distanceTo(camera.position); if (d < 15) at(o.model.g.position, () => pinSound(clamp(1 - d / 15, .1, 1))); } }
  else if (e.k === "throw" && e.id !== myId && (roster.get(e.id) || {}).team === myTeam) { chatLine(`<small>radio</small> <b class="${myTeam ? "t" : "ct"}">${esc(nameOf(e.id))}</b>: ${["Fire in the hole!", "Flashbang out!", "Smoke out!", "Molotov out!"][e.n] || "Grenade out!"}`); beep(880, .04, .2); }
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
  else if (e.k === "flashed" && e.id === myId) { blindLeft = Math.max(blindLeft, e.d); tink(3100); }
  else if (e.k === "smoke") at(new THREE.Vector3(...e.p), () => noiseHit(.5 * fxVol(e.p), 2.2, 1800, .6));
  else if (e.k === "fire") at(new THREE.Vector3(...e.p), () => noiseHit(.7 * fxVol(e.p), .7, 1200, 1.2));
  else if (e.k === "fizzle") at(new THREE.Vector3(...e.p), () => noiseHit(.4 * fxVol(e.p), .5, 3000, 1.5));
  else if (e.k === "bounce") { if (new THREE.Vector3(...e.p).distanceTo(camera.position) < 25) at(new THREE.Vector3(...e.p), () => tink(e.n === 3 ? 700 : 1400)); }
  else if (e.k === "bandage" && e.id === myId) { tink(1500); feed("Bandaged, +40 health"); }
  else if (e.k === "roundEnd") tink(e.w === myTeam ? 1600 : 500);
  else if (e.k === "match") tink(e.w === myTeam ? 2000 : 400);
  else if (e.k === "hit") { const v = others.get(e.id); if (v) puff(v.model.g.position.clone().setY(v.model.g.position.y + (e.h ? 1.65 : 1.2)), 0x9a1010, 8, .1, .4);
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
  const cmd = { seq: ++seq, f: (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0), s: (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), jump: !!keys.Space, duck: !!(SET.crouch === "ctrl" ? (keys.ControlLeft || keys.ControlRight) : keys.KeyC),
    walk: !!keys.ShiftLeft, fire: mouseDown && (locked || AUTO), reload: reloadQ, yaw: me.yaw, pitch: me.pitch, vt: +viewTime().toFixed(4),
    slot: slotQ, zoom: rmb && (locked || AUTO), use: !!keys.KeyE };
  if (GM && GM.fz) { cmd.f = cmd.s = 0; cmd.jump = cmd.fire = false; }
  reloadQ = false; slotQ = null; me.clock += DT;
  move(W, me, cmd);
  const s = weapon(me, cmd, me.clock, (myId * 100003 + cmd.seq) >>> 0);
  if (s && s.nade) { swish(.8); swing = 1; lastFire = performance.now(); }
  else if (s && s.melee) { swish(1); swing = 1; lastFire = performance.now(); }
  else if (s) {   // the predicted shot: tracer, decal and sound now; the damage is the server's to decide
    const o = new THREE.Vector3(me.pos.x, me.pos.y + eye(me), me.pos.z), aw = me.w === "awp";
    for (const d of s.dirs || [s.dir]) { const h = W.first(o, d, 300); tracer(gunTip(), o.clone().addScaledVector(d, h ? h.distance : 300), aw); if (h) { decal(h, d); puff(h.point, 0xb8a888, aw ? 14 : 6, aw ? .18 : .1); const nrm = h.face.normal.clone(); if (nrm.dot(d) > 0) nrm.negate(); sparks(h.point, nrm, aw ? 10 : 5); } } gunSound(me.w, 1);
    if (!(WEAPONS[me.w] || {}).shell && me.w !== "zeus") ejectShell(); if (muzzleLight) { muzzleLight.position.copy(gunTip()); muzzleLight.intensity = aw ? 60 : 30; } flash = aw ? .09 : .045; kick = aw ? 4 : 1; if (aw) { shake = 1; fovPunch = 1; $("hurt").style.transition = "none"; $("hurt").style.boxShadow = "inset 0 0 160px rgba(255,236,200,.35)"; setTimeout(() => { $("hurt").style.transition = "box-shadow .3s"; if (me.alive) $("hurt").style.boxShadow = ""; }, 60); } lastFire = performance.now();
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
    if (o.clone().addScaledVector(d, t).distanceTo(c) > .55 || smokeBetween(o, c)) continue;
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
    g.visible = !!o.vis && !o.gone && o.id !== SPEC.id; g.position.set(x, y, z); g.rotation.y = lerpAng(s0.yaw, s1.yaw, k);
    o.vy = g.rotation.y; o.vp = pitch; o.vd = duck;   // their view, for spectating
    o.model.sd.pose(s1.alive ? speed : 0, o.model.phase, duck, s1.alive ? pitch : 0);
    if (!s1.alive) { g.rotation.x = Math.max(g.rotation.x - .1, -Math.PI / 2); g.position.y = y + .2; o.model.tag.visible = false; } else { g.rotation.x = 0; o.model.tag.visible = !o.model.tag.userData.enemy || o === aimedAt; }
    o.alive = s1.alive;
  }
}
let VOTEON = false, voteTimer = 0, corrMax = 0;
onTap($("vote"), b => { if (!VOTEON) return; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "vote", y: b.dataset.y === "1" })); VOTEON = false; $("vote").innerHTML += `<p>You voted ${b.dataset.y === "1" ? "yes" : "no"}</p>`; });   // corrMax: the largest prediction correction seen (debug, tests)   // a vote you can answer: F1 yes, F2 no (CS)
const SNDST = { last: "" }; let inspectT = 0;   // F: the weapon turned over in hand for a look, as in CS   // the last state the mechanical sounds were played for
/* spectating (2026-11-14): dead in a round mode, after the death cam, you watch a living teammate through their eyes;
   a click moves to the next one, as in CS */
/* Gun Game (2026-11-17): the ladder from the server, your level from the roster (and the level events between) */
const dmLike = m => m === "dm" || m === "gg", compLike = m => m === "comp" || m === "wing";
let LADDER = null; const myLevel = () => ((roster.get(myId) || {}).gl) || 0;
const SPEC = { id: 0 };
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
  if (fired) { gunSound(K.w, .9); flash = .05; kick = Math.min(3, kick + 1); }
  return { t, K };
}
/* everyone in the record where they were then; those not in it are hidden for the replay */
function kcBodies(t) {
  for (const o of others.values()) o.model.g.visible = false;
  for (const [id, r] of KC.rec.h) { if (id === KC.rec.by) continue;
    let m = id !== myId && others.get(id) ? others.get(id).model : null;
    if (!m) { m = KC.temps.get(id); if (!m) { m = person(r.team, nameOf(id)); KC.temps.set(id, m); } }
    const S = kcAt(r.rows, t), g = m.g; g.visible = true; g.position.set(S.x, S.y, S.z); g.rotation.y = S.yaw;
    m.phase = (m.phase || 0) + S.speed * .016 * 3.2; m.sd.pose(S.alive ? S.speed : 0, m.phase, S.duck, S.alive ? S.pitch : 0);
    g.rotation.x = S.alive ? 0 : -Math.PI / 2; if (m.tag) m.tag.visible = !S.alive ? false : r.team === myTeam; }
}
const specList = () => [...others.values()].filter(o => o.team === myTeam && o.alive && !o.gone && o.buf.length).sort((a, b) => a.id - b.id);
const spectating = () => !me.alive && GM && !dmLike(GM.m) && nowS() - diedAt > 3 && !kcActive() && specList().length > 0;
function specNext() { const L = specList(); if (!L.length) { SPEC.id = 0; return; } const i = L.findIndex(o => o.id === SPEC.id); SPEC.id = L[(i + 1) % L.length].id; }
function render(dt) {
  smooth.multiplyScalar(Math.exp(-dt * 12));
  if (wasAlive && !me.alive) { onDeath(); kcBegin(); } else if (!wasAlive && me.alive) { onRespawn(); SPEC.id = 0; } wasAlive = me.alive;
  const kc = kcActive(); if (!kc && KC.on) kcEnd(); KC.on = kc; let kcT = null;
  const spec = spectating() ? (others.get(SPEC.id) && others.get(SPEC.id).alive && others.get(SPEC.id).team === myTeam ? others.get(SPEC.id) : (specNext(), others.get(SPEC.id))) : null;
  if (!spec) SPEC.id = 0;
  const dk = me.alive ? 0 : clamp((nowS() - diedAt) / .6, 0, 1), de = 1 - Math.pow(1 - dk, 3);   // the fall, eased
  camera.position.set(me.pos.x + smooth.x, me.pos.y + smooth.y + (me.alive ? eye(me) : deathEye + (.32 - deathEye) * de), me.pos.z + smooth.z);
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
  const sp = Math.hypot(me.vel.x, me.vel.z); bob += dt * sp * 1.7; kick = Math.max(0, kick - dt * (kick > 1.5 ? 9 : 14)); fovPunch = Math.max(0, fovPunch - dt * 6); flash = Math.max(0, flash - dt);
  const W0 = wpn(me), scoped = !!(W0.zoom && me.zoom), deploying = me.clock < me.deployUntil;
  for (const w of WIDS) VIEW[w].visible = w === (kc ? KC.w : spec ? spec.w : me.w);
  swing = Math.max(0, swing - dt * 5);
  gun.position.set(GUNPOS.x + Math.cos(bob) * .006 * (me.onGround ? 1 : 0) - swing * .06, GUNPOS.y + Math.abs(Math.sin(bob)) * .007 - (deploying ? .12 : 0), GUNPOS.z + kick * .03 - swing * .1);
  muzzle.position.set(GUNPOS.x, GUNPOS.y + .025, GUNPOS.z - (MUZZLE[me.w] || .6) * .62);
  swayX *= Math.exp(-dt * 8); swayY *= Math.exp(-dt * 8);
  const rl = me.reloadAt ? clamp((me.reloadAt - me.clock) / (W0.reload || 2), 0, 1) : 0, dip = Math.sin(rl * Math.PI);   // the reload: down, tilted, back up
  gun.position.x -= swayX; gun.position.y += swayY - dip * .09;
  gun.rotation.set(swing * .9 + dip * .5 + (kick > 1.5 ? kick * .07 : 0), swing * .6 - swayX * 2, dip * .6);
  if (inspectT > 0) { inspectT = Math.max(0, inspectT - dt); const k = Math.sin((1 - inspectT / 2.2) * Math.PI); gun.rotation.y += k * 1.1; gun.rotation.z += k * .5; gun.position.x -= k * .05; gun.position.y += k * .03; }
  if (me.alive) { const st = me.w + "|" + (me.reloadAt ? 1 : 0) + "|" + (me.cock ? 1 : 0) + "|" + (me.landed ? 1 : 0), p0 = SNDST.last.split("|");
    if (SNDST.last && p0[0] !== me.w) clack(.3, 3200);                                  // a draw
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
  const pn = performance.now(); for (let i = tracers.length - 1; i >= 0; i--) if (pn > tracers[i].userData.t) { scene.remove(tracers[i]); tracers[i].geometry.dispose(); tracers.splice(i, 1); }
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
    $("clock").textContent = GM.dc ? fmtT(GM.dc.el + GM.dc.d * GM.dc.pen) : GM.bp && GM.ph === "live" ? "BOMB" : mm(GM.tl); $("clock").classList.toggle("bomb", !!(GM.bp && GM.ph === "live")); $("sct").textContent = GM.sc[0]; $("st").textContent = GM.sc[1]; $("rnd").textContent = GM.dc ? "KILLS " + GM.dc.k + "/" + GM.dc.need : rounds ? "ROUND " + GM.rn : GM.m === "gg" && LADDER ? "LEVEL " + Math.min(myLevel() + 1, LADDER.length) + "/" + LADDER.length : "DM";
    $("big").innerHTML = GM.ph === "over" ? `${esc(GM.msg)}<small>${GM.dc ? "your result is on the menu" : `next match in ${GM.tl} s`}</small>` : GM.ph === "end" ? `${esc(GM.msg)}` : GM.ph === "freeze" ? (GM.dc ? `${GM.dc.need} kills, fast<small>starts in ${GM.tl}</small>` : `Round ${GM.rn}<small>starts in ${GM.tl}</small>`) : ""; $("msg").classList.toggle("low", !!$("big").innerHTML);   // a round message above: the note steps down below it
    $("board").style.display = GM.ph === "over" || keys.Tab ? "block" : "none";
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

/* ── boot ────────────────────────────────────────────────────────────────────── */
const saved = (() => { try { return localStorage.getItem("fps-name"); } catch (e) { return null; } })();
$("name").value = params.get("name") || saved || "";   // empty shows the placeholder; Play picks a name if none is typed
let team = "auto", room = (params.get("room") || "DAILY").toUpperCase(), withBots = true;
$("teams").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return; team = b.dataset.team; for (const x of $("teams").children) x.classList.toggle("on", x === b); });
let gameMode = "dm", botDiff = "normal";
const DIFFS = ["easy", "normal", "hard", "expert"];   // one button that steps through them, as compact as the menu needs
$("bdiff").addEventListener("click", () => { botDiff = DIFFS[(DIFFS.indexOf(botDiff) + 1) % DIFFS.length]; $("bdiff").textContent = botDiff[0].toUpperCase() + botDiff.slice(1); });   // Deathmatch or Competitive, for a room you create (2026-11-14)
$("gmode").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return; gameMode = b.dataset.m;
  for (const x of $("gmode").children) { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); } $("frz").hidden = !compLike(gameMode); $("botn").classList.toggle("off", !withBots || gameMode === "wing"); });
$("bots").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return; withBots = b.dataset.b === "1"; $("botn").classList.toggle("off", !withBots || gameMode === "wing"); $("bdiff").classList.toggle("off", !withBots);
  for (const x of $("bots").children) { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); } });
document.querySelector(".priv .tabs").addEventListener("click", ev => { const b = ev.target.closest("button"); if (!b) return;
  for (const x of b.parentNode.children) { x.classList.toggle("on", x === b); x.setAttribute("aria-selected", x === b); $(x.dataset.tab).hidden = x !== b; }
  if (b.dataset.tab === "jn") $("code").focus(); });
let botN = 3; const setBots = n => { botN = Math.max(1, Math.min(5, n)); $("botv").textContent = botN; const [dn, up] = $("botn").querySelectorAll("button"); dn.disabled = botN <= 1; up.disabled = botN >= 5; };
$("botn").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) setBots(botN + +b.dataset.d); }); setBots(3);
/* Competitive's freeze time, the creator's pick (2026-11-17): 5 s unless changed; the server takes only these values */
const FRZ = [0, 3, 5, 8, 10, 15]; let frzS = 5; const setFrz = v => { frzS = v; $("frzv").textContent = v; const [dn, up] = $("frz").querySelectorAll("button"); dn.disabled = v <= FRZ[0]; up.disabled = v >= FRZ[FRZ.length - 1]; };
$("frz").addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) setFrz(FRZ[Math.max(0, Math.min(FRZ.length - 1, FRZ.indexOf(frzS) + +b.dataset.d))]); }); setFrz(5);
const showJoin = () => document.querySelector('.priv .tabs [data-tab="jn"]').click();
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
function dcShareText(r) { return `Daily Map challenge #${r.day}, ${r.map}\n${fmtT(r.t)} (${r.k} kills, ${r.d} ${r.d === 1 ? "death" : "deaths"}, ${r.hs} headshots)\n${r.counted ? `#${r.rank} of ${r.of} today` : "practice run"}\n${location.origin + location.pathname}`; }
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
  // the page holds one map; the challenge has its own each day, so if another is loaded the page reloads with the
  // challenge's map first and Play then starts the run (its countdown begins on joining, 2026-11-17)
  const go = () => { DCRES = null; try { sessionStorage.removeItem("dcres"); } catch (e) {}
    if (preload && preload.id !== r.id) { try { const n = $("name").value.trim().slice(0, 16); if (n) localStorage.setItem("fps-name", n); sessionStorage.setItem("dcqueue", JSON.stringify({ map: r.id, t: Date.now() })); } catch (e) {} location.reload(); return; }
    getMap(r.id); start({ create: "1", mode: "dc", title: "Daily challenge" }); };
  if ($("dcgo")) $("dcgo").addEventListener("click", go); if ($("dcagain")) $("dcagain").addEventListener("click", go);
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
function lockMouse() { if (TOUCH) return touchPlay(true); try { const p = renderer.domElement.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
function start(q) {
  const n = $("name").value.trim().slice(0, 16) || "player" + (Math.random() * 900 + 100 | 0); if ($("name").value.trim()) try { localStorage.setItem("fps-name", n); } catch (e) {}
  if (ws && ws.readyState > 1) ws = null;   // a dead socket never blocks Play
  if (ws) { if (connected) { audio(); lockMouse(); } return; }
  $("load").textContent = "connecting"; audio(); connect({ name: n, team, fin: SET.fin, ...q }); if (!AUTO && !q.quiet) lockMouse();
}
let DCQ = (() => { try { const q = JSON.parse(sessionStorage.getItem("dcqueue") || "null"); sessionStorage.removeItem("dcqueue"); return q && Date.now() - q.t < 60000 ? q : null; } catch (e) { return null; } })();
if (DCQ) { getMap(DCQ.map); $("load").textContent = "Daily challenge ready. Press Play to start"; $("play").textContent = "Start challenge"; }
$("play").addEventListener("click", () => { if (DCQ && !ws) { DCQ = null; start({ create: "1", mode: "dc", title: "Daily challenge" }); return; } start({ room }); });
/* unstuck: respawn now (a self-kill; the server allows one every 10 s) - K, or the pause menu's button */
function unstuck() { if (ws && ws.readyState === 1 && connected && me.alive) ws.send(JSON.stringify({ t: "u" })); }
$("unstuck").addEventListener("click", () => { unstuck(); lockMouse(); });
/* leave: back to a fresh menu (no rejoin), out of any private room */
$("leave").addEventListener("click", () => { movingTo = "leave"; try { sessionStorage.removeItem("rejoin"); ws && ws.close(); } catch (e) {} location.href = location.pathname; });
const invite = () => location.origin + location.pathname + "?room=" + currentRoom;
$("copylink").addEventListener("click", async () => { let ok = false; try { await navigator.clipboard.writeText(invite()); ok = true; } catch (e) {}
  $("sharehint").textContent = ok ? "Copied. Send it to your friends" : invite(); });
if (room !== "DAILY" && !AUTO) { showJoin(); $("code").value = room; $("load").textContent = "Invited to room " + room + ". Press Play to join"; }
$("create").addEventListener("click", () => start({ create: "1", mode: gameMode, frz: frzS, diff: botDiff, bots: withBots ? "1" : "0", bpt: botN, title: ($("name").value.trim() || "player") + "'s room" }));
$("joincode").addEventListener("click", () => { const c = $("code").value.trim().toUpperCase(); if (c.length !== 4) { $("load").textContent = "A room code is 4 letters"; return; } start({ room: c }); });
for (const id of ["name", "code"]) $(id).addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Enter") (id === "code" ? $("joincode") : $("play")).click(); });
{ let rj = null; try { rj = JSON.parse(sessionStorage.getItem("rejoin") || "null"); sessionStorage.removeItem("rejoin"); } catch (e) {}
  if (rj && Date.now() - rj.t < 30000) { if (rj.map) getMap(rj.map);   /* the map this room needs, before today's takes the one slot (2026-11-17) */ team = rj.team || "auto"; room = rj.room; rejoined = rj.lost ? "lost" : "map"; start({ room, quiet: 1 }); } }
if (AUTO) { $("start").style.display = "none"; team = params.get("team") || "auto"; start(params.get("create") ? { create: "1", mode: params.get("mode") || "dm", frz: params.get("frz") || "", diff: params.get("diff") || "normal", bots: params.get("bots") || "1", bpt: params.get("bpt") || "", title: "test" } : { room }); }
if (AUTO || DEBUG) window.__g = { lu: () => ({ n: LU.list.length, shown: LU.marks.filter(m => m.visible).length, w: me.w, team: myTeam }), kc: () => ({ hls: KC.hls, hl: KC.hl && KC.hl.title, msgs: KC.msgs, deaths: KC.deaths, played: KC.played, fps: +fpsNow.toFixed(1), on: KC.on, rec: !!KC.rec, n: KC.rec ? KC.rec.h.size : 0, temps: KC.temps.size }), corr: (reset) => { const v = corrMax; if (reset) corrMax = 0; return v; }, spec: () => ({ id: SPEC.id, n: specList().length, on: spectating(), mode: GM && GM.m, since: +(nowS() - diedAt).toFixed(1), team: myTeam, mates: [...others.values()].map(o => [o.id, o.team, o.alive, !!o.gone, o.buf.length]) }), ws: () => ws, snaps: () => snapN, snd: { crack, whiz, impactSound, bodyHit, reloadSound, boomSound, flashSound, step, gunSound, audio, ctx: () => AC && AC.state }, fx: () => ({ roomy: +ENV.roomy.toFixed(2), clips: Object.keys(CLIPS).length, sparks: sparkN, shells: shells.length, parts: parts.length, decals: decals.length, light: muzzleLight ? +muzzleLight.intensity.toFixed(1) : null }), start,me, others, roster, keys, pending: () => pending, ping: () => ping, setMouse: v => { mouseDown = v; }, connected: () => connected, W: () => W, myId: () => myId, smooth, viewTime };
requestAnimationFrame(frame);
