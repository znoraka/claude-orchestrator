#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Claude Session Manager"
REPO="znoraka/claude-orchestrator"
BUNDLE_DIR="src-tauri/target/release/bundle"
RELEASE=false

# ── Parse flags ───────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --release) RELEASE=true ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Load signing env ──────────────────────────────────────────────
if [[ -f .env.signing ]]; then
  echo "Loading signing config from .env.signing..."
  # shellcheck disable=SC1091
  source .env.signing
else
  echo "Warning: .env.signing not found — build will be unsigned."
fi

# ── Read version from tauri.conf.json ─────────────────────────────
VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
TAG="v${VERSION}"
echo "Building ${APP_NAME} ${TAG}..."

# ── Build ─────────────────────────────────────────────────────────
pnpm tauri build

# ── Locate artifacts ──────────────────────────────────────────────
DMG=$(find "${BUNDLE_DIR}/dmg" -name '*.dmg' 2>/dev/null | head -1)
APP=$(find "${BUNDLE_DIR}/macos" -name '*.app' 2>/dev/null | head -1)
TARGZ=$(find "${BUNDLE_DIR}/macos" -name '*.tar.gz' 2>/dev/null | grep -v '\.sig$' | head -1)
SIG=$(find "${BUNDLE_DIR}/macos" -name '*.tar.gz.sig' 2>/dev/null | head -1)

if [[ -z "$APP" ]]; then
  echo "Build failed — no .app bundle found."
  exit 1
fi

# ── Create tar.gz + sig for updater if not produced by Tauri ────
if [[ -z "$TARGZ" ]]; then
  TARGZ_NAME="${APP_NAME}_${VERSION}_aarch64.app.tar.gz"
  TARGZ="${BUNDLE_DIR}/macos/${TARGZ_NAME}"
  echo "Creating updater tarball: ${TARGZ_NAME}..."
  tar -czf "$TARGZ" -C "${BUNDLE_DIR}/macos" "${APP_NAME}.app"
fi

if [[ -z "$SIG" && -n "$TAURI_SIGNING_PRIVATE_KEY" ]]; then
  SIG="${TARGZ}.sig"
  echo "Signing tarball..."
  pnpm tauri signer sign --private-key "$TAURI_SIGNING_PRIVATE_KEY" --password "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" "$TARGZ"
fi

echo ""
echo "Build complete!"
echo "  .app:    $APP"
[[ -n "$DMG" ]]   && echo "  .dmg:    $DMG"
[[ -n "$TARGZ" ]] && echo "  .tar.gz: $TARGZ"
[[ -n "$SIG" ]]   && echo "  .sig:    $SIG"

# ── Install locally ──────────────────────────────────────────────
echo ""
echo "Installing to /Applications..."
rm -rf "/Applications/${APP_NAME}.app"
cp -R "$APP" "/Applications/${APP_NAME}.app"
echo "Installed!"

# ── Create GitHub Release (optional) ─────────────────────────────
if [[ "$RELEASE" == true ]]; then
  if [[ -z "$TARGZ" || -z "$SIG" ]]; then
    echo "Error: .tar.gz or .sig not found — cannot create release."
    exit 1
  fi

  SIGNATURE=$(cat "$SIG")
  TARGZ_NAME=$(basename "$TARGZ")
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${TARGZ_NAME}"
  PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Generate latest.json for Tauri updater
  cat > latest.json <<EOF
{
  "version": "${VERSION}",
  "notes": "Release ${TAG}",
  "pub_date": "${PUB_DATE}",
  "platforms": {
    "darwin-aarch64": {
      "signature": "${SIGNATURE}",
      "url": "${DOWNLOAD_URL}"
    },
    "darwin-x86_64": {
      "signature": "${SIGNATURE}",
      "url": "${DOWNLOAD_URL}"
    }
  }
}
EOF

  echo ""
  echo "Creating GitHub Release ${TAG}..."

  ASSETS=("$TARGZ" "$SIG" "latest.json")
  [[ -n "$DMG" ]] && ASSETS+=("$DMG")

  gh release create "$TAG" "${ASSETS[@]}" \
    --repo "$REPO" \
    --title "${APP_NAME} ${TAG}" \
    --notes "Release ${TAG}" \
    --latest

  rm -f latest.json
  echo "Release ${TAG} published!"
else
  echo ""
  echo "Skipping GitHub Release (use --release to publish)."
fi
