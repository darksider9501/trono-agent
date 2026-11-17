/**
 * Self-test for lib/chests.js, fixture shaped like the LIVE inventory bootstrap
 * (2026-11-17: 38 unopened common encounter chests, api /api/loot_chest.php, 64-hex csrf).
 *
 * The markup below is the real container: a <script type="application/json"
 * data-inventory-bootstrap> carrying LOOT_CHESTS / LOOT_CHEST_API / LOOT_CHEST_CSRF.
 *
 * Run: node tools/chests-selftest.js
 */
const chests = require('../lib/chests');

const CSRF = 'f8c488baa8853512d763bd6c34484fe7cf91ce05971606bcafaf61f59a30bb2b';

function bootstrap({ n = 38, api = '/api/loot_chest.php', csrf = CSRF, materials = { arken_steel: 2, sylvenor_wood: 1 } } = {}) {
  const paid = Array.from({ length: n }, (_, i) => ({
    chest_id: 1000 + i,
    chest_key: 'encounter_chest',
    tier: 'common',
    region_key: 'bosque-de-sylvenor',
    awarded_at: '2026-11-16 19:03:52'
  }));
  return {
    LOOT_CHEST_CONTROLLER: 'loot-chests.js?v=16',
    LOOT_CHESTS: paid,
    LOOT_RECIPES: [],
    LOOT_CHEST_API: api,
    LOOT_CHEST_CSRF: csrf,
    // The real page ships ARRAYS of full objects, not {key: qty} dicts. A dict-shaped
    // fixture hid a real bug: spreading the array gave numeric-index keys.
    OWNED_MATERIALS: Object.entries(materials).map(([key, qty]) => ({
      key,
      name: key,
      qty,
      rarity: 'Común',
      category: 'Metal',
      icon: '◆'
    })),
    OWNED_CONSUMABLES: [{ id: 'potion_health_minor', name: 'Poción de Vida Menor', qty: 1 }]
  };
}

function page(opts = {}) {
  const boot = bootstrap(opts);
  return `<!doctype html><html><body>
  <section class="loot-chest-shelf" data-loot-chest-shelf>
    <button type="button" class="loot-chest-open-all" data-loot-open-all>ABRIR TODOS</button>
    <div data-loot-chest-list></div>
  </section>
  <script type="application/json" data-inventory-bootstrap>${JSON.stringify(boot)}</script>
  </body></html>`;
}

const results = [];
const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

/** A fake transport that answers like the real endpoint, batching 20 at a time. */
function fakeG(opts = {}) {
  const state = { materials: { arken_steel: 2, sylvenor_wood: 1 }, gold: 4330 };
  const posts = [];
  const ids = opts.ids || Array.from({ length: opts.n == null ? 38 : opts.n }, (_, i) => 1000 + i);
  return {
    posts,
    state,
    ids,
    async fetchPage(url) {
      const boot = bootstrap({ n: ids.length, api: opts.api, csrf: opts.csrf, materials: state.materials });
      return { ok: true, status: 200, html: page({ n: ids.length, api: opts.api, csrf: opts.csrf, materials: state.materials }) };
    },
    async postJson(url, payload) {
      posts.push({ url, payload });
      if (opts.reject) return { ok: false, status: 200, message: 'No se pudo abrir el cofre.' };
      const batch = Array.isArray(payload.chest_ids) ? payload.chest_ids : [];
      // A partial confirmation is exactly what the real controller refuses to trust.
      const confirmed = opts.partial ? batch.slice(0, 1) : batch;
      const rewards = [];
      for (const _ of confirmed) {
        rewards.push({ type: 'material', key: 'carne_bestia', name: 'Carne de Bestia', quantity: 1 });
        rewards.push({ type: 'gold', key: 'imperial_gold', name: 'Oro Imperial', quantity: 15 });
      }
      if (opts.recipe) rewards.push({ type: 'recipe', key: 'recipe_x', name: 'Receta de Forja' });
      return { ok: true, status: 200, data: { chest_ids: confirmed, rewards } };
    }
  };
}

(async () => {
  // --- reading the bootstrap ------------------------------------------------
  {
    const b = chests.parseBootstrap(page());
    check('bootstrap parsed', !!b, '');
    check('38 chests read', b.chests.length === 38, `${b.chests.length}`);
    check('endpoint allow-listed', b.endpoint === '/api/loot_chest.php', b.endpoint);
    check('csrf accepted', b.csrf === CSRF, `${(b.csrf || '').length} chars`);
    check('chest fields kept', b.chests[0].chest_id === 1000 && b.chests[0].tier === 'common', JSON.stringify(b.chests[0]));
    check('owned materials exposed', b.materials.sylvenor_wood === 1, JSON.stringify(b.materials));
    check('owned materials from the real array shape become a key->qty map', !Array.isArray(b.materials) && b.materials.arken_steel === 2 && Object.keys(b.materials)[0] === 'arken_steel', JSON.stringify(b.materials));
    check('owned consumables keyed by id', b.consumables.potion_health_minor === 1, JSON.stringify(b.consumables));
    check('a foreign endpoint is refused', chests.parseBootstrap(page({ api: 'https://evil.example/x.php' })).endpoint === null, '');
    check('a short csrf is refused', chests.parseBootstrap(page({ csrf: 'abc123' })).csrf === null, '');
    check('no bootstrap -> null', chests.parseBootstrap('<html><body>Mantenimiento en curso</body></html>') === null, '');
    check('broken json -> null', chests.parseBootstrap('<script type="application/json" data-inventory-bootstrap>{oops</script>') === null, '');
  }

  // --- reward summarising ---------------------------------------------------
  {
    const sum = chests.summarize([
      { type: 'material', key: 'carne_bestia', name: 'Carne de Bestia', quantity: 2 },
      { type: 'material', key: 'carne_bestia', name: 'Carne de Bestia', quantity: 3 },
      { type: 'gold', key: 'imperial_gold', quantity: 40 },
      { type: 'equipment', key: 'sword', name: 'Espada' },
      { type: 'recipe', key: 'r1', name: 'Receta' }
    ]);
    const carne = sum.rows.find((r) => r.key === 'carne_bestia');
    check('stackables are summed', carne && carne.quantity === 5, `${carne && carne.quantity}`);
    check('materials map is what the crafter needs', sum.materials.carne_bestia === 5, JSON.stringify(sum.materials));
    check('gold is totalled', sum.gold === 40, `${sum.gold}`);
    check('non-stackables stay separate', sum.rows.filter((r) => !['material', 'gold'].includes(r.type)).length === 2, `${sum.rows.length}`);
  }

  // --- nothing to do --------------------------------------------------------
  {
    const g = fakeG({ n: 0 });
    const out = await chests.openAll(g, { allowMutate: true });
    check('no chests -> no post', g.posts.length === 0, `${g.posts.length}`);
    check('no chests says why', /no chests/.test(out.reason || ''), out.reason);
    check('no chests is not done', out.done === false, '');
  }

  // --- the batch contract ---------------------------------------------------
  {
    const g = fakeG({ n: 45 });
    const out = await chests.openAll(g, { allowMutate: true, maxPerTick: 45 });
    check('45 chests take 3 batches', g.posts.length === 3, `${g.posts.length}`);
    check('batches are 20/20/5', g.posts.map((p) => p.payload.chest_ids.length).join(',') === '20,20,5', g.posts.map((p) => p.payload.chest_ids.length).join(','));
    check('posts the bulk action', g.posts[0].payload.action === 'open_all_chests', g.posts[0].payload.action);
    check('csrf travels in the body', g.posts[0].payload.csrf === CSRF, '');
    check('posts to the page endpoint', g.posts[0].url === '/api/loot_chest.php', g.posts[0].url);
    check('all 45 opened', out.opened === 45 && out.done === true, `opened=${out.opened}`);
    check('waiting reaches zero', out.waiting === 0, `${out.waiting}`);
  }

  // --- the per-tick ceiling -------------------------------------------------
  {
    const g = fakeG({ n: 38 });
    const out = await chests.openAll(g, { allowMutate: true, maxPerTick: 20 });
    check('ceiling stops at one batch', g.posts.length === 1 && out.opened === 20, `posts=${g.posts.length} opened=${out.opened}`);
    check('ceiling reports what is left', out.waiting === 18, `${out.waiting}`);
  }

  // --- materials actually move ---------------------------------------------
  {
    const g = fakeG({ n: 10 });
    const out = await chests.openAll(g, { allowMutate: true, maxPerTick: 10 });
    check('materials come out of the chests', out.materials.carne_bestia === 10, JSON.stringify(out.materials));
    check('before/after lets the caller diff', out.before.carne_bestia === undefined && out.after.carne_bestia === 10, JSON.stringify(out.after));
    check('gold reward is reported', out.gold === 150, `${out.gold}`);
  }

  // --- refusals are refusals, not partial successes -------------------------
  {
    const g = fakeG({ n: 10, reject: true });
    const out = await chests.openAll(g, { allowMutate: true, maxPerTick: 10 });
    check('a rejection opens nothing', out.done === false && out.opened === 0, `${out.opened}`);
    check('a rejection names the server message', /No se pudo abrir el cofre/.test(out.reason || ''), out.reason);
    check('a rejection posts once', g.posts.length === 1, `${g.posts.length}`);
  }

  {
    const g = fakeG({ n: 10, partial: true });
    const out = await chests.openAll(g, { allowMutate: true, maxPerTick: 10 });
    check('an unconfirmed batch is a failure', /not confirmed/.test(out.reason || ''), out.reason);
    check('an unconfirmed batch opens nothing in our copy', out.opened === 0, `${out.opened}`);
  }

  // --- gates ---------------------------------------------------------------
  {
    const g = fakeG({ n: 10 });
    const out = await chests.openAll(g, { maxPerTick: 10 });
    check('dry run posts nothing', g.posts.length === 0, `${g.posts.length}`);
    check('dry run plans the batch', out.dry === true && out.planned === 10, `${out.planned}`);
  }
  {
    const g = fakeG({ n: 10 });
    const out = await chests.openAll(g, { allowMutate: true, maxPerTick: 0 });
    check('ceiling 0 posts nothing', g.posts.length === 0, `${g.posts.length}`);
    check('ceiling 0 says how many wait', /10 waiting/.test(out.reason || ''), out.reason);
  }
  {
    const g = fakeG({ n: 10, csrf: 'nope' });
    const out = await chests.openAll(g, { allowMutate: true, maxPerTick: 10 });
    check('no csrf -> no post', g.posts.length === 0, `${g.posts.length}`);
    check('no csrf says why', /csrf/.test(out.reason || ''), out.reason);
  }
  {
    const g = fakeG({ n: 10, api: 'https://evil.example/x.php' });
    const out = await chests.openAll(g, { allowMutate: true, maxPerTick: 10 });
    check('a foreign endpoint never posts', g.posts.length === 0, `${g.posts.length}`);
    check('a foreign endpoint says why', /allow-listed/.test(out.reason || ''), out.reason);
  }

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ? '(' + r.detail + ')' : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
