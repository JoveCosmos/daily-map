// handlab.mjs [game dir] [out dir] [guns,..]: the first-person hands checked gun by gun (2026-11-24, after the arms rebuild;
// the gun checklist's "screenshots of hands, reload, draw"). Serves <game dir> with the lab page (tools/handlab/) on a
// spare port, opens it in headless Chrome (software GL) and for each gun poses the arms as the game does: six views at rest
// (the eye, from the right, below, the hands close up from the eye, the shooting hand's fingers and thumb, the support
// hand) and an eye-view strip of the draw, the reload and the inspect. Writes <out>/<gun>.jpg and <gun>-moves.jpg, prints
// each gun's wrist numbers (degrees: ext +back/-forward, uln +little-finger side, twist, the shoulder's slide in mm).
// Exit 1 when a page error shows or a rest grip bends a wrist past a body's range (ext -60..65, uln -18..32); 2 when it
// could not measure. Defaults: the live game, /tmp/handlab, the drawn guns.
import { spawn, execFileSync } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
const here = path.dirname(new URL(import.meta.url).pathname);
const dir = path.resolve(process.argv[2] || path.join(here, "..")), out = path.resolve(process.argv[3] || "/tmp/handlab");
const GUNS = (process.argv[4] || "ak,m4,awp,mp9,glock,usp,deagle,knife,he,c4").split(",");
fs.mkdirSync(out, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".glb": "model/gltf-binary", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p.includes("..")) { res.writeHead(400); return res.end(); }
  let f = null;
  if (p.startsWith("/handlab/")) { const rest = p.slice(9) || "index.html"; f = /^(index\.html|lab\.js)$/.test(rest) ? path.join(here, "handlab", rest) : path.join(dir, rest); }
  else f = path.join(dir, p);
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); res.end(b); });
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const HPORT = srv.address().port, CPORT = 9800 + Math.floor(Math.random() * 150), prof = fs.mkdtempSync(path.join(os.tmpdir(), "handlab-"));
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--remote-debugging-port=" + CPORT, "--user-data-dir=" + prof, "about:blank"], { stdio: "ignore", detached: true });
const done = code => { try { process.kill(-chrome.pid, "SIGKILL"); } catch (e) {} srv.close(); try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {} process.exit(code); };
setTimeout(() => { console.log("handlab: timed out"); done(2); }, 30000 + GUNS.length * 40000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let t; for (let k = 0; k < 80 && !t; k++) { await sleep(150); try { t = (await (await fetch(`http://127.0.0.1:${CPORT}/json/list`)).json()).find(x => x.type === "page"); } catch (e) {} }
if (!t) { console.log("handlab: chrome did not start"); done(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl); let n = 0; const pend = {}, errs = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } if (d.method === "Runtime.exceptionThrown") errs.push(JSON.stringify(d.params.exceptionDetails).slice(0, 400)); };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result?.value;
await send("Page.enable"); await send("Runtime.enable");
async function open(q, w, h) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${HPORT}/handlab/index.html${q}` });
  for (let k = 0; k < 120; k++) { await sleep(500); if (await ev("!!(window.__lab && window.__lab.ready)")) return true; }
  return false;
}
const shot = async f => { const s = await send("Page.captureScreenshot", { format: "jpeg", quality: 88 }); fs.writeFileSync(f, Buffer.from(s.result.data, "base64")); };
const teamOf = w => ["m4", "usp", "awp", "mp9"].includes(w) ? 0 : 1, bad = [], rows = [];
if (!await open("", 1920, 720)) { console.log("handlab: the page did not load", errs.join(" | ")); done(2); }
for (const w of GUNS) {
  const r = await ev(`window.__lab.go(${JSON.stringify(w)}, ${teamOf(w)}, {})`); await sleep(150);
  await shot(path.join(out, w + ".jpg")); rows.push(r);
  for (const k of ["R", "L"]) if (r && r[k] && (r[k].ext < -60 || r[k].ext > 65 || r[k].uln < -18 || r[k].uln > 32)) bad.push(`${w} ${k} wrist ${r[k].ext}/${r[k].uln}`);
  console.log(JSON.stringify(r));
}
// the moves, eye view: draw half way, reload at five points (or a shell), the inspect; tiled into one strip per gun
const MOVES = [["draw", { drawK: .5 }], ["r.14", { rp: .14 }], ["r.3", { rp: .3 }], ["r.62", { rp: .62 }], ["r.82", { rp: .82 }], ["r.9", { rp: .9 }], ["inspect", { inspect: .9 }]];
if (await open("?eye", 1280, 720)) {
  const ff = (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch (e) { return false; } })();
  for (const w of GUNS) {
    const files = [];
    for (const [name, st] of MOVES) { await ev(`window.__lab.go(${JSON.stringify(w)}, ${teamOf(w)}, ${JSON.stringify(st)})`); await sleep(100); const f = path.join(out, `.${w}-${name}.jpg`); await shot(f); files.push([name, f]); }
    if (ff) { const args = ["-loglevel", "error", "-y"]; files.forEach(([, f]) => args.push("-i", f));
      const fc = files.map(([name], i) => `[${i}:v]crop=760:430:420:290,scale=380:215,drawtext=text='${name}':x=6:y=6:fontsize=18:fontcolor=yellow[v${i}]`).join(";") + ";" + files.map((_, i) => `[v${i}]`).join("") + `hstack=${files.length}`;
      execFileSync("ffmpeg", [...args, "-filter_complex", fc, path.join(out, w + "-moves.jpg")]); files.forEach(([, f]) => fs.rmSync(f)); }
  }
}
if (errs.length) console.log("handlab: page errors:", errs.join(" | "));
if (bad.length) console.log("handlab: wrists past a body's range:", bad.join(", "));
console.log(`handlab: ${rows.length} guns, pictures in ${out}`);
done(errs.length || bad.length ? 1 : 0);
