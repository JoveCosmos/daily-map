# Models

The files in `models/` come from public sources and are listed here with their licenses. Every other model in the game
is built in code (models.js).

| Files | Source | Author | License |
|---|---|---|---|
| `ak47.glb`, `m4.glb`, `m1911.glb` | "Various Small Arms (Assault Rifles, Sniper, Pistol)", opengameart.org/content/various-small-arms-assault-rifles-sniper-pistol | Tabasco | CC0, or CC-BY 3.0 at your choice (credited here either way) |
| `arms.glb` | "fps arms (rigged only)", opengameart.org/content/fps-arms-rigged-only | para | CC0 |

How they are used: converted from the original Blender files to glTF with Blender 5.3, unchanged in shape. The game
paints them in its own materials (so weapon finishes apply), bakes their rigs into plain meshes, and fits each to the
length and place of the code-built gun it replaces (IMPORTED in models.js): the AK-47 and M4 as themselves, the M1911
as the Desert Eagle, and the M4 under the M4A1-S suppressor. `?codeguns` in the page URL shows the code-built ones.

The arms: the rig's skin is replaced by the team's sleeve and a dark glove (each triangle by the bone that moves it
most), and they are posed in code every frame (makeArms in models.js): hands placed on the gun, fingers curled, elbows
solved to reach. The rig's own animation setup lived in Blender and does not export.
