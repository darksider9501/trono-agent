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
 * Effect per point, as declared by the game UI.
 *
 * Keys are the stat names the simulation already uses, so projecting a point is
 * an addition and nothing else.
 */
const DECLARED = {
  strength: { atkDmg: 2 },
  vitality: { maxHp: 10, armor: 1 },
  intelligence: { maxMana: 4, magicPower: 1 },
  perception: { accuracy: 0.4 },
  agility: { crit: 0.3, evasion: 0.25 },
  resistance: { magicDefense: 1 }
};

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

/** Current per-point delta for an attribute: measured if known, declared otherwise. */
function delta(attr, model = load()) {
  const learned = model[attr] && model[attr].delta;
  return { ...(DECLARED[attr] || {}), ...(learned || {}) };
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
  return out;
}

/**
 * What one point of `attr` is worth, in gold per day, today.
 *
 * `learning.apply` re-ranks with the measured HP cost, so the value reflects
 * what the bot has actually been paying per kill, not what the sim hopes.
 */
function score(hero, attr, model) {
  const probe = project(hero, attr, model);
  const rows = learning.apply(rankTargets(probe), probe);
  const best = rows.find((r) => r.win && !r.coolingDown) || null;
  return {
    goldPerDay: best ? best.goldPerDay : 0,
    target: best ? best.key : null,
    // Tie-break: a kill that costs less HP leaves room for more of them.
    hpCost: best ? best.hpCost : Infinity,
    unpriced: UNPRICED.includes(attr)
  };
}

/** The best target and its yield for a hypothetical hero. */
function bestOf(hero, model) {
  const rows = learning.apply(rankTargets(hero), hero);
  const best = rows.find((r) => r.win && !r.coolingDown) || null;
  return {
    goldPerDay: best ? best.goldPerDay : 0,
    target: best ? best.key : null,
    hpCost: best ? best.hpCost : Infinity
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
function reach(hero, attr, model, horizon, base) {
  let h = hero;
  for (let k = 1; k <= horizon; k += 1) {
    h = project(h, attr, model);
    const best = bestOf(h, model);
    if (best.goldPerDay > base.goldPerDay) {
      return { points: k, gain: +(best.goldPerDay - base.goldPerDay).toFixed(1) };
    }
  }
  return null;
}

/**
 * Rank every attribute by what the next point buys.
 *
 * Order: gold/day gained per point needed to reach the next improvement, then
 * the shorter path, then the cheaper kill, then a stable name order so the
 * choice does not flip between two equally good options on every tick.
 *
 * When nothing crosses within the horizon, every attribute is worth zero today
 * and the ranking falls through to the cheaper kill, which is still real: it is
 * the only direction that shortens fights and frees HP for more of them.
 */
function choose(hero, model = load(), horizon = 15) {
  const base = bestOf(hero, model);
  const rows = Object.keys(DECLARED).map((attr) => {
    const r = reach(hero, attr, model, horizon, base);
    return {
      attr,
      rate: r ? +(r.gain / r.points).toFixed(2) : 0,
      pointsToNext: r ? r.points : null,
      gain: r ? r.gain : 0,
      base,
      unpriced: UNPRICED.includes(attr)
    };
  });
  return rows.sort(
    (a, b) =>
      b.rate - a.rate ||
      (a.pointsToNext ?? Infinity) - (b.pointsToNext ?? Infinity) ||
      a.base.hpCost - b.base.hpCost ||
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
  entry.delta = { ...(entry.delta || {}), ...measured };
  entry.measured = (entry.measured || 0) + 1;
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
function summary(hero, model = load()) {
  const ranked = choose(hero, model);
  return ranked
    .map((r) => `${r.attr}:${r.rate}/point@${r.pointsToNext ?? '-'}pt${r.unpriced ? '(unpriced)' : ''}`)
    .join(' ');
}

module.exports = { DECLARED, UNPRICED, delta, project, score, bestOf, reach, choose, verify, save, load, summary, FILE };
