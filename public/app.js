/* global uPlot */
'use strict';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const RELAY = ['Unknown', 'Open (off-grid)', 'Closed (on-grid)', 'Off-grid, grid present', 'Off-grid, ready to resync',
  'Waiting to init on-grid', 'Gen open', 'Gen closed', 'Gen startup', 'Gen sync ready', 'Gen AC stable', 'Gen AC unstable'];
const MODE = { '-1': 'Unknown', 0: 'Full Backup', 1: 'Self-Consumption', 2: 'Savings' };

function fmtW(w, signed = false) {
  if (w == null || Number.isNaN(w)) return '–';
  const a = signed ? w : Math.abs(w);
  return Math.abs(a) >= 1000 ? `${(a / 1000).toFixed(2)} kW` : `${Math.round(a)} W`;
}
function fmtWh(wh) {
  if (wh == null) return '–';
  return Math.abs(wh) >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${Math.round(wh)} Wh`;
}
const pct = (x) => (x == null || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(0)}%`);
const nowSec = () => Math.floor(Date.now() / 1000);
const getJSON = (u) => fetch(u).then((r) => r.json());

// ---------------------------------------------------------------- tabs
let activeTab = 'live';
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  activeTab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === `tab-${activeTab}`));
  onTab[activeTab] && onTab[activeTab]();
  window.dispatchEvent(new Event('resize'));
});

// ---------------------------------------------------------------- charts
const SERIES = [
  { k: 'pv', label: 'Solar', color: '--pv' },
  { k: 'load', label: 'Home', color: '--load' },
  { k: 'grid', label: 'Grid (+import)', color: '--grid' },
  { k: 'batt', label: 'Battery (+discharge)', color: '--batt' },
];

// Draws min/max envelopes for bucketed data so peaks inside an average stay visible.
function bandsPlugin(getBands) {
  return {
    hooks: {
      drawAxes: [(u) => { // runs before series, so envelopes sit under the lines
        const b = getBands(); if (!b) return;
        const { ctx } = u; const { left, top, width, height } = u.bbox;
        ctx.save(); ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
        for (const s of SERIES) {
          const mx = b[s.k + '_max'], mn = b[s.k + '_min']; if (!mx) continue;
          ctx.beginPath();
          for (let i = 0; i < b.t.length; i++) {
            const x = u.valToPos(b.t[i], 'x', true), y = u.valToPos(mx[i] ?? 0, 'y', true);
            i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
          }
          for (let i = b.t.length - 1; i >= 0; i--) ctx.lineTo(u.valToPos(b.t[i], 'x', true), u.valToPos(mn[i] ?? 0, 'y', true));
          ctx.closePath(); ctx.globalAlpha = 0.14; ctx.fillStyle = css(s.color); ctx.fill();
        }
        ctx.restore();
      }],
    },
  };
}

function autoSize(u, el) {
  new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: el.clientHeight - 40 })).observe(el);
}

function axes(yFmt) {
  const stroke = css('--muted'), grid = { stroke: css('--line'), width: 1 };
  return [
    { stroke, grid, ticks: grid },
    { stroke, grid, ticks: grid, size: 64, values: (u, v) => v.map(yFmt) },
  ];
}

// Vertical markers where the car started/stopped charging (auto control or manual), labelled at the top.
function evMarkersPlugin(getEvents) {
  return {
    hooks: {
      draw: [(u) => {
        const evs = getEvents(); if (!evs || !evs.length) return;
        // Hidden with the EV charging trace when that is switched off in the legend.
        const evSeries = u.series.find((x) => x.label === 'EV charging');
        if (evSeries && !evSeries.show) return;
        const { ctx } = u; const { left, top, width, height } = u.bbox;
        const dpr = devicePixelRatio || 1;
        ctx.save(); ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
        ctx.strokeStyle = ctx.fillStyle = css('--ev'); ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.font = `600 ${11 * dpr}px system-ui`; ctx.textBaseline = 'top';
        evs.forEach((e, i) => {
          const x = u.valToPos(e.ts, 'x', true); if (x < left || x > left + width) return;
          ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
          ctx.fillText(e.label, x + 4 * dpr, top + (4 + (i % 2) * 14) * dpr);
        });
        ctx.restore();
      }],
    },
  };
}

// Car events -> marker labels. Auto commands win; a car-side start/stop shows only if auto control didn't cause it.
function evMarkers(events) {
  const out = [];
  for (const e of events || []) {
    if (e.kind === 'AUTO_START') out.push({ ts: e.ts, label: `EV start ${e.amps} A (auto)` });
    else if (e.kind === 'AUTO_STOP') out.push({ ts: e.ts, label: 'EV stop (auto)' });
    else if (e.kind === 'AUTO_LIMIT') out.push({ ts: e.ts, label: e.title.replace(/^Auto: /, '') });
    else if (!/by auto control/.test(e.body || '')) out.push({ ts: e.ts, label: e.kind === 'EV_STARTED' ? 'EV start (manual)' : /limit/.test(e.body) ? 'EV full' : 'EV stop (manual)' });
  }
  return out;
}

// Car power on the chart's time grid: last bridge sample within 30 s (or the bucket size) of each point.
function evOnGrid(t, samples, res) {
  const out = new Array(t.length).fill(null);
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    while (j + 1 < samples.length && samples[j + 1].ts <= t[i]) j++;
    const s = samples[j];
    if (!s || s.ts > t[i] || t[i] - s.ts > Math.max(30, res)) continue;
    out[i] = s.charging ? (s.current != null && s.voltage > 180 ? s.current * s.voltage : s.power_w || 0) : 0;
  }
  return out;
}

// soc: overlay house-battery SOC on a right-hand 0-100% axis, so grid import can be read against charge level.
// ev: add the car's charging power as its own trace, with start/stop markers from events().
// compare: add faded dashed Solar / Home / Grid traces for a comparison period (shifted onto this axis).
function powerChart(el, { sync, onZoom, bands, soc, ev, events, compare } = {}) {
  const ax = axes((v) => fmtW(v, true));
  if (soc) ax.push({ scale: '%', side: 1, stroke: css('--soc'), grid: { show: false }, size: 52, values: (u, v) => v.map((x) => `${x}%`) });
  const opts = {
    width: el.clientWidth, height: el.clientHeight - 40,
    cursor: { sync: sync ? { key: sync } : undefined, drag: { x: Boolean(onZoom), y: false } },
    scales: { x: { time: true }, ...(soc ? { '%': { range: [0, 100] } } : {}) },
    series: [{}, ...SERIES.map((s) => ({
      label: s.label, stroke: css(s.color), width: 1.5, value: (u, v) => fmtW(v, true), points: { show: false },
    })), ...(ev ? [{ label: 'EV charging', stroke: css('--ev'), fill: css('--ev') + '40', width: 2.5, paths: uPlot.paths.stepped({ align: 1 }), value: (u, v) => (v == null ? '–' : fmtW(v, true)), points: { show: false } }] : []), ...(soc ? [{ label: 'Battery SOC', scale: '%', stroke: css('--soc'), width: 2, dash: [6, 4], value: (u, v) => (v == null ? '–' : `${v.toFixed(0)}%`), points: { show: false } }] : []),
    ...(compare ? SERIES.slice(0, 3).map((s) => ({
      label: `${s.label.replace(/ \(.*/, '')} (compare)`, stroke: css(s.color) + '99', width: 1.5, dash: [3, 3], show: false,
      value: (u, v) => (v == null ? '–' : fmtW(v, true)), points: { show: false },
    })) : [])],
    axes: ax,
    plugins: [...(bands ? [bandsPlugin(bands)] : []), ...(events ? [evMarkersPlugin(events)] : [])],
    hooks: onZoom ? { setSelect: [(u) => {
      if (u.select.width < 5) return;
      const a = u.posToVal(u.select.left, 'x'), b = u.posToVal(u.select.left + u.select.width, 'x');
      u.setSelect({ width: 0, height: 0 }, false);
      onZoom(Math.floor(a), Math.ceil(b));
    }] } : {},
  };
  const u = new uPlot(opts, opts.series.map(() => []), el);
  autoSize(u, el);
  return u;
}

function socChart(el, { sync, extra } = {}) {
  const series = [{}, { label: 'SOC', stroke: css('--soc'), width: 2, value: (u, v) => (v == null ? '–' : `${v.toFixed(1)}%`), points: { show: false } }];
  const ax = axes((v) => `${v}%`);
  if (extra) {
    series.push(extra);
    if (extra.scale !== 'y') ax.push({ scale: extra.scale, side: 1, stroke: css('--muted'), grid: { show: false }, size: 64, values: (u, v) => v.map((x) => fmtW(x, true)) });
  }
  const u = new uPlot({
    width: el.clientWidth, height: el.clientHeight - 40,
    cursor: { sync: sync ? { key: sync } : undefined, drag: { x: false, y: false } },
    scales: { x: { time: true }, y: { range: [0, 100] } },
    series, axes: ax,
  }, series.map(() => []), el);
  autoSize(u, el);
  return u;
}

// ---------------------------------------------------------------- live strip + stream
let last = null;
const liveBuf = { t: [], pv: [], load: [], grid: [], batt: [], soc: [] };
const LIVE_WINDOW = 900;
let liveChart, liveSoc;

function setText(id, t) { const el = $(id); if (el.textContent !== t) el.textContent = t; }

function renderStrip(snap) {
  const s = snap.sample;
  const badge = $('srcBadge');
  badge.className = `badge ${snap.active || 'none'}`;
  badge.textContent = snap.active === 'local' ? 'LOCAL · 1 s' : snap.active === 'cloud' ? 'CLOUD · 1 s' : 'NO DATA';
  const stale = !s || snap.sampleAgeMs > 5000;
  $('livestrip').classList.toggle('stale', stale);
  setText('age', s ? `${new Date(s.ts * 1000).toLocaleTimeString()}${stale ? ' · stale' : ''}` : '');
  if (!s) return;
  setText('v-pv', fmtW(s.pv));
  setText('s-pv', s.ph && s.ph.pv && s.ph.pv.length > 1 ? s.ph.pv.map((x) => fmtW(x)).join(' · ') : ' ');
  setText('v-load', fmtW(s.load));
  setText('s-load', s.ph && s.ph.load && s.ph.load.length > 1 ? s.ph.load.map((x) => fmtW(x)).join(' · ') : ' ');
  setText('v-grid', fmtW(s.grid));
  setText('s-grid', s.grid > 15 ? 'Importing' : s.grid < -15 ? 'Exporting' : 'Idle');
  setText('v-batt', fmtW(s.batt));
  setText('s-batt', s.batt > 15 ? 'Discharging' : s.batt < -15 ? 'Charging' : 'Idle');
  setText('v-soc', s.soc == null ? '–' : `${Math.round(s.soc)}%`);
  $('socfill').style.width = `${s.soc || 0}%`;
  $('backupmark').style.left = `${s.backupSoc || 0}%`;
  const eta = batteryEta(s);
  setText('s-soc', `${MODE[s.mode] || ''}${eta ? ' · ' + eta : ''}`);
}

let capacityWh = null; // filled from battery units if the gateway reports it
function batteryEta(s) {
  if (!capacityWh || s.soc == null || Math.abs(s.batt) < 50) return '';
  const hours = s.batt > 0
    ? (capacityWh * (s.soc - (s.backupSoc || 0)) / 100) / s.batt
    : (capacityWh * (100 - s.soc) / 100) / -s.batt;
  if (!Number.isFinite(hours) || hours < 0) return '';
  const h = Math.floor(hours), m = Math.round((hours - h) * 60);
  return `${s.batt > 0 ? 'to reserve' : 'to full'} ${h}h ${m}m`;
}

function pushLive(s) {
  if (!s || (liveBuf.t.length && liveBuf.t[liveBuf.t.length - 1] >= s.ts)) return;
  liveBuf.t.push(s.ts);
  for (const k of ['pv', 'load', 'grid', 'batt', 'soc']) liveBuf[k].push(s[k]);
  while (liveBuf.t.length && liveBuf.t[0] < s.ts - LIVE_WINDOW) for (const k in liveBuf) liveBuf[k].shift();
  if (activeTab === 'live' && liveChart) {
    liveChart.setData([liveBuf.t, liveBuf.pv, liveBuf.load, liveBuf.grid, liveBuf.batt]);
    liveSoc.setData([liveBuf.t, liveBuf.soc]);
  }
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    const snap = JSON.parse(ev.data);
    last = snap;
    renderStrip(snap);
    if (snap.sample) { renderFlow(snap.sample); pushLive(snap.sample); }
  };
  es.onerror = () => {
    const b = $('srcBadge'); b.className = 'badge none'; b.textContent = 'DASHBOARD OFFLINE';
  };
}

// ---------------------------------------------------------------- flow diagram
const NODES = {
  pv: { x: 210, y: 50, label: 'Solar', c: '--pv' },
  grid: { x: 60, y: 165, label: 'Grid', c: '--grid' },
  home: { x: 360, y: 165, label: 'Home', c: '--load' },
  batt: { x: 210, y: 280, label: 'Battery', c: '--batt' },
};
const HUB = { x: 210, y: 165 };
function buildFlow() {
  const svg = $('flow');
  let h = '';
  for (const [k, n] of Object.entries(NODES)) {
    h += `<path class="wire" d="M${n.x} ${n.y} L${HUB.x} ${HUB.y}"/>`;
    h += `<path class="flowing" id="w-${k}" d="" style="stroke:var(${n.c})"/>`;
  }
  h += `<circle cx="${HUB.x}" cy="${HUB.y}" r="6" fill="var(--muted)"/>`;
  for (const [k, n] of Object.entries(NODES)) {
    h += `<circle class="node" cx="${n.x}" cy="${n.y}" r="34" style="stroke:var(${n.c})"/>`;
    h += `<text x="${n.x}" y="${n.y - 2}" id="f-${k}">–</text><text class="lbl" x="${n.x}" y="${n.y + 14}" id="fl-${k}">${n.label}</text>`;
  }
  svg.innerHTML = h;
}
// Direction: positive "into hub" for sources. pv in; grid + import in; batt + discharge in; home always out.
function renderFlow(s) {
  const flows = { pv: s.pv, grid: s.grid, batt: s.batt, home: -s.load };
  for (const [k, v] of Object.entries(flows)) {
    const n = NODES[k], path = $(`w-${k}`);
    if (v == null || Math.abs(v) < 15) { path.setAttribute('d', ''); continue; }
    path.setAttribute('d', v > 0 ? `M${n.x} ${n.y} L${HUB.x} ${HUB.y}` : `M${HUB.x} ${HUB.y} L${n.x} ${n.y}`);
    path.style.setProperty('--spd', `${Math.max(0.25, 2.2 - Math.log10(Math.abs(v)) * 0.5).toFixed(2)}s`);
  }
  setText('f-pv', fmtW(s.pv)); setText('f-home', fmtW(s.load));
  setText('f-grid', fmtW(s.grid)); setText('fl-grid', s.grid > 15 ? 'Importing' : s.grid < -15 ? 'Exporting' : 'Grid');
  setText('f-batt', fmtW(s.batt));
  setText('fl-batt', `${s.soc == null ? '' : Math.round(s.soc) + '% · '}${s.batt > 15 ? 'out' : s.batt < -15 ? 'in' : 'idle'}`);
  setText('flowNote', `· ${RELAY[s.relay] || ''}`);
}

// ---------------------------------------------------------------- KPIs
function kpis(el, e) {
  const self = e.consumed ? 1 - (e.imported || 0) / e.consumed : null;
  const selfUse = e.produced ? 1 - (e.exported || 0) / e.produced : null;
  const items = [
    ['Produced', fmtWh(e.produced)], ['Consumed', fmtWh(e.consumed)],
    ['Imported', fmtWh(e.imported)], ['Exported', fmtWh(e.exported)],
    ['Battery charged', fmtWh(e.charged)], ['Battery discharged', fmtWh(e.discharged)],
    ['Self-sufficiency', pct(self)], ['Solar self-use', pct(selfUse)],
    ['SOC range', e.soc_min == null ? '–' : `${Math.round(e.soc_min)}–${Math.round(e.soc_max)}%`],
    ['1 s data coverage', pct(e.coverage)],
  ];
  el.innerHTML = items.map(([l, v]) => `<div class="kpi"><label>${l}</label><b>${v}</b></div>`).join('');
}
function midnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d / 1000); }
async function refreshToday() {
  kpis($('todayKpis'), await getJSON(`/api/energy?from=${midnight()}&to=${nowSec()}`));
}

// ---------------------------------------------------------------- history
// A period (preset, stepped with ◀ ▶) holds a view (what the main chart shows, zoomed/panned inside it).
// An optional comparison period is drawn shifted onto the same axis, and its totals sit next to the view's.
const DAY = 86400;
const dayStart = (t) => { const d = new Date(t * 1000); d.setHours(0, 0, 0, 0); return Math.floor(d / 1000); };
const addDays = (t, n) => { const d = new Date(t * 1000); d.setDate(d.getDate() + n); return Math.floor(d / 1000); };
const addMonths = (t, n) => { const d = new Date(t * 1000); d.setMonth(d.getMonth() + n); return Math.floor(d / 1000); };

function makePeriod(p) {
  const n = nowSec(), d0 = dayStart(n);
  if (p === 'today') return { p, unit: 'day', a: d0, b: addDays(d0, 1) };
  if (p === 'yesterday') return { p, unit: 'day', a: addDays(d0, -1), b: d0 };
  if (p === 'week') { const a = addDays(d0, -((new Date(d0 * 1000).getDay() + 6) % 7)); return { p, unit: 'week', a, b: addDays(a, 7) }; }
  if (p === 'month') { const d = new Date(n * 1000); const a = Math.floor(new Date(d.getFullYear(), d.getMonth(), 1) / 1000); return { p, unit: 'month', a, b: addMonths(a, 1) }; }
  if (p === 'year') { const a = Math.floor(new Date(new Date(n * 1000).getFullYear(), 0, 1) / 1000); return { p, unit: 'year', a, b: addMonths(a, 12) }; }
  const len = { '6h': 6 * 3600, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '12m': 365 * DAY }[p];
  return { p, unit: 'roll', len, a: n - len, b: n };
}
function shiftPeriod(P, k) {
  if (P.unit === 'day') return { ...P, a: addDays(P.a, k), b: addDays(P.b, k) };
  if (P.unit === 'week') return { ...P, a: addDays(P.a, 7 * k), b: addDays(P.b, 7 * k) };
  if (P.unit === 'month') return { ...P, a: addMonths(P.a, k), b: addMonths(P.b, k) };
  if (P.unit === 'year') return { ...P, a: addMonths(P.a, 12 * k), b: addMonths(P.b, 12 * k) };
  return { ...P, a: P.a + k * P.len, b: P.b + k * P.len };
}
const fmtDay = (t, opts = {}) => new Date(t * 1000).toLocaleDateString([], { month: 'short', day: 'numeric', ...opts });
function periodLabel(P) {
  const n = nowSec();
  if (P.unit === 'day') return P.a === dayStart(n) ? 'Today' : P.a === addDays(dayStart(n), -1) ? 'Yesterday' : fmtDay(P.a, { weekday: 'short' });
  if (P.unit === 'week') return `Week of ${fmtDay(P.a)}`;
  if (P.unit === 'month') return new Date(P.a * 1000).toLocaleDateString([], { month: 'long', year: 'numeric' });
  if (P.unit === 'year') return String(new Date(P.a * 1000).getFullYear());
  if (P.p === '12m' && n - P.b < 120) return 'Last 12 months';
  if (P.p !== 'custom' && n - P.b < 120) return `Last ${P.p.replace('h', ' h').replace('d', ' days')}`;
  return `${fmtDay(P.a)}, ${new Date(P.a * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – ${fmtDay(P.b)}, ${new Date(P.b * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
const periodEnd = (P) => Math.min(P.b, nowSec());

const hist = { P: makePeriod('today'), from: 0, to: 0, stack: [], data: null, chart: null, soc: null, nav: null, navKey: '', cmp: '' };
hist.from = hist.P.a; hist.to = periodEnd(hist.P);
const toLocalInput = (s) => { const d = new Date(s * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => Math.floor(new Date(v) / 1000);

// Seconds to subtract from the view to get the comparison window (null = compare off).
function compareOffset() {
  if (hist.cmp === 'prev') return hist.P.a - shiftPeriod(hist.P, -1).a;
  if (hist.cmp === 'week') return hist.from - addDays(hist.from, -7);
  if (hist.cmp === 'date' && $('cmpDate').value) {
    const [y, m, d] = $('cmpDate').value.split('-').map(Number);
    return dayStart(hist.P.a) - Math.floor(new Date(y, m - 1, d) / 1000);
  }
  return null;
}
const cmpLabel = (off) => (hist.cmp === 'prev' ? 'previous period' : hist.cmp === 'week' ? 'same time last week' : fmtDay(hist.P.a - off, { weekday: 'short' }));

// Overview strip: the whole period at coarse resolution; the current view is highlighted, drag to pick a new one.
function navChart(el) {
  const u = new uPlot({
    width: el.clientWidth, height: el.clientHeight,
    legend: { show: false }, cursor: { drag: { x: true, y: false }, points: { show: false } },
    scales: { x: { time: true } },
    axes: [{ stroke: css('--muted'), grid: { show: false }, size: 28 }, { show: false }],
    series: [{}, ...SERIES.slice(0, 3).map((s) => ({ stroke: css(s.color), width: 1, points: { show: false } }))],
    hooks: {
      draw: [(u) => {
        const { ctx } = u; const { top, height } = u.bbox;
        const x0 = u.valToPos(hist.from, 'x', true), x1 = u.valToPos(hist.to, 'x', true);
        ctx.save(); ctx.fillStyle = css('--load') + '22'; ctx.strokeStyle = css('--load'); ctx.lineWidth = devicePixelRatio || 1;
        ctx.fillRect(x0, top, Math.max(2, x1 - x0), height); ctx.strokeRect(x0, top, Math.max(2, x1 - x0), height); ctx.restore();
      }],
      setSelect: [(u) => {
        if (u.select.width < 3) return;
        const a = Math.floor(u.posToVal(u.select.left, 'x')), b = Math.ceil(u.posToVal(u.select.left + u.select.width, 'x'));
        u.setSelect({ width: 0, height: 0 }, false);
        setView(a, b);
      }],
    },
  }, [[], [], [], []], el);
  new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: el.clientHeight })).observe(el);
  return u;
}

function setView(a, b, push = true) {
  const lo = hist.P.a, hi = periodEnd(hist.P);
  const w = Math.min(b - a, hi - lo);
  a = Math.max(lo, Math.min(a, hi - w));
  if (push) hist.stack.push([hist.from, hist.to]);
  hist.from = a; hist.to = a + w;
  loadHistory();
}
function setPeriod(P) {
  hist.P = P; hist.stack = [];
  hist.from = P.a; hist.to = periodEnd(P);
  loadHistory();
}
function pan(dir) {
  const w = hist.to - hist.from;
  if (w >= periodEnd(hist.P) - hist.P.a - 1) return stepPeriod(dir); // not zoomed: step the whole period
  setView(hist.from + dir * Math.round(w / 2), hist.to + dir * Math.round(w / 2), false);
}
function stepPeriod(dir) {
  const P = shiftPeriod(hist.P, dir);
  if (P.a >= nowSec()) return;
  setPeriod(P);
}

function histKpis(e, leak, c, cLeak, off) {
  const self = (x) => (x.consumed ? 1 - (x.imported || 0) / x.consumed : null);
  const selfUse = (x) => (x.produced ? 1 - (x.exported || 0) / x.produced : null);
  const items = [
    ['Produced', 'produced', fmtWh], ['Consumed', 'consumed', fmtWh], ['Imported', 'imported', fmtWh], ['Exported', 'exported', fmtWh],
    ['Battery charged', 'charged', fmtWh], ['Battery discharged', 'discharged', fmtWh],
    ['Import leakage', (x, l) => l, fmtWh], ['Self-sufficiency', self, pct], ['Solar self-use', selfUse, pct],
  ];
  const val = (x, l, k) => (typeof k === 'function' ? k(x, l) : x[k]);
  $('rangeKpis').innerHTML = items.map(([label, k, f]) => {
    const v = val(e, leak, k);
    let sub = '';
    if (c) {
      const w = val(c, cLeak, k);
      const delta = v != null && w ? (f === pct ? `${Math.round((v - w) * 100) >= 0 ? '+' : ''}${Math.round((v - w) * 100)} pts` : `${v >= w ? '+' : ''}${Math.round(((v - w) / w) * 100)}%`) : '';
      sub = `<small class="muted">vs ${f(w)}${delta ? ` · ${delta}` : ''}</small>`;
    }
    return `<div class="kpi"><label>${label}</label><b>${f(v)}</b>${sub}</div>`;
  }).join('') + `<div class="kpi"><label>1 s data coverage</label><b>${pct(e.coverage)}</b>${c ? `<small class="muted">vs ${pct(c.coverage)}</small>` : ''}${e.filled ? `<small class="muted">15-min history for ${pct(e.filled)} of the time; imports there are a lower bound</small>` : ''}</div>`;
  $('cmpNote').textContent = c ? `· vs ${cmpLabel(off)}` : '';
}
const sumLeak = (rows) => rows.reduce((s, r) => s + (r.imp_wh || 0), 0);

async function loadHistory() {
  if (!hist.chart) {
    hist.chart = powerChart($('histChart'), {
      sync: 'hist', soc: true, ev: true, compare: true, events: () => hist.evEvents, bands: () => (hist.data && hist.data.res > 1 && hist.data.res < 86400 ? hist.data : null),
      onZoom: (a, b) => setView(a, b),
    });
    hist.soc = socChart($('histSoc'), { sync: 'hist' });
    hist.nav = navChart($('histNav'));
  }
  const P = hist.P, pEnd = periodEnd(P);
  $('periodLabel').textContent = periodLabel(P);
  $('nextP').disabled = P.b >= nowSec();
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x.dataset.p === P.p && P.a === makePeriod(P.p).a));
  $('from').value = toLocalInput(hist.from); $('to').value = toLocalInput(hist.to);
  $('csv').href = `/api/export.csv?from=${hist.from}&to=${hist.to}`;
  const zoomed = hist.to - hist.from < pEnd - P.a - 1;
  $('fullP').disabled = !zoomed;

  const off = compareOffset();
  const [d, e, car, leak] = await Promise.all([
    getJSON(`/api/series?from=${hist.from}&to=${hist.to}`),
    getJSON(`/api/energy?from=${hist.from}&to=${hist.to}`),
    getJSON(`/api/tesla?from=${hist.from}&to=${hist.to}`).catch(() => ({ series: [], events: [] })),
    getJSON(`/api/leakage?from=${hist.from}&to=${hist.to}&res=86400`).catch(() => []),
  ]);
  let c = null, cLeak = null, cs = null;
  if (off != null) {
    const cf = hist.from - off, ct = hist.to - off;
    [cs, c, cLeak] = await Promise.all([
      getJSON(`/api/series?from=${cf}&to=${ct}&res=${d.res}`),
      getJSON(`/api/energy?from=${cf}&to=${ct}`),
      getJSON(`/api/leakage?from=${cf}&to=${ct}&res=86400`).then(sumLeak).catch(() => null),
    ]);
  }
  // Comparison values on this view's time grid (same resolution, so buckets line up after the shift).
  const onGrid = (k) => {
    if (!cs) return d.t.map(() => null);
    const m = new Map(cs.t.map((t, i) => [t + off, cs[k][i]]));
    return d.t.map((t) => m.get(t) ?? null);
  };
  hist.evEvents = evMarkers(car.events);
  hist.data = d;
  const fromHist = d.cloud ? d.cloud.filter(Boolean).length : 0;
  $('resNote').textContent = (d.res === 1 ? `${d.t.length.toLocaleString()} points · 1 s` : `${d.t.length.toLocaleString()} buckets · ${d.res >= 86400 ? 'daily' : d.res >= 3600 ? d.res / 3600 + ' h' : d.res / 60 + ' min'} avg${d.res < 86400 ? ' (min/max shaded)' : ''}`)
    + (fromHist ? ` · ${Math.round((fromHist / d.t.length) * 100)}% from 15-min history (no 1 s data there)` : '');
  hist.chart.setData([d.t, d.pv, d.load, d.grid, d.batt, evOnGrid(d.t, car.series || [], d.res), d.soc, onGrid('pv'), onGrid('load'), onGrid('grid')]);
  for (const i of [7, 8, 9]) hist.chart.setSeries(i, { show: off != null });
  hist.chart.setScale('x', { min: hist.from, max: hist.to });
  hist.soc.setData([d.t, d.soc]);
  hist.soc.setScale('x', { min: hist.from, max: hist.to });
  histKpis(e, sumLeak(leak), c, cLeak, off);

  // Overview: reload only when the period changes; always redraw the view box.
  const key = `${P.a}-${pEnd}`;
  if (hist.navKey !== key) {
    hist.navKey = key;
    const o = await getJSON(`/api/series?from=${P.a}&to=${pEnd}&res=${pEnd - P.a <= 2 * DAY ? 60 : pEnd - P.a <= 45 * DAY ? 900 : pEnd - P.a <= 120 * DAY ? 3600 : 86400}`);
    hist.nav.setData([o.t, o.pv, o.load, o.grid]);
    hist.nav.setScale('x', { min: P.a, max: pEnd });
  } else hist.nav.redraw();
}
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  setPeriod(makePeriod(b.dataset.p));
});
$('prevP').onclick = () => stepPeriod(-1);
$('nextP').onclick = () => stepPeriod(1);
$('panL').onclick = () => pan(-1);
$('panR').onclick = () => pan(1);
$('fullP').onclick = () => setView(hist.P.a, periodEnd(hist.P));
$('cmp').onchange = () => { hist.cmp = $('cmp').value; $('cmpDate').hidden = hist.cmp !== 'date'; if (hist.cmp !== 'date' || $('cmpDate').value) loadHistory(); };
$('cmpDate').onchange = () => loadHistory();
document.addEventListener('keydown', (e) => {
  if (activeTab !== 'history' || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); pan(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); pan(1); }
});
$('apply').onclick = () => {
  const a = fromLocalInput($('from').value), b = fromLocalInput($('to').value);
  if (!(b > a)) return;
  hist.P = { p: 'custom', unit: 'roll', len: b - a, a, b }; hist.stack = [];
  hist.from = a; hist.to = Math.min(b, nowSec());
  loadHistory();
};
$('back').onclick = () => { const p = hist.stack.pop(); if (p) { [hist.from, hist.to] = p; loadHistory(); } };

// ---------------------------------------------------------------- battery
let battChart;
async function loadBattery() {
  const to = nowSec(), from = to - 86400;
  const [b, d, e] = await Promise.all([
    getJSON(`/api/battery?from=${from}&to=${to}`),
    getJSON(`/api/series?from=${from}&to=${to}&res=60`),
    getJSON(`/api/energy?from=${from}&to=${to}`),
  ]);
  const caps = b.latest.map((u) => u.capacity_wh).filter(Boolean);
  if (caps.length) capacityWh = caps.reduce((a, c) => a + c, 0);
  $('units').innerHTML = b.latest.length ? b.latest.map((u) => `<div class="unit"><b>${u.soc ?? '–'}%</b>
    <div class="muted">SN ${u.serial}</div><div>${u.temp != null ? u.temp + ' °C' : ''} ${u.capacity_wh ? '· ' + fmtWh(u.capacity_wh) : ''}</div>
    <div class="muted">${new Date(u.ts * 1000).toLocaleTimeString()}</div></div>`).join('')
    : '<span class="muted">Per-unit data needs the local gateway connection.</span>';

  if (!battChart) {
    battChart = socChart($('battChart'), {
      extra: { label: 'Battery W', stroke: css('--batt'), width: 1, scale: 'w', value: (u, v) => fmtW(v, true), points: { show: false } },
    });
  }
  battChart.setData([d.t, d.soc, d.batt]);

  const cycles = capacityWh ? (e.discharged || 0) / capacityWh : null;
  const eff = e.charged ? (e.discharged || 0) / e.charged : null;
  // SOC rate of change over the last 15 minutes
  const r = d.t.length > 15 ? (d.soc[d.soc.length - 1] - d.soc[d.soc.length - 16]) * 4 : null;
  $('battKpis').innerHTML = [
    ['Charged', fmtWh(e.charged)], ['Discharged', fmtWh(e.discharged)],
    ['Discharged ÷ charged', pct(eff)], ['Equivalent cycles', cycles == null ? '–' : cycles.toFixed(2)],
    ['SOC range', e.soc_min == null ? '–' : `${Math.round(e.soc_min)}–${Math.round(e.soc_max)}%`],
    ['SOC trend (15 min)', r == null || !Number.isFinite(r) ? '–' : `${r > 0 ? '+' : ''}${r.toFixed(1)} %/h`],
    ['Total capacity', capacityWh ? fmtWh(capacityWh) : '–'],
  ].map(([l, v]) => `<div class="kpi"><label>${l}</label><b>${v}</b></div>`).join('');
}

// ---------------------------------------------------------------- grid quality
let voltChart, hzChart;
async function loadGridTab() {
  const to = nowSec(), from = to - 21600;
  const rows = await getJSON(`/api/meters?from=${from}&to=${to}`);
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const t = [...new Set(rows.map((r) => r.b))].sort((a, b) => a - b);
  const idx = new Map(t.map((x, i) => [x, i]));
  const col = (kind, f) => { const a = new Array(t.length).fill(null); rows.filter((r) => r.kind === kind).forEach((r) => (a[idx.get(r.b)] = r[f])); return a; };
  const palette = ['--load', '--pv', '--batt', '--grid'];
  const mk = (el, f, unit, digits) => {
    const series = [{}, ...kinds.map((k, i) => ({ label: k, stroke: css(palette[i % 4]), width: 1.2, value: (u, v) => (v == null ? '–' : `${v.toFixed(digits)} ${unit}`), points: { show: false } }))];
    el.innerHTML = '';
    const u = new uPlot({ width: el.clientWidth, height: el.clientHeight - 40, scales: { x: { time: true } }, series, axes: axes((v) => `${v} ${unit}`) },
      [t, ...kinds.map((k) => col(k, f))], el);
    autoSize(u, el);
    return u;
  };
  if (!rows.length) {
    $('voltChart').innerHTML = $('hzChart').innerHTML = '<p class="muted">No meter readings yet — requires the local gateway.</p>';
  } else {
    voltChart = mk($('voltChart'), 'v', 'V', 1);
    hzChart = mk($('hzChart'), 'hz', 'Hz', 3);
  }
  const s = last && last.sample;
  $('relayInfo').innerHTML = s ? `<dt>Relay</dt><dd>${RELAY[s.relay]}</dd><dt>Battery mode</dt><dd>${MODE[s.mode]}</dd>
    <dt>Backup reserve</dt><dd>${s.backupSoc ?? '–'}%</dd><dt>Phases</dt><dd>${s.phaseCount || '–'}</dd>` : '';
}

// ---------------------------------------------------------------- array
// Microinverters stop reporting at dusk and the gateway keeps serving each one's last value,
// so a report older than this is shown as asleep (0 W) instead of as current output.
const INV_STALE_S = 20 * 60;
const ymdLocal = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const unitName = (s) => `…${String(s).slice(-6)}`;

async function loadArray() {
  const inv = await getJSON('/api/inverters');
  const n = nowSec();
  const awake = inv.filter((r) => n - r.ts <= INV_STALE_S);
  const total = awake.reduce((a, r) => a + (r.watts || 0), 0);
  $('invNote').textContent = inv.length
    ? `· ${inv.length} units · ${fmtW(total)} · ${awake.length ? `${awake.length} reporting` : 'all asleep (no sun)'} · each unit reports every ~15 min`
    : '';
  $('inv').innerHTML = inv.length ? inv.map((r) => {
    const asleep = n - r.ts > INV_STALE_S;
    const f = !asleep && r.max_watts ? Math.min(1, r.watts / r.max_watts) : 0;
    const tip = `${r.serial}\nlast report ${r.watts} W at ${new Date(r.ts * 1000).toLocaleString()}\nmax ${r.max_watts} W`;
    return `<div class="${asleep ? 'asleep' : ''}" style="background:hsl(${40 + f * 10} ${30 + f * 70}% ${85 - f * 35}%)" title="${tip}">
      <b>${asleep ? 'asleep' : `${r.watts} W`}</b><br>${String(r.serial).slice(-6)}</div>`;
  }).join('') : '<span class="muted">Requires the local gateway connection.</span>';
  if (!$('arrA').value) {
    $('arrA').value = ymdLocal(n);
    $('arrB').value = ymdLocal(addDays(dayStart(n), -1));
  }
  loadArrayCompare();
}

// ---- day comparison: per-panel 15-min output, as watts or as % of the array's average panel
const arr = { mode: 'pct', sel: null, chart: null, data: null };

function arrayDayView(d) {
  const slots = 96, w = {};
  for (const s of d.serials) {
    w[s] = Array(slots).fill(null);
    d.t.forEach((t, i) => { const k = Math.round((t - d.from) / d.bucket); if (k >= 0 && k < slots && d.wh[s][i] != null) w[s][k] = d.wh[s][i] * (3600 / d.bucket); });
  }
  // Array average per slot over panels that reported; % only when the average is meaningful (>= 20 W).
  const avg = Array.from({ length: slots }, (_, k) => {
    const v = d.serials.map((s) => w[s][k]).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
  const pct = Object.fromEntries(d.serials.map((s) => [s, w[s].map((x, k) => (x != null && avg[k] >= 20 ? (x / avg[k]) * 100 : null))]));
  const daily = Object.fromEntries(d.serials.map((s) => [s, w[s].reduce((a, x) => a + (x || 0), 0) * (d.bucket / 3600)]));
  const vals = Object.values(daily).filter((x) => x > 0);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const slotsWithData = avg.filter((x) => x != null).length;
  return { w, pct, daily, mean, total: vals.reduce((a, b) => a + b, 0), slotsWithData };
}

function drawArrayChart() {
  const { A, B, serials, a0 } = arr.data;
  const el = $('arrChart');
  if (arr.chart) arr.chart.destroy();
  const pctMode = arr.mode === 'pct';
  const pick = (v, s) => (v ? (pctMode ? v.pct[s] : v.w[s]) : null) || Array(96).fill(null);
  const t = Array.from({ length: 96 }, (_, k) => a0 + k * 900);
  const series = [{}], data = [t];
  serials.forEach((s, i) => {
    const on = arr.sel == null || arr.sel === s;
    series.push({ label: `${unitName(s)} · A`, stroke: arr.sel === s ? css('--pv') : `hsla(${(i * 47) % 360} 60% 50% / ${on ? 0.85 : 0.18})`, width: arr.sel === s ? 3 : 1.2, points: { show: false },
      value: (u, v) => (v == null ? '–' : pctMode ? `${v.toFixed(0)}%` : fmtW(v)) });
    data.push(pick(A, s));
  });
  if (arr.sel != null) {
    series.push({ label: `${unitName(arr.sel)} · B`, stroke: css('--load'), width: 2.5, dash: [6, 4], points: { show: false },
      value: (u, v) => (v == null ? '–' : pctMode ? `${v.toFixed(0)}%` : fmtW(v)) });
    data.push(pick(B, arr.sel));
  }
  const ax = axes((v) => (pctMode ? `${v}%` : fmtW(v)));
  arr.chart = new uPlot({
    width: el.clientWidth, height: el.clientHeight - 40, legend: { show: false },
    scales: { x: { time: true }, y: pctMode ? { range: [0, 150] } : {} },
    cursor: { focus: { prox: 16 } }, focus: { alpha: 0.25 },
    series, axes: ax,
    hooks: {
      setSeries: [(u, i) => { if (i != null && u.series[i]) $('arrNote').textContent = `· ${u.series[i].label}`; }],
      ...(pctMode ? { drawAxes: [(u) => { // 100% reference line
        const { ctx } = u, y = u.valToPos(100, 'y', true);
        ctx.save(); ctx.strokeStyle = css('--muted'); ctx.setLineDash([4, 4]); ctx.beginPath();
        ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke(); ctx.restore();
      }] } : {}),
    },
  }, data, el);
}

function arrayTable() {
  const { A, B, serials } = arr.data;
  const pctOf = (v, s) => (v && v.mean ? (v.daily[s] / v.mean) * 100 : null);
  const chg = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null);
  const cls = (x) => (x == null ? '' : x >= 0 ? 'up' : 'down');
  const fmtPct = (x, sign = false) => (x == null ? '–' : `${sign && x >= 0 ? '+' : ''}${x.toFixed(0)}%`);
  const rows = serials.map((s) => ({ s, a: A.daily[s] ?? null, b: B ? B.daily[s] ?? null : null, pa: pctOf(A, s), pb: pctOf(B, s) }))
    .sort((x, y) => (x.pa ?? 999) - (y.pa ?? 999));
  $('arrTable').innerHTML = `<thead><tr><th>Panel</th><th>Day A</th><th>Day B</th><th>Change</th><th>A, % of array avg</th><th>B, % of array avg</th><th>Shift</th></tr></thead><tbody>`
    + rows.map((r) => `<tr data-s="${r.s}" class="${arr.sel === r.s ? 'sel' : ''}"><td title="${r.s}">${unitName(r.s)}</td>
      <td>${fmtWh(r.a)}</td><td>${fmtWh(r.b)}</td><td class="${cls(chg(r.a, r.b))}">${fmtPct(chg(r.a, r.b), true)}</td>
      <td><span class="bar" style="width:${Math.max(0, Math.min(100, ((r.pa ?? 0) - 50) * 1.2))}px"></span>${fmtPct(r.pa)}</td><td>${fmtPct(r.pb)}</td>
      <td class="${cls(r.pa != null && r.pb != null ? r.pa - r.pb : null)}">${r.pa != null && r.pb != null ? `${r.pa - r.pb >= 0 ? '+' : ''}${(r.pa - r.pb).toFixed(0)} pts` : '–'}</td></tr>`).join('')
    + `</tbody><tfoot><tr><th>Array</th><th>${fmtWh(A.total)}</th><th>${fmtWh(B && B.total)}</th><th class="${cls(chg(A.total, B && B.total))}">${fmtPct(chg(A.total, B && B.total), true)}</th><th>100%</th><th>100%</th><th></th></tr></tfoot>`;
  const pa = rows.map((r) => r.pa).filter((x) => x != null);
  const weakest = rows.find((r) => r.pa != null);
  const items = [
    ['Array, Day A', fmtWh(A.total)], ['Array, Day B', fmtWh(B && B.total)], ['Change', fmtPct(chg(A.total, B && B.total), true)],
    ['Weakest panel (A)', weakest ? `${unitName(weakest.s)} · ${fmtPct(weakest.pa)}` : '–'],
    ['Spread (A)', pa.length ? `${Math.min(...pa).toFixed(0)}–${Math.max(...pa).toFixed(0)}%` : '–'],
    ['Panels under 90% (A)', String(pa.filter((x) => x < 90).length)],
    ['Data (A / B)', `${A.slotsWithData} / ${B ? B.slotsWithData : 0} of 96 slots`],
  ];
  $('arrKpis').innerHTML = items.map(([l, v]) => `<div class="kpi"><label>${l}</label><b>${v}</b></div>`).join('');
}

async function loadArrayCompare() {
  const [da, db] = await Promise.all([getJSON(`/api/array?day=${$('arrA').value}`), $('arrB').value ? getJSON(`/api/array?day=${$('arrB').value}`) : null]);
  const serials = [...new Set([...da.serials, ...(db ? db.serials : [])])].sort();
  arr.data = { A: arrayDayView(da), B: db ? arrayDayView(db) : null, serials, a0: da.from };
  if (arr.sel && !serials.includes(arr.sel)) arr.sel = null;
  $('arrNote').textContent = serials.length ? '' : '· no panel data for these days yet';
  drawArrayChart();
  arrayTable();
}
$('arrA').onchange = loadArrayCompare;
$('arrB').onchange = loadArrayCompare;
$('arrMode').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  arr.mode = b.dataset.m;
  document.querySelectorAll('#arrMode button').forEach((x) => x.classList.toggle('on', x === b));
  if (arr.data) drawArrayChart();
});
$('arrAll').onclick = () => { arr.sel = null; if (arr.data) { drawArrayChart(); arrayTable(); } };
$('arrTable').addEventListener('click', (e) => {
  const tr = e.target.closest('tbody tr'); if (!tr) return;
  arr.sel = arr.sel === tr.dataset.s ? null : tr.dataset.s;
  drawArrayChart(); arrayTable();
});
new ResizeObserver(() => arr.chart && arr.chart.setSize({ width: $('arrChart').clientWidth, height: $('arrChart').clientHeight - 40 })).observe($('arrChart'));

// ---------------------------------------------------------------- system
async function loadSystem() {
  const s = await getJSON('/api/status');
  const src = (n, x) => `<dt>${n}</dt><dd>${x.state}${x.running === false ? ' (standby)' : ''}${x.lastOk ? ' · last ' + new Date(x.lastOk).toLocaleTimeString() : ''}${x.error ? ' · ' + x.error : ''}</dd>`;
  $('sources').innerHTML = `<dt>Active</dt><dd>${s.active || 'none'}</dd>${src('Local gateway', s.sources.local)}${src('Cloud stream', s.sources.cloud)}
    <dt>Gateway host</dt><dd>${s.config.gatewayHost || '(not set)'}</dd><dt>Site</dt><dd>${s.config.siteId}</dd>`;
  const days = s.db.first ? ((s.db.last - s.db.first) / 86400).toFixed(1) : 0;
  $('dbinfo').innerHTML = `<dt>Rows (1 s)</dt><dd>${(s.db.rows || 0).toLocaleString()}</dd>
    <dt>Since</dt><dd>${s.db.first ? new Date(s.db.first * 1000).toLocaleString() : '–'} (${days} d)</dd>
    <dt>DB size</dt><dd>${(s.db.bytes / 1e6).toFixed(1)} MB</dd>`;
  $('log').textContent = s.log.map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.level.padEnd(5)} [${l.tag}] ${l.msg}`).reverse().join('\n');
}

// ---------------------------------------------------------------- EV advisor
const fmtT = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
let evChart, evSoc;

function evHeadline(ev) {
  const p = ev.plan;
  if (!p) return '<span class="muted">EV advisor starting (needs history + weather, ~1 min)…</span>';
  const assumed = ev.state && ev.state.assumed;
  const car = assumed && assumed.charging ? `Car assumed charging at ${assumed.amps} A.` : 'Car assumed not charging.';
  const next = (ev.nextAllowedTs > nowSec() ? ` Next message allowed after ${fmtT(ev.nextAllowedTs)}.` : '')
    + (ev.control && ev.control.enabled ? ` Auto control: ${ev.control.reason}.` : '')
    + (ev.cars && ev.cars.enabled ? ` Cars (${ev.cars.list.join(', ')}): ${ev.cars.mode === 'locked' ? '🔌 ' : 'searching · '}${ev.cars.reason || ev.cars.car}.` : '');
  if (!p.ok) return `<div class="big stop">No EV charging advised</div><div>${p.reason}</div><div class="muted">${car}</div>`;
  const b = p.best;
  if (b && b.startTs <= nowSec() + 60) {
    return `<div class="big go">Charge EV at ${b.amps} A now</div>
      <div>~${(b.watts / 1000).toFixed(1)} kW until ${fmtT(b.endTs)} · ${(b.wh / 1000).toFixed(1)} kWh to the car · house battery ${b.fullAt ? 'full by ' + fmtT(b.fullAt) : 'reaches target'}</div>
      <div class="muted">${car}${next}</div>`;
  }
  if (b) {
    return `<div class="big">Wait · EV window ${fmtT(b.startTs)}–${fmtT(b.endTs)} at ${b.amps} A</div>
      <div>~${(b.wh / 1000).toFixed(1)} kWh excess expected for the car; battery keeps priority until then.</div>
      <div class="muted">${car}${next}</div>`;
  }
  return `<div class="big stop">Don't charge EV from solar now</div><div>${p.reason || ''}</div><div class="muted">${car}${next}</div>`;
}

async function loadEv() {
  const ev = await getJSON('/api/ev');
  const html = evHeadline(ev);
  $('evSummary').innerHTML = html;
  if (activeTab !== 'ev') return ev;
  $('evNow').innerHTML = html;
  $('ntfyOn').hidden = !ev.ntfy; $('ntfyOff').hidden = !!ev.ntfy;
  if (ev.ntfy) $('ntfyUrl').textContent = ev.ntfy;
  const m = ev.model;
  $('evModelNote').textContent = m ? `· learned from ${Math.round(m.hoursUsed / 24)} days · capacity ${m.capacityWh ? (m.capacityWh / 1000).toFixed(1) + ' kWh' : '?'}`
    + ` · max charge ${(m.maxChargeW / 1000).toFixed(1)} kW · backtest error ${m.mape == null ? '?' : Math.round(m.mape * 100) + '%'}` : '';
  $('evLog').innerHTML = ev.notifications.length ? ev.notifications.map((n) =>
    `<dt>${new Date(n.ts * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</dt>
     <dd><b>${n.title}</b>${n.sent || n.error === 'log only' ? '' : ' <span class="stop">(not delivered: ' + (n.error || '?') + ')</span>'}<br><span class="muted">${n.body}</span></dd>`).join('')
    : '<span class="muted">None yet.</span>';

  // Chart: today on a 15-min grid; actual solar from Enlighten intervals, forecast for the rest.
  const day0 = midnight(), steps = (ev.plan && ev.plan.steps) || [];
  const actual = await getJSON(`/api/cloud-intervals?from=${day0}&to=${day0 + 86400}`);
  const act = new Map(actual.map((r) => [r.ts, r]));
  const fc = new Map(steps.map((s) => [s.ts, s]));
  const t = [], a = [], f = [], l = [], e = [], sb = [], se = [];
  for (let ts = day0; ts < day0 + 86400; ts += 900) {
    const r = act.get(ts), s = fc.get(ts);
    t.push(ts);
    a.push(r && r.production != null ? r.production * 4 : null);
    f.push(s ? s.pv : null); l.push(s ? s.load : r && r.consumption != null ? r.consumption * 4 : null);
    e.push(s ? s.ev : null);
    sb.push(s ? s.socBase : r ? r.soc : null); se.push(s ? s.socEv : null);
  }
  if (!evChart) {
    const el = $('evChart');
    evChart = new uPlot({
      width: el.clientWidth, height: el.clientHeight - 40, scales: { x: { time: true } },
      cursor: { sync: { key: 'ev' } },
      series: [{},
        { label: 'Solar actual', stroke: css('--pv'), width: 2, value: (u, v) => fmtW(v) },
        { label: 'Solar forecast', stroke: css('--pv'), dash: [6, 4], width: 1.5, value: (u, v) => fmtW(v) },
        { label: 'Home (typical)', stroke: css('--load'), width: 1.5, value: (u, v) => fmtW(v) },
        { label: 'EV plan', stroke: css('--batt'), fill: css('--batt') + '33', width: 1.5, value: (u, v) => fmtW(v) }],
      axes: axes((v) => fmtW(v)),
    }, [[], [], [], [], []], el);
    autoSize(evChart, el);
    evSoc = socChart($('evSocChart'), {
      sync: 'ev',
      extra: { label: 'SOC with EV plan', stroke: css('--batt'), dash: [6, 4], width: 2, scale: 'y', value: (u, v) => (v == null ? '–' : `${v}%`) },
    });
  }
  evChart.setData([t, a, f, l, e]);
  evSoc.setData([t, sb, se]);
  return ev;
}

$('evStopped').onclick = async () => {
  await fetch('/api/ev/assume', { method: 'POST', body: JSON.stringify({ charging: false }) }); loadEv();
};
$('evCharging').onclick = async () => {
  await fetch('/api/ev/assume', { method: 'POST', body: JSON.stringify({ charging: true, amps: Number($('evAmps').value) }) }); loadEv();
};
$('evTest').onclick = async () => {
  const r = await fetch('/api/ev/test-notify', { method: 'POST' }).then((x) => x.json());
  $('evTest').textContent = r.ok ? 'Sent ✓' : 'Failed';
  loadEv();
};
setInterval(loadEv, 60_000);

const onTab = { ev: loadEv, history: loadHistory, battery: loadBattery, grid: loadGridTab, array: loadArray, system: loadSystem, live: refreshToday };
setInterval(() => { if (activeTab === 'system') loadSystem(); }, 5000);
setInterval(() => { if (activeTab === 'battery') loadBattery(); }, 60_000);
setInterval(refreshToday, 60_000);

// ---------------------------------------------------------------- boot: live status first
(async function boot() {
  buildFlow();
  liveChart = powerChart($('liveChart'), { sync: 'live' });
  liveSoc = socChart($('liveSocChart'), { sync: 'live' });
  connectStream(); // live strip + flow start immediately, before any history loads
  const n = nowSec();
  const d = await getJSON(`/api/series?from=${n - LIVE_WINDOW}&to=${n + 1}&res=1`);
  // Merge prefill ahead of anything the stream already pushed.
  const firstLive = liveBuf.t[0] ?? Infinity;
  const keep = d.t.findIndex((t) => t >= firstLive);
  const cut = keep < 0 ? d.t.length : keep;
  for (const k of ['t', 'pv', 'load', 'grid', 'batt', 'soc']) liveBuf[k] = d[k].slice(0, cut).concat(liveBuf[k]);
  pushLive(null);
  liveChart.setData([liveBuf.t, liveBuf.pv, liveBuf.load, liveBuf.grid, liveBuf.batt]);
  liveSoc.setData([liveBuf.t, liveBuf.soc]);
  refreshToday();
  loadEv();
  getJSON(`/api/battery?from=${n - 3600}&to=${n}`).then((b) => {
    const caps = b.latest.map((u) => u.capacity_wh).filter(Boolean);
    if (caps.length) capacityWh = caps.reduce((a, c) => a + c, 0);
  });
})();
