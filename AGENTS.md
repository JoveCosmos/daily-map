# Working on Daily Map

Notes for anyone changing this code, by hand or with a coding assistant: how the pieces fit, the rules that keep
multiplayer correct, and the traps that already cost time once. Read it before the first change.

## How it fits together

- **`sim.js` is the game.** Movement, capsule collision against the map, weapons (spread, recoil, damage, hit boxes)
  and bot navigation live here, and the **same file runs on the server and in the browser**. Anything that decides an
  outcome (where a player is, whether a shot hits) must be computed in `sim.js` from the inputs alone, never from
  `Math.random()`, the clock or the frame rate. Spread uses a seeded generator (`mulberry32`, seed from player id and
  command number) so client and server agree on every bullet.
- **`server/server.js` is the authority.** It runs the simulation at 64 ticks a second, applies each player's queued
  commands, owns health, kills, pickups, bots and rooms, and sends snapshots (32 a second). It rewinds other players to
  what the shooter saw when it checks a hit (lag compensation, at most 0.4 s back). It also serves the static files.
- **`game.js` is the client.** It predicts the local player by running `sim.js` on its own inputs, corrects itself when a
  snapshot disagrees (replaying the commands the server has not acknowledged yet), and draws everyone else
  interpolated about 100 ms in the past. It also does rendering, sound, the HUD, the menu, settings and touch controls.
- **`models.js`** builds the soldiers and guns procedurally (no model files). **`index.html`** holds the page, the
  menu and all CSS.
- **Maps** (`maps/<id>.json`) point to a visual mesh, a phone visual and a collision mesh, plus a scale. The server
  loads every map in its list once; the public room rotates through `maps/rotation.json`.

## Rules that keep multiplayer correct

1. **Change gameplay in `sim.js`, then restart the server.** If the client and server run different `sim.js`, prediction
   drifts and players rubber-band. Client-only changes (`game.js`, `index.html`, `models.js`) need no server restart.
2. **Never trust the client.** The server checks everything a command claims; it keeps each player's clock within
   0.25 s of real time (a client cannot bank idle time and fire a burst), runs at most 8 commands per tick, and caps the
   rewind. Keep it that way when adding actions.
3. **Do not send what a player should not know.** Snapshots are built per viewer: an enemy's position is sent only with
   line of sight, when very close, or briefly after being seen; unseen running enemies are sent as footsteps only.
   Enemy health is never sent. A new piece of state needs the same thought.
4. **Measure netcode, do not eyeball it.** `server/nettest.mjs` connects protocol-level clients with simulated latency
   (`FAKE_LAG_MS`) and reports hit registration and prediction error. Run it after touching movement, weapons or the tick.

## Traps already hit (do not relearn them)

- **The menu's layout belongs to CSS.** Never set `#start`'s `display` to `flex`, `grid` or `block` from JavaScript;
  only `"none"` (hide) or `""` (show, the stylesheet decides). Setting it once centred the whole menu and broke it.
- **Crouch is C, not Ctrl.** Ctrl+W, Ctrl+S and the like are browser shortcuts a page cannot block: Firefox closed the
  tab mid-game. Do not bind gameplay to Ctrl combinations.
- **Compressed meshes store positions as integers.** Meshes optimised with meshopt have quantized positions; convert
  them to Float32 **before** applying the map's transform, or the navigation finds a tenth of the walkable ground.
- **The map preloads while the menu is open.** Play must not hide the menu or lock the mouse until the map is loaded
  and the server answered, or players stare at the sky turning a camera nothing renders.
- **A dropped connection rejoins by reloading.** The page saves a "rejoin" note and reloads straight back into the
  room; do not try to rebuild a game on a dead socket.
- **Generated maps have holes and pockets.** Spawns skip points with a ceiling close above or walls on most sides, a
  step with no ground within 6.5 m below is refused, and anyone 4 m below the map is respawned. Pits a player cannot
  climb out of are not detected yet: that is why K (respawn if stuck) exists.
- **Phones are a different machine.** They load a lighter visual (`visualMobile`), start without shadows, and judge
  performance by real frame time. Test touch in landscape: a look-drag that starts on a button presses it.
- **Headless test browsers join the game.** A test that is killed by a timeout can leave its browser running and
  connected as a phantom player. Close test browsers explicitly.

## Testing a change

- Run the server (`cd server && npm install && node server.js`), open `http://127.0.0.1:8945/`.
- `?autoplay&debug` starts a game straight away and exposes debug state, for scripted tests.
- Server settings: `PORT` (default 8945), `DAILY_PERIOD` (seconds per map in the public room's rotation, default 3600).
- Test-only server settings (never in production): `FAKE_LAG_MS`, `DM_TIME`, `ROUND_TIME`, `TO_WIN`, `SPAWN_AT=<weapon>`,
  `DEBUG_BOTS=1` (logs what bots decide every 30 s; an empty room pauses, so keep a client connected).
- Check both a desktop browser and a phone (or a touch emulator in landscape).

## Sending work back

Small, focused changes are easiest to merge: one topic a pull request, with a sentence on how it was tested. For
gameplay, say what CS:GO does and how the change matches it. Keep the licence header and the map terms (`MAPS.md`).
