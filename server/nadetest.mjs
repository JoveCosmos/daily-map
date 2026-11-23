/* Grenade test, no browser: a client joins, then takes out and throws each of its four grenades in turn (4, hold
   left click, let go), aiming ahead and slightly down. Counts the server's grenade events and the snapshot's live
   grenades, smokes and fires. Run against a test server: node nadetest.mjs ws://127.0.0.1:8956/ws */
import WebSocket from "ws";
const URL = process.argv[2] || "ws://127.0.0.1:8956/ws", sleep = ms => new Promise(r => setTimeout(r, ms));
const ws = new WebSocket(URL + "?name=Thrower"); let id = 0, seq = 0, me = null, yaw = 0;
const seen = { throw: 0, bounce: 0, boom: 0, flashed: 0, smoke: 0, fire: 0, fizzle: 0, hit: 0 }, live = { ng: 0, sm: 0, fi: 0 }, kinds = new Set();
ws.on("message", raw => { const m = JSON.parse(raw);
  if (m.t === "w") id = m.id;
  if (m.t !== "s") return; if (m.me) me = m.me;   // your own state comes every other update
  if (me.p) yaw = Math.atan2(me.p[0], me.p[2]);   // face the middle of the map, so every throw stays inside it
  for (const e of m.ev) { if (e.k in seen) seen[e.k]++; if (e.k === "throw") kinds.add(e.n); if (e.k === "boom") kinds.add("boom" + e.n); }
  live.ng = Math.max(live.ng, (m.ng || []).length); live.sm = Math.max(live.sm, (m.sm || []).length); live.fi = Math.max(live.fi, (m.fi || []).length); });
await new Promise(r => ws.on("open", r)); await sleep(3000);
const send = c => ws.readyState === 1 && ws.send(JSON.stringify({ t: "c", c: [{ seq: ++seq, f: 0, s: 0, jump: false, duck: false, walk: false, fire: false, reload: false, yaw, pitch: -.15, vt: 0, slot: null, zoom: false, use: false, ...c }] }));
const ticks = async (c, n) => { for (let i = 0; i < n; i++) { send(c); await sleep(1000 / 64); } };
const before = me && me.nd ? me.nd.slice() : null;
for (let k = 0; k < 4; k++) { await ticks({ slot: "g" }, 1); await ticks({}, 40); await ticks({ fire: true }, 10); await ticks({}, 20); }
await sleep(12000);
console.log(JSON.stringify({ grenadesAtStart: before, grenadesLeft: me && me.nd, armour: me && me.ar, events: seen, thrownKinds: [...kinds].sort(), mostLive: live }));
process.exit(0);
