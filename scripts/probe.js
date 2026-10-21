// Checks each connection step once and prints what works. Run: npm run probe
import { config } from '../src/config.js';
import { getSession, getGatewaySerial, getGatewayToken, hasCloudCreds } from '../src/auth.js';
import { LocalSource } from '../src/sources/local.js';
import { CloudSource } from '../src/sources/cloud.js';

const step = async (name, fn) => {
  try {
    const r = await fn();
    console.log(`OK   ${name}${r ? ' — ' + r : ''}`);
    return true;
  } catch (e) {
    console.log(`FAIL ${name} — ${e.message}`);
    return false;
  }
};

if (hasCloudCreds()) {
  await step('Enlighten login', async () => { await getSession({ force: true }); });
  if (config.gateway.serial || config.enlighten.cloud) await step('Gateway serial', async () => `…${(await getGatewaySerial()).slice(-4)}`);
  else console.log('FAIL Gateway serial — set GATEWAY_SERIAL in .env');
} else {
  console.log('SKIP Enlighten login — ENLIGHTEN_EMAIL / ENLIGHTEN_PASSWORD not set');
}

if (config.gateway.host) {
  await step('Gateway token', async () => { await getGatewayToken(); });
  const local = new LocalSource();
  await step(`Gateway livedata (${config.gateway.host})`, async () => {
    await local.enableStream();
    const j = await local.request('GET', '/ivp/livedata/status');
    const m = j.meters || {};
    return `pv ${(m.pv?.agg_p_mw ?? 0) / 1000} W, load ${(m.load?.agg_p_mw ?? 0) / 1000} W, soc ${m.enc_agg_soc ?? m.soc}%`;
  });
  await step('Gateway meter readings', async () => `${(await local.request('GET', '/ivp/meters/readings')).length} meters`);
  await step('Gateway battery inventory', async () => {
    const inv = await local.request('GET', '/ivp/ensemble/inventory');
    return `${inv.flatMap((g) => g.devices || []).length} devices`;
  });
} else {
  console.log('SKIP Gateway — GATEWAY_HOST not set');
}

if (config.enlighten.cloud && hasCloudCreds()) {
  const cloud = new CloudSource();
  await step('Cloud live stream (waits up to 20 s for a frame)', () => new Promise((resolve, reject) => {
    const t = setTimeout(() => { cloud.stop(); reject(new Error(cloud.status.error || 'no frame in 20 s')); }, 20_000);
    cloud.on('sample', (s) => {
      clearTimeout(t); cloud.stop();
      resolve(`pv ${s.pv} W, batt ${s.batt} W, grid ${s.grid} W, load ${s.load} W, soc ${s.soc}%`);
    });
    cloud.start();
  }));
}
process.exit(0);
