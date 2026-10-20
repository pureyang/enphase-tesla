# Grid leakage

**Definition:** energy imported from the grid while the house battery had charge to spare
(SOC more than 5 points above the backup reserve). In self-consumption mode the battery should
cover the house, so ideal leakage is ~0 Wh.

Project goals this affects: (1) minimise grid import, (2) keep excess solar on site
(battery/EV) instead of exporting. Leakage is the import-side counterpart of export.

## How it is measured

Stored continuously: `leakage_1m` (one row per minute, built with the 1-minute rollups),
served at `/api/leakage?from=&to=&res=3600`. Daily totals come from `scripts/daily-report.js`,
which the server runs at 23:55 each night (and on boot for a missed yesterday): → `gridLeakage` in `data/reports/<day>.json`, from gateway 1 Hz rows only
(`samples.src = 1`), where `soc > backup_soc + 5`:

| Field | Meaning |
|---|---|
| `wh` | All import in those seconds |
| `spikeWh`, `spikeSeconds` | Import above 300 W: the battery lagging a load step |
| `biasWh` | The rest: a small steady import while the battery is discharging |
| `maxW` | Largest single-second import |
| `nightPct` | Night import ÷ night house use (pv < 50 W) |

Enlighten 15-min history can't show this (it nets each interval), so days without gateway
data have no leakage figure.

## Observations

### 2026-10-19 (first day, 8.5 h of gateway data, 11:00–20:00)

- Profile: Self-Consumption (`mode = 1`), backup reserve 5%, grid relay closed. 2 × IQ Battery 5P,
  in service since Aug 2025 (the gateway's per-unit `installed` stamp reads 2026-10-12, which looks like a
  re-provision, not the install date). Both units `envoy.global.ok`, firmware 3.0.17, 67% / 71% at 19:55.
- **Leakage 413 Wh**: spikes 175 Wh over 957 s (max 4.1 kW), bias 238 Wh.
- **After sunset (18:15–19:50, SOC 94% → 69%)**: 50 Wh imported against ~2.4 kWh of house use, **about 2%**.
  - Grid sat at +0–75 W most of the time (mean +22 W). The 25 W bins were 0–25 W: 2,370 s,
    25–50 W: 1,332 s, 50–75 W: 606 s. Only 155 s were slightly negative.
  - 11 spikes above 400 W, each lasting 1–6 s, matching load steps to 2.5–4.4 kW
    (6:53, 7:13, 7:19, 7:24–7:26 PM). About 8 Wh in total.
  - Both legs import a little: the latest sample had L1 +13 W and L2 +35 W while the battery split its output evenly.
- **Daytime with a full battery (SOC ≥ 98%)**: 90 Wh imported even though 1.7 kWh was exported in
  the same hours. That came from short spikes when the car or a large appliance started faster than the
  battery and inverters ramped up.

## Likely causes (to confirm)

1. **Control bias.** The battery appears to aim slightly above zero net power (~+20–40 W) so it never
   discharges into the grid. That would explain a steady import while SOC is high. Enphase hasn't
   documented a number for this.
2. **Ramp lag.** Battery output follows the consumption CT with a delay of a few seconds, so each large
   load step imports briefly. This scales with how often big loads switch on (EV starts and amp changes,
   oven, dryer, HVAC).
3. **Per-leg imbalance.** Output is split evenly across L1/L2 while loads aren't. A split-phase utility meter
   nets both legs, so this should only matter if the net metering doesn't.
4. **Installation or calibration.** Enphase moderators point to CT placement and battery calibration
   when owners report this (see sources). That's worth ruling out if the bias is large or growing.

Battery calibration has no homeowner view in the Enphase app; only the installer can check it.

Ruled out so far: reserve too high (it's 5%), and battery power limit (2 × 3.84 kW continuous vs. a 4.4 kW peak load).

## To collect next

- Daily `gridLeakage` for 7+ days to set a baseline, as for capture rate.
- Bias by SOC band and by load level: does it grow at low load, or near the reserve?
- Spike count per day vs. EV pushes followed: each car start or amp change should be one spike.
- Compare with the utility meter's interval data (PG&E Green Button), which shows what is actually billed.

## Ideas (not implemented)

- Ramp the car in steps (e.g. 6 A → target over a minute) to shrink start spikes once the BLE bridge
  can set amps.
- Ask Enphase support with this data: whether the self-consumption import target is configurable.

## Sources

- Enphase Community: "Importing Power while Batteries are charged":
  https://support.enphase.com/s/question/0D5Ps00000SCESnKAP/importing-power-while-batteries-are-charged
- Enphase Community: "Why am I importing from the grid during self-consumption mode…":
  https://support.enphase.com/s/question/0D53m00009NdbhrCAB/why-am-i-importing-from-the-grid-during-selfconsumption-mode-when-i-have-enough-battery-power-and-solar-production-to-supply-to-my-home
- Enphase Community: "…even with the battery at very high charge (80%+) - the system is importing from the grid at night":
  https://support.enphase.com/s/question/0D5Ps00000EKSugKAH/my-system-is-set-to-self-consumption-mode-i-have-recently-noticed-that-even-with-the-battery-at-very-high-charge-80-the-system-is-importing-from-the-grid-at-night-why
- Enphase IQ Battery 5P owner's guide (self-consumption profile, reserve):
  https://enphase.com/en-au/download/enphase-energy-system-iq-battery-5p-owners-guide.pdf
- Enphase tech brief, planning a storage system (consumption CT requirement, zero export):
  https://enphase.com/sites/default/files/downloads/support/Tech-Brief-Planning-Enphase-Storage-System-EN-US.pdf
