// Pulls Enlighten's own 15-minute history (Wh per interval). This is what the EV advisor
// learns from, and it covers time the per-second logger missed (e.g. laptop asleep).
// GET /pv/systems/<site>/daily_energy?start_date=YYYY-MM-DD returns that date to month end.
import { config } from './config.js';
import { getSession, enlightenHeaders, hasCloudCreds } from './auth.js';
import { db, writeCloudInterval } from './db.js';
import { log } from './log.js';

const BACKFILL_DAYS = 92; // matches Open-Meteo's past_days limit used for training

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function fetchFrom(startDate) {
  const session = await getSession();
  const url = `${config.enlighten.base}/pv/systems/${config.enlighten.siteId}/daily_energy?start_date=${startDate}`;
  const res = await fetch(url, { headers: enlightenHeaders(session) });
  if (!res.ok) throw new Error(`daily_energy ${startDate}: ${res.status}`);
  const json = await res.json();
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const st of json.stats || []) {
      const step = st.interval_length || 900;
      const at = (k, i) => (st[k] ? st[k][i] ?? null : null);
      for (let i = 0; i < (st.production || []).length; i++) {
        const ts = st.start_time + i * step;
        if (ts + step > Date.now() / 1000) break; // only completed intervals
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

export async function backfill() {
  if (!hasCloudCreds() || !config.enlighten.siteId) return;
  const have = db.prepare('SELECT MIN(ts) AS a FROM cloud_intervals').get().a;
  const start = new Date(Date.now() - BACKFILL_DAYS * 86400e3);
  // Already have the full window: only refresh from the start of this month.
  const covered = have && have <= start / 1000 + 86400;
  let d = covered ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) : start;
  let total = 0;
  while (d <= new Date()) {
    total += await fetchFrom(ymd(d));
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }
  log.info('history', `Enlighten 15-min history synced (${total} intervals)`);
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
  backfill().catch((e) => log.warn('history', e.message));
  setInterval(() => syncRecent().catch((e) => log.warn('history', e.message)), 15 * 60_000);
}
