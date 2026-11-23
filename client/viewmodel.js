/* the weapon in hand: view models, the rigged arms posed on the gun every frame (reload and draw), the muzzle flash (split out of game.js 2026-11-22) */
import * as THREE from "three";
import { applyFinish, gunModel, loadGunModels, loadFighters, loadArms, makeArms, MUZZLE } from "../models.js";
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
  const h = new THREE.Mesh(new THREE.SphereGeometry(.045, 14, 10), glove); h.position.set(x, y, z); g.add(h);
  const a = new THREE.Mesh(new THREE.CapsuleGeometry(.045, .3, 4, 10), sleeve); a.position.set(x + back[0], y + back[1], z + back[2]); a.lookAt(new THREE.Vector3(x, y, z).add(new THREE.Vector3(...back).multiplyScalar(3))); a.rotateX(Math.PI / 2); g.add(a);
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
/* the arms (2026-11-16, models.js makeArms): one rig on the camera, its hands put on whatever gun is out every frame, so
   they follow recoil, bob and sway. The shoulders sit forward under the gun, out of sight: the gun is drawn at .62 of
   its size .42 m ahead, and arms of the same scale only reach it from there (the usual viewmodel trick) */
const ARMSET = { scale: .72, at: new THREE.Vector3(.06, -.36, -.33), yaw: .35, right: [.03, -.07, .06],
  rifle: { fingers: [1, .25, 0], palm: [0, 1, 0], at: hold => [-.045, -.045, -hold] }, pistol: { fingers: [.3, -.3, -1], palm: [1, 0, 0], at: () => [-.028, -.075, .025], curl: 1.2 } };
/* reload keyframes for the left hand, [time 0..1 of the reload, "home" or { at, fingers, palm }] in the gun's space: a
   rifle's hand goes to the magazine, pulls it out of sight, brings one up, seats it, works the charging handle, goes
   back; a pistol's support hand drops, brings a magazine to the grip, racks the slide; a shotgun's thumbs a shell in */
{ const mag = { at: [-.03, -.13, -.13], fingers: [.2, 1, -.3], palm: [1, 0, 0] }, low = { at: [-.08, -.5, -.02], fingers: [.2, 1, 0], palm: [1, 0, 0] };
  ARMSET.rifleReload = [[0, "home"], [.14, mag], [.3, low], [.48, low], [.62, mag], [.72, mag], [.82, { at: [.05, .07, .04], fingers: [-1, 0, -.2], palm: [-1, 0, 0] }], [.94, "home"], [1, "home"]];
  ARMSET.pistolReload = [[0, "home"], [.15, { at: [-.06, -.45, .06], fingers: [0, 1, 0], palm: [1, 0, 0] }], [.45, { at: [-.04, -.3, .05], fingers: [0, 1, 0], palm: [1, 0, 0] }],
    [.6, { at: [-.02, -.15, .03], fingers: [0, 1, -.2], palm: [1, 0, 0] }], [.76, { at: [-.03, .05, .09], fingers: [0, -.3, -1], palm: [1, 0, 0] }], [.86, { at: [-.03, .05, .02], fingers: [0, -.3, -1], palm: [1, 0, 0] }], [1, "home"]];
  /* the right hand per kind of thing held (2026-11-23): a gun's grip hangs below its bore, but a knife's handle runs along
     the blade's line and a grenade sits round the origin, so one gun target left the hand floating under them */
  ARMSET.grip = { gun: { at: ARMSET.right, fingers: [-.25, -.15, -1], palm: [-1, 0, 0] },
    knife: { at: [.028, .004, .06], fingers: [-.25, -1, -.1], palm: [-1, 0, 0] },
    nade: { at: [.045, -.005, .03], fingers: [-.25, -.15, -1], palm: [-1, 0, 0] },
    c4: { at: [.085, -.01, .03], fingers: [-.25, -.15, -1], palm: [-1, 0, 0] } };
  ARMSET.shells =[[0, "home"], [.35, { at: [-.03, -.08, -.08], fingers: [.3, .6, -.6], palm: [1, .3, 0] }], [.6, { at: [-.01, -.05, -.02], fingers: [.3, .6, -.6], palm: [1, .3, 0] }], [1, "home"]]; }
if (!params.has("codeguns")) loadGunModels(gltf()).then(got => { if (got.length) rebuildViews(); });
loadFighters(gltf()).then(n => { if (!n) return; for (const o of others.values()) reskin(o.model, o.team, o.named); for (const m of KC.temps.values()) { scene.remove(m.g); dispose(m.g); } KC.temps.clear(); });
let ARMS_T = [null, null];   // each team's arms (models.js makeArms); ARMS is whichever is in use
loadArms(gltf()).then(ok => { if (!ok) return;
  const mk = t => { const a = makeArms(sleeve, t); if (!a) return null;
    a.root.position.copy(ARMSET.at); a.root.rotation.set(0, Math.PI + ARMSET.yaw, 0); a.root.scale.setScalar(ARMSET.scale); a.root.visible = false; camera.add(a.root); return a; };
  ARMS_T = [mk(0), mk(1)]; ARMS = ARMS_T[0] || ARMS_T[1]; if (ARMS) rebuildViews(); });
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _cq = new THREE.Quaternion();
function poseArms(w) {
  const cur = ARMS_T[myTeam ? 1 : 0] || ARMS; if (cur !== ARMS) { ARMS.root.visible = false; ARMS = cur; }
  if (VIEW.knife && VIEW.knife.userData.team !== myTeam) { const was = VIEW.knife.visible; gun.remove(VIEW.knife); dispose(VIEW.knife); VIEW.knife = viewModel("knife"); VIEW.knife.visible = was; gun.add(VIEW.knife); }   // your team's knife
  const vm = VIEW[w]; ARMS.root.visible = gun.visible && !!vm && vm.visible; if (!ARMS.root.visible) return;
  vm.updateWorldMatrix(true, false); vm.getWorldQuaternion(_q); camera.getWorldQuaternion(_cq);
  const gd = a => new THREE.Vector3(...a).applyQuaternion(_q), cd = a => new THREE.Vector3(...a).applyQuaternion(_cq), hold = HOLD[w] && HOLD[w][1];
  const kind = hold == null ? null : hold < .06 ? ARMSET.pistol : ARMSET.rifle, W0 = WEAPONS[w] || {};
  let lp = kind && kind.at(hold), lf = kind && kind.fingers, ln = kind && kind.palm; let gripL = kind && kind.curl || .8;   // the left hand's curl: wraps the handguard, closes tighter on a magazine or a shell
  // a reload (2026-11-16): the left hand works the gun along keyframes over the gun's own reload time
  if (kind && me.reloadAt && me.w === w) { const r = W0.shell || W0.reload || 2, p = W0.shell ? 1 - ((me.reloadAt - me.clock) / r % 1 + 1) % 1 : clamp(1 - (me.reloadAt - me.clock) / r, 0, 1);
    const keys = W0.shell ? ARMSET.shells : kind === ARMSET.pistol ? ARMSET.pistolReload : ARMSET.rifleReload, home = { at: lp, fingers: lf, palm: ln };
    let i = 0; while (i < keys.length - 1 && keys[i + 1][0] <= p) i++;
    const A = keys[i], B = keys[Math.min(i + 1, keys.length - 1)], k = B[0] > A[0] ? THREE.MathUtils.smoothstep(p, A[0], B[0]) : 1;
    const pick = (K, f) => K[1] === "home" ? home[f] : K[1][f], mix = f => pick(A, f).map((x, j) => x + (pick(B, f)[j] - x) * k);
    lp = mix("at"); lf = mix("fingers"); ln = mix("palm");
    const off = f => f[1] === "home" ? 0 : 1, held = off(A) + (off(B) - off(A)) * k; gripL = (kind.curl || .8) + held * .45; }
  const left = kind ? { at: vm.localToWorld(_v.set(...lp).clone()), fingers: gd(lf), palm: gd(ln), pole: cd([-1, -1, .2]) }
    : { at: camera.localToWorld(new THREE.Vector3(-.3, -.75, -.25)), fingers: cd([0, -1, 0]), palm: cd([1, 0, 0]), pole: cd([-1, -1, 0]) };   // one-handed: the left arm drops out of sight
  const R = ARMSET.grip[w] || ARMSET.grip[W0.nade ? "nade" : ""] || ARMSET.grip.gun;
  ARMS.pose({ at: vm.localToWorld(_v.set(...R.at).clone()), fingers: gd(R.fingers), palm: gd(R.palm), pole: cd([1, -1, .2]) }, left,
    { curl: ((WEAPONS[w] || {}).melee ? 1.05 : .9) * (1 - DRAWK * .6), thumb: .4, curlL: gripL * (1 - DRAWK * .8), thumbL: .3 });
}   // the imported guns, once they are in (models.js IMPORTED); ?codeguns compares the old ones
const muzzle = (() => { const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,240,200,1)"); gr.addColorStop(.35, "rgba(255,180,80,.8)"); gr.addColorStop(1, "rgba(255,120,30,0)"); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sp.scale.setScalar(.12); camera.add(sp); return sp; })();
const GUNPOS = new THREE.Vector3(.2, -.2, -.42);
const gunTip = () => camera.localToWorld(GUNPOS.clone().add(new THREE.Vector3(0, .036 * .62, -(MUZZLE[me.w] || .6) * .62)));

export { initViews, ARMS, glove, sleeve, HOLD, handAt, viewModel, gun, VIEW, rebuildViews, ARMSET, ARMS_T, _v, _q, _cq, poseArms, muzzle, GUNPOS, gunTip };
