#Requires -Version 5.1
<#
.SYNOPSIS
    Generates a Tauri signing keypair, updates tauri.conf.json, and sets
    TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD in GitHub Secrets.
    Run this once — everything is automated.
#>
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "=== Tauri Signing Setup ==="
Write-Host ""

# ── 1. Verify gh CLI is authenticated ───────────────────────────────────────
Write-Host "Checking GitHub CLI authentication..."
gh auth status 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "GitHub CLI is not authenticated. Run 'gh auth login' first, then re-run this script."
    exit 1
}
Write-Host "  OK"

# ── 2. Detect repo (owner/name) from git remote ─────────────────────────────
$remote = git remote get-url origin 2>&1
if ($remote -match "github\.com[:/](.+?)(?:\.git)?$") {
    $repo = $Matches[1]
} else {
    Write-Error "Could not detect GitHub repo from 'git remote get-url origin': $remote"
    exit 1
}
Write-Host "  Repo: $repo"

# ── 3. Generate a cryptographically random password ─────────────────────────
$passwordBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
$password = [System.Convert]::ToBase64String($passwordBytes)
Write-Host "  Password: generated (32-byte random, base64-encoded)"

# ── 4. Run tauri signer generate ─────────────────────────────────────────────
# tauri writes the private key to $keyFile and the public key to $keyFile.pub
$keyFile = "$env:TEMP\tauri-signing-$(Get-Random).key"
$pubFile = "$keyFile.pub"
Write-Host ""
Write-Host "Generating keypair..."

npx tauri signer generate -w $keyFile --password $password --ci | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "tauri signer generate failed"; exit 1 }

# ── 5. Read both key files ───────────────────────────────────────────────────
if (-not (Test-Path $keyFile)) { Write-Error "Private key file not created at $keyFile"; exit 1 }
if (-not (Test-Path $pubFile))  { Write-Error "Public key file not created at $pubFile";  exit 1 }

$privateKey = (Get-Content $keyFile -Raw).Trim()
$pubkey     = (Get-Content $pubFile -Raw).Trim()

Remove-Item $keyFile -Force -ErrorAction SilentlyContinue
Remove-Item $pubFile -Force -ErrorAction SilentlyContinue
Write-Host "  Key files read and deleted"
Write-Host "  Public key: $pubkey"

# ── 6. Update src-tauri/tauri.conf.json ──────────────────────────────────────
Write-Host ""
Write-Host "Updating tauri.conf.json..."
$confPath = "src-tauri/tauri.conf.json"
$confRaw = Get-Content $confPath -Raw

# Replace only the pubkey value — preserves all other formatting
$newConfRaw = $confRaw -replace '("pubkey"\s*:\s*")[^"]*(")', "`$1$pubkey`$2"
if ($newConfRaw -eq $confRaw) {
    Write-Error "Could not find 'pubkey' field in tauri.conf.json to update."
    exit 1
}
Set-Content $confPath -Value $newConfRaw -Encoding utf8NoBOM -NoNewline
Write-Host "  pubkey updated"

# ── 7. Set GitHub Secrets ────────────────────────────────────────────────────
Write-Host ""
Write-Host "Setting GitHub Secrets..."
$privateKey | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $repo
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set TAURI_SIGNING_PRIVATE_KEY"; exit 1 }
Write-Host "  TAURI_SIGNING_PRIVATE_KEY set"

$password | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo $repo
if ($LASTEXITCODE -ne 0) { Write-Error "Failed to set TAURI_SIGNING_PRIVATE_KEY_PASSWORD"; exit 1 }
Write-Host "  TAURI_SIGNING_PRIVATE_KEY_PASSWORD set"

# ── 8. Commit and push tauri.conf.json ───────────────────────────────────────
Write-Host ""
Write-Host "Committing tauri.conf.json..."
git add src-tauri/tauri.conf.json
git commit -m "Update Tauri updater public key"
git push
Write-Host "  Pushed"

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Done! ==="
Write-Host "The signing keypair is configured. Push a tag to trigger a release:"
Write-Host ""
Write-Host "  git tag v1.0.6 && git push origin v1.0.6"
Write-Host ""
