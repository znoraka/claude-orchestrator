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

# ── Bump patch version (only on --release) ────────────────────────
if [[ "$RELEASE" == true ]]; then
python3 - <<'PYEOF'
import json, re, pathlib

# tauri.conf.json
conf = pathlib.Path("src-tauri/tauri.conf.json")
data = json.loads(conf.read_text())
major, minor, patch = map(int, data["version"].split("."))
patch += 1
new_ver = f"{major}.{minor}.{patch}"
data["version"] = new_ver
conf.write_text(json.dumps(data, indent=2) + "\n")

# package.json
pkg = pathlib.Path("package.json")
pkg_data = json.loads(pkg.read_text())
pkg_data["version"] = new_ver
pkg.write_text(json.dumps(pkg_data, indent=2) + "\n")

# Cargo.toml — patch first occurrence of version = "x.y.z" under [package]
cargo = pathlib.Path("src-tauri/Cargo.toml")
text = cargo.read_text()
text = re.sub(r'^(version\s*=\s*")[^"]+(")', rf'\g<1>{new_ver}\2', text, count=1, flags=re.MULTILINE)
cargo.write_text(text)

print(f"Bumped version to {new_ver}")
PYEOF
fi

# ── Read version from tauri.conf.json ─────────────────────────────
VERSION=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
TAG="v${VERSION}"
echo "Building ${APP_NAME} ${TAG}..."

# ── Build ─────────────────────────────────────────────────────────
pnpm tauri build --bundles app

# ── Create DMG manually (Tauri --bundles dmg is broken on macOS 26) ──
DMG_NAME="${APP_NAME}_${VERSION}_aarch64.dmg"
DMG_STAGING="$(mktemp -d)"
DMG_OUTPUT_DIR="${BUNDLE_DIR}/dmg"
DMG_OUTPUT="${DMG_OUTPUT_DIR}/${DMG_NAME}"

echo "Creating DMG: ${DMG_NAME}..."
cp -R "${BUNDLE_DIR}/macos/${APP_NAME}.app" "${DMG_STAGING}/"
ln -s /Applications "${DMG_STAGING}/Applications"
mkdir -p "${DMG_OUTPUT_DIR}"
hdiutil create \
  -volname "${APP_NAME}" \
  -srcfolder "${DMG_STAGING}" \
  -ov \
  -format UDZO \
  -o "${DMG_OUTPUT}"
rm -rf "${DMG_STAGING}"
echo "DMG created: ${DMG_OUTPUT}"

# ── Locate artifacts ──────────────────────────────────────────────
DMG=$(find "${BUNDLE_DIR}/dmg" -name '*.dmg' 2>/dev/null | head -1)
APP=$(find "${BUNDLE_DIR}/macos" -name '*.app' 2>/dev/null | head -1)
TARGZ=$(find "${BUNDLE_DIR}/macos" -name "*${VERSION}*.tar.gz" 2>/dev/null | head -1)
SIG=$(find "${BUNDLE_DIR}/macos" -name "*${VERSION}*.tar.gz.sig" 2>/dev/null | head -1)

if [[ -z "$APP" ]]; then
  echo "Build failed — no .app bundle found."
  exit 1
fi

# ── Create tar.gz + sig for updater if not produced by Tauri ────
if [[ -z "$TARGZ" ]]; then
  TARGZ_NAME="${APP_NAME// /.}_${VERSION}_aarch64.app.tar.gz"
  TARGZ="${BUNDLE_DIR}/macos/${TARGZ_NAME}"
  echo "Creating updater tarball: ${TARGZ_NAME}..."
  COPYFILE_DISABLE=1 tar -czf "$TARGZ" -C "${BUNDLE_DIR}/macos" "${APP_NAME}.app"
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

# ── Open DMG for installation ─────────────────────────────────────
if [[ -n "$DMG" ]]; then
  echo ""
  echo "Opening DMG for installation..."
  open "$DMG"
else
  echo ""
  echo "No DMG found — manually copy $APP to /Applications/."
fi

# ── Create GitHub Release (optional) ─────────────────────────────
if [[ "$RELEASE" == true ]]; then
  if [[ -z "$TARGZ" || -z "$SIG" ]]; then
    echo "Error: .tar.gz or .sig not found — cannot create release."
    exit 1
  fi

  SIGNATURE=$(cat "$SIG")
  TARGZ_NAME=$(basename "$TARGZ")
  TARGZ_NAME_URL="${TARGZ_NAME// /.}"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${TARGZ_NAME_URL}"
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
