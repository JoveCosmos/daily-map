/* the radar: the map's walkable ground, teammates, spotted enemies, the sites and the bomb (split out of game.js 2026-11-22) */
import { $, nowS } from "./core.js";
import { NADE } from "../sim.js";
import { SITES_C, bombObj } from "./comp.js";
import { connected, SPEC, others, me, FX, PINGS, GM, myTeam, SPOTTED, DECOYDOTS } from "../game.js";
/* ── the radar (2026-11-14): the map's walkable ground from the server, turned so forward is up; teammates always,
   enemies while you or a teammate can see them (CS's rule), smokes and fires ──────────────────────────────────── */
let RMAP = null;
const RPPM = 3.2;   // radar pixels a metre, before the canvas's own 2x
function radarMap(r) {
  const pts = r.pts.map(([x, z]) => [x / 10, z / 10]); if (!pts.length) { RMAP = null; return; }
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const pad = 2, c = document.createElement("canvas"); c.width = Math.ceil((x1 - x0 + 2 * pad) * RPPM * 2); c.height = Math.ceil((z1 - z0 + 2 * pad) * RPPM * 2);
  const g = c.getContext("2d"), cs = r.cell * RPPM * 2 * 1.15; g.fillStyle = "rgba(205,214,206,.34)";
  for (const [x, z] of pts) g.fillRect((x - x0 + pad) * RPPM * 2 - cs / 2, (z - z0 + pad) * RPPM * 2 - cs / 2, cs, cs);
  RMAP = { c, x0: x0 - pad, z0: z0 - pad };
}
function drawRadar() {
  const cv = $("radar"); if (!cv) return; const g = cv.getContext("2d"), W2 = cv.width, H2 = cv.height, k = RPPM * 2;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W2, H2);
  if (!RMAP || !connected) return;
  const sp0 = SPEC.id && others.get(SPEC.id), y = sp0 ? sp0.vy || 0 : me.yaw, cy = Math.cos(y), sy = Math.sin(y), mx = sp0 ? sp0.model.g.position.x : me.pos.x, mz = sp0 ? sp0.model.g.position.z : me.pos.z;
  const at = (x, z) => { const dx = (x - mx) * k, dz = (z - mz) * k; return [W2 / 2 + dx * cy - dz * sy, H2 / 2 + dx * sy + dz * cy]; };
  g.save(); g.translate(W2 / 2, H2 / 2); g.transform(cy, sy, -sy, cy, 0, 0); g.translate(-(mx - RMAP.x0) * k, -(mz - RMAP.z0) * k); g.drawImage(RMAP.c, 0, 0); g.restore();
  const dot = (x, z, col, r = 7) => { const [a, b] = at(x, z); g.beginPath(); g.arc(a, b, r, 0, Math.PI * 2); g.fillStyle = col; g.fill(); };
  for (const c of FX.sm.values()) dot(c.g.position.x, c.g.position.z, "rgba(190,190,186,.55)", NADE.smokeR * k);
  for (const f of FX.fi.values()) dot(f.g.position.x, f.g.position.z, "rgba(255,120,30,.5)", NADE.fireR * k);
  for (const [name, x, y, z] of SITES_C) { const [a, b] = at(x, z); g.font = "700 30px ui-sans-serif,system-ui"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "rgba(255,176,46,.95)"; g.fillText(name, a, b); }
  for (const q of PINGS) dot(q.x, q.z, "#ffb02e", 6);
  if (GM && GM.bp) dot(GM.bp[0], GM.bp[2], nowS() % 1 < .5 ? "#ff5a4a" : "#7a1f17", 9);
  else if (bombObj.visible) dot(bombObj.position.x, bombObj.position.z, "#ffb02e", 8);
  const shown = new Set();
  for (const [id, o] of others) { if (!o.alive || o.gone) continue; const p = o.model.g.position;
    if (o.team === myTeam) dot(p.x, p.z, o.id === SPEC.id ? "#ffffff" : "#5aa2ff"); else if (o.vis && me.alive) { dot(p.x, p.z, "#ff5a4a"); shown.add(id); } }
  for (const [id, x, z] of SPOTTED) if (!shown.has(id)) dot(x, z, "#ff5a4a");
  for (const [, x, z] of DECOYDOTS) dot(x, z, "#ff5a4a");   // an enemy decoy looks like an enemy, as in CS
  g.beginPath(); g.moveTo(W2 / 2, H2 / 2 - 11); g.lineTo(W2 / 2 + 8, H2 / 2 + 8); g.lineTo(W2 / 2, H2 / 2 + 4); g.lineTo(W2 / 2 - 8, H2 / 2 + 8); g.closePath(); g.fillStyle = me.alive ? "#ffffff" : "rgba(255,255,255,.35)"; g.fill();
}

export { RMAP, RPPM, radarMap, drawRadar };
