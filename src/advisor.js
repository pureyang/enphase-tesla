// EV charging advisor. Every 5 min: forecast the rest of today's solar and home load,
// simulate the house battery, and find the EV amps + window that use only true excess
// while the battery still reaches the target SOC before solar fades. Notifies at most
// once per NOTIFY_MIN_INTERVAL_MIN when the advice changes (start / stop / adjust amps).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { train, forecastSteps } from './model.js';
import { notify } from './notify.js';
import { log } from './log.js';

const stateFile = path.join(config.dataDir, 'ev_state.json');
const EFF = 0.96;          // battery charge efficiency
const AMPS_DEADBAND = 3;   // don't nag for amp changes smaller than this
const STABLE_EVALS = 2;    // advice must hold for 2 evaluations (10 min) before notifying
const FULL_SOC = 95;       // at/above this, size the car from live excess instead of the cautious forecast
const FULL_MARGIN_W = 300; // headroom so a small dip doesn't pull from the battery
// Car's measured draw vs amps x volts (2.45 kW at 12 A / 242 V on 2026-10-19).
const CAR_DRAW_FACTOR = 0.84;

const fmtT = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const kw = (w) => `${(w / 1000).toFixed(1)} kW`;
const kwh = (wh) => `${(wh / 1000).toFixed(1)} kWh`;

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}

export class Advisor {
  constructor(collector, tesla = null) {
    this.collector = collector;
    this.tesla = tesla;
    this.state = { assumed: { charging: false, amps: 0 }, lastNotifyTs: 0, pending: null, planDay: null, ...loadState() };
    this.model = null;
    this.last = null;
  }

  save() { fs.writeFileSync(stateFile, JSON.stringify(this.state, null, 2)); }

  start() {
    const run = () => this.evaluate().catch((e) => log.warn('advisor', e.stack || e.message));
    setTimeout(run, 20_000); // give history + weather a moment on boot
    setInterval(run, 5 * 60_000);
  }

  // Context shared by the plan: SOC, capacity, voltage, nowcast correction.
  context(now) {
    const live = this.collector.current && now - this.collector.current.ts < 60 ? this.collector.current : null;
    const lastIv = db.prepare('SELECT soc FROM cloud_intervals WHERE soc IS NOT NULL ORDER BY ts DESC LIMIT 1').get();
    const soc = live && live.soc != null ? live.soc : lastIv ? lastIv.soc : null;

    let capacityWh = this.model.capacityWh;
    if (live && live.energyWh && live.soc > 15) capacityWh = live.energyWh / (live.soc / 100);
    capacityWh = capacityWh || 10000;

    const v = db.prepare(`SELECT v FROM meter_readings WHERE kind = 'net-consumption' AND ts > ? ORDER BY ts DESC LIMIT 1`).get(now - 600);
    const volts = v && v.v > 180 ? v.v : 240;

    // Nowcast: how the last hour of real solar compares to what the model expected.
    const act = db.prepare('SELECT AVG(pv) AS pv, COUNT(*) AS n FROM samples WHERE ts >= ?').get(now - 3600);
    let actualPv = act.n > 1800 ? act.pv : null;
    if (actualPv == null) {
      const c = db.prepare('SELECT SUM(production) AS wh, COUNT(*) AS n FROM cloud_intervals WHERE ts >= ?').get(now - 3600 - 900);
      actualPv = c.n >= 3 ? (c.wh / c.n) * 4 : null;
    }
    const past = forecastSteps(this.model, now - 3600, now);
    const modelPv = past.length ? past.reduce((a, s) => a + s.pv, 0) / past.length : 0;
    const ratio = actualPv != null && modelPv > 300 ? Math.min(1.4, Math.max(0.3, actualPv / modelPv)) : 1;

    return { live, soc, capacityWh, volts, ratio, actualPv, modelPv };
  }

  // Battery SOC (%) over the steps with an EV drawing evW during step indexes [s, e).
  simulate(steps, ctx, evW = 0, s = 0, e = 0) {
    const cap = ctx.capacityWh;
    let E = (ctx.soc / 100) * cap;
    const socs = [];
    for (let k = 0; k < steps.length; k++) {
      const st = steps[k];
      const net = st.pvSafe - st.load - (k >= s && k < e ? evW : 0);
      if (net > 0) E = Math.min(cap, E + Math.min(net, this.model.maxChargeW) * st.dt * EFF);
      else E = Math.max(0, E + net * st.dt);
      socs.push((E / cap) * 100);
    }
    return socs;
  }

  plan(now) {
    const ctx = this.context(now);
    if (ctx.soc == null) return { ok: false, reason: 'No battery SOC yet' };
    const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
    const steps = forecastSteps(this.model, now, midnight / 1000);
    if (steps.length && !steps.some((s) => s.hasWx)) {
      return { ok: false, reason: 'No weather forecast yet. Set LOCATION (ZIP or city) in .env and restart.', ctx };
    }
    if (!steps.length || !steps.some((s) => s.ghi > 0)) return { ok: false, reason: 'No solar left today', ctx };

    for (const st of steps) {
      const start = Math.max(st.ts, now);
      st.dt = (st.ts + 900 - start) / 3600;
      const hoursAhead = (st.ts - now) / 3600;
      st.pvAdj = st.pv * (1 + (ctx.ratio - 1) * Math.exp(-Math.max(0, hoursAhead) / 2));
      st.pvSafe = st.pvAdj * config.ev.safety;
    }
    // Battery must be at target by the last step where solar still covers the home.
    let solarEnd = -1;
    steps.forEach((st, k) => { if (st.pvSafe > st.load) solarEnd = k; });
    const target = config.ev.targetSoc;
    const socAtEnd = (socs) => (solarEnd >= 0 ? socs[solarEnd] : socs[0]);

    const base = this.simulate(steps, ctx);
    const out = { ok: true, ctx, steps, solarEnd: solarEnd >= 0 ? steps[solarEnd].ts + 900 : null, baseSoc: base, best: null };
    if (solarEnd < 0) return { ...out, reason: 'Solar forecast below home load for the rest of today' };
    if (socAtEnd(base) < target) {
      return { ...out, reason: `Battery needs all excess solar: forecast ${Math.round(socAtEnd(base))}% by ${fmtT(steps[solarEnd].ts + 900)} without EV` };
    }

    // Search amps high -> low; EV window must be pure excess (no house-battery drain) at every step.
    let best = null;
    for (let A = config.ev.maxAmps; A >= config.ev.minAmps; A--) {
      const P = A * ctx.volts;
      let k = 0;
      for (let run = 0; run < 2 && k <= solarEnd; run++) {
        while (k <= solarEnd && steps[k].pvSafe - steps[k].load < P) k++;
        const s = k;
        while (k <= solarEnd && steps[k].pvSafe - steps[k].load >= P) k++;
        // Longest window [s, e) inside this run that still lets the battery reach target.
        for (let e = k; e > s; e--) {
          const socs = this.simulate(steps, ctx, P, s, e);
          if (socAtEnd(socs) < target) continue;
          const hours = steps.slice(s, e).reduce((a, st) => a + st.dt, 0);
          const wh = P * hours;
          if (hours >= 0.5 && wh >= 1000 && (!best || wh > best.wh + 1 || (Math.abs(wh - best.wh) <= 1 && hours > best.hours))) {
            best = { amps: A, watts: P, s, e, startTs: Math.max(now, steps[s].ts), endTs: steps[e - 1].ts + 900, hours, wh, socs };
          }
          break;
        }
      }
    }
    // Once the house battery is nearly full, whatever the car doesn't take is exported.
    const full = this.fullMode(now, ctx, steps, solarEnd);
    if (full && (!best || full.amps > best.amps)) best = full;
    out.best = best;
    if (!best) out.reason = 'Excess solar too small or too short for a useful EV session (min 30 min, 1 kWh)';
    return out;
  }

  // Battery-full mode: amps from the last 10 min of real excess (no 0.85 safety factor). The window
  // ends where the forecast (no safety factor) stops covering the car, and the message gives that stop time.
  fullMode(now, ctx, steps, solarEnd) {
    if (!ctx.live || ctx.soc < FULL_SOC) return null;
    const r = db.prepare('SELECT AVG(pv) AS pv, AVG(load) AS load, COUNT(*) AS n FROM samples WHERE ts >= ?').get(now - 600);
    if (r.n < 300) return null;
    const have = this.state.assumed;
    const car = this.tesla && this.tesla.live();
    const evNow = car && car.powerW != null ? (car.charging ? car.powerW : 0)
      : have.charging ? have.amps * ctx.volts * CAR_DRAW_FACTOR : 0;
    const liveExcess = r.pv - (r.load - evNow);
    // Keep enough for the battery to finish reaching target before solar ends.
    const hoursLeft = Math.max(0.25, (steps[solarEnd].ts + 900 - now) / 3600);
    const reserve = Math.max(0, ((config.ev.targetSoc - ctx.soc) / 100) * ctx.capacityWh / hoursLeft);
    const spare = (st) => st.pvAdj - st.load - reserve - FULL_MARGIN_W;
    let best = null;
    for (let A = Math.min(config.ev.maxAmps, Math.floor((liveExcess - reserve - FULL_MARGIN_W) / ctx.volts)); A >= config.ev.minAmps; A--) {
      const P = A * ctx.volts;
      let e = 0;
      while (e < steps.length && spare(steps[e]) >= P) e++;
      const hours = steps.slice(0, e).reduce((a, st) => a + st.dt, 0);
      if (hours >= 0.5 && (!best || P * hours > best.wh)) {
        best = { amps: A, watts: P, s: 0, e, startTs: now, endTs: steps[e - 1].ts + 900, hours, wh: P * hours };
      }
    }
    if (!best) return null;
    return { ...best, socs: this.simulate(steps, ctx, best.watts, 0, best.e), full: true };
  }

  async evaluate() {
    const now = Math.floor(Date.now() / 1000);
    if (!this.model || now - this.model.trainedAt > 6 * 3600) {
      this.model = train();
      log.info('advisor', `model trained: ${this.model.hoursUsed} h of history, capacity ${this.model.capacityWh ? kwh(this.model.capacityWh) : '?'}, `
        + `max charge ${kw(this.model.maxChargeW)}, backtest error ${this.model.mape == null ? '?' : Math.round(this.model.mape * 100) + '%'}`);
    }
    // Real car state from the Tesla BLE bridge replaces the assumed one when it's online.
    const car = this.tesla && this.tesla.live();
    if (car) {
      this.state.assumed = { charging: car.charging, amps: car.charging ? Math.round(car.ampsSet ?? car.current ?? 0) : 0 };
    }
    // Nothing to advise if the car is unplugged or already at its charge limit.
    const carCanCharge = !car || (car.pluggedIn !== false && !['Complete', 'Disconnected'].includes(car.state));
    const p = this.plan(now);
    const nowStep = carCanCharge && p.best && p.best.startTs <= now + 60;
    const want = nowStep ? { charging: true, amps: p.best.amps } : { charging: false, amps: 0 };
    const have = this.state.assumed;

    let kind = null;
    if (want.charging && !have.charging) kind = 'START';
    else if (!want.charging && have.charging) kind = 'STOP';
    else if (want.charging && Math.abs(want.amps - have.amps) >= AMPS_DEADBAND) kind = 'ADJUST';
    else if (!want.charging && carCanCharge && p.best && this.state.planDay !== new Date().toDateString()) kind = 'PLAN';

    // Require the same advice twice in a row so a passing cloud doesn't trigger a message.
    const key = kind && `${kind}:${want.amps}`;
    const pend = this.state.pending;
    const sameAsPending = pend && kind && pend.kind === kind && Math.abs(pend.amps - want.amps) <= 1;
    this.state.pending = kind ? { kind, amps: want.amps, count: sameAsPending ? pend.count + 1 : 1 } : null;
    const rateOk = now - this.state.lastNotifyTs >= config.ev.minIntervalMin * 60;
    const nextAllowedTs = this.state.lastNotifyTs + config.ev.minIntervalMin * 60;

    this.last = { at: now, plan: summarize(p), want, have, pending: this.state.pending, nextAllowedTs, model: modelSummary(this.model) };

    // With auto control on, the controller drives the car and sends its own start/stop pushes.
    if (kind && kind !== 'PLAN' && this.controller && this.controller.active()) { this.save(); return this.last; }
    if (kind && this.state.pending.count >= (kind === 'PLAN' ? 1 : STABLE_EVALS) && rateOk) {
      const msg = message(kind, p, want, have);
      const sent = await notify({ kind, title: msg.title, body: msg.body, amps: want.amps, priority: kind === 'PLAN' ? 2 : 4, tags: msg.tags });
      if (!sent) { this.save(); return this.last; } // stays pending; retried next evaluation
      this.state.lastNotifyTs = now;
      this.state.pending = null;
      if (kind === 'PLAN') this.state.planDay = new Date().toDateString();
      else { this.state.assumed = want; this.state.planDay = new Date().toDateString(); }
      this.last.notified = key;
    }
    this.save();
    return this.last;
  }

  // User tells us what the car is actually doing (from the dashboard), so advice stays in sync.
  setAssumed(charging, amps) {
    this.state.assumed = { charging, amps: charging ? amps : 0 };
    this.state.pending = null;
    this.save();
  }
}

function message(kind, p, want, have) {
  const c = p.ctx, b = p.best;
  const now = c.live ? `Now: solar ${kw(c.live.pv)}, home ${kw(c.live.load)}, battery ${Math.round(c.soc)}%.` : `Battery ${Math.round(c.soc)}%.`;
  const cloud = c.ratio < 0.85 ? ` Solar running ${Math.round((1 - c.ratio) * 100)}% below forecast.` : c.ratio > 1.15 ? ` Solar running ${Math.round((c.ratio - 1) * 100)}% above forecast.` : '';
  const full = b ? fullAt(b.socs, p.steps, config.ev.targetSoc) : null;
  const surplus = b && b.full ? `House battery is full (${Math.round(c.soc)}%), so extra solar would go to the grid. ` : '';
  if (kind === 'START' && b.full) return {
    title: `Start EV charging at ${b.amps} A`,
    body: `${surplus}Set the car to ${b.amps} A (~${kw(b.watts)}) and start now. Stop or turn down at about ${fmtT(b.endTs)}, when solar is forecast to drop. ${now}${cloud}`,
    tags: ['electric_plug', 'battery'],
  };
  if (kind === 'ADJUST' && b.full) return {
    title: `Set EV to ${want.amps} A (was ${have.amps} A)`,
    body: `${surplus}Change charge current to ${want.amps} A (~${kw(b.watts)}). Stop or turn down at about ${fmtT(b.endTs)}, when solar is forecast to drop. ${now}${cloud}`,
    tags: ['electric_plug', want.amps > have.amps ? 'arrow_up' : 'arrow_down'],
  };
  if (kind === 'START') return {
    title: `Start EV charging at ${b.amps} A`,
    body: `Set the car to ${b.amps} A (~${kw(b.watts)}) and start now. Run until about ${fmtT(b.endTs)}, ~${kwh(b.wh)} to the car. `
      + `House battery still forecast to reach ${config.ev.targetSoc}%${full ? ' by ' + fmtT(full) : ''}. ${now}${cloud}`,
    tags: ['electric_plug', 'sunny'],
  };
  if (kind === 'ADJUST') return {
    title: `Set EV to ${want.amps} A (was ${have.amps} A)`,
    body: `Change charge current to ${want.amps} A (~${kw(b.watts)}). Keep charging until about ${fmtT(b.endTs)}. ${now}${cloud}`,
    tags: ['electric_plug', want.amps > have.amps ? 'arrow_up' : 'arrow_down'],
  };
  if (kind === 'STOP') return {
    title: 'Stop EV charging',
    body: `Stop charging the car now. ${p.reason || (b ? `Next window starts ~${fmtT(b.startTs)} at ${b.amps} A.` : 'Remaining solar is needed for the house battery.')} ${now}${cloud}`,
    tags: ['no_entry'],
  };
  return {
    title: `EV window today ${fmtT(b.startTs)}-${fmtT(b.endTs)} at ${b.amps} A`,
    body: `Forecast: ~${kwh(b.wh)} of excess solar for the car between ${fmtT(b.startTs)} and ${fmtT(b.endTs)} at ${b.amps} A, `
      + `with the house battery still reaching ${config.ev.targetSoc}%. I'll send a start message when it's time. ${now}`,
    tags: ['calendar', 'sunny'],
  };
}

function fullAt(socs, steps, target) {
  const k = socs.findIndex((s) => s >= target);
  return k >= 0 ? steps[k].ts + 900 : null;
}

function summarize(p) {
  if (!p.ok) return { ok: false, reason: p.reason };
  const b = p.best;
  return {
    ok: true, reason: p.reason || null,
    soc: p.ctx.soc, capacityWh: Math.round(p.ctx.capacityWh), volts: Math.round(p.ctx.volts),
    nowcastRatio: Math.round(p.ctx.ratio * 100) / 100, solarEnd: p.solarEnd,
    best: b && { amps: b.amps, watts: Math.round(b.watts), startTs: b.startTs, endTs: b.endTs, wh: Math.round(b.wh), fullAt: fullAt(b.socs, p.steps, config.ev.targetSoc), batteryFullMode: Boolean(b.full) },
    steps: p.steps.map((s, k) => ({
      ts: s.ts, pv: Math.round(s.pvAdj), load: Math.round(s.load),
      socBase: Math.round(p.baseSoc[k] * 10) / 10, socEv: b ? Math.round(b.socs[k] * 10) / 10 : null,
      ev: b && k >= b.s && k < b.e ? Math.round(b.watts) : 0,
    })),
  };
}

function modelSummary(m) {
  return {
    trainedAt: m.trainedAt, hoursUsed: m.hoursUsed, capacityWh: m.capacityWh && Math.round(m.capacityWh),
    maxChargeW: Math.round(m.maxChargeW), mape: m.mape, backtestDays: m.backtestDays,
    gain: m.gain.map((g) => Math.round(g * 10) / 10), loadMedian: m.loadMedian.map(Math.round),
  };
}
