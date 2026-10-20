// SQLite storage. One row per second in `samples`; 1-minute rollups for long ranges.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const dbFile = path.join(config.dataDir, process.env.DEMO === '1' ? 'demo.db' : 'enphase.db');
export const db = new DatabaseSync(dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS samples (
  ts INTEGER PRIMARY KEY,          -- unix seconds
  src INTEGER NOT NULL,            -- 1 = local gateway, 2 = cloud stream
  pv REAL, batt REAL, grid REAL, load REAL, gen REAL,   -- W. batt + = discharge, grid + = import
  soc REAL, backup_soc REAL,
  relay INTEGER, mode INTEGER,
  pv_va REAL, batt_va REAL, grid_va REAL, load_va REAL,
  ph TEXT                          -- JSON per-phase watts {pv:[..],batt:[..],grid:[..],load:[..]}
);

CREATE TABLE IF NOT EXISTS rollup_1m (
  ts INTEGER PRIMARY KEY,          -- minute start, unix seconds
  n INTEGER,
  pv REAL, pv_min REAL, pv_max REAL,
  batt REAL, batt_min REAL, batt_max REAL,
  grid REAL, grid_min REAL, grid_max REAL,
  load REAL, load_min REAL, load_max REAL,
  soc REAL, soc_min REAL, soc_max REAL,
  pv_wh REAL, load_wh REAL, imp_wh REAL, exp_wh REAL, chg_wh REAL, dis_wh REAL
);

CREATE TABLE IF NOT EXISTS meter_readings (
  ts INTEGER NOT NULL, kind TEXT NOT NULL,   -- production | net-consumption | storage
  p REAL, q REAL, s REAL, v REAL, i REAL, pf REAL, hz REAL,
  e_dlvd REAL, e_rcvd REAL,                  -- lifetime Wh counters from the meter
  PRIMARY KEY (ts, kind)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS battery_units (
  ts INTEGER NOT NULL, serial TEXT NOT NULL,
  soc REAL, temp REAL, capacity_wh REAL, status TEXT,
  PRIMARY KEY (ts, serial)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS inverters (
  ts INTEGER NOT NULL, serial TEXT NOT NULL, watts REAL, max_watts REAL,
  PRIMARY KEY (ts, serial)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cloud_intervals (
  ts INTEGER PRIMARY KEY,          -- 15-min interval start from Enlighten history
  production REAL, consumption REAL, charge REAL, discharge REAL,
  grid_import REAL, soc REAL      -- Wh per interval, SOC %
);

CREATE TABLE IF NOT EXISTS weather_hourly (
  ts INTEGER PRIMARY KEY,          -- hour start, unix seconds
  ghi REAL, cloud REAL, temp REAL, -- W/m2 mean over the hour, %, C
  fetched_at INTEGER
);

CREATE TABLE IF NOT EXISTS notifications (
  ts INTEGER NOT NULL, kind TEXT, title TEXT, body TEXT, amps INTEGER, sent INTEGER, error TEXT
);

-- Grid leakage per minute: import while the battery had charge to spare (docs/grid-leakage.md).
CREATE TABLE IF NOT EXISTS leakage_1m (
  ts INTEGER PRIMARY KEY,          -- minute start
  n INTEGER,                       -- gateway seconds in the minute with SOC > reserve + 5
  imp_wh REAL, spike_wh REAL, spike_s INTEGER, max_w REAL,   -- spike = import above 300 W
  load_wh REAL, batt_wh REAL, pv_wh REAL, soc REAL
);

CREATE TABLE IF NOT EXISTS ev_samples (
  ts INTEGER PRIMARY KEY,          -- unix seconds, every 10 s while the Tesla BLE bridge is online
  charging INTEGER, state TEXT,
  amps_set REAL, current REAL, voltage REAL, power_w REAL,   -- setpoint A, actual A, V, W
  battery REAL, charge_limit REAL, energy_added REAL, plugged INTEGER, asleep INTEGER, rssi REAL
);
`);

// Columns added after first release.
for (const sql of ['ALTER TABLE cloud_intervals ADD COLUMN export REAL']) {
  try { db.exec(sql); } catch {}
}

export const RELAY = [
  'UNKNOWN', 'OPEN', 'CLOSED', 'OFFGRID_AC_GRID_PRESENT', 'OFFGRID_READY_FOR_RESYNC',
  'WAITING_TO_INIT_ON_GRID', 'GEN_OPEN', 'GEN_CLOSED', 'GEN_STARTUP', 'GEN_SYNC_READY',
  'GEN_AC_STABLE', 'GEN_AC_UNSTABLE',
];
export const MODE = { '-1': 'UNKNOWN', 0: 'FULL_BACKUP', 1: 'SELF_CONSUMPTION', 2: 'SAVINGS' };

const insSample = db.prepare(`INSERT OR REPLACE INTO samples
  (ts, src, pv, batt, grid, load, gen, soc, backup_soc, relay, mode, pv_va, batt_va, grid_va, load_va, ph)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

export function writeSample(tsSec, s) {
  insSample.run(
    tsSec, s.src === 'local' ? 1 : 2,
    s.pv, s.batt, s.grid, s.load, s.gen, s.soc, s.backupSoc,
    s.relay, s.mode, s.va.pv, s.va.batt, s.va.grid, s.va.load,
    JSON.stringify(s.ph),
  );
}

const insMeter = db.prepare(`INSERT OR REPLACE INTO meter_readings
  (ts, kind, p, q, s, v, i, pf, hz, e_dlvd, e_rcvd) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
export function writeMeter(tsSec, r) {
  insMeter.run(tsSec, r.kind, r.p, r.q, r.s, r.v, r.i, r.pf, r.hz, r.eDlvd, r.eRcvd);
}

const insBatt = db.prepare(`INSERT OR REPLACE INTO battery_units
  (ts, serial, soc, temp, capacity_wh, status) VALUES (?,?,?,?,?,?)`);
export function writeBatteryUnit(tsSec, u) {
  insBatt.run(tsSec, u.serial, u.soc, u.temp, u.capacityWh, u.status);
}

const insInv = db.prepare(`INSERT OR IGNORE INTO inverters (ts, serial, watts, max_watts) VALUES (?,?,?,?)`);
export function writeInverter(r) {
  insInv.run(r.ts, r.serial, r.watts, r.maxWatts);
}

const insCloud = db.prepare(`INSERT OR REPLACE INTO cloud_intervals
  (ts, production, consumption, charge, discharge, grid_import, soc, export) VALUES (?,?,?,?,?,?,?,?)`);
export function writeCloudInterval(r) {
  insCloud.run(r.ts, r.production, r.consumption, r.charge, r.discharge, r.gridImport, r.soc, r.export ?? null);
}

const insWeather = db.prepare(`INSERT OR REPLACE INTO weather_hourly (ts, ghi, cloud, temp, fetched_at) VALUES (?,?,?,?,?)`);
export function writeWeather(rows) {
  const at = Math.floor(Date.now() / 1000);
  db.exec('BEGIN');
  try {
    for (const r of rows) insWeather.run(r.ts, r.ghi, r.cloud, r.temp, at);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const insNote = db.prepare(`INSERT INTO notifications (ts, kind, title, body, amps, sent, error) VALUES (?,?,?,?,?,?,?)`);
export function writeNotification(n) {
  insNote.run(n.ts, n.kind, n.title, n.body, n.amps ?? null, n.sent ? 1 : 0, n.error ?? null);
}
const insEv = db.prepare(`INSERT OR REPLACE INTO ev_samples
  (ts, charging, state, amps_set, current, voltage, power_w, battery, charge_limit, energy_added, plugged, asleep, rssi)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const bool = (v) => (v == null ? null : v ? 1 : 0);
export function writeEvSample(tsSec, e) {
  insEv.run(tsSec, bool(e.charging), e.state, e.ampsSet, e.current, e.voltage, e.powerW,
    e.battery, e.limit, e.energyAdded, bool(e.pluggedIn), bool(e.asleep), e.rssi);
}
export function evSeries(fromSec, toSec) {
  return db.prepare('SELECT * FROM ev_samples WHERE ts >= ? AND ts < ? ORDER BY ts').all(fromSec, toSec);
}

// Car start/stop/limit events for chart markers.
export function evEvents(fromSec, toSec) {
  return db.prepare(`SELECT ts, kind, title, body, amps FROM notifications
    WHERE ts >= ? AND ts < ? AND kind IN ('AUTO_START', 'AUTO_STOP', 'AUTO_LIMIT', 'EV_STARTED', 'EV_STOPPED') ORDER BY ts`).all(fromSec, toSec);
}

export function recentNotifications(limit = 20) {
  return db.prepare('SELECT * FROM notifications ORDER BY ts DESC LIMIT ?').all(limit);
}

// --- Rollups -------------------------------------------------------------
// Energy per second = W * 1s / 3600. Missing seconds are not counted (n shows coverage).
const rollupSql = db.prepare(`INSERT OR REPLACE INTO rollup_1m
SELECT (ts/60)*60, COUNT(*),
  AVG(pv), MIN(pv), MAX(pv),
  AVG(batt), MIN(batt), MAX(batt),
  AVG(grid), MIN(grid), MAX(grid),
  AVG(load), MIN(load), MAX(load),
  AVG(soc), MIN(soc), MAX(soc),
  SUM(MAX(pv,0))/3600.0, SUM(MAX(load,0))/3600.0,
  SUM(MAX(grid,0))/3600.0, SUM(MAX(-grid,0))/3600.0,
  SUM(MAX(-batt,0))/3600.0, SUM(MAX(batt,0))/3600.0
FROM samples WHERE ts >= ? AND ts < ? GROUP BY ts/60`);

// Gateway rows only: the cloud stream is too coarse to see second-scale import.
const leakageSql = db.prepare(`INSERT OR REPLACE INTO leakage_1m
SELECT (ts/60)*60, COUNT(*),
  SUM(MAX(grid,0))/3600.0, SUM(CASE WHEN grid > 300 THEN grid ELSE 0 END)/3600.0, SUM(grid > 300), MAX(grid),
  SUM(MAX(load,0))/3600.0, SUM(MAX(batt,0))/3600.0, SUM(MAX(pv,0))/3600.0, AVG(soc)
FROM samples WHERE ts >= ? AND ts < ? AND src = 1 AND soc > COALESCE(backup_soc, 0) + 5 GROUP BY ts/60`);

export function rollup(fromSec, toSec) {
  const a = Math.floor(fromSec / 60) * 60, b = Math.floor(toSec / 60) * 60;
  rollupSql.run(a, b);
  leakageSql.run(a, b);
}

// On boot, fill any minutes that have samples but no rollup row.
export function catchUpRollups() {
  const first = db.prepare('SELECT MIN(ts) AS t FROM samples').get().t;
  if (first == null) return;
  const last = db.prepare('SELECT MAX(ts) AS t FROM rollup_1m').get().t;
  rollupSql.run(Math.floor((last ?? first) / 60) * 60, Math.floor(Date.now() / 60000) * 60);
  const lastLeak = db.prepare('SELECT MAX(ts) AS t FROM leakage_1m').get().t;
  leakageSql.run(Math.floor((lastLeak ?? first) / 60) * 60, Math.floor(Date.now() / 60000) * 60);
}

// Drop per-second rows older than cutoff (RECORD_HISTORY off). Minute rollups and leakage stay.
export function pruneDetail(cutoffSec) {
  let n = 0;
  for (const t of ['samples', 'meter_readings', 'battery_units', 'inverters', 'ev_samples']) {
    n += Number(db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoffSec).changes);
  }
  return n;
}

export function leakageSeries(fromSec, toSec, res = 3600) {
  return db.prepare(`SELECT (ts/CAST(? AS INTEGER))*CAST(? AS INTEGER) AS t, SUM(n) AS n, SUM(imp_wh) AS imp_wh, SUM(spike_wh) AS spike_wh,
      SUM(spike_s) AS spike_s, MAX(max_w) AS max_w, SUM(load_wh) AS load_wh, SUM(batt_wh) AS batt_wh, AVG(soc) AS soc
    FROM leakage_1m WHERE ts >= ? AND ts < ? GROUP BY t ORDER BY t`).all(res, res, fromSec, toSec);
}

// --- Queries -------------------------------------------------------------
const COLS = ['pv', 'batt', 'grid', 'load', 'soc'];

export function pickResolution(spanSec) {
  if (spanSec <= 6 * 3600) return 1;
  if (spanSec <= 4 * 86400) return 60;
  if (spanSec <= 45 * 86400) return 900;
  return 3600;
}

// Columnar output for uPlot: { res, t:[], pv:[], pv_min:[], ... }
export function series(fromSec, toSec, res) {
  const out = { res, t: [] };
  if (res === 1) {
    for (const c of [...COLS, 'gen', 'backup_soc', 'relay', 'src']) out[c] = [];
    const rows = db.prepare(`SELECT ts, pv, batt, grid, load, soc, gen, backup_soc, relay, src
      FROM samples WHERE ts >= ? AND ts < ? ORDER BY ts`).all(fromSec, toSec);
    for (const r of rows) {
      out.t.push(r.ts);
      for (const c of [...COLS, 'gen', 'backup_soc', 'relay', 'src']) out[c].push(r[c]);
    }
    return out;
  }
  for (const c of COLS) { out[c] = []; out[c + '_min'] = []; out[c + '_max'] = []; }
  out.n = [];
  // Recent minutes may not be rolled up yet; compute from raw for the open tail.
  rollup(Math.max(fromSec, Date.now() / 1000 - 180), Date.now() / 1000 + 60);
  const rows = db.prepare(`SELECT (ts/CAST(? AS INTEGER))*CAST(? AS INTEGER) AS b, SUM(n) AS n,
      ${COLS.map((c) => `SUM(${c}*n)/SUM(n) AS ${c}, MIN(${c}_min) AS ${c}_min, MAX(${c}_max) AS ${c}_max`).join(', ')}
    FROM rollup_1m WHERE ts >= ? AND ts < ? GROUP BY b ORDER BY b`).all(res, res, fromSec, toSec);
  for (const r of rows) {
    out.t.push(r.b);
    out.n.push(r.n);
    for (const c of COLS) {
      out[c].push(r[c]); out[c + '_min'].push(r[c + '_min']); out[c + '_max'].push(r[c + '_max']);
    }
  }
  return out;
}

export function energy(fromSec, toSec) {
  rollup(Math.max(fromSec, Date.now() / 1000 - 180), Date.now() / 1000 + 60);
  const r = db.prepare(`SELECT SUM(n) AS n, SUM(pv_wh) AS produced, SUM(load_wh) AS consumed,
      SUM(imp_wh) AS imported, SUM(exp_wh) AS exported, SUM(chg_wh) AS charged, SUM(dis_wh) AS discharged,
      MIN(soc_min) AS soc_min, MAX(soc_max) AS soc_max
    FROM rollup_1m WHERE ts >= ? AND ts < ?`).get(fromSec, toSec);
  const expected = Math.max(1, Math.min(toSec, Date.now() / 1000) - fromSec);
  return { ...r, coverage: Math.min(1, (r.n || 0) / expected) };
}

export function meterSeries(fromSec, toSec, res) {
  const rows = db.prepare(`SELECT (ts/CAST(? AS INTEGER))*CAST(? AS INTEGER) AS b, kind, AVG(v) AS v, MIN(v) AS v_min, MAX(v) AS v_max,
      AVG(hz) AS hz, MIN(hz) AS hz_min, MAX(hz) AS hz_max, AVG(pf) AS pf, AVG(i) AS i, AVG(q) AS q
    FROM meter_readings WHERE ts >= ? AND ts < ? GROUP BY b, kind ORDER BY b`).all(res, res, fromSec, toSec);
  return rows;
}

export function batterySeries(fromSec, toSec) {
  return db.prepare(`SELECT ts, serial, soc, temp FROM battery_units WHERE ts >= ? AND ts < ? ORDER BY ts`)
    .all(fromSec, toSec);
}

export function latestBatteryUnits() {
  return db.prepare(`SELECT b.* FROM battery_units b
    JOIN (SELECT serial, MAX(ts) AS ts FROM battery_units GROUP BY serial) m USING (serial, ts)`).all();
}

export function latestInverters() {
  return db.prepare(`SELECT i.* FROM inverters i
    JOIN (SELECT serial, MAX(ts) AS ts FROM inverters GROUP BY serial) m USING (serial, ts)
    ORDER BY serial`).all();
}

export function rawRows(fromSec, toSec) {
  return db.prepare('SELECT * FROM samples WHERE ts >= ? AND ts < ? ORDER BY ts').iterate(fromSec, toSec);
}

export function cloudIntervals(fromSec, toSec) {
  return db.prepare('SELECT * FROM cloud_intervals WHERE ts >= ? AND ts < ? ORDER BY ts').all(fromSec, toSec);
}

export function stats() {
  const s = db.prepare('SELECT COUNT(*) AS rows, MIN(ts) AS first, MAX(ts) AS last FROM samples').get();
  let bytes = 0;
  for (const f of [dbFile, dbFile + '-wal']) { try { bytes += fs.statSync(f).size; } catch {} }
  return { ...s, bytes };
}
