/* the hands on what they hold (2026-11-24). Where each hand goes is measured off each gun's own mesh (the old code used one
   spot for every gun: on the Maverick M4, whose grip sits 5-10 cm ahead of its origin, the hand floated at the stock), each
   hand is turned the way a hand holds that part, and each finger closes joint by joint until it meets the gun (the old
   fingers all bent one amount and stopped in the air or went through). Pure: three, three-mesh-bvh, models.js and sim.js
   only, so tools can pose the hands without the game (the hand lab). Gun frame: metres, origin near the grip, forward -Z */
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { WEAPONS } from "../sim.js";
import { FINGERS, WRIST } from "../models.js";

/* where the support hand holds a long gun, as z in the gun frame (on the handguard, in front of the magazine); anything not
   listed holds at -HOLD of the old table. Pistols are held two-handed, knives, grenades and the bomb in the right hand */
const HOLDZ = { ak: -.4, m4: -.53, awp: -.36, mp9: -.15 };
const HOLD = { ak: .37, m4: .37, aug: .17, awp: .3, mp9: .13, mac10: .1, nova: .4, tec9: .1, mp7: .13, ump: .14, p90: .12, galil: .37, famas: .17, m4a1s: .37, sg553: .17, ssg08: .28, xm1014: .4, negev: .45 };
const PISTOL = new Set(["glock", "usp", "deagle", "p250", "cz75", "fiveseven", "zeus"]), AKBOLT = new Set(["ak", "galil"]);
export const kindOf = w => { const W0 = WEAPONS[w] || {}; return W0.melee ? "knife" : W0.nade ? "nade" : w === "c4" ? "c4" : PISTOL.has(w) ? "pistol" : "long"; };

/* ── the gun's shape: one geometry in the gun frame and its BVH (rays measure it, closest points close the fingers on it) ── */
export function shapeOf(vm) {
  if (vm.userData.shape) return vm.userData.shape;
  vm.updateMatrixWorld(true); const inv = vm.matrixWorld.clone().invert(), parts = [];
  vm.traverse(o => { if (!o.isMesh || !o.geometry || o.userData.nohand) return;
    const g = new THREE.BufferGeometry(); g.setAttribute("position", (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry).attributes.position.clone());
    g.applyMatrix4(inv.clone().multiply(o.matrixWorld)); parts.push(g); });
  if (!parts.length) return null;
  const geom = parts.length > 1 ? mergeGeometries(parts) : parts[0]; geom.computeBoundingBox();
  return (vm.userData.shape = { geom, bvh: new MeshBVH(geom), box: geom.boundingBox.clone() });
}
const _ray = new THREE.Ray();
// solid stretches along a ray through the gun (entry/exit pairs of a double-sided cast), as distances along it
function spans(S, o, d) {
  _ray.origin.copy(o); _ray.direction.copy(d);
  const t = S.bvh.raycast(_ray, THREE.DoubleSide).map(h => h.distance).sort((a, b) => a - b), out = [];
  for (let i = 0; i + 1 < t.length; i += 2) out.push([t[i], t[i + 1]]);
  return out;
}
/* the grip: rays front to back at heights down the gun; at each, the rearmost solid stretch that is short enough to be a
   grip (not the receiver) and near the trigger (not the stock). The grip is the longest run of heights where that stretch
   carries on from the one above; its centre line is fitted through the stretches' middles */
export function measure(vm, w) {
  const S = shapeOf(vm); if (!S) return null;
  const b = S.box, k = kindOf(w), cx = (b.min.x + b.max.x) / 2, rows = [];
  for (let y = -.012; y > b.min.y + .004; y -= .004) {
    const sp = spans(S, new THREE.Vector3(cx, y, b.max.z + .05), new THREE.Vector3(0, 0, -1)).map(([a, c]) => [b.max.z + .05 - a, b.max.z + .05 - c]);   // [back z, front z]
    const g = sp.filter(([zb, zf]) => zb - zf < (k === "pistol" ? .1 : .12) && zf < .16 && zb - zf > .012)[0];
    rows.push(g ? { y, zb: g[0], zf: g[1] } : null);
  }
  let run = [], cur = [];
  for (const r of rows) {
    if (r && (!cur.length || (r.zf < cur[cur.length - 1].zb && r.zb > cur[cur.length - 1].zf))) cur.push(r);
    else { if (cur.length > run.length) run = cur; cur = r ? [r] : []; }
  }
  if (cur.length > run.length) run = cur;
  if (run.length < 4) return null;
  // the top few rows meet the receiver and the trigger guard: the line is fitted on the rows below them
  const body = run.slice(Math.min(3, run.length - 3)), n = body.length, my = body.reduce((a, r) => a + r.y, 0) / n, mz = body.reduce((a, r) => a + (r.zb + r.zf) / 2, 0) / n;
  const slope = body.reduce((a, r) => a + (r.y - my) * ((r.zb + r.zf) / 2 - mz), 0) / (body.reduce((a, r) => a + (r.y - my) ** 2, 0) || 1);   // dz/dy
  const top = run[0].y, bot = run[run.length - 1].y, zAt = y => mz + slope * (y - my);
  const down = new THREE.Vector3(0, -1, -slope).normalize();
  const depth = body.map(r => (r.zb - r.zf) / 2).sort((a, c) => a - c)[n >> 1];
  const ymid = (top + bot) / 2, xs = spans(S, new THREE.Vector3(b.max.x + .05, ymid, zAt(ymid)), new THREE.Vector3(-1, 0, 0));
  const gx = xs.length ? b.max.x + .05 - (xs[0][0] + xs[xs.length - 1][1]) / 2 : cx, width = xs.length ? (xs[xs.length - 1][1] - xs[0][0]) / 2 : .015;
  const grip = { top: new THREE.Vector3(gx, top, zAt(top)), bot: new THREE.Vector3(gx, bot, zAt(bot)), down, depth, width };
  // the trigger: the first stretch ahead of the grip a little under its top (the blade); else just ahead of the grip
  let trig = null;
  for (let y = top - .006; y > top - .03 && !trig; y -= .003) {
    const sp = spans(S, new THREE.Vector3(gx, y, zAt(y) - depth - .004), new THREE.Vector3(0, 0, -1));
    if (sp.length && sp[0][0] < .05 && sp[0][1] - sp[0][0] < .025) trig = new THREE.Vector3(gx, y, zAt(y) - depth - .004 - sp[0][0]);
  }
  const out = { w, kind: k, grip, trigger: trig || new THREE.Vector3(gx, top - .012, zAt(top) - depth - .02) };
  // the handguard, where the support hand goes on a long gun: its underside from a ray up, its sides at that height
  if (k === "long") {
    const z = HOLDZ[w] ?? -(HOLD[w] ?? .3), up = spans(S, new THREE.Vector3(gx, b.min.y - .05, z), new THREE.Vector3(0, 1, 0));
    if (up.length) {
      const yb = b.min.y - .05 + up[0][0], side = spans(S, new THREE.Vector3(b.max.x + .05, yb + .012, z), new THREE.Vector3(-1, 0, 0));
      const x0 = side.length ? b.max.x + .05 - side[0][0] : gx + .02, x1 = side.length ? b.max.x + .05 - side[side.length - 1][1] : gx - .02, r = Math.max(.012, (x0 - x1) / 2);
      out.guard = { at: new THREE.Vector3((x0 + x1) / 2, yb + r, z), r };
    }
  }
  // the magazine: the lowest point under the gun between the grip and the handguard (a pistol's is in its grip); a reload's
  // hand takes it there. The charging handle (long guns, right side over the magazine) or the slide's back (pistols)
  if (k === "long") {
    let lo = null; const z1 = (HOLDZ[w] ?? -(HOLD[w] ?? .3)) + .06;
    for (let z = zAt(top) - depth - .02; z > z1; z -= .01) {
      const up = spans(S, new THREE.Vector3(gx, b.min.y - .05, z), new THREE.Vector3(0, 1, 0));
      if (up.length) { const y = b.min.y - .05 + up[0][0]; if (!lo || y < lo.y) lo = { y, z }; }
    }
    out.mag = lo && lo.y < top - .04 ? new THREE.Vector3(gx, (lo.y + top) / 2, lo.z + .02) : new THREE.Vector3(gx, top - .04, zAt(top) - depth - .09);   // none hanging under it: just ahead of the trigger
    // the AK family's charging handle rides the receiver's right side at half its height; the others' bolt release is
    // on the left side over the magazine well
    const half = top + (b.max.y - top) * .55;
    out.rack = AKBOLT.has(w) ? new THREE.Vector3(gx + .045, half, out.mag.z + .07) : new THREE.Vector3(gx - .035, half, out.mag.z + .04);
  } else if (k === "pistol") out.mag = grip.bot.clone();
  out.port = ejectPort(S, out, gx);
  MEASW[w] = out; delete THIRD[w];   // other players' hands use it too
  return out;
}
/* the ejection port, where the empty case leaves (2026-11-24; one spot for every pistol and one for every long gun before):
   on the right of the gun at the bore's height, over the front of the magazine well on a long gun (the chamber), over the
   trigger on a gun fed through its grip (pistols, the MP9), just under the top of a pistol's slide. The bore's height is
   the middle of the gun's front 2 cm (the muzzle); the right side is where a ray from the right meets the gun there */
const GRIPFED = new Set(["mp9", "mac10", "tec9", "mp7", "ump"]), PORTS = {};
export const portOf = w => PORTS[w] || null;
function ejectPort(S, m, gx) {
  const b = S.box, P = S.geom.attributes.position, g = m.grip;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < P.count; i++) if (P.getZ(i) < b.min.z + .02) { const y = P.getY(i); if (y < lo) lo = y; if (y > hi) hi = y; }
  let y = lo < hi ? (lo + hi) / 2 : g.top.y + .03, z;
  if (m.kind === "pistol" || GRIPFED.has(m.w)) z = m.trigger.z - .01;
  else z = m.mag ? Math.max(m.mag.z, g.top.z - .2) + .03 : m.trigger.z - .06;
  if (m.kind === "pistol") {   // just under the top of the slide over the trigger
    const d = spans(S, new THREE.Vector3(gx, b.max.y + .05, z), new THREE.Vector3(0, -1, 0));
    if (d.length) y = b.max.y + .05 - d[0][0] - .008;
  }
  for (let k = 0; k < 6; k++, y -= .004) {   // the right side there (a little lower where the ray misses)
    const sp = spans(S, new THREE.Vector3(b.max.x + .05, y, z), new THREE.Vector3(-1, 0, 0));
    if (sp.length) return (PORTS[m.w] = new THREE.Vector3(b.max.x + .05 - sp[0][0] + .004, y, z));
  }
  return (PORTS[m.w] = new THREE.Vector3(gx + .02, y, z));
}
// one-handed things: a knife's handle (the back part, along its length), a grenade's or the bomb's body
export function measureHeld(vm, w) {
  const S = shapeOf(vm); if (!S) return null;
  const b = S.box, k = kindOf(w), c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
  if (k === "knife") {
    // the handle: the back 40%; its centre line from the middle of its rays across, its half thickness
    const z = b.max.z - size.z * .2, ys = spans(S, new THREE.Vector3(c.x, b.max.y + .05, z), new THREE.Vector3(0, -1, 0)), xs = spans(S, new THREE.Vector3(b.max.x + .05, c.y, z), new THREE.Vector3(-1, 0, 0));
    const yc = ys.length ? b.max.y + .05 - (ys[0][0] + ys[ys.length - 1][1]) / 2 : c.y, xc = xs.length ? b.max.x + .05 - (xs[0][0] + xs[xs.length - 1][1]) / 2 : c.x;
    const ry = ys.length ? (ys[ys.length - 1][1] - ys[0][0]) / 2 : .012, rx = xs.length ? (xs[xs.length - 1][1] - xs[0][0]) / 2 : .01;
    return { w, kind: k, at: new THREE.Vector3(xc, yc, b.max.z - size.z * .22), along: new THREE.Vector3(0, 0, -1), ry, rx };
  }
  return { w, kind: k, at: c, r: Math.min(size.x, size.z) / 2, h: size.y };
}

/* ── how each hand holds it (gun frame): the wrist's place W, the fingers' direction F, the palm's facing P ──────────────
   A hand closes round a line across its knuckles: the right hand's runs up the grip, the support hand's along the
   handguard. HAND gives that line's place in the hand's own frame (metres at the hand's size): along the fingers from the
   wrist, and out from the palm by the palm's half thickness plus the part's own radius */
export const HAND = { thumb: [.6, 0], along: .08, alongL: .095, palm: .016, idx: .03, roll: 6 * Math.PI / 180, rollL: -6 * Math.PI / 180, yawL: 30 * Math.PI / 180,
  /* a pistol's support hand (hand metres, radians; hand lab 2026-11-24): half a finger lower than the shooting hand and
     out over its fingers (fwd, out), the palm turned back 30 degrees onto the grip's front left (flat on the left panel the
     wrist bent 35-52 back and 48-68 sideways: the forearm comes in from the left), the knuckle line 25 degrees nearer
     upright than the grip's (canted forward the wrist went past 50 toward the little finger), the thumb forward along
     the frame over the trigger guard */
  sup: { lower: .01, fwd: .012, out: .03, roll: 30 * Math.PI / 180, cant: -25 * Math.PI / 180, along: .95, thumb: [.15, -.6] } };
const frameOn = (line, dir, P, radial, along, out, k) => {
  const A = dir.clone().normalize(), Pn = P.clone().addScaledVector(A, -P.dot(A)).normalize(), F = new THREE.Vector3().crossVectors(Pn, A).multiplyScalar(radial).normalize();
  return { W: line.clone().addScaledVector(F, -along * k).addScaledVector(Pn, -out), F, P: Pn };
};
/* k: the hand's size in the gun frame (hand metres -> gun metres); radial: each rig hand's handedness (models.js) */
export function grips(m, k, radial, lowerL = 0) {
  if (!m) return null;
  const g = m.grip, up = g.down.clone().negate(), res = {};
  // right hand: the knuckle line up the grip, index finger at its top; the palm on the grip's back and right, facing
  // forward and left into it; the line sits a hand's span below the grip's top
  const fwd = new THREE.Vector3(0, 0, -1).addScaledVector(up, up.z).normalize(), left = new THREE.Vector3(-1, 0, 0);   // forward and left, square to the grip
  const P = left.clone().multiplyScalar(Math.cos(HAND.roll)).addScaledVector(fwd, Math.sin(HAND.roll));
  const ell = (a, rx, rz) => 1 / Math.sqrt((Math.cos(a) / rx) ** 2 + (Math.sin(a) / rz) ** 2);   // the grip's radius that way (an ellipse)
  // the grip line's point under the middle of the hand: the index knuckle just under the trigger's height
  const ty = m.trigger.y - HAND.idx * k, c = g.top.clone().addScaledVector(g.down, Math.max(0, (g.top.y - ty) / -g.down.y)), radP = ell(HAND.roll, g.width, g.depth);
  res.R = frameOn(c, up, P, radial.R, HAND.along, (HAND.palm * k + radP), k);
  if (m.kind === "long" && m.guard) {
    // support hand: under the handguard, palm up (a touch to the left, so the fingers rise round its right side), the knuckle line along it but turned
    // 30 degrees (index forward-left): a hand coming from the left cups a handguard on the slant, straight along it the
    // wrist would bend 60 degrees toward the little finger
    const G = m.guard, Pl = new THREE.Vector3(Math.sin(HAND.rollL), Math.cos(HAND.rollL), 0);
    res.L = frameOn(G.at, new THREE.Vector3(-Math.sin(HAND.yawL), 0, -Math.cos(HAND.yawL)), Pl, radial.L, HAND.alongL, HAND.palm * k + G.r, k);
  } else if (m.kind === "pistol") {
    // support hand, thumbs forward as a pistol is held two-handed: the palm over the grip's left side, the fingers round the
    // front of the shooting hand's (its index under the trigger guard), the thumb forward along the frame. It closes round
    // the grip and the shooting fingers together, so its knuckle line runs down the front strap below the shooting hand's
    // and out over its fingers (lowerL: further down, where a gun's trigger guard is in the way: gripFor)
    const s = HAND.sup, Ac = up.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), -s.cant);
    const Pl = new THREE.Vector3(1, 0, 0).multiplyScalar(Math.cos(s.roll)).addScaledVector(fwd, -Math.sin(s.roll));
    res.L = frameOn(c.clone().addScaledVector(g.down, (s.lower + lowerL) * k).addScaledVector(fwd, s.fwd * k), Ac, Pl, radial.L, HAND.along * s.along, HAND.palm * k + ell(s.roll, g.width, g.depth) + s.out * k, k);
  }
  return res;
}

/* one-handed things, in the right hand: a knife by its handle (the knuckle line along it), a grenade or the bomb by its
   body like a grip (knuckle line up it, palm on its right and back); their forearms come from a straight wrist */
export function heldGrip(h, k, radial) {
  if (!h) return null;
  if (h.kind === "knife") {
    // the palm under the handle and to its left, facing up and right into it, so the fingers come over it from the left
    // and the forearm rises from the bottom right with the wrist straight (palm-left, the forearm had to come down from above)
    const P = new THREE.Vector3(Math.cos(.87), Math.sin(.87), 0);
    return { R: frameOn(h.at, h.along, P, radial.R, HAND.along, HAND.palm * k + h.rx, k) };
  }
  const P = new THREE.Vector3(-Math.cos(.35), 0, -Math.sin(.35));
  return { R: frameOn(h.at.clone().add(new THREE.Vector3(0, -.01, 0)), new THREE.Vector3(0, 1, 0), P, radial.R, HAND.along, HAND.palm * k + h.r, k) };
}
/* the support hand's reload, by the gun's own parts (measured): [share of the reload time, where]. A long gun's hand goes to
   the magazine, takes it down out of sight, brings one up, seats it, works the bolt (an AK's charging handle reached
   under the gun on its right, the others' bolt release slapped on the left), goes back; a pistol's drops, brings a
   magazine up into the grip and pushes it home; a shotgun's thumbs a shell into the port.
   Each place: a hand frame on that part and how far the fingers close (a share of a full curl) */
// timed to the reload's sounds (client/audio.js RELOADS, shares of the reload): a rifle's magazine clicks out at .08 and in at
// .52 and its bolt at .82, so the hand is on the magazine just before each click and on the bolt at it; a pistol's out at
// .06 and in at .55
export const RELOAD = {
  long: [[0, "home"], [.06, "mag"], [.1, "mag"], [.24, "low"], [.38, "low"], [.5, "mag"], [.6, "mag"], [.78, "rack"], [.85, "rack"], [.95, "home"], [1, "home"]],
  pistol: [[0, "home"], [.05, "seat"], [.18, "drop"], [.4, "bring"], [.53, "seat"], [.68, "seat"], [1, "home"]],
  shell: [[0, "home"], [.35, "port"], [.6, "portIn"], [1, "home"]]
};
function places(m, k, radial) {
  const L = radial.L, out = {}, V = (...a) => new THREE.Vector3(...a);
  const on = (pt, A, P, curl, along = HAND.along, r = .02) => Object.assign(frameOn(pt, A, P, L, along, HAND.palm * k + r, k), { curl });
  const moved = (f, d, curl) => ({ W: f.W.clone().add(d), F: f.F, P: f.P, curl });
  if (m.mag) {
    out.mag = on(m.mag, V(0, 1, 0), V(1, 0, 0), .55, HAND.along * .9);   // the palm on the magazine's left side, fingers round its front
    out.low = moved(out.mag, V(-.08, -.34, .1), .55);
    out.drop = moved(out.mag, V(-.06, -.4, .1), .4); out.bring = moved(out.mag, V(-.04, -.2, .06), .5);
    out.seat = on(m.mag.clone().add(V(0, -.035, 0)), V(0, 0, -1), V(0, 1, 0), .3, HAND.along * .8);   // palm up under the grip, pushing it home
  }
  if (m.rack) out.rack = AKBOLT.has(m.w) ? on(m.rack, V(0, 0, -1), V(-1, 0, 0), .5, HAND.along * .9, .015)   // under the gun to the handle on its right
                                          : on(m.rack, V(0, 1, 0), V(1, 0, 0), .15, HAND.along * .75, .02);  // flat palm on the left of the receiver
  const port = m.mag ? m.mag.clone().add(V(0, .03, .02)) : m.grip.top.clone().add(V(0, -.03, -.12));
  out.port = on(port, V(0, 0, -1), V(0, 1, 0), .45, HAND.along * .9); out.portIn = moved(out.port, V(0, .015, -.02), .5);
  return out;
}

/* ── fingers that close on the gun ──────────────────────────────────────────────────────────────────────────────────────
   A hand wraps a bar with all three joints of a finger closing together, the middle one most (closing one joint fully
   before the next left claws: a straight middle joint and a hooked tip). So each finger curls whole, in proportion,
   until it meets the gun (its skin a finger's radius round the bone); then its two outer joints keep closing until they
   meet it too; then the tip. The thumb's base is set across the palm, then its two joints close the same way. Done once
   per gun and hand, at the hand's rest place on the gun; the trigger finger sets its base and closes its tip on the trigger */
const SYN = [1.25, 1.6, 1.05], TSYN = [.9, 1.15], RAD = [.0088, .0094, .009, .0078], TRAD = .0105;
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _hit = {}, _gi = new THREE.Matrix4(), _ab = new THREE.Vector3(), _ps = new THREE.Vector3();
const segDist = (p, a, b) => { _ab.subVectors(b, a); const t = THREE.MathUtils.clamp(_ps.subVectors(p, a).dot(_ab) / (_ab.lengthSq() || 1), 0, 1); return _ps.copy(a).addScaledVector(_ab, t).distanceTo(p); };
function touches(S, chain, from, r, avoid) {
  // any point along the bones from..end within r of the gun's surface
  for (let j = from; j < chain.length; j++) {
    const b = chain[j], nx = chain[j + 1]; b.getWorldPosition(_p);
    if (nx) nx.getWorldPosition(_q); else _q.set(0, b.position.length() * .92, 0).applyMatrix4(b.matrixWorld);   // the tip: as long as the bone before it
    for (let s = j === from ? .3 : 0; s <= 1.0001; s += .233) {
      const pt = _p.clone().lerp(_q, s).applyMatrix4(_gi), c = S.bvh.closestPointToPoint(pt, _hit);
      if (c && c.distance < r) return true;
      if (avoid) for (const k of avoid) if (segDist(pt, k.a, k.b) < r + k.r) return true;   // the other hand's fingers
    }
  }
  return false;
}
/* a hand's fingers and thumb as capsules in the gun's frame, as they are posed now: the other hand closes round them */
export function fingerCaps(arms, k, vm) {
  const S = arms.side[k], sc = arms.root.getWorldScale(new THREE.Vector3()).x, gs = vm.getWorldScale(new THREE.Vector3()).x, inv = vm.matrixWorld.clone().invert(), out = [];
  const chains = S.fingers.map((ch, i) => [ch, RAD[i]]); if (S.thumb[0]) chains.push([S.thumb, TRAD]);
  for (const [ch, r] of chains) ch.forEach((b, j) => {
    const a = b.getWorldPosition(new THREE.Vector3()), e = ch[j + 1] ? ch[j + 1].getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, b.position.length() * .92, 0).applyMatrix4(b.matrixWorld);
    out.push({ a: a.applyMatrix4(inv), b: e.applyMatrix4(inv), r: r * sc / gs });
  });
  return out;
}
export function closeFingers(arms, k, vm, opts = {}) {
  const S = shapeOf(vm); if (!S) return null;
  const side = arms.side[k], rest = arms.rest, sc = arms.root.getWorldScale(new THREE.Vector3()).x, gs = vm.getWorldScale(new THREE.Vector3()).x;
  vm.updateMatrixWorld(true); _gi.copy(vm.matrixWorld).invert();
  const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1), q = new THREE.Quaternion();
  const set = (b, a, a2 = 0) => { b.quaternion.copy(rest.get(b)[1]).multiply(q.setFromAxisAngle(X, a)); if (a2) b.quaternion.multiply(q.setFromAxisAngle(Z, a2)); b.updateMatrixWorld(true); };
  // the largest t in [0, 1] for which apply(t) leaves bones from.. clear of the gun (a coarse sweep, then halving)
  const sweep = (apply, chain, from, r) => {
    let a = 0, hi = 1; apply(0); if (touches(S, chain, from, r, opts.avoid)) return 0;
    for (let t = .05; t <= 1.0001; t += .05) { apply(t); if (touches(S, chain, from, r, opts.avoid)) { hi = t; break; } a = t; if (t > .99) { hi = 1; a = 1; } }
    for (let it = 0; it < 5 && hi - a > .004; it++) { const m = (a + hi) / 2; apply(m); if (touches(S, chain, from, r, opts.avoid)) hi = m; else a = m; }
    apply(a); return a;
  };
  const wrap = (chain, r, syn, base = null) => {
    const ang = [0, 0, 0].slice(0, chain.length), lim = syn.map(x => x * 1.15);
    const put = () => chain.forEach((b, j) => set(b, ang[j]));
    const from = base == null ? 0 : 1;
    if (base != null) ang[0] = base;
    const c1 = sweep(t => { for (let j = from; j < chain.length; j++) ang[j] = t * syn[j]; put(); }, chain, from, r);
    const a1 = ang.slice();
    if (chain.length - from > 1) sweep(t => { for (let j = from + 1; j < chain.length; j++) ang[j] = Math.min(lim[j], a1[j] + t * syn[j]); put(); }, chain, from + 1, r);
    const a2 = ang.slice(), last = chain.length - 1;
    if (last > from + 1) sweep(t => { ang[last] = Math.min(lim[last], a2[last] + t * syn[last]); put(); }, chain, last, r);
    return ang.map(x => +x.toFixed(3));
  };
  const out = { fingers: [], thumb: null };
  side.fingers.forEach((ch, i) => {
    if (opts.only && !opts.only.includes(i)) return out.fingers.push([0, 0, 0]);   // a quick test of some fingers alone
    const r = RAD[i] * sc / gs;
    out.fingers.push(opts.trigger != null && i === 0 ? wrap(ch, r, SYN, opts.trigger) : wrap(ch, r, SYN));
  });
  if (side.thumb[0] && !opts.only) {
    const [b1, b2, b3] = side.thumb, t0 = opts.thumbBase || HAND.thumb;
    set(b1, t0[0], t0[1]);
    const ang = wrap([b2, b3], TRAD * sc / gs, TSYN);
    out.thumb = [t0[0], t0[1], ang[0], ang[1]];
  }
  return out;
}

/* ── the arms behind the hands ─────────────────────────────────────────────────────────────────────────────────────────
   Each arm's shoulder is worked back from its hand: the forearm leaves the wrist along that grip's natural line (FORE),
   which puts the elbow; from there the upper arm runs down, back and out of sight under the view (viewmodels hide it so:
   the gun is drawn small and far out, real shoulders could not reach it). Every grip, rifle, pistol or knife, so gets a
   natural wrist and forearm by construction; the solve in models.js picks the elbow round that and spreads the twist */
export const ANCHOR = { down: { R: [.35, -.85, .4], L: [-.35, -.85, .4] } };
/* the forearm's line into each grip (gun frame, elbow to wrist): the shooting hand's from behind, nearly level, a little
   outside; the support hand's up from below and outside, its wrist cocked back under the handguard (so the forearm rises
   from the bottom of the view as in CS, not across it); a pistol's support hand from below and outside */
export const FORE = { R: [-.2, .05, -.98], Llong: [.45, .6, -.6], Lpistol: [.45, .45, -.77] };
let CAM = null;
const camQ = () => CAM ? CAM.getWorldQuaternion(_cq) : _cq.identity(), _cq = new THREE.Quaternion();
const D2R = Math.PI / 180;
function anchor(arms, k, T, fore) {
  const S = arms.side[k], sc = arms.root.getWorldScale(new THREE.Vector3()).x, A = new THREE.Vector3().crossVectors(T.F, T.P).multiplyScalar(S.radial);
  const a = fore ? fore.clone().normalize() : T.F.clone().addScaledVector(T.P, Math.tan(WRIST.ext[0] * D2R)).addScaledVector(A, Math.tan(WRIST.uln[0] * D2R)).normalize();
  T.ext0 = Math.atan2(a.dot(T.P), a.dot(T.F)) / D2R; T.uln0 = Math.atan2(a.dot(A), a.dot(T.F)) / D2R;   // the solve keeps this wrist
  const E = T.at.clone().addScaledVector(a, -S.lb * sc), down = new THREE.Vector3(...ANCHOR.down[k]).normalize().applyQuaternion(camQ());
  T.shoulder = E.clone().addScaledVector(down, S.la * sc); T.pole = E.clone().sub(T.shoulder.clone().lerp(T.at, .5)).normalize();
  return T;
}
const foreOf = (vm, c, k) => { if (c.kind !== "long" && c.kind !== "pistol") return null; const f = k === "R" ? FORE.R : c.kind === "pistol" ? FORE.Lpistol : FORE.Llong; return new THREE.Vector3(...f).transformDirection(vm.matrixWorld); };

/* ── every frame ────────────────────────────────────────────────────────────────────────────────────────────────────────
   The rest grip (measured, turned, fingers closed) is worked out once per gun view and arms, then carried on the gun:
   recoil, sway, the draw and the inspect move the gun and the hands go with it */
let CACHE = new WeakMap();
export const resetGrips = () => { CACHE = new WeakMap(); for (const k in THIRD) delete THIRD[k]; };   // after a change to HAND or the arms (tests, tools)
/* other players' hands (models.js setGrips): their wrists' places on the gun in their hands, from the same measured grip and
   handguard. The fighters' hands have no fingers to close and turning them tore their skin, so each wrist keeps the spot the
   old fixed places gave on the AK and the Glock, now taken from the gun's own grip (and handguard) instead of its origin
   (gun frame metres: a long gun's right wrist above and behind its grip's middle, its left on the handguard's underside; a
   pistol's two wrists by its grip) */
const MEASW = {}, THIRD = {}, TP = { R: [.017, .057, -.01], L: [.017, -.03, .019], RP: [0, .035, -.03], LP: [-.029, .026, -.021] };
export const thirdGrips = w => { if (THIRD[w] !== undefined) return THIRD[w]; const m = MEASW[w]; if (!m) return null;
  if (!m.grip) return (THIRD[w] = null);
  const g = m.grip, ty = m.trigger.y - HAND.idx, c = g.top.clone().addScaledVector(g.down, Math.max(0, (g.top.y - ty) / -g.down.y)), V = a => new THREE.Vector3(...a), P = m.kind === "pistol";
  return (THIRD[w] = { R: c.clone().add(V(P ? TP.RP : TP.R)), L: P ? c.clone().add(V(TP.LP)) : m.guard ? m.guard.at.clone().add(V(TP.L)) : null }); };
const _c = new THREE.Quaternion();
const toWorld = (vm, f) => ({ at: vm.localToWorld(f.W.clone()), F: f.F.clone().transformDirection(vm.matrixWorld), P: f.P.clone().transformDirection(vm.matrixWorld) });
const curlOf = (lvl, t = 1) => ({ fingers: [0, 1, 2, 3].map(() => SYN.map(x => x * lvl * t)), thumb: [.25, -.55, .4 * lvl, .6 * lvl] });
export function gripFor(arms, w, vm) {
  let per = CACHE.get(vm); if (!per) CACHE.set(vm, per = new WeakMap());
  let c = per.get(arms); if (c) return c;
  scaleArms(arms, kindOf(w)); vm.updateMatrixWorld(true);
  const k = arms.root.getWorldScale(new THREE.Vector3()).x / vm.getWorldScale(new THREE.Vector3()).x, radial = { R: arms.side.R.radial, L: arms.side.L.radial };
  const kind = kindOf(w), m = kind === "long" || kind === "pistol" ? measure(vm, w) : measureHeld(vm, w);
  c = { m, kind, fr: null, fingers: {}, places: m && m.grip ? places(m, k, radial) : {} };
  // close the fingers with the hands at their rest grip. A pistol's support hand closes round the shooting hand's fingers as
  // well as the grip, its thumb forward along the frame; where its index starts inside the trigger guard (it would stay
  // straight: a finger that touches before it bends does not bend) it goes down 3 mm at a time, up to 1.5 cm (the USP)
  let caps = null;
  for (let low = 0; ; low += .003) {
    const fr = c.fr = kind === "long" || kind === "pistol" ? grips(m, k, radial, low) : heldGrip(m, k, radial);
    if (!fr) break;
    const r = fr.R ? anchor(arms, "R", toWorld(vm, fr.R), foreOf(vm, c, "R")) : null, l = fr.L ? anchor(arms, "L", toWorld(vm, fr.L), foreOf(vm, c, "L")) : null;
    if (r && c.fingers.R) Object.assign(r, c.fingers.R);   // a retry: the shooting hand as it closed the first time
    arms.pose(r, l);
    if (fr.R && !c.fingers.R) c.fingers.R = closeFingers(arms, "R", vm, kind === "long" || kind === "pistol" ? { trigger: .3 } : {});
    if (!fr.L) break;
    if (kind !== "pistol") { c.fingers.L = closeFingers(arms, "L", vm); break; }
    caps = caps || fingerCaps(arms, "R", vm); c.lowL = low;
    // the support index alone first (cheap); the whole hand once, where that finger closes
    if (closeFingers(arms, "L", vm, { avoid: caps, only: [0] }).fingers[0][0] > .05 || low > .0149) { c.fingers.L = closeFingers(arms, "L", vm, { avoid: caps, thumbBase: HAND.sup.thumb }); break; }
  }
  per.set(arms, c); return c;
}
const HANG = { at: [-.32, -.78, -.22], F: [0, -1, -.2], P: [1, 0, 0] };   // a free left hand, out of sight below the view
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _m = new THREE.Matrix4();
const qOf = (f, q) => q.setFromRotationMatrix(_m.makeBasis(f.F, f.P, new THREE.Vector3().crossVectors(f.F, f.P)));
/* st: { drawK (1 at the draw's start), rp (a magazine reload's progress 0..1), sp (a shell's progress 0..1) } */
export function poseHands(arms, w, vm, camera, st = {}) {
  CAM = camera; vm.updateMatrixWorld(true);
  const c = gripFor(arms, w, vm), drawK = st.drawK || 0; scaleArms(arms, c.kind);
  if (!c.fr || !c.fr.R) return null;
  const relax = (f, t) => f && { fingers: f.fingers.map(a => a.map(x => x * (1 - t))), thumb: f.thumb && f.thumb.map((x, i) => i < 2 ? x : x * (1 - t)) };
  const R = Object.assign(anchor(arms, "R", toWorld(vm, c.fr.R), foreOf(vm, c, "R")), relax(c.fingers.R, drawK * .5));
  let L = null;
  if (c.fr.L) {
    let f = c.fr.L, fingers = relax(c.fingers.L, drawK * .8);
    const keys = st.sp != null ? RELOAD.shell : st.rp != null ? RELOAD[c.kind] : null, p = st.sp ?? st.rp;
    if (keys) {
      let i = 0; while (i < keys.length - 1 && keys[i + 1][0] <= p) i++;
      const A = keys[i], B = keys[Math.min(i + 1, keys.length - 1)], t = B[0] > A[0] ? THREE.MathUtils.smoothstep(p, A[0], B[0]) : 1;
      const get = K => K[1] === "home" ? Object.assign({}, c.fr.L, { curl: null }) : c.places[K[1]] || Object.assign({}, c.fr.L, { curl: null });
      const fa = get(A), fb = get(B), q = qOf(fa, _qa).slerp(qOf(fb, _qb), t), basis = new THREE.Matrix4().makeRotationFromQuaternion(q);
      f = { W: fa.W.clone().lerp(fb.W, t), F: new THREE.Vector3().setFromMatrixColumn(basis, 0), P: new THREE.Vector3().setFromMatrixColumn(basis, 1) };
      const ca = fa.curl == null ? c.fingers.L : curlOf(fa.curl), cb = fb.curl == null ? c.fingers.L : curlOf(fb.curl);
      fingers = { fingers: ca.fingers.map((a, j) => a.map((x, n) => x + (cb.fingers[j][n] - x) * t)), thumb: ca.thumb.map((x, n) => x + (cb.thumb[n] - x) * t) };
    }
    L = Object.assign(anchor(arms, "L", toWorld(vm, f), foreOf(vm, c, "L")), fingers);
  } else {
    const q = camera.getWorldQuaternion(_c);
    L = Object.assign(anchor(arms, "L", { at: camera.localToWorld(new THREE.Vector3(...HANG.at)), F: new THREE.Vector3(...HANG.F).normalize().applyQuaternion(q), P: new THREE.Vector3(...HANG.P).applyQuaternion(q) }), curlOf(.3));
  }
  return arms.pose(R, L);
}
/* the arms on the camera: the rig faces -Z as the camera does (each shoulder is then placed from its hand, above). Their
   scale against the gun's (.62) by what is held: rifles are drawn about 1.3 x real (the AK's grip is 7 cm deep) and take
   the hand at 1.16 x the gun; pistols are drawn near real size, where that hand swallowed the grip, so 1.03 x. It changes
   with the draw, while the gun comes up from below the view */
export const MOUNT = { scale: { long: .72, pistol: .64, knife: .66, nade: .66, c4: .7 }, shoulders: [0, -.17, .07] };
export function mountArms(arms, camera) {
  const r = arms.root; r.position.set(0, 0, 0); r.quaternion.identity(); r.scale.setScalar(1); r.updateMatrixWorld(true);
  const inv = r.matrixWorld.clone().invert(); arms.mid = arms.side.R.up.getWorldPosition(new THREE.Vector3()).add(arms.side.L.up.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5).applyMatrix4(inv);
  camera.add(r); scaleArms(arms, "long");
}
function scaleArms(arms, kind) {
  const sc = MOUNT.scale[kind] || MOUNT.scale.long, r = arms.root; if (r.scale.x === sc) return;
  r.scale.setScalar(sc); r.position.set(...MOUNT.shoulders).addScaledVector(arms.mid, -sc); r.updateMatrixWorld(true);
}
