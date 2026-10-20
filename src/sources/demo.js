// Synthetic 1 Hz data for trying the dashboard without credentials (DEMO=1).
import { EventEmitter } from 'node:events';

export class DemoSource extends EventEmitter {
  constructor() {
    super();
    this.name = 'local';
    this.status = { state: 'ok (demo)', lastOk: 0, error: null };
    this.soc = 55;
  }
  enabled() { return true; }
  start() {
    setInterval(() => {
      const d = new Date();
      const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
      const sun = Math.max(0, Math.sin(((h - 6.5) / 13) * Math.PI));
      const pv = 7200 * sun * (0.85 + 0.15 * Math.random());
      const load = 600 + 400 * Math.random() + (Math.random() < 0.02 ? 3500 : 0);
      let batt = Math.max(-3800, Math.min(3800, load - pv)); // + discharge
      if (this.soc <= 20 && batt > 0) batt = 0;
      if (this.soc >= 100 && batt < 0) batt = 0;
      this.soc = Math.min(100, Math.max(0, this.soc - batt / 3600 / 100)); // 10 kWh pack
      const grid = load - pv - batt;
      this.status.lastOk = Date.now();
      this.emit('sample', {
        src: 'local', pv, batt, grid, load, gen: 0,
        va: { pv, batt: Math.abs(batt), grid: Math.abs(grid), load },
        ph: { pv: [pv / 2, pv / 2], batt: [batt / 2, batt / 2], grid: [grid / 2, grid / 2], load: [load * 0.6, load * 0.4] },
        soc: this.soc, backupSoc: 20, relay: 2, mode: 1, phaseCount: 2,
      });
      const ts = Math.floor(Date.now() / 1000);
      this.emit('meter', ts, { kind: 'net-consumption', p: grid, q: 0, s: Math.abs(grid), v: 240 + Math.random() * 3, i: grid / 240, pf: 0.98, hz: 60 + (Math.random() - 0.5) * 0.04, eDlvd: 0, eRcvd: 0 });
      if (ts % 30 === 0) {
        this.emit('battery', ts, { serial: 'DEMO-A', soc: Math.round(this.soc), temp: 24, capacityWh: 5000, status: 'demo' });
        this.emit('battery', ts, { serial: 'DEMO-B', soc: Math.round(this.soc), temp: 25, capacityWh: 5000, status: 'demo' });
      }
    }, 1000);
  }
  stop() {}
}
