#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist-plugin"
STAGE="$OUT_DIR/dispatcharr-live-sports"
ZIP="$OUT_DIR/dispatcharr-live-sports.zip"

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

for f in plugin.json plugin.py client.py sync.py lifecycle.py store.py README.md LICENSE; do
  cp "$ROOT/dispatcharr-live-sports/$f" "$STAGE/$f"
done

mkdir -p "$OUT_DIR"
(cd "$OUT_DIR" && zip -r -q dispatcharr-live-sports.zip dispatcharr-live-sports)
rm -rf "$STAGE"
echo "$ZIP"
unzip -l "$ZIP"
