/**
 * Combat engine for Defiende el Trono.
 *
 * Protocol (reverse-engineered from /assets/js/combat-pve.js):
 *   POST /api/combat_pve.php  JSON {operation:'create_from_world', location_id, world_enemy_id,
 *                                   practice_hp, practice_damage, practice_armor, request_id, csrf}
 *   POST /api/combat_pve.php  JSON {operation:'attack', combat_id, request_id, csrf}
 *   POST /api/combat_pve.php  JSON {operation:'skill', skill_key, repeat_count, combat_id, request_id, csrf}
 *   POST /api/combat_pve.php  JSON {operation:'recover_abandon', combat_id, csrf}
 *   GET  /api/combat_state.php?combat_id=...
 *   CSRF: 64-hex from <main class="combat-pve-page" ... data-csrf="...">
 *
 * Measured damage model (live, 2026-11-11):
 *   basic hit  = attack_damage - enemy_def
 *   skill  hit = round(attack_damage * skill_power) - enemy_def
 *   burn  tick = round(0.26 * round(attack_damage * skill_power)), 3 turns, refreshes
 *   taken hit  = enemy_dmg - our_armor   (doubled at level gap >= 5)
 *
 * The predictor is the safety gate: the bot never spends HP on a fight it cannot win,
 * because HP is the scarcest resource (regen ~2%/min while resting at the hospital).
 */
const { HOST } = require('./game');

const COMBAT_API = '/api/combat_pve.php';

/** Region 1 (Bosque de Sylvenor) measured card values. Refreshed from the live map when possible. */
const ENCOUNTERS = {
  virex: { key: 'virex', name: 'Virex', level: 2, tier: 'boss', locationId: 1, enemyId: 1, hp: 160, dmg: 20, def: 4, stamina: 3, gold: 6, exp: 160 },
  aeril: { key: 'aeril', name: 'Aeril', level: 3, tier: 'mob', locationId: 2, enemyId: 2, hp: 255, dmg: 26, def: 6, stamina: 3, gold: 9, exp: 190 },
  brumak: { key: 'brumak', name: 'Brumak', level: 4, tier: 'mini', locationId: 3, enemyId: 3, hp: 332, dmg: 33, def: 8, stamina: 3, gold: 12, exp: 220 },
  lyss: { key: 'lyss', name: 'Lyss', level: 5, tier: 'mini', locationId: 4, enemyId: 4, hp: 491, dmg: 39, def: 10, stamina: 4, gold: 15, exp: 250 },
  morvak: { key: 'morvak', name: 'Morvak', level: 6, tier: 'boss', locationId: 5, enemyId: 5, hp: 625, dmg: 46, def: 12, stamina: 4, gold: 18, exp: 280 },
  eryndor: { key: 'eryndor', name: 'Eryndor', level: 7, tier: 'mini', locationId: 6, enemyId: 6, hp: 774, dmg: 52, def: 14, stamina: 4, gold: 21, exp: 310 },
  nymira: { key: 'nymira', name: 'Nymira', level: 8, tier: 'mini', locationId: 7, enemyId: 7, hp: 952, dmg: 59, def: 16, stamina: 5, gold: 24, exp: 340 },
  sylthar: { key: 'sylthar', name: 'Sylthar', level: 10, tier: 'final', locationId: 8, enemyId: 8, hp: 1637, dmg: 110, def: 20, stamina: 5, gold: 30, exp: 625 }
};

const PRACTICE = { locationId: 62, enemyId: 133 };

/** Skills land in this order of preference: cheap sustained damage first. */
const SKILL_PRIORITY = ['wildfire_bolt', 'solar_bloom', 'beast_ember', 'ember_roots', 'cinder_storm'];

const uuid = () => {
  const h = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${h()}-${h()}-${h()}-${h()}`;
};

/**
 * Analytic fight simulation. Mirrors the server exchange order:
 * player action -> burn tick -> enemy action.
 *
 * @param {object} p
 * @param {{hp:number,dmg:number,def:number}} p.enemy
 * @param {{atkDmg:number,armor:number,hp:number,mana:number,skillPower:number,burnRatio:number,skillMana:number,skillCd:number,levelGap:number,dangerGap:number,dangerMultiplier:number}} p.me
 */
function simulateFight({ enemy, me, maxActions = 60 }) {
  const basic = Math.max(1, me.atkDmg - enemy.def);
  const skillPower = me.skillPower || 0;
  const skillBase = skillPower ? Math.round(me.atkDmg * skillPower) : 0;
  const skillHit = skillPower ? Math.max(1, skillBase - enemy.def) : 0;
  const burnTick = skillPower ? Math.max(1, Math.round((me.burnRatio || 0.26) * skillBase)) : 0;

  const dangerOn = me.dangerGap && me.levelGap >= me.dangerGap;
  const incomingBase = Math.max(1, enemy.dmg - me.armor);
  const incoming = dangerOn ? Math.round(incomingBase * (me.dangerMultiplier || 2)) : incomingBase;

  let eHp = enemy.hp;
  let pHp = me.hp;
  let mana = me.mana;
  let cd = 0;
  let burnTurns = 0;
  let actions = 0;
  let usedSkill = false;

  while (eHp > 0 && pHp > 0 && actions < maxActions) {
    const canSkill = skillPower > 0 && cd <= 0 && mana >= me.skillMana;
    if (canSkill) {
      eHp -= skillHit;
      burnTurns = 3;
      mana -= me.skillMana;
      cd = me.skillCd || 2;
      usedSkill = true;
    } else {
      eHp -= basic;
      if (cd > 0) cd -= 1;
    }
    if (burnTurns > 0 && eHp > 0) {
      eHp -= burnTick;
      burnTurns -= 1;
    }
    actions += 1;
    if (eHp <= 0) break;
    pHp -= incoming;
  }

  const win = eHp <= 0 && pHp > 0;
  return {
    win,
    actions,
    hpLeft: Math.max(0, pHp),
    hpCost: Math.max(0, me.hp - Math.max(0, pHp)),
    incoming,
    basic,
    skillHit,
    burnTick,
    usedSkill,
    dpsPerAction: +(((enemy.hp - Math.max(0, eHp)) / actions) || 0).toFixed(2)
  };
}

/** Read the hero's combat stats straight from the server (equipment included). */
async function readHero(g) {
  const eq = await g.apiGet('/api/hero_equipment.php');
  if (!eq || !eq.ok || !eq.data) throw new Error('hero_equipment unavailable');
  const d = eq.data;
  const final = d.stats.final;
  const level = d.hero.level;

  // hero_equipment does not expose vitals.regeneration; player_state does, and that
  // value is the only reliable "am I stuck in a combat?" signal (0 while one is active).
  const ps = await g.apiGet('/api/player_state.php').catch(() => null);
  const pv = ps && ps.ok && ps.state && ps.state.hero ? ps.state.hero.vitals : null;

  const skillsPage = await g.fetchPage('/pages/skills.php');
  const ranks = {};
  let points = 0;
  if (skillsPage.ok) {
    const pts = /data-skill-points>(\d+)</.exec(skillsPage.html);
    points = pts ? Number(pts[1]) : 0;
    for (const m of skillsPage.html.matchAll(/data-skill-key="([a-z_]+)" data-skill-level="(\d+)"/g)) {
      ranks[m[1]] = Number(m[2]);
    }
  }

  const known = SKILL_PRIORITY.find((k) => (ranks[k] || 0) > 0) || null;
  const skillMeta = known ? readSkillMeta(skillsPage.html, known) : null;

  return {
    level,
    atkDmg: final.attack_damage,
    armor: final.armor,
    magicPower: final.magic_power,
    maxHp: final.max_hp,
    maxMana: final.max_mana,
    crit: final.crit_chance,
    hp: pv ? pv.current.hp : d.vitals.current.hp,
    mana: pv ? pv.current.mana : d.vitals.current.mana,
    stamina: pv ? pv.current.stamina : d.vitals.current.stamina,
    // Wallet balances. player_state is the only endpoint that carries them, and
    // without them the run cannot show progress toward the withdrawal threshold.
    gold: ps && ps.ok && ps.state && ps.state.economy ? ps.state.economy.gold : null,
    dotirian: ps && ps.ok && ps.state && ps.state.economy ? ps.state.economy.dotirian : null,
    gems: ps && ps.ok && ps.state && ps.state.economy ? ps.state.economy.gems : null,
    // 0 while any combat is active — the runner's watchdog watches this number.
    regenHp: pv && pv.regeneration ? pv.regeneration.hp : null,
    regenMana: pv && pv.regeneration ? pv.regeneration.mana : null,
    restingBuilding: (pv && pv.resting_building) || null,
    skillPoints: points,
    ranks,
    skill: known && skillMeta ? { key: known, ...skillMeta } : null
  };
}

function readSkillMeta(html, key) {
  const re = new RegExp(`<button[^>]*data-skill-key="${key}"([^>]*)>`, 'i');
  const m = re.exec(html);
  if (!m) return { power: 1.25, mana: 7, cd: 2, burnRatio: 0.26 };
  const attr = (name) => {
    const a = new RegExp(`data-skill-${name}="([^"]*)"`).exec(m[1]);
    return a ? a[1] : null;
  };
  const powerText = attr('power');
  const desc = attr('description') || '';
  const burn = /Quemadura: ([\d.]+)%/.exec(desc);
  return {
    power: powerText ? Number(powerText) / 100 : 1.25,
    mana: Number(attr('mana') || 7),
    cd: Number(attr('cooldown') || 2),
    burnRatio: burn ? Number(burn[1]) / 100 : 0.26
  };
}

/** Best fightable target ranked by EXP gained per HP spent (HP is the scarce resource). */
function rankTargets(hero, enemies = ENCOUNTERS) {
  const rows = [];
  // The two daily budgets that bound farmable gold. Stamina regenerates 10/hour
  // (measured); HP regenerates 1.5%/min outside the hospital, the conservative
  // rate (hospital rest is 2%/min).
  const STAMINA_PER_DAY = 240;
  const hpPerDay = hero.maxHp * 0.015 * 60 * 24;
  for (const enemy of Object.values(enemies)) {
    const sim = simulateFight({
      enemy,
      me: {
        atkDmg: hero.atkDmg,
        armor: hero.armor,
        // Combat always starts from the hero's full pool: judging a fight by the
        // current (regenerating) HP would call every target a loss.
        hp: hero.maxHp,
        mana: hero.maxMana,
        skillPower: hero.skill ? hero.skill.power : 0,
        burnRatio: hero.skill ? hero.skill.burnRatio : 0,
        skillMana: hero.skill ? hero.skill.mana : 0,
        skillCd: hero.skill ? hero.skill.cd : 0,
        levelGap: enemy.level - hero.level,
        dangerGap: 5,
        dangerMultiplier: 2
      }
    });
    rows.push({
      ...enemy,
      ...sim,
      // Can the bot actually start this fight now, with the HP it has at this moment?
      affordable: sim.win && sim.hpCost + (hero.hpBuffer || 0) <= hero.hp,
      expPerHp: sim.win ? +(enemy.exp / Math.max(1, sim.hpCost)).toFixed(3) : 0,
      goldPerHp: sim.win ? +(enemy.gold / Math.max(1, sim.hpCost)).toFixed(4) : 0,
      expPerStamina: sim.win ? +(enemy.exp / Math.max(1, enemy.stamina)).toFixed(2) : 0,
      // Daily gold is bounded by whichever runs out first: the 240 stamina the
      // hero regenerates per day, or the HP it regenerates per day. Ranking by
      // EXP per HP optimised the resource that is NOT scarce; this ranks by the
      // yield that actually caps the day.
      goldPerStamina: sim.win ? +(enemy.gold / Math.max(1, enemy.stamina)).toFixed(3) : 0,
      goldPerDay: sim.win
        ? +(
            Math.min(
              STAMINA_PER_DAY / Math.max(1, enemy.stamina),
              hpPerDay / Math.max(1, sim.hpCost)
            ) * enemy.gold
          ).toFixed(1)
        : 0
    });
  }
  rows.sort((a, b) => {
    if (a.win !== b.win) return a.win ? -1 : 1;
    return b.goldPerDay - a.goldPerDay || b.goldPerHp - a.goldPerHp;
  });
  return rows;
}

/** Fresh CSRF for the combat API, read from the combat page itself. */
async function combatCsrf(g, query = '') {
  const page = await g.fetchPage(`/pages/combat_pve.php${query}`);
  if (!page.ok) throw new Error(`combat page HTTP ${page.status}`);
  const m = /data-combat-pve[\s\S]{0,1500}?data-csrf="([0-9a-f]{64})"/.exec(page.html);
  if (!m) throw new Error('no combat csrf on page');
  const active = /data-combat-id="(\d+)"/.exec(page.html);
  return { csrf: m[1], activeCombatId: active ? Number(active[1]) : 0 };
}

/**
 * Abandon a combat server-side.
 *
 * SAFETY-CRITICAL: a combat left in status "active" pauses HP **and** mana
 * regeneration completely. Measured live: with combat 45772 stuck active,
 * player_state reported vitals.regeneration.hp = 0 and passive_label "0%/min",
 * while stamina kept regenerating at 10/h. Abandoning flipped it back to 4.74
 * (1.5%/min) within the same second. Abandoning is free: "Conservarás tu vida
 * y maná actuales".
 */
async function abandonCombat(g, combatId, csrf) {
  if (!combatId) return { ok: false, reason: 'no combat id' };
  const res = await g.evalInPage(`(async () => {
    const r = await fetch(${JSON.stringify(COMBAT_API)}, { method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-CSRF-Token':${JSON.stringify(csrf)}},
      body: JSON.stringify({operation:'recover_abandon', combat_id:${combatId}, csrf:${JSON.stringify(csrf)}}) });
    return { status: r.status, body: await r.json().catch(() => null) };
  })()`, 60000);
  return { ok: res.status === 200, status: res.status, body: res.body };
}

/**
 * Run one fight to completion.
 * @param {object} opts {locationId, enemyId, hpBuffer, practice:{hp,dmg,armor}, maxActions}
 */
async function fight(g, opts) {
  const { locationId, enemyId, allowMutate } = opts;
  if (!allowMutate) throw new Error('MUTATION_BLOCKED: fight needs allowMutate');

  const practice = opts.practice || { hp: 10000, damage: 0, armor: 0 };
  const query =
    `?location_id=${locationId}&world_enemy_id=${enemyId}` +
    `&practice_hp=${practice.hp}&practice_damage=${practice.damage}&practice_armor=${practice.armor}`;

  const { csrf, activeCombatId } = await combatCsrf(g, query);

  // Abandon a stale active combat so the server does not reject the new one.
  if (activeCombatId) {
    await g.evalInPage(`(async () => {
      await fetch(${JSON.stringify(COMBAT_API)}, { method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-CSRF-Token':${JSON.stringify(csrf)}},
        body: JSON.stringify({operation:'recover_abandon', combat_id:${activeCombatId}, csrf:${JSON.stringify(csrf)}}) });
      return true;
    })()`);
  }

  const hero = await readHero(g);
  const skillKey = hero.skill ? hero.skill.key : null;
  const before = await g.apiGet('/api/player_state.php');
  const hpBefore = before.state.hero.vitals.current.hp;
  const expBefore = before.state.hero.hero_exp;
  const goldBefore = before.state.economy.gold;

  const result = await g.evalInPage(`(async () => {
    const url = ${JSON.stringify(COMBAT_API)};
    const csrf = ${JSON.stringify(csrf)};
    const uuid = () => { const b = new Uint8Array(16); crypto.getRandomValues(b);
      b[6]=(b[6]&15)|64; b[8]=(b[8]&63)|128;
      return [...b].map((v,i)=>((i==4||i==6||i==8||i==10)?'-':'')+v.toString(16).padStart(2,'0')).join(''); };
    const post = async (p) => { const r = await fetch(url, { method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body: JSON.stringify(p) });
      return await r.json().catch(() => ({ ok:false, message:'bad json' })); };

    const c = await post({ operation:'create_from_world',
      location_id: ${locationId}, world_enemy_id: ${enemyId},
      practice_hp: ${practice.hp}, practice_damage: ${practice.damage}, practice_armor: ${practice.armor},
      request_id: uuid(), csrf });
    if (!c.ok) return { error: c.message || 'create failed', errorType: c.error_type || null };
    const cid = c.data.state.battle.combat_id;

    const skillKey = ${JSON.stringify(skillKey)};
    let status = c.data.state.battle.status;
    const log = [];
    let last = c.data.state;
    for (let i = 0; i < ${opts.maxActions || 40} && status === 'active'; i++) {
      const j = skillKey
        ? await post({ operation:'skill', skill_key: skillKey, repeat_count: 1, combat_id: cid, request_id: uuid(), csrf })
        : await post({ operation:'attack', combat_id: cid, request_id: uuid(), csrf });
      let out = j;
      // Skill on cooldown or out of mana -> fall back to the basic attack.
      if (!j.ok && skillKey) {
        out = await post({ operation:'attack', combat_id: cid, request_id: uuid(), csrf });
      }
      if (!out.ok) { log.push({ i, err: out.message || 'action failed' }); break; }
      const st = out.data.state;
      last = st;
      status = st.battle.status;
      const me = (st.actors || []).find((a) => a.side === 'player') || {};
      const en = (st.actors || []).find((a) => a.side === 'enemy') || {};
      log.push({ i, myHp: me.hp_current, myMp: me.mp_current, enemyHp: en.hp_current, status });
    }

    return {
      combatId: cid,
      status,
      endReason: last.battle ? last.battle.end_reason : null,
      rounds: log.length,
      log,
      meta: last.meta || null,
      stamina: last.meta && last.meta.stamina ? last.meta.stamina.current : null
    };
  })()`, 120000);

  if (result.error) {
    // Even a rejected/aborted action can leave the combat open (that is what froze
    // regeneration). Clean it up before reporting the failure.
    await abandonCombat(g, result.combatId, csrf).catch(() => {});
    return { ok: false, error: result.error, errorType: result.errorType };
  }

  // A combat that did not reach 'finished' keeps the hero "en combate" and stops
  // HP/mana regeneration for as long as it lives. Never leave one behind.
  if (result.status !== 'finished') {
    await abandonCombat(g, result.combatId, csrf).catch(() => {});
  }

  const after = await g.apiGet('/api/player_state.php');
  const st = after.state;
  return {
    ok: true,
    won: result.status === 'finished' && result.endReason === 'hp_zero' && result.log.length > 0 &&
      (result.log[result.log.length - 1].myHp || 0) > 0,
    status: result.status,
    endReason: result.endReason,
    rounds: result.rounds,
    combatId: result.combatId,
    hpBefore,
    hpAfter: st.hero.vitals.current.hp,
    hpCost: hpBefore - st.hero.vitals.current.hp,
    expGain: st.hero.hero_exp - expBefore,
    goldGain: st.economy.gold - goldBefore,
    level: st.hero.hero_level,
    stamina: st.hero.vitals.current.stamina,
    log: result.log
  };
}

/**
 * Calibration: fight the practice dummy with damage 0 and the target's armor.
 * Costs no stamina and no HP (dummy deals 0), and reveals real damage numbers.
 */
async function calibrate(g, opts = {}) {
  const enemy = opts.enemy || { def: 0 };
  const res = await fight(g, {
    locationId: PRACTICE.locationId,
    enemyId: PRACTICE.enemyId,
    allowMutate: opts.allowMutate,
    practice: { hp: 10000, damage: 0, armor: enemy.def },
    maxActions: opts.maxActions || 6
  });
  return res;
}

module.exports = {
  COMBAT_API,
  ENCOUNTERS,
  PRACTICE,
  SKILL_PRIORITY,
  HOST,
  uuid,
  simulateFight,
  readHero,
  rankTargets,
  combatCsrf,
  abandonCombat,
  fight,
  calibrate
};
