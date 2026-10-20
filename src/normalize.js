// Both sources (local livedata JSON and cloud DataMsg protobuf) describe the same
// MeterSummaryData structure. Normalize to one shape in watts.
// Sign convention (Enphase): batt + = discharging, grid + = importing.

const RELAY_NAMES = [
  'OPER_RELAY_UNKNOWN', 'OPER_RELAY_OPEN', 'OPER_RELAY_CLOSED', 'OPER_RELAY_OFFGRID_AC_GRID_PRESENT',
  'OPER_RELAY_OFFGRID_READY_FOR_RESYNC_CMD', 'OPER_RELAY_WAITING_TO_INITIALIZE_ON_GRID',
  'OPER_RELAY_GEN_OPEN', 'OPER_RELAY_GEN_CLOSED', 'OPER_RELAY_GEN_STARTUP', 'OPER_RELAY_GEN_SYNC_READY',
  'OPER_RELAY_GEN_AC_STABLE', 'OPER_RELAY_GEN_AC_UNSTABLE',
];
const MODE_NAMES = { BATT_MODE_FULL_BACKUP: 0, BATT_MODE_SELF_CONS: 1, BATT_MODE_SAVINGS: 2, BATT_MODE_UNKNOWN: -1 };

const w = (mw) => (mw == null ? null : Number(mw) / 1000);

function relayCode(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const i = RELAY_NAMES.indexOf(v);
  if (i >= 0) return i;
  // local livedata sometimes reports e.g. "closed"/"open"
  if (/closed/i.test(v)) return 2;
  if (/open/i.test(v)) return 1;
  return 0;
}

function modeCode(v) {
  if (v == null) return -1;
  if (typeof v === 'number') return v;
  return MODE_NAMES[v] ?? -1;
}

// Cloud: protobuf DataMsg decoded with toObject({ enums: String, longs: Number }) and camelCase keys.
export function fromCloud(msg) {
  const m = msg.meters || {};
  const ch = (k) => m[k] || {};
  const ph = (k) => (ch(k).aggPPhMw || []).map(w);
  return {
    src: 'cloud',
    deviceTs: Number(msg.timestamp) || null,
    pv: w(ch('pv').aggPMw), batt: w(ch('storage').aggPMw), grid: w(ch('grid').aggPMw),
    load: w(ch('load').aggPMw), gen: w(ch('generator').aggPMw),
    va: { pv: w(ch('pv').aggSMva), batt: w(ch('storage').aggSMva), grid: w(ch('grid').aggSMva), load: w(ch('load').aggSMva) },
    ph: { pv: ph('pv'), batt: ph('storage'), grid: ph('grid'), load: ph('load') },
    soc: m.soc ?? null,
    backupSoc: msg.backupSoc ?? null,
    relay: relayCode(m.gridRelay),
    mode: modeCode(msg.battMode),
    phaseCount: m.phaseCount || 0,
  };
}

// Local: GET /ivp/livedata/status -> { meters: { pv: { agg_p_mw, agg_p_ph_a_mw, ... }, soc, main_relay_state, ... } }
export function fromLocal(json) {
  const m = json.meters || {};
  const ch = (k) => m[k] || {};
  const ph = (k) => ['a', 'b', 'c']
    .map((p) => ch(k)[`agg_p_ph_${p}_mw`])
    .slice(0, Math.max(1, m.phase_count || 2))
    .map(w);
  return {
    src: 'local',
    deviceTs: m.last_update ? m.last_update * 1000 : null,
    pv: w(ch('pv').agg_p_mw), batt: w(ch('storage').agg_p_mw), grid: w(ch('grid').agg_p_mw),
    load: w(ch('load').agg_p_mw), gen: w(ch('generator').agg_p_mw),
    va: { pv: w(ch('pv').agg_s_mva), batt: w(ch('storage').agg_s_mva), grid: w(ch('grid').agg_s_mva), load: w(ch('load').agg_s_mva) },
    ph: { pv: ph('pv'), batt: ph('storage'), grid: ph('grid'), load: ph('load') },
    soc: m.enc_agg_soc ?? m.soc ?? null,
    energyWh: m.enc_agg_energy ?? null, // stored battery energy; energyWh / soc = usable capacity
    backupSoc: m.backup_soc ?? null,
    // Local livedata encodes the relay as 1 = closed (on-grid), 0 = open; map to the cloud enum.
    relay: typeof m.main_relay_state === 'number' ? (m.main_relay_state === 1 ? 2 : 1) : relayCode(m.main_relay_state),
    mode: modeCode(m.backup_bat_mode),
    phaseCount: m.phase_count || 0,
  };
}
