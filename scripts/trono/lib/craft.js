/**
 * Potion crafting at the smithy (Herreria -> "FABRICAR POCIONES").
 *
 * Page: /pages/buildings.php?view=smithy
 * Post: <data-endpoint on [data-potion-workshop]>   (live: /api/potion_craft.php)
 *       form {csrf, potion, request_id, quantity} + header X-Requested-With: XMLHttpRequest
 *       answers {ok, name, result:{quantity, gold, gold_spent, materials:{<key>:<balance>}}}
 *
 * Why this module exists: the daily "CRAFTEAR POCIONES DE VIDA" asks for "Fabrica 2
 * pociones de vida" and pays 20 activity points. Nothing in the agent could make one, so
 * the objective sat at 0/2 every day.
 *
 * Costs, measured 2026-11-17: 100 Oro Imperial + 2 Carne de Bestia + 4 Madera de Sylvenor
 * per Poción de Vida Menor (recipes unlock by smithy level: 1 · minors, 3 · medium,
 * 6 · major). Both materials come from the world map, not from combat.
 *
 * Two hard rules this file enforces instead of trusting its caller:
 *
 *   1. GOLD CAP. `maxGold` is a ceiling on this call, and the module refuses to run at
 *      all when it is 0. Spending gold is human territory; the default is off, and the
 *      line that turns it on is explicit in the runner.
 *   2. MATERIALS ARE CHECKED FIRST. The page reports owned/need per material; if the
 *      balance does not cover the quantity, nothing is posted. A craft that the server
 *      would reject is a wasted round-trip and a noise line in the log.
 *
 * Demand is read from the dailies, not hardcoded: crafting 2 potions every tick would
 * burn gold forever, and the objective only wants two.
 */
const PAGE = '/pages/buildings.php?view=smithy';
const DAILY = '/pages/quests_daily.php';

/** Recipes we care about, best first. Health potions are what the daily asks for. */
const PREFERRED = ['potion_health_minor', 'potion_mana_minor'];

/**
 * Daily objective text -> potion key.
 *
 * The board renders "Fabrica 2 pociones de vida" with a 0/2 counter. The number in the
 * label is the target; the counter is the truth, so we take the counter.
 */
const DEMAND = [
  [/pociones?\s+de\s+vida/i, 'potion_health_minor'],
  [/pociones?\s+de\s+man[a\u00e1]/i, 'potion_mana_minor'],
  [/elixires?\s+de\s+da[n\u00f1]o/i, 'elixir_damage_minor'],
  [/elixires?\s+de\s+defensa/i, 'elixir_defense_minor']
];

/** The workshop block: gold on hand, endpoint, and the daily's unmet potion demand. */
function parseWorkshop(html) {
  const tag = /<[a-z]+[^>]*\bdata-potion-workshop\b[^>]*>/i.exec(html);
  if (!tag) return null;
  const gold = /data-gold="(\d+)"/i.exec(tag[0]);
  const endpoint = /data-endpoint="([^"]+)"/i.exec(tag[0]);
  const path = endpoint ? endpoint[1].trim() : '';
  return {
    gold: gold ? Number(gold[1]) : null,
    // Allow-list: the page may only point us at its own API.
    endpoint: /^\/api\/[a-z0-9_]+\.php$/.test(path) ? path : null,
    level: Number((/HERRER[I\u00cd]A\s+NV\.\s*(\d+)/i.exec(html) || [])[1] || 0),
    recipes: parseRecipes(html)
  };
}

function parseRecipes(html) {
  const recipes = [];
  for (const m of html.matchAll(/<form[^>]*data-potion-form[^>]*>([\s\S]*?)<\/form>/g)) {
    const tag = /<form[^>]*>/.exec(m[0])[0];
    const body = m[1];
    const field = (name) => {
      const f = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i').exec(body)
        || new RegExp(`value="([^"]*)"[^>]*name="${name}"`, 'i').exec(body);
      return f ? f[1] : null;
    };
    const materials = [];
    for (const li of body.matchAll(/data-potion-material="([a-z0-9_]+)"[^>]*data-need="(\d+)"[^>]*data-owned="(\d+)"/g)) {
      materials.push({ key: li[1], need: Number(li[2]), owned: Number(li[3]) });
    }
    const unit = /data-potion-total[^>]*data-unit="(\d+)"/i.exec(body);
    const maxQty = /name="quantity"[^>]*max="(\d+)"/i.exec(body) || /max="(\d+)"[^>]*name="quantity"/i.exec(body);
    recipes.push({
      potion: field('potion'),
      csrf: field('csrf'),
      name: ((/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(body) || [])[1] || '').replace(/<[^>]+>/g, '').trim(),
      locked: /data-locked="1"/i.test(tag),
      unitGold: unit ? Number(unit[1]) : null,
      maxQuantity: maxQty ? Number(maxQty[1]) : 100,
      materials
    });
  }
  return recipes;
}

/**
 * Unmet potion demand from the daily board: {potion_key: missing_count}.
 *
 * Only rows whose label names a potion and whose counter is below target count. Anything
 * we have no recipe for is ignored rather than guessed at.
 */
function parseDailyDemand(html) {
  const out = {};
  for (const m of html.matchAll(/qb-obj__label[^>]*>([^<]+)</g)) {
    const label = m[1];
    const tail = html.slice(m.index, m.index + 400);
    const counter = /qb-obj__count[^>]*>(\d+)\s*\/\s*(\d+)/.exec(tail);
    if (!counter) continue;
    const done = Number(counter[1]);
    const target = Number(counter[2]);
    const missing = target - done;
    if (missing <= 0) continue;
    for (const [re, potion] of DEMAND) {
      if (re.test(label)) out[potion] = Math.max(out[potion] || 0, missing);
    }
  }
  return out;
}

/** How many of this recipe the current materials and gold allow. */
function affordable(recipe, gold, maxGold) {
  const cap = Math.min(gold, maxGold);
  let qty = recipe.maxQuantity;
  if (recipe.unitGold > 0) qty = Math.min(qty, Math.floor(cap / recipe.unitGold));
  for (const m of recipe.materials) {
    if (m.need > 0) qty = Math.min(qty, Math.floor(m.owned / m.need));
  }
  return Math.max(0, qty);
}

function shortages(recipe) {
  return recipe.materials
    .map((m) => {
      const short = Math.max(0, m.need - m.owned);
      return short > 0 ? `${m.key} ${m.owned}/${m.need}` : null;
    })
    .filter(Boolean)
    .join(', ');
}

async function read(g) {
  const page = await g.fetchPage(PAGE);
  if (!page.ok) throw new Error(`smithy HTTP ${page.status}`);
  const workshop = parseWorkshop(page.html);
  let demand = {};
  if (workshop) {
    const daily = await g.fetchPage(DAILY);
    if (daily.ok) demand = parseDailyDemand(daily.html);
  }
  return { workshop, demand, html: page.html };
}

/**
 * Craft what the dailies ask for, within the gold cap.
 *
 * Returns {done, crafted:[{potion,name,quantity,goldSpent,goldBefore,goldAfter}], reason, gold}
 * — `done` means at least one potion entered the inventory.
 */
async function craft(g, opts = {}) {
  const maxGold = Number(opts.maxGold || 0);
  const state = await read(g);
  const ws = state.workshop;
  if (!ws) return { done: false, reason: 'no potion workshop on the smithy page' };
  if (!ws.endpoint) return { done: false, reason: 'workshop has no endpoint on the page' };

  if (!(maxGold > 0)) {
    return {
      done: false,
      reason: `craft disabled (gold cap 0, ${ws.gold} gold on hand)`,
      demand: state.demand
    };
  }
  if (!state.demand || !Object.keys(state.demand).length) {
    return { done: false, reason: 'no potion objective in the dailies' };
  }

  const ordered = [
    ...PREFERRED.filter((k) => state.demand[k] > 0),
    ...Object.keys(state.demand).filter((k) => !PREFERRED.includes(k))
  ];

  const crafted = [];
  let gold = ws.gold;
  let budgetLeft = maxGold;

  for (const potion of ordered) {
    const recipe = ws.recipes.find((r) => r.potion === potion);
    if (!recipe) continue;
    if (recipe.locked) continue;
    if (!recipe.csrf) continue;

    const want = Math.min(Number(state.demand[potion]) || 0, opts.maxPerPotion || 20);
    const fits = Math.min(want, affordable(recipe, gold, budgetLeft));
    if (fits < 1) {
      // Nothing to post for this one; keep going in case a cheaper recipe fits.
      continue;
    }
    if (!opts.allowMutate) {
      return { done: false, dry: true, planned: potion, quantity: fits, gold };
    }

    const before = gold;
    const res = await g.postFormJson(
      ws.endpoint,
      {
        csrf: recipe.csrf,
        potion: recipe.potion,
        // Idempotency key, exactly as the page's own controller sends it: the same id is
        // kept when the answer is lost, and only rotates after a success, so a replay
        // can never charge twice.
        request_id: opts.requestId || require('crypto').randomUUID(),
        quantity: String(fits)
      },
      { allowMutate: true, headers: { 'X-Requested-With': 'XMLHttpRequest' } }
    );

    if (!res || res.ok !== true) {
      return {
        done: crafted.length > 0,
        crafted,
        reason: `server rejected ${potion} x${fits}: ${(res && (res.message || res.raw)) || 'no answer'}`,
        gold
      };
    }
    const result = res.result || {};
    const spent = Number(result.gold_spent || recipe.unitGold * fits || 0);
    gold = Number.isFinite(Number(result.gold)) ? Number(result.gold) : gold - spent;
    budgetLeft -= spent;
    crafted.push({
      potion,
      name: res.name || recipe.name,
      quantity: Number(result.quantity || fits),
      goldSpent: spent,
      goldBefore: before,
      goldAfter: gold
    });
    // The answer carries the new material balances, so the next recipe uses them and not
    // the stale ones read from the page.
    for (const m of recipe.materials) {
      const balance = result.materials && result.materials[m.key];
      if (balance !== undefined) m.owned = Number(balance);
    }
  }

  if (!crafted.length) {
    const why = ordered
      .map((p) => {
        const r = ws.recipes.find((x) => x.potion === p);
        if (!r) return `${p}: no recipe on the page`;
        if (r.locked) return `${p}: locked (smithy level ${ws.level})`;
        return `${p}: ${shortages(r) || 'not enough gold'}`;
      })
      .join('; ');
    return { done: false, reason: `nothing craftable: ${why}`, gold, demand: state.demand };
  }

  return { done: true, crafted, gold, goldSpent: crafted.reduce((n, c) => n + c.goldSpent, 0) };
}

module.exports = { PAGE, DAILY, PREFERRED, read, craft, parseWorkshop, parseRecipes, parseDailyDemand, affordable, shortages };
