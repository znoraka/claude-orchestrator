Create a new release of Claude Orchestrator. Analyze all changes since the last release, bump the version, build, and publish.

## Steps

### 1. Determine the last release version and changes

- Read the current version from `src-tauri/tauri.conf.json`
- Run `git log` to find the last release tag (tags matching `vX.Y.Z`)
- Run `git log <last-tag>..HEAD --oneline` to get all commits since the last release
- If there is no previous tag, use all commits

### 2. Decide the version bump

Based on the commits since the last release:

- **Major** (X.0.0): Breaking changes, major rewrites, incompatible API changes
- **Minor** (0.X.0): New features, significant enhancements, new UI panels
- **Patch** (0.0.X): Bug fixes, small tweaks, dependency updates, refactoring

Present the commit list and your recommended bump to the user. Ask them to confirm the new version before proceeding.

### 3. Bump the version in all files

Update the version string in these files — they must all match:

- `src-tauri/tauri.conf.json` → `"version"` field
- `src-tauri/Cargo.toml` → `version` field under `[package]`
- `package.json` → `"version"` field

### 4. Commit the version bump

Create a commit with message: `Bump version to X.Y.Z`

Do NOT push yet.

### 5. Build and release

Run the build script with the release flag:

```bash
./build.sh --release
```

This will:
- Source `.env.signing` for code signing credentials
- Build the app (signed + notarized)
- Install locally to `/Applications`
- Generate `latest.json` for the auto-updater
- Create a GitHub Release tagged `vX.Y.Z` with all artifacts

### 6. Push

After the release is created successfully, push the version bump commit:

```bash
git push
```

### 7. Summary

Report back:
- Previous version → new version
- Number of commits included
- GitHub Release URL (from `gh release view` output)
