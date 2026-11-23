#!/usr/bin/env bash
# add-map.sh: a world generated on Tencent's HY-World site -> a playable map of the daily rotation, in one command.
#   tools/add-map.sh <upload.glb> <id> "<Display name>" [--scale 35] [--activate] [--force]
# Steps: collision (200k faces), pits filled in it (fillpits.mjs), desktop visual (meshopt, webp 2048, half the triangles), phone visual (webp 1024,
# ~15%), unused textures stripped, map json, playability check (fails the map when it cannot be played), menu
# preview, raw upload kept in maps/originals. The check walks the map with the game's own movement, follows routes as
# bots do, times spawn to bomb site and counts floor cracks (warnings say what a CS-style round on it would lack);
# then a short bot-only match (BOTCHECK=0 skips it) and a measure of how the fighters stand out on it (VISCHECK=0). --activate appends the id to maps/rotation.json and, when RESTART_CMD is
# set, runs it to restart the game server (players are put straight back into the room). Nothing reaches maps/ until every step has passed.
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd); ROOT=$(dirname "$T"); MAPS=$ROOT/maps
usage() { sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 3 ] || usage
SRC=$1 ID=$2 NAME=$3; shift 3; SCALE=35 ACTIVATE=0 FORCE=0
while [ $# -gt 0 ]; do case $1 in --scale) SCALE=$2; shift 2;; --activate) ACTIVATE=1; shift;; --force) FORCE=1; shift;; *) usage;; esac; done
[[ $ID =~ ^[a-z0-9-]{2,24}$ ]] || { echo "id must be 2-24 of a-z 0-9 -"; exit 2; }
[ -f "$SRC" ] || { echo "no such file: $SRC"; exit 2; }
[ $FORCE = 1 ] || [ ! -e "$MAPS/$ID.json" ] || { echo "map $ID exists (use --force to rebuild it)"; exit 2; }
W=$(mktemp -d "$T/work-$ID-XXXX"); trap 'rm -rf "$W"' EXIT
GT=$T/node_modules/.bin/gltf-transform; step() { printf '\n== %s\n' "$*"; }
SECONDS=0
step "collision"; "$T/.venv/bin/python" "$T/collision.py" "$SRC" "$W/coll-raw.glb"
step "desktop visual"; "$GT" optimize "$SRC" "$W/vis.glb" --compress meshopt --texture-compress webp --texture-size 2048 --simplify true --simplify-ratio 0.5 --simplify-error 0.0008 >/dev/null
node "$T/strip.mjs" "$W/vis.glb" "$W/$ID-visual.glb" >/dev/null
step "phone visual"; "$GT" optimize "$SRC" "$W/vism.glb" --compress meshopt --texture-compress webp --texture-size 1024 --simplify true --simplify-ratio 0.15 --simplify-error 0.003 >/dev/null
node "$T/strip.mjs" "$W/vism.glb" "$W/$ID-visual-m.glb" >/dev/null
python3 - "$W/$ID.json" "$NAME" "$ID" "$SCALE" <<'PY'
import json, sys; p, name, i, scale = sys.argv[1:]
json.dump({"name": name + ", HY-World", "visual": f"{i}-visual.glb", "visualMobile": f"{i}-visual-m.glb", "collision": f"{i}-coll.glb",
           "scale": float(scale), "rotate": [0, 0, 0], "offset": [0, 0, 0]}, open(p, "w")); open(p, "a").write("\n")
PY
# pits (floor a player can drop into and never climb out of) filled in the collision: a lid on a small hole, a barrier
# along a large lower area; the check below then fails the map if any are left
step "pits"; (cd "$T" && node fillpits.mjs "$W/coll-raw.glb" "$W/$ID.json" "$W/coll-fill.glb") || { echo "NOT PLAYABLE: pits could not be filled"; exit 1; }
"$GT" meshopt "$W/coll-fill.glb" "$W/$ID-coll.glb" >/dev/null
step "install + check"; for f in "$ID-coll.glb" "$ID-visual.glb" "$ID-visual-m.glb" "$ID.json"; do install -m 644 "$W/$f" "$MAPS/$f"; done
if ! (cd "$T" && node check.mjs "$ID"); then
  echo "NOT PLAYABLE: map files removed, nothing added to the rotation"; rm -f "$MAPS/$ID".json "$MAPS/$ID"-coll.glb "$MAPS/$ID"-visual.glb "$MAPS/$ID"-visual-m.glb; exit 1; fi
# a bot-only Competitive match on it (botcheck.mjs, 2026-11-23): bots walk and shoot with the players' own movement and
# guns, so a map can trap them; it fails when no round finishes or they spend their time gliding past spots they cannot
# walk, and warns of a lopsided side or no plants. BOTCHECK=0 skips it, BOTCHECK_SECS sets its length (180)
step "bots"; if [ "${BOTCHECK:-1}" != 0 ]; then
  if ! (cd "$T" && node botcheck.mjs "$ID" "${BOTCHECK_SECS:-180}"); then
    echo "NOT PLAYABLE (bots): map files removed, nothing added to the rotation"; rm -f "$MAPS/$ID".json "$MAPS/$ID"-coll.glb "$MAPS/$ID"-visual.glb "$MAPS/$ID"-visual-m.glb; exit 1; fi
else echo "skipped (BOTCHECK=0)"; fi
# how well the fighters stand out against it (vischeck.mjs, 2026-11-23): warns when many views of a fighter 10-25 m away
# blend into the background; never fails the map. VISCHECK=0 skips it
step "visibility"; if [ "${VISCHECK:-1}" != 0 ]; then (cd "$T" && node --experimental-websocket vischeck.mjs "$ID") || echo "visibility not measured"; else echo "skipped (VISCHECK=0)"; fi
step "preview"; node --experimental-websocket "$T/preview.mjs" "$ID" "$W/$ID-preview.jpg" && install -m 644 "$W/$ID-preview.jpg" "$MAPS/$ID-preview.jpg" || echo "preview failed (the menu shows a plain background); rerun: node --experimental-websocket tools/preview.mjs $ID maps/$ID-preview.jpg"
[ "$(realpath "$SRC")" = "$(realpath -m "$MAPS/originals/$ID-visual.glb")" ] || install -m 644 "$SRC" "$MAPS/originals/$ID-visual.glb"
ls -la "$MAPS/$ID"* | awk '{printf "  %8.1f MB  %s\n", $5/1048576, $9}'
if [ $ACTIVATE = 1 ]; then
  python3 - "$MAPS/rotation.json" "$ID" <<'PY'
import json, sys; p, i = sys.argv[1:]; d = json.load(open(p)); r = d["rotation"]
if i not in r: r.append(i)
open(p, "w").write(json.dumps(d) + "\n"); print("rotation:", ", ".join(r))
PY
  if [ -n "${RESTART_CMD:-}" ]; then eval "$RESTART_CMD" && echo "game server restarted"; else echo "added to maps/rotation.json: restart the game server to load it (set RESTART_CMD to do it here)"; fi
else echo "not in the rotation yet: rerun with --activate, or add \"$ID\" to maps/rotation.json and restart the game server"; fi
echo "done in ${SECONDS}s"
