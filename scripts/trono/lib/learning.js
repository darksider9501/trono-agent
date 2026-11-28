/**
 * Progressive learning for combat targeting.
 *
 * The fight predictor simulates from a full HP pool, so its `hpCost` is an
 * estimate. Every real fight returns the HP actually spent. This module keeps a
 * running estimate per target, demotes targets that lose, and persists both to
 * state/learning.json so a restart does not throw the history away.
 *
 * Two properties matter:
 * - The measured cost replaces the simulated one in the ranking, so the bot
 *   stops trusting a model that is wrong about itself.
 * - A lost fight is not retried immediately; the cooldown grows with each
 *   consecutive loss for that target.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'state', 'learning.json');
const ALPHA = 0.35; // weight of the newest measurement in the moving average
const LOSS_COOLDOWN_MS = 15 * 60 * 1000;
const STAMINA_PER_DAY = 240;

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    cache = {};
  }
  if (!cache || typeof cache !== 'object') cache = {};
  return cache;
}

function entry(key) {
  const all = load();
  if (!all[key]) {
    all[key] = { hpCost: null, fights: 0, wins: 0, losses: 0, cooldownUntil: 0 };
  }
  return all[key];
}

/** How many recent costs are kept for the worst-case estimate. */
const RECENT = 8;
/** Fallback spread applied to a measured average when no recent list exists. */
const WORST_SPREAD = 1.15;

/** Record one finished fight against a target. */
function record(key, { hpCost, won, level }) {
  const e = entry(key);
  e.fights += 1;
  if (Number.isFinite(hpCost) && hpCost > 0) {
    e.hpCost = e.hpCost === null ? +hpCost.toFixed(1) : +(e.hpCost * (1 - ALPHA) + hpCost * ALPHA).toFixed(1);
    // A moving average is the right number for planning and the wrong number for
    // a go/no-go gate. On 2026-11-18 the average for Eryndor sat at 143.9 while
    // the real cost of the same fight was 368, because earlier cheap kills (more
    // armour, bigger pool) were still in the average. The gate let a second fight
    // start on 362 HP and the hero died twice, costing 529 gold. The recent list
    // keeps the worst case visible so the gate can use it instead.
    const list = Array.isArray(e.recent) ? e.recent : [];
    list.push(+hpCost.toFixed(1));
    e.recent = list.slice(-RECENT);
  }
  if (Number.isFinite(level)) e.level = level;
  if (won) {
    e.wins += 1;
    e.losses = 0;
    e.cooldownUntil = 0;
  } else {
    e.losses += 1;
    e.cooldownUntil = Date.now() + LOSS_COOLDOWN_MS * e.losses;
  }
}

/** Read a target's history without creating an entry for it. */
function peek(key) {
  return load()[key] || null;
}

/** True when the target is not serving a loss cooldown. */
function available(key) {
  const e = entry(key);
  return !e.cooldownUntil || Date.now() >= e.cooldownUntil;
}

/**
 * Fold everything learned into a fresh ranking.
 *
 * Recomputes gold/day from the measured HP cost and pushes cooling targets to
 * the back. Mutates and re-sorts the rows in place, then returns them.
 *
 * Measured fights outrank the simulator, and the simulator is treated as a
 * weak signal on purpose. On 2026-11-12 it predicted 224 HP for Eryndor and a
 * win; the real fight cost 310 HP, ended in a loss and took 79 gold with it.
 * The same model underestimated Brumak by 3.4x, Aeril by 11.7x and Virex by 11x,
 * so an unmeasured target is only worth a probe when the model calls it almost
 * free, and never when the enemy outlevels the hero.
 */
function apply(rows, hero) {
  const hpPerDay = hero.maxHp * 0.015 * 60 * 24;
  // The worst simulation error actually observed is ~12x (Aeril: 4 HP predicted,
  // 47 measured). A probe is only worth it when even being that wrong leaves the
  // hero alive, so the margin uses the worst case, not the average.
  const SIM_ERROR_MARGIN = 12;
  for (const r of rows) {
    const e = peek(r.key);
    const measured = !!(e && e.fights > 0);
    // Keep the model's number under its own name before a measurement replaces it;
    // the trust gate below has to compare against the simulation, always.
    r.hpCostSimulated = r.hpCost;
    // What the SIMULATOR said, before any demotion below. The probe escape hatch
    // at the end of this function needs it: a target demoted for lack of evidence
    // is still one the model thinks is winnable, and that is exactly the one
    // worth measuring.
    r.simWin = !!r.win;
    if (measured && e.hpCost) {
      r.hpCost = e.hpCost;
      r.goldPerHp = +(r.gold / Math.max(1, r.hpCost)).toFixed(4);
    }
    // Worst cost actually observed, not the average. A gate that plans on the
    // average loses every fight that lands on the wrong side of the spread.
    //
    // `recent` does not exist for entries written before 2026-11-18, so a
    // measured target with no recent list falls back to the average plus a
    // spread allowance. Measured spread on Eryndor: average 358.5, worst 374,
    // so 1.15 covers the observed variance with room to spare.
    r.hpCostWorst = measured && Array.isArray(e.recent) && e.recent.length
      ? Math.max(...e.recent)
      : (measured ? +(r.hpCost * WORST_SPREAD).toFixed(1) : r.hpCostSimulated);
    if (measured) {
      // A target that has never been won is not winnable, whatever the model
      // says. It gets one fresh attempt after each level-up, when the stats that
      // the model ignored have actually changed.
      const retryAtNewLevel = e.wins === 0 && hero.level > (e.level || 0);
      if (e.wins === 0 && !retryAtNewLevel) {
        r.win = false;
        r.blockedBy = `lost every measured fight (${e.fights})`;
      } else if (e.wins === 0) {
        r.win = r.win && r.level <= hero.level && r.hpCostSimulated * SIM_ERROR_MARGIN <= hero.maxHp;
        r.blockedBy = r.win ? null : 'unproven above hero level';
      }
      r.trust = 'measured';
    } else {
      // Never fought: trust the model only where being wrong cannot be fatal.
      const trivial = r.hpCostSimulated * SIM_ERROR_MARGIN <= hero.maxHp;
      const atOrBelowLevel = r.level <= hero.level;
      if (r.win && (!trivial || !atOrBelowLevel)) {
        r.win = false;
        r.blockedBy = !atOrBelowLevel ? 'outlevels the hero (untested)' : 'simulation not confident enough (untested)';
      }
      r.trust = 'simulated';
    }
    r.goldPerDay =
      r.win && r.hpCost > 0
        ? +(
            Math.min(STAMINA_PER_DAY / Math.max(1, r.stamina), hpPerDay / Math.max(1, r.hpCost)) * r.gold
          ).toFixed(1)
        : 0;
    r.coolingDown = e ? !!e.cooldownUntil && Date.now() < e.cooldownUntil : false;
  }
  rows.sort((a, b) => {
    if (a.win !== b.win) return a.win ? -1 : 1;
    if (a.coolingDown !== b.coolingDown) return a.coolingDown ? 1 : -1;
    return b.goldPerDay - a.goldPerDay || b.goldPerHp - a.goldPerHp;
  });
  return rows;
}

/** Human-readable snapshot for the log line. */
function summary() {
  const all = load();
  return Object.entries(all)
    .filter(([, e]) => e.fights > 0)
    .map(([k, e]) => `${k}:${e.wins}/${e.fights}@${e.hpCost ?? '?'}hp`)
    .join(' ');
}

function save() {
  try {
    const all = load();
    // Only keep targets that actually carry history. An entry with no fights and
    // no cooldown is indistinguishable from a target never seen, so persisting it
    // only makes the file unreadable.
    for (const [key, e] of Object.entries(all)) {
      if (!e.fights && !e.cooldownUntil) delete all[key];
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(all, null, 2));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (_) {
    // A failed write must never fail a tick.
  }
}

module.exports = { record, available, apply, summary, save, load, FILE };
