/* Hit registration test, no browser: a Runner strafing at full speed and a Shooter that does what game.js does -
   buffers snapshots, draws (here: computes) the Runner 100 ms in the past, aims at that, fires one shot every
   350 ms, and tags the shot with its view time. Counts the server's confirmed hits. */
import WebSocket from "ws";
const URL = process.argv[2] || "ws://127.0.0.1:8956/ws", SECONDS = +(process.argv[3] || 40), INTERP = .1, DT = 1 / 64;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(name) {
  const c = { name, ws: new WebSocket(URL + "?name=" + name), id: 0, seq: 0, off: null, snaps: [], hits: 0, me: null, onSnap: null };
  c.ws.on("message", raw => { const m = JSON.parse(raw);
    if (m.t === "w") { c.id = m.id; c.off = m.tm - performance.now() / 1000; }
    if (m.t === "s") { const est = m.tm - performance.now() / 1000; c.off = c.off == null || Math.abs(est - c.off) > .5 ? est : c.off * .9 + est * .1; c.me = m.me; c.snaps.push(m); if (c.snaps.length > 60) c.snaps.shift();
      for (const e of m.ev) if (e.k === "hit" && e.by === c.id) c.hits++; } });
  c.view = () => performance.now() / 1000 + c.off - INTERP;
  c.send = cmds => c.ws.readyState === 1 && c.ws.send(JSON.stringify({ t: "c", c: cmds }));
  return c;
}
const shooter = client("Shooter"); await sleep(400); const runner = client("Runner");
await new Promise(r => runner.ws.on("open", r)); await sleep(2600);   // past spawn protection
let shots = 0, lastShot = 0, yaw = 0, pitch = 0, t0 = performance.now();
const lat = [];
const timer = setInterval(() => {
  const t = (performance.now() - t0) / 1000;
  // the runner: left and right, 1.1 s each way, never stopping
  // face the shooter so a strafe crosses the line of fire
  let ryaw = 0; if (runner.me && shooter.me) { const dx = shooter.me.p[0] - runner.me.p[0], dz = shooter.me.p[2] - runner.me.p[2]; ryaw = Math.atan2(-dx, -dz); }
  runner.send([{ seq: ++runner.seq, f: 0, s: Math.floor(t / .8) % 2 ? 1 : -1, yaw: ryaw, pitch: 0 }]);   // .8 s each way: about 4 m, inside the cleared lane
  // the shooter: the runner where a client would draw it, interpolated between the two snapshots around view time
  const vt = shooter.view(), S = shooter.snaps; let pos = null;
  for (let i = S.length - 1; i > 0; i--) if (S[i - 1].tm <= vt) { const a = S[i - 1].e.find(e => e[0] === runner.id), b = S[i].e.find(e => e[0] === runner.id);
    if (a && b) { const k = Math.min(1, (vt - S[i - 1].tm) / (S[i].tm - S[i - 1].tm)); pos = [a[3] + (b[3] - a[3]) * k, a[4] + (b[4] - a[4]) * k, a[5] + (b[5] - a[5]) * k]; if (shooter.me) { const lx = b[3] - shooter.me.p[0], lz = b[5] - shooter.me.p[2], L = Math.hypot(lx, lz) || 1; lat.push(Math.abs(b[10] * (-lz / L) + b[11] * (lx / L))); } } break; }
  let fire = false;
  if (pos && shooter.me && shooter.me.al) {
    const ex = shooter.me.p[0], ey = shooter.me.p[1] + 64 * .0254, ez = shooter.me.p[2], dx = pos[0] - ex, dy = pos[1] + 1.2 - ey, dz = pos[2] - ez;
    yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(dy, Math.hypot(dx, dz));
    if (t - lastShot > .35 && shooter.me.m > 0 && !shooter.me.ra) { fire = true; lastShot = t; shots++; }
  }
  shooter.send([{ seq: ++shooter.seq, f: 0, s: 0, yaw, pitch, fire, reload: shooter.me && shooter.me.m === 0, vt: +vt.toFixed(4) }]);
  if (t > SECONDS) { clearInterval(timer); setTimeout(() => { console.log(JSON.stringify({ shots, hits: shooter.hits, hitRate: Math.round(100 * shooter.hits / Math.max(1, shots)) + "%",
    runnerSpeedAcrossLineOfFire: (lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length)).toFixed(1) + " m/s" })); process.exit(0); }, 600); }
}, DT * 1000);
