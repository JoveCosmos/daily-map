// botcheck.mjs <id> [seconds 180] [game dir ..]: a bot-only Competitive match on map <id>, five bots a side, watched by a
// player who never spawns (GHOST=1), on a throwaway server from <game dir> on a spare port (2026-11-23, after the
// Counter-Strike audit: bots now walk and shoot with the players' own movement and guns, and a map can trap them).
// Reports rounds and how they ended, plants, defuses, kills and hits by side, and how often bots had to glide past a
// spot they could not walk (server.js botTick). Prints one JSON line and one line per warning; exit 1 when no round
// finishes, the server fails, or bots spend more of their time gliding than walking would allow.
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
const [,, id, secsArg = "180", dirArg] = process.argv, secs = +secsArg;
if (!/^[a-z0-9-]{2,24}$/.test(id || "")) { console.log("usage: node botcheck.mjs <map id> [seconds] [game dir]"); process.exit(2); }
const dir = path.resolve(dirArg || path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const WebSocket = createRequire(path.join(dir, "server", "server.js"))("ws");
const port = 9500 + Math.floor(Math.random() * 400), state = fs.mkdtempSync(path.join(os.tmpdir(), "botcheck-"));
const srv = spawn("node", ["server.js"], { cwd: path.join(dir, "server"), detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), ROTATION: id, GHOST: "1", FREEZE: "3", DEBUG_BOTS: "1", STATE_DIRECTORY: state, MAP_SKIP: "0" } });
let log = ""; srv.stdout.on("data", d => { log += d; }); srv.stderr.on("data", d => { log += d; });
const done = code => { try { process.kill(-srv.pid, "SIGKILL"); } catch (e) {} try { fs.rmSync(state, { recursive: true, force: true }); } catch (e) {} process.exit(code); };
setTimeout(() => { console.log("botcheck: timed out"); done(1); }, (secs + 120) * 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let k = 0; k < 120 && !/listening on/.test(log); k++) { await sleep(500); if (srv.exitCode != null) break; }
if (!/listening on/.test(log)) { console.log("botcheck: the server did not start\n" + log.slice(-800)); done(1); }
const st = { shots: [0, 0], hits: [0, 0], kills: [0, 0], wins: [0, 0], why: {}, rounds: 0, planted: 0, defused: 0 }, team = new Map();
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?name=watcher&create=1&mode=comp&bpt=5&team=ct`); let seq = 0;
ws.on("message", raw => { const m = JSON.parse(raw.toString());
  if (m.t === "r") for (const r of m.r) team.set(r[0], r[2]);
  if (m.t !== "s") return;
  for (const e of m.ev) {
    if (e.k === "shot" && team.has(e.id)) st.shots[team.get(e.id)]++;
    if (e.k === "hit" && team.has(e.by) && e.by !== e.id) st.hits[team.get(e.by)]++;
    if (e.k === "kill" && team.has(e.by) && e.by !== e.id) st.kills[team.get(e.by)]++;
    if (e.k === "roundEnd") { st.rounds++; if (e.w >= 0) st.wins[e.w]++; const k = (["Atlas", "Ember"][e.w] || "draw") + " " + (e.why || ""); st.why[k] = (st.why[k] || 0) + 1; }
    if (e.k === "planted") st.planted++; if (e.k === "defused") st.defused++; } });
ws.on("error", () => {});
const tick = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "c", c: [{ seq: ++seq, f: 0, s: 0, yaw: 0, pitch: 0, vt: 0 }] })), 50);
await sleep(secs * 1000); clearInterval(tick);
// the bots' own tally (server.js BOTSTAT, every 30 s): the last line of the watched room
const tally = (log.match(/\[[A-Z0-9]{4}\] bots (\{.*\})/g) || []).filter(l => !/\[(WARM|DAILY)\]/.test(l)).map(l => JSON.parse(l.slice(l.indexOf("{")))).pop() || {};
const minutes = Math.max(.5, (secs - 25) / 60), glidesPerBotMin = +((tally.glide || 0) / 10 / minutes).toFixed(2), acc = t => +(100 * st.hits[t] / Math.max(1, st.shots[t])).toFixed(0);
const out = { id, seconds: secs, rounds: st.rounds, wins: { Atlas: st.wins[0], Ember: st.wins[1] }, ends: st.why, planted: st.planted, defused: st.defused,
  kills: { Atlas: st.kills[0], Ember: st.kills[1] }, accuracy: { Atlas: acc(0), Ember: acc(1) }, glides: tally.glide || 0, glidesPerBotMin, jumps: (tally.jumpUp || 0) + (tally.jumpStuck || 0), asides: tally.aside || 0,
  errors: (log.match(/uncaught:.*/g) || []).slice(0, 3) };
const problems = [], warnings = [];
if (!st.rounds) problems.push("no round finished: the bots cannot play this map");
if (out.errors.length) problems.push("the server reported errors: " + out.errors[0]);
if (glidesPerBotMin > 1.5) problems.push(`bots glide past spots they cannot walk ${glidesPerBotMin} times a minute each`);
else if (glidesPerBotMin > .5) warnings.push(`bots glide past spots they cannot walk ${glidesPerBotMin} times a minute each (server log with DEBUG_BOTS=2 lists where)`);
if (st.rounds >= 6 && Math.min(...st.wins) / st.rounds < .2) warnings.push(`one side won ${Math.min(...st.wins)} of ${st.rounds} rounds (bot matches near 50/50 are the aim; a longer run settles it)`);
if (st.rounds >= 4 && !st.planted) warnings.push("no bomb was planted: the attackers' bots never reached a site");
if (Math.max(...st.shots) < 50) warnings.push("the bots hardly fought (fewer than 50 shots a side)");
out.ok = !problems.length; out.problems = problems; out.warnings = warnings;
console.log(JSON.stringify(out)); for (const x of warnings) console.log("warning: " + x);
done(out.ok ? 0 : 1);
