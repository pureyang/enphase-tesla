// Local IQ Gateway (Envoy) poller. Fast livedata + meter readings, slower battery/inverter polls.
// Each loop backs off exponentially on errors so a struggling gateway gets room to recover.
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { getGatewayToken } from '../auth.js';
import { fromLocal } from '../normalize.js';
import { log } from '../log.js';

// Gateway uses a self-signed cert; trust is limited to this agent, which only talks to GATEWAY_HOST.
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 4 });
const MAX_BACKOFF_MS = 30_000;
const STREAM_RETRY_MS = 30_000;
const STOP = Symbol('stop'); // returned by a poll fn to end its loop

export class LocalSource extends EventEmitter {
  constructor() {
    super();
    this.name = 'local';
    this.status = { state: 'idle', lastOk: 0, error: null, streamEnabledAt: 0 };
    this.streamTriedAt = 0;
    this.meterKinds = null; // eid -> measurementType
    this.timers = new Set();
    this.running = false;
  }

  enabled() { return Boolean(config.gateway.host); }

  request(method, path, body) {
    return new Promise(async (resolve, reject) => {
      let token;
      try { token = await getGatewayToken(); } catch (e) { return reject(e); }
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        host: config.gateway.host, path, method, agent, timeout: 4000,
        headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode === 401) return reject(Object.assign(new Error('gateway 401 (token rejected)'), { auth: true }));
          if (res.statusCode >= 400) return reject(Object.assign(new Error(`gateway ${res.statusCode} on ${path}`), { status: res.statusCode }));
          try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error(`bad JSON from ${path}`)); }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`timeout on ${path}`)));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  start() {
    if (!this.enabled()) { this.status.state = 'disabled'; return; }
    this.status.state = 'starting';
    this.running = true;
    this.every(config.gateway.livePollMs, () => this.pollLive());
    this.every(config.gateway.meterPollMs, () => this.pollMeters());
    this.every(30_000, () => this.pollBatteries(), true);
    this.every(300_000, () => this.pollInverters(), true);
  }

  stop() { this.running = false; this.timers.forEach(clearTimeout); this.timers.clear(); }

  // One request at a time per loop (never stacks on a slow gateway). After n consecutive failures
  // the next try waits ms * 2^n, capped at 30 s (or ms, for loops already slower than that).
  every(ms, fn, immediate = false) {
    let failures = 0;
    let timer = null;
    const schedule = (delay) => {
      if (!this.running) return;
      timer = setTimeout(run, delay);
      this.timers.add(timer);
    };
    const run = async () => {
      this.timers.delete(timer);
      const t0 = Date.now();
      try {
        if (await fn() === STOP) return;
        failures = 0;
        schedule(Math.max(0, ms - (Date.now() - t0))); // keep the cadence: count the request time
      } catch (e) {
        failures++;
        this.fail(e);
        schedule(Math.min(ms * 2 ** failures, Math.max(ms, MAX_BACKOFF_MS)));
      }
    };
    schedule(immediate ? 0 : ms);
  }

  fail(e) {
    if (this.status.error !== e.message) log.warn('local', e.message);
    this.status.error = e.message;
    if (Date.now() - this.status.lastOk > 5000) this.status.state = 'error';
    if (e.auth) getGatewayToken({ force: true }).catch((err) => log.error('local', err.message));
  }

  async enableStream() {
    // At most one enable POST per 30 s, even if the gateway never reports the stream as enabled.
    if (Date.now() - this.streamTriedAt < STREAM_RETRY_MS) return;
    this.streamTriedAt = Date.now();
    await this.request('POST', '/ivp/livedata/stream', { enable: 1 });
    this.status.streamEnabledAt = Date.now();
  }

  async pollLive() {
    // Livedata only updates while the stream flag is on; it auto-expires, so refresh every 4 min.
    if (Date.now() - this.status.streamEnabledAt > 240_000) await this.enableStream();
    const t0 = Date.now();
    const json = await this.request('GET', '/ivp/livedata/status');
    // A request that spanned a laptop sleep returns pre-sleep data; never log it as current.
    if (Date.now() - t0 > 5000) return;
    if (json.connection && json.connection.sc_stream && json.connection.sc_stream !== 'enabled') {
      await this.enableStream();
    }
    this.status.lastOk = Date.now();
    this.status.state = 'ok';
    this.status.error = null;
    this.emit('sample', fromLocal(json));
  }

  async pollMeters() {
    if (!this.meterKinds) {
      let meters;
      try { meters = await this.request('GET', '/ivp/meters'); } catch (e) {
        if (e.status !== 404) throw e;
        meters = []; // firmware without the meters API
      }
      // Only enabled meters; disabled ones (load/evse/pv3p) report zeros that would pollute charts.
      this.meterKinds = Object.fromEntries(
        (Array.isArray(meters) ? meters : []).filter((m) => m.state === 'enabled').map((m) => [m.eid, m.measurementType]));
      if (!Object.keys(this.meterKinds).length) {
        log.info('local', 'no enabled CT meters on this gateway; meter readings polling off');
        return STOP;
      }
    }
    const t0 = Date.now();
    const readings = await this.request('GET', '/ivp/meters/readings');
    if (Date.now() - t0 > 5000) return; // spanned a sleep; stale
    const ts = Math.floor(Date.now() / 1000);
    for (const r of readings) {
      if (!this.meterKinds[r.eid]) continue;
      this.emit('meter', ts, {
        kind: this.meterKinds[r.eid],
        p: r.activePower, q: r.reactivePower ?? r.reactPwr, s: r.apparentPower ?? r.apprntPwr,
        v: r.voltage, i: r.current, pf: r.pwrFactor, hz: r.freq,
        eDlvd: r.actEnergyDlvd, eRcvd: r.actEnergyRcvd,
      });
    }
  }

  async pollBatteries() {
    const inv = await this.request('GET', '/ivp/ensemble/inventory');
    const ts = Math.floor(Date.now() / 1000);
    for (const group of inv) {
      if (!/ENCHARGE|ACB|IQ.?BATT/i.test(group.type || '')) continue; // skip COLLAR, C6 combiner/RGM
      for (const d of group.devices || []) {
        this.emit('battery', ts, {
          serial: String(d.serial_num),
          soc: d.percentFull ?? d.soc ?? null,
          temp: d.temperature ?? null,
          capacityWh: d.encharge_capacity ?? null,
          status: d.led_status != null ? `led:${d.led_status}` : (d.device_status || []).join(','),
        });
      }
    }
  }

  async pollInverters() {
    const list = await this.request('GET', '/api/v1/production/inverters');
    for (const r of list) {
      this.emit('inverter', {
        ts: r.lastReportDate, serial: String(r.serialNumber), watts: r.lastReportWatts, maxWatts: r.maxReportWatts,
      });
    }
  }
}
