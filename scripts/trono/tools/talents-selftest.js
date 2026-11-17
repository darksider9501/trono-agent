/**
 * Self-test for lib/talents.js against the v3 talent board.
 *
 * No network, no session, no mutation: the page below is a synthetic copy of the LIVE
 * /pages/talents.php shape captured on 2026-11-16 (87 KB, 30 nodes, budget 16). It keeps
 * every marker that broke the previous parser, because those are the ones that matter:
 *
 *   - zero <input>            (the old code read csrf and hero from hidden inputs)
 *   - zero data-node          (the old code scraped node attributes)
 *   - csrf on <main data-talent-lab> ..., next to SIX decoy data-csrf attributes
 *                             (header, notices, chat, military, buildings, session JSON)
 *   - the whole tree as <script type="application/json"> with version/budget/ranks/
 *     branches, including can_upgrade + reason computed by the server
 *   - hero in <body data-hero> AND in the board payload
 *
 * Run: node tools/talents-selftest.js
 */
const talents = require('../lib/talents');

const CSRF = 'a'.repeat(63) + 'b';
const DECOY = (c) => c.repeat(64);

function node(id, talent_key, name, { max = 5, req_level = 1, parents = [], row = 0, level_met = true } = {}) {
  return {
    id,
    name,
    description: `${name} desc`,
    row,
    x: 620,
    y: 275,
    max,
    effect: { dmg_pct: 0.5 },
    req_level,
    quote: null,
    effects_by_rank: ['+0%', '+0.5%'],
    parents,
    required_points: 0,
    final: false,
    icon: `assets/img/talents/nodes/${id}.webp`,
    talent_key,
    can_upgrade: parents.length === 0,
    reason: parents.length === 0 ? 'Disponible' : 'Requiere antes',
    level_rule: `Nivel de héroe ${req_level}.`,
    level_met,
    branch: id.split('_')[0]
  };
}

function board(overrides = {}) {
  return {
    version: 3,
    budget: 16,
    name: 'Talentos de prueba',
    hero: 'inferno',
    hero_name: 'Inferno',
    theme: { accent: '#ef9c4c', branches: { offense: '#ef9c4c' } },
    portrait: 'assets/img/heroes/portraits/inferno.webp',
    portrait_frame: { width: 386.8966, height: 483.4483, left: -144.8276, top: -5.1724 },
    branches: [
      {
        id: 'offense',
        name: 'Ofensiva',
        color: '#ef9c4c',
        nodes: [
          node('offense_root', 'inferno_offense_root', 'Brasas del Origen'),
          node('offense_left', 'inferno_offense_left', 'Llamarada Voraz', { req_level: 5, parents: ['offense_root'], row: 1 }),
          node('offense_left_mid', 'inferno_offense_left_mid', 'Filo de Magma', { req_level: 10, parents: ['offense_left'], row: 2, level_met: false })
        ]
      },
      {
        id: 'defense',
        name: 'Defensiva',
        color: '#98d374',
        nodes: [
          node('defense_root', 'inferno_defense_root', 'Piel de Ceniza'),
          node('defense_left', 'inferno_defense_left', 'Corteza Quemada', { req_level: 5, parents: ['defense_root'], row: 1 }),
          node('defense_left_mid', 'inferno_defense_left_mid', 'Muralla de Escoria', { req_level: 10, parents: ['defense_left'], row: 2, level_met: false })
        ]
      },
      {
        id: 'utility',
        name: 'Resistencia',
        color: '#e0c46d',
        nodes: [
          node('utility_root', 'inferno_utility_root', 'Aliento del Vigía'),
          node('utility_left', 'inferno_utility_left', 'Paso del Centinela', { req_level: 5, parents: ['utility_root'], row: 1 }),
          node('utility_left_mid', 'inferno_utility_left_mid', 'Pulmón de Hierro', { req_level: 10, parents: ['utility_left'], row: 2, level_met: false })
        ]
      }
    ],
    mode: 'player',
    level: 8,
    ranks: {
      offense_root: 0,
      offense_left: 0,
      offense_left_mid: 0,
      defense_root: 0,
      defense_left: 0,
      defense_left_mid: 0,
      utility_root: 0,
      utility_left: 0,
      utility_left_mid: 0
    },
    reset: { free_used: false, scrolls: 0, scroll_cost: 38 },
    refund_cost: 8,
    ...overrides
  };
}

/** The page, in the order the real one renders it. */
function page(model = board()) {
  return `<!doctype html><html lang="es"><head><title>Defiende Tu Trono</title>
<link rel="stylesheet" href="/assets/css/talents-tree.css?v=1790357253">
<script type="application/json" data-game-navigation>{"url":"/pages/talents.php","root":"/","userId":1068,"routes":["talents"]}</script>
<script type="application/json" data-session-activity>{"remainingMs":1602387,"csrf":"${DECOY('c')}"}</script>
</head>
<body class="ui-reborn page-talentos" data-hero="inferno" data-audio-hero-level="8" data-audio-base="/assets/audio/">
<div data-csrf="${DECOY('d')}" data-notice-read-keys="1"></div>
<div data-csrf="${DECOY('f')}" data-military-api="/api/reino_military.php"></div>
<div data-csrf="${DECOY('1')}" data-api="/api/building_notices.php"></div>
<div data-csrf="${DECOY('2')}" data-api="/api/chat.php"></div>
<div data-csrf="${DECOY('3')}" data-friends-api="/api/friends.php"></div>
<div data-csrf="${DECOY('4')}" data-api="/api/quests.php"></div>
<aside id="gameSidebar">nav</aside>
<a class="active" href="/pages/talents.php" title="Arbol de Talentos">Arbol de Talentos</a>
<main class="talent-lab" data-talent-lab data-action-url="/actions/talent_board.php" data-csrf="${CSRF}" data-user-id="1068" data-asset-base="/">
<div class="talent-lab__identity"><span>PODER</span> Puntos disponibles 16</div>
<script type="application/json" data-talent-board>${JSON.stringify(model)}</script>
</main>
</body></html>`;
}

const results = [];
const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

/** Replays the server contract: form POST in, {ok, message, model} out. */
function fakeServer(model, opts = {}) {
  const state = JSON.parse(JSON.stringify(model));
  const recompute = () => {
    const nodes = state.branches.flatMap((b) => b.nodes);
    for (const n of nodes) {
      const rank = Number(state.ranks[n.id] || 0);
      const parentsOk = (n.parents || []).every((p) => Number(state.ranks[p] || 0) > 0);
      n.can_upgrade = rank < n.max && parentsOk && n.req_level <= state.level;
      n.reason = n.can_upgrade ? 'Disponible' : 'No';
    }
  };
  recompute();
  const htmlFor = () => page(state);
  return {
    posts: [],
    async fetchPage() {
      return { ok: true, status: 200, html: htmlFor() };
    },
    async postFormJson(url, fields) {
      this.posts.push({ url, ...fields });
      if (opts.rejectOn && opts.rejectOn(state, fields)) {
        return { ok: false, status: 200, message: 'No disponible.' };
      }
      const n = state.branches.flatMap((b) => b.nodes).find((x) => x.talent_key === fields.talent_key);
      if (!n || !n.can_upgrade || state.budget <= 0) return { ok: false, status: 200, message: 'No disponible.' };
      state.ranks[n.id] = Number(state.ranks[n.id] || 0) + 1;
      // `budget` is the LIFETIME budget and the server does not decrement it: the live
      // board read budget=16 both before spending and after all 16 points were spent.
      recompute();
      return { ok: true, status: 200, message: 'ok', model: JSON.parse(JSON.stringify(state)) };
    }
  };
}

(async () => {
  // --- the page is read by shape -------------------------------------------
  {
    const html = page();
    check('no hidden inputs, like the live page', !/<input/i.test(html), '');
    check('no data-node attributes', !/data-node=/.test(html), '');
    const b = talents.parseBoard(html);
    check('board found among 3 json blocks', !!b && b.version === 3, b && `v${b.version}`);
    check('budget is the point count', talents.parsePoints(html) === 16, `p=${talents.parsePoints(html)}`);
    check('hero from the board payload', b && b.hero === 'inferno', b && b.hero);
    check('all 9 nodes parsed', talents.parseNodes(html).length === 9, `n=${talents.parseNodes(html).length}`);
    check('csrf taken from the lab element', talents.parseCsrf(html) === CSRF, talents.parseCsrf(html));
    const all = [...html.matchAll(/data-csrf="([0-9a-f]+)"/g)].map((m) => m[1]);
    check('6 decoy csrf values ignored', all.length === 7 && all.filter((c) => c === CSRF).length === 1, `total=${all.length}`);
    check('action url followed from the page', talents.parseActionUrl(html) === '/actions/talent_board.php', talents.parseActionUrl(html));
    check('a tampered action url falls back', talents.parseActionUrl(html.replace('/actions/talent_board.php', 'https://evil.example/x')) === talents.DEFAULT_ACTION_URL, '');
  }

  // --- the spend loop -------------------------------------------------------
  {
    const g = fakeServer(board());
    const out = await talents.spendAll(g, { allowMutate: true });
    const order = g.posts.map((p) => p.talent_key);
    check('spends the whole budget', g.posts.length === 16 && out.pointsLeft === 0, `posts=${g.posts.length} left=${out.pointsLeft}`);
    check('done', out.done === true, out.reason || '');
    check('roots first, 5/5/5', JSON.stringify(order.slice(0, 15)) === JSON.stringify([
      ...Array(5).fill('inferno_offense_root'),
      ...Array(5).fill('inferno_defense_root'),
      ...Array(5).fill('inferno_utility_root')
    ]), order.slice(0, 15).join(','));
    check('leftover goes to the child the server opened', order[15] === 'inferno_offense_left', order[15]);
    check('never touches a level-gated node', !order.some((k) => k.endsWith('_mid')), order.filter((k) => k.endsWith('_mid')).join(','));
    check('posts the four form fields', g.posts.every((p) => p.csrf === CSRF && p.hero === 'inferno' && p.action === 'upgrade' && p.talent_key), '');
    check('posts to the action url', g.posts.every((p) => p.url === '/actions/talent_board.php'), g.posts[0].url);
  }

  // --- spent budget is not available budget -------------------------------
  {
    const spent = board();
    spent.ranks = Object.fromEntries(Object.keys(spent.ranks).map((k) => [k, 0]));
    spent.ranks.offense_root = 5;
    spent.ranks.defense_root = 5;
    spent.ranks.utility_root = 5;
    spent.ranks.offense_left = 1;
    const out = await talents.spendAll(fakeServer(spent), { allowMutate: true });
    check('budget minus ranks is the balance', talents.availablePoints(spent) === 0, `available=${talents.availablePoints(spent)}`);
    check('a spent board is silent, not a skip per tick', /no talent points/.test(out.reason || ''), out.reason);
  }

  // --- levels gate the plan, not the loop ----------------------------------
  {
    const g = fakeServer(board({ budget: 3 }));
    const out = await talents.spendAll(g, { allowMutate: true });
    check('stops when the budget is gone', g.posts.length === 3 && out.pointsLeft === 0, `posts=${g.posts.length} left=${out.pointsLeft}`);
  }

  // --- dry run, rejection, preview -----------------------------------------
  {
    const g = fakeServer(board());
    const out = await talents.spendAll(g, { allowMutate: false });
    check('dry run posts nothing', g.posts.length === 0, `${g.posts.length}`);
    check('dry run names the target', out.planned === 'inferno_offense_root', out.planned);
  }
  {
    const g = fakeServer(board(), { rejectOn: (s, f) => f.talent_key === 'inferno_defense_root' });
    const out = await talents.spendAll(g, { allowMutate: true });
    check('a rejection stops the loop', g.posts.length === 6, `posts=${g.posts.length}`);
    check('the rejection is named', /server rejected inferno_defense_root/.test(out.reason || ''), out.reason);
    check('what landed is kept', out.applied.length === 5, `applied=${out.applied.length}`);
    check('no invented counter', out.pointsLeft === null, `${out.pointsLeft}`);
  }
  {
    const g = fakeServer(board({ mode: 'preview' }));
    const out = await talents.spendAll(g, { allowMutate: true });
    check('preview boards are not touched', g.posts.length === 0 && /not player/.test(out.reason || ''), out.reason);
  }

  // --- no board at all is loud, not silent --------------------------------
  {
    const g = { posts: [], async fetchPage() { return { ok: true, status: 200, html: '<html><body><aside id="gameSidebar">x</aside></body></html>' }; } };
    const out = await talents.spendAll(g, { allowMutate: true });
    check('a page without a board says so', /no board payload/.test(out.reason || ''), out.reason);
  }

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail ? '(' + r.detail + ')' : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
