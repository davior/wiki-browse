#!/usr/bin/env bash
#
# Assemble a deployable copy of WikiBrowse into ./dist, and optionally sync it
# to a host. WikiBrowse is a static site (no build step) — this just gathers the
# files a server needs and makes sure config.js is in place.
#
# Usage:
#   ./deploy.sh                                   # build ./dist
#   ./deploy.sh user@host:/var/www/wikibrowse     # build, then rsync to a target
#   OUT=public ./deploy.sh                        # build into ./public instead
#
set -euo pipefail
cd "$(dirname "$0")"

OUT="${OUT:-dist}"
TARGET="${1:-}"
ASSETS=(index.html css js config.js)

# config.js is gitignored (it holds the deploy-specific connection). The app
# loads it via <script>, so it must exist — seed it from the template if absent.
if [[ ! -f config.js ]]; then
  echo "config.js not found — seeding it from config.example.js." >&2
  echo "  Edit config.js to set your wiki before deploying for real." >&2
  cp config.example.js config.js
fi

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "${ASSETS[@]}" "$OUT"/
echo "Built $OUT/ ($(du -sh "$OUT" | cut -f1))."

# If a destination was given, push the build there with rsync.
if [[ -n "$TARGET" ]]; then
  echo "Syncing $OUT/ → $TARGET …"
  rsync -av --delete "$OUT"/ "$TARGET"
  echo "Deployed to $TARGET."
else
  echo "Serve it with:  cd $OUT && python3 -m http.server 8000"
fi
