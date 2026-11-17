/**
 * Opening the encounter chests the inventory is sitting on.
 *
 * Why this module exists: two dailies cannot be finished without it —
 *
 *   "Abre 5 cofres de botín"     0/5    (5 chests)
 *   "Reúne 10 materiales"        0/10   (10 materials)
 *   "Fabrica 2 pociones de vida" 0/2    (needs 2 Carne de Bestia + 4 Madera)
 *
 * and the crafting one was dead because of the third line: `lib/craft.js` can craft, but
 * the agent owned 0 Carne de Bestia and 1 Madera de Sylvenor, so `affordable()` was 0
 * every tick. The world map does NOT sell or gather these — investigated 2026-11-17,
 * region 1 (Bosque de Sylvenor) exposes eight locations and all eight are
 * `marker_type: "enemy"`, with no gathering node, no harvest endpoint and no loot table
 * in `/api/world/location.php`. The materials come out of chests.
 *
 * On 2026-11-17 the inventory bootstrap carried 38 unopened chests, all
 * `chest_key: "encounter_chest"`, `tier: "common"`, `region_key: "bosque-de-sylvenor"`,
 * awarded between 2026-11-11 and 2026-11-16. They were just sitting there.
 *
 * Contract, read from /assets/js/loot-chests.js?v=16 (the page's own controller):
 *
 *   bulk   POST <LOOT_CHEST_API>  JSON {action:'open_all_chests', chest_ids:[...], csrf}
 *          -> {ok, data:{chest_ids:[...confirmed], rewards:[...]}}
 *          The controller sends 20 ids per request and requires every id in the batch to
 *          come back confirmed; we treat a partial confirmation as a failure, not a
 *          success, because the remaining chests would silently vanish from our copy.
 *
 *   single POST <LOOT_CHEST_API>  JSON {chest_id, csrf}
 *          -> {ok, data:{rewards:[...]}}
 *
 *   reward {type:'material'|'gold'|'rune'|'attribute_point'|'talent_point'|..., key,
 *           name, quantity, level, rarity}
 *
 * The csrf comes from the page's bootstrap (`LOOT_CHEST_CSRF`), NOT from a header —
 * `GameHttp.apiPost` puts the token in `x-csrf-token` and is rejected here, which is why
 * the transport grew `postJson`.
 *
 * Two rules, same shape as `lib/craft.js`:
 *
 *   1. NEVER OPEN MORE THAN ASKED. `maxPerTick` bounds the whole call; the default is one
 *      batch of 20, so 38 chests take two ticks instead of one burst.
 *   2. THE ENDPOINT IS ALLOW-LISTED. If the page ever points its bootstrap at another
 *      host, nothing is posted.
 */
const PAGE = '/pages/inventory.php';

/** The controller's own batch size. Sending more is not part of the contract. */
const BATCH = 20;

/** csrf tokens on this game are 64 hex; the page has a dozen of them and only one is real. */
const CSRF_RE = /^[0-9a-f]{32,128}$/;

/** Endpoint allow-list: the page may only point us at its own API. */
const ENDPOINT_RE = /^\/api\/[a-z0-9_]+\.php$/;

/**
 * The inventory page's bootstrap: unopened chests, the endpoint and its csrf.
 *
 * Returns null when the page carries no bootstrap at all (logged out, maintenance, or a
 * page whose render was cut short) — the caller must not guess.
 */
/**
 * Normalise the bootstrap's owned lists into `{key: qty}`.
 *
 * The bootstrap does NOT ship a dict: `OWNED_MATERIALS` is an array of
 * `{key, name, qty, rarity, category, ...}` and `OWNED_CONSUMABLES` is an array of
 * `{id, name, qty, ...}`. Spread-assigning the raw array produces `{0: {...}, 1: {...}}`
 * and every material delta lands on a numeric index, which is exactly the bug a synthetic
 * dict-shaped fixture hides. Accept both shapes and normalise here, once.
 */
function ownedMap(raw, keyField) {
  const out = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const key = item[keyField];
      if (!key) continue;
      out[String(key)] = Number(item.qty != null ? item.qty : item.quantity) || 0;
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const qty = value && typeof value === 'object' ? (value.qty != null ? value.qty : value.quantity) : value;
      out[String(key)] = Number(qty) || 0;
    }
  }
  return out;
}

function parseBootstrap(html) {
  const m =
    /<script[^>]*\bdata-inventory-bootstrap\b[^>]*>([\s\S]*?)<\/script>/i.exec(html) ||
    /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;

  let boot;
  try {
    boot = JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
  if (!boot || typeof boot !== 'object' || !Array.isArray(boot.LOOT_CHESTS)) return null;

  const api = String(boot.LOOT_CHEST_API || '').trim();
  const csrf = String(boot.LOOT_CHEST_CSRF || '').trim();

  return {
    endpoint: ENDPOINT_RE.test(api) ? api : null,
    csrf: CSRF_RE.test(csrf) ? csrf : null,
    chests: boot.LOOT_CHESTS.filter((c) => c && Number(c.chest_id) > 0).map((c) => ({
      chest_id: Number(c.chest_id),
      chest_key: String(c.chest_key || ''),
      tier: String(c.tier || ''),
      region_key: String(c.region_key || ''),
      awarded_at: String(c.awarded_at || '')
    })),
    materials: ownedMap(boot.OWNED_MATERIALS, 'key'),
    consumables: ownedMap(boot.OWNED_CONSUMABLES, 'id')
  };
}

/**
 * Group rewards the way the page does (`summarizeRewards`): stackable types collapse into
 * one row with a summed quantity, everything else (equipment, recipes) stays as it came.
 *
 * Material totals are what the caller actually needs, so they are also returned apart.
 */
function summarize(rewards) {
  const STACKABLE = ['material', 'rune', 'gold', 'attribute_point', 'talent_point'];
  const rows = [];
  const groups = new Map();

  for (const raw of Array.isArray(rewards) ? rewards : []) {
    if (!raw || typeof raw !== 'object') continue;
    if (!STACKABLE.includes(raw.type)) {
      rows.push({ ...raw });
      continue;
    }
    const key = [raw.type, raw.key || raw.name || '', raw.level || '', raw.rarity || ''].join('|');
    let row = groups.get(key);
    if (!row) {
      row = { ...raw, quantity: 0 };
      groups.set(key, row);
      rows.push(row);
    }
    row.quantity += Number(raw.quantity) || 1;
  }

  const materials = {};
  let gold = 0;
  for (const row of rows) {
    if (row.type === 'material') materials[row.key] = (materials[row.key] || 0) + row.quantity;
    if (row.type === 'gold') gold += Number(row.quantity) || 0;
  }
  return { rows, materials, gold };
}

/** Read the inventory page and report what is waiting. */
async function read(g) {
  const page = await g.fetchPage(PAGE);
  if (!page.ok) throw new Error(`inventory HTTP ${page.status}`);
  const boot = parseBootstrap(page.html);
  if (!boot) return { noBootstrap: true, chests: [], endpoint: null, csrf: null, materials: {} };
  return boot;
}

/**
 * Open chests, newest first, at most `maxPerTick` of them, `BATCH` per request.
 *
 * Returns {done, opened, rewards, materials, gold, reason, before, after} — `done` means
 * at least one chest was actually opened and confirmed by the server.
 */
async function openAll(g, opts = {}) {
  const maxPerTick = Math.max(0, Number(opts.maxPerTick == null ? BATCH : opts.maxPerTick) || 0);
  const boot = await read(g);
  const before = { ...boot.materials };

  if (boot.noBootstrap) {
    return { done: false, reason: 'inventory page carries no loot-chest bootstrap', opened: 0, materials: {}, gold: 0 };
  }
  if (!boot.chests.length) {
    return { done: false, reason: 'no chests to open', opened: 0, materials: {}, gold: 0, before };
  }
  if (!boot.endpoint) {
    return { done: false, reason: 'chest endpoint missing or not allow-listed', opened: 0, materials: {}, gold: 0, before };
  }
  if (!boot.csrf) {
    return { done: false, reason: 'no loot-chest csrf on the inventory page', opened: 0, materials: {}, gold: 0, before };
  }
  if (maxPerTick < 1) {
    return { done: false, reason: `chests disabled (maxPerTick 0, ${boot.chests.length} waiting)`, opened: 0, materials: {}, gold: 0, before };
  }

  const wanted = boot.chests.slice(0, maxPerTick).map((c) => c.chest_id);
  const collected = [];
  const opened = [];

  for (let i = 0; i < wanted.length; i += BATCH) {
    const batch = wanted.slice(i, i + BATCH);
    if (!opts.allowMutate) {
      return { done: false, dry: true, planned: batch.length, available: boot.chests.length, materials: {}, gold: 0, before };
    }

    const res = await g.postJson(boot.endpoint, { action: 'open_all_chests', chest_ids: batch, csrf: boot.csrf }, { allowMutate: true });

    if (!res || res.ok !== true) {
      const why = (res && (res.message || res.raw)) || 'no answer';
      return {
        done: opened.length > 0,
        opened: opened.length,
        rewards: summarize(collected).rows,
        materials: summarize(collected).materials,
        gold: summarize(collected).gold,
        reason: `server rejected batch of ${batch.length}: ${why}`,
        before
      };
    }

    const data = res.data || {};
    const confirmed = new Set((Array.isArray(data.chest_ids) ? data.chest_ids : []).map(Number));
    const missing = batch.filter((id) => !confirmed.has(id));
    if (missing.length) {
      // The page throws here too. Trusting a partial answer loses chests from our copy
      // while the server still holds them, so the caller must re-read next tick.
      return {
        done: opened.length > 0,
        opened: opened.length,
        rewards: summarize(collected).rows,
        materials: summarize(collected).materials,
        gold: summarize(collected).gold,
        reason: `${missing.length}/${batch.length} chests not confirmed by the server`,
        before
      };
    }

    opened.push(...batch);
    if (Array.isArray(data.rewards)) collected.push(...data.rewards);
  }

  const sum = summarize(collected);
  const after = { ...before };
  for (const [key, qty] of Object.entries(sum.materials)) after[key] = (after[key] || 0) + qty;

  return {
    done: opened.length > 0,
    opened: opened.length,
    waiting: boot.chests.length - opened.length,
    rewards: sum.rows,
    materials: sum.materials,
    gold: sum.gold,
    before,
    after
  };
}

module.exports = { PAGE, BATCH, read, openAll, parseBootstrap, summarize };
