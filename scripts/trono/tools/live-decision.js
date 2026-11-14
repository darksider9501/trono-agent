#!/usr/bin/env node
/**
 * Prints the live fight decision: the real hero, the ranked tier table and what
 * chooseFight would do right now. Used to check that the policy sees the same
 * numbers the runner acts on.
 *
 * The production runner owns CDP 9777, so this must run with the agent stopped:
 *   node tools/live-decision.js
 */
const { Game } = require('../lib/game');
const { readHero, rankTargets } = require('../lib/combat');
const learning = require('../lib/learning');
const { chooseFight } = require('../lib/select');
const lock = require('../lib/driverlock');
const credentials = require('../lib/credentials');

async function main() {
  if (lock.current()) {
    console.log('driver busy — stop the agent first');
    process.exit(2);
  }
  if (!lock.acquire('live-decision')) {
    console.log('could not acquire the driver lock');
    process.exit(2);
  }
  let g = null;
  try {
    g = await Game.connect({ spawn: true });
    if (!(await g.isLoggedIn())) {
      const creds = credentials.load();
      const res = await g.login(creds);
      if (!res || !res.ok) throw new Error('login failed');
    }
    const hero = await readHero(g);
    const targets = learning.apply(rankTargets(hero), hero);

    console.log('live hero:');
    console.log(
      JSON.stringify(
        {
          level: hero.level,
          hp: `${hero.hp}/${hero.maxHp}`,
          mana: `${hero.mana}/${hero.maxMana}`,
          stamina: `${hero.stamina}/${hero.maxStamina}`,
          atkDmg: hero.atkDmg,
          armor: hero.armor,
          crit: hero.crit,
          skill: hero.skill,
          gold: hero.gold,
          regenHp: hero.regenHp
        },
        null,
        1
      )
    );

    const margin = Math.round(hero.maxHp * 0.12);
    console.log(`\n   tier    win  gold  sta  hpCost  gold/sta  gold/day  startable (margin ${margin})`);
    for (const t of targets) {
      console.log(
        `${t.name.padEnd(8)} ${t.win ? 'Y' : 'N'}   ${String(t.gold).padStart(3)}  ${String(t.stamina).padStart(3)}  ` +
          `${String(Math.round(t.hpCost)).padStart(6)}  ${String(t.goldPerStamina).padStart(8)}  ${String(Math.round(t.goldPerDay)).padStart(8)}  ` +
          `${t.hpCost + margin <= hero.maxHp ? 'yes' : 'no'}`
      );
    }

    const sel = chooseFight(hero, targets, { maxFights: 2 });
    console.log(`\ndecision: ${sel.action}  tier=${sel.tier ? sel.tier.name : '-'}  plan=${sel.plan.length}x`);
    console.log(`reason:   ${sel.reason}`);
  } finally {
    if (g) {
      try {
        g.close();
      } catch (_) {}
    }
    lock.release();
  }
}

main().catch((e) => {
  console.error(`live decision failed: ${e.message}`);
  process.exit(1);
});
