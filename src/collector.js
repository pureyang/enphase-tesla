// Chooses the active source and writes exactly one row per wall-clock second.
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import * as store from './db.js';
import { LocalSource } from './sources/local.js';
import { CloudSource } from './sources/cloud.js';
import { DemoSource } from './sources/demo.js';
import { log } from './log.js';

export class Collector extends EventEmitter {
  constructor() {
    super();
    this.local = process.env.DEMO === '1' ? new DemoSource() : new LocalSource();
    this.cloud = new CloudSource();
    this.latest = { local: null, cloud: null };
    this.active = null;
    this.current = null;
    this.written = 0;
    this.cloudStartedAt = 0;

    for (const src of [this.local, this.cloud]) {
      src.on('sample', (s) => { this.latest[src.name] = { at: Date.now(), s }; });
    }
    this.local.on('meter', (ts, r) => store.writeMeter(ts, r));
    this.local.on('battery', (ts, u) => store.writeBatteryUnit(ts, u));
    this.local.on('inverter', (r) => store.writeInverter(r));
  }

  start() {
    this.startedAt = Date.now();
    store.catchUpRollups();
    this.local.start();
    if (!this.local.enabled() || config.preferred === 'cloud') this.cloud.start();

    // Align to second boundaries (+150 ms so a just-arrived sample is included).
    const tick = () => {
      this.tick();
      setTimeout(tick, 1000 - (Date.now() % 1000) + 150);
    };
    setTimeout(tick, 1000 - (Date.now() % 1000) + 150);
    setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      store.rollup(now - 180, now);
    }, 60_000);
  }

  fresh(name, maxAgeMs) {
    const l = this.latest[name];
    return l && Date.now() - l.at <= maxAgeMs ? l : null;
  }

  chooseSource() {
    const localOk = this.fresh('local', config.fallbackAfterS * 1000);
    const preferLocal = config.preferred !== 'cloud' && this.local.enabled();

    if (preferLocal && localOk) {
      // Local healthy: release the cloud stream after 2 min of stable local data.
      if (this.cloud.running && this.fresh('local', 1500) && this.local.status.lastOk - this.cloudStartedAt > 120_000) {
        log.info('collector', 'local gateway healthy, cloud stream to standby');
        this.cloud.stop();
      }
      return 'local';
    }
    // Give the gateway time to deliver its first sample before falling back at boot.
    const booting = Date.now() - this.startedAt < config.fallbackAfterS * 1000;
    if (!this.cloud.running && this.cloud.enabled() && !(preferLocal && booting)) {
      log.warn('collector', 'local gateway stale, starting cloud live stream');
      this.cloudStartedAt = Date.now();
      this.cloud.start();
    }
    if (this.fresh('cloud', 5000)) return 'cloud';
    return localOk ? 'local' : null;
  }

  tick() {
    const name = this.chooseSource();
    if (name !== this.active) {
      log.info('collector', `active source: ${name || 'none'}`);
      this.active = name;
    }
    const ts = Math.floor(Date.now() / 1000);
    const l = name && this.fresh(name, 3000);
    if (l) {
      try {
        store.writeSample(ts, l.s);
        this.written++;
      } catch (e) {
        log.error('db', e.message);
      }
      this.current = { ts, ...l.s };
    }
    this.emit('tick', this.snapshot());
  }

  snapshot() {
    return {
      now: Date.now(),
      active: this.active,
      sample: this.current,
      sampleAgeMs: this.current ? Date.now() - this.current.ts * 1000 : null,
      sources: { local: this.local.status, cloud: { ...this.cloud.status, running: this.cloud.running } },
    };
  }
}
