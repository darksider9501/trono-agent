/**
 * Read-only regeneration probe.
 *
 * Prints the RAW player_state so we can see every recovery-related field the
 * server exposes, then samples it again after N seconds to measure the real
 * HP/mana rate. Performs zero mutations: if regen stays flat here, the cause is
 * server-side state, not the runner's write traffic.
 *
 *   node scripts/trono/_probe_regen.js 120
 */
const fs = require('fs');
const path = require('path');
const { Game } = require('./lib/game');

const WAIT = Number(process.argv[2] || 120);
const OUT = path.join(__dirname, 'logs');

function pick(obj, re, prefix = '') {
  const rows = [];
  const walk = (v, p) => {
    if (v === null || typeof v !== 'object') {
      if (re.test(p)) rows.push(`${p} = ${v}`);
      return;
    }
    for (const [k, val] of Object.entries(v)) walk(val, p ? `${p}.${k}` : k);
  };
  walk(obj, prefix);
  return rows;
}

const fmt = (s) => ({
  hp: s.hero.vitals.current.hp,
  hpMax: s.hero.vitals.max ? s.hero.vitals.max.hp : null,
  mana: s.hero.vitals.current.mana,
  manaMax: s.hero.vitals.max ? s.hero.vitals.max.mana : null,
  stamina: s.hero.vitals.current.stamina,
  resting: s.hero.vitals.resting_building,
  recovery: s.hero.vitals.recovery,
  raw: s.hero.vitals
});

(async () => {
  const g = await Game.connect({ spawn: true });
  try {
    const t0 = Date.now();
    const a = await g.apiGet('/api/player_state.php');
    if (!a || !a.ok) throw new Error(`player_state HTTP ${a && a.status}`);

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'player_state_raw.json'), JSON.stringify(a, null, 2), 'utf8');

    console.log('=== top-level keys ===');
    console.log(Object.keys(a).join(', '));
    console.log('\n=== hero keys ===');
    console.log(Object.keys(a.state.hero).join(', '));
    console.log('\n=== vitals (raw) ===');
    console.log(JSON.stringify(a.state.hero.vitals, null, 2));

    console.log('\n=== recovery/time-ish fields anywhere ===');
    const rows = pick(a, /(regen|recover|rest|updat|_at$|time|next|tick|accru)/i);
    console.log(rows.slice(0, 60).join('\n') || '(none)');

    console.log('\n=== buildings ===');
    console.log(JSON.stringify(a.state.buildings || a.state.kingdom || {}, null, 2).slice(0, 1200));

    const s1 = fmt(a.state);
    console.log('\n=== sample 1 ===');
    console.log(JSON.stringify(s1, null, 1).slice(0, 900));

    console.log(`\nwaiting ${WAIT}s with NO writes at all...`);
    await new Promise((r) => setTimeout(r, WAIT * 1000));

    const b = await g.apiGet('/api/player_state.php');
    const s2 = fmt(b.state);
    const mins = (Date.now() - t0) / 60000;
    console.log('\n=== sample 2 (after probe) ===');
    console.log(JSON.stringify(s2, null, 1).slice(0, 900));

    const hpMax = s1.hpMax || 316;
    const manaMax = s1.manaMax || 266;
    console.log('\n=== measured rate ===');
    console.log(
      `elapsed ${mins.toFixed(2)} min · hp ${s1.hp} -> ${s2.hp} (${s2.hp - s1.hp >= 0 ? '+' : ''}${s2.hp - s1.hp}` +
        ` = ${(((s2.hp - s1.hp) / mins) / hpMax * 100).toFixed(2)}%/min) · mana ${s1.mana} -> ${s2.mana}` +
        ` (${s2.mana - s1.mana >= 0 ? '+' : ''}${s2.mana - s1.mana} = ${(((s2.mana - s1.mana) / mins) / manaMax * 100).toFixed(2)}%/min)`
    );
    console.log(`resting_building: ${s1.resting} -> ${s2.resting}`);
    fs.writeFileSync(path.join(OUT, 'player_state_raw_after.json'), JSON.stringify(b, null, 2), 'utf8');
  } finally {
    g.close();
  }
})().catch((e) => {
  console.error(`ERROR ${e.code || ''} ${e.message}`);
  process.exit(1);
});
