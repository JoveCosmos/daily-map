# Working on NG - Newground

**How we work:** one thing at a time, finished from start to end against its checklist in `CHECKLISTS.md` (a gun has
11 stages, from its model to the operator playing it), and it can be switched off until then: guns in `sim.js` `OFF`
(nothing hands them out: pickups, buying, bots, the Gun Game ladder), modes as `hidden` cards in the menu. Do not open
new features beside the one in progress.

Notes for anyone changing this code, by hand or with a coding assistant: how the pieces fit, the rules that keep
multiplayer correct, and the traps that already cost time once. Read it before the first change.

## How it fits together

- **`sim.js` is the game.** Movement, capsule collision against the map, weapons (spread, recoil, damage, hit boxes)
  and bot navigation live here, and the **same file runs on the server and in the browser**. Anything that decides an
  outcome (where a player is, whether a shot hits) must be computed in `sim.js` from the inputs alone, never from
  `Math.random()`, the clock or the frame rate. Spread uses a seeded generator (`mulberry32`, seed from player id and
  command number) so client and server agree on every bullet. On the ground a player moves as Source's box does
  (`groundMove`: raised a step, `STEP` = 18 units, for the move across, then stood on the highest walkable floor under
  a disc as wide as the body, `support`); in the air, or when that fails, the capsule is pushed out of the map. Route
  links (`buildNav`) must fit a body, not only a centre line, and the bomb-site rule is here too (`bombSites`).
- **`server/server.js` is the authority.** It runs the simulation at 64 ticks a second, applies each player's queued
  commands, owns health, kills, pickups, bots and rooms, and sends each player the others every tick and its own state
  every other tick (`snapshot(full)`; the pickups only when they change; compressed). It rewinds other players to what
  the shooter saw when it checks a hit (lag compensation, at most 0.4 s back, between the two recorded ticks around the
  shot's view time) and holds that view time to the player's usual lag, 40 ms either way (`shotTime`). Bots are a set of
  keys and a mouse each tick (`botKeys`, `botRun`, `botTrigger`, difficulty in `BOTAIM`) run through the same `move()`
  and `weapon()` as players. It also serves the static files.
- **`game.js` is the client.** It predicts the local player by running `sim.js` on its own inputs, corrects itself when a
  snapshot disagrees (replaying the commands the server has not acknowledged yet), and draws everyone else
  interpolated two updates plus the measured jitter in the past (`interp`, 35-250 ms). It also does rendering, the HUD, the menu, settings and touch controls.
- **`client/` holds the rest of the client, one module per part:** `core.js` (renderer, scene, camera, URL switches,
  `$`, `nowS`: no game state, safe to import anywhere), `audio.js`, `fx.js`, `talk.js`, `comp.js` (buy menu, lineups,
  sites, bomb), `radar.js`, `nades.js`, `viewmodel.js` (guns in hand, arms) and `killcam.js`. They import game state from
  `game.js` and `game.js` imports them back. Two rules make that work: **only the module that declares a variable
  assigns it** (an imported binding is read-only; other modules call a setter such as `setBlind`, `recoilFx`,
  `releaseMouse`), and **a module never reads `game.js` state while it loads** (that state does not exist yet; build
  such things in a function `game.js` calls, as `initViews()` does). A new file under `client/` is served as is.
- **Modes, grenades and the bomb are the server's alone.** Deathmatch, Competitive (money, buying, the C4, rounds,
  halftime, votes), Wingman (Competitive two a side on one site, `MODES.wing`), Retakes (`MODES.rt`: the bomb planted when the freeze ends,
  Ember spawned around it, set loadouts in `rtKit`, no buying), Gun Game (`LADDER`, `ggKit`, `ggLevel`;
  no pickups or drops) and the daily challenge (`MODES.dc`, solo against four bots) live in `server.js`; `DMLIKE` and
  `COMP` group them, and `game.js` mirrors that with `dmLike()` and `compLike()`; grenades fly there too (`tickNades`), and clients only draw what each snapshot
  lists (grenades, smokes, fires). The buy prices are kept in two places, `PRICE` in `server.js` and in `client/comp.js`: change
  both.
- **`models.js`** builds the soldiers and guns procedurally; most guns are a close relative's model with the parts that
  tell them apart (`VARIANT`). A few guns use a public-domain model instead (`IMPORTED`, files in `models/`, credits in
  MODELS.md): it is painted in the game's own materials and fitted to the code-built gun's box (muzzle, top, centre),
  so hands, flash and tracers need no change, and `?codeguns` shows the old one. Weapon finishes repaint a gun's body
  materials (`applyFinish`). The first-person arms (rebuilt 2026-11-24) are one rig for every arms file (upper arm,
  forearm, a twist bone half way and one at the wrist, hand, fingers; `models/arms-cc0.glb` here), posed in code every
  frame: `makeArms` in models.js places and turns each hand exactly, works the shoulder back from the hand so the wrist
  keeps a natural bend, picks the elbow round the reach circle and spreads the hand's turn over the twist bones; the
  sleeve does not turn with the forearm, the glove and its strap do. Where the hands go is client/hands.js: each gun's
  grip line, trigger, handguard and magazine measured off its own mesh by rays (`measure`, once per gun in idle time),
  fingers closed joint by joint until they meet the gun (`closeFingers`), reloads moving the support hand by the gun's
  parts at the reload sounds (`RELOAD`), the arms scaled by what is held (`MOUNT`). Every fighter's body gets
  a thin edge of its team's colour (`RIM`, `rimmed`): a copy of the body material per fighter on one shared shader, built
  on the smooth normal (the cloth's normal maps lit the whole body), switched by `sd.rim(0..1)`, which goes out as the
  fighter falls, so a lit outline always means someone alive. **`index.html`** holds the page, the menu and all CSS.
- **Bullets by calibre** (client/fx.js): `CAL` gives each gun its round, and the round sets the spent case (`CASES`,
  one instanced mesh a kind, 16 on phones, 40 on desktop), the tracer (`TRACE`) and the hole, dust and sparks (`HIT`).
  Bolt and pump guns throw their case when the bolt comes back (`CYCLE`), the rest at the shot.
- **The map switch is for testing.** With `MAP_SKIP=1` an arrow by the menu's "Next:" moves the public room on now
  (`/skipmap`). It is off by default: anyone could empty the public room with it every 5 seconds.
- **One way into a game.** The menu shows a card per mode (`#mgrid`); a card opens the setup popup (`#msetup`, `msOpen`)
  with only the rows that mode lists in `MODEINFO` (side for every mode, bots, their skill, freeze time) and one Start
  (`msGo`). Joining by code or invite link opens the same popup. `#play` is only Resume / Continue during a game. A new
  mode needs a card, a `MODEINFO` entry and its case in `msGo`.
- **Replays come from the server's record.** Every snapshot tick the server keeps each player's position, view, weapon
  and shots for 10 s (`record`, `e.hist`). A death sends the victim a short record (`sendKillcam`, message `kc`); a round's
  end sends everyone its best moment (`pickHighlight`, message `hl`). Only the dead or the finished round see it, so it
  gives the living nothing. The client plays both through one player (`KC`, `kcCamera`, `kcBodies` in client/killcam.js).
- **What is kept on disk** sits next to `boards.json` (or in `$STATE_DIRECTORY`): `stats.json` (lifetime numbers per
  player name, `/stats?name=`) and `challenge.json` (the daily challenge's runs, the last 30 days, `/challenge`). Names
  are free text, there are no accounts. None of these files belong in git.
- **Smoke lineups** are found by the server once per map, at start (`lineups()`, run by a warm-up room per map): it throws smokes from the attackers' route with the
  real grenade physics (`botAim`) and keeps two per site that land on it. Clients only draw them (`setLineups`).
- **Sound** is in client/audio.js: recorded clips (`sounds/`, SOUNDS.md, `CLIP_NAMES`) and code-made ones (cracks, impacts).
  Anything with a place in the world plays through `at(pos, fn)`, which pans it, muffles it behind walls, delays it by
  distance and sends it to the echo; `probeEnv` sets the echo from how enclosed the listener is.
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
4. **Every player-state field lives in four places.** `newPlayer` and `copyPlayer` in `sim.js`, the snapshot's `me` in
   `server.js`, and the reconcile in `game.js`. Miss one and prediction drifts, or a copied array is shared between the
   prediction and the server's state. `copyPlayer` copies arrays and objects, never shares them.
5. **Measure netcode, do not eyeball it.** `server/nettest.mjs` connects protocol-level clients with simulated latency
   (`FAKE_LAG_MS`) and reports hit registration and prediction error. Run it after touching movement, weapons or the tick.
6. **An update without `me` is normal.** Every other update carries only the others, the events, grenades in flight and,
   when they changed, the pickups. Anything reading updates (the client's handlers, test clients) treats `me`, `gm`,
   `sm`, `fi`, `sp`, `dc` and `pk` as optional: a missing list means unchanged, never empty.

## Traps already hit (do not relearn them)

- **Shots land on whole ticks.** A gun's cycle (0.1 s for the AK) is not a whole number of ticks; rounding each gap up
  fired the AK at 549 a minute, and recovery that started "after the cycle" ran on the tick of every next shot, so a
  held spray never got past the pattern's first entries. The next shot carries the remainder, and recovery waits a tick
  past the cycle. feeltest fires through `weapon()` tick by tick: test guns that way, not their tables.
- **A route link must fit a body.** Links tested along a centre line alone passed under a stall's counter and between
  posts; the old bots glided along them and never noticed, walking bots stuck there. A stuck bot still glides to its
  next point after 1.5 s without headway; `tools/check.mjs` counts how often a map makes them.

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
  step with no ground within 6.5 m below is refused, and anyone 4 m below the map is respawned. Holes and pits are filled in
  the collision when a map is added (`tools/fillpits.mjs`, shared finder `tools/pits.mjs`); K (respawn if stuck) stays
  as the last resort.
- **Phones are a different machine.** They load a lighter visual (`visualMobile`), start without shadows, and judge
  performance by real frame time. Test touch in landscape: a look-drag that starts on a button presses it.
- **The HUD ignores the pointer.** `#hud` has `pointer-events: none` so overlays never block play; a panel with
  buttons (buy, radio, vote) needs `pointer-events: auto`, and on phones a z-index above `#touch`, which comes later in
  the page and covers everything.
- **A touch button acts through `press()` in `game.js`.** Its `data-key` does nothing until `press()` handles that code.
- **One writer per element.** Two places setting the same button each frame means the later one always wins: decide it
  in one place.
- **Grenades can leave the map.** A steep throw clears low walls; the server logs it and drops the grenade. Tests that
  throw should aim into the map.
- **A rigged model can draw at a size it does not measure.** A skinned mesh is measured in its bind pose but drawn
  through its bones; the imported AK came out far too big in the view. Imported guns are baked to plain meshes
  (`bakeSkins`), and a gun model returns inside a holder group because callers set its scale.
- **A sound recorded in a room carries the room.** Cut foley tight and dry (high-pass, the boom cut, the tail gated):
  the game adds the echo of where the player stands, and a second one baked into the clip sounds like a basement.
- **The page holds one map.** `getMap` keeps a single preload; a room on another map reloads the page with that map
  first (the rejoin note carries `map`). The daily challenge has its own map each day, so its Start reloads before Play
  (`dcqueue`). Without this, joining looped forever.
- **Leaving a page writes a rejoin note** that lasts 30 s: a test that opens another page right after lands back in the
  old room. Clear `sessionStorage` between test pages.
- **`?autoplay` never shows the phone's touch layer** (it only runs while playing for real), so taps there do nothing in
  that mode. Test phones by tapping through the menu like a player.
- **Other players' `alive` is 0 or 1.** It arrives in the snapshot as a number: test it as `o.alive` (truthy), never
  `=== false` or `!== false`, which read everyone as alive (the scoreboard never showed anyone else dead).
- **A message's `t` is its type.** A field called `t` in the same object overwrites it and the client drops the message
  (the challenge result did this once).
- **A phone panel fades the controls.** While scores, radio, buy, a vote or chat is open, or the player is dead, the body
  gets `tpanel` and the action buttons fade out; the stick and the panels' own buttons stay. Panels sit below the score
  bar. One writer sets `tpanel` (next to the scoreboard in `render`): add a new panel to that condition.
- **The phone's crouch button has its own input** (`TouchDuck`). It once toggled Ctrl, and when the keyboard crouch
  became C it silently did nothing. A touch button should never borrow a keyboard binding the player can change.
- **HUD text is cached.** About twenty HUD elements get a setter that skips an unchanged value (see "HUD writes only when
  the value changes" in game.js), because render() sets them every frame. Writing the same text through another
  route (a child element, `innerText`) bypasses the cache: use the same property.
- **Placed sounds have a budget** (`AT` in client/audio.js): HRTF only for near sounds and six at a time, distant ones dropped
  when many are playing, wall rays within 60 m. A new sound through `at()` inherits this; one played around it does not.
- **Headless test browsers join the game.** A test that is killed by a timeout can leave its browser running and
  connected as a phantom player. Close test browsers explicitly.

## Testing a change

- `node server/feeltest.mjs`: the weapons and movement in `sim.js` against CS's numbers (damage and armour, spray and
  recovery, tagging, falloff, wallbangs, bursts, the Zeus, landing and bunny hops; a held spray and the rate of fire
  through `weapon()` tick by tick; steps, ramps, rough floors, ledges, the counter-strafe) and that prediction replays
  exactly. No server needed.
- The first-person hands: `tools/handlab.mjs [game dir] [out dir] [guns]` poses the arms on each gun as the game does and
  saves six views at rest plus an eye-view strip of the draw, the reload and the inspect, with each wrist's bend in
  degrees; exit 1 on a page error or a wrist bent past a body's range.
- A map: `tools/check.mjs <id>` (its play tests need this `sim.js`; `SIM=<path>` checks against another build),
  `tools/botcheck.mjs <id> [seconds] [game dir]` (a bot-only Competitive match), `tools/vischeck.mjs <id> [game dir]`
  (how the fighters stand out; `SHOT=<prefix>` saves a few views).
- With a test server running: `server/nadetest.mjs` (all grenades through the protocol), `server/comptest.mjs` (a
  Competitive match with bots: buying, plants, defuses, halftime), `server/nettest.mjs` (hit registration).

- Run the server (`cd server && npm install && node server.js`), open `http://127.0.0.1:8945/`.
- `?autoplay&debug` starts a game straight away and exposes debug state, for scripted tests. It never captures the
  mouse, so what shows only while playing (the radar, the phone controls) stays hidden there; test those by playing.
- Server settings: `PORT` (default 8945), `DAILY_PERIOD` (seconds per map in the public room's rotation, default 86400).
- Competitive test settings: `FREEZE`, `ROUND_TIME`, `BOMB_TIME`, `HALF`, `TO_WIN`, `START_MONEY` (shorter matches),
  `BOMB_TO=<name>` (who carries the bomb), `TEST_PLANT=1` (a bomb already on A), `TEST_BOTS=ct,t` (bots per side),
  `DEBUG_COMP=1` (logs the carrier). In a browser, `?autoplay&debug` exposes `window.__g`; `__g.corr()` is the largest
  prediction correction seen, which should stay at 0 without other players.
- Test-only server settings (never in production): `FAKE_LAG_MS`, `DM_TIME`, `GG_TIME` (Gun Game's clock), `DC_KILLS`
  (kills to finish the daily challenge), `ROUND_TIME`, `TO_WIN`, `SPAWN_AT=<weapon>`,
  `DEBUG_BOTS=1` (logs what bots decide every 30 s; an empty room pauses, so keep a client connected; `DEBUG_BOTS=2`
  also logs where they glide), `GHOST=1` (humans never spawn: bot-only matches).
- Hit registration, the measured way: `PER_TEAM=0 ROTATION=standin DUEL=1 NO_DEATH=1 FAKE_LAG_MS=150 node server.js`,
  then `node nettest.mjs ws://127.0.0.1:<port>/ws 30`, again with `NO_REWIND=1` to compare (2026-11-16: 96% against 11%;
  2026-11-23 with the page's own clock and delay: 94% at 150 and 300 ms). `BACKTRACK=1` tries a modified page reaching
  0.3 s back on its shots alone: they miss.
  `ROTATION=standin` matters: a generated map has no clear 12-18 m lane, and `DUEL` now refuses to start without one.
  Pace any protocol client by real time, as game.js does: commands faster than 64 a second queue on the server and
  every shot arrives later than the last.
- Check both a desktop browser and a phone (or a touch emulator in landscape).
- A server started in the background for a test: record node's own pid (`( cd server && exec node server.js ) & pid=$!`).
  `cd server && node server.js &` backgrounds a subshell, its pid is not the server's, and the server outlives the test.

## Sending work back

Small, focused changes are easiest to merge: one topic a pull request, with a sentence on how it was tested. For
gameplay, say what CS:GO does and how the change matches it. Keep the licence header and the map terms (`MAPS.md`).
