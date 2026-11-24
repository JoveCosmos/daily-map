/* The look of things: weapons drawn as real side profiles extruded into solids (bevelled, in their own materials),
   and soldiers built as a jointed skeleton that walks, crouches, aims and holds the weapon it carries. Everything is
   made here in code, except the few guns with a public-domain model to replace theirs (IMPORTED, MODELS.md). Sizes are
   real (metres); a gun's origin is its grip, forward is -Z. */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

const M = (color, roughness = .7, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
const TEX = {}, rnd = (() => { let a = 7; return () => ((a = Math.imul(a ^ a >>> 15, 2654435761) + 1013904223 | 0) >>> 0) / 4294967296; })();
function tex(key, size, draw, rep = 1) {
  if (TEX[key] || typeof document === "undefined") return TEX[key] || null;
  const c = document.createElement("canvas"); c.width = c.height = size; draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.userData.shared = true;
  return (TEX[key] = t);
}
const grain = (g, n, w, h, a) => { for (let i = 0; i < n; i++) { g.fillStyle = `rgba(${rnd() < .5 ? "0,0,0" : "255,255,255"},${a * rnd()})`; g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 2, 1 + rnd() * 2); } };
const T = {
  wood: () => tex("wood", 256, (g, n) => { g.fillStyle = "#7b4a22"; g.fillRect(0, 0, n, n);
    for (let y = 0; y < n; y += 2) { const d = Math.sin(y * .09) * 6 + Math.sin(y * .023) * 14; g.strokeStyle = `rgba(${rnd() < .5 ? "40,20,6" : "150,95,50"},${.12 + rnd() * .18})`; g.lineWidth = 1 + rnd() * 1.5; g.beginPath(); g.moveTo(0, y + d * .1); for (let x = 0; x <= n; x += 16) g.lineTo(x, y + Math.sin((x + d) * .03) * 2.5); g.stroke(); }
    grain(g, 2500, n, n, .08); }, 3),
  metal: () => tex("metal", 256, (g, n) => { g.fillStyle = "#2e3033"; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 900; i++) { g.strokeStyle = `rgba(255,255,255,${.015 + rnd() * .03})`; const y = rnd() * n; g.beginPath(); g.moveTo(rnd() * n, y); g.lineTo(rnd() * n, y + rnd() * 2); g.stroke(); }
    for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(170,175,180,${.05 + rnd() * .12})`; g.beginPath(); g.arc(rnd() * n, rnd() * n, 1 + rnd() * 5, 0, 7); g.fill(); } }, 4),
  poly: () => tex("poly", 128, (g, n) => { g.fillStyle = "#1e2023"; g.fillRect(0, 0, n, n); grain(g, 4000, n, n, .1); }, 6),
  olive: () => tex("olive", 128, (g, n) => { g.fillStyle = "#56603f"; g.fillRect(0, 0, n, n); grain(g, 4000, n, n, .12); }, 6),
  weave: () => tex("weave", 64, (g, n) => { g.fillStyle = "#808080"; g.fillRect(0, 0, n, n); for (let y = 0; y < n; y += 4) for (let x = 0; x < n; x += 4) { g.fillStyle = (x + y) % 8 ? "#9a9a9a" : "#6a6a6a"; g.fillRect(x, y, 4, 2); } }, 10),
  // team camouflage: Atlas a cool digital pattern, Ember warm desert blotches
  atlas: () => tex("camo-atlas", 256, (g, n) => { const pal = ["#3b4a5f", "#2c3747", "#55657a", "#1f2833"]; g.fillStyle = pal[0]; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 520; i++) { g.fillStyle = pal[1 + (rnd() * 3 | 0)]; const x = (rnd() * n / 8 | 0) * 8, y = (rnd() * n / 8 | 0) * 8, w = (1 + rnd() * 3 | 0) * 8, h = (1 + rnd() * 2 | 0) * 8; g.fillRect(x, y, w, h); } }, 2),
  ember: () => tex("camo-ember", 256, (g, n) => { const pal = ["#9a8460", "#b39c74", "#76623f", "#c4ae86"]; g.fillStyle = pal[0]; g.fillRect(0, 0, n, n);
    for (let i = 0; i < 90; i++) { g.fillStyle = pal[1 + (rnd() * 3 | 0)]; g.beginPath(); const x = rnd() * n, y = rnd() * n, r = 10 + rnd() * 26; g.ellipse(x, y, r, r * (.4 + rnd() * .5), rnd() * 3, 0, 7); g.fill(); } grain(g, 1500, n, n, .06); }, 2)
};
const textured = (map, roughness, metalness, bump = .002) => { const m = new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale: bump, roughness, metalness }); m.userData.shared = true; return m; };
const MAT = {
  gunmetal: M(0x2c2e31, .42, .65), steel: M(0x777b80, .3, .85), black: M(0x1b1d20, .55, .2), wood: M(0x7b4a22, .55), woodDark: M(0x58331a, .6),
  bakelite: M(0x8c3f1a, .45, .1), olive: M(0x56603f, .7, .05), tan: M(0xa08e66, .75), blade: M(0xd9dde1, .18, .95),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0c1a24, roughness: .05, metalness: .3, clearcoat: 1 })
};
if (typeof document !== "undefined") {
  MAT.gunmetal = textured(T.metal(), .38, .7, .0015); MAT.wood = textured(T.wood(), .55, 0, .003); MAT.woodDark = textured(T.wood(), .6, 0, .003); MAT.woodDark.color.set(0x8a7060);
  MAT.black = textured(T.poly(), .6, .15, .002); MAT.olive = textured(T.olive(), .7, .05, .002);
}
for (const k in MAT) MAT[k].userData.shared = true;   // shared by every gun: never disposed with one
/* weapon finishes (2026-11-14): cosmetic only, chosen in Settings, seen by everyone. A finish repaints the gun's body
   materials (gunmetal, polymer, olive furniture); steel, wood, glass and blades keep theirs. Owning finishes on chain
   (gno) would plug in here later: the list a player may pick from would come from their wallet */
export const FINISHES = ["factory", "desert", "arctic", "night", "forest", "crimson", "gold"];
const FIN = {};
function finishMats(name) {
  if (FIN[name]) return FIN[name];
  if (typeof document === "undefined" || name === "factory" || !FINISHES.includes(name)) return (FIN[name] = null);
  const camo = (pal, blobs, sq) => tex("fin-" + name, 256, (g, n) => { g.fillStyle = pal[0]; g.fillRect(0, 0, n, n);
    for (let i = 0; i < blobs; i++) { g.fillStyle = pal[1 + (rnd() * (pal.length - 1) | 0)]; const x = rnd() * n, y = rnd() * n;
      if (sq) { g.fillRect((x / 8 | 0) * 8, (y / 8 | 0) * 8, (1 + rnd() * 3 | 0) * 8, (1 + rnd() * 2 | 0) * 8); } else { g.beginPath(); const r = 8 + rnd() * 22; g.ellipse(x, y, r, r * (.4 + rnd() * .5), rnd() * 3, 0, 7); g.fill(); } } });
  const plain = (c, r, m) => { const x = new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m }); x.userData.shared = true; return x; };
  const tx = (map, r, m) => { const x = textured(map, r, m, .002); x.userData.shared = true; return x; };
  const set = {
    desert: () => tx(camo(["#b49a6a", "#9b8156", "#cdb88c", "#7d6845"], 110, false), .7, .05),
    arctic: () => tx(camo(["#d9dde0", "#b7bec4", "#8c959c", "#eef1f3"], 420, true), .55, .1),
    night: () => plain(0x141a2a, .35, .55),
    forest: () => tx(camo(["#4a5a3a", "#33402a", "#6b7a4f", "#262d1e"], 110, false), .7, .05),
    crimson: () => tx(camo(["#5a0f12", "#8a1a1e", "#2a0708", "#b0302a"], 300, false), .4, .3),
    gold: () => plain(0xc9a14a, .22, .95)
  }[name]();
  return (FIN[name] = set);
}
const REPAINT = new Set(["gunmetal", "black", "olive"]);
export function applyFinish(g, name) {
  const m = finishMats(name); if (!m) return g;
  const mats = new Set([...REPAINT].map(k => MAT[k]));
  g.traverse(o => { if (o.isMesh && mats.has(o.material)) o.material = m; });
  return g;
}
/* a side profile (points as [forward, up] in metres; [cx, cy, x, y] is a curve) extruded to a width, forward -> -Z */
function profile(pts, width, mat, bevel = .003) {
  const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) { const p = pts[i]; if (p.length === 4) sh.quadraticCurveTo(p[0], p[1], p[2], p[3]); else sh.lineTo(p[0], p[1]); }
  sh.closePath();
  const d = Math.max(.001, width - 2 * bevel), g = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 6 });
  g.translate(0, 0, -d / 2); g.rotateY(Math.PI / 2);
  const m = new THREE.Mesh(g, mat); m.castShadow = true; return m;
}
function tube(r, len, mat, fwd, up = 0, seg = 16, r2 = r) {
  const g = new THREE.CylinderGeometry(r2, r, len, Math.min(seg, 10)); g.rotateX(Math.PI / 2); const m = new THREE.Mesh(g, mat); m.position.set(0, up, -fwd); m.castShadow = true; return m;
}
function box(sx, sy, sz, mat, fwd, up, x = 0) { const m = new THREE.Mesh(new RoundedBoxGeometry(sx, sy, sz, 1, Math.min(sx, sy, sz) * .25), mat); m.position.set(x, up, -fwd); m.castShadow = true; return m; }

/* how far the muzzle is in front of the grip, for the flash and the tracer */
export const MUZZLE = { knife: .22, ak: .8, m4: .74, aug: .58, awp: 1.04, glock: .19, usp: .33, deagle: .25, mp9: .34, mac10: .22, nova: .82, he: .05, flash: .05, smoke: .05, molotov: .1, c4: .1,
  p250: .19, cz75: .19, fiveseven: .19, tec9: .3, mp7: .36, ump: .3, p90: .32, galil: .8, famas: .62, m4a1s: .95, sg553: .62, ssg08: .9, xm1014: .82, negev: .95, zeus: .1, decoy: .05 };
/* the rest of the arsenal (2026-11-14): each built on the nearest gun above, with the parts that tell it apart */
const VARIANT = { p250: "glock", cz75: "glock", fiveseven: "glock", tec9: "mac10", mp7: "mp9", ump: "mac10", galil: "ak", famas: "aug", m4a1s: "m4", sg553: "aug", ssg08: "awp", xm1014: "nova", negev: "m4", p90: "mp9" };
function variant(w, g) {
  const add = m => g.add(m);
  // the base may be a Hunyuan 3D gun now, not the code one these parts were sized on: parts that sit on its outside are placed
  // from its own bounds (front, back, top) so nothing floats off it (2026-11-22)
  const bb = new THREE.Box3().setFromObject(g), front = -bb.min.z, back = -bb.max.z, top = bb.max.y;
  const tipY = (() => { let lo = Infinity, hi = -Infinity; const v = new THREE.Vector3(); g.updateMatrixWorld(true);
    g.traverse(o => { if (!o.isMesh) return; const p = o.geometry.attributes.position; for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); if (v.z < bb.min.z + .03) { lo = Math.min(lo, v.y); hi = Math.max(hi, v.y); } } });
    return lo < hi ? (lo + hi) / 2 : .034; })();   // the muzzle's height
  if (w === "p250") add(box(.03, .036, .19, MAT.steel, .005, .04));                                   // a bright steel slide
  else if (w === "fiveseven") add(box(.03, .036, .19, MAT.olive, .005, .04));                         // the sand-coloured slide
  else if (w === "cz75") add(box(.03, .036, .19, MAT.gunmetal, .005, .04));
  else if (w === "tec9") { add(tube(.008, .12, MAT.steel, .25, .035)); g.scale.set(.85, .85, .85); }   // long thin barrel, small frame
  else if (w === "mp7") add(box(.03, .012, .12, MAT.black, (front + back) / 2 + .02, top + .004));   // a rail on top
  else if (w === "ump") { add(box(.045, .05, .22, MAT.black, back - .1, .02)); g.scale.set(1.2, 1.15, 1.15); }   // a full stock, a bigger box
  else if (w === "galil") add(profile([[.26, .0], [.46, .006], [.465, .058], [.26, .066]], .054, MAT.black));   // black handguard over the wood
  else if (w === "famas") { add(box(.02, .03, .3, MAT.black, .05, .13)); add(box(.012, .05, .012, MAT.black, -.07, .1)); add(box(.012, .05, .012, MAT.black, .17, .1)); }   // the carry handle
  else if (w === "m4a1s") { add(tube(.02, .2, MAT.black, front + .08, tipY)); }                                // the suppressor
  else if (w === "sg553") { add(tube(.022, .18, MAT.black, .05, .14)); add(tube(.026, .002, MAT.glass, .14, .14)); }   // its scope
  else if (w === "p90") { add(box(.05, .028, .24, MAT.glass, (front + back) / 2 + .03, top + .01)); }   // the clear top magazine and the bullpup butt (2026-11-22: the P90 had no model and was invisible)
  else if (w === "ssg08") g.scale.set(.86, .82, .82);                                                   // a lighter bolt gun than the AWP
  else if (w === "xm1014") { add(profile([[.3, -.01], [.5, -.01], [.5, .04], [.3, .04]], .042, MAT.black)); add(box(.02, .03, .32, MAT.gunmetal, .45, .075)); }   // black fore-end, heat shield
  else if (w === "negev") { add(box(.07, .1, .12, MAT.olive, .14, -.06)); add(tube(.011, .3, MAT.steel, front + .13, tipY));
    for (const x of [-1, 1]) { const l = new THREE.Mesh(new THREE.CylinderGeometry(.006, .006, .16, 6), MAT.black); l.position.set(x * .03, tipY - .08, -(front - .05)); l.rotation.z = x * .35; l.castShadow = true; add(l); } }   // bipod legs, standing down from the barrel   // box magazine, long barrel, bipod
  return g;
}
/* imported guns (2026-11-16): CC0 models (MODELS.md) for the guns they match, painted in our own materials so finishes
   still apply, and fitted to the code-built gun's length and place (muzzle, top, centre line), so the grip, the hands, the
   flash and the tracer all stay where they were. Until they load, or if one fails, the code-built gun is used. rot turns
   the file's forward into ours (-Z); mats names each material slot of the file */
const IMPORTED = {
  ak: { file: "hy-ak.glb", rot: Math.PI / 2, own: true },     // Hunyuan 3D (2026-11-22), own textures kept
  m4: { file: "hy-m4.glb", rot: Math.PI, own: true, dark: .22 },   // the re-rendered Maverick (2026-11-23) came out silver-white: darkened to the black finish asked for
  mp9: { file: "hy-mp9.glb", rot: Math.PI / 2, own: true },
  deagle: { file: "hy-deagle.glb", rot: -Math.PI / 2, own: true },
  awp: { file: "hy-awp.glb", rot: -Math.PI / 2, own: true },
  glock: { file: "hy-glock.glb", rot: -Math.PI / 2, own: true },
  usp: { file: "hy-usp.glb", rot: Math.PI / 2, own: true, like: "glock" },   // sized as a bare pistol, the suppressor added in code
  knife: { file: "hy-knife-atlas.glb", rot: -Math.PI / 2, own: true },       // Atlas: teal blade
  knifeE: { file: "hy-knife-ember.glb", rot: -Math.PI / 2, own: true, like: "knife" }   // Ember: black blade
};
/* two cuts of every Hunyuan 3D file (2026-11-22): the full one (30k faces, colour + normal + metal maps) for the gun in your
   own hands on a computer, and the m- one (5k faces, a 512 colour map only) for guns in other players' hands, and for
   everything on a phone, where the full set ran out of graphics memory (the screen broke up and the game hung) */
let LITE = false;
export function setLite(v) { LITE = !!v; }
// one-time change to every model and map address: phones cached the old files for a day under the new code
export const BUST = "?v=20261123";
export const fileFor = f => (LITE ? "m-" : "") + f;
const LOADED = {}, LOADED3 = {};
export async function loadGunModels(loader) {
  await Promise.all(Object.entries(IMPORTED).flatMap(([w, d]) => [
    (async () => { try { LOADED3[w] = fitImported(w, d, (await loader.loadAsync("models/m-" + d.file + BUST)).scene); if (LITE) LOADED[w] = LOADED3[w]; } catch (e) {} })(),
    LITE ? null : (async () => { try { LOADED[w] = fitImported(w, d, (await loader.loadAsync("models/" + d.file + BUST)).scene); } catch (e) {} })()]));
  return Object.keys(LOADED);
}
function fitImported(w, d, scene) {
  const code = codeGun(d.like || w), cb = new THREE.Box3().setFromObject(code); disposeTree(code);
  bakeSkins(scene); const root = new THREE.Group(); scene.rotation.y += d.rot; root.add(scene);
  if (!d.noLevel) levelRoll(root, scene);
  scene.traverse(o => { if (o.isMesh) { if (!d.own) o.material = MAT[d.mats[o.material.name]] || MAT.gunmetal; else { o.material.userData.shared = true; if (d.dark) o.material.color.multiplyScalar(d.dark); } o.castShadow = true; o.geometry.userData.shared = true; } });
  let b = new THREE.Box3().setFromObject(root); root.scale.setScalar((cb.max.z - cb.min.z) / (b.max.z - b.min.z)); root.updateMatrixWorld(true);
  b = new THREE.Box3().setFromObject(root);
  root.position.set((cb.min.x + cb.max.x) / 2 - (b.min.x + b.max.x) / 2, cb.max.y - b.max.y, cb.min.z - b.min.z);
  return root;
}
/* upright about the barrel (2026-11-22): the generated files come with some roll of their own (the Maverick lay 45 degrees
   on its side, the Deagle 10), so the gun's cross-section seen down the barrel is turned until its long axis, grip to top,
   is vertical */
function cov(root, scene, a, b) {   // the spread of the points over two axes (0 x, 1 y, 2 z)
  root.updateMatrixWorld(true); const v = new THREE.Vector3(); let n = 0, mx = 0, my = 0, xx = 0, yy = 0, xy = 0;
  scene.traverse(o => { if (!o.isMesh) return; const p = o.geometry.attributes.position; for (let i = 0; i < p.count; i += 3) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); const X = v.getComponent(a), Y = v.getComponent(b); n++; mx += X; my += Y; xx += X * X; yy += Y * Y; xy += X * Y; } });
  return { n, mx, my, xx, yy, xy };
}
function levelRoll(root, scene) {
  // first the barrel straight along the length (the Deagle came turned a few degrees to one side)
  { let { n, mx, my, xx, yy, xy } = cov(root, scene, 2, 0); if (n) { mx /= n; my /= n; xx = xx / n - mx * mx; yy = yy / n - my * my; xy = xy / n - mx * my;
    const yaw = .5 * Math.atan2(2 * xy, xx - yy); if (Math.abs(yaw) > .01 && Math.abs(yaw) < .3) scene.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)); } }
  let { n, mx, my, xx, yy, xy } = cov(root, scene, 0, 1);
  if (!n) return; mx /= n; my /= n; xx = xx / n - mx * mx; yy = yy / n - my * my; xy = xy / n - mx * my;
  const major = .5 * Math.atan2(2 * xy, xx - yy);   // the long axis' angle from +X
  let roll = Math.PI / 2 - major; roll = Math.atan2(Math.sin(roll), Math.cos(roll)); if (roll > Math.PI / 2) roll -= Math.PI; if (roll < -Math.PI / 2) roll += Math.PI;
  if (Math.abs(roll) < .03 || Math.abs(roll) > 1.2) return;   // already upright, or not a gun shape (a flat blade)
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll); scene.quaternion.premultiply(q);
}
/* a rigged file (a bolt, a slide) drawn in its rest pose as a plain mesh: a skinned mesh measures in its bind pose but draws
   through its bones, and the two disagreed in the view (the AK came out far too big); the moving parts are animated in
   code anyway */
function bakeSkins(scene) {
  scene.updateMatrixWorld(true); const v = new THREE.Vector3(), skinned = [];
  scene.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
  for (const o of skinned) {
    const g = o.geometry.clone(), pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i); o.applyBoneTransform(i, v); pos.setXYZ(i, v.x, v.y, v.z); }
    g.deleteAttribute("skinIndex"); g.deleteAttribute("skinWeight"); g.computeVertexNormals();
    const m = new THREE.Mesh(g, o.material); m.name = o.name; m.matrix.copy(o.matrixWorld); m.matrix.decompose(m.position, m.quaternion, m.scale);
    o.parent.remove(o); scene.add(m);
  }
  scene.traverse(o => { if (o.isBone) o.visible = false; });
}
export function gunModel(w, team = 0, third = false) {
  const L = third && !LITE ? LOADED3 : LOADED;   // third person: the light cut
  if (w === "knife" && team && L.knifeE) w = "knifeE";   // each team's own knife
  if (L[w]) { const g = new THREE.Group(); g.add(L[w].clone());
    if (w === "usp") { g.add(tube(.016, .15, MAT.black, .175, .04)); g.add(tube(.017, .004, MAT.gunmetal, .1, .04)); }   // the USP-S suppressor
    return g; }   // a holder: callers scale and turn it, the fit inside stays
  return codeGun(w, third);
}
function codeGun(w, third = false) {
  if (VARIANT[w]) return variant(w, gunModel(VARIANT[w], 0, third));
  const g = new THREE.Group(), add = m => g.add(m);
  if (w === "knife") {
    add(profile([[0, -.012], [.16, -.012], [.215, .004], [.17, .016], [.0, .016]], .005, MAT.blade, .0015));
    add(profile([[-.11, -.017], [0, -.017], [.008, -.022], [.008, .022], [0, .019], [-.11, .019]], .026, MAT.black, .004));
  } else if (w === "ak") {
    add(profile([[-.06, 0], [.26, 0], [.26, .052], [.21, .074], [-.03, .074], [-.06, .058]], .046, MAT.gunmetal));                 // receiver
    add(profile([[-.06, .058], [-.06, .004], [-.34, -.055], [-.4, -.066], [-.4, .036], [-.34, .044]], .04, MAT.wood));              // stock
    add(profile([[.0, .002], [.045, .002], [.018, -.115], [-.026, -.112]], .03, MAT.woodDark));                                     // pistol grip
    add(profile([[.075, .002], [.135, .002], [.155, -.085, .205, -.17], [.15, -.19], [.112, -.095, .08, .002]], .03, MAT.bakelite)); // the curved magazine
    add(profile([[.26, .0], [.46, .006], [.465, .058], [.26, .066]], .052, MAT.wood));                                               // handguard
    add(tube(.013, .2, MAT.wood, .36, .084));                                                                                        // gas tube
    add(tube(.0095, .36, MAT.steel, .62, .036)); add(tube(.014, .045, MAT.gunmetal, .79, .036));                                     // barrel, brake
    add(box(.012, .045, .012, MAT.gunmetal, .7, .066)); add(profile([[.0, .02], [.04, .02], [.01, -.02], [-.02, -.02]], .012, MAT.gunmetal, .002));
    for (const f of [-.02, .08, .18]) for (const x of [-.024, .024]) { const r = tube(.0035, .004, MAT.steel, f, .045); r.rotation.set(0, 0, Math.PI / 2); r.position.x = x; add(r); }   // receiver rivets
    add(box(.02, .012, .05, MAT.gunmetal, .03, .085));   // rear sight leaf
  } else if (w === "m4") {
    add(profile([[-.05, 0], [.26, 0], [.26, .074], [-.05, .074]], .05, MAT.black));                                                 // receiver
    add(box(.022, .022, .29, MAT.gunmetal, .12, .086));                                                                              // top rail
    for (let f = -.005; f < .26; f += .022) add(box(.026, .006, .008, MAT.gunmetal, f, .1));                                       // its slots
    for (let f = .28; f < .47; f += .022) for (const x of [-.032, .032]) add(box(.006, .02, .008, MAT.gunmetal, f, .035, x));      // side rails
    add(profile([[-.05, .062], [-.05, .004], [-.29, -.03], [-.335, -.045], [-.335, .066], [-.27, .07]], .045, MAT.black));          // stock
    add(profile([[.0, .002], [.04, .002], [.02, -.11], [-.022, -.108]], .03, MAT.black));                                           // grip
    add(profile([[.075, .002], [.128, .002], [.135, -.17], [.083, -.17]], .028, MAT.steel, .002));                                  // magazine
    add(profile([[.26, -.008], [.48, -.008], [.48, .078], [.26, .078]], .058, MAT.black));                                          // quad rail
    add(tube(.0095, .26, MAT.steel, .6, .034)); add(tube(.013, .05, MAT.black, .74, .034));
    add(box(.016, .04, .02, MAT.black, .02, .11)); add(box(.012, .045, .012, MAT.black, .5, .1));                                   // sights
  } else if (w === "aug") {
    add(profile([[-.3, -.02], [.17, -.02], [.23, .02], [.23, .064], [-.24, .064], [-.3, .04]], .062, MAT.olive, .006));             // bullpup housing
    add(profile([[.0, -.018], [.04, -.018], [.03, -.12], [-.01, -.12]], .032, MAT.olive));                                          // grip
    add(profile([[.15, -.018], [.185, -.018], [.18, -.11], [.15, -.11]], .03, MAT.olive));                                          // foregrip
    add(profile([[-.17, -.016], [-.105, -.016], [-.1, -.17], [-.16, -.17]], .028, MAT.glass, .002));                                // translucent magazine
    add(tube(.024, .22, MAT.black, .02, .108)); add(tube(.027, .03, MAT.black, .14, .108)); add(tube(.027, .03, MAT.black, -.1, .108));
    add(tube(.02, .002, MAT.glass, -.116, .108)); add(tube(.0105, .32, MAT.steel, .4, .028)); add(tube(.015, .05, MAT.black, .58, .028));
  } else if (w === "awp") {
    add(profile([[-.42, -.06], [-.42, .065], [-.12, .072], [.36, .058], [.36, .004], [.06, -.004], [.02, -.11], [-.05, -.11], [-.1, -.02], [-.18, -.02], [-.21, -.07], [-.36, -.07]], .056, MAT.olive, .006));
    add(profile([[-.06, .004], [.06, .004], [.055, -.1], [.0, -.1]], .04, MAT.black));                                              // magazine well
    add(tube(.013, .66, MAT.gunmetal, .7, .042, 16, .016)); add(tube(.02, .06, MAT.gunmetal, 1.02, .042));                          // fluted barrel, brake
    add(tube(.028, .3, MAT.black, .04, .135)); add(tube(.036, .08, MAT.black, .22, .135)); add(tube(.032, .06, MAT.black, -.13, .135));
    add(tube(.034, .002, MAT.glass, .262, .135)); add(box(.03, .03, .05, MAT.black, .06, .09));                                     // lens, mount
    add(tube(.012, .03, MAT.black, .04, .175)); { const t2 = tube(.012, .03, MAT.black, .04, .135); t2.rotation.set(0, 0, Math.PI / 2); t2.position.x = .04; add(t2); }   // turrets
    const bolt = tube(.006, .07, MAT.steel, -.02, .07); bolt.rotation.set(0, 0, Math.PI / 2); bolt.position.x = .035; add(bolt); add(box(.02, .02, .02, MAT.steel, -.02, .07, .07));
  } else if (w === "glock" || w === "usp") {   // polymer pistols: slide over frame, the USP-S with its long suppressor
    add(profile([[-.09, .022], [.1, .022], [.1, .058], [-.085, .058]], .028, w === "usp" ? MAT.gunmetal : MAT.black));            // slide
    add(profile([[-.09, 0], [.1, 0], [.1, .022], [-.09, .022]], .026, MAT.black));                                                  // frame
    add(profile([[-.07, .002], [-.018, .002], [-.035, -.108], [-.088, -.104]], .03, MAT.black));                                     // grip
    add(profile([[-.015, .0], [.035, .0], [.035, -.03], [-.015, -.03]], .008, MAT.black, .002));                                     // trigger guard
    add(box(.008, .012, .008, MAT.black, .09, .064)); add(box(.012, .01, .008, MAT.black, -.075, .064));                            // sights
    if (w === "usp") { add(tube(.016, .15, MAT.black, .175, .04)); add(tube(.017, .004, MAT.gunmetal, .1, .04)); }                   // suppressor
  } else if (w === "deagle") {   // the heavy one: a long steel slide, a thick barrel, a big grip
    add(profile([[-.11, .024], [.15, .024], [.15, .074], [-.105, .074]], .034, MAT.steel));
    add(profile([[-.11, 0], [.15, 0], [.15, .024], [-.11, .024]], .03, MAT.gunmetal));
    add(profile([[-.085, .002], [-.025, .002], [-.045, -.12], [-.105, -.116]], .036, MAT.black));
    add(profile([[-.02, .0], [.04, .0], [.04, -.035], [-.02, -.035]], .009, MAT.gunmetal, .002));
    add(box(.012, .03, .03, MAT.steel, .14, .055)); add(box(.01, .014, .01, MAT.black, .14, .082)); add(box(.014, .012, .01, MAT.black, -.095, .082));
  } else if (w === "mp9") {   // compact polymer SMG: grip magazine, a vertical foregrip, a thin folding stock
    add(profile([[-.08, 0], [.17, 0], [.17, .06], [-.08, .06]], .045, MAT.black));
    add(profile([[.0, .002], [.045, .002], [.03, -.17], [-.012, -.168]], .032, MAT.black));                                          // grip with the magazine
    add(profile([[.11, .002], [.14, .002], [.135, -.075], [.11, -.075]], .028, MAT.black));                                          // foregrip
    add(box(.012, .012, .2, MAT.gunmetal, -.18, .03, 0)); add(box(.01, .06, .012, MAT.gunmetal, -.28, .01));                       // stock
    add(tube(.009, .1, MAT.steel, .22, .03)); add(box(.02, .016, .12, MAT.gunmetal, .04, .07));                                    // barrel, rail
  } else if (w === "mac10") {   // a steel box with a grip magazine and a short barrel
    add(box(.05, .07, .2, MAT.gunmetal, .04, .03)); add(box(.04, .012, .16, MAT.black, .04, .072));
    add(profile([[-.02, .002], [.022, .002], [.012, -.17], [-.03, -.168]], .03, MAT.black));
    add(tube(.01, .08, MAT.steel, .17, .035)); add(box(.012, .03, .012, MAT.gunmetal, -.07, .05));
  } else if (w === "nova") {   // pump shotgun: long barrel over the tube magazine, the pump on it, a full stock
    add(profile([[-.06, 0], [.2, 0], [.2, .06], [-.06, .06]], .05, MAT.black));
    add(profile([[-.06, .055], [-.06, .004], [-.36, -.06], [-.42, -.07], [-.42, .04], [-.33, .05]], .045, MAT.black));             // stock
    add(profile([[.0, .002], [.04, .002], [.02, -.1], [-.022, -.098]], .03, MAT.black));                                             // grip
    add(tube(.012, .6, MAT.steel, .5, .045)); add(tube(.012, .44, MAT.gunmetal, .42, .015));                                        // barrel, magazine tube
    add(profile([[.3, -.01], [.5, -.01], [.5, .04], [.3, .04]], .04, MAT.woodDark));                                                 // the pump
    add(box(.008, .012, .008, MAT.steel, .79, .062));
  } else if (w === "he") {   // fragmentation: an olive egg, its spoon and pin
    const b = new THREE.Mesh(new THREE.SphereGeometry(.034, 14, 10), MAT.olive); b.scale.set(1, 1.15, 1); add(b);
    add(box(.012, .05, .016, MAT.gunmetal, -.01, .03)); add(tube(.008, .008, MAT.steel, 0, .052));
  } else if (w === "flash" || w === "smoke") {   // a can: bright steel for the flash, grey with a band for the smoke
    const c = new THREE.Mesh(new THREE.CylinderGeometry(.026, .026, .1, 14), w === "flash" ? MAT.steel : MAT.gunmetal); add(c);
    add(box(.012, .05, .016, MAT.gunmetal, -.01, .045)); if (w === "smoke") add(new THREE.Mesh(new THREE.CylinderGeometry(.027, .027, .018, 14), MAT.black));
  } else if (w === "zeus") {   // the taser: a short yellow-and-black body
    add(profile([[-.06, 0], [.12, 0], [.12, .05], [-.06, .05]], .03, MAT.black)); add(box(.032, .02, .1, MAT.olive, .05, .03));
    add(profile([[-.05, .002], [-.01, .002], [-.025, -.09], [-.065, -.088]], .028, MAT.black));
  } else if (w === "decoy") {   // a small grey can with a band
    const c = new THREE.Mesh(new THREE.CylinderGeometry(.022, .022, .08, 12), MAT.gunmetal); add(c); add(new THREE.Mesh(new THREE.CylinderGeometry(.023, .023, .012, 12), MAT.olive));
  } else if (w === "c4") {   // the bomb in hand: a charge with its keypad and wires
    add(box(.07, .14, .2, MAT.olive, 0, 0)); add(box(.075, .04, .09, MAT.black, .03, .07)); add(box(.02, .02, .2, MAT.steel, 0, -.06, .04));
  } else if (w === "molotov") {   // a bottle with a rag in its neck
    const b = new THREE.Mesh(new THREE.CylinderGeometry(.03, .032, .12, 14), MAT.glass); add(b);
    const nk = new THREE.Mesh(new THREE.CylinderGeometry(.011, .02, .06, 10), MAT.glass); nk.position.y = .09; add(nk);
    const rag = new THREE.Mesh(new THREE.CylinderGeometry(.013, .009, .06, 8), MAT.woodDark); rag.position.y = .13; add(rag);
  }
  return g;
}

/* ── soldiers ────────────────────────────────────────────────────────────────── */
const SK = { ct: { cloth: 0x3b4a5f, vest: 0x232c38, pants: 0x2f3947, gear: 0x1e252e, head: 0x2b3542 }, t: { cloth: 0x8b7451, vest: 0x5b4932, pants: 0x6d5b3f, gear: 0x3d3122, head: 0x8e7350 } };
const cap = (r, len, mat) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 8), mat); m.castShadow = true; return m; };
const rbox = (sx, sy, sz, mat, r = .04) => { const m = new THREE.Mesh(new RoundedBoxGeometry(sx, sy, sz, 2, r), mat); m.castShadow = sx * sy > .02; return m; };   // small parts cast no shadow
/* each team's materials, made once and shared by all its soldiers: camouflage cloth with a woven relief */
const KIT = {};
function kit(team) {
  if (KIT[team]) return KIT[team];
  const c = team ? SK.t : SK.ct, sh = m => (m.userData.shared = true, m);
  const camo = typeof document !== "undefined" ? (team ? T.ember() : T.atlas()) : null;
  const cloth = sh(new THREE.MeshStandardMaterial({ map: camo, bumpMap: camo ? T.weave() : null, bumpScale: .004, roughness: .9, color: 0xffffff }));
  const pants = sh(new THREE.MeshStandardMaterial({ map: camo, bumpMap: camo ? T.weave() : null, bumpScale: .004, roughness: .92, color: 0xdddddd }));
  return (KIT[team] = { c, cloth, pants, vest: sh(M(c.vest, .78)), gear: sh(M(c.gear, .72)), pouch: sh(M(team ? 0x7a6545 : 0x2a3340, .8)), skin: sh(M(0xc49a72, .7)),
    boots: sh(M(0x1d1915, .85)), sole: sh(M(0x0d0c0b, .95)), glove: sh(M(0x26221e, .8)), headM: sh(M(c.head, team ? .9 : .5, team ? 0 : .12)),
    dark: sh(M(0x111418, .25, .4)), balaclava: sh(M(0x3a3f44, .95)), lens: sh(new THREE.MeshPhysicalMaterial({ color: 0x2e4a3a, roughness: .04, metalness: .6, clearcoat: 1, emissive: 0x0a1a12 })), scarf: sh(M(0x4a3c2c, .95)) });
}
export const sleeveMaterial = team => kit(team).cloth;
/* first-person arms (rebuilt 2026-11-24, assets/hy/fitarms.py; the 2026-11-16 CC0 rig and the 2026-11-22 fit are retired).
   Every arms file carries one armature, in metres, facing -Z: upper_arm -> forearm -> forearm_twist (half way) and wrist (at
   the wrist) -> hand -> fingers. A team's file (arms-atlas, arms-ember) is its generated sleeve with the CC0 hand as the
   glove; arms-cc0 is the CC0 arm alone (the fallback, and the public game's), worn in the team's sleeve material.
   pose() takes each hand's place and facing on the gun and works the arm out the way a body would:
   - the elbow: of every elbow the two bone lengths allow (a circle round the shoulder-wrist line), the one that leaves the
     wrist nearest its comfortable grip (a little extended and toward the little finger), the hand turned within a
     forearm's range, and the elbow toward the side asked (client/hands.js works the shoulder and that side out from the
     hand, so the best elbow is usually exactly the natural one). The old solve took a fixed elbow direction and put the rest in the wrist
     (bent up to 77 degrees one way and 70 the other at once: "twisted at the wrist")
   - the turn of the hand about the forearm goes to the forearm, as the radius rolls over the ulna: wrist carries all of it,
     forearm_twist half; the sleeve rides the forearm and does not turn (a loose sleeve does not), the glove's strap does
   - the shoulder is off screen: when a hand is out of reach it slides toward it, never the hand away from the gun
   - the fingers bend at each of their three joints by the angles given (client/hands.js closes them on the gun) */
const ARMS = { scene: null, team: [null, null], used: false };
const load1 = async (loader, f) => { try { return (await loader.loadAsync("models/" + f + BUST)).scene; } catch (e) { return null; } };
export async function loadArms(loader) {
  [ARMS.scene, ARMS.team[0], ARMS.team[1]] = await Promise.all(["arms-cc0.glb", fileFor("arms-atlas.glb"), fileFor("arms-ember.glb")].map(f => load1(loader, f)));
  return !!(ARMS.scene || ARMS.team[0] || ARMS.team[1]);
}
export const FINGERS = ["index", "middle", "ring", "pinky"];
// how a body likes its wrist (degrees): [preferred, softness, hardest one way, hardest the other]. twist: the hand's turn
// about the forearm from the rig's rest; only the strap and glove turn with it (the sleeve does not), so it is barely held
export const WRIST = { ext: [12, 30, -60, 65], uln: [8, 18, -18, 32], twist: [0, 400, -170, 170] };
export function makeArms(sleeve, team = 0) {
  let root = ARMS.team[team ? 1 : 0];
  if (!root) { if (!ARMS.scene || ARMS.used) return null; root = ARMS.scene; ARMS.used = true; }
  const meshes = []; root.traverse(o => { if (o.isSkinnedMesh) { o.frustumCulled = false; o.castShadow = false; meshes.push(o); } });
  if (!meshes.length) return null;
  for (const m of meshes) {
    if (m.material && m.material.name === "sleeve") m.material = sleeve;   // the bare CC0 skin wears the team's sleeve
    else if (m.material && m.material.map) m.material.roughness = Math.max(m.material.roughness, .6);
  }
  const bones = meshes[0].skeleton.bones, B = n => bones.find(b => b.name === n);
  if (!B("wristR") || !B("handR")) return null;   // an arms file from before the rebuild
  const rest = new Map(); for (const b of bones) rest.set(b, [b.position.clone(), b.quaternion.clone()]);
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert(), at = (b, v = new THREE.Vector3()) => b.getWorldPosition(v).applyMatrix4(inv);   // root space
  const wq = b => b.getWorldQuaternion(new THREE.Quaternion()), rq = root.getWorldQuaternion(new THREE.Quaternion()).invert();
  const SIDE = {};
  for (const k of ["R", "L"]) {
    const S = { k, up: B("upper_arm" + k), fo: B("forearm" + k), tw: B("forearm_twist" + k), wr: B("wrist" + k), hand: B("hand" + k),
      fingers: FINGERS.map(f => [1, 2, 3].map(i => B(`f_${f}0${i}${k}`))), thumb: [1, 2, 3].map(i => B(`thumb0${i}${k}`)) };
    const s0 = at(S.up), e0 = at(S.fo), w0 = at(S.hand);
    S.la = s0.distanceTo(e0); S.lb = e0.distanceTo(w0);
    // the hand's own axes at rest (root space): F along the middle finger, A across the knuckles toward the index (radial),
    // P out of the palm (the side the fingers curl to); kept in the hand bone's frame
    const F = at(S.fingers[1][0]).sub(w0).normalize(), A = at(S.fingers[0][0]).sub(at(S.fingers[3][0])); A.addScaledVector(F, -A.dot(F)).normalize();
    const P = new THREE.Vector3().crossVectors(F, A).normalize(), tip = at(S.fingers[1][2]).sub(at(S.fingers[1][0]));
    if (P.dot(tip) < 0) P.negate();
    S.radial = Math.sign(new THREE.Vector3().crossVectors(F, P).dot(A));   // A = radial * (F x P): which way round this hand is
    const hq = wq(S.hand).premultiply(rq).invert(); S.F = F.clone().applyQuaternion(hq); S.P = P.clone().applyQuaternion(hq);
    // the forearm's line, in its own frame and in each twist bone's
    const fl = w0.clone().sub(e0).normalize();
    const loc = b => fl.clone().applyQuaternion(wq(b).premultiply(rq).invert());
    S.af = loc(S.fo); S.atw = S.tw ? loc(S.tw) : null; S.awr = loc(S.wr);
    // the elbow's hinge at rest, in the upper arm's frame and the forearm's (the arm keeps it as it bends)
    S.n0 = new THREE.Vector3().crossVectors(e0.clone().sub(s0), w0.clone().sub(e0)).normalize();
    S.u0 = e0.clone().sub(s0).normalize(); S.f0 = fl;
    S.qu0 = wq(S.up).premultiply(rq); S.qf0 = wq(S.fo).premultiply(rq);
    SIDE[k] = S;
  }
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), m1 = new THREE.Matrix4(), m2 = new THREE.Matrix4();
  const D = 180 / Math.PI;
  const pen = (x, [p, s, lo, hi]) => ((x - p) / s) ** 2 + (x > hi ? ((x - hi) / 3) ** 2 : 0) + (x < lo ? ((lo - x) / 3) ** 2 : 0);
  const basis = (a, b) => { const c = new THREE.Vector3().crossVectors(a, b); return new THREE.Matrix4().makeBasis(a, b, c); };
  const setWorld = (b, q) => { b.parent.getWorldQuaternion(q2); b.quaternion.copy(q2.invert().multiply(q)); b.updateMatrixWorld(true); };
  // one arm: T = { at, F, P, pole } (world), returns what it did (for the lab and tests)
  function reach(S, T) {
    const wroot = root.getWorldQuaternion(new THREE.Quaternion()), sc = root.getWorldScale(new THREE.Vector3()).x;
    const la = S.la * sc, lb = S.lb * sc;
    // the hand's world turn, from its fingers' direction and its palm's
    const F = T.F.clone().normalize(), P = T.P.clone().addScaledVector(F, -T.P.dot(F)).normalize();
    const Qh = new THREE.Quaternion().setFromRotationMatrix(basis(F, P).multiply(m2.copy(basis(S.F, S.P)).transpose()));
    const A = new THREE.Vector3().crossVectors(F, P).multiplyScalar(S.radial);
    // the shoulder slides along its line to the hand when the hand is out of reach (or too close to bend into)
    // the shoulder: where the caller puts it (first-person arms anchor each one off screen), else where the rig has it
    if (T.shoulder) { S.up.parent.updateMatrixWorld(true); S.up.position.copy(S.up.parent.worldToLocal(T.shoulder.clone())); S.up.updateMatrixWorld(true); }
    const W = T.at, s0 = S.up.getWorldPosition(new THREE.Vector3()); let d = s0.distanceTo(W); const far = (la + lb) * .995, near = Math.abs(la - lb) + .2 * Math.min(la, lb);
    let slid = 0;
    if (d > far || d < near) { const want = d > far ? far : near, back = s0.clone().sub(W).normalize(); slid = d - want; s0.copy(W).addScaledVector(back, want); S.up.parent.updateMatrixWorld(true);
      S.up.position.copy(S.up.parent.worldToLocal(s0.clone())); S.up.updateMatrixWorld(true); d = want; }
    const u = v1.copy(W).sub(s0).normalize().clone(), ca = (la * la + d * d - lb * lb) / (2 * la * d), along = la * ca, rad = la * Math.sqrt(Math.max(0, 1 - ca * ca));
    const p1 = new THREE.Vector3(0, 1, 0).cross(u); if (p1.lengthSq() < 1e-6) p1.set(1, 0, 0).cross(u); p1.normalize(); const p2 = new THREE.Vector3().crossVectors(u, p1);
    const C = s0.clone().addScaledVector(u, along), pole = T.pole.clone().addScaledVector(u, -T.pole.dot(u)).normalize();
    const n0w = S.n0.clone().applyQuaternion(wroot), u0w = S.u0.clone().applyQuaternion(wroot), f0w = S.f0.clone().applyQuaternion(wroot);
    const qu0w = wroot.clone().multiply(S.qu0), qf0w = wroot.clone().multiply(S.qf0);
    // everything an elbow at angle t round the circle implies
    const at_ = t => {
      const E = C.clone().addScaledVector(p1, Math.cos(t) * rad).addScaledVector(p2, Math.sin(t) * rad);
      const u1 = E.clone().sub(s0).normalize(), a1 = v2.copy(W).sub(E).normalize().clone(), n1 = new THREE.Vector3().crossVectors(u1, a1).normalize();
      // the arm turned so its rest upper arm and hinge land on the new ones, then the elbow bent about that hinge
      const R = new THREE.Quaternion().setFromRotationMatrix(basis(u1, n1).multiply(m1.copy(basis(u0w, n0w)).transpose()));
      const Qu = R.clone().multiply(qu0w), fr = f0w.clone().applyQuaternion(R), Qf = new THREE.Quaternion().setFromUnitVectors(fr, a1).multiply(R).multiply(qf0w);
      // the wrist: the forearm's line seen from the hand (extension toward the palm side, ulnar toward the radial axis' opposite)
      const ext = Math.atan2(a1.dot(P), a1.dot(F)) * D, uln = Math.atan2(a1.dot(A), a1.dot(F)) * D;
      // the hand's turn about the forearm from the rest (what the twist bones will carry): the sleeve does not turn, the strap
      // and glove do, so this only costs past a forearm's real range
      const Ql = Qf.clone().invert().multiply(Qh), pr = Ql.x * S.af.x + Ql.y * S.af.y + Ql.z * S.af.z, t2 = 2 * Math.atan2(pr, Ql.w), tw = Math.atan2(Math.sin(t2), Math.cos(t2)) * D;
      const cost = pen(ext, T.ext0 != null ? [T.ext0, WRIST.ext[1], WRIST.ext[2], WRIST.ext[3]] : WRIST.ext) + pen(uln, T.uln0 != null ? [T.uln0, WRIST.uln[1], WRIST.uln[2], WRIST.uln[3]] : WRIST.uln) + pen(tw, WRIST.twist) + 2 * (1 - E.clone().sub(C).normalize().dot(pole));
      return { E, Qu, Qf, ext, uln, sup: tw, cost };
    };
    // the elbow's angle round the circle: last frame's neighbourhood first (the hands move a little a frame), the whole
    // circle when there is no last one or the near search came out much worse (a switch, a reload's jump)
    let best = null; const D1 = Math.PI / 180, warm = S.lastT != null;
    const look = (t) => { const r = at_(t); if (!best || r.cost < best.cost) best = Object.assign(r, { t }); };
    if (warm) for (let i = -12; i <= 12; i += 3) look(S.lastT + i * D1);
    if (!warm || best.cost > S.lastCost * 1.5 + .5) { for (let i = 0; i < 36; i++) look(i / 36 * Math.PI * 2); }
    const c0 = best.t; for (let i = -2; i <= 2; i++) if (i) look(c0 + i * D1);
    S.lastT = best.t; S.lastCost = best.cost;
    setWorld(S.up, best.Qu); setWorld(S.fo, best.Qf);
    // the hand's turn about the forearm (its twist) goes to the twist bones; the hand keeps the rest (the bend at the wrist)
    const Ql = S.fo.getWorldQuaternion(q1).invert().multiply(Qh), ax = S.af, pr = Ql.x * ax.x + Ql.y * ax.y + Ql.z * ax.z;
    const tw = 2 * Math.atan2(pr, Ql.w), twist = Math.atan2(Math.sin(tw), Math.cos(tw));
    if (S.tw) { S.tw.quaternion.copy(rest.get(S.tw)[1]).multiply(q2.setFromAxisAngle(S.atw, twist / 2)); S.tw.updateMatrixWorld(true); }
    S.wr.quaternion.copy(rest.get(S.wr)[1]).multiply(q2.setFromAxisAngle(S.awr, twist)); S.wr.updateMatrixWorld(true);
    setWorld(S.hand, Qh);
    return { ext: best.ext, uln: best.uln, sup: best.sup, twist: twist * D, slid, cost: best.cost, E: best.E };
  }
  // fingers: [[mcp, pip, dip] x index, middle, ring, pinky] (radians, + closes), thumb: [base in, base across, middle, tip]
  function bend(S, fingers, thumb) {
    S.fingers.forEach((ch, i) => { const a = fingers[i] || fingers; ch.forEach((b, j) => { if (b) b.quaternion.copy(rest.get(b)[1]).multiply(q1.setFromAxisAngle(XAX, (Array.isArray(a) ? a[j] : a) || 0)); }); });
    if (thumb) { const [t0, t1, t2, t3] = thumb, [b1, b2, b3] = S.thumb;
      if (b1) b1.quaternion.copy(rest.get(b1)[1]).multiply(q1.setFromAxisAngle(XAX, t0 || 0)).multiply(q2.setFromAxisAngle(ZAX, t1 || 0));
      if (b2) b2.quaternion.copy(rest.get(b2)[1]).multiply(q1.setFromAxisAngle(XAX, t2 || 0));
      if (b3) b3.quaternion.copy(rest.get(b3)[1]).multiply(q1.setFromAxisAngle(XAX, t3 || 0)); }
  }
  return { root, mesh: meshes[0], meshes, side: SIDE, rest,
    /* r, l: { at, F, P, pole, shoulder, ext0, uln0, fingers, thumb } in world space (ext0/uln0: this grip's own wrist; l null: that arm keeps its rest) */
    pose(r, l) {
      for (const [b, [p, q]] of rest) { b.position.copy(p); b.quaternion.copy(q); } root.updateMatrixWorld(true);
      const out = {};
      for (const [k, T] of [["R", r], ["L", l]]) { if (!T) continue; out[k] = reach(SIDE[k], T); bend(SIDE[k], T.fingers || 0, T.thumb); }
      root.updateMatrixWorld(true); return out;
    } };
}
const XAX = new THREE.Vector3(1, 0, 0), ZAX = new THREE.Vector3(0, 0, 1);
/* fighters (2026-11-21): bodies generated in Hunyuan 3D and rigged by us (22 bones, MODELS.md), posed here every frame
   by the same walk, crouch and aim as the code-built soldier below, with a two-bone reach that puts the hands on the
   gun. Each team has a few bodies; a player keeps one by their name. Until the files load, the code-built one stands in */
const FIGHTERS = { 0: ["atlas1", "atlas2", "atlas3", "atlas4"], 1: ["ember1", "ember2", "ember3", "ember4", "ember5"] }, HY = { 0: [], 1: [] }, HEIGHT = 1.78;
export async function loadFighters(loader) {
  await Promise.all(Object.entries(FIGHTERS).flatMap(([team, names]) => names.map(async n => {
    try { const scene = (await loader.loadAsync("models/" + fileFor(`fighter-${n}.glb`) + BUST)).scene; HY[team].push(prepFighter(scene, +team, n)); } catch (e) {} })));
  for (const t of [0, 1]) HY[t].sort((a, b) => a.n < b.n ? -1 : 1);
  return HY[0].length + HY[1].length;
}
function prepFighter(scene, team, n) {
  let mesh = null; scene.traverse(o => { if (o.isSkinnedMesh) mesh = o; });
  const g = mesh.geometry; g.computeBoundingBox(); const bb = g.boundingBox, h = bb.max.y - bb.min.y; g.userData.shared = true;
  let mat = mesh.material;
  if (!mat.map) {   // a grey body: the team's colours by height (boots, trousers, jacket, head), blended across each band
    const P = g.attributes.position, col = new Float32Array(P.count * 3), cs = (team ? [0x1d1915, 0x54432f, 0x9c8259, 0x6b5a44] : [0x1d1915, 0x2f3947, 0x3b4a5f, 0x2b3542]).map(x => new THREE.Color(x)), cut = [.07, .5, .86], tmp = new THREE.Color();
    for (let v = 0; v < P.count; v++) { const f = (P.getY(v) - bb.min.y) / h; let i = 0; while (i < 3 && f > cut[i] + .02) i++;
      tmp.copy(cs[i]); if (i < 3 && f > cut[i] - .02) tmp.lerp(cs[i + 1], (f - cut[i] + .02) / .04); col.set([tmp.r, tmp.g, tmp.b], v * 3); }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3)); mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85 });
  } else mat.roughness = Math.max(mat.roughness, .7);
  mat.userData.shared = true;
  return { n, scene, mat, s: HEIGHT / h, y: -bb.min.y * HEIGHT / h };
}
/* the team's rim light (2026-11-24, operator): a fine edge of the team's colour round every fighter, strongest where the
   body turns away from the eye, so a player reads against any wall (vischeck: Ember's desert camo melted into the
   factory, snow village and market). It is drawn inside the body's own material (no extra draw call), so walls and smoke
   cover it as they cover the body, and game.js puts it out as a fighter dies: a lit outline always means someone alive.
   Each fighter gets its own copy of its body's material (same program, same textures) so its light can fade alone */
/* the menu's team swatches; gain 2.5 and power 4 keep it a thin edge (A/B on factory, market and snow village: a softer,
   wider one tinted the whole body). It lifts a fighter off a dark or same-coloured wall; against a bright sky it lightens a
   dark fighter a little, who stands out there anyway */
export const RIM = { colour: [new THREE.Color(0x4f86d9), new THREE.Color(0xe0a14a)], gain: { value: 2.5 }, power: { value: 4 } };
const RIMU = new WeakMap();
function rimShader(sh) {   // one named function for every copy: the same text keeps them on one compiled program
  const u = RIMU.get(this); sh.uniforms.rimK = u.k; sh.uniforms.rimC = u.c; sh.uniforms.rimG = RIM.gain; sh.uniforms.rimP = RIM.power;
  sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nuniform float rimK, rimG, rimP;\nuniform vec3 rimC;")
    // the smooth surface's normal, not the normal map's: the bumps of the cloth would light up all over the body
    .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += rimC * ( rimK * rimG * pow( 1.0 - saturate( dot( nonPerturbedNormal, normalize( vViewPosition ) ) ), rimP ) );");
}
function rimmed(root, team) {   // returns the fighter's light switch, 0..1
  const u = { k: { value: 1 }, c: { value: RIM.colour[team ? 1 : 0] } }, made = new Map();
  root.traverse(o => { if (!o.isMesh || !o.material || !o.material.isMeshStandardMaterial) return;
    let m = made.get(o.material);
    if (!m) { const src = o.material; m = src.clone(); m.userData = {}; m.onBeforeCompile = rimShader; RIMU.set(m, u); made.set(src, m);
      if (src.map) src.map.userData.shared = true; }   // the copy goes when its fighter goes, the body's texture stays
    o.material = m; });
  const set = v => { u.k.value = v; }; set.u = u.k; return set;
}
export const CR = { drop: .45, thigh: 1.15, shin: 2.2, lean: 0 };   // the fighter crouch, tuned against the hit boxes
const AIR = { thigh: .55, shin: 1.1 };   // the jump tuck: sim.js AIR, which the leg hit boxes use, keep both the same
const sm = x => x * x * (3 - 2 * x), seg = (p, a, b) => sm(Math.min(1, Math.max(0, (p - a) / (b - a))));
function fighter(team, F) {
  const root = new THREE.Group(), fit = new THREE.Group(), body = cloneSkinned(F.scene); fit.add(body); root.add(fit);
  fit.rotation.y = Math.PI; fit.scale.setScalar(F.s); fit.position.y = F.y;   // the files face +Z; the game's forward is -Z
  body.traverse(o => { if (o.isMesh) { o.material = F.mat; o.castShadow = true; o.frustumCulled = false; } });
  const rim = rimmed(body, team);   // the body only: the gun in its hands stays as it is
  const bones = {}; body.traverse(o => { if (o.isBone) bones[o.name] = o; });
  root.updateMatrixWorld(true);
  // each bone's rest: its own turn, and its turn in the body's frame, so a turn about the body's axes can be applied to it
  const rest = new Map(), wq = new THREE.Quaternion(), rq = new THREE.Quaternion();
  for (const b of Object.values(bones)) rest.set(b, { p: b.position.clone(), q: b.quaternion.clone(), w: b.getWorldQuaternion(new THREE.Quaternion()) });
  const turn = (b, x, y = 0, z = 0) => { const r = rest.get(b); rq.setFromEuler(new THREE.Euler(x, y, z)); b.quaternion.copy(r.q).multiply(wq.copy(r.w).invert().multiply(rq).multiply(r.w)); };
  // the hips drop in the body's frame: one metre down, in the hips' parent's terms
  const H = bones.hips, hp = H.getWorldPosition(new THREE.Vector3()), down = H.parent.worldToLocal(hp.clone().setY(hp.y - 1)).sub(H.parent.worldToLocal(hp.clone()));
  const torso = new THREE.Group(); root.add(torso); const mount = new THREE.Group(); torso.add(mount);
  let held = null;
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), pole = new THREE.Vector3();
  const setWorldQuat = (b, q) => { b.parent.getWorldQuaternion(q2); b.quaternion.copy(q2.invert().multiply(q)); b.updateMatrixWorld(true); };
  const turnTo = (b, from, to) => { b.getWorldQuaternion(q1); setWorldQuat(b, new THREE.Quaternion().setFromUnitVectors(from, to).multiply(q1)); };
  function reach(k, T, poleLocal) {   // shoulder fixed, elbow from the two lengths, bent toward the pole, wrist on T
    const up = bones["upperarm" + k], fo = bones["forearm" + k], hd = bones["hand" + k];
    const sh = up.getWorldPosition(new THREE.Vector3()), el0 = fo.getWorldPosition(new THREE.Vector3()), wr0 = hd.getWorldPosition(new THREE.Vector3());
    const la = sh.distanceTo(el0), lb = el0.distanceTo(wr0), d = v1.copy(T).sub(sh), dist = THREE.MathUtils.clamp(d.length(), Math.abs(la - lb) + 1e-4, (la + lb) * .999);
    d.normalize(); const ca = (la * la + dist * dist - lb * lb) / (2 * la * dist), along = la * ca, rise = la * Math.sqrt(Math.max(0, 1 - ca * ca));
    root.getWorldQuaternion(q1); pole.copy(poleLocal).applyQuaternion(q1); pole.addScaledVector(d, -pole.dot(d)).normalize();
    const elbow = sh.clone().addScaledVector(d, along).addScaledVector(pole, rise);
    turnTo(up, v2.copy(el0).sub(sh).normalize(), v3.copy(elbow).sub(sh).normalize());
    const e1 = fo.getWorldPosition(new THREE.Vector3()), w1 = hd.getWorldPosition(new THREE.Vector3());
    turnTo(fo, v2.copy(w1).sub(e1).normalize(), v3.copy(T).sub(e1).normalize());
  }
  const POLE_R = new THREE.Vector3(.6, -1, .3), POLE_L = new THREE.Vector3(-.8, -1, .1), tR = new THREE.Vector3(), tL = new THREE.Vector3();
  return {
    root, head: bones.head, rim,
    setWeapon(w, fin = "factory") { if (held === w + fin) return; held = w + fin; for (const c of [...mount.children]) { mount.remove(c); disposeTree(c); } const m = applyFinish(gunModel(w, team, true), fin); m.scale.setScalar(1.05); mount.add(m); mount.userData.w = w; },
    /* o.move: the walk's direction from the facing (radians, 0 ahead), o.dead: 0..1 into the fall, o.air: 0..1 off the
       ground, o.land: 1..0 just after landing, o.act: { k: reload | cock | throw | plant | defuse, p: 0..1 through it } */
    pose(speed, phase, duck, pitch, o = {}) {
      // strafing (2026-11-22): the hips turn toward the walk, up to 60 degrees, and the chest turns back to the aim; walking
      // backwards the legs face ahead and step in reverse, so nobody moonwalks
      let mv = o.move || 0, dir = 1; if (Math.abs(mv) > Math.PI / 2) { mv -= Math.sign(mv) * Math.PI; dir = -1; }
      const legYaw = speed > .3 ? THREE.MathUtils.clamp(mv, -1.05, 1.05) * Math.min(1, speed / 1.5) : 0, dead = o.dead || 0;
      phase *= dir;
      // the crouch (2026-11-22) lowers the head by the 18 units the hit boxes drop (sim.js), upright over the hips, so the
      // head you see is the head the server tests: the old pose stopped 13 cm high and leant 30 cm forward of it
      // dying: the knees go first, the chest slumps, the arms drop; game.js tips the whole body over on top of this
      const kn = Math.min(1, dead * 1.8), bend = Math.max(duck, kn * .8);
      const air = o.air || 0, land = o.land || 0, act = o.act;
      const k = Math.min(1, speed / 4.5) * (1 - air * .7), sw = Math.sin(phase) * .6 * k, drop = bend * CR.drop + Math.abs(Math.sin(phase)) * .025 * k + land * .05;
      for (const [b, r] of rest) { b.position.copy(r.p); b.quaternion.copy(r.q); }
      H.position.copy(rest.get(H).p).addScaledVector(down, drop); if (legYaw) turn(H, 0, legYaw);   // the legs hang off the hips and turn with them
      // in the air the knees tuck up (as the leg hit boxes do); a landing gives at the knees for a moment
      const th = bend * CR.thigh + air * AIR.thigh + land * .12, shn = bend * CR.shin + air * AIR.shin + land * .25;
      turn(bones.thighR, sw + th); turn(bones.thighL, -sw + th);
      turn(bones.shinR, -(Math.max(0, Math.sin(phase + 1.2)) * .9 * k + shn)); turn(bones.shinL, -(Math.max(0, Math.sin(phase + 1.2 + Math.PI)) * .9 * k + shn));
      // planting or defusing the head looks down at the bomb (only the head: the chest stays where its hit box is)
      const bow = act && (act.k === "plant" || act.k === "defuse") ? .55 : 0;
      const lean = pitch * .55 + duck * CR.lean - kn * .5; turn(bones.spine, lean, -legYaw * (1 - kn)); turn(bones.neck, pitch * .45 - kn * .4 - bow * (1 - pitch * .45));
      torso.visible = dead < .05;   // the gun falls out of the hands (the server drops it as a pickup)
      if (dead > 0) { turn(bones.upperarmR, -kn * .3, 0, -kn * .25); turn(bones.upperarmL, -kn * .3, 0, kn * .25); root.updateMatrixWorld(true); return; }
      root.updateMatrixWorld(true);
      // the gun rides the chest: placed off the spine and leaning with it
      bones.spine.getWorldPosition(v1); torso.position.copy(root.worldToLocal(v1)); torso.rotation.set(lean, 0, 0);
      const knife = held && held.startsWith("knife"), w = mount.userData.w || "ak", len = MUZZLE[w] ?? .5;
      if (knife) mount.position.set(.18, .04, -.42); else mount.position.set(.1, .2, -.22);
      mount.rotation.set(0, 0, 0);
      // actions (2026-11-22), as CS's third-person: a reload tips the gun and the left hand takes the magazine down to the
      // belt and back; a grenade is held back over the shoulder with the pin out, then thrown overarm; the bomb is held low
      // in front with both hands
      const P = act ? act.p : 0, BACK = [.24, .34, .14], FRONT = [.12, .02, -.55];
      if (act && act.k === "reload") { const tip = seg(P, 0, .15) * (1 - seg(P, .85, 1)); mount.rotation.set(-.25 * tip, 0, .5 * tip); mount.position.y -= .05 * tip; }
      else if (act && act.k === "cock") { const b = seg(P, 0, 1); mount.position.set(.1 + (BACK[0] - .1) * b, .2 + (BACK[1] - .2) * b, -.22 + (BACK[2] + .22) * b); }
      else if (act && act.k === "throw") { const f = seg(P, 0, .55), r = seg(P, .55, 1); for (let i = 0; i < 3; i++) mount.position.setComponent(i, BACK[i] + (FRONT[i] - BACK[i]) * f + ([.1, .2, -.22][i] - FRONT[i]) * r); mount.rotation.x = -1.2 * f * (1 - r); }
      else if (bow) mount.position.set(.02, -.22, -.4);
      torso.updateMatrixWorld(true);
      mount.localToWorld(tR.set(0, -.02, .03));
      if (act && act.k === "reload" && len >= .3) {   // the left hand: off the grip, to the magazine, down to the belt, back up
        const g = mount.localToWorld(new THREE.Vector3(0, -.03, -Math.min(.42, len * .5))), mg = mount.localToWorld(new THREE.Vector3(0, -.13, -.1)), belt = torso.localToWorld(new THREE.Vector3(-.16, -.32, -.08));
        const a = seg(P, .05, .25), b = seg(P, .25, .45) * (1 - seg(P, .5, .7)), c = seg(P, .75, .95);
        tL.copy(g).lerp(mg, a * (1 - c)).lerp(belt, b);
        reach("R", tR, POLE_R); reach("L", tL, POLE_L);
      } else if (act && (act.k === "cock" || act.k === "throw")) {   // the free hand points ahead, as a thrower aims
        reach("R", tR, POLE_R); reach("L", torso.localToWorld(tL.set(-.12, .12, -.42)), POLE_L);
      } else if (bow) { reach("R", tR, POLE_R); reach("L", mount.localToWorld(tL.set(-.08, 0, 0)), POLE_L); }
      else if (knife || len < .3) { reach("R", tR, POLE_R); turn(bones.upperarmL, -sw * .6); bones.upperarmL.updateMatrixWorld(true); if (len < .3 && !knife) reach("L", mount.localToWorld(tL.set(-.03, -.03, .04)), POLE_L); }
      else { reach("R", tR, POLE_R); reach("L", mount.localToWorld(tL.set(0, -.03, -Math.min(.42, len * .5))), POLE_L); }
      root.updateMatrixWorld(true);
    }
  };
}
const hashName = s => { let h = 7; for (const c of String(s || "")) h = Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0; return h; };
export function soldier(team, name) {
  const list = HY[team ? 1 : 0];
  return list.length ? fighter(team, list[hashName(name) % list.length]) : codeSoldier(team);
}
function codeSoldier(team) {
  const K = kit(team), { c, cloth, vest, pants, gear, pouch, skin, boots, sole, glove } = K;
  const at = (m, x, y, z, rx = 0) => { m.position.set(x, y, z); m.rotation.x = rx; return m; };
  const root = new THREE.Group(), hips = new THREE.Group(); hips.position.y = .95; root.add(hips);
  hips.add(rbox(.34, .17, .21, pants, .05));
  hips.add(at(rbox(.37, .055, .24, gear, .02), 0, .07, 0));
  for (const x of [-.15, .15]) hips.add(at(rbox(.06, .1, .09, pouch, .015), x, .0, -.05));   // hip pouches
  const spine = new THREE.Group(); spine.position.y = .08; hips.add(spine);
  spine.add(at(rbox(.38, .44, .22, cloth, .07), 0, .25, 0));
  // plate carrier: front and back plates, magazine pouches, a radio, shoulder straps
  spine.add(at(rbox(.34, .3, .06, vest, .02), 0, .26, -.125)); spine.add(at(rbox(.34, .32, .06, vest, .02), 0, .26, .125));
  for (const x of [-.1, 0, .1]) spine.add(at(rbox(.075, .12, .055, pouch, .012), x, .16, -.175));
  spine.add(at(rbox(.06, .14, .05, gear, .012), .2, .32, .02)); spine.add(at(new THREE.Mesh(new THREE.CylinderGeometry(.006, .006, .16, 5), gear), .21, .45, .03));
  for (const x of [-.12, .12]) spine.add(at(rbox(.07, .03, .26, vest, .01), x, .43, 0));
  // a pack on the back: an assault pack for Atlas, a lighter sling bag for Ember
  spine.add(team ? at(rbox(.22, .22, .1, pouch, .03), -.04, .2, .2) : at(rbox(.28, .34, .14, pouch, .04), 0, .26, .22));
  const neck = new THREE.Group(); neck.position.y = .5; spine.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(.112, 16, 12), team ? skin : K.balaclava); head.position.y = .1; head.castShadow = true; neck.add(head);
  if (team) {   // Ember: a head wrap, a face scarf, goggles pushed up on the forehead
    const wrap = new THREE.Mesh(new THREE.SphereGeometry(.122, 16, 8, 0, Math.PI * 2, 0, Math.PI * .55), K.headM); wrap.position.y = .11; wrap.castShadow = true; neck.add(wrap);
    const scarf = new THREE.Mesh(new THREE.CylinderGeometry(.118, .1, .1, 14, 1, true), K.scarf); scarf.position.y = .035; scarf.material.side = THREE.DoubleSide; neck.add(scarf);
    neck.add(at(rbox(.19, .04, .045, K.lens, .012), 0, .19, -.095, -.6));
  } else {      // Atlas: a balaclava, a helmet with rails and a night-vision mount, goggles
    const helm = new THREE.Mesh(new THREE.SphereGeometry(.135, 16, 8, 0, Math.PI * 2, 0, Math.PI * .5), K.headM); helm.position.y = .12; helm.castShadow = true; neck.add(helm);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(.135, .012, 4, 18), K.headM); rim.rotation.x = Math.PI / 2; rim.position.y = .12; neck.add(rim);
    for (const x of [-.13, .13]) neck.add(at(rbox(.015, .03, .12, gear, .005), x, .15, 0));
    neck.add(at(rbox(.05, .04, .035, gear, .008), 0, .23, -.12));
    neck.add(at(rbox(.2, .05, .05, K.lens, .016), 0, .11, -.095));
  }
  // arms: a shoulder, an elbow with a pad, a gloved hand; posed around the weapon by pose()
  const arm = side => {
    const sh = new THREE.Group(); sh.position.set(.22 * side, .43, 0); spine.add(sh);
    const up = cap(.056, .2, cloth); up.position.y = -.13; sh.add(up);
    const el = new THREE.Group(); el.position.y = -.27; sh.add(el);
    el.add(at(rbox(.075, .06, .07, gear, .02), 0, 0, .02));
    const fo = cap(.05, .18, cloth); fo.position.y = -.12; el.add(fo);
    el.add(at(rbox(.075, .1, .055, glove, .02), 0, -.25, 0));
    return { sh, el };
  };
  const armR = arm(1), armL = arm(-1);
  const leg = side => {
    const h = new THREE.Group(); h.position.set(.1 * side, -.04, 0); hips.add(h);
    const th = cap(.078, .3, pants); th.position.y = -.21; h.add(th);
    h.add(at(rbox(.06, .1, .05, pouch, .012), .08 * side, -.2, 0));   // a thigh pouch
    const kn = new THREE.Group(); kn.position.y = -.43; h.add(kn);
    kn.add(at(rbox(.1, .09, .06, gear, .02), 0, 0, -.06));
    const sh = cap(.062, .3, pants); sh.position.y = -.2; kn.add(sh);
    kn.add(at(rbox(.12, .11, .25, boots, .035), 0, -.42, -.04)); kn.add(at(rbox(.125, .025, .26, sole, .008), 0, -.475, -.04));
    return { h, kn };
  };
  const legR = leg(1), legL = leg(-1);
  const mount = new THREE.Group(); mount.position.set(.1, .32, -.22); spine.add(mount);
  let held = null; const rim = rimmed(root, team);   // the mount is still empty here: the gun is left out
  return {
    root, head, rim,
    setWeapon(w, fin = "factory") { if (held === w + fin) return; held = w + fin; for (const c of [...mount.children]) { mount.remove(c); disposeTree(c); } const m = applyFinish(gunModel(w, team, true), fin); m.scale.setScalar(1.05); mount.add(m); },
    /* speed in m/s, phase grows with distance walked, duck 0..1, pitch in radians */
    pose(speed, phase, duck, pitch) {
      const k = Math.min(1, speed / 4.5), sw = Math.sin(phase) * .6 * k;
      // signs: a positive turn about X swings a hanging limb forward (-Z); a knee bends with a negative one
      hips.position.y = .95 - duck * .32 - Math.abs(Math.sin(phase)) * .025 * k;
      legR.h.rotation.x = sw + duck * 1.05; legL.h.rotation.x = -sw + duck * 1.05;
      legR.kn.rotation.x = -(Math.max(0, Math.sin(phase + 1.2)) * .9 * k + duck * 1.75); legL.kn.rotation.x = -(Math.max(0, Math.sin(phase + 1.2 + Math.PI)) * .9 * k + duck * 1.75);
      spine.rotation.x = pitch * .55 - duck * .18; neck.rotation.x = pitch * .45;
      // the rifle hold: right hand on the grip, left hand forward on the handguard (a knife is held low and forward)
      if (held === "knife") { armR.sh.rotation.set(.55, 0, -.1); armR.el.rotation.set(.9, 0, 0); armL.sh.rotation.set(-sw * .6, 0, .1); armL.el.rotation.set(.3, 0, 0); mount.position.set(.18, .12, -.42); }
      else { armR.sh.rotation.set(1.0, 0, -.18); armR.el.rotation.set(.75, 0, 0); armL.sh.rotation.set(1.3, 0, .55); armL.el.rotation.set(.35, 0, 0); mount.position.set(.08, .3, -.24); }
    }
  };
}
export const disposeTree = o => o.traverse(x => { if (x.geometry && !x.geometry.userData.shared) x.geometry.dispose(); });
