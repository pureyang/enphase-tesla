// Tesla charging state from the ESPHome Tesla BLE bridge (esphome/tesla-ble.yaml).
// Subscribes to the device's web_server /events stream (SSE) and keeps the latest value of
// each entity; a row goes to ev_samples every 10 s while the stream is alive.
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { log } from '../log.js';

// ESPHome entity (domain + object id from the entity name) -> our field.
const FIELDS = {
  'sensor:charger_power': 'powerKw',
  'sensor:charger_current': 'current',
  'sensor:charger_voltage': 'voltage',
  'sensor:battery': 'battery',
  'sensor:energy_added': 'energyAdded',
  'sensor:charger_max': 'evseMax',
  'number:charging_amps': 'ampsSet',
  'number:charging_limit': 'limit',
  'text_sensor:charging': 'state',
  'switch:charger': 'chargingOn',
  'binary_sensor:charger': 'pluggedIn',
  'binary_sensor:asleep': 'asleep',
  'sensor:ble_signal': 'rssi',
  'switch:ble_connection': 'bleConnected',
  'binary_sensor:pairing_required': 'pairingRequired',
};

// Event ids look like "sensor-charger_current" (older) or "sensor/Charger Current" (newer).
function fieldFor(id) {
  const m = /^([a-z_]+)[-/](.+)$/.exec(id || '');
  if (!m) return null;
  const key = `${m[1]}:${m[2].toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
  return FIELDS[key] || null;
}

function parseValue(d) {
  if (d.state === 'NA' || d.state === '') return null; // no reading yet (car not connected)
  if (typeof d.value === 'number' || typeof d.value === 'boolean') return d.value;
  if (typeof d.state === 'string') {
    if (d.state === 'ON') return true;
    if (d.state === 'OFF') return false;
    const n = parseFloat(d.state);
    return Number.isFinite(n) && /^-?[\d.]+(\s|$)/.test(d.state) ? n : d.state;
  }
  return d.value ?? d.state ?? null;
}

export class TeslaSource extends EventEmitter {
  constructor() {
    super();
    this.state = {};
    this.status = { state: 'idle', error: null, lastEventAt: 0 };
    this.abort = null;
  }

  enabled() { return Boolean(config.tesla.host); }

  start() {
    if (!this.enabled()) { this.status.state = 'disabled'; return; }
    this.connect();
    // Only log while the bridge is actually talking to the car; otherwise every field is empty.
    setInterval(() => {
      const car = this.live();
      if (car) this.emit('sample', Math.floor(Date.now() / 1000), car);
    }, 10_000);
  }

  headers() {
    const { user, password } = config.tesla;
    return user ? { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` } : {};
  }

  async connect() {
    this.status.state = 'connecting';
    try {
      this.abort = new AbortController();
      const res = await fetch(`http://${config.tesla.host}/events`, { headers: this.headers(), signal: this.abort.signal });
      if (!res.ok) throw new Error(`tesla-ble ${res.status}`);
      this.status.state = 'ok';
      this.status.error = null;
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n'); // ESPHome sends CRLF
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          this.onEvent(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
      throw new Error('stream ended');
    } catch (e) {
      if (this.status.error !== e.message) log.warn('tesla', e.message);
      this.status.state = 'error';
      this.status.error = e.message;
      setTimeout(() => this.connect(), 15_000);
    }
  }

  onEvent(block) {
    let type = 'message', data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    this.status.lastEventAt = Date.now();
    if (type !== 'state' || !data) return;
    let d;
    try { d = JSON.parse(data); } catch { return; }
    const f = fieldFor(d.id) || fieldFor(d.name_id);
    if (f) this.state[f] = parseValue(d);
  }

  // Normalised view: charging = car is actually pulling current.
  current() {
    const s = this.state;
    const charging = s.state === 'Charging' || (typeof s.current === 'number' && s.current > 0.5);
    return {
      charging,
      state: s.state ?? null,
      ampsSet: s.ampsSet ?? null,
      current: s.current ?? null,
      voltage: s.voltage ?? null,
      powerW: typeof s.powerKw === 'number' ? Math.round(s.powerKw * 1000) : null,
      battery: s.battery ?? null,
      limit: s.limit ?? null,
      energyAdded: s.energyAdded ?? null,
      pluggedIn: s.pluggedIn ?? null,
      asleep: s.asleep ?? null,
      rssi: s.rssi ?? null,
      bleConnected: s.bleConnected ?? null,
      pairingRequired: s.pairingRequired ?? null,
    };
  }

  // Commands (ESPHome web_server REST). Throw on failure so the controller can log it.
  async post(path) {
    const res = await fetch(`http://${config.tesla.host}/${path}`, { method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`tesla-ble ${path} ${res.status}`);
  }
  wake() { return this.post(`button/${encodeURIComponent('Wake up')}/press`); }
  setAmps(a) { return this.post(`number/${encodeURIComponent('Charging Amps')}/set?value=${Math.round(a)}`); }
  setLimit(pct) { return this.post(`number/${encodeURIComponent('Charging Limit')}/set?value=${Math.round(pct)}`); }
  setCharging(on) { return this.post(`switch/Charger/${on ? 'turn_on' : 'turn_off'}`); }

  // Fresh reading for the advisor, or null if the bridge is offline or not talking to the car.
  live(maxAgeMs = 120_000) {
    if (Date.now() - this.status.lastEventAt >= maxAgeMs || !this.state.bleConnected || this.state.pairingRequired) return null;
    return this.current();
  }
}
