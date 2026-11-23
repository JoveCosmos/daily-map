// perfgate.mjs <dir>: the phone performance gate run by deploy.sh (2026-11-22, after the full Hunyuan 3D set hung the
// operator's phone at 150 MB of graphics memory). Starts the server from <dir> on a spare port with 5 bots a side,
// opens one autoplay phone client in headless Chrome (software GL), counts what the GPU is given, and fails over budget.
//   PERF_TEX_MB, PERF_TRIS, PERF_DRAWS override the budgets (exit 0 = within budget, 1 = over, 2 = could not measure).
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const dir = path.resolve(process.argv[2] || ".");
const BUDGET = { texMB: +(process.env.PERF_TEX_MB || 40), tris: +(process.env.PERF_TRIS || 650000), draws: +(process.env.PERF_DRAWS || 450) };
const base = 9400 + Math.floor(Math.random() * 400), SPORT = base, CPORT = base + 1;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "perfgate-"));
const srv = spawn("node", ["server.js"], { cwd: path.join(dir, "server"), env: { ...process.env, PORT: String(SPORT), PER_TEAM: "5", STATE_DIRECTORY: prof }, stdio: "ignore", detached: true });
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--remote-debugging-port=" + CPORT, "--user-data-dir=" + prof, "about:blank"], { stdio: "ignore", detached: true });
const done = code => { for (const p of [chrome, srv]) try { process.kill(-p.pid, "SIGKILL"); } catch (e) {} try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {} process.exit(code); };
setTimeout(() => { console.log("perfgate: timed out"); done(2); }, 150000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let t; for (let k = 0; k < 80 && !t; k++) { await sleep(150); try { t = (await (await fetch(`http://127.0.0.1:${CPORT}/json/list`)).json()).find(x => x.type === "page"); } catch (e) {} }
if (!t) { console.log("perfgate: chrome did not start"); done(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl); let n = 0; const pend = {}, errs = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } if (d.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300)); };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 420, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const B = window.__B = { draws: 0, tris: 0, tex: 0, frames: 0 };
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) { const p = C.prototype;
    const de = p.drawElements; p.drawElements = function (m, c) { B.draws++; B.tris += c / 3; return de.apply(this, arguments); };
    const dei = p.drawElementsInstanced; if (dei) p.drawElementsInstanced = function (m, c, ty, o, i) { B.draws++; B.tris += c / 3 * i; return dei.apply(this, arguments); };
    const da = p.drawArrays; p.drawArrays = function (m, f, c) { B.draws++; B.tris += c / 3; return da.apply(this, arguments); };
    const ti = p.texImage2D; p.texImage2D = function () { const a = arguments; let w = 0, h = 0; if (a.length >= 8) { w = a[3]; h = a[4]; } else { const s = a[5]; w = s && (s.width || s.videoWidth) || 0; h = s && (s.height || s.videoHeight) || 0; } if (a[1] === 0) B.tex += w * h * 4; return ti.apply(this, arguments); };
    const ts = p.texStorage2D; if (ts) p.texStorage2D = function (tg, lv, f, w, h) { B.tex += w * h * 4; return ts.apply(this, arguments); }; }
  const raf = window.requestAnimationFrame; window.requestAnimationFrame = f => raf(t => { B.frames++; f(t); }); })();` });
await send("Page.navigate", { url: `http://127.0.0.1:${SPORT}/?autoplay&touch&team=ct` });
await sleep(55000);
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true })).result.result.value;
await ev("(()=>{const B=__B;B.s={d:B.draws,t:B.tris,f:B.frames}})()"); await sleep(20000);
const r = await ev("(()=>{const B=__B,s=B.s,f=Math.max(1,B.frames-s.f);return {frames:f,draws:Math.round((B.draws-s.d)/f),tris:Math.round((B.tris-s.t)/f),texMB:Math.round(B.tex/1e6),others:window.__g?window.__g.others.size:0}})()");
if (!r || r.frames < 20 || r.others < 3) { console.log("perfgate: no game to measure", JSON.stringify(r), errs[0] || ""); done(2); }
const over = Object.keys(BUDGET).filter(k => r[k] > BUDGET[k]);
console.log(`perfgate phone: graphics ${r.texMB}/${BUDGET.texMB} MB, ${r.tris}/${BUDGET.tris} tris, ${r.draws}/${BUDGET.draws} draws a frame, ${r.others} others${errs.length ? ", " + errs.length + " page errors" : ""}`);
if (errs.length) { console.log("perfgate: page error", errs[0]); done(1); }
done(over.length ? 1 : 0);
