/**
 * Self-test for lib/craft.js (smithy potions), fixture from the LIVE page 2026-11-17.
 *
 * The markup below is the real thing, trimmed to two cards: the unlocked Poción de Vida
 * Menor (100 gold + 2 Carne de Bestia + 4 Madera de Sylvenor) and the level-3-gated
 * mediana, which must never be posted.
 *
 * Run: node tools/craft-selftest.js
 */
const craft = require('../lib/craft');

const CSRF = '017e642d60257c6b17702e160e60a1513c1c699473f8b374';

function card({ potion, name, unit, needCarne, needWood, ownedCarne, ownedWood, locked = 0, max = 100 }) {
  return `  <form class="smithy-potions__card${locked ? ' is-locked' : ''}" data-potion-form data-locked="${locked}">
    <img src="/assets/img/consumables/${potion}.webp" alt="${name}">
    <div>
      <h3>${name}</h3>
      <small>Herrería nivel 1 · ${unit} Oro Imperial por poción</small>
      <ul>
        <li data-potion-material="carne_bestia" data-need="${needCarne}" data-owned="${ownedCarne}"><span>Carne de Bestia</span><small data-material-summary>Necesitas ${needCarne} · Tienes ${ownedCarne}</small></li>
        <li data-potion-material="sylvenor_wood" data-need="${needWood}" data-owned="${ownedWood}"><span>Madera de Sylvenor</span><small data-material-summary>Necesitas ${needWood} · Tienes ${ownedWood}</small></li>
      </ul>
      <input type="hidden" name="csrf" value="${CSRF}">
      <input type="hidden" name="potion" value="${potion}">
      <input type="hidden" name="request_id" value="2c154ebe-0055-495a-b3d6-8b4112de2494">
      <label>Cantidad <input type="number" name="quantity" value="1" min="1" max="${max}" step="1" inputmode="numeric" required aria-label="Cantidad de Poción"></label>
      <strong data-potion-total data-unit="${unit}">Total: ${unit} oro</strong>
      <button type="submit"${locked ? ' disabled' : ''}>FABRICAR POCIÓN</button>
    </div>
  </form>`;
}

function smithyPage({ gold = 4330, ownedCarne = 0, ownedWood = 1 } = {}) {
  return `<!doctype html><html><body>
  <details class="smithy-potions" data-potion-workshop data-gold="${gold}" data-endpoint="/api/potion_craft.php">
    <summary>FABRICAR POCIONES</summary>
    <header><span>HERRERÍA NV. 1</span></header>
${card({ potion: 'potion_health_minor', name: 'Poción de Vida Menor', unit: 100, needCarne: 2, needWood: 4, ownedCarne, ownedWood })}
${card({ potion: 'potion_health_medium', name: 'Poción de Vida Mediana', unit: 500, needCarne: 4, needWood: 8, ownedCarne, ownedWood, locked: 1 })}
  </details></body></html>`;
}

// Verbatim rows from /pages/quests_daily.php (2026-11-17).
const DAILY_PAGE = `<ul class="qb-objs">
  <li class="qb-obj is-pending"><span class="qb-obj__radio" aria-hidden="true"></span> <span class="qb-obj__label">Fabrica 2 pociones de vida</span> <span class="qb-obj__count">0/2</span></li>
  <li class="qb-obj is-pending"><span class="qb-obj__radio" aria-hidden="true"></span> <span class="qb-obj__label">Abre 5 cofres de botín</span> <span class="qb-obj__count">1/5</span></li>
</ul>
<ul class="qb-objs">
  <li class="qb-obj is-done"><span class="qb-obj__label">Fabrica 1 poción de maná</span> <span class="qb-obj__count">1/1</span></li>
</ul>`;

const results = [];
const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

function fakeG(opts = {}) {
  const state = { gold: opts.gold ?? 4330, carne: opts.carne ?? 0, wood: opts.wood ?? 1 };
  const posts = [];
  return {
    posts,
    state,
    async fetchPage(url) {
      if (url === craft.DAILY) return { ok: true, status: 200, html: DAILY_PAGE };
      return { ok: true, status: 200, html: smithyPage({ gold: state.gold, ownedCarne: state.carne, ownedWood: state.wood }) };
    },
    async postFormJson(url, fields, o) {
      posts.push({ url, fields, headers: o && o.headers });
      if (opts.reject) return { ok: false, status: 200, message: 'No hay materiales suficientes.' };
      const qty = Number(fields.quantity);
      const unit = fields.potion === 'potion_health_minor' ? 100 : 500;
      const spent = unit * qty;
      state.gold -= spent;
      state.carne -= 2 * qty;
      state.wood -= 4 * qty;
      return {
        ok: true,
        name: 'Poción de Vida Menor',
        result: { quantity: qty, gold: state.gold, gold_spent: spent, materials: { carne_bestia: state.carne, sylvenor_wood: state.wood } }
      };
    }
  };
}

(async () => {
  // --- reading the page -----------------------------------------------------
  {
    const ws = craft.parseWorkshop(smithyPage());
    check('workshop parsed', !!ws, '');
    check('gold read from the workshop', ws.gold === 4330, `${ws.gold}`);
    check('endpoint read and allow-listed', ws.endpoint === '/api/potion_craft.php', ws.endpoint);
    check('smithy level read', ws.level === 1, `${ws.level}`);
    check('two recipes', ws.recipes.length === 2, `${ws.recipes.length}`);
    const r = ws.recipes[0];
    check('recipe fields', r.potion === 'potion_health_minor' && r.csrf === CSRF && r.unitGold === 100 && !r.locked, `${r.potion} ${r.unitGold}`);
    check('materials with owned/need', r.materials.length === 2 && r.materials[0].need === 2 && r.materials[0].owned === 0, JSON.stringify(r.materials));
    check('locked card is marked', ws.recipes[1].locked === true, '');
    check('a tampered endpoint is refused', craft.parseWorkshop(smithyPage().replace('/api/potion_craft.php', 'https://evil.example/x')).endpoint === null, '');
  }

  // --- demand from the dailies ---------------------------------------------
  {
    const d = craft.parseDailyDemand(DAILY_PAGE);
    check('daily asks for 2 life potions', d.potion_health_minor === 2, JSON.stringify(d));
    check('a finished objective asks for nothing', d.potion_mana_minor === undefined, JSON.stringify(d));
    check('non-potion objectives are ignored', Object.keys(d).length === 1, Object.keys(d).join(','));
  }

  // --- the gold gate --------------------------------------------------------
  {
    const g = fakeG({ carne: 4, wood: 8 });
    const out = await craft.craft(g, { maxGold: 0 });
    check('cap 0 never posts', g.posts.length === 0, `${g.posts.length}`);
    check('cap 0 says why', /craft disabled/.test(out.reason || ''), out.reason);
  }

  // --- the material gate ----------------------------------------------------
  {
    const g = fakeG({ carne: 0, wood: 1 });
    const out = await craft.craft(g, { maxGold: 1000, allowMutate: true });
    check('missing materials never post', g.posts.length === 0, `${g.posts.length}`);
    check('the shortage is named', /carne_bestia 0\/2/.test(out.reason || ''), out.reason);
  }

  // --- the happy path -------------------------------------------------------
  {
    const g = fakeG({ carne: 4, wood: 8 });
    const out = await craft.craft(g, { maxGold: 500, allowMutate: true });
    check('crafts the two the daily wants', g.posts.length === 1 && g.posts[0].fields.quantity === '2', `posts=${g.posts.length} qty=${g.posts[0] && g.posts[0].fields.quantity}`);
    check('posts to the page endpoint', g.posts[0].url === '/api/potion_craft.php', g.posts[0].url);
    check('sends the four form fields', !!(g.posts[0].fields.csrf && g.posts[0].fields.potion && g.posts[0].fields.request_id && g.posts[0].fields.quantity), JSON.stringify(g.posts[0].fields));
    check('request_id is a uuid v4', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(g.posts[0].fields.request_id), g.posts[0].fields.request_id);
    check('sends X-Requested-With like the page', g.posts[0].headers['X-Requested-With'] === 'XMLHttpRequest', JSON.stringify(g.posts[0].headers));
    check('reports 200 gold spent', out.goldSpent === 200, `${out.goldSpent}`);
    check('reports the new balance', out.gold === 4130, `${out.gold}`);
    check('done', out.done === true, out.reason || '');
    check('crafted detail carries before/after', out.crafted[0].goldBefore === 4330 && out.crafted[0].goldAfter === 4130, JSON.stringify(out.crafted[0]));
  }

  // --- the cap bounds the quantity, not just the permission ----------------
  {
    const g = fakeG({ carne: 8, wood: 16, gold: 4330 });
    const out = await craft.craft(g, { maxGold: 150, allowMutate: true });
    check('cap 150 buys one, not two', g.posts[0].fields.quantity === '1', g.posts[0].fields.quantity);
    check('spend stays inside the cap', out.goldSpent <= 150, `${out.goldSpent}`);
  }

  // --- materials bound the quantity too ------------------------------------
  {
    const g = fakeG({ carne: 3, wood: 20 });
    await craft.craft(g, { maxGold: 1000, allowMutate: true });
    check('enough material for one only', g.posts[0].fields.quantity === '1', g.posts[0].fields.quantity);
  }

  // --- a rejection is reported, not retried --------------------------------
  {
    const g = fakeG({ carne: 4, wood: 8 });
    const out = await craft.craft(g, { maxGold: 500, allowMutate: true });
    const g2 = fakeG({ carne: 4, wood: 8 });
    g2.postFormJson = async (url, fields, o) => {
      g2.posts.push({ url, fields, headers: o && o.headers });
      return { ok: false, status: 200, message: 'No hay materiales suficientes.' };
    };
    const out2 = await craft.craft(g2, { maxGold: 500, allowMutate: true });
    check('rejection posts once', g2.posts.length === 1, `${g2.posts.length}`);
    check('rejection names the server message', /No hay materiales suficientes/.test(out2.reason || ''), out2.reason);
    check('rejection is not a success', out2.done === false, '');
    check('a clean run is unaffected', out.done === true, out.reason || '');
  }

  // --- dry run --------------------------------------------------------------
  {
    const g = fakeG({ carne: 4, wood: 8 });
    const out = await craft.craft(g, { maxGold: 500 });
    check('dry run posts nothing', g.posts.length === 0, `${g.posts.length}`);
    check('dry run plans the potion', out.planned === 'potion_health_minor' && out.quantity === 2, JSON.stringify(out));
  }

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ? '(' + r.detail + ')' : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
