#!/usr/bin/env node
/**
 * One-shot, human-authorized probe of a single target.
 *
 * Exists because the trust gate in lib/learning.js blocks an unmeasured target on
 * a simulation that has been wrong by up to 12x. When a human authorizes paying
 * for the measurement, this runs exactly ONE fight with the same protocol the
 * runner uses and stores the real HP cost, so the next decision is made on
 * evidence instead of on the model.
 *
 * Refuses to run while the production runner is alive: two clients sharing one
 * session would fight each other for the single combat slot.
 *
 *   node tools/probe.js eryndor
 */
const path = require('path');
const { execSync } = require('child_process');

const TRONO = path.join(__dirname, '..');
const session = require(path.join(TRONO, 'lib', 'session.js'));
const { GameHttp } = require(path.join(TRONO, 'lib', 'httptransport.js'));
const { readHero, fight, rankTargets, ENCOUNTERS } = require(path.join(TRONO, 'lib', 'combat.js'));
const learning = require(path.join(TRONO, 'lib', 'learning.js'));

const PS_COUNT =
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*trono*runner.js*' } | Measure-Object | Select-Object -ExpandProperty Count";

function runnerAlive() {
  try {
    const out = execSync(`powershell -NoProfile -Command "${PS_COUNT}"`, { encoding: 'utf8' });
    return Number(out.trim()) > 0;
  } catch (_) {
    return null; // cannot tell; the caller decides
  }
}

(async () => {
  const key = process.argv[2] || 'eryndor';
  const enemy = ENCOUNTERS[key];
  if (!enemy) {
    console.log(`unknown target "${key}"; known: ${Object.keys(ENCOUNTERS).join(', ')}`);
    process.exit(2);
  }
  if (runnerAlive() === true) {
    console.log('runner alive - pause the agent first (one session, one client)');
    process.exit(2);
  }

  const g = new GameHttp(session.load());
  const hero = await readHero(g);

  console.log('=== BEFORE ===');
  console.log(
    `  hero      lv${hero.level}  hp ${hero.hp}/${hero.maxHp}  atk ${hero.atkDmg}  armor ${hero.armor}  sta ${hero.stamina}/${hero.maxStamina}`
  );
  console.log(
    `  target    ${enemy.name} lv${enemy.level}  ${enemy.stamina} stamina  reward ${enemy.gold} gold / ${enemy.exp} exp`
  );

  const row = rankTargets(hero).find((r) => r.key === key);
  if (row) {
    console.log(
      `  simulator win=${row.win} hpCost=${Math.round(row.hpCost)}  (x12 = ${Math.round(row.hpCost * 12)} vs maxHp ${hero.maxHp})`
    );
  }
  const before = learning.load()[key];
  console.log(
    `  learning  ${before ? `fights=${before.fights} wins=${before.wins} hpCost=${before.hpCost} level=${before.level === undefined ? 'MISSING' : before.level}` : '(no history)'}`
  );

  if (hero.stamina < enemy.stamina) {
    console.log(`  ABORT: stamina ${hero.stamina} < ${enemy.stamina}`);
    process.exit(3);
  }
  if (!hero.hp || hero.hp <= 0) {
    console.log('  ABORT: hero has no HP');
    process.exit(3);
  }

  console.log('\n=== FIGHT ===');
  const res = await fight(g, {
    locationId: enemy.locationId,
    enemyId: enemy.enemyId,
    allowMutate: true,
    maxActions: 40
  });
  if (!res.ok) {
    console.log(`  aborted - ${res.error}`);
    process.exit(3);
  }
  console.log(`  ${res.won ? 'WIN' : 'LOSS'}  rounds=${res.rounds}  end=${res.endReason || '?'}`);
  console.log(`  hp    ${res.hpBefore} -> ${res.hpAfter}   (cost ${res.hpCost})`);
  console.log(`  exp   +${res.expGain}   gold ${res.goldGain >= 0 ? '+' : ''}${res.goldGain}   stamina ${res.stamina}   level ${res.level}`);
  console.log(`  rounds  ${res.log.map((r) => `${r.i}[${r.myHp}/${r.enemyHp}]`).join(' ')}`);

  learning.record(key, { hpCost: res.hpCost, won: !!res.won, level: hero.level });
  learning.save();

  const after = learning.load()[key];
  console.log('\n=== AFTER (state/learning.json) ===');
  console.log(
    `  ${key}: fights=${after.fights} wins=${after.wins} losses=${after.losses} hpCost=${after.hpCost} level=${after.level} cooldown=${after.cooldownUntil || 0}`
  );

  // What the gate decides now that it has a measurement instead of a simulation.
  const hero2 = await readHero(g);
  const ranked = learning.apply(rankTargets(hero2), hero2);
  const me = ranked.find((r) => r.key === key);
  console.log('\n=== GATE AFTER ===');
  console.log(`  hero lv${hero2.level} hp ${hero2.hp}/${hero2.maxHp} sta ${hero2.stamina}`);
  console.log(
    `  ${key}: win=${me.win} trust=${me.trust} hpCost=${me.hpCost} goldPerDay=${me.goldPerDay} blockedBy=${me.blockedBy || '-'} coolingDown=${me.coolingDown}`
  );
  const top = ranked
    .filter((r) => r.win && !r.coolingDown)
    .slice(0, 3)
    .map((r) => `${r.key} ${r.goldPerDay}/d`);
  console.log(`  top: ${top.join('  |  ')}`);
})().catch((e) => {
  console.log('ERROR', e.code || '', e.message);
  process.exit(1);
});
