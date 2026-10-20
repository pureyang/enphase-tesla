# Enphase Tesla

Per-second monitoring for an Enphase solar + battery system, from your IQ Gateway on your own
network. Optionally, charge a Tesla from **excess solar only** with a $10 Bluetooth board. No Tesla
API, no cloud subscriptions.

**Core (everything you need is an Enphase system and a computer):**

- **Live dashboard** updated every second: solar, house, IQ Battery, grid, per-phase meters,
  microinverters, battery units.
- **History**: the last 26 h at 1 s, plus minute averages forever (about 60 MB for the 26 h, plus ~130 MB a year).
- **Grid leakage**: grid import while the battery still had charge, per minute and per night
  (see `docs/grid-leakage.md`).
- **EV advisor**: learns your solar and load by hour, reads the weather forecast and shows on the
  dashboard when and how fast to charge an EV so the house battery still ends the day full.

**Optional (off unless you turn it on):**

| Feature | Turn on with | Needs |
| --- | --- | --- |
| Full per-second history (every second, forever) | `RECORD_HISTORY=1` | ~20 GB of disk a year |
| Phone push notifications | `NOTIFY=1` | Free [ntfy](https://ntfy.sh) app |
| Automatic Tesla charging over Bluetooth | Installer's Tesla step | [M5Stack NanoC6](https://shop.m5stack.com/products/m5stack-nanoc6-dev-kit) (~$10) |

The NanoC6 is only needed for Tesla control. Without it, everything else works.

Not affiliated with Enphase or Tesla. Tesla control sends real charge commands to your car; use at your own risk.

## What you need

| Item | Notes |
| --- | --- |
| Enphase IQ Gateway with consumption CTs | Local API needs your Enlighten login (a gateway token is minted automatically) |
| Always-on computer on the same network | Windows, macOS, Linux or Raspberry Pi. Node 24+ or Docker |
| *Tesla control only:* [M5Stack NanoC6](https://shop.m5stack.com/products/m5stack-nanoc6-dev-kit) | ~$10, USB powered, within Bluetooth range of where the car parks, plus a USB-C data cable to flash it |
| *Tesla control only:* a Tesla on a charger it controls | Tested: Model 3 on a Mobile Connector, 240 V, 5–32 A |

## Install

1. Get the code:
   ```
   git clone https://github.com/pureyang/enphase-tesla.git
   cd enphase-tesla
   ```
2. Run the installer:
   - **Windows**: `powershell -ExecutionPolicy Bypass -File install.ps1`
   - **macOS / Linux / Pi**: `./install.sh`
3. Open http://localhost:8787.

The installer asks, in order:

1. **Docker or Node**, and checks it's installed.
2. **Enphase**: Enlighten email and password, site id, gateway serial and IP, ZIP code (for the forecast).
3. **Full per-second history?** Default no.
4. **Phone push notifications?** Default no. If yes, install the ntfy app and subscribe to the topic
   shown on the EV tab.
5. **Tesla control?** Default no. Answer yes only if you have a NanoC6. It writes
   `esphome/secrets.yaml` (Wi-Fi, VIN, car Bluetooth MAC, generated passwords), can flash the
   NanoC6 over USB, and stores the bridge IP. Then follow [Pairing the car](#pairing-the-car).
6. **Start**: `docker compose up -d`, or `npm ci` + start at logon on Windows.

Re-running the installer keeps existing values, so it is also how you turn features on later.
Everything it writes (`.env`, `esphome/secrets.yaml`, `data/`) is git-ignored.

### Manual setup

1. `cp .env.example .env` and fill in the Enphase section. Optional features stay off until you set them.
2. `npm install`, then `npm run probe` to check login, gateway token and live data.
3. `npm start`, or `docker compose up -d --build`.

Try the UI with fake data: `DEMO=1 npm start` (writes to `data/demo.db`).

### Turning a feature on later

Edit `.env` (or re-run the installer), then restart the app (`docker compose restart`, or
restart the `EnphaseLive` scheduled task on Windows).

- `RECORD_HISTORY=1`: keeps every second from now on. Seconds already pruned don't come back.
- `NOTIFY=1`: the EV tab then shows your topic and a **Send test** button.
- Tesla: re-run the installer and answer yes at the Tesla step.

## Pairing the car

Only for Tesla control. You need the NanoC6 flashed by the installer.

1. Flash the NanoC6 (installer Tesla step, or `esphome run esphome/tesla-ble.yaml --device COM3`).
2. Car Bluetooth MAC: the car advertises as `S` + first 16 hex chars of `sha1(VIN)` + `C`. Any BLE
   scanner app shows its MAC next to that name.
3. Plug the NanoC6 into USB power near the car. Line of sight to the driver-side door pillar helps;
   better than −85 dBm is reliable.
4. Sit in the car, open `http://<bridge-ip>/` (user/password from `.env`), press **Pair BLE Key**,
   tap your key card on the console and confirm on the car screen.
5. The EV tab now shows the car's real amps, battery % and charge limit.

## How the car control works

Only runs when the Tesla bridge is set up.

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
- Messages when charging starts (with the expected ending car battery %) and when it stops: on the
  dashboard, and on your phone with `NOTIFY=1`.

`EV_AUTO_CONTROL=0` turns control off; the advisor then posts "start / stop / set N A" messages instead
(dashboard, plus phone with `NOTIFY=1`), at most one per `NOTIFY_MIN_INTERVAL_MIN`.

## Settings (`.env`)

| Key | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_HOST` | `envoy.local` | Gateway IP (use an IP under Docker) |
| `RECORD_HISTORY` | 0 | 1 = keep every per-second row forever (~20 GB/yr) |
| `HISTORY_HOURS` | 26 | Per-second rows kept when `RECORD_HISTORY=0` (min 26) |
| `NOTIFY` | 0 | 1 = push messages to your phone via ntfy |
| `LOCATION` | | ZIP or city for the forecast (or `LAT`/`LON`) |
| `EV_MIN_AMPS` / `EV_MAX_AMPS` | 5 / 32 | Charger range |
| `EV_TARGET_SOC` | 99 | House battery must reach this before solar fades |
| `EV_SAFETY` | 0.85 | Fraction of forecast solar the plan relies on |
| `EV_AUTO_CONTROL` | 1 | Drive the car over Bluetooth (only with a bridge set up) |
| `EV_CONTROL_INTERVAL_S` | 60 | Seconds between updates to the car (min 30) |
| `EV_AUTO_FROM` | | First day (YYYY-MM-DD) to take control |
| `EV_OVERRIDE_MIN` | 120 | Back-off after a manual change |
| `EV_CAR_KWH` | 75 | Usable pack size, for the expected-SOC estimate |
| `EV_LOAN_WH` | 200 | Daily house-battery loan to ride through clouds at min amps |
| `EV_LIMIT_RAISE_TO` | 90 | Car charge limit used when the house battery is full (0 = off) |
| `TESLA_BLE_HOST` / `_USER` / `_PASSWORD` | | Bridge address and web login |
| `NTFY_TOPIC` | auto | Push topic (generated if blank; setting it also turns on `NOTIFY`) |

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
  With `RECORD_HISTORY=0`, this and the other per-second tables (`meter_readings`, `battery_units`,
  `inverters`, `ev_samples`) keep only the last `HISTORY_HOURS`; minute rollups and leakage are kept.
- `rollup_1m`: per-minute avg/min/max + Wh. `leakage_1m`: per-minute grid leakage.
- `meter_readings`, `battery_units`, `inverters`, `cloud_intervals`, `weather_hourly`.
- `ev_samples`: car state every 10 s. `notifications`: messages and car commands.
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
