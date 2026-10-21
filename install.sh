#!/usr/bin/env bash
# Solar Surplus EV installer (Linux / macOS / Raspberry Pi).
#   ./install.sh            # asks docker or node
#   ./install.sh docker
# Safe to re-run: keeps existing .env / esphome/secrets.yaml values unless you change them.
set -euo pipefail
cd "$(dirname "$0")"

ask() { local p="$1" d="${2:-}" v; read -r -p "$p${d:+ [$d]}: " v; echo "${v:-$d}"; }
ask_secret() { local v; read -r -s -p "$1: " v; echo >&2; echo "$v"; }
token() { head -c "${1:-18}" /dev/urandom | base64 | tr -d '+/=\n'; }
get_env() { sed -n "s/^$1=//p" .env | head -1; }
set_env() {
  local k="$1" v="$2" tmp; tmp=$(mktemp)
  if grep -q "^$k=" .env; then awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > "$tmp" && mv "$tmp" .env
  else echo "$k=$v" >> .env; rm -f "$tmp"; fi
}

echo; echo "== Solar Surplus EV setup =="; echo

mode="${1:-}"
if [ -z "$mode" ]; then mode=$(ask "Run with docker or node?" "$(command -v docker >/dev/null && echo docker || echo node)"); fi
case "$mode" in
  docker) command -v docker >/dev/null || { echo "Docker not found: https://docs.docker.com/engine/install/"; exit 1; } ;;
  node)
    command -v node >/dev/null || { echo "Node.js 24+ not found: https://nodejs.org"; exit 1; }
    [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ] || { echo "Node 24+ required (uses node:sqlite)"; exit 1; } ;;
  *) echo "mode must be docker or node"; exit 1 ;;
esac

[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example"; }
echo; echo "-- Enphase (Enter keeps the value in brackets) --"
set_env ENLIGHTEN_EMAIL "$(ask 'Enlighten email' "$(get_env ENLIGHTEN_EMAIL)")"
if [ -z "$(get_env ENLIGHTEN_PASSWORD)" ] || [ "$(ask 'Change Enlighten password? (y/N)' n)" = y ]; then
  set_env ENLIGHTEN_PASSWORD "$(ask_secret 'Enlighten password')"
fi
set_env GATEWAY_SERIAL "$(ask 'IQ Gateway serial (Enphase app > System > Devices > Gateway)' "$(get_env GATEWAY_SERIAL)")"
gw=$(get_env GATEWAY_HOST)
if [ -z "$gw" ] || [ "$gw" = envoy.local ]; then
  gw=$( (getent hosts envoy.local 2>/dev/null || dscacheutil -q host -a name envoy.local 2>/dev/null) | grep -oE '([0-9]+\.){3}[0-9]+' | head -1 || true)
fi
set_env GATEWAY_HOST "$(ask 'IQ Gateway IP (Docker needs an IP, not envoy.local)' "$gw")"
set_env LOCATION "$(ask 'ZIP code or city (weather forecast)' "$(get_env LOCATION)")"

yn() { [ "$1" = 1 ] && echo y || echo n; }
echo; echo "-- Optional features --"
echo "Full history keeps every per-second row forever (~20 GB/yr). Without it: last 26 h per second + minute averages forever."
set_env RECORD_HISTORY "$([ "$(ask 'Keep full per-second history? (y/N)' "$(yn "$(get_env RECORD_HISTORY)")")" = y ] && echo 1 || echo 0)"
echo "Phone pushes use the free ntfy app (ntfy.sh). Without them, messages show on the dashboard only."
set_env NOTIFY "$([ "$(ask 'Send push notifications to your phone? (y/N)' "$(yn "$(get_env NOTIFY)")")" = y ] && echo 1 || echo 0)"
echo "Enlighten cloud features: 92 days of history (the EV advisor learns faster) and a cloud fallback if the gateway stops answering."
echo "They use Enlighten web endpoints that are not a published API; Enphase's terms may not allow it. Default: off, gateway only."
set_env ENLIGHTEN_CLOUD "$([ "$(ask 'Use Enlighten cloud features? (y/N)' "$(yn "$(get_env ENLIGHTEN_CLOUD)")")" = y ] && echo 1 || echo 0)"
if [ "$(get_env ENLIGHTEN_CLOUD)" = 1 ]; then
  set_env ENLIGHTEN_SITE_ID "$(ask 'Enlighten site id (number in the Enlighten URL)' "$(get_env ENLIGHTEN_SITE_ID)")"
  set_env ENLIGHTEN_BACKFILL_DAYS "$(ask 'Days of Enlighten history to import (or "all")' "$(v=$(get_env ENLIGHTEN_BACKFILL_DAYS); echo "${v:-365}")")"
fi

echo; echo "-- Tesla control (optional) --"
echo 'Needs an M5Stack NanoC6 (~$10, https://shop.m5stack.com/products/m5stack-nanoc6-dev-kit) near where the car parks.'
echo "Skip this if you only want Enphase monitoring."
if [ "$(ask 'Set up Tesla control? (y/N)' "$([ -n "$(get_env TESLA_BLE_HOST)" ] && echo y || echo n)")" = y ]; then
  [ -n "$(get_env TESLA_BLE_USER)" ] || set_env TESLA_BLE_USER enphase
  [ -n "$(get_env TESLA_BLE_PASSWORD)" ] || set_env TESLA_BLE_PASSWORD "$(token)"
  set_env TESLA_CAR1_NAME "$(ask 'Name for this car (shown in messages)' "$(v=$(get_env TESLA_CAR1_NAME); echo "${v:-Car 1}")")"
  set_env EV_CAR_KWH "$(ask 'Car usable battery size, kWh' "$(v=$(get_env EV_CAR_KWH); echo "${v:-75}")")"
  if [ ! -f esphome/secrets.yaml ]; then
    ssid=$(ask 'Wi-Fi name (2.4 GHz) for the bridge'); wpass=$(ask_secret 'Wi-Fi password')
    vin=$(ask 'Car VIN (17 characters)' | tr a-z A-Z)
    mac=$(ask 'Car Bluetooth MAC (blank = find later)' '00:00:00:00:00:00')
    cat > esphome/secrets.yaml <<EOF
wifi_ssid: "$ssid"
wifi_password: "$wpass"
wifi_hotspot_password: "$(token 12)"
api_encryption_key: "$(head -c 32 /dev/urandom | base64)"
web_username: "$(get_env TESLA_BLE_USER)"
web_password: "$(get_env TESLA_BLE_PASSWORD)"
ble_mac_address: "$mac"
tesla_vin: "$vin"
EOF
    echo "Wrote esphome/secrets.yaml (git-ignored)"
  fi
  # Optional second car on the same bridge: the app switches between them (README "Two cars").
  if [ "$(ask 'Second Tesla charging at this home, same bridge? (y/N)' "$([ -n "$(get_env TESLA_CAR2_NAME)" ] && echo y || echo n)")" = y ]; then
    set_env TESLA_CAR2_NAME "$(ask 'Name for the second car' "$(v=$(get_env TESLA_CAR2_NAME); echo "${v:-Car 2}")")"
    set_env EV_CAR2_KWH "$(ask 'Second car usable battery size, kWh' "$(v=$(get_env EV_CAR2_KWH); echo "${v:-75}")")"
    vin2=$(ask 'Second car VIN (17 characters)' | tr a-z A-Z); mac2=$(ask 'Second car Bluetooth MAC (AA:BB:CC:DD:EE:FF)')
    grep -vE '^(tesla_vin_2|ble_mac_address_2):' esphome/secrets.yaml > esphome/secrets.yaml.tmp && mv esphome/secrets.yaml.tmp esphome/secrets.yaml
    printf 'ble_mac_address_2: "%s"\ntesla_vin_2: "%s"\n' "$mac2" "$vin2" >> esphome/secrets.yaml
  elif ! grep -q '^tesla_vin_2:' esphome/secrets.yaml; then
    printf 'ble_mac_address_2: ""\ntesla_vin_2: ""\n' >> esphome/secrets.yaml
  fi
  if [ "$(ask 'Flash the NanoC6 over USB now? (y/N)' n)" = y ]; then
    port=$(ask 'USB serial port' "$(ls /dev/ttyACM* /dev/cu.usbmodem* 2>/dev/null | head -1)")
    if command -v docker >/dev/null && [ "$(uname)" = Linux ]; then
      docker run --rm -v "$PWD/esphome:/config" --device "$port" ghcr.io/esphome/esphome:2026.9.1 run tesla-ble.yaml --device "$port" --no-logs
    else
      command -v uv >/dev/null || { echo "Install uv (https://docs.astral.sh/uv/) and re-run"; exit 1; }
      [ -d .venv-esphome ] || { uv venv --python 3.12 .venv-esphome && uv pip install --python .venv-esphome/bin/python esphome==2026.9.1; }
      .venv-esphome/bin/esphome run esphome/tesla-ble.yaml --device "$port" --no-logs
    fi
    echo "Flashed. Find the bridge IP in your router (hostname tesla-ble)."
  fi
  set_env TESLA_BLE_HOST "$(ask 'Bridge IP address' "$(get_env TESLA_BLE_HOST)")"
  echo 'Pairing: sit in the car, open http://<bridge-ip>/ (user/password from .env), press "Pair BLE Key", tap your key card on the console, confirm on the screen.'
fi

echo; echo "-- Starting --"
if [ "$mode" = docker ]; then
  docker compose up -d --build
else
  npm ci --omit=dev
  echo "Start with: npm start   (or run it under systemd / launchd to keep it running)"
fi
echo; echo "Dashboard: http://localhost:$(v=$(get_env PORT); echo "${v:-8787}")"
[ "$(get_env NOTIFY)" = 1 ] && echo "Push notifications: install the ntfy app and subscribe to the topic shown on the EV tab."
true
