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

/** Record one finished fight against a target. */
function record(key, { hpCost, won }) {
  const e = entry(key);
  e.fights += 1;
  if (Number.isFinite(hpCost) && hpCost > 0) {
    e.hpCost = e.hpCost === null ? +hpCost.toFixed(1) : +(e.hpCost * (1 - ALPHA) + hpCost * ALPHA).toFixed(1);
  }
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
 */
function apply(rows, hero) {
  const hpPerDay = hero.maxHp * 0.015 * 60 * 24;
  for (const r of rows) {
    const e = peek(r.key);
    if (e && e.fights > 0 && e.hpCost) {
      r.hpCostSimulated = r.hpCost;
      r.hpCost = e.hpCost;
      r.goldPerHp = +(r.gold / Math.max(1, r.hpCost)).toFixed(4);
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
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(load(), null, 2));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (_) {
    // A failed write must never fail a tick.
  }
}

module.exports = { record, available, apply, summary, save, load, FILE };
