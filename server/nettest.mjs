/* Hit registration test, no browser: a Runner strafing at full speed and a Shooter that does what game.js does -
   buffers snapshots, draws (here: computes) the Runner 100 ms in the past, aims at that, fires one shot every
   350 ms, and tags the shot with its view time. Counts the server's confirmed hits. */
import WebSocket from "ws";
const URL = process.argv[2] || "ws://127.0.0.1:8956/ws", SECONDS = +(process.argv[3] || 40), INTERP = +(process.env.INTERP || .045), DT = 1 / 64;   // the page draws the others about 45 ms late since 2026-11-23 (was 100)
const sleep = ms => new Promise(r => setTimeout(r, ms));
function client(name) {
  const c = { name, ws: new WebSocket(URL + "?name=" + name), id: 0, seq: 0, off: null, ests: [], interp: INTERP, snaps: [], hits: 0, me: null, onSnap: null };
  c.ws.on("message", raw => { const m = JSON.parse(raw);
    if (m.t === "w") { c.id = m.id; c.off = m.tm - performance.now() / 1000; }
    if (m.t === "s") { /* the page's clock and delay (game.js onSnap): the least-delayed update of the last two seconds sets the clock, the spread sets the delay */
      const est = m.tm - performance.now() / 1000; c.ests.push(est); if (c.ests.length > 128) c.ests.shift(); const hi = Math.max(...c.ests), lo = Math.min(...c.ests);
      c.off = c.off == null || Math.abs(hi - c.off) > .3 ? hi : c.off + Math.max(-.002, Math.min(.002, hi - c.off)); c.interp = process.env.INTERP ? INTERP : Math.max(.035, Math.min(.25, 2 / 64 + (hi - lo) + .004)); if (m.me) c.me = m.me; c.snaps.push(m); if (c.snaps.length > 120) c.snaps.shift();
      for (const e of m.ev) if (e.k === "hit" && e.by === c.id) c.hits++; } });
  c.view = () => performance.now() / 1000 + c.off - c.interp;
  c.send = cmds => c.ws.readyState === 1 && c.ws.send(JSON.stringify({ t: "c", c: cmds }));
  return c;
}
const shooter = client("Shooter"); await sleep(400); const runner = client("Runner");
await new Promise(r => runner.ws.on("open", r)); await sleep(2600);   // past spawn protection
let shots = 0, lastShot = 0, yaw = 0, pitch = 0, t0 = performance.now();
const lat = [];
/* one tick per DT of real time, as game.js paces its commands (2026-11-16): a bare setInterval(15.625) runs a little
   fast in Node, the server queues what is ahead of real time, and every shot then arrived later than the one before -
   the rewind grew 33 ms a second until it passed REWIND_MAX and shots missed for a reason no player has */
let ticks = 0, done = false;
const timer = setInterval(() => { while (!done && ticks * DT * 1000 <= performance.now() - t0) { ticks++; tick(); } }, 4);
function tick() {
  const t = (performance.now() - t0) / 1000;
  // the runner: left and right, 1.1 s each way, never stopping
  // face the shooter so a strafe crosses the line of fire
  let ryaw = 0; if (runner.me && shooter.me) { const dx = shooter.me.p[0] - runner.me.p[0], dz = shooter.me.p[2] - runner.me.p[2]; ryaw = Math.atan2(-dx, -dz); }
  runner.send([{ seq: ++runner.seq, f: 0, s: Math.floor(t / .8) % 2 ? 1 : -1, yaw: ryaw, pitch: 0 }]);   // .8 s each way: about 4 m, inside the cleared lane
  // the shooter: the runner where a client would draw it, interpolated between the two snapshots around view time
  /* BACKTRACK=1 (test only, 2026-11-23): a modified page that claims, on its shots alone, a view 0.3 s older than its
     other commands, and aims where the runner was then. The server holds a shot to the player's usual lag, so these miss */
  const bt = process.env.BACKTRACK === "1" && t - lastShot > .35 ? .3 : 0, vt = shooter.view() - bt, S = shooter.snaps; let pos = null;
  for (let i = S.length - 1; i > 0; i--) if (S[i - 1].tm <= vt) { const a = S[i - 1].e.find(e => e[0] === runner.id), b = S[i].e.find(e => e[0] === runner.id);
    if (a && b) { const k = Math.min(1, (vt - S[i - 1].tm) / (S[i].tm - S[i - 1].tm)), ex = Math.min(Math.max(0, vt - S[i].tm), .25); pos = [a[3] + (b[3] - a[3]) * k + b[10] * ex, a[4] + (b[4] - a[4]) * k, a[5] + (b[5] - a[5]) * k + b[11] * ex];   /* a late update: carried on by its speed, as the page draws it */ if (shooter.me) { const lx = b[3] - shooter.me.p[0], lz = b[5] - shooter.me.p[2], L = Math.hypot(lx, lz) || 1; lat.push(Math.abs(b[10] * (-lz / L) + b[11] * (lx / L))); } } break; }
  let fire = false;
  if (pos && shooter.me && shooter.me.al) {
    const ex = shooter.me.p[0], ey = shooter.me.p[1] + 64 * .0254, ez = shooter.me.p[2], dx = pos[0] - ex, dy = pos[1] + 1.2 - ey, dz = pos[2] - ez;
    yaw = Math.atan2(-dx, -dz); pitch = Math.atan2(dy, Math.hypot(dx, dz));
    if (t - lastShot > .35 && shooter.me.m > 0 && !shooter.me.ra) { fire = true; lastShot = t; shots++; }
  }
  shooter.send([{ seq: ++shooter.seq, f: 0, s: 0, yaw, pitch, fire, reload: shooter.me && shooter.me.m === 0, vt: +vt.toFixed(4) }]);
  if (t > SECONDS) { done = true; clearInterval(timer); setTimeout(() => { console.log(JSON.stringify({ shots, hits: shooter.hits, hitRate: Math.round(100 * shooter.hits / Math.max(1, shots)) + "%",
    runnerSpeedAcrossLineOfFire: (lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length)).toFixed(1) + " m/s" })); process.exit(0); }, 600); }
}
