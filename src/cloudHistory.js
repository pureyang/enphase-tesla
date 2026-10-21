// Optional (ENLIGHTEN_CLOUD=1): pulls Enlighten's own 15-minute history (Wh per interval). The EV advisor
// learns from it, and History charts use it wherever the per-second logger has no data (e.g. laptop
// asleep, or before this app was installed). ENLIGHTEN_BACKFILL_DAYS sets the depth (default 365, or "all").
// GET /pv/systems/<site>/daily_energy?start_date=YYYY-MM-DD returns that date to month end.
import { config } from './config.js';
import { getSession, enlightenHeaders, hasCloudCreds } from './auth.js';
import { db, writeCloudInterval, syncLocalIntervals } from './db.js';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

// Remembers where the account's history begins, so "all" doesn't re-probe older months on every boot.
const stateFile = path.join(config.dataDir, 'history.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };

const PAUSE_MS = 1500;       // between month requests, to go easy on Enlighten
const MAX_MONTHS = 240;

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Stores intervals in [startDate, endTs) and returns how many. Before the system existed Enlighten
// answers with its first days instead of nothing, so anything outside the range is ignored.
async function fetchFrom(startDate, endTs = Infinity) {
  const session = await getSession();
  const url = `${config.enlighten.base}/pv/systems/${config.enlighten.siteId}/daily_energy?start_date=${startDate}`;
  const res = await fetch(url, { headers: enlightenHeaders(session) });
  if (!res.ok) throw new Error(`daily_energy ${startDate}: ${res.status}`);
  const json = await res.json();
  const [y, m, d] = startDate.split('-').map(Number);
  const startTs = new Date(y, m - 1, d) / 1000;
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const st of json.stats || []) {
      const step = st.interval_length || 900;
      const at = (k, i) => (st[k] ? st[k][i] ?? null : null);
      for (let i = 0; i < (st.production || []).length; i++) {
        const ts = st.start_time + i * step;
        if (ts + step > Date.now() / 1000) break; // only completed intervals
        if (ts < startTs || ts >= endTs) continue;
        writeCloudInterval({
          ts,
          production: at('production', i), consumption: at('consumption', i),
          charge: at('charge', i), discharge: at('discharge', i),
          gridImport: at('grid_import', i), soc: at('soc', i),
          export: (at('solar_grid', i) || 0) + (at('battery_grid', i) || 0),
        });
        n++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

// Newest month first, so recent training data lands first. Months already complete are skipped, so a
// restart only fetches what's missing. With "all", it stops after two empty months (before the system existed).
export async function backfill() {
  if (!hasCloudCreds() || !config.enlighten.siteId) return;
  const now = new Date();
  const all = config.enlighten.backfillDays === 'all';
  const known = readState().firstTs;
  const oldest = all ? (known ? new Date(known * 1000) : null) : new Date(now - config.enlighten.backfillDays * 86400e3);
  const count = db.prepare('SELECT COUNT(*) AS n FROM cloud_intervals WHERE ts >= ? AND ts < ?');
  let total = 0, empty = 0, months = 0, fetched = 0;
  for (let d = new Date(now.getFullYear(), now.getMonth(), 1); months < MAX_MONTHS; d = new Date(d.getFullYear(), d.getMonth() - 1, 1), months++) {
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    if (oldest && end <= oldest) break;
    const from = oldest && oldest > d ? oldest : d;
    const expected = (Math.min(end, now) - from) / 900e3;
    const recent = end > new Date(now - 2 * 86400e3); // this month (and last, early in a month): always refresh
    if (!recent && count.get(from / 1000, end / 1000).n >= expected * 0.95) { empty = 0; continue; }
    if (fetched++) await new Promise((r) => setTimeout(r, PAUSE_MS));
    const n = await fetchFrom(ymd(from), end / 1000);
    total += n;
    log.info('history', `Enlighten history ${ymd(from).slice(0, 7)}: ${n} intervals`);
    empty = n ? 0 : empty + 1;
    if (all && !oldest && empty >= 2) break;
  }
  const first = db.prepare('SELECT MIN(ts) AS a FROM cloud_intervals').get().a;
  if (all && !known && empty >= 2 && first) fs.writeFileSync(stateFile, JSON.stringify({ firstTs: first }, null, 2));
  log.info('history', `Enlighten 15-min history synced (${total} new/updated intervals, ${fetched} requests); history from ${first ? ymd(new Date(first * 1000)) : 'n/a'}`);
}

// Current month only: picks up each completed 15-min interval of today.
export async function syncRecent() {
  if (!hasCloudCreds() || !config.enlighten.siteId) return;
  const now = new Date();
  // Include yesterday so the first day of a month still refreshes the previous evening.
  const from = new Date(now.getFullYear(), now.getMonth(), Math.max(1, now.getDate() - 1));
  await fetchFrom(ymd(from));
}

export function startCloudHistory() {
  // Without ENLIGHTEN_CLOUD, build the same 15-min intervals from this logger's own minute rollups.
  if (!config.enlighten.cloud) {
    const local = (all) => {
      try {
        const n = syncLocalIntervals(all ? 0 : Math.floor(Date.now() / 1000) - 2 * 86400);
        if (all) log.info('history', `15-min history from local data (${n} intervals); ENLIGHTEN_CLOUD=1 adds Enlighten's`);
      } catch (e) { log.warn('history', e.message); }
    };
    setTimeout(() => local(true), 5_000);
    setInterval(() => local(false), 15 * 60_000);
    return;
  }
  backfill().catch((e) => log.warn('history', e.message));
  setInterval(() => syncRecent().catch((e) => log.warn('history', e.message)), 15 * 60_000);
}
