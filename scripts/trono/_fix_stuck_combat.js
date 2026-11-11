/**
 * Clear a stuck combat so regeneration resumes, then MEASURE the result.
 *
 * Diagnosis (verified live): player_state reported
 *   vitals.regeneration.hp = 0, passive_label "0%/min"
 * while stamina still regenerated at 10/h. The combat page still carried
 *   data-combat-id="45772"  with status "active", ended_at null
 * so the server kept the hero "en combate" — and the hospital page says
 * regeneration only applies "fuera de combate". Abandoning is safe and free:
 * "Conservarás tu vida y maná actuales".
 */
const { Game } = require('./lib/game');

const API = '/api/combat_pve.php';

async function csrfAndId(g) {
  const page = await g.fetchPage('/pages/combat_pve.php');
  const csrf = /data-combat-pve[\s\S]{0,1500}?data-csrf="([0-9a-f]{64})"/.exec(page.html);
  const id = /data-combat-id="(\d+)"/.exec(page.html);
  return { csrf: csrf ? csrf[1] : null, combatId: id ? Number(id[1]) : 0 };
}

async function abandon(g, combatId, csrf) {
  return g.evalInPage(`(async () => {
    const r = await fetch(${JSON.stringify(API)}, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': ${JSON.stringify(csrf)} },
      body: JSON.stringify({ operation: 'recover_abandon', combat_id: ${combatId}, csrf: ${JSON.stringify(csrf)} })
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  })()`, 60000);
}

async function vitals(g) {
  const ps = await g.apiGet('/api/player_state.php');
  const v = ps.state.hero.vitals;
  return {
    hp: v.current.hp,
    mana: v.current.mana,
    stamina: v.current.stamina,
    hpMax: v.max.hp,
    manaMax: v.max.mana,
    regenHp: v.regeneration.hp,
    regenMana: v.regeneration.mana,
    hpLabel: v.regeneration_details.hp.total_label,
    manaLabel: v.regeneration_details.mana.total_label,
    resting: v.resting_building
  };
}

(async () => {
  const g = await Game.connect({ spawn: true });
  try {
    if (!(await g.isLoggedIn())) {
      const creds = require('./lib/credentials').load();
      console.log('login:', (await g.login(creds)).ok);
    }

    const { csrf, combatId } = await csrfAndId(g);
    console.log('stuck combat:', combatId || '(none)', '| csrf:', csrf ? 'ok' : 'MISSING');

    const before = await vitals(g);
    console.log('before:', JSON.stringify(before));

    if (combatId && csrf) {
      const res = await abandon(g, combatId, csrf);
      console.log('abandon:', JSON.stringify(res).slice(0, 300));
    }

    if (combatId) {
      const st = await g.apiGet(`/api/combat_state.php?combat_id=${combatId}`);
      const b = st && st.data && st.data.state && st.data.state.battle;
      console.log('battle now:', b ? `status=${b.status} ended=${b.ended_at} reason=${b.end_reason}` : JSON.stringify(st).slice(0, 200));
    }

    const t0 = Date.now();
    const s0 = await vitals(g);
    console.log('\nafter abandon:', JSON.stringify(s0));

    console.log('\nsampling 3 x 80s to measure the real rate...');
    const samples = [s0];
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 80000));
      const s = await vitals(g);
      samples.push(s);
      const mins = (Date.now() - t0) / 60000;
      console.log(`  t+${mins.toFixed(1)}min hp=${s.hp} (${s.regenHp} = ${s.hpLabel}) mana=${s.mana} (${s.manaLabel}) regenHp=${s.regenHp}`);
    }

    const mins = (Date.now() - t0) / 60000;
    const dHp = samples[samples.length - 1].hp - samples[0].hp;
    const dMana = samples[samples.length - 1].mana - samples[0].mana;
    console.log('\n=== measured ===');
    console.log(
      `hp ${samples[0].hp} -> ${samples[samples.length - 1].hp} (+${dHp} in ${mins.toFixed(1)}min = ` +
        `${(dHp / mins).toFixed(2)} HP/min = ${((dHp / mins / samples[0].hpMax) * 100).toFixed(2)}%/min)`
    );
    console.log(
      `mana ${samples[0].mana} -> ${samples[samples.length - 1].mana} (+${dMana} = ` +
        `${(dMana / mins).toFixed(2)}/min = ${((dMana / mins / samples[0].manaMax) * 100).toFixed(2)}%/min)`
    );
  } finally {
    g.close();
  }
})().catch((e) => {
  console.error(`ERROR ${e.code || ''} ${e.message}`);
  process.exit(1);
});
