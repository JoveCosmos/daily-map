/* the page's base (split out of game.js 2026-11-22): the renderer, scene, camera and sun, the URL switches, and small
   helpers every part of the client uses. Nothing here reads game state, so any module can import it */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { setLite } from "../models.js";
export const gltf = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);   // map files are meshopt-compressed, about 17x smaller
export const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
export const AUTO = params.has("autoplay"), TEAM = ["ATLAS", "EMBER"], TEAMCOL = [0x4f86d9, 0xd09440];

/* ── renderer ────────────────────────────────────────────────────────────────── */
export const renderer = new THREE.WebGLRenderer({ antialias: devicePixelRatio < 1.5, powerPreference: "high-performance" });   // dense screens need no multi-sampling
export const PHONE = matchMedia("(pointer: coarse)").matches || new URLSearchParams(location.search).has("touch");
setLite(PHONE || new URLSearchParams(location.search).has("lite"));   // phones load the light cut of every model (models.js)
renderer.setPixelRatio(Math.min(devicePixelRatio, PHONE ? 1.25 : 1.5)); renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = !PHONE;   // phones: no shadow pass at all
 renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;   // redrawn 20 times a second, in render()
document.body.prepend(renderer.domElement);
export const scene = new THREE.Scene();
{ const c = document.createElement("canvas"); c.width = 2; c.height = 256; const g = c.getContext("2d"), gr = g.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, "#5f8fc4"); gr.addColorStop(.55, "#a9c8e2"); gr.addColorStop(1, "#e9e4d6"); g.fillStyle = gr; g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; scene.background = t; }
scene.fog = new THREE.Fog(0xd6dfe4, 70, 260);
{ const pm = new THREE.PMREMGenerator(renderer); scene.environment = pm.fromScene(new RoomEnvironment(), .04).texture; scene.environmentIntensity = .45; pm.dispose(); }   // reflections on metal, wood and cloth, computed once
export const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, .03, 600); scene.add(camera);
scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8a7458, 1.1));
export const sun = new THREE.DirectionalLight(0xfff1d6, 2.1); sun.position.set(30, 60, 20); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.bias = -.0004; sun.shadow.normalBias = .03; scene.add(sun); scene.add(sun.target);
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

export const TOUCH = params.has("touch") || matchMedia("(pointer: coarse)").matches;
if (TOUCH) document.body.classList.add("touch");
export const nowS = () => performance.now() / 1000;
