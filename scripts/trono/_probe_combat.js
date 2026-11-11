/**
 * Why is regeneration 0? READ ONLY.
 *
 * player_state reports vitals.regeneration.{hp,mana} = 0 and passive_label "0%/min",
 * while stamina still regenerates. The hospital page states regeneration applies
 * "fuera de combate" (out of combat), so the prime suspect is a combat instance the
 * server still considers active (a fight that was created but never finished).
 */
const { Game } = require('./lib/game');

(async () => {
  const g = await Game.connect({ spawn: true });
  try {
    if (!(await g.isLoggedIn())) {
      console.log('session dead -> login');
      const creds = require('./lib/credentials').load();
      const res = await g.login(creds);
      console.log('login:', res.ok);
    }

    const page = await g.fetchPage('/pages/combat_pve.php');
    console.log('combat page status', page.status, 'bytes', page.html.length);

    const ids = [...new Set([...page.html.matchAll(/data-combat-id="(\d+)"/g)].map((m) => m[1]))];
    console.log('data-combat-id values:', ids.length ? ids.join(', ') : '(none)');

    const main = (page.html.match(/<main[\s\S]*?<\/main>/i) || [])[0] || page.html;
    const text = main
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    console.log('\n--- combat page text (first 900) ---');
    console.log(text.slice(0, 900));

    // Any element that announces an unfinished battle?
    for (const m of page.html.matchAll(/data-(battle|combat|in-combat|status)-?[a-z]*="([^"]{0,40})"/gi)) {
      if (/combat|battle/i.test(m[0])) console.log('marker:', m[0].slice(0, 120));
    }

    for (const id of ids) {
      const st = await g.apiGet(`/api/combat_state.php?combat_id=${id}`);
      console.log(`\n--- combat_state ${id} ---`);
      const s = st && st.data ? st.data : st;
      const battle = s && s.state && s.state.battle ? s.state.battle : s && s.battle;
      console.log(JSON.stringify(battle || s, null, 1).slice(0, 700));
    }

    // Baseline: what the HUD and the hospital page claim right now.
    const ps = await g.apiGet('/api/player_state.php');
    const v = ps.state.hero.vitals;
    console.log('\n--- vitals now ---');
    console.log(`hp ${v.current.hp}/${v.max.hp}  mana ${v.current.mana}/${v.max.mana}  resting=${v.resting_building}`);
    console.log(`regen hp=${v.regeneration.hp} mana=${v.regeneration.mana} labels=${JSON.stringify(v.regeneration_details)}`);

    const ov = await g.fetchPage('/pages/overview.php');
    const ovt = (ov.html.match(/<main[\s\S]*?<\/main>/i) || [ov.html])[0]
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    const i = ovt.search(/Pasiva/i);
    console.log('\n--- HUD regen labels ---');
    console.log(i === -1 ? '(not found)' : ovt.slice(Math.max(0, i - 160), i + 260));
  } finally {
    g.close();
  }
})().catch((e) => {
  console.error(`ERROR ${e.code || ''} ${e.message}`);
  process.exit(1);
});
