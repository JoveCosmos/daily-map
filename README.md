# Daily Map

A multiplayer first-person shooter in the browser, played on a new AI-generated world every day.
No install: open a link and play, on desktop or phone.

## What is in it

- **Netcode in the Counter-Strike tradition:** an authoritative 64-tick server, client-side prediction and
  reconciliation, interpolation of other players, and lag compensation (the server rewinds to what the shooter saw).
  `server/nettest.mjs` measures hit registration under simulated latency.
- **CS weapons and their feel:** 32 items with CS:GO's damage, armour penetration and range falloff: pistols (Glock-18,
  USP-S, P250, Five-SeveN, Tec-9, CZ75-Auto, Desert Eagle), SMGs (MP9, MAC-10, MP7, UMP-45, P90), shotguns (Nova,
  XM1014), rifles (Galil AR, FAMAS, AK-47, M4A4, M4A1-S, SG 553, AUG, SSG 08, AWP), the Negev, the Zeus x27, the knife.
  A spray pattern per gun, spread that builds while spraying and recovers, tagging, wallbangs through thin walls, head,
  chest, stomach, arm and leg zones, CS armour and helmets, burst fire on the Glock and FAMAS.
- **Grenades:** HE, flashbang, smoke, molotov and decoy, thrown, lobbed or bounced with real physics. Smoke blocks sight
  (for bots and for what the server sends), fire burns for 7 seconds and smoke puts it out.
- **Two modes:** Deathmatch, and Competitive: CS's short match with money, a buy menu, two bomb sites placed on every
  map automatically, the C4 planted and defused, round pay, halftime, spectating teammates after death, and votes.
- **Movement:** Source-style running, air strafing and crouching, CS's landing slowdown, bunny hops and crouch-jumps.
- **Generated worlds:** maps made with Tencent HY-World, turned into a playable map (collision, phone version, spawns,
  bot navigation, menu preview) by one command, `tools/add-map.sh`. A public room rotates through `maps/rotation.json`.
- **Bots** at four difficulties that strafe, take cover, flank, buy, use grenades, plant, retake and defuse; a radar;
  team chat, radio calls and pings; a damage report and assists; private rooms with a 4-letter code; a leaderboard per
  map; touch controls on phones; settings (CS-scale sensitivity, FOV, volume, crosshair, weapon finish).

## Run it

Requires Node 20 or later.

```bash
cd server
npm install
node server.js            # http://127.0.0.1:8945
```

Open `http://127.0.0.1:8945/` in a browser. `PORT=` changes the port. The game also works under a path behind a
reverse proxy (for example `/play/`); proxy WebSocket upgrades for `ws`.

Useful environment settings: `PER_TEAM` (bots per side when a room fills, default 3), `DAILY_PERIOD` (seconds per map in
the rotation, default 3600), `STATE_DIRECTORY` (where the leaderboard is kept).

## Add a map

Any 3D world exported as a GLB can become a map; ours come from Tencent HY-World (text or image to a 3D world, on
Tencent's site). One command does the rest:

```bash
tools/add-map.sh <world.glb> <id> "<Display name>" [--scale 35] [--activate] [--force]
```

It builds a collision mesh (about 200k faces), a desktop visual (compressed, half the triangles, 2048 px textures) and a
lighter phone visual, removes textures the game never uses, writes `maps/<id>.json`, checks the map is playable, and
renders a menu preview. It refuses a map with too little walkable ground, a walk shorter than 15 m or longer than 120 m,
or fewer than 3 safe spawns a team, and reports enclosed pockets. Nothing reaches `maps/` until every step has passed.
The raw upload is kept in `maps/originals/`.

- `--scale` sets metres per model unit (35 suits HY-World exports; try another value if the world looks too big or
  small, then compare the reported walk length).
- `--activate` adds the map to `maps/rotation.json`, the public room's rotation. Restart the server to load it, or set
  `RESTART_CMD` to a command that restarts it and the script runs it for you.
- Look around a map without playing: `http://127.0.0.1:8945/preview.html?map=<id>`.
- Play it locally: put its id alone in `maps/rotation.json` (or first in the list) and start the server; the public
  room opens on it. The room moves to the next map every `DAILY_PERIOD` seconds (default 3600; 86400 for a real day).

Needs Python 3 with `trimesh` and `fast_simplification` (`pip install trimesh fast-simplification`), Node with
`tools/package.json` installed (`cd tools && npm install`), and Google Chrome for the preview.

## Working on the code

Read [AGENTS.md](AGENTS.md) first: how the client, server and shared simulation fit together, the rules that
keep multiplayer correct, and traps already hit.

## Layout

```
index.html, game.js     the page and the client (rendering, input, prediction, HUD, menu)
sim.js                  the simulation shared by client and server (movement, collision, weapons, navigation)
models.js               player and weapon models
server/server.js        the authoritative game server (rooms, modes, bots, grenades, lag compensation, static files)
server/*test.mjs        tests: netcode (nettest), weapons and movement (feeltest), grenades (nadetest), Competitive (comptest)
maps/                   map definitions and their meshes
tools/                  the map pipeline
vendor/                 three.js, three-mesh-bvh, spark
```

## Controls

WASD move, mouse aim and fire, Space jump, C crouch, Shift walk, R reload, 1 primary, 2 pistol, 3 knife (twice for the
Zeus), 4 grenades, 5 the bomb, Q last weapon, right click zoom (lob a grenade, burst on the Glock and FAMAS), E pick up or
defuse, F inspect, B buy, Y and U chat, Z radio, middle click mark a spot, Tab scores, K respawn if stuck. Phones get a
touch stick and buttons for all of it.

## License

GNO Network General Public License, version 6 or later (see `LICENSE.md`). The bundled maps were generated with Tencent
HY-World and carry its license terms (see `MAPS.md`). `vendor/` holds third-party libraries under their own licenses.
