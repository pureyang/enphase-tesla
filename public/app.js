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
function powerChart(el, { sync, onZoom, bands, soc, ev, events } = {}) {
  const ax = axes((v) => fmtW(v, true));
  if (soc) ax.push({ scale: '%', side: 1, stroke: css('--soc'), grid: { show: false }, size: 52, values: (u, v) => v.map((x) => `${x}%`) });
  const opts = {
    width: el.clientWidth, height: el.clientHeight - 40,
    cursor: { sync: sync ? { key: sync } : undefined, drag: { x: Boolean(onZoom), y: false } },
    scales: { x: { time: true }, ...(soc ? { '%': { range: [0, 100] } } : {}) },
    series: [{}, ...SERIES.map((s) => ({
      label: s.label, stroke: css(s.color), width: 1.5, value: (u, v) => fmtW(v, true), points: { show: false },
    })), ...(ev ? [{ label: 'EV charging', stroke: css('--ev'), fill: css('--ev') + '33', width: 2, value: (u, v) => (v == null ? '–' : fmtW(v, true)), points: { show: false } }] : []), ...(soc ? [{ label: 'Battery SOC', scale: '%', stroke: css('--soc'), width: 2, dash: [6, 4], value: (u, v) => (v == null ? '–' : `${v.toFixed(0)}%`), points: { show: false } }] : [])],
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
const hist = { from: midnight(), to: nowSec(), stack: [], data: null, chart: null, soc: null };
const toLocalInput = (s) => { const d = new Date(s * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => Math.floor(new Date(v) / 1000);

async function loadHistory() {
  if (!hist.chart) {
    hist.chart = powerChart($('histChart'), {
      sync: 'hist', soc: true, ev: true, events: () => hist.evEvents, bands: () => (hist.data && hist.data.res > 1 ? hist.data : null),
      onZoom: (a, b) => { hist.stack.push([hist.from, hist.to]); hist.from = a; hist.to = b; loadHistory(); },
    });
    hist.soc = socChart($('histSoc'), { sync: 'hist' });
  }
  $('from').value = toLocalInput(hist.from); $('to').value = toLocalInput(hist.to);
  $('csv').href = `/api/export.csv?from=${hist.from}&to=${hist.to}`;
  const [d, e, car] = await Promise.all([
    getJSON(`/api/series?from=${hist.from}&to=${hist.to}`),
    getJSON(`/api/energy?from=${hist.from}&to=${hist.to}`),
    getJSON(`/api/tesla?from=${hist.from}&to=${hist.to}`).catch(() => ({ series: [], events: [] })),
  ]);
  hist.evEvents = evMarkers(car.events);
  hist.data = d;
  $('resNote').textContent = d.res === 1 ? `${d.t.length.toLocaleString()} points · 1 s` : `${d.t.length.toLocaleString()} buckets · ${d.res >= 3600 ? d.res / 3600 + ' h' : d.res / 60 + ' min'} avg (min/max shaded)`;
  hist.chart.setData([d.t, d.pv, d.load, d.grid, d.batt, evOnGrid(d.t, car.series || [], d.res), d.soc]);
  hist.chart.setScale('x', { min: hist.from, max: hist.to });
  hist.soc.setData([d.t, d.soc]);
  hist.soc.setScale('x', { min: hist.from, max: hist.to });
  kpis($('rangeKpis'), e);
}
$('presets').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x === b));
  const n = nowSec(), p = b.dataset.p;
  hist.to = n; hist.stack = [];
  hist.from = p === 'today' ? midnight() : n - { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 }[p];
  loadHistory();
});
$('apply').onclick = () => { hist.stack.push([hist.from, hist.to]); hist.from = fromLocalInput($('from').value); hist.to = fromLocalInput($('to').value); loadHistory(); };
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
async function loadArray() {
  const inv = await getJSON('/api/inverters');
  const total = inv.reduce((a, r) => a + (r.watts || 0), 0);
  $('invNote').textContent = inv.length ? `· ${inv.length} units · ${fmtW(total)} · gateway updates these every ~5 min` : '';
  $('inv').innerHTML = inv.length ? inv.map((r) => {
    const f = r.max_watts ? Math.min(1, r.watts / r.max_watts) : 0;
    return `<div style="background:hsl(${40 + f * 10} ${30 + f * 70}% ${85 - f * 35}%)" title="${r.serial}\nmax ${r.max_watts} W\n${new Date(r.ts * 1000).toLocaleString()}">
      <b>${r.watts} W</b><br>${String(r.serial).slice(-6)}</div>`;
  }).join('') : '<span class="muted">Requires the local gateway connection.</span>';
}

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
    + (ev.control && ev.control.enabled ? ` Auto control: ${ev.control.reason}.` : '');
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
