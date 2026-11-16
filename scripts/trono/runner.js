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
const security = require('./lib/security');
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

const LOG_DIR = path.join(__dirname, 'logs');
const LOG = path.join(LOG_DIR, 'runner.log');

function log(msg, data) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
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
  const applied = [];
  let snapshot = (available.data && available.data.overview) || null;

  while (points > 0) {
    const ranked = attributes.choose(hero, model);
    const pick = ranked[0];
    // Every attribute scored zero: no target is winnable at all. Damage is the
    // only thing that changes that and it does so before the simulation can see
    // it, so spend there rather than leaving the point idle.
    // `choose` scores an attribute by the gold/day it unlocks at the next
    // threshold (`gain`), not by a flat rate, so the zero test is on `gain`.
    // Comparing `pick.goldPerDay` (undefined) silently disabled this fallback.
    const fallback = !pick || pick.gain <= 0;
    const chosen = fallback ? 'strength' : pick.attr;

    const page = await g.fetchPage('/pages/overview.php');
    const m = /data-api="\/api\/hero_attributes.php" data-csrf="([0-9a-f]{64})"/.exec(page.html) ||
      /data-overview-attributes[\s\S]{0,400}?data-csrf="([0-9a-f]{64})"/.exec(page.html);
    if (!m) return { done: applied.length > 0, reason: 'no attribute csrf', applied };

    const res = await g.apiPost('/api/hero_attributes.php', { attribute: chosen }, {
      allowMutate: LIVE,
      csrf: m[1]
    });
    if (!res || !res.ok) return { done: applied.length > 0, reason: (res && res.message) || 'post failed', applied };

    const measured = attributes.verify(chosen, snapshot, res.data && res.data.overview, model);
    if (measured) log(`attribute model: ${chosen} measured ${JSON.stringify(measured)}`);
    snapshot = (res.data && res.data.overview) || snapshot;

    applied.push(`${chosen}${fallback ? '(fallback)' : `(+${pick.gain}g/d at ${pick.pointsToNext}p)`}`);
    // Re-read instead of trusting the projection: the next point must be scored
    // against what the hero really is, not against what this loop expected.
    hero = await readHero(g);
    points = res.data && res.data.points_available !== undefined
      ? Number(res.data.points_available)
      : points - 1;
    attributes.save(model);
  }
  return { done: true, reason: `applied ${applied.join(', ')}`, applied };
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

/** Daily quests: accept what combat can finish, then claim whatever is ready. */
async function handleDailies(g) {
  let accepted = [];
  try {
    const o = await dailies.offers(g);
    // Skip offers that require spending gold/materials or crafting we cannot sustain yet.
    const SKIP = /Fabrica|Gasta|Mejora|Compra/i;
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

  let claimed = [];
  try {
    const r = await dailies.claimAll(g, { allowMutate: LIVE });
    claimed = r.claimed || [];
  } catch (e) {
    log(`dailies claim failed: ${e.message}`);
  }

  if (accepted.length) log(`dailies accepted: ${accepted.map((a) => a.title || a.id).join(', ')}`);
  if (claimed.length) log(`dailies claimed: ${JSON.stringify(claimed)}`);
  return { accepted, claimed };
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
  const daily = await claimDailyLogin(g);
  log(`daily_login: ${daily.done ? 'CLAIMED' : 'skip'} — ${daily.reason}`);
  const prod = await claimProduction(g);
  log(`production: ${prod.done ? 'CLAIMED' : 'skip'} — ${prod.reason}`);

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

  // 2b. daily quests: accept first (progress only counts after accepting), then claim
  await handleDailies(g);

  // 3. spend what the game granted
  const attr = await spendAttributePoints(g, hero, targets);  if (attr.done || attr.reason !== 'no points') log(`attributes: ${attr.done ? 'OK' : 'skip'} — ${attr.reason}`);
  const skill = await spendSkillPoints(g, hero);
  if (skill.done || skill.reason !== 'no skill points') log(`skills: ${skill.done ? 'OK' : 'skip'} — ${skill.reason}`);

  try {
    const tal = await talents.spendAll(g, { allowMutate: LIVE });
    if (tal.done || (tal.reason && tal.reason !== 'no talent points')) {
      log(`talents: ${tal.done ? 'OK' : 'skip'} — ${tal.done ? JSON.stringify(tal.applied) : tal.reason}`);
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
    if (!fresh || !fresh.win || fresh.coolingDown || fresh.hpCost + margin > now.hp) break;
    if (now.stamina < target.stamina) {
      log(`stamina too low for ${target.name} (${now.stamina}/${target.stamina})`);
      break;
    }

    log(`fight ${target.name} (lv${target.level}) — predicted ${target.actions} actions, ${target.hpCost} HP, ${target.exp} EXP`);
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
      throw new Error('mode=http needs a verified state/session.json; run once in hybrid to create it');
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
  const halt = security.readHalt();
  if (halt) {
    log(
      `SECURITY HALT active — refusing to start. ${halt.where} at ${halt.at} :: ${(halt.signals || []).join(', ')}`
    );
    log(`human must clear: node tools/clear-halt.js --ack="<what you found>"`);
    process.exit(3);
  }

  const got = lock.acquire('runner');
  if (!got.ok) {
    log(`another driver is active (pid ${got.holder.pid}, ${got.holder.name}) — exiting`);
    process.exit(2);
  }

  const acquired = await acquire();
  let g = acquired.g;
  log(`transport: ${acquired.via} (mode ${MODE})`);
  try {
    let cfg = await g.idleConfig();
    let ticks = 0;
    let failures = 0;
    let recoverFailures = 0;
    let maintenanceWaits = 0;

    for (;;) {
      try {
        const hb = await g.heartbeat(cfg);
        if (!hb.alive) {
          cfg = await g.idleConfig();
        }
        ticks += 1;
        await tick(g, { tick: ticks });
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
      log(`sleeping ${loopSeconds}s`);
      await sleep(loopSeconds * 1000);
    }
  } finally {
    try {
      g.close();
    } catch (e) {}
    lock.release();
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
