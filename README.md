# Enphase Tesla

Charge your Tesla from **excess solar only**, using local data from an Enphase IQ Gateway and a
$10 Bluetooth board talking to the car. No Tesla API, no cloud subscriptions.

- **Per-second dashboard** for an Enphase system (solar, house, IQ Battery, grid), live the moment
  the page opens, logged to SQLite.
- **EV advisor** that learns your house's solar and load by hour, reads the weather forecast and
  plans car charging so the house battery still ends the day full.
- **Automatic car control** over Bluetooth (ESPHome on an M5Stack NanoC6): every minute it sets the
  car's amps to match spare solar, with start/stop push notifications via [ntfy](https://ntfy.sh).
- **Nightly report**: how much excess solar you captured vs. exported, car energy and solar share,
  and **grid leakage** (grid import while the battery still had charge; see `docs/grid-leakage.md`).

Not affiliated with Enphase or Tesla. It sends real charge commands to your car; use at your own risk.

## What you need

| Item | Notes |
| --- | --- |
| Enphase IQ Gateway with consumption CTs | Local API needs your Enlighten login (a gateway token is minted automatically) |
| Always-on computer on the same network | Windows, macOS, Linux or Raspberry Pi. Node 24+ or Docker |
| M5Stack NanoC6 (optional, for the car) | ~$10, USB powered, within Bluetooth range of where the car parks |
| A Tesla on a charger it controls | Tested: Model 3 on a Mobile Connector, 240 V, 5–32 A |

## Install

```
git clone https://github.com/pureyang/enphase-tesla.git
cd enphase-tesla
```

**Windows**: `powershell -ExecutionPolicy Bypass -File install.ps1`
**macOS / Linux / Pi**: `./install.sh`

The installer:
1. Asks Docker or Node, and checks it's installed.
2. Writes `.env`: Enlighten login, site id, gateway serial and IP, ZIP code.
3. Optional Tesla bridge: writes `esphome/secrets.yaml` (Wi-Fi, VIN, car Bluetooth MAC, generated
   passwords), flashes the NanoC6 over USB, and stores the bridge IP.
4. Starts the app (`docker compose up -d`, or `npm ci` + start at logon on Windows).

Then open http://localhost:8787. For pushes, install the ntfy app and subscribe to the topic on the EV tab.

Re-running the installer keeps existing values. Everything it writes (`.env`, `esphome/secrets.yaml`,
`data/`) is git-ignored.

### Manual setup

1. `cp .env.example .env` and fill it in.
2. `npm install`, then `npm run probe` to check login, gateway token and live data.
3. `npm start`, or `docker compose up -d --build`.

Try the UI with fake data: `DEMO=1 npm start` (writes to `data/demo.db`).

## Pairing the car

1. Flash the NanoC6 (installer step 3, or `esphome run esphome/tesla-ble.yaml --device COM3`).
2. Car Bluetooth MAC: the car advertises as `S` + first 16 hex chars of `sha1(VIN)` + `C`. Any BLE
   scanner app shows its MAC next to that name.
3. Plug the NanoC6 into USB power near the car. Line of sight to the driver-side door pillar helps;
   better than −85 dBm is reliable.
4. Sit in the car, open `http://<bridge-ip>/` (user/password from `.env`), press **Pair BLE Key**,
   tap your key card on the console and confirm on the car screen.
5. The EV tab now shows the car's real amps, battery % and charge limit.

## How the car control works

Every `EV_CONTROL_INTERVAL_S` (default 60 s), `src/controller.js` sets the car's amps. Priorities:

1. **Use all excess solar.** If the house is exporting and the car can take more, amps go up.
2. **Then minimise grid use.** The car never charges from the house battery or the grid: amps are
   capped at live excess and cut if the house imports while the car charges.

- House battery below 95%: follows the advisor's plan, so the battery still reaches `EV_TARGET_SOC`.
- 95% and above: tracks live excess minute by minute, keeping back what the battery needs to top off.
- Starts need 2 good minutes in a row. During a cloud the car drops to min amps and borrows from the
  house battery (up to `EV_LOAN_WH`, default 200 Wh/day) instead of stopping; the loan is repaid from
  solar before the car gets more. It stops ~3 min after the loan runs out.
- A plan that only moves the car's window back by an hour or less doesn't stop a running session.
- When the house battery is full and the car reaches its own charge limit, the limit is raised to
  `EV_LIMIT_RAISE_TO` (default 90%) so solar goes to the car instead of the grid, then put back after sunset.
- Session, loan and plan are saved in `data/ev_state.json`, so a restart doesn't reset them.
- At night it only stops sessions it started; your own overnight charging is left alone.
- A change in the Tesla app pauses control for `EV_OVERRIDE_MIN` (default 120).
- Pushes when charging starts (with the expected ending car battery %) and when it stops.

`EV_AUTO_CONTROL=0` turns control off; the advisor then sends "start / stop / set N A" pushes instead,
at most one per `NOTIFY_MIN_INTERVAL_MIN`.

## Settings (`.env`)

| Key | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_HOST` | `envoy.local` | Gateway IP (use an IP under Docker) |
| `LOCATION` | | ZIP or city for the forecast (or `LAT`/`LON`) |
| `EV_MIN_AMPS` / `EV_MAX_AMPS` | 5 / 32 | Charger range |
| `EV_TARGET_SOC` | 99 | House battery must reach this before solar fades |
| `EV_SAFETY` | 0.85 | Fraction of forecast solar the plan relies on |
| `EV_AUTO_CONTROL` | 1 | Drive the car over Bluetooth |
| `EV_CONTROL_INTERVAL_S` | 60 | Seconds between updates to the car (min 30) |
| `EV_AUTO_FROM` | | First day (YYYY-MM-DD) to take control |
| `EV_OVERRIDE_MIN` | 120 | Back-off after a manual change |
| `EV_CAR_KWH` | 75 | Usable pack size, for the expected-SOC estimate |
| `EV_LOAN_WH` | 200 | Daily house-battery loan to ride through clouds at min amps |
| `EV_LIMIT_RAISE_TO` | 90 | Car charge limit used when the house battery is full (0 = off) |
| `TESLA_BLE_HOST` / `_USER` / `_PASSWORD` | | Bridge address and web login |
| `NTFY_TOPIC` | auto | Push topic (generated if blank) |

## Data sources

| Source | Rate | How |
| --- | --- | --- |
| Local IQ Gateway (preferred) | 1 s | `GET /ivp/livedata/status` (stream enabled via `POST /ivp/livedata/stream`), `GET /ivp/meters/readings` |
| Enlighten cloud live stream (fallback) | 1 s | Same feed as Enlighten's "Live Status" panel, see below |
| Gateway battery inventory | 30 s | `GET /ivp/ensemble/inventory` (per-unit SOC, temperature) |
| Gateway microinverters | 5 min | `GET /api/v1/production/inverters` |
| Enlighten history | 15 min | `GET /pv/systems/<site>/today` |
| Open-Meteo | hourly | Solar radiation and cloud forecast |
| Tesla BLE bridge | ~10 s | ESPHome web_server `/events` (SSE); commands via its REST API |

The collector writes exactly one row per second from whichever source is healthy. If local data is
older than `FALLBACK_AFTER_S` (10 s) it starts the cloud stream, and puts it back on standby once
local has been healthy for 2 min.

Signs follow Enphase: battery **+ = discharging**, grid **+ = importing**.

### Enlighten live stream (recovered from the web bundle)

1. `GET /pv/aws_sigv4/livestream.json?serial_num=<gateway>` with header `e-auth-token: <session>`
   returns `aws_iot_endpoint`, `aws_authorizer`, `aws_token_key/value`, `aws_digest`,
   `live_stream_topic`, `live_stream_duration` (900 s).
2. MQTT 3.1.1 over `wss://<aws_iot_endpoint>/mqtt`. Username is the query string
   `?x-amz-customauthorizer-name=…&<token_key>=…&site-id=…&x-amz-customauthorizer-signature=…&evse-count=0&env=prod`.
3. Subscribe to `live_stream_topic`. Each message (~1/s) is protobuf `DataMsg` (`proto/DataMsg.proto`).
4. Renew before `live_stream_duration` runs out.

## Storage (`data/enphase.db`, SQLite)

- `samples`: 1 row/s of solar, battery, grid, house W, SOC, reserve, relay, mode, per-phase JSON.
- `rollup_1m`: per-minute avg/min/max + Wh. `leakage_1m`: per-minute grid leakage.
- `meter_readings`, `battery_units`, `inverters`, `cloud_intervals`, `weather_hourly`.
- `ev_samples`: car state every 10 s. `notifications`: pushes and car commands.
- `data/reports/<day>.json`: nightly report (23:55).

API: `/api/stream` (SSE), `/api/series`, `/api/energy`, `/api/meters`, `/api/battery`, `/api/inverters`,
`/api/ev`, `/api/tesla`, `/api/leakage`, `/api/status`, `/api/export.csv?from=&to=` (unix seconds).

## Docker

```
docker compose up -d --build                 # app on http://localhost:8787
docker compose --profile esphome up -d       # optional ESPHome dashboard (OTA updates) on :6052
```

Uses `.env` and keeps the database in `./data`. Containers can't resolve `envoy.local`, so set
`GATEWAY_HOST` and `TESLA_BLE_HOST` to IP addresses. Run only one copy (Docker **or** Node): two
copies would both send commands to the car.

## Credits

- [yoziru/esphome-tesla-ble](https://github.com/yoziru/esphome-tesla-ble): Tesla BLE firmware for ESP32
- [Open-Meteo](https://open-meteo.com): weather forecast
- [uPlot](https://github.com/leeoniya/uPlot): charts

## License

MIT, see [LICENSE](LICENSE).
