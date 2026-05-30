# jg-local-relay installer — Windows. Run in PowerShell:
#
#   iwr https://cp.jaagaa.ai/install-relay.ps1 -UseBasicParsing | iex
#
# Or with the token + projects pre-set:
#
#   $env:JG_RELAY_TOKEN="…"; $env:JG_RELAY_PROJECTS="jaagaa,cricket"
#   iwr https://cp.jaagaa.ai/install-relay.ps1 -UseBasicParsing | iex
#
# Re-running upgrades in place.

$ErrorActionPreference = "Stop"

$CpUrl    = if ($env:JG_CP_URL)         { $env:JG_CP_URL }         else { "wss://cp.jaagaa.ai/relay" }
$SrcUrl   = if ($env:JG_RELAY_SRC)      { $env:JG_RELAY_SRC }      else { "https://cp.jaagaa.ai/relay-bundle.tar.gz" }
$Projects = if ($env:JG_RELAY_PROJECTS) { $env:JG_RELAY_PROJECTS } else { "" }
$Token    = if ($env:JG_RELAY_TOKEN)    { $env:JG_RELAY_TOKEN }    else { "" }
$RelayId  = if ($env:JG_RELAY_ID)       { $env:JG_RELAY_ID }       else { ($env:COMPUTERNAME).ToLower() }

# Node is required.
$Node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $Node) {
  Write-Error "jg-local-relay: Node.js 20+ is required (install from https://nodejs.org) — aborting."
  exit 1
}
$NodeBin = $Node.Source

# Prompt for missing token interactively.
if (-not $Token) {
  $Token = Read-Host "Paste your JG_RELAY_TOKEN (from cp.jaagaa.ai - Settings - Relays)"
}
if (-not $Token) {
  Write-Error "jg-local-relay: JG_RELAY_TOKEN is required."
  exit 1
}
if (-not $Projects) {
  $Projects = Read-Host "Projects this machine serves (comma-separated, blank = all)"
}

$Prefix = Join-Path $env:LOCALAPPDATA "jg-local-relay"
$LogDir = Join-Path $Prefix "logs"
New-Item -ItemType Directory -Path $Prefix, $LogDir -Force | Out-Null

Write-Host "-> Downloading agent bundle from $SrcUrl"
$Tarball = Join-Path $env:TEMP "jg-local-relay-bundle.tar.gz"
Invoke-WebRequest -Uri $SrcUrl -OutFile $Tarball -UseBasicParsing
# tar is shipped in Win10+; expand into $Prefix.
tar -xzf $Tarball -C $Prefix

Write-Host "-> Installing Node dependencies (pm2 + ws — this can take 10-30s)"
# pm2 is a hard dep of jg-local-relay (see its package.json), so this single
# install also brings pm2 into $Prefix\node_modules — no separate global
# install step. JG_PM2_BIN below pins the relay to this local copy.
# --silent dropped: with pm2 the install pulls many packages and went
# minutes-mute, looking hung. --loglevel=warn keeps the output sane.
Push-Location $Prefix
& npm install --omit=dev --no-fund --no-audit --loglevel=warn
Pop-Location

# Local pm2 binary owned by this relay install. npm on Windows writes a
# pm2.cmd shim in node_modules\.bin; either path works for child_process.spawn.
$Pm2Bin = Join-Path $Prefix "node_modules\.bin\pm2.cmd"

# Wrap the relay launch in a small VBS so it runs hidden (no console window
# at logon). The vbs invokes node with our env baked in.
$VbsPath = Join-Path $Prefix "launch.vbs"
$IndexJs = Join-Path $Prefix "src\index.js"
$OutLog  = Join-Path $LogDir "out.log"
$ErrLog  = Join-Path $LogDir "err.log"

$VbsContent = @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("Process").Item("JG_CP_URL")         = "$CpUrl"
sh.Environment("Process").Item("JG_RELAY_TOKEN")    = "$Token"
sh.Environment("Process").Item("JG_RELAY_ID")       = "$RelayId"
sh.Environment("Process").Item("JG_RELAY_PROJECTS") = "$Projects"
sh.Environment("Process").Item("JG_PM2_BIN")        = "$Pm2Bin"
sh.Run "cmd /c """"$NodeBin"" ""$IndexJs"" >> ""$OutLog"" 2>> ""$ErrLog""", 0, False
"@
Set-Content -Path $VbsPath -Value $VbsContent -Encoding ASCII

# Register a Scheduled Task that runs the vbs at logon AND keeps it alive.
$TaskName = "JaagaaLocalRelay"
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
$Action  = "wscript.exe `"$VbsPath`""
schtasks /Create /SC ONLOGON /TN $TaskName /TR $Action /RL LIMITED /F | Out-Null
schtasks /Run /TN $TaskName | Out-Null

Write-Host "-> Verifying handshake..."
for ($i = 0; $i -lt 10; $i++) {
  if (Test-Path $OutLog) {
    if ((Get-Content $OutLog -Tail 200 -ErrorAction SilentlyContinue) -match "registered with cp") {
      Write-Host "OK Connected to $CpUrl as `"$RelayId`" (projects: $(if ($Projects) { $Projects } else { 'all' }))"
      exit 0
    }
  }
  Start-Sleep -Seconds 1
}
Write-Warning "Did not see 'registered with cp' in $OutLog within 10s — check the log for errors."
if (Test-Path $OutLog) { Get-Content $OutLog -Tail 20 }
if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 20 }
exit 1
