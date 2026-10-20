// Location + Open-Meteo hourly irradiance (past 92 days for training, next 2 days for forecast).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { writeWeather } from './db.js';
import { log } from './log.js';

const locFile = path.join(config.dataDir, 'location.json');

export async function getLocation() {
  if (config.ev.lat && config.ev.lon) return { lat: config.ev.lat, lon: config.ev.lon, name: 'LAT/LON from .env' };
  if (!config.ev.location) throw new Error('Set LOCATION (ZIP or city) or LAT/LON in .env for the weather forecast');
  try {
    const c = JSON.parse(fs.readFileSync(locFile, 'utf8'));
    if (c.query === config.ev.location) return c;
  } catch {}

  let loc;
  const q = config.ev.location.trim();
  if (/^\d{5}$/.test(q)) {
    const r = await fetch(`https://api.zippopotam.us/us/${q}`);
    if (!r.ok) throw new Error(`ZIP ${q} not found`);
    const p = (await r.json()).places[0];
    loc = { lat: Number(p.latitude), lon: Number(p.longitude), name: `${p['place name']}, ${p['state abbreviation']}` };
  } else {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(q)}`);
    const g = ((await r.json()).results || [])[0];
    if (!g) throw new Error(`Location "${q}" not found`);
    loc = { lat: g.latitude, lon: g.longitude, name: `${g.name}, ${g.admin1 || g.country}` };
  }
  // ~1 km precision is plenty for weather.
  loc = { ...loc, lat: Math.round(loc.lat * 100) / 100, lon: Math.round(loc.lon * 100) / 100, query: q };
  fs.writeFileSync(locFile, JSON.stringify(loc, null, 2));
  log.info('weather', `location: ${loc.name}`);
  return loc;
}

export async function refreshWeather() {
  const { lat, lon } = await getLocation();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&hourly=shortwave_radiation,cloud_cover,temperature_2m&past_days=92&forecast_days=3&timeformat=unixtime';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`open-meteo ${r.status}`);
  const h = (await r.json()).hourly;
  // shortwave_radiation at time T is the mean over the preceding hour -> store under hour start T-3600.
  writeWeather(h.time.map((t, i) => ({
    ts: t - 3600, ghi: h.shortwave_radiation[i], cloud: h.cloud_cover[i], temp: h.temperature_2m[i],
  })));
  return h.time.length;
}

export function startWeather() {
  const run = () => refreshWeather().catch((e) => log.warn('weather', e.message));
  run();
  setInterval(run, 30 * 60_000);
}
