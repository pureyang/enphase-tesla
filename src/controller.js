// Automatic EV control over the Tesla BLE bridge. Every EV_CONTROL_INTERVAL_S (default 60 s) it
// sets the car's amps from live power flow, in priority order:
//   1. Use all excess solar: never export while the car could take it.
//   2. Minimise grid: the car never draws on the house battery or the grid to charge.
// Below FULL_SOC it follows the advisor's plan (which leaves the house battery enough solar to reach
// target), capped at real excess. At/above FULL_SOC it tracks live excess minute by minute.
// A manual change in the Tesla app pauses control for EV_OVERRIDE_MIN.
// Smoothing: during a short dip the car holds at min amps on a small loan from the house battery
// (EV_LOAN_WH a day, repaid from solar before the car gets more), and a plan that only pushes the
// window back by <= STICKY_S doesn't stop a running session. State survives restarts (ev_state.json).
// Fewer start/stops: on cloudy days a start needs CLOUDY_START_TICKS good minutes and a planned session
// of at least MIN_SESSION_WH / MIN_SESSION_S; after we stop, no restart for REST_S unless the house is
// exporting enough for min amps REST_EXPORT_TICKS minutes running; amps follow a 3-tick average and
// only change by AMPS_STEP or more (cuts for grid import and raises into clear export apply at once).
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
const REPAY_W = 500;       // while the loan is open, this much of the excess goes to the house battery first
const STICKY_S = 3600;     // keep charging if the plan's next window starts within this
const PLAN_MAX_AGE_S = 900; // a saved plan is used after a restart until the advisor has a fresh one
const CLOUDY_RATIO = 0.8;  // solar this far below the model's expectation counts as cloudy...
const CLOUDY_COVER = 70;   // ...as does forecast cloud cover (%) for this hour
const CLOUDY_START_TICKS = 5;
const MIN_SESSION_WH = 1000, MIN_SESSION_S = 1800; // cloudy-day start needs this much planned charging left
const REST_S = 20 * 60;    // after our own stop, wait this long before starting again...
const REST_EXPORT_TICKS = 5; // ...unless exporting >= min amps + margin this many ticks in a row
const SMOOTH_TICKS = 3, AMPS_STEP = 2;

export class Controller {
  constructor(collector, tesla, advisor) {
    this.collector = collector;
    this.tesla = tesla;
    this.advisor = advisor;
    const saved = advisor.state.control || {};
    this.expect = saved.expect ?? null;       // what the car should be doing after our last command
    this.ownSession = saved.ownSession ?? false; // true if we started the current session
    this.pausedUntil = saved.pausedUntil ?? 0;
    this.loan = saved.loan ?? { day: null, wh: 0 }; // Wh the car borrowed from the house battery today
    this.wasCharging = saved.wasCharging ?? null;
    this.restUntil = saved.restUntil ?? 0;   // no restart before this (set when we stop a session)
    this.carKey = saved.carKey ?? null;      // car the session state above belongs to (two cars, one bridge)
    this.exportTicks = 0;
    this.targets = [];                        // recent target amps while charging, for smoothing
    this.lastTick = 0;
    this.startCount = 0;
    this.stopCount = 0;
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

  persist() {
    this.advisor.state.control = { expect: this.expect, ownSession: this.ownSession, pausedUntil: this.pausedUntil, loan: this.loan, wasCharging: this.wasCharging, restUntil: this.restUntil, carKey: this.carKey };
    this.advisor.save();
  }

  // The advisor's latest plan, or the one saved before a restart if it's still recent.
  plan(now) {
    if (this.advisor.last && this.advisor.last.plan) return { plan: this.advisor.last.plan, want: this.advisor.last.want };
    const lp = this.advisor.state.lastPlan;
    return lp && now - lp.at < PLAN_MAX_AGE_S ? { plan: lp.plan, want: lp.want } : { plan: null, want: null };
  }

  async tick() {
    try { await this.step(); } finally { this.persist(); }
  }

  async step() {
    const now = Math.floor(Date.now() / 1000);
    const car = this.tesla.live();
    const set = (reason, extra = {}) => { this.status = { enabled: true, active: false, at: now, reason, car: car && car.carName, ...extra }; };
    if (config.control.from && new Date().toLocaleDateString('en-CA') < config.control.from) return set(`Starts ${config.control.from}`);
    if (!car) return set('Car not reachable over Bluetooth');
    // The bridge moved to the other car: what we knew about the session belongs to the old one.
    if (this.carKey !== car.car) {
      if (this.carKey) log.info('control', `now controlling ${car.carName}`);
      this.carKey = car.car;
      this.expect = null; this.ownSession = false; this.wasCharging = null;
      this.targets = []; this.startCount = this.stopCount = 0; this.restUntil = 0;
    }
    await this.watchTransitions(now, car);
    await this.manageLimit(now, car).catch((e) => log.warn('control', `charge limit: ${e.message}`));
    if (car.pluggedIn === false || ['Complete', 'Disconnected'].includes(car.state)) {
      this.expect = null; this.ownSession = false;
      return set(car.pluggedIn === false ? 'Car not plugged in' : `Car ${car.state}`);
    }

    // Manual change in the Tesla app or car screen? Back off. (At night, amps below what we asked is the
    // car or charger capping the max, not you.)
    const amps = Math.round(car.ampsSet ?? 0);
    const night = this.nightWindow(now);
    if (this.expect && now - this.expect.ts > 120
        && (car.charging !== this.expect.charging
          || (car.charging && Math.abs(amps - this.expect.amps) >= 1 && !(night && amps < this.expect.amps)))) {
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

    // Night top-off: inside the off-peak window, charge at max amps until the car reaches its own limit.
    // House battery isn't spared (any charge left at midnight goes to the car first), and the loan isn't
    // counted, so it can't hold back the car's solar charging later in the day.
    if (night) {
      const info = { mode: 'night top-off', excessW, exportW, importW, soc: r.soc };
      const why = `Night top-off: off-peak until ${night.until}`;
      if (car.battery != null && car.limit != null && car.battery >= car.limit) {
        return set(`Night top-off: car at its ${car.limit}% limit`, round(info));
      }
      // Raise once to max; if the car/charger caps lower, don't re-send every tick.
      const sentMax = this.expect && this.expect.charging && this.expect.amps === config.ev.maxAmps;
      if (!car.charging || (amps < config.ev.maxAmps && !sentMax)) return this.command(now, car, config.ev.maxAmps, why, info);
      set(`${why}, ${amps} A to ${car.limit ?? '?'}%`, round(info));
      this.status.active = true;
      return;
    }

    // Loan: battery discharge while the car charges is borrowed; battery charging repays it. Resets daily.
    const today = new Date().toLocaleDateString('en-CA');
    if (this.loan.day !== today) this.loan = { day: today, wh: 0 };
    const dtH = this.lastTick ? Math.min(now - this.lastTick, 3 * config.control.intervalS) / 3600 : 0;
    this.lastTick = now;
    if (car.charging && r.batt > 0) this.loan.wh += r.batt * dtH;
    else if (r.batt < 0) this.loan.wh = Math.max(0, this.loan.wh + r.batt * dtH);

    // At night leave manual sessions alone; stop only what we started.
    if (r.pv < DAYLIGHT_W) {
      if (car.charging && this.ownSession) return this.command(now, car, 0, 'Solar is down', { excessW, soc: r.soc });
      return set('Night: not managing', { excessW: Math.round(excessW), soc: r.soc });
    }

    const { plan, want } = this.plan(now);
    let targetW, mode, planSaysNo = false;
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
      mode = 'plan';
      let planW = want && want.charging ? want.amps * volts : 0;
      // Sticky plan: a running session isn't stopped just because the window moved back a little.
      const b = plan && plan.best;
      if (!planW && car.charging && b && b.startTs - now <= STICKY_S) { planW = b.amps * volts; mode = 'plan (sticky)'; }
      planSaysNo = !planW;
      targetW = planW ? Math.min(planW, excessW - MARGIN_W) : 0;
    }
    // Priority 1: exporting with room on the car? Take it.
    if (exportW > MARGIN_W) targetW = Math.max(targetW, carW + exportW - MARGIN_W);
    // Repay the loan before giving the car more.
    if (this.loan.wh > 1 && !planSaysNo) targetW = Math.min(targetW, excessW - MARGIN_W - REPAY_W);
    // Priority 2: importing while charging? Back off by that much.
    if (car.charging && importW > MARGIN_W) targetW = Math.min(targetW, carW - importW);

    let next = Math.min(config.ev.maxAmps, Math.floor(targetW / volts));
    if (next < config.ev.minAmps) next = 0;
    const info = { mode, excessW, exportW, importW, soc: r.soc, targetW, loanWh: this.loan.wh };
    const cloudy = this.cloudy(now, plan);
    // Dip, not a plan change: hold at min amps while the loan has room (or solar still covers min amps).
    const minW = config.ev.minAmps * volts;
    if (car.charging && next === 0 && !planSaysNo && r.pv >= DAYLIGHT_W
        && (excessW >= minW || this.loan.wh < config.control.loanWh)) {
      next = config.ev.minAmps;
      info.mode = `${mode}, holding on ${Math.round(this.loan.wh)}/${config.control.loanWh} Wh loan`;
    }

    if (!car.charging) {
      this.targets = [];
      this.exportTicks = exportW >= minW + MARGIN_W ? this.exportTicks + 1 : 0;
      this.startCount = next > 0 ? this.startCount + 1 : 0;
      const why = `${mode}: ${(excessW / 1000).toFixed(1)} kW excess`;
      // Resting after our last stop: only real, sustained export ends the rest early.
      if (now < this.restUntil && this.exportTicks < REST_EXPORT_TICKS) {
        return set(`Resting after last stop until ${clock(this.restUntil)}`, round(info));
      }
      if (next > 0 && cloudy) {
        const left = this.plannedLeft(now, plan);
        if (mode.startsWith('plan') && (left.wh < MIN_SESSION_WH || left.s < MIN_SESSION_S)) {
          return set(`Cloudy: plan has only ${(left.wh / 1000).toFixed(1)} kWh / ${Math.round(left.s / 60)} min left, not starting`, round(info));
        }
        if (this.startCount < CLOUDY_START_TICKS) return set(`Cloudy: ${this.startCount}/${CLOUDY_START_TICKS} good minutes before starting`, round(info));
        return this.command(now, car, next, `${why} (cloudy, ${CLOUDY_START_TICKS} min steady)`, info);
      }
      if (next > 0 && this.startCount >= START_TICKS) return this.command(now, car, next, why, info);
    } else {
      this.stopCount = next === 0 ? this.stopCount + 1 : 0;
      if (next === 0 && this.stopCount >= STOP_TICKS) return this.command(now, car, 0, `${mode}: excess ${(excessW / 1000).toFixed(1)} kW is below ${config.ev.minAmps} A`, info);
      if (next > 0) {
        // Steadier amps: follow the recent average and ignore 1 A wiggles. Cutting for grid import is immediate.
        this.targets = [...this.targets, next].slice(-SMOOTH_TICKS);
        const avg = Math.floor(this.targets.reduce((a, b) => a + b, 0) / this.targets.length);
        const smooth = Math.max(config.ev.minAmps, Math.min(config.ev.maxAmps, avg));
        // Immediate: cut when importing (priority 2), raise when clearly exporting (priority 1).
        const urgent = (importW > MARGIN_W && next < amps) || (exportW > AMPS_STEP * volts + MARGIN_W && next > amps);
        const want = urgent ? next : Math.abs(smooth - amps) >= AMPS_STEP ? smooth : amps;
        if (want !== amps) return this.command(now, car, want, `${mode}: ${(excessW / 1000).toFixed(1)} kW excess${want === next ? '' : ' (3-min average)'}`, info);
      }
    }
    set(car.charging ? `Holding ${amps} A` : 'Waiting for excess solar', round(info));
    this.status.active = true;
  }

  // { until } while now is inside NIGHT_CHARGE_FROM..UNTIL (local time; wraps past midnight), else null.
  nightWindow(now) {
    const n = config.control.night;
    if (!n.enabled) return null;
    const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); };
    const d = new Date(now * 1000), t = d.getHours() * 60 + d.getMinutes();
    const a = mins(n.from), b = mins(n.until);
    const inside = a <= b ? t >= a && t < b : t >= a || t < b;
    return inside ? { until: clock(Math.floor(d.setHours(Math.floor(b / 60), b % 60, 0, 0) / 1000)) } : null;
  }

  // Cloudy = solar running well below what the model expected, or heavy forecast cloud this hour.
  cloudy(now, plan) {
    const ratio = this.advisor.last && this.advisor.last.plan && this.advisor.last.plan.nowcastRatio;
    if (ratio != null && ratio < CLOUDY_RATIO) return true;
    const w = db.prepare('SELECT cloud FROM weather_hourly WHERE ts = ?').get(Math.floor(now / 3600) * 3600);
    return Boolean(w && w.cloud >= CLOUDY_COVER);
  }

  // Energy and time left in the plan's current/next window.
  plannedLeft(now, plan) {
    const b = plan && plan.best;
    if (!b || b.endTs <= now) return { wh: 0, s: 0 };
    const s = b.endTs - Math.max(now, b.startTs);
    return { wh: (b.watts * s) / 3600, s };
  }

  // A sleeping car drops settings, so wake it and wait (up to 45 s) before sending any.
  async wakeIfAsleep(car) {
    if (!car.asleep) return;
    await this.tesla.wake();
    for (let i = 0; i < 15 && this.tesla.current().asleep; i++) await new Promise((r) => setTimeout(r, 3000));
  }

  // amps 0 = stop. Sets amps before starting so the car never starts at an old, higher setting.
  async command(now, car, amps, reason, info) {
    const was = car.charging ? Math.round(car.ampsSet ?? 0) : 0;
    const kind = amps === 0 ? 'STOP' : !car.charging ? 'START' : 'ADJUST';
    let ok = true;
    try {
      await this.wakeIfAsleep(car);
      if (amps > 0) await this.tesla.setAmps(amps);
      if (amps > 0 && !car.charging) {
        await this.tesla.setCharging(true);
        await this.tesla.setAmps(amps); // re-send once charging: the car can start at its previous setting
      }
      if (amps === 0) await this.tesla.setCharging(false);
    } catch (e) {
      ok = false;
      log.warn('control', `${kind} ${amps} A failed: ${e.message}`);
    }
    this.startCount = this.stopCount = 0;
    this.targets = amps > 0 ? [amps] : [];
    if (ok && kind === 'STOP') { this.restUntil = now + REST_S; this.exportTicks = 0; }
    if (ok) {
      this.expect = { charging: amps > 0, amps, ts: now };
      if (kind === 'START') this.ownSession = true;
      if (kind === 'STOP') this.ownSession = false;
    }
    const title = carTag(car) + (kind === 'STOP' ? 'Auto: stopped EV charging' : kind === 'START' ? `Auto: started EV at ${amps} A` : `Auto: EV ${was} A -> ${amps} A`);
    const body = `${reason}. Battery ${Math.round(info.soc)}%, grid ${info.importW > 0 ? `+${Math.round(info.importW)}` : `-${Math.round(info.exportW || 0)}`} W.`;
    log.info('control', `${title} (${reason})${ok ? '' : ' FAILED'}`);
    this.status = { enabled: true, active: true, at: now, reason: title, car: car.carName, ...round(info) };

    writeNotification({ ts: now, kind: `AUTO_${kind}`, title, body: ok ? body : `${body} Command FAILED.`, amps, sent: false, error: ok ? 'log only' : 'command failed' });
  }

  // Option 2 charge limit: when the house battery is full and the car has reached its own limit, raise the
  // limit to EV_LIMIT_RAISE_TO so spare solar goes into the car instead of the grid. Restored after sunset
  // (or the next day). A limit change by you in the meantime cancels the restore.
  async manageLimit(now, car) {
    const st = this.advisor.state;
    const today = new Date().toLocaleDateString('en-CA');
    const r = db.prepare('SELECT AVG(pv) AS pv, AVG(load) AS load, AVG(soc) AS soc, COUNT(*) AS n FROM samples WHERE ts >= ? AND src = 1')
      .get(now - config.control.intervalS);
    if (r.n < config.control.intervalS / 2 || car.limit == null) return;
    const lr = st.limitRaise;
    if (lr && lr.car && lr.car !== car.car) return; // raised on the other car: restore when it's back
    if (lr) {
      if (car.limit !== lr.to) { delete st.limitRaise; this.advisor.save(); log.info('control', `charge limit changed to ${car.limit}% outside the app; not restoring`); return; }
      if (r.pv < DAYLIGHT_W || lr.day !== today) {
        await this.wakeIfAsleep(car);
        await this.tesla.setLimit(lr.from);
        delete st.limitRaise; this.advisor.save();
        writeNotification({ ts: now, kind: 'AUTO_LIMIT', title: `${carTag(car)}Auto: car charge limit back to ${lr.from}%`, body: 'Solar is down.', amps: null, sent: false, error: 'log only' });
        log.info('control', `charge limit restored to ${lr.from}%`);
      }
      return;
    }
    const to = config.control.limitRaiseTo;
    if (!to || car.battery == null || car.limit >= to || car.pluggedIn === false || r.soc < FULL_SOC || r.pv < DAYLIGHT_W) return;
    const volts = car.voltage > 180 ? car.voltage : 240;
    const carW = car.charging ? (car.current ?? 0) * volts : 0;
    const spareW = r.pv - (r.load - carW) - MARGIN_W;
    if (car.battery < car.limit - 1 || spareW < config.ev.minAmps * volts) return;
    await this.wakeIfAsleep(car);
    await this.tesla.setLimit(to);
    st.limitRaise = { from: car.limit, to, day: today, car: car.car }; this.advisor.save();
    await notify({ kind: 'AUTO_LIMIT', title: `${carTag(car)}Raised car charge limit ${car.limit}% -> ${to}%`,
      body: `House battery is full (${Math.round(r.soc)}%) and the car reached ${car.battery}%, so ${(spareW / 1000).toFixed(1)} kW of solar would go to the grid. Back to ${car.limit}% after sunset.`,
      priority: 3, tags: ['red_car', 'sunny'] });
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
      title = `${carTag(car)}EV charging started at ${amps} A`;
      body = `Started by ${who}. Car battery ${car.battery ?? '?'}%`
        + (exp ? `, expected ~${exp.soc}% when solar charging ends around ${exp.at}` : '')
        + ` (limit ${car.limit ?? '?'}%).`;
    } else {
      title = `${carTag(car)}EV charging stopped`;
      body = `Stopped by ${who}. Car battery ${car.battery ?? '?'}%.${added}`;
    }
    await notify({ kind: car.charging ? 'EV_STARTED' : 'EV_STOPPED', title, body, priority: 3, tags: ['red_car', car.charging ? 'electric_plug' : 'no_entry'] });
  }

  // Car SOC at the end of today's planned solar window: plan energy left x charging efficiency, capped at the car's limit.
  expectedCarSoc(now, car) {
    const { plan } = this.plan(now);
    const b = plan && plan.best;
    if (car.battery == null || !b || b.endTs <= now) return null;
    const wh = b.watts * (b.endTs - Math.max(now, b.startTs)) / 3600;
    const kwh = (config.tesla.cars.find((c) => c.key === car.car) || {}).kwh || config.control.carKwh;
    const soc = Math.min(car.limit || 100, car.battery + (wh * CAR_CHARGE_EFF) / (kwh * 1000) * 100);
    return { soc: Math.round(soc), at: new Date(b.endTs * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) };
  }
}

// "Model Y: " prefix on messages when there are two cars.
const carTag = (car) => (config.tesla.cars.length > 1 && car && car.carName ? `${car.carName}: ` : '');
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v]));
