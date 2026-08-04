# Ensures the Telegram bridge is running for the currently logged-in user.
# Intended for the "Herdr Telegram Bridge Watchdog" Scheduled Task.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$daemonEntry = Join-Path $repoRoot "dist\index.js"
$nodeCandidates = @(
  (Get-Command node.exe -ErrorAction SilentlyContinue).Source,
  "C:\\nvm4w\\nodejs\\node.exe",
  (Join-Path $env:ProgramFiles "nodejs\\node.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
$node = $nodeCandidates | Select-Object -First 1

if (-not $node) {
  throw "Node.js was not found. Install Node.js or update the nodeCandidates list in this script."
}

$status = (& $node $daemonEntry "--status" 2>&1 | Out-String).Trim()
if ($status -match "^Daemon: running") {
  exit 0
}

if ($status -notmatch "^Daemon: not running") {
  throw "Unable to determine daemon status: $status"
}

Start-Process -FilePath $node -ArgumentList @($daemonEntry, "--daemon") -WorkingDirectory $repoRoot -WindowStyle Hidden
