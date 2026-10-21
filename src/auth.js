// Enlighten session + local gateway (Envoy) JWT handling.
// Tokens are cached in data/tokens.json so restarts don't re-login.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';

const cacheFile = path.join(config.dataDir, 'tokens.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

function save() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

function jwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return (payload.exp || 0) * 1000;
  } catch { return 0; }
}

export function hasCloudCreds() {
  return Boolean(config.enlighten.email && config.enlighten.password);
}

// Enlighten web session. Same value the web app sends as `e-auth-token`.
export async function getSession({ force = false } = {}) {
  const fresh = cache.session && Date.now() - cache.session.at < 6 * 3600e3;
  if (!force && fresh) return cache.session.id;
  if (!hasCloudCreds()) throw new Error('ENLIGHTEN_EMAIL / ENLIGHTEN_PASSWORD not set in .env');

  const body = new URLSearchParams({
    'user[email]': config.enlighten.email,
    'user[password]': config.enlighten.password,
  });
  const res = await fetch(`${config.enlighten.base}/login/login.json`, { method: 'POST', body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.session_id) {
    throw new Error(`Enlighten login failed (${res.status}): ${json.message || 'no session_id'}`);
  }
  cache.session = { id: json.session_id, at: Date.now() };
  save();
  log.info('auth', 'Enlighten session refreshed');
  return json.session_id;
}

export function enlightenHeaders(sessionId) {
  return {
    'e-auth-token': sessionId,
    Cookie: `_enlighten_4_session=${sessionId}`,
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

// Gateway serial: from .env, else discovered via the same devices.json the Enlighten UI loads.
export async function getGatewaySerial() {
  if (config.gateway.serial) return config.gateway.serial;
  if (cache.gatewaySerial) return cache.gatewaySerial;
  if (!config.enlighten.cloud) throw new Error('Set GATEWAY_SERIAL in .env (or ENLIGHTEN_CLOUD=1 to look it up)');
  const session = await getSession();
  const res = await fetch(`${config.enlighten.base}/app-api/${config.enlighten.siteId}/devices.json`, {
    headers: enlightenHeaders(session),
  });
  const json = await res.json().catch(() => ({}));
  const envoy = (json.result || []).find((g) => g.type === 'envoy');
  const serial = envoy && envoy.devices && envoy.devices[0] && envoy.devices[0].serial_num;
  if (!serial) throw new Error('Could not discover gateway serial; set GATEWAY_SERIAL in .env');
  cache.gatewaySerial = String(serial);
  save();
  return cache.gatewaySerial;
}

// Local gateway JWT. Prefers GATEWAY_TOKEN from .env, else mints one the way Enphase's local API
// tech brief describes: Enlighten login, then Entrez (valid ~1 year). Not part of ENLIGHTEN_CLOUD.
export async function getGatewayToken({ force = false } = {}) {
  if (config.gateway.token && !force) return config.gateway.token;
  const c = cache.gateway;
  if (!force && c && jwtExp(c.token) - Date.now() > 7 * 86400e3) return c.token;

  const session = await getSession();
  const serial = await getGatewaySerial();
  const res = await fetch('https://entrez.enphaseenergy.com/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: session,
      serial_num: serial,
      username: config.enlighten.email,
    }),
  });
  const token = (await res.text()).trim();
  if (!res.ok || token.split('.').length !== 3) {
    throw new Error(`Entrez token request failed (${res.status})`);
  }
  cache.gateway = { token, at: Date.now() };
  save();
  log.info('auth', `Gateway token minted, expires ${new Date(jwtExp(token)).toISOString().slice(0, 10)}`);
  return token;
}
