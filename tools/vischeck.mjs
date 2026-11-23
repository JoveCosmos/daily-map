// vischeck.mjs <id> [game dir ..]: how well the fighters stand out against map <id> (2026-11-23, after the Counter-Strike
// audit: CS keeps its players readable against every wall, and a generated map's colours are whatever the generator
// made). A throwaway server from <game dir> on a spare port, five bots a side, one page in headless Chrome (software GL).
// For each fighter in the game, from up to two walkable spots 10-25 m away with a clear line to it, the page renders the
// view as a player sees it, then again with the fighter white and everything else black (walls still hide what they
// hide): the fighter's pixels against the ring of pixels round it give the brightness gap (0-255) and the colour gap.
// Prints one JSON line and a warning when many views blend in; exit 2 when it could not measure (never fails a map).
import { spawn } from "node:child_process"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const [,, id, dirArg] = process.argv;
if (!/^[a-z0-9-]{2,24}$/.test(id || "")) { console.log("usage: node vischeck.mjs <map id> [game dir]"); process.exit(2); }
const dir = path.resolve(dirArg || path.join(path.dirname(new URL(import.meta.url).pathname), ".."));
const SPORT = 9500 + Math.floor(Math.random() * 400), CPORT = SPORT + 1, tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vischeck-"));
const srv = spawn("node", ["server.js"], { cwd: path.join(dir, "server"), detached: true, stdio: "ignore", env: { ...process.env, PORT: String(SPORT), ROTATION: id, PER_TEAM: "5", STATE_DIRECTORY: tmp, MAP_SKIP: "0" } });
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars", "--remote-debugging-port=" + CPORT, "--user-data-dir=" + tmp, "about:blank"], { stdio: "ignore", detached: true });
const done = code => { for (const p of [chrome, srv]) try { process.kill(-p.pid, "SIGKILL"); } catch (e) {} try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} process.exit(code); };
setTimeout(() => { console.log("vischeck: timed out"); done(2); }, 240000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let k = 0; k < 120; k++) { await sleep(500); try { if ((await fetch(`http://127.0.0.1:${SPORT}/rooms`)).ok) break; } catch (e) {} }
let t; for (let k = 0; k < 80 && !t; k++) { await sleep(150); try { t = (await (await fetch(`http://127.0.0.1:${CPORT}/json/list`)).json()).find(x => x.type === "page"); } catch (e) {} }
if (!t) { console.log("vischeck: no browser"); done(2); }
const ws = new WebSocket(t.webSocketDebuggerUrl); let n = 0; const pend = {};
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(r => { const i = ++n; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Emulation.setDeviceMetricsOverride", { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${SPORT}/?autoplay&debug&team=ct` });
const ev = async (e, awaitPromise = false) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise }); return r.result && r.result.result ? r.result.result.value : null; };
for (let k = 0; k < 120; k++) { await sleep(1000); if (await ev("!!(window.__g && __g.connected() && __g.others.size >= 6)")) break; }
await sleep(15000);   // the generated fighters load after the page and take the place of the code-built ones
const r = await ev(`(async () => {
  const { scene, camera, renderer } = await import("/client/core.js"), THREE = await import("three");
  const g = window.__g, W = g.W(), gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const fighters = [...g.others.values()].filter(o => o.alive !== false && !o.gone && o.model && o.model.g);
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 }), white = new THREE.MeshBasicMaterial({ color: 0xffffff }), views = [], skipped = [], shots = [];
  const read = () => { const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  const kids = camera.children.map(c => [c, c.visible]); kids.forEach(([c]) => c.visible = false);
  const bg = scene.background, fog = scene.fog, cam0 = camera.position.clone(), q0 = camera.quaternion.clone();
  for (const f of fighters) {
    const P = f.model.g.position, chest = P.clone(); chest.y += 1.2; let tries = 0; const vis0 = f.model.g.visible; f.model.g.visible = true;   // an enemy out of this page's sight is hidden: shown for the measure
    /* spots to look from: floor 10-25 m away round the fighter (the page builds no routes, so the floor is found by a
       ray from above), standing room over it, a clear line to the fighter's chest */
    const spots = []; for (let k = 0; k < 24; k++) { const an = k / 24 * Math.PI * 2 + f.id, d = 12 + (k % 3) * 6, q = new THREE.Vector3(P.x + Math.cos(an) * d, P.y + 3, P.z + Math.sin(an) * d);
      const fl = W.first(q, new THREE.Vector3(0, -1, 0), 8); if (!fl || Math.abs(fl.face.normal.y) < .7) continue; const eye = fl.point.clone(); eye.y += 1.62;
      if (W.first(fl.point.clone().setY(fl.point.y + .1), new THREE.Vector3(0, 1, 0), 1.8)) continue; if (W.clear(eye, chest)) spots.push(eye); }
    for (const eye of spots) { if (tries >= 2) break; tries++;
      camera.position.copy(eye); camera.lookAt(chest); camera.updateMatrixWorld(true);
      const fx = []; scene.traverse(o => { if ((o.isSprite || o.isPoints) && o.visible) { fx.push(o); o.visible = false; } });   // smoke, glare, tags: the map and the fighter alone
      renderer.render(scene, camera); const A = read();
      const saved = []; scene.traverse(o => { if (o.isMesh || o.isSprite || o.isLine || o.isPoints) { saved.push([o, o.material, o.visible]); let mine = false; for (let p = o; p; p = p.parent) if (p === f.model.g) { mine = true; break; }
        if (o.isMesh) o.material = mine ? white : black; else o.visible = false; if (mine && (o.isSprite)) o.visible = false; } });
      scene.background = new THREE.Color(0); scene.fog = null; renderer.render(scene, camera); const B = read();
      for (const [o, m, v] of saved) { o.material = m; o.visible = v; } scene.background = bg; scene.fog = fog; for (const o of fx) o.visible = true;
      let x0 = w, x1 = 0, y0 = h, y1 = 0, cnt = 0, Lf = 0; const cf = [0, 0, 0];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (B[i] > 128) { cnt++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        Lf += .2126 * A[i] + .7152 * A[i + 1] + .0722 * A[i + 2]; cf[0] += A[i]; cf[1] += A[i + 1]; cf[2] += A[i + 2]; } }
      if (cnt < 40) { skipped.push(cnt); continue; }
      const mx = (x1 - x0) * .5 + 2, my = (y1 - y0) * .5 + 2; let nb = 0, Lb = 0; const cb = [0, 0, 0];
      for (let y = Math.max(0, y0 - my | 0); y < Math.min(h, y1 + my); y++) for (let x = Math.max(0, x0 - mx | 0); x < Math.min(w, x1 + mx); x++) { const i = (y * w + x) * 4; if (B[i] > 128) continue;
        nb++; Lb += .2126 * A[i] + .7152 * A[i + 1] + .0722 * A[i + 2]; cb[0] += A[i]; cb[1] += A[i + 1]; cb[2] += A[i + 2]; }
      if (!nb) continue; Lf /= cnt; Lb /= nb;
      if (${JSON.stringify(!!process.env.SHOT)} && shots.length < 4) { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"), im = x.createImageData(w, h);
        for (let y = 0; y < h; y++) im.data.set(A.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4); x.putImageData(im, 0, 0); x.strokeStyle = "#f0f"; x.strokeRect(x0 - 3, h - y1 - 3, x1 - x0 + 6, y1 - y0 + 6); shots.push(c.toDataURL("image/jpeg", .8)); }
      views.push({ team: f.team, d: +P.distanceTo(eye).toFixed(1), px: cnt, dL: +Math.abs(Lf - Lb).toFixed(1), dC: +Math.hypot(cf[0] / cnt - cb[0] / nb, cf[1] / cnt - cb[1] / nb, cf[2] / cnt - cb[2] / nb).toFixed(1), Lf: +Lf.toFixed(0), Lb: +Lb.toFixed(0) }); } }
  for (const f of fighters) f.model.g.visible = f.vis !== false && !f.gone;
  kids.forEach(([c, v]) => c.visible = v); camera.position.copy(cam0); camera.quaternion.copy(q0);
  return { fighters: fighters.length, views, skipped, shots };
})()`, true);
if (!r || !r.views || r.views.length < 4) { console.log("vischeck: too few views to measure", JSON.stringify(r)); done(2); }
if (process.env.SHOT) (r.shots || []).forEach((u, i) => fs.writeFileSync(process.env.SHOT + "-" + i + ".jpg", Buffer.from(u.split(",")[1], "base64")));   // SHOT=<prefix>: a few of the views, the fighter boxed
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }, V = r.views;
const blend = V.filter(v => v.dL < 20 && v.dC < 40), byTeam = t => V.filter(v => v.team === t);
const out = { id, views: V.length, medianBrightnessGap: med(V.map(v => v.dL)), medianColourGap: med(V.map(v => v.dC)), blendIn: +(100 * blend.length / V.length).toFixed(0),
  atlas: { views: byTeam(0).length, brightnessGap: med(byTeam(0).map(v => v.dL)) || 0 }, ember: { views: byTeam(1).length, brightnessGap: med(byTeam(1).map(v => v.dL)) || 0 },
  fighterBrightness: med(V.map(v => v.Lf)), backgroundBrightness: med(V.map(v => v.Lb)) };
const warnings = []; if (out.blendIn > 30) warnings.push(`${out.blendIn}% of views of a fighter 10-25 m away blend into the background (brightness gap under 20 of 255 and colour gap under 40)`);
console.log(JSON.stringify(out)); for (const x of warnings) console.log("warning: " + x);
done(0);
