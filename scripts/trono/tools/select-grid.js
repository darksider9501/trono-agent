#!/usr/bin/env node
/**
 * Offline grid test for the fight-selection policy.
 *
 * Prints the decision the runner would take for every combination of HP and
 * stamina at today's hero stats, so the policy can be read as a table instead of
 * inferred from a live log. It never touches the browser.
 *
 *   node tools/select-grid.js [maxHp] [atkDmg] [armor] [crit]
 */
const { rankTargets } = require('../lib/combat');
const learning = require('../lib/learning');
const { chooseFight } = require('../lib/select');

const [maxHp = 636, atkDmg = 38, armor = 19, crit = 6] = process.argv.slice(2).map(Number);

const base = {
  level: 5,
  maxHp,
  maxMana: 346,
  mana: 346,
  atkDmg,
  armor,
  crit,
  maxStamina: 65,
  skill: { key: 'wildfire_bolt', power: 1.25, mana: 7, cd: 2, burnRatio: 0.26 }
};

const rows = [];
for (const hp of [0.1, 0.2, 0.3, 0.5, 0.75, 1].map((f) => Math.round(maxHp * f))) {
  for (const stamina of [65, 50, 30, 12]) {
    const hero = { ...base, hp, stamina };
    const targets = learning.apply(rankTargets(hero), hero);
    const sel = chooseFight(hero, targets, { maxFights: 2 });
    rows.push({
      hp,
      stamina,
      action: sel.action,
      pick: sel.action === 'fight' ? `${sel.tier.name} (${sel.plan.length}x)` : '-',
      why: sel.reason.replace(/^resting: need/, 'rest need').slice(0, 74)
    });
  }
}

console.log(`hero maxHp ${maxHp} atk ${atkDmg} armor ${armor} crit ${crit}  stamina cap 65\n`);
console.log('   hp  sta  action  pick            why');
for (const r of rows) {
  console.log(`${String(r.hp).padStart(5)} ${String(r.stamina).padStart(4)}  ${r.action.padEnd(6)}  ${r.pick.padEnd(15)} ${r.why}`);
}

// The tier table the policy sees, with the budgets that produce it.
const targets = learning.apply(rankTargets({ ...base, hp: maxHp, stamina: 65 }), { ...base, hp: maxHp, stamina: 65 });
console.log('\n   tier    win  gold  sta  hpCost  gold/sta  gold/day  startable (buffer included)');
const margin = Math.round(maxHp * 0.12);
for (const t of targets) {
  console.log(
    `${t.name.padEnd(8)} ${t.win ? 'Y' : 'N'}   ${String(t.gold).padStart(3)}  ${String(t.stamina).padStart(3)}  ` +
      `${String(Math.round(t.hpCost)).padStart(6)}  ${String(t.goldPerStamina).padStart(8)}  ${String(Math.round(t.goldPerDay)).padStart(8)}  ` +
      `${t.hpCost + margin <= maxHp ? 'yes' : 'no'}`
  );
}
