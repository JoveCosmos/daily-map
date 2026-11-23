// menu background for a map: preview.html rendered in headless Chrome against the running game server
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
let [id, out, base] = process.argv.slice(2);
// the running game server: given, or whichever blue/green copy answers (8945 was retired 2026-11-01; previews came out blank)
if (!base) for (const p of [8946, 8947]) { try { if ((await fetch(`http://127.0.0.1:${p}/rooms`)).ok) { base = `http://127.0.0.1:${p}`; break; } } catch (e) {} }
if (!base) { console.error("preview: no game server on 8946 or 8947"); process.exit(1); }
const PORT = 9300 + Math.floor(Math.random() * 90), dir = fs.mkdtempSync(path.join(os.tmpdir(), "addmap-"));
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--remote-debugging-port=" + PORT, "--user-data-dir=" + dir, "about:blank"], { stdio: "ignore", detached: true });
const done = code => { try { process.kill(-chrome.pid, "SIGKILL"); } catch (e) {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} process.exit(code); };
setTimeout(() => { console.error("preview: timed out"); done(1); }, 120000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let t; for (let k = 0; k < 80 && !t; k++) { await sleep(150); try { t = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.type === "page"); } catch (e) {} }
if (!t) { console.error("preview: no browser"); done(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl); let n = 0; const pend = {};
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${base}/preview.html?map=${id}` });
for (let k = 0; k < 200; k++) { await sleep(500); const r = await send("Runtime.evaluate", { expression: "!!window.done", returnByValue: true }); if (r.result.result.value) break; }
await sleep(500); const s = await send("Page.captureScreenshot", { format: "jpeg", quality: 72 });
fs.writeFileSync(out, Buffer.from(s.result.data, "base64")); done(0);
