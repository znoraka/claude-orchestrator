#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Claude Session Manager"

echo "Building ${APP_NAME}..."
pnpm tauri build

DMG=$(find src-tauri/target/release/bundle/dmg -name '*.dmg' 2>/dev/null | head -1)
APP=$(find src-tauri/target/release/bundle/macos -name '*.app' 2>/dev/null | head -1)

if [[ -n "$APP" ]]; then
  echo ""
  echo "Build complete!"
  echo "  .app: $APP"
  [[ -n "$DMG" ]] && echo "  .dmg: $DMG"
  echo ""
  echo "Installing to /Applications..."
  rm -rf "/Applications/${APP_NAME}.app"
  cp -R "$APP" "/Applications/${APP_NAME}.app"
  echo "Installed! You can now open '${APP_NAME}' from Spotlight."
else
  echo "Build failed — no .app bundle found."
  exit 1
fi
