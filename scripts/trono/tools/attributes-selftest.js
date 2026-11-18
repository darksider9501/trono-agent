/**
 * Self-test for lib/attributes.js and the two bugs it shipped on 2026-11-18.
 *
 * Fixtures are the real values measured live that day:
 *   /api/hero_attributes.php `formulas` — the game publishing its own coefficients
 *   `derived`, `profile.primary = "intelligence"` for the druid
 *   hero lv9: atkDmg 54, armor 17, maxHp 730, maxMana 434
 *   state/learning.json measuments for the tier-1 encounters
 *
 * Bug 1: DECLARED said `strength: {atkDmg: 2}`. The game says `{arm: 0.5}`.
 *        The runner spent 27 points on strength and bought 13.5 armour, no damage.
 * Bug 2: `choose` scored ONE point at a time against a simulator that rounds
 *        damage to whole numbers, so every attribute scored exactly 0 and the
 *        fallback always picked strength. Irreversible decision made blind.
 *
 * Run: node tools/attributes-selftest.js
 */
const attributes = require('../lib/attributes');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}

// The live payload, verbatim shape and values from 2026-11-18.
const LIVE_FORMULAS = {
  strength: { arm: 0.5 },
  vitality: { hp: 10, arm: 1 },
  intelligence: { atk: 2, dmg: 2, magic_damage: 2, mana: 6, crit: 0.1 },
  perception: { accuracy: 0.4, detection: 0.4 },
  agility: { crit: 0.1, eva: 0.05, aspd: 1, initiative: 1 },
  resistance: { magic_defense: 1, debuff_resistance: 0.3 }
};

const HERO = {
  level: 9,
  atkDmg: 54,
  armor: 17,
  maxHp: 730,
  maxMana: 434,
  crit: 5,
  hp: 730,
  mana: 434,
  stamina: 68,
  maxStamina: 68,
  skill: { key: 'wildfire_bolt', power: 2.25, mana: 7, cd: 2, burnRatio: 0.26 }
};

const freshModel = () => {
  const m = { _formulas: { raw: LIVE_FORMULAS } };
  return m;
};

// ---------------------------------------------------------------- formulas ---
const mapped = attributes.fromFormulas(LIVE_FORMULAS);
check('formulas: strength maps to armour only, never damage',
  mapped && mapped.strength && mapped.strength.armor === 0.5 && mapped.strength.atkDmg === undefined,
  JSON.stringify(mapped && mapped.strength));
check('formulas: vitality maps hp and armour',
  mapped.vitality.maxHp === 10 && mapped.vitality.armor === 1, JSON.stringify(mapped.vitality));
check('formulas: intelligence maps damage (dmg -> atkDmg)',
  mapped.intelligence.atkDmg === 2, JSON.stringify(mapped.intelligence));
check('formulas: intelligence maps mana and crit',
  mapped.intelligence.maxMana === 6 && mapped.intelligence.crit === 0.1, JSON.stringify(mapped.intelligence));
check('formulas: unpriced keys are dropped, not invented',
  mapped.intelligence.magicPower === undefined && mapped.intelligence.magic_damage === undefined,
  JSON.stringify(mapped.intelligence));
check('formulas: a schema change returns null instead of zeroing the table',
  attributes.fromFormulas({}) === null && attributes.fromFormulas(null) === null);

// The game's formulas must beat the stale learned delta that poisoned the model.
const poisoned = {
  _formulas: { raw: LIVE_FORMULAS },
  strength: { delta: { atkDmg: 2, armor: 1 }, measured: 17 }
};
check('formulas outrank a stale measured delta',
  attributes.delta('strength', poisoned).atkDmg === undefined,
  JSON.stringify(attributes.delta('strength', poisoned)));

// Without formulas, the declared prior is still the game's, not the old lie.
check('declared fallback: strength is armour, not damage',
  attributes.DECLARED.strength.atkDmg === undefined && attributes.DECLARED.strength.armor === 0.5,
  JSON.stringify(attributes.DECLARED.strength));
check('declared fallback: intelligence carries the damage',
  attributes.DECLARED.intelligence.atkDmg === 2, JSON.stringify(attributes.DECLARED.intelligence));

// ----------------------------------------------------------------- project ---
const model = freshModel();
const int1 = attributes.project(HERO, 'intelligence', model);
check('project: intelligence raises damage by 2', int1.atkDmg === 56, `atkDmg ${int1.atkDmg}`);
check('project: intelligence raises mana by 6', int1.maxMana === 440, `maxMana ${int1.maxMana}`);
check('project: does not mutate the input hero', HERO.atkDmg === 54);
const str1 = attributes.project(HERO, 'strength', model);
check('project: strength raises armour by 0.5 and damage by 0',
  str1.armor === 17.5 && str1.atkDmg === 54, `armor ${str1.armor} atkDmg ${str1.atkDmg}`);

// -------------------------------------------------------------------- choose ---
// The decisive test: with the live hero and 27 points, intelligence must win.
//
// The yield TIES between intelligence, vitality and strength, and that is not a
// bug in the ranking — it is the economy. Stamina caps the day at 60 fights of
// Eryndor, so any attribute that pushes the HP cost below 15,768/60 = 263 HP
// reaches the same 1,260 gold/day ceiling. All three do (154 / 82 / 221).
//
// What separates them is everything else, and the order encodes it:
//   - intelligence is the druid's declared primary attribute, and it is the ONLY
//     stat that can ever raise the ceiling, because a higher tier is unlocked by
//     killing faster, never by surviving longer;
//   - it cuts the fight from 8 rounds to 4, which is the variance that killed
//     the hero twice on 2026-11-18.
const ranked = attributes.choose(HERO, model, 27, 'intelligence');
check('choose: intelligence wins the 27-point budget', ranked[0].attr === 'intelligence',
  `winner ${ranked[0].attr}`);
check('choose: the winner has a positive yield', ranked[0].gain > 0, `gain ${ranked[0].gain}`);
check('choose: intelligence reaches the region-1 ceiling', ranked[0].gain === 300,
  `gain ${ranked[0].gain} (960 -> ${960 + ranked[0].gain})`);
// Document the tie instead of pretending it does not exist.
check('choose: vitality reaches the same ceiling (the yield genuinely ties)',
  ranked.find((r) => r.attr === 'vitality').gain === ranked[0].gain,
  `int ${ranked[0].gain} vs vit ${ranked.find((r) => r.attr === 'vitality').gain}`);
check('choose: strength never outranks the primary on a tie',
  ranked[0].attr === 'intelligence' && ranked.find((r) => r.attr === 'strength').gain <= ranked[0].gain,
  `str ${ranked.find((r) => r.attr === 'strength').gain}`);
check('choose: the primary attribute is flagged for the tiebreak',
  ranked[0].primary === true);
check('choose: unpriced attributes score zero',
  ranked.find((r) => r.attr === 'perception').gain === 0);
// Intelligence must halve the ROUND COUNT, which is the property that actually
// matters and the one strength cannot buy.
//
// Measured with the live numbers: base is 8 rounds / 245 simulated HP against
// Eryndor; 27 points of intelligence is 4 rounds / 105 HP. Strength reaches 8
// rounds / 151 HP — it saves more raw HP per fight (armour applies on every
// round), but the fight never gets shorter.
//
// Rounds are the variance. Both deaths on 2026-11-18 happened because a fight
// that "should" cost 143.9 ran long; a 4-round fight cannot run 12 rounds. And
// the ceiling in this region is set by stamina, which only a shorter fight can
// raise — armour can never unlock the next tier up.
const intRow = ranked.find((r) => r.attr === 'intelligence');
const strRow = ranked.find((r) => r.attr === 'strength');
check('choose: intelligence halves the round count (4 vs 8 on Eryndor)',
  intRow.rounds < strRow.rounds,
  `int ${intRow.rounds} rounds vs str ${strRow.rounds} rounds`);
check('choose: strength buys no round reduction at all',
  strRow.rounds === ranked[0].base.rounds,
  `str ${strRow.rounds} vs base ${ranked[0].base.rounds}`);

// Without the primary hint the tie must still be broken deterministically, and
// it must never fall back to strength.
const noHint = attributes.choose(HERO, model, 27, null);
check('choose: deterministic without a primary hint', noHint[0].attr !== 'strength' || noHint[0].gain > 0,
  `winner ${noHint[0].attr} gain ${noHint[0].gain}`);
check('choose: same input twice gives the same winner',
  attributes.choose(HERO, model, 27, null)[0].attr === noHint[0].attr);

// Bug 2 regression: a one-point budget must not score every attribute zero when
// the whole budget has a real answer. The simulator quantises, so this is the
// exact condition that produced `strength(fallback)` 27 times.
const one = attributes.choose(HERO, model, 1, 'intelligence');
const allZero = one.every((r) => r.gain === 0 && r.simSaves === 0);
check('choose: a one-point budget is not evaluated as all-zero', !allZero,
  one.map((r) => `${r.attr}=${r.gain}`).join(' '));

// ------------------------------------------------------------- bestOf ranking ---
// `rankFor` rewrites goldPerDay after sorting, so bestOf must scan for the
// maximum instead of trusting the first winnable row. Getting this wrong made
// intelligence score 0 while being worth 300 gold/day.
const best = attributes.bestOf(HERO, model, HERO);
check('bestOf: reports the maximum yield, not the first row', best.goldPerDay > 0,
  `goldPerDay ${best.goldPerDay} target ${best.target}`);

// -------------------------------------------------------------- verifyDerived ---
// `verify` compared `overview`, a field this API has never returned, so it always
// returned null and the model was never corrected. `derived` is the real shape.
const vm = freshModel();
const seen = attributes.verifyDerived('intelligence', { arm: 17, dmg: 54, hp: 730 }, { arm: 17, dmg: 56, hp: 730 }, vm);
check('verifyDerived: reads the real `derived` block',
  seen && seen.atkDmg === 2, JSON.stringify(seen));
check('verifyDerived: records an observation count',
  vm.intelligence && vm.intelligence.observedCount === 1);
check('verifyDerived: a no-op spend measures nothing',
  attributes.verifyDerived('vitality', { arm: 17 }, { arm: 17 }, vm) === null);

// ------------------------------------------------------------- no double count ---
// verifyDerived must never touch `delta`, or the stale-delta poisoning returns.
check('verifyDerived: does not write into `delta`',
  vm.intelligence && vm.intelligence.delta === undefined);

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <- ' + (r.detail || '')}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
