# Models

The files in `models/` come from public sources and are listed here with their licenses. Every other model in the game
is built in code (models.js).

| Files | Source | Author | License |
|---|---|---|---|
| `hy-*.glb`, `fighter-*.glb`, `arms-atlas/ember.glb` and their `m-` light cuts (5-8k faces, a 512 colour map only, for phones and for guns in other hands); `hy-ak.glb`, `hy-m4.glb`, `hy-mp9.glb`, `hy-deagle.glb`, `hy-awp.glb`, `hy-glock.glb`, `hy-usp.glb`, `hy-knife-atlas.glb`, `hy-knife-ember.glb` | Generated for this game in Hunyuan 3D by the project owner (textured), reduced to 30k faces with 1024 textures, the loose magazine removed | Daily Map | ours, server only: not in the public repo (raw exports in /srv/fps-poc-assets/tencent-raw) |
| `ak47.glb`, `m4.glb`, `m1911.glb` (no longer used) | "Various Small Arms (Assault Rifles, Sniper, Pistol)", opengameart.org/content/various-small-arms-assault-rifles-sniper-pistol | Tabasco | CC0, or CC-BY 3.0 at your choice (credited here either way) |
| `fighter-*.glb` | Generated for this game in Hunyuan 3D by the project owner, reduced to 20k faces and rigged with our own 22-bone humanoid (Blender, `assets/hy/rig.py`; `atlas1` textured in Hunyuan 3D, its weights copied from the grey twin by `rigt.py`; `atlas2`, `atlas4`, `ember4` and `ember5` generated textured in a T-pose, weighted by distance to the bones on a voxel-remeshed twin (`grey.py`, `rigt.py`) with the arms lowered into the rest pose) | Daily Map | ours, server only: not in the public repo (raw exports in /srv/fps-poc-assets/tencent-raw) |
| `arms-atlas.glb`, `arms-ember.glb` | Generated for this game in Hunyuan 3D by the project owner (textured): the sleeves only, cut clean at the sleeve's end and at the wrist strap (each end closed), on our own arm rig with the `arms.glb` hand as the glove (`assets/hy/fitarms.py`, 2026-11-24); phone cuts by `assets/hy/litearms.py` (sleeve 6k faces, the glove whole) | Daily Map | ours, server only: not in the public repo (raw exports in /srv/fps-poc-assets/tencent-raw) |
| `arms.glb` (the source rig and hand), `arms-cc0.glb` (the fallback arms the game loads: the same rig as the team arms, made from `arms.glb` by `assets/hy/fitarms.py`) | "fps arms (rigged only)", opengameart.org/content/fps-arms-rigged-only | para | CC0 |

How they are used: converted from the original Blender files to glTF with Blender 5.3, unchanged in shape. The game
paints them in its own materials (so weapon finishes apply), bakes their rigs into plain meshes, and fits each to the
length and place of the code-built gun it replaces (IMPORTED in models.js): the AK-47 and M4 as themselves, the M1911
as the Desert Eagle, and the M4 under the M4A1-S suppressor. `?codeguns` in the page URL shows the code-built ones.

The arms (rebuilt 2026-11-24): one armature for every arms file, in metres, facing the camera's way: upper arm, forearm, a twist bone half way and one at the wrist, the hand and its fingers. A loose sleeve does not turn with the forearm, the glove and its strap do, so the hand turns its full range without twisting any skin. In the game (models.js makeArms, client/hands.js) each hand is put where it holds that gun, measured off the gun's own mesh (the grip's line, the trigger, the handguard, the magazine), its fingers close joint by joint until they meet the gun, and the elbow and shoulder are worked back from the hand so the wrist keeps a natural bend.

The fighters: Atlas has atlas1 to atlas4 (atlas4 the commando), Ember has ember1 to ember4 (ember4 the jungle guerrilla), and a player keeps one by their name. The grey
bodies are painted in code by height (boots, trousers, jacket, head) in the team's colours. Each frame they take the
same walk, crouch and aim as the code-built soldier (each turn applied about the body's own axes, so the bones' rolls do
not matter), the gun rides the chest, and a two-bone reach puts each hand on it. Hit boxes are the server's, unchanged.
Until the files load, the code-built soldier stands in, and it is swapped when they arrive.
