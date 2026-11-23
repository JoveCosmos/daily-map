# Checklists

How Newground is built from now on: one thing at a time, finished from start to end before the next. A gun, a map or
any other part of the game is only switched on (or left on) when every line of its checklist is done and the operator
has played it. Until then it stays off, like the guns in `sim.js` `OFF` and the hidden modes in the menu.

## A gun

Every gun goes through all of these, in this order. Tick each one per gun.

**1. Model**
- [ ] A real 3D model, a full cut for your own hands and a light cut for other players' hands and phones
- [ ] Fitted: muzzle, sights, grip and magazine where the code expects them (flash, tracer and hands follow)
- [ ] Each team's look and the weapon finishes work on it

**2. Hands**
- [ ] The right hand closes on the grip, fingers wrapped, nothing floating or cutting through
- [ ] The left hand on its own support point (handguard, magazine well, or both hands on a pistol)
- [ ] Draw: the gun comes up and the hands close on it
- [ ] Reload animation keyed to this gun's own reload (magazine out and in, bolt, slide or pump, at the right moments)
- [ ] Inspect

**3. Numbers**
- [ ] Damage per hit zone, armour penetration, range falloff
- [ ] Fire rate, single, burst or auto, magazine and reserve, reload time, draw time
- [ ] Movement speed with it out, wallbang depth, how much a hit slows the target

**4. Accuracy**
- [ ] First-shot accuracy, standing and crouched
- [ ] Spread while moving, in the air, and how fast it comes back after stopping (counter-strafe)
- [ ] Its own hand-made spray pattern (not a scaled copy of another gun)
- [ ] Spray recovery time; tapping, bursting and spraying each feel right
- [ ] Scope levels and scoped accuracy, if it has a scope

**5. Recoil feel**
- [ ] View punch and how fast it settles
- [ ] The gun's kick, climb and twist on screen, and its recovery

**6. Sound**
- [ ] Its own shot recording, near and far, true to the real gun (suppressed if it is)
- [ ] Reload parts in time with the animation, draw, dry fire, bolt or pump
- [ ] Heard right from other players: direction, distance, walls, echo

**7. Effects**
- [ ] Muzzle flash sized for the gun
- [ ] Tracer sized by calibre
- [ ] Impact marks, dust and sparks sized by calibre
- [ ] Empty case by calibre (size, steel or brass, shotgun hull), from its own eject port, its own throw, its own landing
      sound; ejected at the right moment (shot, bolt or pump); from other players' guns too

**8. In other players' hands**
- [ ] Shown in their hands with the right pose, their flash, tracer and cases
- [ ] Dropped on the ground and as a map pickup, looking like itself

**9. In the game**
- [ ] How you get it: spawn kit, map pickup, buy price, kill reward
- [ ] Bots know when to take it and how to use it (range, bursts, scoping)
- [ ] Name in the kill feed, HUD and buy menu; crosshair
- [ ] Phone controls work with it (fire, zoom, burst, reload)
- [ ] Killcam and spectating show it right

**10. Tests**
- [ ] Its numbers in `server/feeltest.mjs`
- [ ] Headless browser check on desktop and phone: no errors, screenshots of hands, reload, draw
- [ ] Graphics budget still met (`tools/perfgate.mjs`)

**11. Done**
- [ ] The operator plays it and approves
- [ ] Taken out of `OFF`, deployed, AGENTS.md and README updated, pushed when the operator says so

## A map

- [ ] Prompt within the rules: one flat level, closed buildings, no water, stairs, balconies or trenches, many streets
- [ ] Imported big enough (scale 50-55 for the newer, larger maps), doors and cover still to scale
- [ ] Ground guard and pits: `tools/fillpits.mjs` leaves no holes and no pits; `tools/check.mjs` passes, its play tests
      included: straight walks with the game's movement (nothing a step high stops them, little time off the ground),
      routes walked as bots walk them (few glides), floor cracks, and its spawn-to-site times read (they say how much of a
      CS round the map leaves room for)
- [ ] No spawn pockets; both sides' spawns fair; bomb sites placed and fair (bot matches near 50/50)
- [ ] Bots move, fight and plant on it without getting stuck: `tools/botcheck.mjs` (add-map runs it) finishes rounds, plants,
      glides rarely, and longer bot matches come out near 50/50
- [ ] The look matches the collision (no invisible walls where you can see through, no walking through walls)
- [ ] Menu preview, phone version, graphics budget
- [ ] The operator plays it and approves; then into the rotation

## Anything else (a mode, a menu part, a HUD element, a sound, a bot behaviour)

- [ ] What it is and why, in one sentence
- [ ] Look on desktop and phone, in the design's colours and cards
- [ ] Feel and sound
- [ ] Its rules and numbers
- [ ] Server and browser agree (the server decides, the browser predicts the same)
- [ ] Bots handle it
- [ ] Edge cases: dead, spectating, killcam, reconnect, map change, room empty
- [ ] Performance on a phone
- [ ] Tests: automated, headless browser, phone
- [ ] AGENTS.md and README
- [ ] The operator plays it and approves; then on, deployed, pushed when the operator says so
