/**
 * Attribute allocation policy.
 *
 * A point is not worth "the biggest stat". It is worth what it adds to gold per
 * day under the budget that runs out first, which is the same rule lib/combat.js
 * uses to rank targets, fed with the HP cost measured in lib/learning.js.
 *
 * Where the numbers come from:
 * - The game documents each attribute on the overview page, in the card `title`
 *   attributes (state/sections/pages_overview_php.html:139-164). That is the
 *   prior, and it is not a guess made here.
 * - The POST to /api/hero_attributes.php returns the full derived snapshot, so
 *   every spend also measures the real delta. If the game ever changes a
 *   coefficient, the measurement overwrites the prior (see `verify`).
 *
 * Honest limit: perception and resistance raise accuracy and magic defence,
 * neither of which the combat simulation models. They therefore score 0 here.
 * That means "unpriced by this model", not "useless" — see `UNPRICED`.
 */
const fs = require('fs');
const path = require('path');
const { rankTargets } = require('./combat');
const learning = require('./learning');

const FILE = path.join(__dirname, '..', 'state', 'attribute_model.json');

/**
 * Effect per point, in the stat names the simulation already uses.
 *
 * These are NOT derived from the UI copy. They come from `formulas` in
 * /api/hero_attributes.php, which is the game publishing its own coefficients
 * (captured 2026-11-18):
 *
 *   strength     { arm: 0.5 }
 *   vitality     { hp: 10, arm: 1 }
 *   intelligence { atk: 2, dmg: 2, magic_damage: 2, mana: 6, crit: 0.1 }
 *   perception   { accuracy: 0.4, detection: 0.4 }
 *   agility      { crit: 0.1, eva: 0.05, aspd: 1, initiative: 1 }
 *   resistance   { magic_defense: 1, debuff_resistance: 0.3 }
 *
 * Why this matters: the previous table claimed `strength: {atkDmg: 2}`. That is
 * false — strength buys HALF A POINT OF ARMOUR and no damage at all. On
 * 2026-11-18 the runner spent 27 points on strength on the strength of that
 * wrong entry: it bought 13.5 armour, 0 damage, and +0 gold/day. Attribute
 * points cannot be respec'd (`overview.php` exposes no reset/refund), so the
 * error is permanent. This table is a fallback only; `formulas` from the API
 * overrides it at runtime (see `learnFormulas`).
 *
 * Only the parts a simulation can price are listed. `detection`, `aspd`,
 * `initiative` and `debuff_resistance` have no model in combat.js, so they are
 * dropped rather than invented.
 */
const DECLARED = {
  strength: { armor: 0.5 },
  vitality: { maxHp: 10, armor: 1 },
  intelligence: { atkDmg: 2, maxMana: 6, crit: 0.1 },
  perception: { accuracy: 0.4 },
  agility: { crit: 0.1, evasion: 0.05 },
  resistance: { magicDefense: 1 }
};

/** Game formula key -> simulation field. Anything absent is unpriced. */
const FORMULA_MAP = {
  arm: 'armor',
  hp: 'maxHp',
  dmg: 'atkDmg',
  mana: 'maxMana',
  crit: 'crit',
  eva: 'evasion',
  accuracy: 'accuracy',
  magic_defense: 'magicDefense'
};

/**
 * Translate the game's `formulas` block into the simulation's field names.
 *
 * Returns null when the payload is not the shape we expect, so a schema change
 * leaves the declared fallback in place instead of silently zeroing the table.
 */
function fromFormulas(formulas) {
  if (!formulas || typeof formulas !== 'object') return null;
  const out = {};
  for (const [attr, effects] of Object.entries(formulas)) {
    if (!effects || typeof effects !== 'object') continue;
    const mapped = {};
    for (const [k, v] of Object.entries(effects)) {
      const dst = FORMULA_MAP[k];
      if (dst && Number.isFinite(Number(v))) mapped[dst] = Number(v);
    }
    if (Object.keys(mapped).length) out[attr] = mapped;
  }
  return Object.keys(out).length ? out : null;
}

/** Attributes whose effect the combat simulation cannot price. */
const UNPRICED = ['perception', 'resistance'];

/** Overview field -> simulation field. */
const OVERVIEW_MAP = { max_hp: 'maxHp', max_mana: 'maxMana', dmg: 'atkDmg', armor: 'armor' };

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

/** Current per-point delta for an attribute: the game's formula first, then declared, then measured. */
function delta(attr, model = load()) {
  const formula = fromFormulas(model._formulas && model._formulas.raw);
  if (formula && formula[attr]) return formula[attr];
  const learned = model[attr] && model[attr].delta;
  return { ...(DECLARED[attr] || {}), ...(learned || {}) };
}

/**
 * Record the game's own `formulas` block as the source of truth.
 *
 * The API publishes the coefficients it actually applies, so there is no reason
 * to infer them from a UI string or from a noisy before/after diff. Returns true
 * when the table changed.
 */
function learnFormulas(formulas, model = load()) {
  const raw = fromFormulas(formulas);
  if (!raw) return false;
  const before = JSON.stringify(model._formulas && model._formulas.raw);
  if (before === JSON.stringify(formulas)) return false;
  model._formulas = { raw: formulas, at: new Date().toISOString() };
  cache = model;
  save(model);
  return true;
}

/** Apply one point of `attr` to the hero, without mutating the caller's object. */
function project(hero, attr, model) {
  const d = delta(attr, model);
  const out = { ...hero, skill: hero.skill };
  if (d.atkDmg) out.atkDmg = hero.atkDmg + d.atkDmg;
  if (d.maxHp) out.maxHp = hero.maxHp + d.maxHp;
  if (d.maxMana) out.maxMana = hero.maxMana + d.maxMana;
  if (d.armor) out.armor = hero.armor + d.armor;
  if (d.crit) out.crit = hero.crit + d.crit;
  if (d.evasion) out.evasion = (hero.evasion || 0) + d.evasion;
  if (d.accuracy) out.accuracy = (hero.accuracy || 0) + d.accuracy;
  if (d.magicDefense) out.magicDefense = (hero.magicDefense || 0) + d.magicDefense;
  return out;
}

/**
 * What one point of `attr` is worth, in gold per day, today.
 *
 * `learning.apply` re-ranks with the measured HP cost, so the value reflects
 * what the bot has actually been paying per kill, not what the sim hopes.
 */
function score(hero, attr, model, baseline) {
  const probe = project(hero, attr, model);
  const rows = rankFor(probe, model, baseline || hero);
  const best = rows.find((r) => r.win && !r.coolingDown) || null;
  return {
    goldPerDay: best ? best.goldPerDay : 0,
    target: best ? best.key : null,
    // Tie-break: a kill that costs less HP leaves room for more of them.
    hpCost: best ? best.hpCost : Infinity,
    unpriced: UNPRICED.includes(attr)
  };
}

/**
 * Rank targets for a hypothetical hero, anchored on the measured costs.
 *
 * `learning.apply` replaces a measured target's cost with the measurement, which
 * is right for the real hero and WRONG for a hypothetical one. The measurement
 * belongs to the current stats, so it cannot see that two more points of damage
 * shorten the fight. Left alone, every attribute scores the identical number on
 * every measured target, `gain` comes out 0 for all six, and `choose` falls
 * through to its blind tie-break.
 *
 * That is exactly what happened on 2026-11-18: 27 points went to strength
 * (`strength(fallback)` in the log) while the real best buy was intelligence.
 *
 * The fix keeps the measurement as the anchor and scales it by how much the
 * simulation says the fight moved:
 *
 *   cost(projected) = cost(measured) * sim(projected) / sim(current)
 *
 * So a point that turns a 12-round fight into a 10-round one is worth 17% of the
 * measured cost, which is a real number to rank against.
 */
function rankFor(hero, model, baseline) {
  const rows = learning.apply(rankTargets(hero), hero);
  if (!baseline) return rows;

  const baseSim = new Map(rankTargets(baseline).map((r) => [r.key, r.hpCost]));
  const hpPerDay = hero.maxHp * 0.015 * 60 * 24;

  for (const r of rows) {
    if (r.trust !== 'measured' || !Number.isFinite(r.hpCost)) continue;
    const simBase = baseSim.get(r.key);
    const simNew = r.hpCostSimulated;
    if (!Number.isFinite(simBase) || !Number.isFinite(simNew) || simBase <= 0) continue;

    r.hpCostMeasured = r.hpCost;
    r.hpCost = +(r.hpCost * (simNew / simBase)).toFixed(1);
    r.goldPerHp = +(r.gold / Math.max(1, r.hpCost)).toFixed(4);
    r.goldPerDay =
      r.win && r.hpCost > 0
        ? +(Math.min(240 / Math.max(1, r.stamina), hpPerDay / Math.max(1, r.hpCost)) * r.gold).toFixed(1)
        : 0;
  }
  return rows;
}

/** The best target and its yield for a hypothetical hero. */
function bestOf(hero, model, baseline) {
  const rows = rankFor(hero, model, baseline);
  // Pick the maximum explicitly. `rankFor` rewrites `goldPerDay` after the rows
  // were sorted, so "the first winnable row" is no longer the best one — that
  // shortcut silently returned Brumak (960) for a hero whose real best was
  // Eryndor (1,260), which is how intelligence scored 0 while being worth 300.
  let best = null;
  for (const r of rows) {
    if (!r.win || r.coolingDown) continue;
    if (!best || r.goldPerDay > best.goldPerDay) best = r;
  }
  return {
    goldPerDay: best ? best.goldPerDay : 0,
    target: best ? best.key : null,
    hpCost: best ? best.hpCost : Infinity,
    rounds: best ? best.actions : null
  };
}

/**
 * How many points of `attr` it takes to cross into a strictly better yield.
 *
 * This is the measurement that actually matters. While stamina binds, the number
 * of fights per day does not move, so a single point adds nothing and a
 * marginal-value score degenerates to the same number for every attribute. What
 * a point buys is progress toward a threshold where the yield jumps.
 *
 * Returns `{ points, gain }` or null when the horizon is not enough.
 */
function reach(hero, attr, model, horizon, base, baseline) {
  let h = hero;
  for (let k = 1; k <= horizon; k += 1) {
    h = project(h, attr, model);
    const best = bestOf(h, model, baseline || hero);
    if (best.goldPerDay > base.goldPerDay) {
      return { points: k, gain: +(best.goldPerDay - base.goldPerDay).toFixed(1) };
    }
  }
  return null;
}

/**
 * Rank every attribute by what spending the WHOLE budget on it would buy.
 *
 * Per-point evaluation is useless here, and that is a fact about the engine, not
 * a detail. `simulateFight` rounds damage to whole numbers, so one point of
 * intelligence (atk 54 -> 56) leaves the round count at 8 and the HP cost at 245:
 * exactly zero measured improvement. Three points drop it to 7 rounds and 210 HP.
 * Ranking on one point therefore returns 0 for every attribute, which is the
 * degenerate case that produced `strength(fallback)` 27 times on 2026-11-18 and
 * bought 13.5 armour and no damage. Attribute points cannot be undone.
 *
 * So the question asked is the real one: "if I commit everything available to
 * this attribute, how much better is my day?" That answer is smooth, it survives
 * the rounding, and it is what a one-shot irreversible decision needs.
 *
 * Ordering:
 *   1. gold/day gained per point committed — the actual yield.
 *   2. the class's declared primary attribute (`profile.primary`, e.g. druid ->
 *      intelligence). When the yield ties, the game's own design is the tiebreak,
 *      not alphabetical order. This is what makes intelligence win at level 9:
 *      intelligence and vitality both cap the stamina budget at 1,260 gold/day,
 *      so the yield is identical and the primary decides.
 *   3. HP saved per fight by the simulation, then a stable name order.
 */
function choose(hero, model = load(), budget = 1, primary = null) {
  const base = bestOf(hero, model, hero);
  const n = Math.max(1, budget | 0);

  const rows = Object.keys(DECLARED).map((attr) => {
    let h = hero;
    for (let k = 0; k < n; k += 1) h = project(h, attr, model);
    const best = bestOf(h, model, hero);
    const gain = +(best.goldPerDay - base.goldPerDay).toFixed(1);

    // HP the full commitment saves per fight, per the simulation. Negative is
    // possible and must never be rewarded: it means the attribute lengthens the
    // fight, which only happens to a model that is wrong about itself.
    let simSaves = 0;
    let rounds = null;
    if (base.target) {
      const before = rankTargets(hero).find((t) => t.key === base.target);
      const after = rankTargets(h).find((t) => t.key === base.target);
      if (before && after) {
        simSaves = +(before.hpCost - after.hpCost).toFixed(1);
        rounds = after.actions;
      }
    }

    return {
      attr,
      // Yield per committed point, so a 1-point and a 27-point budget compare.
      rate: +(gain / n).toFixed(2),
      gain,
      points: n,
      simSaves,
      // Rounds left in the best fight after the full commitment. This is the
      // variance measure: a 4-round fight cannot run 12 rounds, and the two
      // deaths on 2026-11-18 were both long fights on a short estimate.
      rounds,
      goldPerDay: best.goldPerDay,
      target: best.target,
      base,
      unpriced: UNPRICED.includes(attr),
      primary: attr === primary
    };
  });

  return rows.sort(
    (a, b) =>
      b.rate - a.rate ||
      b.gain - a.gain ||
      Number(b.primary) - Number(a.primary) ||
      (a.rounds ?? 99) - (b.rounds ?? 99) ||
      b.simSaves - a.simSaves ||
      a.attr.localeCompare(b.attr)
  );
}

/**
 * Compare the prior against what the server actually did, and keep the real number.
 *
 * `before` and `after` are the `overview` snapshots returned by the attributes
 * API. Only fields the game moved are recorded, so an attribute that the UI
 * documents but that does not touch the snapshot keeps its declared prior.
 */
function verify(attr, before, after, model = load()) {
  if (!before || !after) return null;
  const measured = {};
  for (const [src, dst] of Object.entries(OVERVIEW_MAP)) {
    const a = Number(before[src]);
    const b = Number(after[src]);
    if (Number.isFinite(a) && Number.isFinite(b) && b !== a) measured[dst] = +(b - a).toFixed(4);
  }
  if (!Object.keys(measured).length) return null;

  const entry = model[attr] || (model[attr] = {});
  entry.delta = { ...entry.delta, ...measured };
  entry.measured = (entry.measured || 0) + 1;
  entry.at = new Date().toISOString();
  cache = model;
  return measured;
}

/**
 * Compare two `derived` blocks from /api/hero_attributes.php.
 *
 * That endpoint answers a spend with the full recomputed snapshot: `derived`
 * carries the stat deltas and `total` the allocation. The old code compared
 * `data.overview`, a field this API has never returned, so `verify` always saw
 * `undefined` and returned null. The stale entry it left behind claimed
 * strength buys +2 damage AND +1 armour, which made the tie-break prefer
 * strength forever. This is the shape that actually exists.
 */
const DERIVED_MAP = {
  arm: 'armor',
  hp: 'maxHp',
  dmg: 'atkDmg',
  atk: 'atk',
  mana: 'maxMana',
  crit: 'crit',
  eva: 'evasion',
  accuracy: 'accuracy',
  magic_defense: 'magicDefense'
};

function verifyDerived(attr, before, after, model = load()) {
  if (!before || !after) return null;
  const measured = {};
  for (const [src, dst] of Object.entries(DERIVED_MAP)) {
    const a = Number(before[src]);
    const b = Number(after[src]);
    if (Number.isFinite(a) && Number.isFinite(b) && b !== a) measured[dst] = +(b - a).toFixed(4);
  }
  if (!Object.keys(measured).length) return null;

  const entry = model[attr] || (model[attr] = {});
  entry.observed = { ...(entry.observed || {}), ...measured };
  entry.observedCount = (entry.observedCount || 0) + 1;
  entry.at = new Date().toISOString();
  cache = model;
  return measured;
}

function save(model = load()) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(model, null, 2));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (_) {
    // A failed write must never fail a tick.
  }
}

/** One-line snapshot for the log. */
function summary(hero, model = load(), primary = null) {
  const ranked = choose(hero, model, 15, primary);
  return ranked
    .map((r) => `${r.attr}:${r.rate}/point@${r.pointsToNext ?? '-'}pt${r.simSaves ? `-${r.simSaves}hp` : ''}${r.unpriced ? '(unpriced)' : ''}`)
    .join(' ');
}

module.exports = {
  DECLARED,
  UNPRICED,
  FORMULA_MAP,
  delta,
  fromFormulas,
  learnFormulas,
  project,
  score,
  bestOf,
  rankFor,
  reach,
  choose,
  verify,
  verifyDerived,
  save,
  load,
  summary,
  FILE
};
