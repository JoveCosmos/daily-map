/* The look of things: weapons drawn as real side profiles extruded into solids (bevelled, in their own materials),
   and soldiers built as a jointed skeleton that walks, crouches, aims and holds the weapon it carries. Everything is
   made here in code, so nothing is borrowed. Sizes are real (metres); a gun's origin is its grip, forward is -Z. */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

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
export const MUZZLE = { knife: .22, ak: .8, m4: .74, aug: .58, awp: 1.04 };
export function gunModel(w) {
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
export function soldier(team) {
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
  let held = null;
  return {
    root, head,
    setWeapon(w) { if (held === w) return; held = w; for (const c of [...mount.children]) { mount.remove(c); disposeTree(c); } const m = gunModel(w); m.scale.setScalar(1.05); mount.add(m); },
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
export const disposeTree = o => o.traverse(x => { if (x.geometry) x.geometry.dispose(); });
