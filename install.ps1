# Enphase Tesla installer (Windows).
#   powershell -ExecutionPolicy Bypass -File install.ps1            # asks Docker or Node
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Mode docker
# Safe to re-run: keeps existing .env / esphome\secrets.yaml values unless you change them.
param(
  [ValidateSet('docker', 'node', '')] [string]$Mode = '',
  [switch]$SkipFlash
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Ask($prompt, $default = '') {
  $v = Read-Host ($(if ($default) { "$prompt [$default]" } else { $prompt }))
  if ([string]::IsNullOrWhiteSpace($v)) { $default } else { $v.Trim() }
}
function AskSecret($prompt) {
  $s = Read-Host $prompt -AsSecureString
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}
function RandomToken($bytes = 18) {
  $b = New-Object byte[] $bytes; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b) -replace '[+/=]', ''
}
function GetEnv($key) {
  $m = Select-String -Path .env -Pattern "^$key=(.*)$" | Select-Object -First 1
  if ($m) { $m.Matches[0].Groups[1].Value } else { '' }
}
function SetEnv($key, $value) {
  $lines = Get-Content .env
  if ($lines -match "^$key=") { $lines = $lines -replace "^$key=.*$", "$key=$value" } else { $lines += "$key=$value" }
  Set-Content .env $lines -Encoding utf8
}

Write-Host "`n== Enphase Tesla setup ==`n"

# 1. How to run
$hasDocker = [bool](Get-Command docker -ErrorAction SilentlyContinue)
$hasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
if (-not $Mode) {
  $def = if ($hasDocker) { 'docker' } else { 'node' }
  $Mode = Ask 'Run with docker or node?' $def
}
if ($Mode -eq 'docker' -and -not $hasDocker) { throw 'Docker not found. Install Docker Desktop (https://docs.docker.com/desktop/) or use -Mode node.' }
if ($Mode -eq 'node') {
  if (-not $hasNode) { throw 'Node.js not found. Install Node 24+ (https://nodejs.org) or use -Mode docker.' }
  $major = [int]((node -v).TrimStart('v').Split('.')[0])
  if ($major -lt 24) { throw "Node $major found; Node 24+ is required (uses node:sqlite)." }
}

# 2. .env
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host 'Created .env from .env.example' }
Write-Host "`n-- Enphase (press Enter to keep the value in brackets) --"
SetEnv ENLIGHTEN_EMAIL (Ask 'Enlighten email' (GetEnv ENLIGHTEN_EMAIL))
if (-not (GetEnv ENLIGHTEN_PASSWORD) -or (Ask 'Change Enlighten password? (y/N)' 'n') -eq 'y') {
  SetEnv ENLIGHTEN_PASSWORD (AskSecret 'Enlighten password')
}
SetEnv ENLIGHTEN_SITE_ID (Ask 'Enlighten site id (number in the Enlighten URL)' (GetEnv ENLIGHTEN_SITE_ID))
SetEnv GATEWAY_SERIAL (Ask 'IQ Gateway serial (Enlighten > Devices > Gateway)' (GetEnv GATEWAY_SERIAL))
$gw = GetEnv GATEWAY_HOST
if ($gw -eq 'envoy.local' -or -not $gw) {
  try { $gw = ([Net.Dns]::GetHostAddresses('envoy.local') | Where-Object AddressFamily -eq 'InterNetwork' | Select-Object -First 1).IPAddressToString } catch {}
}
SetEnv GATEWAY_HOST (Ask 'IQ Gateway IP (Docker needs an IP, not envoy.local)' $gw)
SetEnv LOCATION (Ask 'ZIP code or city (weather forecast)' (GetEnv LOCATION))

# 3. Tesla BLE bridge (optional)
Write-Host "`n-- Tesla Bluetooth bridge (M5Stack NanoC6 running esphome-tesla-ble) --"
$tesla = (Ask 'Set up the Tesla bridge? (y/N)' $(if (GetEnv TESLA_BLE_HOST) { 'y' } else { 'n' })) -eq 'y'
if ($tesla) {
  if (-not (GetEnv TESLA_BLE_USER)) { SetEnv TESLA_BLE_USER 'enphase' }
  if (-not (GetEnv TESLA_BLE_PASSWORD)) { SetEnv TESLA_BLE_PASSWORD (RandomToken) }
  SetEnv EV_CAR_KWH (Ask 'Car usable battery size, kWh' $(if (GetEnv EV_CAR_KWH) { GetEnv EV_CAR_KWH } else { '75' }))

  $sec = 'esphome\secrets.yaml'
  if (-not (Test-Path $sec)) {
    $ssid = Ask 'Wi-Fi name (2.4 GHz) for the bridge'
    $wpass = AskSecret 'Wi-Fi password'
    $vin = (Ask 'Car VIN (17 characters)').ToUpper()
    $mac = Ask 'Car Bluetooth MAC (AA:BB:CC:DD:EE:FF; leave blank to find it later)' '00:00:00:00:00:00'
    $key = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($key)
    @(
      "wifi_ssid: `"$ssid`"", "wifi_password: `"$wpass`"", "wifi_hotspot_password: `"$(RandomToken 12)`"",
      "api_encryption_key: `"$([Convert]::ToBase64String($key))`"",
      "web_username: `"$(GetEnv TESLA_BLE_USER)`"", "web_password: `"$(GetEnv TESLA_BLE_PASSWORD)`"",
      "ble_mac_address: `"$mac`"", "tesla_vin: `"$vin`""
    ) | Set-Content $sec -Encoding utf8
    Write-Host "Wrote $sec (git-ignored)"
  }

  if (-not $SkipFlash -and (Ask 'Flash the NanoC6 over USB now? (y/N)' 'n') -eq 'y') {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'uv not found: winget install astral-sh.uv, then re-run.' }
    if (-not (Test-Path .venv-esphome)) {
      uv venv --python 3.12 .venv-esphome
      uv pip install --python .venv-esphome\Scripts\python.exe esphome==2026.9.1
    }
    $port = Ask 'USB serial port (Device Manager > Ports)' 'COM3'
    $env:ESPHOME_ESP_IDF_PREFIX = 'C:\esp\idf'  # short path: ESP-IDF breaks on long Windows paths
    & .venv-esphome\Scripts\esphome.exe run esphome\tesla-ble.yaml --device $port --no-logs
    Write-Host 'Flashed. Find the bridge IP in your router (hostname tesla-ble).'
  }
  SetEnv TESLA_BLE_HOST (Ask 'Bridge IP address' (GetEnv TESLA_BLE_HOST))
  Write-Host 'Pairing: sit in the car, open http://<bridge-ip>/ (user/password from .env), press "Pair BLE Key", tap your key card on the console, confirm on the screen.'
}

# 4. Start
Write-Host "`n-- Starting --"
if ($Mode -eq 'docker') {
  docker compose up -d --build
} else {
  npm ci --omit=dev
  if ((Ask 'Start automatically at logon? (Y/n)' 'y') -eq 'y') { & "$root\scripts\install-autostart.ps1" }
  else { Write-Host 'Start it with: npm start' }
}
Write-Host "`nDashboard: http://localhost:$(if (GetEnv PORT) { GetEnv PORT } else { '8787' })"
Write-Host 'Push notifications: install the ntfy app and subscribe to the topic shown on the EV tab.'
Write-Host 'Keep this PC awake (Settings > System > Power > Sleep: Never) for per-second logging.'
