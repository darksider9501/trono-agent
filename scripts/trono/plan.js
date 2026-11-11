/**
 * Read-only combat planner: prints live hero stats and the target ranking
 * (EXP per HP spent, EXP per stamina) with a win/lose verdict per enemy.
 *
 *   node scripts/trono/plan.js
 *   node scripts/trono/plan.js --json
 */
const { Game } = require('./lib/game');
const { readHero, rankTargets } = require('./lib/combat');

const asJson = process.argv.includes('--json');

(async () => {
  const g = await Game.connect();
  try {
    const hero = await readHero(g);
    const rows = rankTargets(hero);

    if (asJson) {
      console.log(JSON.stringify({ hero, rows }, null, 2));
      return;
    }

    console.log(
      `hero lv${hero.level} | hp ${hero.hp}/${hero.maxHp} mana ${hero.mana}/${hero.maxMana} ` +
        `sta ${hero.stamina} | atk ${hero.atkDmg} arm ${hero.armor} crit ${hero.crit}% | ` +
        `skill ${hero.skill ? `${hero.skill.key} ${Math.round(hero.skill.power * 100)}%` : 'none'}`
    );
    console.log('');
    console.log('enemy      lv  hp   dmg def sta  exp gold  | verdict  actions  hpCost  exp/hp  exp/sta  now   gold/day');
    console.log('----------- -- ---- ---- --- --- ---- ----  | -------- -------  ------  ------  -------  ---');
    for (const r of rows) {
      console.log(
        `${r.name.padEnd(10).slice(0, 10)} ${String(r.level).padStart(2)} ` +
          `${String(r.hp).padStart(4)} ${String(r.dmg).padStart(4)} ${String(r.def).padStart(3)} ` +
          `${String(r.stamina).padStart(3)} ${String(r.exp).padStart(4)} ${String(r.gold).padStart(4)}  | ` +
          `${(r.win ? 'WIN' : 'LOSE').padEnd(8)} ${String(r.actions).padStart(7)} ` +
          `${String(r.hpCost).padStart(7)} ${String(r.expPerHp).padStart(7)} ${String(r.expPerStamina).padStart(7)}  ` +
          `${r.affordable ? 'yes' : 'no '}  ${String(r.goldPerDay).padStart(8)}`
      );
    }
    const best = rows.find((r) => r.win);
    console.log('');
    console.log(
      best
        ? `best farm right now: ${best.name} (lv${best.level}) — ${best.exp} EXP for ~${best.hpCost} HP, ` +
            `${best.stamina} stamina (${best.expPerHp} EXP/HP)`
        : 'no winnable target with current stats — level or gear up first'
    );
  } finally {
    g.close();
  }
})().catch((e) => {
  console.error(`ERROR ${e.code || ''} ${e.message}`);
  process.exit(1);
});
