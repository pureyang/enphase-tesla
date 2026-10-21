// Two cars on one Tesla BLE bridge. The bridge talks to one car at a time ("Active Car").
//   Discovery: while the active car's charge port is closed (or the car isn't in range), switch to the
//   other car every DWELL_S, so whichever car gets plugged in is found within a few minutes.
//   Locked: once the active car's charge port is open (cable in), stay with it until it closes.
// The charge port door comes from VCSEC, which the bridge reads without waking the car.
import { config } from './config.js';
import { log } from './log.js';

const DWELL_S = 4 * 60;      // time on each car before moving on: connect + a few VCSEC polls
const SETTLE_S = 45;         // after a switch, wait this long before asking the car for fresh data

export class CarSwitcher {
  constructor(tesla) {
    this.tesla = tesla;
    this.lastSwitch = Math.floor(Date.now() / 1000); // give the car the bridge starts on a full dwell
    this.refreshed = true;
    this.status = { enabled: config.tesla.cars.length > 1, mode: 'single car', car: config.tesla.cars[0].name };
  }

  start() {
    if (!this.status.enabled || !this.tesla.enabled()) return;
    const run = () => this.tick().catch((e) => log.warn('cars', e.message));
    setTimeout(run, 20_000);
    setInterval(run, 30_000);
  }

  async tick() {
    const now = Math.floor(Date.now() / 1000);
    const t = this.tesla;
    const car = t.car();
    const s = t.state;
    const sinceSwitch = now - Math.max(this.lastSwitch, Math.floor(t.status.switchedAt / 1000));
    const connected = Boolean(s.bleConnected) && !s.pairingRequired && Date.now() - t.status.lastEventAt < 60_000;

    // Once connected after a switch, ask the car for a full update so no field is left empty.
    if (!this.refreshed && connected && sinceSwitch >= SETTLE_S) {
      this.refreshed = true;
      await t.forceUpdate().catch((e) => log.warn('cars', `force update: ${e.message}`));
    }

    const c = t.current();
    const plugged = c.portOpen === true || (c.pluggedIn === true && c.state != null && c.state !== 'Disconnected');
    if (connected && plugged) {
      this.status = { enabled: true, mode: 'locked', car: car.name, reason: `${car.name} is plugged in` };
      return;
    }
    const why = !connected ? `${car.name} not in range or not paired` : `${car.name} not plugged in`;
    if (sinceSwitch < DWELL_S) {
      this.status = { enabled: true, mode: 'discovery', car: car.name, reason: `${why}; checking it until ${clock(now - sinceSwitch + DWELL_S)}` };
      return;
    }
    const cars = config.tesla.cars;
    const next = cars[(cars.findIndex((x) => x.key === car.key) + 1) % cars.length];
    log.info('cars', `${why}; switching bridge to ${next.name}`);
    await t.setActiveCar(next.key);
    this.lastSwitch = now;
    this.refreshed = false;
    this.status = { enabled: true, mode: 'discovery', car: next.name, reason: `switched to ${next.name} (${why})` };
  }
}

const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
