/**
 * Autonomous runner for Defiende el Trono — v2 (plays the game).
 *
 * Loop, in priority order:
 *   1. keep the session alive (idle timeout is 180 s of untrusted input)
 *   2. claim everything that is free (daily login, production, activity milestones)
 *   3. spend points the game has granted (attributes, skill ranks)
 *   4. fight the best EXP-per-HP target the hero can actually beat
 *   5. when HP is too low to fight, rest at the hospital and wait
 *
 * Hard safety rules:
 *   - never start a fight the predictor says is a loss (HP is the scarce resource)
 *   - never spend gold, gems, diamonds or Dotiria
 *
 * Usage:
 *   node scripts/trono/runner.js --dry
 *   node scripts/trono/runner.js --live
 *   node scripts/trono/runner.js --live --loop=120
 *   node scripts/trono/runner.js --live --fights=3    # cap fights per tick
 */
const fs = require('fs');
const path = require('path');
const { Game, sleep, DEFAULT_PORT: CDP_PORT } = require('./lib/game');
const { readHero, rankTargets, fight, combatCsrf, abandonCombat, ENCOUNTERS } = require('./lib/combat');
const dailies = require('./lib/dailies');
const talents = require('./lib/talents');
const craft = require('./lib/craft');
const chests = require('./lib/chests');
const security = require('./lib/security');
const quiet = require('./lib/quiet');
const control = require('./lib/control');
const session = require('./lib/session');
const { GameHttp } = require('./lib/httptransport');

const args = process.argv.slice(2);
// The Agent Hub executes [runtime, script] with no arguments, so the live flag
// and the loop interval can also arrive as environment variables.
const LIVE = args.includes('--live') || process.env.TRONO_LIVE === '1';

/**
 * How the Hub asked for this agent to be launched.
 *
 *   browser : the tab owns the session and the loop (original behaviour)
 *   hybrid  : the tab logs in, the loop runs over HTTP, the tab is closed
 *   http    : HTTP only, from state/session.json; never opens a browser
 *
 * Default is browser: a missing variable must never change how production runs.
 */
const MODE = String(process.env.AGENT_LAUNCH_MODE || process.env.TRONO_MODE || 'browser').toLowerCase();
if (!['browser', 'hybrid', 'http'].includes(MODE)) {
  console.error(`unknown launch mode "${MODE}" — expected browser | hybrid | http`);
  process.exit(2);
}
const loopArg = args.find((a) => a.startsWith('--loop='));
const loopSeconds = loopArg
  ? parseInt(loopArg.split('=')[1], 10)
  : parseInt(process.env.TRONO_LOOP || '0', 10) || 0;

/**
 * Presupuesto de tiempo del proceso, en minutos. 0 = sin limite (systemd).
 *
 * Existe porque un runner efimero (GitHub Actions) mata el job a las 6 h sin
 * avisar, y un SIGKILL a mitad de pelea deja el lock tomado y el estado a
 * medias. Con esto el agente sale solo un rato antes, por el camino normal:
 * el `finally` libera el lock y escribe el ticker `stopped`.
 *
 * Se comprueba en la cabecera del loop, nunca a mitad de un tick, para no
 * cortar una pelea ya enviada.
 */
const maxMinArg = args.find((a) => a.startsWith('--max-minutes='));
const MAX_MINUTES = Math.max(
  0,
  maxMinArg
    ? parseInt(maxMinArg.split('=')[1], 10) || 0
    : parseInt(process.env.TRONO_MAX_MINUTES || '0', 10) || 0,
);
const DEADLINE = MAX_MINUTES > 0 ? Date.now() + MAX_MINUTES * 60000 : Infinity;

/** Milisegundos que quedan de presupuesto. Infinity si no hay limite. */
function remainingMs() {
  return DEADLINE === Infinity ? Infinity : Math.max(0, DEADLINE - Date.now());
}

/**
 * Potion crafting spends gold, and gold is human territory.
 *
 * The cap is an explicit environment variable that defaults to 0, which keeps the whole
 * module off: the agent reads the smithy, works out what the dailies would cost, and
 * posts nothing. Turning it on is a one-line, human-made decision.
 */
const CRAFT_MAX_GOLD = Math.max(0, parseInt(process.env.TRONO_CRAFT_MAX_GOLD || '0', 10) || 0);

/**
 * How many encounter chests to open per tick.
 *
 * Chests are free to open and they are the only source of the crafting materials, so the
 * ceiling is not a safety gate on spending — it is a pace control. The inventory was
 * carrying 38 of them on 2026-11-17; the controller's own batch size is 20, so one batch
 * per tick clears the backlog in two ticks without a 38-request burst.
 */
const CHESTS_PER_TICK = Math.max(0, parseInt(process.env.TRONO_CHESTS_PER_TICK || '20', 10) || 0);

/** Last craft skip reason, so a stable shortage is logged once instead of every tick. */
let lastCraftReason = null;

/** Last chest skip reason, same idea. */
let lastChestReason = null;

// How long to wait when the game says it is in maintenance. Waiting IS the
// correct response: nothing here is a detection, and reopening a browser or
// logging in again during a maintenance window is exactly the pointless,
// repeated-authentication pattern the breaker exists to avoid. The wait doubles
// up to half an hour, because the real windows have lasted hours (2026-11-15:
// ~19 h): a fixed 5-minute poll would mean ~230 requests for nothing.
const MAINTENANCE_WAIT_MS = 5 * 60 * 1000;
const MAINTENANCE_WAIT_MAX_MS = 30 * 60 * 1000;

// Verified in the economy page: 10,000 gold buys 1 DOTIRIA and 1 DOTIRIA pays 1
// USDT (`data-unit="10000" data-reward="1"`). The first withdrawal allows 10-15
// USDT with no prior deposit, so 100,000 gold is the shortest path to a payout.
const WITHDRAW_GOLD = 100000;
const fightsArg = args.find((a) => a.startsWith('--fights='));
const maxFights = fightsArg ? parseInt(fightsArg.split('=')[1], 10) : 2;

// El control server ya respeta TRONO_LOG_FILE; el runner no, y eso rompe el
// despliegue en la nube: el proceso escribe en una ruta y el Hub lee otra, asi
// que el panel se queda en blanco aunque el agente este trabajando.
const LOG_DIR = process.env.TRONO_LOG_DIR || path.join(__dirname, 'logs');
const LOG = process.env.TRONO_LOG_FILE || path.join(LOG_DIR, 'runner.log');

function log(msg, data) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const line = `[${new Date().toISOString()}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, LOG + '.1');
    fs.appendFileSync(LOG, line + '\n', 'utf8');
  } catch (e) {}
}

function randomId() {
  // /api/daily_rewards.php validates request_id as a UUID v4, matching
  // crypto.randomUUID() in /assets/js/daily-rewards.js?v=5. A hand-rolled hex id
  // is rejected with 409 "Solicitud inválida." before any reward is granted.
  // /api/daily_production.php takes no request_id at all.
  return require('crypto').randomUUID();
}

/** Daily login reward: POST /api/daily_rewards.php {action:'claim', request_id} */
async function claimDailyLogin(g) {
  const cfg = await g.apiGet('/api/daily_rewards.php');
  if (!cfg || !cfg.ok) return { done: false, reason: 'daily_rewards unreadable' };
  if (!cfg.data || !cfg.data.available) {
    return { done: false, reason: `not available yet (${cfg.data ? cfg.data.remaining_seconds : '?'}s)` };
  }
  // The claim endpoint issues its own CSRF inside the GET payload (data.csrf);
  // the site client echoes exactly that token. A token scraped from
  // /pages/quests_main.php is rejected with "CSRF inválido".
  const csrf = cfg.data.csrf;
  if (!csrf) return { done: false, reason: 'daily_rewards gave no csrf' };
  const res = await g.apiPost('/api/daily_rewards.php', { action: 'claim', request_id: randomId() }, {
    allowMutate: LIVE,
    csrf
  });
  return { done: !!(res && res.ok), reason: (res && (res.message || 'claimed')) || 'no response' };
}

/** Kingdom production claim. The site embeds this endpoint's CSRF only in the
 *  overview production card, not on /pages/economy.php. */
async function claimProduction(g) {
  const dp = await g.apiGet('/api/daily_production.php');
  if (!dp || !dp.ok) return { done: false, reason: 'production unreadable' };
  if (!dp.data || !dp.data.claim_available) {
    return { done: false, reason: `nothing to claim (${dp.data ? dp.data.seconds_to_next : '?'}s)` };
  }
  try {
    // csrfFor('/pages/economy.php') returned the first csrf on that page, which
    // belongs to building_notices.php: economy.html never mentions this
    // endpoint. The overview card carries the token that matches it.
    const page = await g.fetchPage('/pages/overview.php');
    if (!page.ok) return { done: false, reason: `overview HTTP ${page.status}` };
    const m = /data-production-card[^>]*data-api="\/api\/daily_production\.php"[^>]*data-csrf="([0-9a-f]{64})"/i.exec(
      page.html
    );
    if (!m) return { done: false, reason: 'no production csrf on overview' };
    // The site controller posts {action:'claim'} and no request_id here.
    const res = await g.apiPost('/api/daily_production.php', { action: 'claim' }, {
      allowMutate: LIVE,
      csrf: m[1]
    });
    return { done: !!(res && res.ok), reason: (res && (res.message || 'claimed')) || 'no response' };
  } catch (e) {
    return { done: false, reason: e.message };
  }
}

/** Activity milestones are claimed through the quests page form (16-hex csrf). */
async function claimActivity(g, milestones) {
  const page = await g.fetchPage('/pages/quests_main.php');
  if (!page.ok) return { done: false, reason: `quests page HTTP ${page.status}` };
  const csrf16 = /name="csrf" value="([0-9a-f]{16,})"/i.exec(page.html);
  if (!csrf16) return { done: false, reason: 'no 16-hex csrf on quests page' };

  const claimed = [];
  for (const m of milestones) {
    const res = await g.postForm(
      '/pages/quests_main.php',
      { csrf: csrf16[1], quest_action: 'claim_activity', milestone: String(m) },
      { allowMutate: LIVE }
    );
    claimed.push({ milestone: m, status: res && res.status });
  }
  return { done: claimed.length > 0, reason: `milestones ${milestones.join(',')}`, claimed };
}

async function activityProgress(g) {
  const page = await g.fetchPage('/pages/quests_main.php');
  const m = page.text.match(/ACTIVIDAD DIARIA\s*(\d+)\s*\/\s*(\d+)/i) || page.html.match(/(\d+)\s*\/\s*100/);
  if (!m) return null;
  return { current: parseInt(m[1], 10), max: parseInt(m[2] || '100', 10) };
}

/**
 * Spend attribute points where they buy the most gold per day.
 *
 * lib/attributes.js owns the choice: it scores each attribute by the gold/day it
 * adds under whichever budget binds first, using the HP cost the bot has actually
 * been paying. Every spend is also a measurement — the response carries the new
 * derived snapshot, so the coefficient the UI documents is checked against what
 * the server did and corrected when it differs.
 */
async function spendAttributePoints(g, hero, targets) {
  const available = await g.apiGet('/api/hero_attributes.php');
  let points = (available && available.data && available.data.points_available) || 0;
  if (points <= 0) return { done: false, reason: 'no points' };

  const model = attributes.load();
  const data = (available && available.data) || {};

  // The game publishes its own coefficients. Trust them over anything we inferred.
  if (attributes.learnFormulas(data.formulas, model)) {
    log(`attribute formulas adopted from the API (${Object.keys(data.formulas || {}).length} attributes)`);
  }
  const primary = (data.profile && data.profile.primary) || null;

  const applied = [];
  // `derived` is what the POST actually recomputes; `overview` never existed.
  let snapshot = data.derived || null;

  // Decide ONCE, with the whole budget, then commit it.
  //
  // Re-choosing before every single point looks safer and is actually wrong.
  // `simulateFight` rounds damage to whole numbers, so the marginal value of
  // point 27 is invisible until the points are already there: spending 1 point,
  // re-scoring, spending 1 point again splits the budget across attributes that
  // each individually look worthless. That is how 27 points ended up in
  // `strength` on 2026-11-18. The decision is irreversible, so it is taken once,
  // on the full amount, and executed.
  const ranked = attributes.choose(hero, model, points, primary);
  const pick = ranked[0];
  if (!pick) return { done: false, reason: 'no rankable attribute', applied };

  // Never spend where nothing is priced. `gain` is gold/day unlocked and
  // `simSaves` is HP saved per fight; a point that does neither is a point we
  // cannot justify, and it is irreversible.
  if (pick.gain <= 0 && pick.simSaves <= 0 && !pick.primary) {
    return {
      done: false,
      reason: `holding ${points} point(s): nothing priced today (best ${pick.attr} gain=${pick.gain} saves=${pick.simSaves})`,
      applied
    };
  }

  const chosen = pick.attr;
  const why = pick.gain > 0
    ? `+${pick.gain}g/d`
    : pick.primary
      ? 'primary'
      : `-${pick.simSaves}hp/fight`;
  log(
    `attributes: ${points} point(s) -> ${chosen} (${why}; rounds ${pick.base.rounds || '?'} -> ${pick.rounds || '?'}, ` +
    `rank: ${ranked.slice(0, 3).map((r) => `${r.attr}=${r.gain}`).join(' ')})`
  );

  for (let i = 0; i < points; i += 1) {
    const page = await g.fetchPage('/pages/overview.php');
    const m = /data-api="\/api\/hero_attributes.php" data-csrf="([0-9a-f]{64})"/.exec(page.html) ||
      /data-overview-attributes[\s\S]{0,400}?data-csrf="([0-9a-f]{64})"/.exec(page.html);
    if (!m) return { done: applied.length > 0, reason: 'no attribute csrf', applied };

    const res = await g.apiPost('/api/hero_attributes.php', { attribute: chosen }, {
      allowMutate: LIVE,
      csrf: m[1]
    });
    if (!res || !res.ok) return { done: applied.length > 0, reason: (res && res.message) || 'post failed', applied };

    // Measure against `derived`, the block the server actually recomputes.
    const measured = attributes.verifyDerived(chosen, snapshot, res.data && res.data.derived, model);
    if (measured) log(`attribute observed: ${chosen} -> ${JSON.stringify(measured)}`);
    if (res.data && res.data.derived) snapshot = res.data.derived;

    applied.push(chosen);

    const left = res.data && res.data.points_available;
    if (left !== undefined && Number(left) <= 0) break;

    // Re-read so the logged hero and the next POST build on what the server
    // really holds, not on what this loop expected.
    if (i === 0 || i === points - 1) hero = await readHero(g);
    attributes.save(model);
  }
  attributes.save(model);

  const tally = applied.reduce((acc, a) => ({ ...acc, [a]: (acc[a] || 0) + 1 }), {});
  return {
    done: applied.length > 0,
    reason: `applied ${Object.entries(tally).map(([k, n]) => `${k}x${n}`).join(', ')} — ${why}`,
    applied
  };
}

/**
 * Skill points: upgrade whichever learned skill buys the most gold per day.
 *
 * Every card publishes its current and next power (`data-skill-power`,
 * `data-skill-next-power`), so one level's effect is known before paying for it.
 * The projected level goes through the same simulation and the same gold-per-day
 * rule as attribute points, instead of always upgrading whatever came first.
 *
 * Only skills already at level 1 or above are considered. The simulation has no
 * model for stun, shields or healing, so unlocking an untrained skill would be
 * scored on its damage percentage alone and that score would be misleading.
 */
async function spendSkillPoints(g, hero) {
  if (!hero.skillPoints) return { done: false, reason: 'no skill points' };
  const page = await g.fetchPage('/pages/skills.php');
  const csrfM = /data-skills-page[\s\S]{0,300}?data-csrf="([0-9a-f]+)"/.exec(page.html);
  if (!csrfM) return { done: false, reason: 'no skills csrf' };

  const cards = [];
  for (const block of page.html.split('data-skill-card').slice(1)) {
    const attr = (n) => {
      const m = new RegExp(`data-skill-${n}="([^"]*)"`).exec(block);
      return m ? m[1] : null;
    };
    const key = attr('key');
    if (!key) continue;
    const level = Number(attr('level') || 0);
    const max = Number(attr('max-level') || 10);
    if (level < 1 || level >= max) continue;
    const power = Number(attr('power') || 0) / 100;
    const next = Number(attr('next-power') || 0) / 100;
    if (!(next > power)) continue;
    const burn = /Quemadura: ([\d.]+)%/.exec(attr('description') || '');
    cards.push({
      key,
      level,
      next,
      mana: Number(attr('mana') || 0),
      cd: Number(attr('cooldown') || 2),
      burnRatio: burn ? Number(burn[1]) / 100 : 0
    });
  }
  if (!cards.length) return { done: false, reason: 'nothing upgradable' };

  const ranked = cards
    .map((c) => {
      const probe = {
        ...hero,
        skill: { key: c.key, power: c.next, mana: c.mana, cd: c.cd, burnRatio: c.burnRatio }
      };
      const best = learning.apply(rankTargets(probe), probe).find((r) => r.win && !r.coolingDown);
      return { ...c, goldPerDay: best ? best.goldPerDay : 0 };
    })
    .sort((a, b) => b.goldPerDay - a.goldPerDay || b.next - a.next);

  const pick = ranked[0];
  const res = await g.apiPost('/api/hero_skill_upgrade.php', { skill_key: pick.key }, {
    allowMutate: LIVE,
    csrf: csrfM[1]
  });
  if (!res || !res.ok) return { done: false, reason: (res && res.message) || 'failed' };
  return {
    done: true,
    reason: `${pick.key} lv${pick.level}->${pick.level + 1} (${pick.goldPerDay}g/d)`
  };
}

/** Rest at the hospital for the +0.5%/min HP bonus while waiting. */
async function restAtHospital(g) {
  if (!LIVE) return { done: false, reason: 'dry run' };
  // Re-posting "rest" every tick resets the recovery timer and silently cancels the
  // whole bonus, so only start resting when the hero is not already resting.
  const ps = await g.apiGet('/api/player_state.php');
  const resting = ps && ps.ok && ps.state.hero.vitals.resting_building;
  if (resting === 'hospital') return { done: false, reason: 'already resting' };

  const page = await g.fetchPage('/pages/buildings.php?view=hospital');
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page.html);
  if (!csrf) return { done: false, reason: 'no hospital csrf' };
  const res = await g.postForm(
    '/pages/buildings.php?view=hospital',
    { building_key: 'hospital', csrf: csrf[1], action: 'rest' },
    { allowMutate: LIVE }
  );
  return { done: (res && res.status) === 200, reason: 'resting at hospital' };
}

/**
 * Daily quests, part 1: accept what the agent can actually finish.
 *
 * Progress is only counted after an offer is accepted, so this has to run BEFORE the
 * steps that make progress (chests, crafting) or every tick spends its work on an
 * objective that is not listening.
 *
 * `Fabrica` used to be skipped here because there was no crafting module; `lib/craft.js`
 * now covers potions, so the offer is taken. `Gasta|Mejora|Compra` stay: those spend gold
 * on things a human has to authorise.
 */
async function acceptDailies(g) {
  const accepted = [];
  try {
    const o = await dailies.offers(g);
    const SKIP = /Gasta|Mejora|Compra/i;
    const wanted = o.list.filter((x) => !SKIP.test(x.text));
    if (LIVE) {
      for (const offer of wanted) {
        const res = await dailies.accept(g, offer.instanceId, o.csrf, { allowMutate: true });
        accepted.push({ id: offer.instanceId, title: offer.title, status: res && res.status });
        await sleep(400);
      }
    }
  } catch (e) {
    log(`dailies accept failed: ${e.message}`);
  }
  if (accepted.length) log(`dailies accepted: ${accepted.map((a) => a.title || a.id).join(', ')}`);
  return accepted;
}

/** Daily quests, part 2: claim whatever is ready. Runs after the work, not before it. */
async function claimDailies(g) {
  let claimed = [];
  try {
    const r = await dailies.claimAll(g, { allowMutate: LIVE });
    claimed = r.claimed || [];
  } catch (e) {
    log(`dailies claim failed: ${e.message}`);
  }
  if (claimed.length) log(`dailies claimed: ${JSON.stringify(claimed)}`);
  return claimed;
}

/**
 * Regeneration watchdog.
 *
 * A combat left in status "active" blocks ALL HP and mana regeneration (measured:
 * regeneration.hp = 0, "0%/min"). Fight loops die mid-way whenever a fetch drops,
 * which leaves exactly that state behind and silently freezes the hero forever.
 * The check triggers on the symptom, so it costs nothing in the normal case:
 * zero regen while vitals are below max => look for an open combat and abandon it.
 */
async function ensureOutOfCombat(g, hero) {
  if (hero.regenHp === null || hero.regenHp === undefined) return { cleared: false, reason: 'regen unknown' };
  if (hero.regenHp > 0) return { cleared: false, reason: 'regen ok' };
  if (hero.hp >= hero.maxHp && hero.mana >= hero.maxMana) return { cleared: false, reason: 'full vitals' };

  const { csrf, activeCombatId } = await combatCsrf(g);
  if (!activeCombatId) return { cleared: false, reason: 'regen 0 with no open combat — investigate' };

  const res = await abandonCombat(g, activeCombatId, csrf);
  log(`WATCHDOG: abandoned stuck combat ${activeCombatId} (regen was 0%/min) — ${res.ok ? 'ok' : 'failed'}`);
  return { cleared: !!res.ok, combatId: activeCombatId };
}

async function tick(g, state) {
  const snap = await g.state();
  let hero = await readHero(g);
  const cleared = await ensureOutOfCombat(g, hero);
  if (cleared.cleared) hero = await readHero(g);
  let targets = rankTargets(hero);

  log('state', {
    lv: hero.level,
    exp: `${snap.hero.exp}/${snap.hero.expToNext}`,
    hp: `${hero.hp}/${hero.maxHp}`,
    mana: `${hero.mana}/${hero.maxMana}`,
    regenHp: hero.regenHp,
    sta: hero.stamina,
    // The wallet, not the production rate. `gold` used to log
    // snap.production.perDay, which is 164.5 every tick and says nothing about
    // progress toward a payout.
    gold: hero.gold,
    dotirian: hero.dotirian,
    prodPerDay: snap.production ? snap.production.perDay : undefined,
    points: snap.attributes.available,
    skillPoints: hero.skillPoints
  });
  if (hero.gold !== null && hero.gold !== undefined) {
    const pct = ((hero.gold / WITHDRAW_GOLD) * 100).toFixed(1);
    log(`wallet: ${hero.gold} gold (${pct}% of ${WITHDRAW_GOLD})  ${hero.dotirian ?? '?'} DOTIRIA`);
  }

  // 2. free claims
  try {
    const daily = await claimDailyLogin(g);
    log(`daily_login: ${daily.done ? 'CLAIMED' : 'skip'} — ${daily.reason}`);
  } catch (e) {
    log(`daily_login failed: ${e.message}`);
  }
  try {
    const prod = await claimProduction(g);
    log(`production: ${prod.done ? 'CLAIMED' : 'skip'} — ${prod.reason}`);
  } catch (e) {
    log(`production failed: ${e.message}`);
  }

  // Wrapped like every other mutation section: a rejected milestone claim used to
  // throw straight out of tick() and abort chests, crafting, dailies and fights.
  // One cosmetic claim must never cost a whole tick of gold.
  try {
    const act = await activityProgress(g);
    if (act) {
      const reachable = [20, 40, 60, 80, 100].filter((m) => act.current >= m);
      if (reachable.length) {
        const res = await claimActivity(g, reachable);
        log(`activity: ${res.done ? 'CLAIMED' : 'skip'} — ${res.reason}`);
      } else {
        log(`activity: skip — ${act.current}/${act.max}`);
      }
    }
  } catch (e) {
    log(`activity failed: ${e.message}`);
  }

  // 2b. daily quests: accept first. Progress only counts after accepting, so the two
  //     steps below (chests, crafting) would move nothing if this ran after them.
  await acceptDailies(g);

  // 2c. the encounter chests. They are the only source of the crafting materials, and
  //     two dailies of their own: "Abre 5 cofres de botín" and "Reúne 10 materiales".
  try {
    const out = await chests.openAll(g, { maxPerTick: CHESTS_PER_TICK, allowMutate: LIVE });
    if (out.done) {
      const mats = Object.entries(out.materials || {}).map(([k, v]) => `${k} +${v}`).join(', ');
      const extra = out.gold ? ` (+${out.gold} gold)` : '';
      log(`chests: OK ${out.opened} opened (${out.waiting} left)${mats ? ' -> ' + mats : ''}${extra}`);
      lastChestReason = null;
    } else if (out.dry) {
      log(`chests: dry - would open ${out.planned} of ${out.available}`);
      lastChestReason = out.reason || null;
    } else if (out.reason) {
      // "no chests to open" repeats every tick once the shelf is empty; say it once.
      if (out.reason !== lastChestReason) log(`chests: skip - ${out.reason}`);
      lastChestReason = out.reason;
    }
  } catch (e) {
    log(`chests failed: ${e.message}`);
  }

  // 2d. the potions the dailies ask for, inside the gold cap a human set
  try {
    const made = await craft.craft(g, { maxGold: CRAFT_MAX_GOLD, allowMutate: LIVE });
    if (made.done) {
      const items = made.crafted.map((c) => `${c.quantity} x ${c.name}`).join(', ');
      log(`craft: OK ${items} for ${made.goldSpent} gold (${made.crafted[0].goldBefore} -> ${made.gold})`);
      lastCraftReason = null;
    } else if (made.dry) {
      log(`craft: dry - would make ${made.quantity} x ${made.planned} with ${made.gold} gold on hand`);
      lastCraftReason = made.reason || null;
    } else if (made.reason) {
      // Materials arrive slowly, so the same shortage repeats every tick. Say it once,
      // and again only when the reason changes.
      if (made.reason !== lastCraftReason) log(`craft: skip - ${made.reason}`);
      lastCraftReason = made.reason;
    }
  } catch (e) {
    log(`craft failed: ${e.message}`);
  }

  // 2e. claim whatever the work above just finished
  await claimDailies(g);

  // 3. spend what the game granted
  // Each of these is a separate irreversible action on a different endpoint; a
  // rejection on one must not take the other two down with it.
  try {
    const attr = await spendAttributePoints(g, hero, targets);
    if (attr.done || attr.reason !== 'no points') log(`attributes: ${attr.done ? 'OK' : 'skip'} — ${attr.reason}`);
  } catch (e) {
    log(`attributes failed: ${e.message}`);
  }
  try {
    const skill = await spendSkillPoints(g, hero);
    if (skill.done || skill.reason !== 'no skill points') log(`skills: ${skill.done ? 'OK' : 'skip'} — ${skill.reason}`);
  } catch (e) {
    log(`skills failed: ${e.message}`);
  }

  try {
    const tal = await talents.spendAll(g, { allowMutate: LIVE });
    if (tal.done || (tal.reason && tal.reason !== 'no talent points')) {
      // Sixteen points is sixteen objects: log the tally, not the transcript.
      const tally = {};
      for (const a of tal.applied || []) tally[a.key] = (tally[a.key] || 0) + 1;
      const summary = Object.entries(tally).map(([k, n]) => `${k}x${n}`).join(', ');
      const left = typeof tal.pointsLeft === 'number' ? ` left ${tal.pointsLeft}` : '';
      log(`talents: ${tal.done ? 'OK' : 'skip'} ${tal.done ? `${(tal.applied || []).length} spent (${summary})${left}` : tal.reason}`);
    }
  } catch (e) {
    log(`talents failed: ${e.message}`);
  }

  hero = await readHero(g);
  targets = learning.apply(rankTargets(hero), hero);

  const best = targets.find((t) => t.win && !t.coolingDown);
  if (!best) {
    log('no winnable target with current stats — resting');
    await restAtHospital(g);
    return { rested: true };
  }

  // Which tier deserves the next stamina point. The policy lives in lib/select
  // so it can be tested on a grid of HP/stamina values without the browser.
  const sel = selectPolicy.chooseFight(hero, targets, { maxFights });
  const margin = sel.margin;
  if (sel.action === 'wait') {
    log(sel.reason);
    await restAtHospital(g);
    return { rested: true };
  }
  const plan = sel.plan;
  if (sel.notable) log(sel.reason);

  // 4. fight
  if (!LIVE) {
    log(`dry run: would fight ${plan.map((t) => `${t.name}(lv${t.level}, ${t.hpCost}HP/${t.exp}EXP)`).join(', ')}`);
    return { fought: 0, dry: true };
  }

  let fought = 0;
  for (const target of plan) {
    if (fought >= maxFights) break;
    const freshHero = await readHero(g);
    const fresh = learning.apply(rankTargets(freshHero), freshHero).find((t) => t.key === target.key);
    const now = freshHero;
    // Go/no-go uses the WORST cost observed, not the average.
    //
    // On 2026-11-18 the average for Eryndor was 358.5 and the gate was 362 HP,
    // so it started a second fight and the hero died (gold -269). Twenty minutes
    // later the same thing happened again (-260). `hpCost` is a moving average
    // that still carried cheap kills from when the pool was larger, so comparing
    // it to the live HP was always optimistic. `hpCostWorst` (lib/learning.js)
    // is the highest cost in the recent window, which is the number a gate needs.
    const need = (fresh && fresh.hpCostWorst) + margin;
    if (!fresh || !fresh.win || fresh.coolingDown || need > now.hp) {
      if (fresh && fresh.win && !fresh.coolingDown) {
        log(
          `skip ${target.name}: needs ${Math.round(need)} HP (worst ${Math.round(fresh.hpCostWorst)} + margin ${margin}), has ${now.hp}`
        );
      }
      break;
    }
    if (now.stamina < target.stamina) {
      log(`stamina too low for ${target.name} (${now.stamina}/${target.stamina})`);
      break;
    }

    log(
      `fight ${target.name} (lv${target.level}) — predicted ${target.actions} actions, ${target.hpCost} HP avg / ${Math.round(fresh.hpCostWorst)} worst, ${target.exp} EXP, hp ${now.hp}/${now.maxHp}`
    );
    const res = await fight(g, {
      locationId: target.locationId,
      enemyId: target.enemyId,
      allowMutate: LIVE,
      maxActions: 40
    });
    if (!res.ok) {
      log(`fight aborted — ${res.error}`);
      break;
    }
    log(`result ${res.won ? 'WIN' : 'LOSS'}`, {
      rounds: res.rounds,
      hp: `${res.hpBefore}->${res.hpAfter}`,
      hpCost: res.hpCost,
      exp: res.expGain,
      gold: res.goldGain,
      stamina: res.stamina,
      level: res.level
    });
    learning.record(target.key, { hpCost: res.hpCost, won: !!res.won, level: now.level });
    fought += 1;
    if (!res.won) break;
  }
  learning.save();

  return { fought };
}

const lock = require('./lib/driverlock');
const learning = require('./lib/learning');
const attributes = require('./lib/attributes');
const selectPolicy = require('./lib/select');

/** Login with bounded retries on an open tab. */
async function loginWithRetries(g, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const creds = require('./lib/credentials').load();
    if (!creds) throw new Error('no credentials available');
    const res = await g.login(creds).catch((e) => ({ ok: false, error: e.message }));
    if (res.ok) {
      log(`login ok (attempt ${attempt})`);
      return true;
    }
    log(`login failed (attempt ${attempt}/${attempts}) — ${JSON.stringify(res).slice(0, 200)}`);
    if (attempt < attempts) await sleep(20000 * attempt);
  }
  return false;
}

/**
 * Connect to the browser, tolerating a launcher that is still coming up or a
 * dying instance left behind by a hard kill.
 */
async function connectWithRetry(attempts = 3) {
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await Game.connect({ spawn: true });
    } catch (e) {
      last = e;
      log(`browser connect failed (${i}/${attempts}) — ${e.message}`);
      if (i < attempts) await sleep(8000 * i);
    }
  }
  throw last;
}

/**
 * Why the browser stays open.
 *
 * The browser is the only thing that can authenticate, and the agent never
 * decides on its own to close it. Handing the cookie off to HTTP is a transport
 * change, not a licence to kill a window the user may be watching or using.
 *
 * Consequence, on purpose: the browser lives until the user closes it. To stop
 * that from stacking one browser per restart, the Hub reuses a browser whose CDP
 * port is already up instead of launching another one.
 */
const BROWSER_STAYS_OPEN =
  'browser left open on purpose — it is yours to close; the agent keeps working over HTTP';

/**
 * Get a transport with a live session, honouring MODE.
 *
 * The browser is the only thing that can authenticate, so hybrid opens it even
 * when a saved session exists but fails verification. It is closed again only
 * after `session.verify` proved the exported cookie works from plain Node.
 * That ordering is the whole safety property: no browser dies on a guess.
 */
async function acquire() {
  if (MODE !== 'browser') {
    const saved = session.load();
    if (saved) {
      const v = await session.verify(saved);
      if (v.ok) {
        // The Hub may have opened a browser before this run. Nobody needs it
        // now, but closing it is not ours to decide: the browser belongs to the
        // user. It is reused by the next restart (the Hub skips pre_launch when
        // CDP is already listening), so it cannot pile up either.
        log(
          `http session from disk verified (${v.user} lv${v.level}, gold ${v.gold}, ${session.ageMinutes(saved)}m old) — ${BROWSER_STAYS_OPEN}`
        );
        return { g: new GameHttp(saved), via: 'http-saved' };
      }
      if (v.network) {
        // The cookie may be perfect; the network is not. Let the caller retry
        // with backoff instead of discarding a valid session and opening a
        // browser over a transient blip.
        throw new Error(`network while verifying the saved session (${v.error})`);
      }
      log(`saved http session rejected (${v.error}) — a browser login is needed`);
      session.clear();
    }
    if (MODE === 'http') {
      // Una VM arranca en frio: no hay session.json, y hasta ahora esto tiraba un
      // throw. Pero el login headless existe y funciona sin navegador, que es
      // justamente la razon por la que la nube es posible. Sin esta rama el
      // servicio de systemd entraba en bucle de reinicio para siempre.
      log('mode=http sin sesion guardada — login headless');
      const out = await session.ensure();
      if (!out.ok) {
        const why = out.network ? `red (${out.error})` : out.error || 'login rechazado';
        throw new Error(`login headless fallo en la nube: ${why}`);
      }
      log(`http session ${out.via} (${out.check.user} lv${out.check.level}, gold ${out.check.gold})`);
      return { g: new GameHttp(out.session), via: `http-${out.via}` };
    }
  }

  const g = await connectWithRetry();
  if (!(await g.isLoggedIn())) {
    log('session dead at start, logging in');
    if (!(await loginWithRetries(g))) throw new Error('autonomous login failed after retries');
  }

  if (MODE === 'browser') return { g, via: 'browser' };

  // Hand off to HTTP. Proof before close, always.
  const exported = await session.fromBrowser(g);
  const check = await session.verify(exported);
  if (!check.ok) {
    // Keep the browser open: it is the only way back into the account.
    log(`handoff REFUSED — cookie does not work outside the browser (${check.error}); staying on the browser`);
    return { g, via: 'browser (handoff refused)' };
  }
  session.save(exported, { verified: true, goldAtHandoff: check.gold, hpAtHandoff: check.hp });

  log(`handoff verified over HTTP (gold ${check.gold}, hp ${check.hp}) — ${BROWSER_STAYS_OPEN}`);

  // Re-check with the browser still open. A handoff that only works once is not
  // a handoff, and the browser is the only way back, so we stay on it.
  const after = await session.verify(exported);
  if (!after.ok) {
    log(`handoff unstable (${after.error}) — staying on the browser`);
    return { g, via: 'browser (handoff unstable)' };
  }
  return { g: new GameHttp(exported), via: 'http (browser open)' };
}

/** Rebuild the transport: reconnect, re-login, re-handoff in hybrid. */
async function recover(g) {
  try {
    if (g) g.close();
  } catch (e) {}
  const acquired = await acquire();
  return { g: acquired.g, action: acquired.via };
}

(async () => {
  // A halt survives restarts on purpose: the Hub restarts this process, and a
  // restart must not look like the human approving what was just detected.
  //
  // Excepcion unica y acotada: un halt que escribio el clasificador ANTERIOR al
  // 2026-11-23 para un 5xx con cuerpo vacio. Ese halt vive en el cache de
  // Actions, el job muere en 0s antes de poder limpiarlo, y por lo tanto jamas
  // se libera solo. `supersedeObsoleteHalt` solo lo toca si el codigo actual es
  // incapaz de reproducirlo (ver el predicado en lib/security.js).
  security.supersedeObsoleteHalt();

  const halt = security.readHalt();
  if (halt) {
    log(
      `SECURITY HALT active — refusing to start. ${halt.where} at ${halt.at} :: ${(halt.signals || []).join(', ')}`
    );
    // Si el halt sigue en pie, decir EXACTAMENTE por que el predicado no lo
    // reconocio. Sin esto la proxima corrida muere igual de opaca y hay que
    // adivinar que condicion fallo mirando un log de 0s.
    log(`supersede rejected this halt: ${security.explainObsoleteHalt(halt)}`);
    log(`human must clear: node tools/clear-halt.js --ack="<what you found>"`);
    process.exit(3);
  }

  // Dueño único: si la nube está vivo y se cobijó, este runner es standby: hace
  // ni un login ni un request. El gate va antes de adquirir el lock: acquire()
  // ya es un login. El runner en la nube tiene TRONO_ON_CLOUD=1 y lo salta.
  if (!process.env.TRONO_ON_CLOUD && (await control.cloudOwnerActive())) {
    log(`cloud en ${control.cloudConfig()?.url || 'la nube'}: agente standby local (el cloud es owner) — saliendo sin requests`);
    process.exit(0);
  }

  // Dormancia programada (se acuesta 23:30-00:30, despierta 05:30-06:30 hora
  // Cuba): antes de adquirir lock/login.
  {
    const s0 = quiet.state();
    if (s0.quiet) {
      log(`horario de silencio: sin requests hasta ${quiet.fmtMs(s0.until)} (${quiet.tzLabel()})`);
      await quiet.sleepWhileQuiet(DEADLINE === Infinity ? {} : { deadline: DEADLINE });
      if (remainingMs() <= 0) {
        log(`presupuesto de ${MAX_MINUTES} min agotado durante el silencio — saliendo sin requests`);
        process.exit(0);
      }
    }
  }

  // Pausa humana: tambien antes de acquire(), porque acquire() es un login.
  // Si el Hub reinicia el proceso mientras esta pausado, sin este gate el
  // reinicio emitiria un request que el humano acaba de pedir no emitir.
  // Se re-evalua cada 5 s: leer un archivo local no es un request al juego, y
  // asi un resume desde el Hub surte efecto en segundos, no en un minuto.
  let pauseLogged = false;
  while (control.readControl().paused && !control.readControl().stop) {
    if (!pauseLogged) {
      log('pausado por control (Hub) — esperando sin requests hasta el resume');
      pauseLogged = true;
    }
    control.writeTicker({ tick: 0, at: new Date().toISOString(), mode: MODE, state: 'paused' });
    await sleep(5000);
  }
  if (pauseLogged) log('resume: el control ya no esta pausado');
  if (control.readControl().stop) {
    log('detencion pedida por control (Hub) — saliendo sin tocar el juego');
    process.exit(0);
  }

  const got = lock.acquire('runner');
  if (!got.ok) {
    log(`another driver is active (pid ${got.holder.pid}, ${got.holder.name}) — exiting`);
    log(`lock state: ${lock.describe()}`);
    process.exit(2);
  }
  if (got.stale) log(`took over a stale driver lock (${got.stale})`);

  // Keep the lock fresh and stop driving the tab the moment we lose it. Without
  // this the file ages out after TTL_MS and a second process can take over while
  // this one is still mid-fight, which invalidates both sessions.
  const beat = lock.keepAlive(() => {
    log('driver lock was taken by another process — our session is invalid, stopping');
  });

  const acquired = await acquire();
  let g = acquired.g;
  log(`transport: ${acquired.via} (mode ${MODE})`);
  // Ticker inicial: el Hub necesita saber que el proceso está vivo desde el
  // arranque, no recién después del primer tick (que puede tardar minutos).
  control.writeTicker({ tick: 0, at: new Date().toISOString(), mode: MODE, state: 'starting' });
  try {
    let cfg = await g.idleConfig();
    let ticks = 0;
    let failures = 0;
    let recoverFailures = 0;
    let maintenanceWaits = 0;
    let lastOwnerCheck = 0;
    let pausedLogged = false;

    for (;;) {
      // Presupuesto agotado: salir por el camino normal ANTES de empezar otro
      // tick. Nunca a mitad de uno: cortar una pelea ya enviada deja el estado
      // del juego y el nuestro desincronizados.
      if (remainingMs() <= 0) {
        log(`presupuesto de ${MAX_MINUTES} min agotado — saliendo limpio (tick ${ticks})`);
        break;
      }
      // Si la nube vuelve a estar viva, ceder el mando: dos dueños sobre la
      // misma cuenta se rotan el DTTSESS y los dos quedan en 401. Se consulta
      // cada minuto (tráfico local, cero requests al juego).
      if (!process.env.TRONO_ON_CLOUD && Date.now() - lastOwnerCheck > 60000) {
        lastOwnerCheck = Date.now();
        if (await control.cloudOwnerActive()) {
          log('cloud volvió: este runner se retira (el cloud es owner) — sin más requests');
          break;
        }
      }
      if (quiet.state().quiet) {
        const s = quiet.state();
        const rest = remainingMs();
        if (rest !== Infinity && rest < 60000) {
          log(`horario de silencio, pero quedan ${Math.round(rest / 1000)}s de presupuesto — saliendo limpio`);
          break;
        }
        log(`horario de silencio: sin requests hasta ${quiet.fmtMs(s.until)} (${quiet.tzLabel()}). Dormir...`);
        control.writeTicker({ tick: ticks, at: new Date().toISOString(), mode: MODE, state: 'quiet' });
        // sleepWhileQuiet no conoce el presupuesto: en un job efimero moriria
        // de SIGKILL a mitad del silencio. Se le pasa el deadline.
        await quiet.sleepWhileQuiet(DEADLINE === Infinity ? {} : { deadline: DEADLINE });
        if (remainingMs() <= 0) {
          log(`presupuesto de ${MAX_MINUTES} min agotado durante el silencio — saliendo limpio`);
          break;
        }
        continue;
      }
      if (control.readControl().paused) {
        if (!pausedLogged) {
          log('pausado por control (Hub) — esperando sin requests hasta el resume');
          pausedLogged = true;
        }
        control.writeTicker({ tick: ticks, at: new Date().toISOString(), mode: MODE, state: 'paused' });
        await sleep(5000);
        continue;
      }
      if (pausedLogged) {
        log('resume: el control ya no esta pausado');
        pausedLogged = false;
      }
      if (control.readControl().stop) {
        log('detención pedida por control (Hub) — saliendo sin tocar el juego');
        break;
      }
      try {
        const hb = await g.heartbeat(cfg);
        if (!hb.alive) {
          cfg = await g.idleConfig();
        }
        ticks += 1;
        await tick(g, { tick: ticks });
        control.writeTicker({ tick: ticks, at: new Date().toISOString(), mode: MODE });
        // Helpers deep in the tick catch their own errors and return "skip", so a
        // halt detected there would otherwise be swallowed and the loop would
        // keep poking the site. The file is the source of truth, not the throw.
        if (security.isHalted()) {
          const h = security.readHalt();
          const err = new Error(`SECURITY HALT: ${(h.signals || []).join(', ')} in ${h.where}`);
          err.code = 'SECURITY_HALT';
          throw err;
        }
        failures = 0;
        maintenanceWaits = 0;
      } catch (e) {
        // Never recover from a detection: reconnect and relogin are exactly the
        // repeated requests that turn a challenge into a ban.
        if (e && e.code === 'SECURITY_HALT') {
          log(`SECURITY HALT — stopping the agent. ${e.message}`);
          throw e;
        }
        // A maintenance window is routine. It must not count as a failure (that
        // would trigger recover() on the third one) and it must never look like a
        // detection, so it just waits and tries again.
        if (e && e.code === 'MAINTENANCE') {
          const wait = Math.min(MAINTENANCE_WAIT_MAX_MS, MAINTENANCE_WAIT_MS * 2 ** maintenanceWaits);
          maintenanceWaits += 1;
          log(`maintenance window (#${maintenanceWaits}) — ${e.message}. waiting ${wait / 60000} min`);
          await sleep(wait);
          continue;
        }
        failures += 1;
        log(`tick failed (${failures}) — ${e.message}`);
        // Rebuilding the transport is the heavy, account-risky move: it can reopen
        // a browser and log in again. A retryable error is never worth that -- the
        // transport is intact, the world is not -- so it only counts up, which
        // keeps an outage visible in the log without poking the site with logins.
        const fatal =
          /AUTH|session|unavailable|page error|Inspected target|Failed to fetch|WebSocket|ECONN/i.test(
            `${e.code || ''} ${e.message}`
          );
        const rebuild = !e.retryable && (fatal || failures >= 3);
        if (rebuild) {
          try {
            const r = await recover(g);
            g = r.g;
            cfg = await g.idleConfig();
            failures = 0;
            recoverFailures = 0;
            log(`recovered: ${r.action}`);
          } catch (re) {
            // Never let a failed recovery kill the process — that is exactly what
            // forced a manual login. Back off and let the loop try again.
            recoverFailures += 1;
            log(`recovery failed (${recoverFailures}) — ${re.message}`);
            if (recoverFailures >= 5) throw re;
            await sleep(30000 * recoverFailures);
          }
        }
      }
      if (!loopSeconds) break;
      // Dormir nunca mas alla del presupuesto restante: si quedan 40 s, no
      // tiene sentido dormir 300 y que GitHub mate el job justo al despertar.
      const rest = remainingMs();
      const napMs = Math.min(loopSeconds * 1000, rest === Infinity ? Infinity : rest);
      if (napMs <= 0) {
        log(`presupuesto de ${MAX_MINUTES} min agotado — saliendo limpio (tick ${ticks})`);
        break;
      }
      log(`sleeping ${Math.round(napMs / 1000)}s`);
      await sleep(napMs);
    }
  } finally {
    try {
      beat.stop();
    } catch (e) {}
    try {
      g.close();
    } catch (e) {}
    lock.release();
    // El ticker es liveness: si el proceso muere, el Hub no debe creer que
    // sigue vivo con un PID reciclado.
    try {
      control.writeTicker({ tick: -1, at: new Date().toISOString(), mode: MODE, state: 'stopped' });
    } catch (e) {}
  }
})().catch((e) => {
  if (e && e.code === 'SECURITY_HALT') {
    log(`ERROR SECURITY_HALT ${e.message}`);
    lock.release();
    process.exit(3);
  }
  log(`ERROR ${e.code || ''} ${e.message}`);
  lock.release();
  process.exit(1);
});
