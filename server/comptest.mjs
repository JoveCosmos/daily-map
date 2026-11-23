/* Competitive test, no browser: creates a Competitive room with bots, buys on round one, then only watches (the bots
   play it out). Reports rounds and how they ended, money, buys, bomb plants, defuses and explosions, and halftime.
   Run against a test server with short timers, e.g.
   FREEZE=3 ROUND_TIME=45 BOMB_TIME=15 HALF=3 TO_WIN=4 node server.js, then node comptest.mjs ws://127.0.0.1:8956/ws */
import WebSocket from "ws";
const URL = process.argv[2] || "ws://127.0.0.1:8956/ws", SECS = +(process.argv[3] || 150), sleep = ms => new Promise(r => setTimeout(r, ms));
const ws = new WebSocket(URL + "?name=Tester&create=1&mode=comp&bpt=3");
const seen = { round: 0, buy: 0, plantStart: 0, planted: 0, defuseStart: 0, defused: 0, bombDrop: 0, bombPick: 0, half: 0, match: 0 }, ends = [], money = [];
let me = null, gm = null, sites = null, bought = false, seq = 0;
ws.on("message", raw => { const m = JSON.parse(raw);
  if (m.t === "w") sites = m.sites;
  if (m.t !== "s") return; if (m.me) me = m.me; if (m.gm) gm = m.gm;   // your own state and the match come every other update
  for (const e of m.ev) { if (e.k in seen) seen[e.k]++; if (e.k === "roundEnd") ends.push(["Atlas", "Ember"][e.w] + ":" + e.why); if (e.k === "boom" && e.n === 2) seen.exploded = (seen.exploded || 0) + 1; }
  if (m.me && me.mo != null) money.push(me.mo); });
await new Promise(r => ws.on("open", r)); await sleep(1500);
// round one: try the buy menu the way the page does (a pistol upgrade and armour fit $800)
for (const it of ["vest", "deagle", "he"]) ws.send(JSON.stringify({ t: "b", i: it }));
await sleep(SECS * 1000);
console.log(JSON.stringify({ sites, events: seen, roundEnds: ends, moneyRange: [Math.min(...money), Math.max(...money)], score: gm && gm.sc, phase: gm && gm.ph, round: gm && gm.rn }));
process.exit(0);
