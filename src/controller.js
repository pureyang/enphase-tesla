// Automatic EV control over the Tesla BLE bridge. Every EV_CONTROL_INTERVAL_S (default 60 s) it
// sets the car's amps from live power flow, in priority order:
//   1. Use all excess solar: never export while the car could take it.
//   2. Minimise grid: the car never draws on the house battery or the grid to charge.
// Below FULL_SOC it follows the advisor's plan (which leaves the house battery enough solar to reach
// target), capped at real excess. At/above FULL_SOC it tracks live excess minute by minute.
// A manual change in the Tesla app pauses control for EV_OVERRIDE_MIN.
import { config } from './config.js';
import { db, writeNotification } from './db.js';
import { notify } from './notify.js';
import { log } from './log.js';

const FULL_SOC = 95;
const MARGIN_W = 150;      // headroom so the car isn't the reason for a small import
const START_TICKS = 2;     // target must allow charging this many ticks in a row before starting
const STOP_TICKS = 3;      // ...and must be below min amps this many ticks before stopping
const DAYLIGHT_W = 100;    // below this solar it's night: only stop sessions we started
const CAR_CHARGE_EFF = 0.9; // wall -> pack

export class Controller {
  constructor(collector, tesla, advisor) {
    this.collector = collector;
    this.tesla = tesla;
    this.advisor = advisor;
    this.expect = null;       // what the car should be doing after our last command
    this.ownSession = false;  // true if we started the current session
    this.pausedUntil = 0;
    this.startCount = 0;
    this.stopCount = 0;
    this.wasCharging = null;
    this.status = { enabled: config.control.enabled, active: false, reason: 'starting' };
  }

  start() {
    if (!config.control.enabled || !this.tesla.enabled()) {
      this.status = { enabled: false, active: false, reason: config.control.enabled ? 'No Tesla BLE bridge configured' : 'EV_AUTO_CONTROL=0' };
      return;
    }
    const run = () => this.tick().catch((e) => log.warn('control', e.stack || e.message));
    setTimeout(run, 30_000);
    setInterval(run, config.control.intervalS * 1000);
  }

  // Started for today (EV_AUTO_FROM) and the car is reachable: pushes are handled here, not by the advisor.
  active() {
    if (!config.control.enabled || !this.tesla.live()) return false;
    return !config.control.from || new Date().toLocaleDateString('en-CA') >= config.control.from;
  }

  async tick() {
    const now = Math.floor(Date.now() / 1000);
    const car = this.tesla.live();
    const set = (reason, extra = {}) => { this.status = { enabled: true, active: false, at: now, reason, ...extra }; };
    if (config.control.from && new Date().toLocaleDateString('en-CA') < config.control.from) return set(`Starts ${config.control.from}`);
    if (!car) return set('Car not reachable over Bluetooth');
    await this.watchTransitions(now, car);
    if (car.pluggedIn === false || ['Complete', 'Disconnected'].includes(car.state)) {
      this.expect = null; this.ownSession = false;
      return set(car.pluggedIn === false ? 'Car not plugged in' : `Car ${car.state}`);
    }

    // Manual change in the Tesla app or car screen? Back off.
    const amps = Math.round(car.ampsSet ?? 0);
    if (this.expect && now - this.expect.ts > 120
        && (car.charging !== this.expect.charging || (car.charging && Math.abs(amps - this.expect.amps) >= 1))) {
      this.pausedUntil = now + config.control.overrideMin * 60;
      this.expect = null; this.ownSession = false;
      log.info('control', `manual change seen (car ${car.charging ? `charging ${amps} A` : 'stopped'}); paused until ${new Date(this.pausedUntil * 1000).toLocaleTimeString()}`);
    }
    if (now < this.pausedUntil) return set(`Paused after manual change until ${new Date(this.pausedUntil * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);

    const r = db.prepare('SELECT AVG(pv) AS pv, AVG(load) AS load, AVG(grid) AS grid, AVG(batt) AS batt, AVG(soc) AS soc, COUNT(*) AS n FROM samples WHERE ts >= ? AND src = 1')
      .get(now - config.control.intervalS);
    if (r.n < config.control.intervalS / 2) return set('Not enough live gateway data');
    const volts = car.voltage > 180 ? car.voltage : 240;
    const carW = car.charging ? (car.current ?? amps) * volts : 0;
    const excessW = r.pv - (r.load - carW);  // solar beyond the house, car excluded
    const exportW = Math.max(0, -r.grid);
    const importW = Math.max(0, r.grid);

    // At night leave manual sessions alone; stop only what we started.
    if (r.pv < DAYLIGHT_W) {
      if (car.charging && this.ownSession) return this.command(now, car, 0, 'Solar is down', { excessW, soc: r.soc });
      return set('Night: not managing', { excessW: Math.round(excessW), soc: r.soc });
    }

    const plan = this.advisor.last && this.advisor.last.plan;
    let targetW, mode;
    if (r.soc >= FULL_SOC) {
      // Battery nearly full: anything the car doesn't take is exported. Keep what the battery needs to top up.
      let reserveW = 0;
      if (plan && plan.ok && plan.solarEnd && r.soc < config.ev.targetSoc) {
        const hoursLeft = Math.max(0.25, (plan.solarEnd - now) / 3600);
        reserveW = ((config.ev.targetSoc - r.soc) / 100) * plan.capacityWh / hoursLeft;
      }
      targetW = excessW - reserveW - MARGIN_W;
      mode = 'live excess';
    } else {
      const want = this.advisor.last && this.advisor.last.want;
      targetW = want && want.charging ? Math.min(want.amps * volts, excessW - MARGIN_W) : 0;
      mode = 'plan';
    }
    // Priority 1: exporting with room on the car? Take it.
    if (exportW > MARGIN_W) targetW = Math.max(targetW, carW + exportW - MARGIN_W);
    // Priority 2: importing while charging? Back off by that much.
    if (car.charging && importW > MARGIN_W) targetW = Math.min(targetW, carW - importW);

    let next = Math.min(config.ev.maxAmps, Math.floor(targetW / volts));
    if (next < config.ev.minAmps) next = 0;
    const info = { mode, excessW, exportW, importW, soc: r.soc, targetW };

    if (!car.charging) {
      this.startCount = next > 0 ? this.startCount + 1 : 0;
      if (next > 0 && this.startCount >= START_TICKS) return this.command(now, car, next, `${mode}: ${(excessW / 1000).toFixed(1)} kW excess`, info);
    } else {
      this.stopCount = next === 0 ? this.stopCount + 1 : 0;
      if (next === 0 && this.stopCount >= STOP_TICKS) return this.command(now, car, 0, `${mode}: excess ${(excessW / 1000).toFixed(1)} kW is below ${config.ev.minAmps} A`, info);
      if (next > 0 && next !== amps) return this.command(now, car, next, `${mode}: ${(excessW / 1000).toFixed(1)} kW excess`, info);
    }
    set(car.charging ? `Holding ${amps} A` : 'Waiting for excess solar', round(info));
    this.status.active = true;
  }

  // amps 0 = stop. Sets amps before starting so the car never starts at an old, higher setting.
  async command(now, car, amps, reason, info) {
    const was = car.charging ? Math.round(car.ampsSet ?? 0) : 0;
    const kind = amps === 0 ? 'STOP' : !car.charging ? 'START' : 'ADJUST';
    let ok = true;
    try {
      if (car.asleep) await this.tesla.wake();
      if (amps > 0) await this.tesla.setAmps(amps);
      if (amps > 0 && !car.charging) await this.tesla.setCharging(true);
      if (amps === 0) await this.tesla.setCharging(false);
    } catch (e) {
      ok = false;
      log.warn('control', `${kind} ${amps} A failed: ${e.message}`);
    }
    this.startCount = this.stopCount = 0;
    if (ok) {
      this.expect = { charging: amps > 0, amps, ts: now };
      if (kind === 'START') this.ownSession = true;
      if (kind === 'STOP') this.ownSession = false;
    }
    const title = kind === 'STOP' ? 'Auto: stopped EV charging' : kind === 'START' ? `Auto: started EV at ${amps} A` : `Auto: EV ${was} A -> ${amps} A`;
    const body = `${reason}. Battery ${Math.round(info.soc)}%, grid ${info.importW > 0 ? `+${Math.round(info.importW)}` : `-${Math.round(info.exportW || 0)}`} W.`;
    log.info('control', `${title} (${reason})${ok ? '' : ' FAILED'}`);
    this.status = { enabled: true, active: true, at: now, reason: title, ...round(info) };

    writeNotification({ ts: now, kind: `AUTO_${kind}`, title, body: ok ? body : `${body} Command FAILED.`, amps, sent: false, error: ok ? 'log only' : 'command failed' });
  }

  // Push when the car starts or stops charging, whoever caused it (us, the Tesla app, or the car at its limit).
  async watchTransitions(now, car) {
    const was = this.wasCharging;
    this.wasCharging = car.charging;
    if (was == null || was === car.charging) return;
    const ours = this.expect && now - this.expect.ts < 180 && this.expect.charging === car.charging;
    const who = ours ? 'auto control' : car.state === 'Complete' ? 'car reached its charge limit' : 'Tesla app / car';
    const added = car.energyAdded != null ? ` ${car.energyAdded.toFixed(1)} kWh added this session.` : '';
    let title, body;
    if (car.charging) {
      const amps = Math.round(car.ampsSet ?? car.current ?? 0);
      const exp = this.expectedCarSoc(now, car);
      title = `EV charging started at ${amps} A`;
      body = `Started by ${who}. Car battery ${car.battery ?? '?'}%`
        + (exp ? `, expected ~${exp.soc}% when solar charging ends around ${exp.at}` : '')
        + ` (limit ${car.limit ?? '?'}%).`;
    } else {
      title = 'EV charging stopped';
      body = `Stopped by ${who}. Car battery ${car.battery ?? '?'}%.${added}`;
    }
    await notify({ kind: car.charging ? 'EV_STARTED' : 'EV_STOPPED', title, body, priority: 3, tags: ['red_car', car.charging ? 'electric_plug' : 'no_entry'] });
  }

  // Car SOC at the end of today's planned solar window: plan energy left x charging efficiency, capped at the car's limit.
  expectedCarSoc(now, car) {
    const b = this.advisor.last && this.advisor.last.plan && this.advisor.last.plan.best;
    if (car.battery == null || !b || b.endTs <= now) return null;
    const wh = b.watts * (b.endTs - Math.max(now, b.startTs)) / 3600;
    const soc = Math.min(car.limit || 100, car.battery + (wh * CAR_CHARGE_EFF) / (config.control.carKwh * 1000) * 100);
    return { soc: Math.round(soc), at: new Date(b.endTs * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) };
  }
}

const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v]));
