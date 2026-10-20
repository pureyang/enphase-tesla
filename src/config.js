import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

export const config = {
  root,
  dataDir: path.join(root, 'data'),
  protoDir: path.join(root, 'proto'),
  publicDir: path.join(root, 'public'),
  port: Number(env.PORT || 8787),
  // 127.0.0.1 = this PC only. Set HOST=0.0.0.0 to view from phones on your LAN.
  host: env.HOST || '127.0.0.1',
  preferred: (env.PREFERRED_SOURCE || 'local').toLowerCase(),
  fallbackAfterS: Number(env.FALLBACK_AFTER_S || 10),
  enlighten: {
    base: 'https://enlighten.enphaseenergy.com',
    email: env.ENLIGHTEN_EMAIL || '',
    password: env.ENLIGHTEN_PASSWORD || '',
    siteId: env.ENLIGHTEN_SITE_ID || '',
  },
  ev: {
    location: env.LOCATION || '',
    lat: Number(env.LAT) || null,
    lon: Number(env.LON) || null,
    minAmps: Number(env.EV_MIN_AMPS || 5),
    maxAmps: Number(env.EV_MAX_AMPS || 32),
    // Fraction of forecast solar the plan relies on; lower = more conservative for the house battery.
    safety: Number(env.EV_SAFETY || 0.85),
    targetSoc: Number(env.EV_TARGET_SOC || 99),
    minIntervalMin: Number(env.NOTIFY_MIN_INTERVAL_MIN || 60),
    ntfyTopic: env.NTFY_TOPIC || '',
    ntfyServer: env.NTFY_SERVER || 'https://ntfy.sh',
  },
  // ESPHome Tesla BLE bridge (esphome/tesla-ble.yaml)
  tesla: {
    host: env.TESLA_BLE_HOST || '',
    user: env.TESLA_BLE_USER || '',
    password: env.TESLA_BLE_PASSWORD || '',
  },
  // Automatic EV control over BLE (src/controller.js). On by default when the bridge is configured.
  control: {
    enabled: !['0', 'false', 'off'].includes(String(env.EV_AUTO_CONTROL ?? '1').toLowerCase()),
    intervalS: Math.max(30, Number(env.EV_CONTROL_INTERVAL_S || 60)),
    from: env.EV_AUTO_FROM || '',        // YYYY-MM-DD: first day to take control
    overrideMin: Number(env.EV_OVERRIDE_MIN || 120), // pause after a manual change in the Tesla app
    // Raise the car's charge limit to this when the house battery is full and the car hit its limit (0 = off).
    limitRaiseTo: Number(env.EV_LIMIT_RAISE_TO ?? 90),
    carKwh: Number(env.EV_CAR_KWH || 75),
    // Max Wh a day the car may borrow from the house battery to ride through a dip at min amps (0 = never).
    loanWh: Number(env.EV_LOAN_WH ?? 200), // usable pack size, for the expected-SOC estimate
  },
  gateway: {
    host: env.GATEWAY_HOST || '',
    serial: env.GATEWAY_SERIAL || '',
    token: env.GATEWAY_TOKEN || '',
  },
};
