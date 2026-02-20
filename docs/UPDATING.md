# StageView Update Process

## How updates work

1. A new version tag is pushed to GitHub (e.g. `v1.0.6`)
2. GitHub Actions builds the app, signs it, and creates a release
3. The release includes `latest.json` — a small file the app checks to know if a newer version exists
4. When a user opens StageView, it silently checks `latest.json`
5. If a newer version is available, the update downloads and installs automatically in the background

---

## Releasing a new version

**1. Bump the version number in `src-tauri/tauri.conf.json`:**
```json
"version": "1.0.6"
```

**2. Commit, tag, and push:**
```powershell
git add src-tauri/tauri.conf.json
git commit -m "Bump version to 1.0.6"
git push
git tag v1.0.6
git push origin v1.0.6
```

That's it. GitHub Actions handles the rest — building, signing, and publishing the release.

---

## If the signing keys ever need to be regenerated

Run this from the repo root (requires `gh` CLI to be logged in):

```powershell
.\setup-signing.ps1
```

This will:
- Generate a new keypair
- Update the public key in `tauri.conf.json`
- Set the private key and password as GitHub Secrets
- Commit and push the change

No manual steps required.

---

## Where things live

| What | Where |
|---|---|
| Release workflow | `.github/workflows/release.yml` |
| Signing setup script | `setup-signing.ps1` |
| App version | `src-tauri/tauri.conf.json` → `"version"` |
| Updater public key | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |
| Update check endpoint | `https://github.com/keithhegstad/StageView/releases/latest/download/latest.json` |
