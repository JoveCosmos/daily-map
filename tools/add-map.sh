#!/usr/bin/env bash
# add-map.sh: a world generated on Tencent's HY-World site -> a playable map of the daily rotation, in one command.
#   tools/add-map.sh <upload.glb> <id> "<Display name>" [--scale 35] [--activate] [--force]
# Steps: collision (200k faces), desktop visual (meshopt, webp 2048, half the triangles), phone visual (webp 1024,
# ~15%), unused textures stripped, map json, playability check (fails the map when it cannot be played), menu
# preview, raw upload kept in maps/originals. --activate appends the id to maps/rotation.json and restarts the game
# server (players are put straight back into the room). Nothing reaches maps/ until every step has passed.
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
"$GT" meshopt "$W/coll-raw.glb" "$W/$ID-coll.glb" >/dev/null
step "desktop visual"; "$GT" optimize "$SRC" "$W/vis.glb" --compress meshopt --texture-compress webp --texture-size 2048 --simplify true --simplify-ratio 0.5 --simplify-error 0.0008 >/dev/null
node "$T/strip.mjs" "$W/vis.glb" "$W/$ID-visual.glb" >/dev/null
step "phone visual"; "$GT" optimize "$SRC" "$W/vism.glb" --compress meshopt --texture-compress webp --texture-size 1024 --simplify true --simplify-ratio 0.15 --simplify-error 0.003 >/dev/null
node "$T/strip.mjs" "$W/vism.glb" "$W/$ID-visual-m.glb" >/dev/null
python3 - "$W/$ID.json" "$NAME" "$ID" "$SCALE" <<'PY'
import json, sys; p, name, i, scale = sys.argv[1:]
json.dump({"name": name + ", HY-World", "visual": f"{i}-visual.glb", "visualMobile": f"{i}-visual-m.glb", "collision": f"{i}-coll.glb",
           "scale": float(scale), "rotate": [0, 0, 0], "offset": [0, 0, 0]}, open(p, "w")); open(p, "a").write("\n")
PY
step "install + check"; for f in "$ID-coll.glb" "$ID-visual.glb" "$ID-visual-m.glb" "$ID.json"; do install -m 644 "$W/$f" "$MAPS/$f"; done
if ! (cd "$T" && node check.mjs "$ID"); then
  echo "NOT PLAYABLE: map files removed, nothing added to the rotation"; rm -f "$MAPS/$ID".json "$MAPS/$ID"-coll.glb "$MAPS/$ID"-visual.glb "$MAPS/$ID"-visual-m.glb; exit 1; fi
step "preview"; node --experimental-websocket "$T/preview.mjs" "$ID" "$W/$ID-preview.jpg" && install -m 644 "$W/$ID-preview.jpg" "$MAPS/$ID-preview.jpg" || echo "preview failed (the menu shows a plain background); rerun: node --experimental-websocket tools/preview.mjs $ID maps/$ID-preview.jpg"
[ "$(realpath "$SRC")" = "$(realpath -m "$MAPS/originals/$ID-visual.glb")" ] || install -m 644 "$SRC" "$MAPS/originals/$ID-visual.glb"
ls -la "$MAPS/$ID"* | awk '{printf "  %8.1f MB  %s\n", $5/1048576, $9}'
if [ $ACTIVATE = 1 ]; then
  python3 - "$MAPS/rotation.json" "$ID" <<'PY'
import json, sys; p, i = sys.argv[1:]; d = json.load(open(p)); r = d["rotation"]
if i not in r: r.append(i)
open(p, "w").write(json.dumps(d) + "\n"); print("rotation:", ", ".join(r))
PY
  systemctl restart fps-poc-server; echo "game server restarted"
else echo "not in the rotation yet: rerun with --activate, or add \"$ID\" to maps/rotation.json and restart fps-poc-server"; fi
echo "done in ${SECONDS}s"
