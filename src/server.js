import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './db.js';
import { Collector } from './collector.js';
import { startCloudHistory } from './cloudHistory.js';
import { startWeather } from './weather.js';
import { Advisor } from './advisor.js';
import { TeslaSource } from './sources/tesla.js';
import { Controller } from './controller.js';
import { CarSwitcher } from './cars.js';
import { notify, ntfyUrl } from './notify.js';
import { log } from './log.js';

const collector = new Collector();
collector.start();
startCloudHistory();
startWeather();
const tesla = new TeslaSource();
tesla.on('sample', (ts, e) => store.writeEvSample(ts, e));
tesla.start();
const cars = new CarSwitcher(tesla);
cars.start();
const advisor = new Advisor(collector, tesla);
advisor.start();
const controller = new Controller(collector, tesla, advisor);
advisor.controller = controller;
controller.start();

// Per-microinverter 15-min energy: backfill from whatever raw reports exist, then keep it current.
setTimeout(() => { try { store.syncInverter15m(0); } catch (e) { log.warn('array', e.message); } }, 15_000);
setInterval(() => { try { store.syncInverter15m(Date.now() / 1000 - 3 * 3600); } catch (e) { log.warn('array', e.message); } }, 15 * 60_000);

// Nightly report (capture rate, grid leakage, sessions) into data/reports/<day>.json at 23:55,
// and on boot for yesterday if it was missed.
function runReport(day) {
  execFile(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(config.root, 'scripts/daily-report.js'), day],
    { env: process.env, timeout: 120_000 }, (err, out) => {
      if (err) log.warn('report', `${day}: ${err.message}`);
      else log.info('report', out.split('\n').slice(0, 3).join(' | '));
    });
}
const localDay = (d) => d.toLocaleDateString('en-CA');
{
  const y = new Date(Date.now() - 86400_000);
  if (!fs.existsSync(path.join(config.dataDir, 'reports', `${localDay(y)}.json`))) setTimeout(() => runReport(localDay(y)), 60_000);
  let lastRun = null;
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() >= 55 && lastRun !== localDay(now)) {
      lastRun = localDay(now);
      runReport(lastRun);
    }
  }, 60_000);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const clients = new Set();
collector.on('tick', (snap) => {
  const msg = `data: ${JSON.stringify(snap)}\n\n`;
  for (const res of clients) res.write(msg);
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const STATIC = {
  '/vendor/uPlot.iife.min.js': path.join(config.root, 'node_modules/uplot/dist/uPlot.iife.min.js'),
  '/vendor/uPlot.min.css': path.join(config.root, 'node_modules/uplot/dist/uPlot.min.css'),
};

function sendJson(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function range(q) {
  const now = Math.floor(Date.now() / 1000);
  const to = Number(q.get('to')) || now;
  const from = Number(q.get('from')) || to - 3600;
  return [Math.floor(from), Math.ceil(to)];
}

const routes = {
  '/api/stream': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(collector.snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  },
  '/api/series': (req, res, q) => {
    const [from, to] = range(q);
    const res_ = q.get('res') && q.get('res') !== 'auto' ? Number(q.get('res')) : store.pickResolution(to - from);
    sendJson(res, store.series(from, to, res_));
  },
  '/api/energy': (req, res, q) => {
    const [from, to] = range(q);
    sendJson(res, store.energy(from, to));
  },
  '/api/meters': (req, res, q) => {
    const [from, to] = range(q);
    sendJson(res, store.meterSeries(from, to, Math.max(1, store.pickResolution(to - from))));
  },
  '/api/battery': (req, res, q) => {
    const [from, to] = range(q);
    sendJson(res, { latest: store.latestBatteryUnits(), series: store.batterySeries(from, to) });
  },
  '/api/inverters': (req, res) => sendJson(res, store.latestInverters()),
  // Per-microinverter 15-min energy for one local day: ?day=YYYY-MM-DD
  '/api/array': (req, res, q) => {
    const [y, m, d] = String(q.get('day') || '').split('-').map(Number);
    const a = y ? new Date(y, m - 1, d) : new Date(new Date().setHours(0, 0, 0, 0));
    const b = new Date(a); b.setDate(b.getDate() + 1);
    store.syncInverter15m(Math.max(a / 1000, Date.now() / 1000 - 2 * 86400));
    sendJson(res, store.arrayDay(a / 1000, b / 1000));
  },
  '/api/ev': (req, res) => sendJson(res, {
    ...(advisor.last || {}), state: advisor.state, control: controller.status, cars: { ...cars.status, list: config.tesla.cars.map((c) => c.name) }, ntfy: config.ev.notify ? ntfyUrl() : null,
    notifications: store.recentNotifications(15), settings: config.ev && { ...config.ev, ntfyTopic: undefined },
  }),
  // Re-run the advisor now (e.g. after telling it what the car is doing).
  '/api/ev/evaluate': async (req, res) => sendJson(res, await advisor.evaluate()),
  // Body: { charging: bool, amps: number } — what the car is actually doing.
  '/api/ev/assume': async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { error: 'POST only' }, 405);
    const b = await readBody(req);
    advisor.setAssumed(Boolean(b.charging), Number(b.amps) || 0);
    sendJson(res, await advisor.evaluate());
  },
  '/api/ev/test-notify': async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, { error: 'POST only' }, 405);
    if (!config.ev.notify) return sendJson(res, { ok: false, error: 'Push notifications are off (NOTIFY=1 in .env)' });
    const ok = await notify({ kind: 'TEST', title: 'Solar Surplus EV test', body: 'EV charging notifications are working.', tags: ['white_check_mark'] });
    sendJson(res, { ok });
  },
  // Grid leakage buckets (default hourly): ?from&to&res=60|3600|86400
  '/api/leakage': (req, res, q) => {
    const [from, to] = range(q);
    sendJson(res, store.leakageSeries(from, to, Number(q.get('res')) || 3600));
  },
  '/api/tesla': (req, res, q) => {
    const [from, to] = range(q);
    sendJson(res, { status: tesla.status, cars: cars.status, latest: tesla.current(), series: store.evSeries(from, to), events: store.evEvents(from, to) });
  },
  '/api/cloud-intervals': (req, res, q) => {
    const [from, to] = range(q);
    sendJson(res, store.cloudIntervals(from, to));
  },
  '/api/status': (req, res) => sendJson(res, {
    ...collector.snapshot(), tesla: tesla.status, db: store.stats(), log: log.recent(),
    config: { siteId: config.enlighten.siteId, gatewayHost: config.gateway.host, preferred: config.preferred,
      recordHistory: config.recordHistory, historyHours: config.historyHours, notify: config.ev.notify },
  }),
  '/api/export.csv': (req, res, q) => {
    const [from, to] = range(q);
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="enphase_${from}_${to}.csv"`,
    });
    res.write('iso_time,ts,source,pv_w,battery_w,grid_w,load_w,generator_w,soc_pct,backup_soc_pct,grid_relay,batt_mode\n');
    for (const r of store.rawRows(from, to)) {
      res.write([
        new Date(r.ts * 1000).toISOString(), r.ts, r.src === 1 ? 'local' : 'cloud',
        r.pv, r.batt, r.grid, r.load, r.gen, r.soc, r.backup_soc,
        store.RELAY[r.relay] || r.relay, store.MODE[r.mode] || r.mode,
      ].join(',') + '\n');
    }
    res.end();
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    const route = routes[url.pathname];
    if (route) {
      return Promise.resolve(route(req, res, url.searchParams)).catch((e) => {
        log.error('http', e.stack);
        if (!res.headersSent) sendJson(res, { error: e.message }, 500);
      });
    }

    const file = STATIC[url.pathname]
      || path.join(config.publicDir, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(config.publicDir) && !Object.values(STATIC).includes(file)) {
      res.writeHead(403); return res.end();
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    log.error('http', e.stack);
    sendJson(res, { error: e.message }, 500);
  }
});

server.listen(config.port, config.host, () => {
  log.info('http', `dashboard on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
});
