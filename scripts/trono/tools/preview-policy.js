#!/usr/bin/env node
/**
 * Offline preview of the spending policy.
 *
 * Prints what attribute points are worth right now, without touching the browser
 * or the game. Two measurements matter and they are different questions:
 *
 * 1. Slope — what one point adds to gold per day. With stamina binding this is
 *    usually zero, because the number of fights per day does not move.
 * 2. Threshold — how few points it takes to cross into a better tier. That is
 *    where the real gold is, and a single-point score cannot see it.
 *
 * Also acts as a regression test for the skill-card parser against the committed
 * dump under state/sections.
 *
 *   node tools/preview-policy.js [maxHp] [atkDmg] [armor] [crit] [points]
 */
const fs = require('fs');
const path = require('path');
const { choose, project, DECLARED } = require('../lib/attributes');
const { rankTargets } = require('../lib/combat');
const learning = require('../lib/learning');

const [maxHp = 636, atkDmg = 38, armor = 19, crit = 6, batch = 15] = process.argv.slice(2).map(Number);

const hero = {
  level: 5,
  maxHp,
  hp: maxHp,
  maxMana: 346,
  mana: 346,
  atkDmg,
  armor,
  crit,
  skill: { key: 'wildfire_bolt', power: 1.25, mana: 7, cd: 2, burnRatio: 0.26 }
};

function ranked(h) {
  return learning.apply(rankTargets(h), h);
}

function bestGold(h) {
  const b = ranked(h).find((r) => r.win && !r.coolingDown);
  return b ? { gold: b.goldPerDay, target: b.key, hpCost: b.hpCost } : { gold: 0, target: null, hpCost: Infinity };
}

const base = bestGold(hero);
console.log(`=== baseline ===`);
console.log(`  gold/day=${base.gold}  target=${base.target}  hpCost=${base.hpCost}  (stamina binds below hpCost ${Math.round((maxHp * 0.015 * 1440) / 80)})`);

console.log('\n=== target table at current stats ===');
for (const r of ranked(hero)) {
  console.log(
    `  ${r.name.padEnd(9)} lv${r.level}  gold=${String(r.gold).padStart(2)} sta=${r.stamina}` +
      `  win=${r.win ? 'Y' : 'N'}  gold/day=${String(r.goldPerDay).padStart(7)}` +
      `  hpCost=${String(r.hpCost).padEnd(6)} ${r.affordable ? 'affordable' : ''}`
  );
}

console.log(`\n=== threshold sweep: points to the next improvement (batch ${batch}) ===`);
for (const attr of Object.keys(DECLARED)) {
  let h = hero;
  let found = null;
  for (let k = 1; k <= batch; k += 1) {
    h = project(h, attr);
    const b = bestGold(h);
    if (b.gold > base.gold) {
      found = { k, ...b };
      break;
    }
  }
  if (found) {
    const rate = ((found.gold - base.gold) / found.k).toFixed(1);
    console.log(`  ${attr.padEnd(13)} +${String(found.k).padStart(2)} points -> ${found.gold} gold/day on ${found.target}  (+${rate} g/d per point)`);
  } else {
    console.log(`  ${attr.padEnd(13)} no improvement within +${batch} points`);
  }
}

console.log('\n=== what the runner sees now (threshold-aware ranking) ===');
for (const r of choose(hero)) {
  console.log(
    `  ${r.attr.padEnd(13)} rate=${String(r.rate).padStart(5)} g/d per point` +
      `  next improvement at +${r.pointsToNext ?? '-'} points` +
      `  (base ${r.base.goldPerDay} g/d on ${r.base.target})` +
      (r.unpriced ? '  UNPRICED' : '')
  );
}

const dump = path.join(__dirname, '..', 'state', 'sections', 'pages_skills_php.html');
if (!fs.existsSync(dump)) {
  console.log('\n(no skills dump — skipping skill parser check)');
  process.exit(0);
}

console.log('\n=== skill cards parsed from the dump ===');
const html = fs.readFileSync(dump, 'utf8');
let cards = 0;
let upgradable = 0;
for (const block of html.split('data-skill-card').slice(1)) {
  const attr = (x) => {
    const m = new RegExp(`data-skill-${x}="([^"]*)"`).exec(block);
    return m ? m[1] : null;
  };
  const key = attr('key');
  if (!key) continue;
  cards += 1;
  const level = Number(attr('level') || 0);
  const max = Number(attr('max-level') || 10);
  const power = Number(attr('power') || 0) / 100;
  const next = Number(attr('next-power') || 0) / 100;
  const burn = /Quemadura: ([\d.]+)%/.exec(attr('description') || '');
  const usable = level >= 1 && level < max && next > power;
  if (usable) upgradable += 1;
  if (usable) {
    console.log(`  ${key.padEnd(14)} lv${level}/${max}  power ${power.toFixed(2)}->${next.toFixed(2)}  USABLE`);
  }
}
console.log(`  cards=${cards} upgradable=${upgradable}`);
