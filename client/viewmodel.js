/* the weapon in hand: view models, the rigged arms posed on the gun every frame (reload and draw), the muzzle flash (split out of game.js 2026-11-22) */
import * as THREE from "three";
import { applyFinish, gunModel, loadGunModels, loadFighters, loadArms, makeArms, MUZZLE } from "../models.js";
import { poseHands, mountArms, gripFor } from "./hands.js";
import { camera, params, gltf, scene } from "./core.js";
import { WIDS, WEAPONS, clamp } from "../sim.js";
import { myTeam, SET, dispose, others, reskin, KC, me, DRAWK } from "../game.js";
/* ── the weapon in hand: the real model, gloved hands and forearms holding it ── */
let ARMS = null;   // the rigged arms once loaded (below); until then the old hands
const glove = new THREE.MeshStandardMaterial({ color: 0x2a2520, roughness: .85 }), sleeve = new THREE.MeshStandardMaterial({ color: 0x3b4a5f, roughness: .85 });
const HOLD = { knife: [0, null], ak: [0, .37], m4: [0, .37], aug: [0, .17], awp: [0, .3], glock: [0, .02], usp: [0, .02], deagle: [0, .02], mp9: [0, .13], mac10: [0, .1], nova: [0, .4],
               he: [0, null], flash: [0, null], smoke: [0, null], molotov: [0, null], c4: [0, null], decoy: [0, null], zeus: [0, null],
               p250: [0, .02], cz75: [0, .02], fiveseven: [0, .02], tec9: [0, .1], mp7: [0, .13], ump: [0, .14], p90: [0, .12], galil: [0, .37], famas: [0, .17],
               m4a1s: [0, .37], sg553: [0, .17], ssg08: [0, .28], xm1014: [0, .4], negev: [0, .45] };   // where the left hand rests, forward of the grip
function handAt(g, x, y, z, back) {
  const h = new THREE.Mesh(new THREE.SphereGeometry(.045, 14, 10), glove); h.position.set(x, y, z); h.userData.nohand = true; g.add(h);
  const a = new THREE.Mesh(new THREE.CapsuleGeometry(.045, .3, 4, 10), sleeve); a.userData.nohand = true; a.position.set(x + back[0], y + back[1], z + back[2]); a.lookAt(new THREE.Vector3(x, y, z).add(new THREE.Vector3(...back).multiplyScalar(3))); a.rotateX(Math.PI / 2); g.add(a);
}
function viewModel(w) {
  const g = new THREE.Group(), m = applyFinish(gunModel(w, myTeam), SET.fin); g.add(m); g.userData.team = myTeam;
  // the weapon faces away from the sun: a little of its own light instead of a lamp (point lights cost every surface)
  m.traverse(o => { o.castShadow = false; if (o.isMesh) { o.material = o.material.clone(); o.material.emissive = new THREE.Color(0x2a2a2a); } });
  if (!ARMS) { handAt(g, 0, -.03, .0, [.05, -.12, .2]); if (HOLD[w][1] != null) handAt(g, -.01, -.01, -HOLD[w][1], [-.1, -.13, .14]); }   // the old hands until the arms are in
  return g;
}
const gun = new THREE.Group(); camera.add(gun); gun.scale.setScalar(.62);
const VIEW = {};   // filled by initViews() once game.js has its state (the models need your team and finish)
function initViews() { for (const w of WIDS) { VIEW[w] = viewModel(w); VIEW[w].visible = false; gun.add(VIEW[w]); } }
function rebuildViews() { for (const w of WIDS) { const was = VIEW[w].visible; gun.remove(VIEW[w]); dispose(VIEW[w]); VIEW[w] = viewModel(w); VIEW[w].visible = was; gun.add(VIEW[w]); } }
/* the arms (rebuilt 2026-11-24, models.js makeArms + client/hands.js): one rig on the camera, its hands put on whatever is out
   every frame, so they follow recoil, bob, sway, the draw and the inspect. Where each hand goes is measured off each gun's
   own mesh and its fingers closed on it, once per gun (worked out for every gun in idle time after loading, so a switch
   never waits for it); the reload moves the support hand by the gun's own parts */
if (!params.has("codeguns")) loadGunModels(gltf()).then(got => { if (got.length) { rebuildViews(); warmGrips(); } });
loadFighters(gltf()).then(n => { if (!n) return; for (const o of others.values()) reskin(o.model, o.team, o.named); for (const m of KC.temps.values()) { scene.remove(m.g); dispose(m.g); } KC.temps.clear(); });
let ARMS_T = [null, null];   // each team's arms (models.js makeArms); ARMS is whichever is in use
loadArms(gltf()).then(ok => { if (!ok) return;
  const mk = t => { const a = makeArms(sleeve, t); if (!a) return null; mountArms(a, camera); a.root.visible = false; return a; };
  ARMS_T = [mk(0), mk(1)]; ARMS = ARMS_T[0] || ARMS_T[1]; if (ARMS) { rebuildViews(); warmGrips(); } });
function warmGrips() {   // every gun's grip for the arms in use, one gun per idle slot
  const todo = WIDS.slice(), idle = window.requestIdleCallback || (f => setTimeout(f, 60));
  const step = () => { const w = todo.shift(); if (!w) return; if (ARMS && VIEW[w]) try { gripFor(ARMS_T[myTeam ? 1 : 0] || ARMS, w, VIEW[w]); } catch (e) {} idle(step); };
  idle(step);
}
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _cq = new THREE.Quaternion();
function poseArms(w) {
  const cur = ARMS_T[myTeam ? 1 : 0] || ARMS; if (cur !== ARMS) { ARMS.root.visible = false; ARMS = cur; warmGrips(); }
  if (VIEW.knife && VIEW.knife.userData.team !== myTeam) { const was = VIEW.knife.visible; gun.remove(VIEW.knife); dispose(VIEW.knife); VIEW.knife = viewModel("knife"); VIEW.knife.visible = was; gun.add(VIEW.knife); }   // your team's knife
  const vm = VIEW[w]; ARMS.root.visible = gun.visible && !!vm && vm.visible; if (!ARMS.root.visible) return;
  // a reload in progress (your own gun): its share done, a shotgun's per shell
  const W0 = WEAPONS[w] || {}, st = { drawK: DRAWK };
  if (me.reloadAt && me.w === w && !KC.on) { const r = W0.shell || W0.reload || 2;
    if (W0.shell) st.sp = 1 - ((me.reloadAt - me.clock) / r % 1 + 1) % 1; else st.rp = clamp(1 - (me.reloadAt - me.clock) / r, 0, 1); }
  poseHands(ARMS, w, vm, camera, st);
}
const muzzle = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,240,200,1)"); gr.addColorStop(.35, "rgba(255,180,80,.8)"); gr.addColorStop(1, "rgba(255,120,30,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sp.scale.setScalar(.12); camera.add(sp); return sp; })();
const GUNPOS = new THREE.Vector3(.2, -.2, -.42);
const gunTip = () => camera.localToWorld(GUNPOS.clone().add(new THREE.Vector3(0, .036 * .62, -(MUZZLE[me.w] || .6) * .62)));

export { initViews, ARMS, glove, sleeve, HOLD, handAt, viewModel, gun, VIEW, rebuildViews, ARMS_T, _v, _q, _cq, poseArms, muzzle, GUNPOS, gunTip };
