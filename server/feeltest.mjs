/* Gun feel test, no server: runs sim.js directly on the stand-in map and checks spray spread, tagging, damage
   falloff, the stomach zone, wallbangs, and that a client replaying from the server's state lands where the server
   does (prediction stays exact with the new state). Prints one line per check and exits 1 on any failure. */
import * as THREE from "three";
import { World, standinParts, newPlayer, move, weapon, inaccuracy, hitBox, damageFor, penetrate, copyPlayer, armour, equip, throwFrom, nadeStep, NADES, WEAPONS, DT, DEG, U, C } from "../sim.js";

let fails = 0;
const check = (name, ok, info) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  (" + info + ")" : ""}`); if (!ok) fails++; };
const W = new World(Object.values(standinParts()).flat());
const cmd = (o = {}) => ({ f: 0, s: 0, jump: false, duck: false, walk: false, fire: false, reload: false, yaw: 0, pitch: 0, seq: 0, ...o });
const grounded = () => { const s = newPlayer(); s.pos.set(5, 0, 15); for (let i = 0; i < 64; i++) move(W, s, cmd()); return s; };

// spray spread: grows while spraying, gone again after a short pause
{ const s = grounded(); let t = 0; const base = inaccuracy(s) / DEG, seen = [];
  for (let i = 0; i < 64; i++) { t += DT; const sh = weapon(s, cmd({ fire: true }), t, i); if (sh) seen.push(inaccuracy(s) / DEG); }
  const sprayed = inaccuracy(s) / DEG;
  for (let i = 0; i < 32; i++) { t += DT; weapon(s, cmd(), t, 0); }
  const rested = inaccuracy(s) / DEG;
  check("AK spray spread grows", sprayed > base + 1.5, `standing ${base.toFixed(2)} deg, after ${seen.length} shots ${sprayed.toFixed(2)} deg`);
  check("AK spread recovers after 0.5 s", rested < base + .1, `${rested.toFixed(2)} deg`); }

// each rifle its own pattern
{ const k = id => WEAPONS[id].spray.slice(8, 16).map(p => Math.sign(Math.round(p[0] * 10))).join("");
  check("M4 and AUG patterns differ from the AK", k("m4") !== k("ak") && k("aug") !== k("ak"), `AK ${k("ak")}, M4 ${k("m4")}, AUG ${k("aug")}`); }

// tagging: a hit slows a running player, and it wears off
{ const s = grounded(); for (let i = 0; i < 128; i++) move(W, s, cmd({ f: 1 }));
  const full = Math.hypot(s.vel.x, s.vel.z); s.tag = WEAPONS.ak.tag; s.vel.x *= 1 - s.tag; s.vel.z *= 1 - s.tag;
  for (let i = 0; i < 16; i++) move(W, s, cmd({ f: 1 }));
  const tagged = Math.hypot(s.vel.x, s.vel.z);
  for (let i = 0; i < 96; i++) move(W, s, cmd({ f: 1 }));
  const after = Math.hypot(s.vel.x, s.vel.z);
  check("tagging slows a runner", tagged < full * .75, `${(full / U).toFixed(0)} -> ${(tagged / U).toFixed(0)} u/s after 0.25 s`);
  check("tagging wears off", after > full * .97 && s.tag === 0, `${(after / U).toFixed(0)} u/s after 1.75 s`); }

// damage falloff and the stomach
{ const ak = WEAPONS.ak;
  check("AK body falls off with distance", damageFor(ak, "body", 40) < damageFor(ak, "body", 5), `${damageFor(ak, "body", 5).toFixed(1)} at 5 m, ${damageFor(ak, "body", 40).toFixed(1)} at 40 m`);
  check("AK head still one-taps at 30 m", damageFor(ak, "head", 30) >= 100, damageFor(ak, "head", 30).toFixed(1));
  const p = new THREE.Vector3(0, 0, 0), o = new THREE.Vector3(0, 1.03, 5), d = new THREE.Vector3(0, 0, -1);
  const h = hitBox(p, 0, o, d), c = hitBox(p, 0, new THREE.Vector3(0, 1.3, 5), d);
  check("stomach and chest are separate zones", h && h.part === "stomach" && c && c.part === "body", `${h && h.part} at 1.03 m, ${c && c.part} at 1.30 m`);
  check("stomach hurts a quarter more", Math.abs(damageFor(ak, "stomach", 0) - damageFor(ak, "body", 0) * 1.25) < 1e-9); }

// wallbangs on the stand-in: the 0.4 m railing (x 18, z -7.3, 2.2 to 3.3 m up) and the 1.2 m centre wall
{ const shoot = (o, d, pen) => { const wh = W.first(o, d, 300); return wh ? penetrate(W, o, d, wh.distance, pen, 300) : null; };
  const rail = [new THREE.Vector3(18, 2.75, -2), new THREE.Vector3(0, 0, -1)], mid = [new THREE.Vector3(-6, 2, -4), new THREE.Vector3(1, 0, 0)];
  const awp = shoot(...rail, WEAPONS.awp.pen), ak = shoot(...rail, WEAPONS.ak.pen), thick = shoot(...mid, WEAPONS.awp.pen);
  check("AWP passes the 0.4 m railing", !!awp, awp && `wall ${awp.th.toFixed(2)} m, damage x${awp.pm.toFixed(2)}`);
  check("AK is stopped by the 0.4 m railing", !ak);
  check("nothing passes the 1.2 m wall", !thick); }

// prediction: the server tags the player mid-run; a client that reconciles from the server's state and replays its
// unacknowledged commands must end exactly where the server does
{ const srv = grounded(), cl = newPlayer(); copyPlayer(cl, srv); const cmds = [];
  for (let i = 0; i < 40; i++) cmds.push(cmd({ f: 1, s: i % 20 < 10 ? 1 : -1, fire: i % 3 === 0, seq: i + 1 }));
  let t = 0; const snap = newPlayer();
  cmds.forEach((c, i) => { t += DT; move(W, srv, c); weapon(srv, c, t, i);
    if (i === 12) { srv.tag = .55; srv.vel.x *= .45; srv.vel.z *= .45; }             // the server's hit, unknown to the client
    if (i === 20) copyPlayer(snap, srv); });                                          // the snapshot that acks command 21
  copyPlayer(cl, snap); let tc = 21 * DT;
  for (const c of cmds.slice(21)) { tc += DT; move(W, cl, c); weapon(cl, c, tc, 0); }   // the client's replay
  const err = cl.pos.distanceTo(srv.pos) * 100;
  check("prediction after a tag replays exactly", err < .01 && Math.abs(cl.tag - srv.tag) < 1e-9 && Math.abs(cl.acc - srv.acc) < 1e-9, `${err.toFixed(3)} cm`); }


// CS armour, against CS:GO's own numbers (point blank): AK chest 36 -> 27 through armour, AK head 144 -> 111 with a
// helmet, still 144 without one; legs ignore armour; AWP chest 115 -> 112; armour loses half of what it stopped
{ const ar = (w, part, helmet, armor = 100) => { const s = newPlayer(); s.armor = armor; s.helmet = helmet; return [armour(s, WEAPONS[w], part, damageFor(WEAPONS[w], part, 0)), s.armor]; };
  const [b, a] = ar("ak", "body", true), [h] = ar("ak", "head", true), [hn] = ar("ak", "head", false), [l] = ar("ak", "leg", true), [awp] = ar("awp", "body", true), [m4h] = ar("m4", "head", true), [none] = ar("ak", "body", false, 0);
  check("AK chest through armour = 27, armour 100 -> 96", b === 27 && a === 96, `${b}, armour ${a}`);
  check("AK head with helmet = 111", h === 111, String(h));
  check("AK head without helmet = 144", hn === 144, String(hn));
  check("legs ignore armour (AK 27)", l === 27, String(l));
  check("AWP chest through armour = 112", awp === 112, String(awp));
  check("M4 head with helmet = 92", m4h === 92, String(m4h));
  check("AK chest, no armour = 36", none === 36, String(none));
  const [lo] = ar("ak", "body", true, 2);
  check("thin armour runs out, the rest hits health", lo === 32, `${lo} with 2 armour left`); }

// a pistol is one shot a click; slots keep their own ammunition
{ const s = grounded(); equip(s, "glock"); equip(s, "ak"); let t = 1, shots = 0;
  const run = (c, n) => { for (let i = 0; i < n; i++) { t += DT; if (weapon(s, cmd(c), t, i)) shots++; } };
  run({ slot: "s" }, 1); run({}, 50);                                     // draw the pistol, let it come up
  check("2 draws the pistol", s.w === "glock" && s.mag === 20, `${s.w} ${s.mag}`);
  run({ fire: true }, 64); const held1 = shots; shots = 0; run({}, 2);    // let go before clicking
  for (let k = 0; k < 5; k++) { run({ fire: true }, 2); run({}, 12); }
  check("holding fire on a pistol shoots once", held1 === 1, `${held1} in 1 s held`);
  check("clicking shoots every click", shots === 5, `${shots} of 5 clicks`);
  run({ slot: "p" }, 1); check("the rifle came back with its own 30", s.w === "ak" && s.mag === 30, `${s.w} ${s.mag}`);
  run({ slot: "s" }, 1); check("the pistol kept its 14", s.w === "glock" && s.mag === 14, `${s.mag}`); }

// the shotgun: nine pellets a shot, one shell a reload step, and it can fire between shells
{ const s = grounded(); equip(s, "nova"); let t = 1, last = null;
  for (let i = 0; i < 64; i++) { t += DT; const r = weapon(s, cmd(), t, i); }
  t += DT; last = weapon(s, cmd({ fire: true }), t, 7);
  check("Nova fires 9 pellets", last && last.dirs && last.dirs.length === 9, last && last.dirs ? String(last.dirs.length) : "none");
  s.mag = 3; for (let i = 0; i < 64; i++) { t += DT; weapon(s, cmd(), t, 0); }
  t += DT; weapon(s, cmd({ reload: true }), t, 0); for (let i = 0; i < 70; i++) { t += DT; weapon(s, cmd(), t, 0); }
  check("Nova reloads one shell at a time", s.mag === 5, `${s.mag} after 1.1 s`); }

// grenades: 4 takes one out, left click cocks it, release throws; it bounces and settles; back to the last weapon
{ const s = grounded(); equip(s, "glock"); equip(s, "ak"); s.last = "glock"; for (const n of NADES) s.nades[n] = 1; let t = 1, thrown = null;
  const run = (c, n) => { for (let i = 0; i < n; i++) { t += DT; const r = weapon(s, cmd(c), t, i); if (r && r.nade) thrown = r; } };
  run({ slot: "g" }, 1); run({}, 40); const out = s.w;
  run({ fire: true }, 10); run({}, 1);
  check("4 takes the HE out, release throws it", out === "he" && thrown && thrown.nade === "he" && thrown.str === 1, `${out}, threw ${thrown && thrown.nade}`);
  check("after the throw: none left, back to the gun held before", s.nades.he === 0 && s.w === "ak", `${s.nades.he} left, holding ${s.w}`);
  const g = { ...throwFrom(W, s, 1), rest: false }; let bounces = 0;
  for (let i = 0; i < 64 * 8 && !g.rest; i++) if (nadeStep(W, g)) bounces++;
  check("a thrown grenade bounces and comes to rest", g.rest && bounces >= 1, `${bounces} bounces, rests at ${g.p.x.toFixed(1)}, ${g.p.y.toFixed(2)}, ${g.p.z.toFixed(1)}`); }

// movement: CS's landing slowdown, the price of chained jumps, and the crouch-jump's extra height
{ const run = (s, c, n) => { for (let i = 0; i < n; i++) move(W, s, cmd(c)); };
  const sp = s => Math.hypot(s.vel.x, s.vel.z) / U;
  const a = grounded(); run(a, { f: 1 }, 96); const full = sp(a);
  run(a, { f: 1, jump: true }, 1); let air = 0; while (!a.onGround && air < 200) { run(a, { f: 1 }, 1); air++; }
  run(a, { f: 1 }, 1); const landed = sp(a); run(a, { f: 1 }, 64); const back = sp(a);
  check("a landing slows you", landed < full * .75, `${full.toFixed(0)} -> ${landed.toFixed(0)} u/s on landing`);
  check("and it wears off within a second", back > full * .97, `${back.toFixed(0)} u/s 1 s later`);
  const b = grounded(); run(b, { f: 1 }, 96); const speeds = [];
  for (let j = 0; j < 4; j++) { run(b, { f: 1, jump: true }, 1); let k = 0; while (!b.onGround && k < 200) { run(b, { f: 1 }, 1); k++; } run(b, { f: 1 }, 1); speeds.push(Math.round(sp(b))); }
  check("jumps that touch the ground cost more each time", speeds[3] < speeds[0], speeds.join(" -> ") + " u/s after each landing");
  const h = grounded(); run(h, { f: 1 }, 96); const hops = [];
  for (let j = 0; j < 4; j++) { run(h, { f: 1, jump: true }, 1); let k = 0; while (!h.onGround && k < 200) { run(h, { f: 1 }, 1); k++; } hops.push(Math.round(sp(h))); }
  check("a jump on the landing tick keeps the speed (bunny hop)", hops[3] > full * .9, hops.join(" -> ") + " u/s");
  const peak = duck => { const s = grounded(); const y0 = s.pos.y; let top = y0; run(s, { jump: true }, 1);
    for (let i = 0; i < 200 && !(s.onGround && i > 5); i++) { run(s, { duck: duck && i > 10 }, 1); top = Math.max(top, s.pos.y); } return top - y0; };
  const plain = peak(false), cj = peak(true);
  check("a crouch-jump lifts the feet higher", cj > plain + .35, `${plain.toFixed(2)} m plain, ${cj.toFixed(2)} m crouch-jumping`); }

// the rest of the arsenal: every gun has CS's damage and armour ratio; the Zeus kills within reach and is spent;
// the Glock's burst fires three; the M4A1-S out-damages the M4A4 per hit as in CS
{ const missing = Object.entries(WEAPONS).filter(([id, w]) => !w.nade && !w.c4 && !w.melee && (typeof w.dmg !== "number" || !w.ap)).map(([id]) => id);
  check("every gun has damage and an armour ratio", !missing.length, missing.join(",") || `${Object.keys(WEAPONS).length} weapons`);
  const s = grounded(); s.zeus = true; equip(s, "glock"); let t = 1;
  for (let i = 0; i < 2; i++) { t += DT; weapon(s, cmd({ slot: "k" }), t, 0); for (let k = 0; k < 64; k++) { t += DT; weapon(s, cmd(), t, 0); } }
  const held = s.w; t += DT; const z = weapon(s, cmd({ fire: true }), t, 1);
  check("3 twice brings out the Zeus; it fires once and is gone", held === "zeus" && z && z.w === "zeus" && !s.zeus && s.w !== "zeus", `${held}, fired ${z && z.w}, holding ${s.w}`);
  check("the Zeus reaches 4.65 m and kills through armour", WEAPONS.zeus.reach === 4.65 && damageFor(WEAPONS.zeus, "body", 3) >= 500);
  const b = grounded(); equip(b, "glock"); let tb = 1, shots = 0; for (let k = 0; k < 64; k++) { tb += DT; weapon(b, cmd(), tb, 0); }
  tb += DT; weapon(b, cmd({ zoom: true }), tb, 0); tb += DT; weapon(b, cmd(), tb, 0);
  for (let k = 0; k < 30; k++) { tb += DT; if (weapon(b, cmd({ fire: k < 2 }), tb, k)) shots++; }
  check("right click puts the Glock in burst: one click, three shots", b.burstOn && shots === 3, `${shots} shots from one click`);
  check("M4A1-S hits harder than M4A4 (38 vs 33)", WEAPONS.m4a1s.dmg === 38 && WEAPONS.m4.dmg === 33 && WEAPONS.m4.name === "M4A4"); }

// arms: a shot across in front of a player facing it hits an arm (normal damage, armour covers it); from behind, none
{ const p = new THREE.Vector3(0, 0, 0), yaw = 0;   // facing -z
  const side = hitBox(p, 0, new THREE.Vector3(-5, 1.3, -.35), new THREE.Vector3(1, 0, 0), yaw);
  check("a shot across the front hits an arm", side && side.part === "arm", side ? side.part : "nothing");
  const behind = hitBox(p, 0, new THREE.Vector3(-5, 1.3, .6), new THREE.Vector3(1, 0, 0), yaw);
  check("the same line behind the back misses", !behind || behind.part !== "arm", behind ? behind.part : "nothing");
  const s = newPlayer(); s.armor = 100; s.helmet = true;
  check("an AK arm hit through armour = 27, as the chest", armour(s, WEAPONS.ak, "arm", damageFor(WEAPONS.ak, "arm", 0)) === 27); }

console.log(fails ? `${fails} FAILED` : "all passed"); process.exit(fails ? 1 : 0);
