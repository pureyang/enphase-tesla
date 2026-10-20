// Learns this system's behaviour from Enlighten 15-min history + Open-Meteo irradiance:
//   - solar gain per hour of day (Wh produced per W/m2 of forecast irradiance)
//   - typical home load per hour of day (median, so past EV sessions don't inflate it)
//   - usable battery capacity and max charge rate
import { db } from './db.js';

const DAY = 86400;
const hourOfDay = (ts) => new Date(ts * 1000).getHours();

function percentile(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}

export function train({ days = 30 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * DAY;

  // Hourly sums of 15-min Wh -> average W for that hour.
  const hours = db.prepare(`SELECT (c.ts/3600)*3600 AS h, SUM(c.production) AS pv, SUM(c.consumption) AS load,
      COUNT(*) AS n, w.ghi AS ghi
    FROM cloud_intervals c LEFT JOIN weather_hourly w ON w.ts = (c.ts/3600)*3600
    WHERE c.ts >= ? GROUP BY h HAVING n = 4 ORDER BY h`).all(from);

  // --- solar gain per hour of day, recency-weighted
  const num = Array(24).fill(0), den = Array(24).fill(0), pvMax = Array(24).fill(0);
  for (const r of hours) {
    if (r.ghi == null || r.pv == null) continue;
    const hd = hourOfDay(r.h);
    pvMax[hd] = Math.max(pvMax[hd], r.pv);
    if (r.ghi < 20) continue;
    const w = Math.pow(0.93, (now - r.h) / DAY);
    num[hd] += w * r.pv;
    den[hd] += w * r.ghi;
  }
  const gain = num.map((n, i) => (den[i] > 0 ? n / den[i] : 0));

  // --- home load excluding EV: median per hour of day over the last 28 days.
  // Past EV sessions (4-6 kW blocks) would inflate it, so drop hours the advisor said to charge,
  // and hours more than 2 kW above that hour's quiet (25th percentile) level.
  const evHours = advisedChargingHours(from);
  const byHour = Array.from({ length: 24 }, () => []);
  for (const r of hours) {
    if (r.load != null && now - r.h < 28 * DAY && !evHours.has(r.h)) byHour[hourOfDay(r.h)].push(r.load);
  }
  const loadMedian = byHour.map((a) => {
    const q25 = percentile(a, 0.25);
    return percentile(a.filter((x) => x <= q25 + 2000), 0.5) ?? 800;
  });

  // --- battery capacity from charge energy vs SOC rise between consecutive intervals
  const iv = db.prepare(`SELECT ts, charge, discharge, soc FROM cloud_intervals WHERE ts >= ? ORDER BY ts`).all(from);
  let e = 0, dsoc = 0;
  const chargeW = [];
  for (let i = 1; i < iv.length; i++) {
    const a = iv[i - 1], b = iv[i];
    if (b.ts - a.ts !== 900 || a.soc == null || b.soc == null) continue;
    if (b.charge > 0) chargeW.push(b.charge * 4);
    if (b.charge > 150 && (b.discharge || 0) < 20 && a.soc >= 10 && b.soc <= 95 && b.soc > a.soc) {
      e += b.charge; dsoc += b.soc - a.soc;
    }
  }
  let capacityWh = dsoc > 20 ? (e * 0.96) / (dsoc / 100) : null;
  if (capacityWh && (capacityWh < 2000 || capacityWh > 60000)) capacityWh = null;
  const maxChargeW = percentile(chargeW, 0.98) || 3800;

  // --- backtest: daily production predicted vs actual for the last 14 full days
  const daily = new Map();
  for (const r of hours) {
    if (r.ghi == null || now - r.h > 14 * DAY) continue;
    const d = new Date(r.h * 1000).toDateString();
    const x = daily.get(d) || { act: 0, pred: 0 };
    x.act += r.pv || 0;
    x.pred += Math.min(gain[hourOfDay(r.h)] * r.ghi, pvMax[hourOfDay(r.h)] || Infinity);
    daily.set(d, x);
  }
  const errs = [...daily.values()].filter((x) => x.act > 2000).map((x) => Math.abs(x.pred - x.act) / x.act);
  const mape = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;

  return {
    trainedAt: now, days, hoursUsed: hours.length,
    gain, pvMax, loadMedian, capacityWh, maxChargeW, mape, backtestDays: errs.length,
  };
}

// Hour starts during which the advisor's sent messages had the car charging (START/ADJUST until STOP).
function advisedChargingHours(from) {
  const notes = db.prepare(`SELECT ts, kind FROM notifications WHERE ts >= ? AND sent = 1
    AND kind IN ('START', 'ADJUST', 'STOP') ORDER BY ts`).all(from - DAY);
  const out = new Set();
  let since = null;
  const add = (a, b) => { for (let h = Math.floor(a / 3600) * 3600; h < b; h += 3600) out.add(h); };
  for (const n of notes) {
    if (n.kind === 'STOP') { if (since != null) add(since, n.ts); since = null; }
    else if (since == null) since = n.ts;
  }
  if (since != null) add(since, Date.now() / 1000);
  return out;
}

// 15-min forecast steps [{ ts, ghi, pv, load }] from `fromTs` to `toTs` (pv before nowcast correction).
export function forecastSteps(m, fromTs, toTs) {
  const wx = new Map(db.prepare('SELECT ts, ghi, cloud FROM weather_hourly WHERE ts >= ? AND ts < ?')
    .all(Math.floor(fromTs / 3600) * 3600 - 3600, toTs + 3600).map((r) => [r.ts, r]));
  const steps = [];
  for (let t = Math.floor(fromTs / 900) * 900; t < toTs; t += 900) {
    const h = hourOfDay(t), w = wx.get(Math.floor(t / 3600) * 3600);
    const ghi = w ? w.ghi : 0;
    steps.push({
      ts: t, ghi, cloud: w ? w.cloud : null, hasWx: Boolean(w),
      pv: Math.min(m.gain[h] * ghi, m.pvMax[h] || Infinity),
      load: m.loadMedian[h],
    });
  }
  return steps;
}
