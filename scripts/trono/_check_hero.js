const { Game } = require('./lib/game');
const { readHero } = require('./lib/combat');

(async () => {
  const g = await Game.connect({ spawn: true });
  try {
    const hero = await readHero(g);
    console.log(JSON.stringify(
      {
        level: hero.level,
        hp: `${hero.hp}/${hero.maxHp}`,
        mana: `${hero.mana}/${hero.maxMana}`,
        regenHp: hero.regenHp,
        regenMana: hero.regenMana,
        restingBuilding: hero.restingBuilding,
        atkDmg: hero.atkDmg,
        armor: hero.armor,
        skill: hero.skill && hero.skill.key
      },
      null,
      1
    ));
  } finally {
    g.close();
  }
})().catch((e) => {
  console.error(`ERROR ${e.code || ''} ${e.message}`);
  process.exit(1);
});
