// End-of-day excess-solar report. Usage: node scripts/daily-report.js [YYYY-MM-DD]
// Builds a 1-minute series (gateway 1 Hz data where present, Enlighten 15-min history otherwise),
// detects large load steps (EV sessions and appliances), and scores how much excess solar was
// kept on site. Writes data/reports/<date>.json; the baseline is the median of earlier reports.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../src/db.js';
import { config } from '../src/config.js';

const STEP_W = 1000;          // load change that counts as an appliance switching on/off
const DAYLIGHT_W = 50;

const day = process.argv[2] || new Date().toLocaleDateString('en-CA');
const d0 = Math.floor(new Date(`${day}T00:00:00`).getTime() / 1000);
const d1 = d0 + 86400;
const fmtT = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

// --- 1-minute series
const local = new Map(db.prepare(`SELECT (ts/60)*60 AS m, AVG(pv) AS pv, AVG(load) AS load, AVG(batt) AS batt,
    AVG(grid) AS grid, MAX(soc) AS soc, COUNT(*) AS n FROM samples WHERE ts >= ? AND ts < ? GROUP BY m`)
  .all(d0, d1).filter((r) => r.n >= 45).map((r) => [r.m, r]));
const cloud = new Map(db.prepare('SELECT * FROM cloud_intervals WHERE ts >= ? AND ts < ?').all(d0, d1).map((r) => [r.ts, r]));
const end = Math.min(d1, Math.floor(Date.now() / 60000) * 60);
const mins = [];
for (let m = d0; m < end; m += 60) {
  const l = local.get(m);
  if (l) { mins.push({ ts: m, src: 'local', pv: Math.max(0, l.pv), load: l.load, batt: l.batt, grid: l.grid, soc: l.soc }); continue; }
  const c = cloud.get(Math.floor(m / 900) * 900);
  if (!c) { mins.push({ ts: m, src: 'none' }); continue; }
  const imp = Math.max(0, c.consumption + c.charge + (c.export || 0) - c.production - c.discharge);
  mins.push({ ts: m, src: 'cloud', pv: c.production * 4, load: c.consumption * 4, batt: (c.discharge - c.charge) * 4,
    grid: (imp - (c.export || 0)) * 4, soc: c.soc });
}
const have = mins.filter((x) => x.src !== 'none');

// --- load steps -> sessions (gateway minutes only; 15-min history is too coarse)
const advised = [];
{
  let on = null;
  for (const n of db.prepare(`SELECT ts, kind, amps FROM notifications WHERE ts >= ? AND ts < ? AND sent = 1
      AND kind IN ('START','ADJUST','STOP') ORDER BY ts`).all(d0 - 3600, d1)) {
    if (n.kind === 'STOP') { if (on) advised.push({ ...on, end: n.ts }); on = null; }
    else if (!on) on = { start: n.ts, amps: n.amps };
  }
  if (on) advised.push({ ...on, end: end });
}
const sessions = [];
{
  const loads = mins.map((x) => (x.src === 'local' ? x.load : null));
  const delta = loads.map((v, i) => {
    if (i < 3 || i > mins.length - 3 || v == null) return 0;
    const before = median(loads.slice(i - 3, i).filter((x) => x != null));
    const after = median(loads.slice(i, i + 3).filter((x) => x != null));
    return before == null || after == null ? 0 : after - before;
  });
  // One step shows up in several neighbouring deltas; keep only the local peak.
  const peak = (i) => delta.slice(Math.max(0, i - 3), i + 4).every((x) => Math.abs(x) <= Math.abs(delta[i]));
  const open = [];
  for (let i = 3; i < mins.length - 3; i++) {
    const d = delta[i];
    if (Math.abs(d) < STEP_W / 2 || !peak(i)) continue;
    // A charger ramps up over a few minutes: fold a second rise within 6 min into the same session.
    if (d > 0 && open.length && i - open.at(-1).i <= 6) { open.at(-1).w += d; open.at(-1).i = i; continue; }
    if (d >= STEP_W) open.push({ i, ts: mins[i].ts, w: d });
    else if (d <= -STEP_W && open.length) {
      // close the open step closest in size
      let k = 0;
      open.forEach((o, j) => { if (Math.abs(o.w + d) < Math.abs(open[k].w + d)) k = j; });
      const o = open.splice(k, 1)[0];
      sessions.push({ start: o.ts, end: mins[i].ts, w: Math.round((o.w - d) / 2) });
    }
  }
  for (const o of open) sessions.push({ start: o.ts, end, w: Math.round(o.w), open: true });
}
for (const s of sessions) {
  s.minutes = (s.end - s.start) / 60;
  s.kwh = Math.round((s.w * s.minutes) / 60) / 1000;
  // EV = starts while the advisor had the car charging (START/ADJUST .. STOP, +15 min to react).
  s.ev = (s.minutes >= 15 || s.open) && advised.some((a) => s.start >= a.start - 300 && s.start <= a.end + 900);
  s.label = s.ev ? 'EV' : 'Other load';
}
sessions.sort((a, b) => a.start - b.start);

// EV draw per minute: measured by the Tesla BLE bridge where available, else detected EV sessions.
const evMeasured = new Map(db.prepare(`SELECT (ts/60)*60 AS m, AVG(CASE WHEN charging = 1 THEN power_w ELSE 0 END) AS w
  FROM ev_samples WHERE ts >= ? AND ts < ? AND (state IS NOT NULL OR power_w IS NOT NULL) GROUP BY m`)
  .all(d0, d1).map((r) => [r.m, r.w]));
for (const x of have) {
  const s = sessions.find((q) => q.ev && x.ts >= q.start && x.ts < q.end);
  x.ev = evMeasured.has(x.ts) ? evMeasured.get(x.ts) || 0 : s ? Math.min(s.w, Math.max(0, x.load)) : 0;
  x.house = x.load - x.ev;
}

// --- energy totals (Wh; each minute = 1/60 h)
const wh = (f, xs = have) => Math.round(xs.reduce((a, x) => a + f(x), 0) / 60);
const daylight = have.filter((x) => x.pv > DAYLIGHT_W);
const firstSun = daylight[0]?.ts ?? null, lastSun = daylight.at(-1)?.ts ?? null;
const produced = wh((x) => x.pv);
const excess = wh((x) => Math.max(0, x.pv - x.house), daylight);
const exported = wh((x) => Math.max(0, -x.grid), daylight);
const importedDay = wh((x) => Math.max(0, x.grid), daylight);
const battCharged = wh((x) => Math.max(0, -x.batt), daylight);
const evWh = wh((x) => x.ev);
const evSolarWh = wh((x) => Math.min(x.ev, Math.max(0, x.pv - x.house)));
const full = have.find((x) => x.soc >= 99);
const sunsetSoc = lastSun ? have.find((x) => x.ts === lastSun)?.soc : null;
// --- grid leakage: grid import while the house battery could have covered it (see docs/grid-leakage.md).
// Gateway 1 Hz rows only. Spike = import above SPIKE_W (battery lagging a load step); bias = the rest.
const SPIKE_W = 300;
const leak = db.prepare(`SELECT
    SUM(CASE WHEN grid > 0 THEN grid ELSE 0 END) / 3600.0 AS wh,
    SUM(CASE WHEN grid > ${SPIKE_W} THEN grid ELSE 0 END) / 3600.0 AS spike_wh,
    SUM(grid > ${SPIKE_W}) AS spike_s,
    SUM(CASE WHEN pv < ${DAYLIGHT_W} AND grid > 0 THEN grid ELSE 0 END) / 3600.0 AS night_wh,
    SUM(CASE WHEN pv < ${DAYLIGHT_W} THEN MAX(load, 0) ELSE 0 END) / 3600.0 AS night_load_wh,
    COUNT(*) AS n, MAX(grid) AS max_w
  FROM samples WHERE ts >= ? AND ts < ? AND src = 1 AND soc > COALESCE(backup_soc, 0) + 5`).get(d0, d1);
const leakage = {
  seconds: leak.n,
  wh: Math.round(leak.wh || 0),
  spikeWh: Math.round(leak.spike_wh || 0),
  biasWh: Math.round((leak.wh || 0) - (leak.spike_wh || 0)),
  spikeSeconds: leak.spike_s || 0,
  maxW: Math.round(leak.max_w || 0),
  // share of night-time house use that still came from the grid with battery available
  nightPct: leak.night_load_wh > 0 ? Math.round((leak.night_wh / leak.night_load_wh) * 1000) / 10 : null,
};

const notes = db.prepare('SELECT ts, kind, sent, amps, title, error FROM notifications WHERE ts >= ? AND ts < ? ORDER BY ts').all(d0, d1)
  .filter((n) => n.kind !== 'TEST');

const report = {
  day, generatedAt: Math.floor(Date.now() / 1000),
  coverage: {
    localPct: Math.round((have.filter((x) => x.src === 'local').length / mins.length) * 100),
    cloudPct: Math.round((have.filter((x) => x.src === 'cloud').length / mins.length) * 100),
    missingPct: Math.round(((mins.length - have.length) / mins.length) * 100),
  },
  sun: { first: firstSun, last: lastSun },
  wh: { produced, excess, exported, importedDaylight: importedDay, batteryCharged: battCharged, ev: evWh, evFromSolar: evSolarWh },
  // Headline: share of excess solar kept on site (battery + car) instead of exported.
  captureRate: excess > 0 ? Math.round((1 - exported / excess) * 1000) / 1000 : null,
  evSolarShare: evWh > 0 ? Math.round((evSolarWh / evWh) * 1000) / 1000 : null,
  battery: { fullAt: full?.ts ?? null, socAtSunset: sunsetSoc },
  gridLeakage: leakage,
  // Days mostly on 15-min cloud history can't separate the car from the house; keep them out of the baseline.
  baselineEligible: Math.round((have.filter((x) => x.src === 'local').length / mins.length) * 100) >= 40,
  notifications: {
    sent: notes.filter((n) => n.sent).length, failed: notes.filter((n) => !n.sent).length,
    list: notes.map((n) => ({ ts: n.ts, kind: n.kind, sent: Boolean(n.sent), amps: n.amps, title: n.title, error: n.error })),
  },
  sessions,
  evMeasuredMinutes: evMeasured.size,
  series: have.filter((x) => x.ts % 300 === 0).map((x) => [x.ts, Math.round(x.pv), Math.round(x.load), Math.round(x.house), Math.round(x.grid), x.soc]),
};

const dir = path.join(config.dataDir, 'reports');
fs.mkdirSync(dir, { recursive: true });
const prior = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== `${day}.json`)
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((r) => r.captureRate != null && r.baselineEligible);
report.baseline = {
  days: prior.length,
  captureRate: prior.length ? median(prior.map((r) => r.captureRate)) : null,
  evSolarShare: prior.length ? median(prior.filter((r) => r.evSolarShare != null).map((r) => r.evSolarShare)) : null,
  notificationsPerDay: prior.length ? median(prior.map((r) => r.notifications.sent)) : null,
};
fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify(report, null, 2));

const kwh = (w) => `${(w / 1000).toFixed(1)} kWh`;
console.log(`Report ${day}  (gateway ${report.coverage.localPct}% / cloud ${report.coverage.cloudPct}% / missing ${report.coverage.missingPct}%)`);
console.log(`solar ${kwh(produced)}  excess ${kwh(excess)}  exported ${kwh(exported)}  capture ${report.captureRate == null ? '-' : Math.round(report.captureRate * 100) + '%'}`);
console.log(`battery charged ${kwh(battCharged)}  full at ${full ? fmtT(full.ts) : 'never'}  soc at sunset ${sunsetSoc ?? '-'}%`);
console.log(`EV ${kwh(evWh)} (${kwh(evSolarWh)} from solar)  daylight grid import ${kwh(importedDay)}`);
console.log(`grid leakage ${leakage.wh} Wh (spikes ${leakage.spikeWh} Wh over ${leakage.spikeSeconds} s, bias ${leakage.biasWh} Wh, max ${leakage.maxW} W)`
  + `, night ${leakage.nightPct ?? '-'}% of house use  [${Math.round(leakage.seconds / 36) / 100} h of gateway data]`);
console.log(`notifications sent ${report.notifications.sent}, failed ${report.notifications.failed}`);
for (const s of sessions) console.log(`  ${fmtT(s.start)}-${s.open ? 'now' : fmtT(s.end)} ${s.label} ~${(s.w / 1000).toFixed(1)} kW ${s.minutes} min ${s.kwh} kWh`);
console.log(`baseline: ${prior.length} earlier day(s)`);
