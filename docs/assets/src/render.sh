#!/usr/bin/env bash
# Render every picture in docs/assets from its source here, with headless
# Chrome at 2x: ./docs/assets/src/render.sh [name ...]   (default: all)
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
names=("$@"); [ ${#names[@]} -gt 0 ] || names=($(ls *.html | sed 's/\.html$//'))
for n in "${names[@]}"; do
  size=$(grep -o 'window-size=[0-9]*,[0-9]*' "$n.html" | head -1 | cut -d= -f2)
  "$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=2 --window-size="$size" \
    --screenshot="../$n.png" "file://$PWD/$n.html" >/dev/null 2>&1
  echo "$n.png ($size at 2x)"
done
