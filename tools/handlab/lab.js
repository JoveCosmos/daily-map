/* hand lab page (2026-11-24, tools/handlab.mjs drives it): the first-person arms posed on a gun exactly as the game poses
   them (models.js makeArms, client/hands.js), drawn from the eye and from five other angles, with the wrist numbers.
   ?eye: the eye view alone, full size. window.__lab.go(w, team, { rp, sp, drawK, inspect }) poses and draws one */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { loadGunModels, loadArms, makeArms, gunModel, applyFinish, setLite } from "../models.js";
import { poseHands, mountArms, gripFor } from "../client/hands.js";
const Q = new URLSearchParams(location.search), EYE = Q.has("eye");
setLite(Q.has("lite"));
const CW = 640, CH = 360, COLS = 3, ROWS = 2;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(EYE ? 1280 : CW * COLS, EYE ? 720 : CH * ROWS); renderer.setScissorTest(true);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x8899aa);
{ const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), .04).texture; scene.environmentIntensity = .45; }
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8a7458, 1.1));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.1); sun.position.set(30, 60, 20); scene.add(sun);
// the game's camera and gun mount (client/core.js, client/viewmodel.js): 74 degrees, the gun at .62 of its size .42 m out
const camera = new THREE.PerspectiveCamera(74, 16 / 9, .03, 600); scene.add(camera); camera.updateMatrixWorld(true);
const GUNPOS = [.2, -.2, -.42], gun = new THREE.Group(); camera.add(gun); gun.scale.setScalar(.62); gun.position.set(...GUNPOS);
const sleeve = new THREE.MeshStandardMaterial({ color: 0x3b4a5f, roughness: .85 });
const loader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const VIEW = {}; let ARMS_T = [null, null], ARMS = null;
function viewModel(w, team) {
  const g = new THREE.Group(), m = applyFinish(gunModel(w, team), "factory"); g.add(m);
  m.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(0x2a2a2a); } });
  return g;
}
const bone = n => ARMS && ARMS.meshes[0].skeleton.bones.find(b => b.name === n);
const look = (pos, at, up = [0, 1, 0], fov = 32) => { const c = new THREE.PerspectiveCamera(fov, CW / CH, .01, 50); c.position.set(...pos); c.up.set(...up); c.lookAt(new THREE.Vector3(...at)); c.updateMatrixWorld(true); return c; };
const near = (k, off) => () => { const p = bone("hand" + k).getWorldPosition(new THREE.Vector3()); return look([p.x + off[0], p.y + off[1], p.z + off[2]], p.toArray(), [0, 1, 0], 26); };
const VIEWS = [
  ["eye (the game's view)", () => camera],
  ["from the right", () => look([1.5, -.2, -.45], [.08, -.3, -.42])],
  ["from below", () => look([.1, -1.4, -.5], [.1, -.25, -.5], [0, 0, -1])],
  ["eye at the hands (x3)", () => { const c = new THREE.PerspectiveCamera(26, CW / CH, .01, 50); const a = bone("handR").getWorldPosition(new THREE.Vector3()), b = bone("handL").getWorldPosition(new THREE.Vector3()); c.lookAt(a.lerp(b, .5)); c.updateMatrixWorld(true); return c; }],
  ["right hand from its left (fingers, thumb)", near("R", [-.45, .05, -.12])],
  ["left hand from the front left", near("L", [-.35, -.1, -.35])]
];
const lb = document.getElementById("lb");
if (!EYE) VIEWS.forEach(([name], i) => { const d = document.createElement("div"); d.textContent = name; d.style.left = (i % COLS) * CW + "px"; d.style.top = Math.floor(i / COLS) * CH + "px"; lb.appendChild(d); });
function draw() {
  scene.updateMatrixWorld(true);
  if (EYE) { renderer.setViewport(0, 0, 1280, 720); renderer.setScissor(0, 0, 1280, 720); renderer.render(scene, camera); return; }
  VIEWS.forEach(([, cam], i) => { const x = (i % COLS) * CW, y = (ROWS - 1 - Math.floor(i / COLS)) * CH; renderer.setViewport(x, y, CW, CH); renderer.setScissor(x, y, CW, CH); renderer.render(scene, cam()); });
}
async function go(w = "ak", team = 1, st = {}) {
  for (const k in VIEW) VIEW[k].visible = false;
  const key = w + team; if (!VIEW[key]) { VIEW[key] = viewModel(w, team); gun.add(VIEW[key]); }
  const vm = VIEW[key]; vm.visible = true;
  if (ARMS) ARMS.root.visible = false; ARMS = ARMS_T[team] || ARMS_T[0]; ARMS.root.visible = true;
  // the draw and the inspect as game.js moves the gun for them
  const d = st.drawK ? st.drawK * st.drawK * (3 - 2 * st.drawK) : 0;
  gun.position.set(GUNPOS[0], GUNPOS[1] - d * .26, GUNPOS[2] + d * .06); gun.rotation.set(-d * .7, 0, d * .45);
  if (st.inspect) { const k = st.inspect; gun.rotation.y += k * 1.1; gun.rotation.z += k * .5; gun.position.x -= k * .05; gun.position.y += k * .03; }
  camera.updateMatrixWorld(true);
  const t0 = performance.now(), c = gripFor(ARMS, w, vm), solveMs = performance.now() - t0;
  const r = poseHands(ARMS, w, vm, camera, st) || {};
  draw();
  const out = { w, team, solveMs: Math.round(solveMs) };
  for (const k of ["R", "L"]) if (r[k]) out[k] = { ext: Math.round(r[k].ext), uln: Math.round(r[k].uln), twist: Math.round(r[k].twist), slid: Math.round(r[k].slid * 1000) };
  out.fingers = c.fingers && c.fingers.R ? c.fingers.R.fingers.map(f => f.map(x => +x.toFixed(2))) : null;
  out.measured = c.m ? { kind: c.kind, mag: !!c.m.mag, guard: !!c.m.guard } : null;
  document.getElementById("info").textContent = `${w} team ${team} ${JSON.stringify(st)}  ` + JSON.stringify({ R: out.R, L: out.L });
  return out;
}
(async () => {
  await loadGunModels(loader()); await loadArms(loader());
  const mk = t => { const a = makeArms(sleeve, t); if (!a) return null; mountArms(a, camera); a.root.visible = false; return a; };
  ARMS_T = [mk(0), mk(1)];
  window.__lab = { go, ready: true };
})();
