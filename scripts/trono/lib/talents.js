/**
 * Talent tree (Poder -> Arbol de Talentos).
 *
 * Page: /pages/talents.php
 * Use : POST <data-action-url on <main data-talent-lab>>   (v3: /actions/talent_board.php)
 *       form {csrf, hero, action, talent_key}, action in {upgrade, refund, reset, buy_scroll}
 *       answers {ok, message, model} — `model` is the whole board, post-action.
 *
 * Shape history, because this file has now been rewritten once for the same reason
 * twice. The 2026-11 page was server-rendered: 32 `data-node` attributes, a hidden
 * `<input name="csrf">`, a hidden `<input name="hero">`, POST /actions/talent_tree_use.php.
 * The live v3 page (2026-11-16, 87 KB vs the old 118 KB) server-renders NOTHING:
 * zero inputs, zero data-node, zero talent_tree_use. The whole board arrives as one
 * `<script type="application/json">` block —
 *   {version:3, budget:<points>, hero:<key>, mode:"player", ranks:{<node id>:<rank>},
 *    branches:[{id, name, nodes:[{talent_key, max, can_upgrade, reason, req_level, parents, ...}]}]}
 * — plus the csrf on the lab element itself (`<main class="talent-lab" data-csrf=...>`).
 * The browser's own controller (assets/js/talent-tree-preview.js) reads exactly those
 * two things, so we read them too instead of re-deriving the tree's rules.
 *
 * What we deliberately do NOT do: recompute which nodes are legal. `can_upgrade` and
 * `reason` are the server's own verdict, including the hero-level gates that change as
 * the account levels up. Reimplementing them means guessing, and guessing here spends
 * points on nodes the server will refuse.
 *
 * Policy: the offensive root first (damage ends fights in fewer actions, which is the
 * cheapest way to save HP), then the other two roots so the 5/5/5 spread is
 * deterministic, then whatever the server reports as upgradable.
 */
const PAGE = '/pages/talents.php';
const DEFAULT_ACTION_URL = '/actions/talent_board.php';

/**
 * Priority by talent_key. Roots are capped at 5 points each, so at hero level 8 this
 * spends 5/5/5 and leaves the rest to the server's own `can_upgrade` list.
 *
 * Order rationale, measured on the live board (all three roots are +0.5%/point):
 *   offense  +0.5% damage    -> fewer rounds -> less HP per fight
 *   defense  +0.5% armor     -> less HP taken -> fewer heals -> less gold burned
 *   utility  +0.5% stamina regen -> 240 stamina/day * 2.5% = ~6 stamina/day, marginal
 */
const PREFERRED = [
  'inferno_offense_root',
  'inferno_defense_root',
  'inferno_utility_root',
  'inferno_offense_left',
  'inferno_offense_right',
  'inferno_defense_left',
  'inferno_defense_right',
  'inferno_utility_left',
  'inferno_utility_right'
];

/** Hard stop on the spend loop; the budget is 16 today, 40 is already generous. */
const MAX_SPENDS = 40;

/**
 * The board payload, form-first and not attribute-first.
 *
 * The page carries three `application/json` blocks (session config, navigation, board).
 * Rather than key off a `data-*` attribute the site is free to rename, parse every one
 * and take the object that actually has branches and a budget.
 */
function parseBoard(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const raw = m[1].trim();
    if (!raw.startsWith('{')) continue;
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      continue;
    }
    if (obj && Array.isArray(obj.branches) && typeof obj.budget === 'number') return obj;
  }
  return null;
}

/** Every node, flattened and annotated with its branch id and current rank. */
function nodesOf(board) {
  if (!board) return [];
  const ranks = board.ranks || {};
  return board.branches.flatMap((b) =>
    (b.nodes || []).map((n) => {
      const rank = Number(ranks[n.id] || 0);
      const max = Number(n.max || 0);
      return {
        key: n.talent_key,
        id: n.id,
        branch: b.id,
        name: n.name,
        rank,
        max,
        // Derived for readers that only ever understood the old vocabulary; the
        // authority is can_upgrade.
        state: rank >= max ? 'max' : n.can_upgrade ? 'ready' : 'locked',
        canUpgrade: !!n.can_upgrade,
        reason: n.reason,
        reqLevel: n.req_level,
        levelMet: n.level_met,
        parents: n.parents || [],
        effect: n.effect,
        effectsByRank: n.effects_by_rank
      };
    })
  );
}

/**
 * The csrf lives on the lab element, not in an input. Scoping to the `data-talent-lab`
 * tag matters: the page carries seven `data-csrf` attributes (header, notices, chat,
 * military, buildings...) and any of the other six would be rejected by the endpoint.
 */
function parseCsrf(html) {
  const tag = /<[a-z]+[^>]*\bdata-talent-lab\b[^>]*>/i.exec(html);
  if (!tag) return null;
  const m = /data-csrf="([0-9a-f]{16,64})"/i.exec(tag[0]);
  return m ? m[1] : null;
}

/**
 * The endpoint the page itself posts to. Following the attribute means the next
 * endpoint rename is a no-op for us; the allow-list check means a tampered page cannot
 * point our POST somewhere else.
 */
function parseActionUrl(html) {
  const tag = /<[a-z]+[^>]*\bdata-talent-lab\b[^>]*>/i.exec(html);
  const m = tag && /data-action-url="([^"]+)"/i.exec(tag[0]);
  if (!m) return DEFAULT_ACTION_URL;
  const path = m[1].trim();
  return /^\/actions\/[a-z0-9_]+\.php$/.test(path) ? path : DEFAULT_ACTION_URL;
}

/** Available points, straight from the board's own budget counter. */
function parsePoints(html) {
  const board = parseBoard(html);
  return board ? Number(board.budget) : 0;
}

/** Kept for callers that only want the node list. */
function parseNodes(html) {
  return nodesOf(parseBoard(html));
}

async function read(g) {
  const page = await g.fetchPage(PAGE);
  if (!page.ok) throw new Error(`talents HTTP ${page.status}`);
  const board = parseBoard(page.html);
  const nodes = nodesOf(board);
  return {
    csrf: parseCsrf(page.html),
    // The board is the authority for the hero key: the controller posts model.hero,
    // and <body data-hero> is only its rendering.
    hero: board ? board.hero : null,
    actionUrl: parseActionUrl(page.html),
    mode: board ? board.mode : null,
    points: board ? Number(board.budget) : 0,
    board,
    nodes,
    ready: nodes.filter((n) => n.canUpgrade && n.rank < n.max)
  };
}

function choose(ready) {
  for (const key of PREFERRED) {
    const hit = ready.find((n) => n.key === key);
    if (hit) return hit;
  }
  return ready[0] || null;
}

/** Spend every available talent point, one server round-trip per point. */
async function spendAll(g, opts = {}) {
  const before = await read(g);
  if (!before.board) {
    // Loud, and it names the shape we expected: when the page changes again, the next
    // session reads this line instead of guessing from a skip.
    return { done: false, reason: 'talents page has no board payload (expected <script type="application/json"> with branches+budget)' };
  }
  if (before.mode !== 'player') {
    // Preview boards are demos: the page's own save() bails out on them.
    return { done: false, reason: `talents board in ${before.mode || 'unknown'} mode, not player` };
  }
  if (!before.points) return { done: false, reason: 'no talent points', points: 0 };
  if (!before.csrf || !before.hero) return { done: false, reason: 'no csrf/hero on talents page' };

  const applied = [];
  let state = before;
  for (let i = 0; i < MAX_SPENDS && state.points > 0; i++) {
    const node = choose(state.ready);
    // No legal node left: the remaining points are level-gated or parent-gated and
    // there is nothing to do until the account grows.
    if (!node) {
      return {
        done: applied.length > 0,
        applied,
        pointsLeft: state.points,
        reason: applied.length ? undefined : 'no upgradable node'
      };
    }
    if (!opts.allowMutate) {
      // Dry run: report what would be spent rather than posting.
      return { done: false, dry: true, wouldSpend: state.points, planned: node.key, applied };
    }

    const res = await g.postFormJson(
      state.actionUrl,
      { csrf: state.csrf, hero: state.hero, action: 'upgrade', talent_key: node.key },
      { allowMutate: true }
    );

    if (!res || res.ok !== true) {
      // A 200 with ok:false is a rejection (already at max, points gone, a gate we
      // did not model). Stop instead of hammering the endpoint.
      return {
        done: applied.length > 0,
        applied,
        // There is no reliable counter on a rejection, so do not claim one.
        pointsLeft: null,
        reason: `server rejected ${node.key}: ${(res && (res.message || res.raw)) || 'no answer'}`
      };
    }
    applied.push({ key: node.key, rank: node.rank + 1, budget: res.model ? res.model.budget : null });

    const model = res.model;
    if (!model || !Array.isArray(model.branches)) {
      // The action landed but we cannot see the new state; re-read the page.
      state = await read(g);
      continue;
    }
    state = {
      ...state,
      hero: model.hero,
      points: Number(model.budget),
      board: model,
      nodes: nodesOf(model),
      ready: nodesOf(model).filter((n) => n.canUpgrade && n.rank < n.max)
    };
  }

  return { done: applied.length > 0, applied, pointsLeft: state.points };
}

module.exports = { PAGE, DEFAULT_ACTION_URL, read, spendAll, choose, parseBoard, parseNodes, parsePoints, parseCsrf, parseActionUrl };
