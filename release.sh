#!/usr/bin/env bash
set -euo pipefail

REPO="znoraka/claude-orchestrator"

# ── Show commits since last tag ────────────────────────────────────
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LAST_TAG" ]]; then
  echo "Commits since ${LAST_TAG}:"
  git log "${LAST_TAG}..HEAD" --oneline
else
  echo "No previous tag found. All commits:"
  git log --oneline
fi

# ── Current version ────────────────────────────────────────────────
CURRENT=$(python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
echo ""
echo "Current version: ${CURRENT}"

# ── Prompt for bump type ───────────────────────────────────────────
read -r -p "Bump type? [ma]jor / [mi]nor / [p]atch (default: patch): " BUMP_TYPE
BUMP_TYPE="${BUMP_TYPE:-p}"

NEW_VERSION=$(python3 - <<PYEOF
major, minor, patch = map(int, "${CURRENT}".split("."))
bump = "${BUMP_TYPE}".lower()
if bump in ("ma", "major"):
    major += 1; minor = 0; patch = 0
elif bump in ("mi", "minor"):
    minor += 1; patch = 0
else:
    patch += 1
print(f"{major}.{minor}.{patch}")
PYEOF
)

# ── Confirm ────────────────────────────────────────────────────────
echo ""
read -r -p "Bumping ${CURRENT} → ${NEW_VERSION}. Proceed? [Y/n]: " CONFIRM
CONFIRM="${CONFIRM:-Y}"
if [[ "$(echo "${CONFIRM}" | tr '[:upper:]' '[:lower:]')" != "y" ]]; then
  echo "Aborted."
  exit 0
fi

# ── Bump version in all files ──────────────────────────────────────
python3 - <<PYEOF
import json, re, pathlib

new_ver = "${NEW_VERSION}"

conf = pathlib.Path("src-tauri/tauri.conf.json")
data = json.loads(conf.read_text())
data["version"] = new_ver
conf.write_text(json.dumps(data, indent=2) + "\n")

pkg = pathlib.Path("package.json")
pkg_data = json.loads(pkg.read_text())
pkg_data["version"] = new_ver
pkg.write_text(json.dumps(pkg_data, indent=2) + "\n")

cargo = pathlib.Path("src-tauri/Cargo.toml")
text = cargo.read_text()
text = re.sub(r'^(version\s*=\s*")[^"]+(")', rf'\g<1>{new_ver}\2', text, count=1, flags=re.MULTILINE)
cargo.write_text(text)

print(f"Bumped version to {new_ver}")
PYEOF

# ── Commit the version bump ────────────────────────────────────────
git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml
git commit -m "Bump version to ${NEW_VERSION}"

# ── Build + publish ────────────────────────────────────────────────
./build.sh --release --no-bump

# ── Push commits ──────────────────────────────────────────────────
git push

# ── Print release URL ──────────────────────────────────────────────
RELEASE_URL=$(gh release view "v${NEW_VERSION}" --repo "${REPO}" --json url -q .url 2>/dev/null || echo "")
echo ""
if [[ -n "$RELEASE_URL" ]]; then
  echo "Release published: ${RELEASE_URL}"
else
  echo "Release v${NEW_VERSION} published on GitHub."
fi
