/**
 * Talent tree (Poder -> Arbol de Talentos).
 *
 * Page: /pages/talents.php  (nodes carry data-node / data-branch / data-rank / data-max / data-state / data-parents-keys)
 * Use : POST /actions/talent_tree_use.php  form {csrf, hero:<hero_key>, talent_key}
 * Free reset: POST /actions/talent_reset.php form {csrf, hero}
 *
 * Policy: progress the offensive root first (damage ends fights in fewer actions,
 * which is the cheapest way to save HP), then any node the server reports as ready.
 */
const PAGE = '/pages/talents.php';
const USE = '/actions/talent_tree_use.php';

const PREFERRED = [
  'inferno_offense_root',
  'inferno_offense_left',
  'inferno_offense_right',
  'inferno_defense_root',
  'inferno_utility_root'
];

function parseNodes(html) {
  const nodes = [];
  const seen = new Set();
  for (const m of html.matchAll(/data-node="([a-z0-9_]+)"([\s\S]{0,1400}?)>/g)) {
    const key = m[1];
    if (seen.has(key)) continue;
    const attrs = {};
    for (const a of m[2].matchAll(/data-([a-z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    nodes.push({
      key,
      branch: attrs.branch,
      name: attrs.name,
      rank: Number(attrs.rank || 0),
      max: Number(attrs.max || 0),
      state: attrs.state,
      reason: attrs.reason,
      fxNext: attrs['fx-next'],
      parents: (attrs['parents-keys'] || '').split('|').filter(Boolean)
    });
    seen.add(key);
  }
  return nodes;
}

function parsePoints(html) {
  const m = /Puntos disponibles[\s\S]{0,120}?<strong[^>]*>(\d+)</.exec(html) || /data-talent-points[^>]*>(\d+)</.exec(html);
  if (m) return Number(m[1]);
  const m2 = /Puntos disponibles\s*(\d+)/.exec(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  return m2 ? Number(m2[1]) : 0;
}

function parseHero(html) {
  const m = /<input type="hidden" name="hero" value="([^"]+)"/.exec(html);
  return m ? m[1] : null;
}

function parseCsrf(html) {
  const m = /<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"/.exec(html);
  return m ? m[1] : null;
}

async function read(g) {
  const page = await g.fetchPage(PAGE);
  if (!page.ok) throw new Error(`talents HTTP ${page.status}`);
  const nodes = parseNodes(page.html);
  return {
    csrf: parseCsrf(page.html),
    hero: parseHero(page.html),
    // The header renders the available counter; fall back to ready-node count.
    points: parsePoints(page.html),
    nodes,
    // After the first invest a node leaves "ready" but is still upgradable.
    ready: nodes.filter((n) => n.state !== 'locked' && n.rank < n.max)
  };
}

function choose(ready) {
  for (const key of PREFERRED) {
    const hit = ready.find((n) => n.key === key && n.rank < n.max);
    if (hit) return hit;
  }
  return ready[0] || null;
}

/** Spend every available talent point on the best ready node. */
async function spendAll(g, opts = {}) {
  const before = await read(g);
  if (!before.points) return { done: false, reason: 'no talent points', points: 0 };
  if (!before.csrf || !before.hero) return { done: false, reason: 'no csrf/hero on talents page' };

  const applied = [];
  let points = before.points;
  let html = null;
  for (let i = 0; i < points; i++) {
    const state = html ? { csrf: parseCsrf(html), hero: parseHero(html), ready: parseNodes(html).filter((n) => n.state !== 'locked' && n.rank < n.max) } : before;
    const node = choose(state.ready || []);
    if (!node) break;
    const res = await g.postForm(
      USE,
      { csrf: state.csrf, hero: state.hero, talent_key: node.key },
      { allowMutate: !!opts.allowMutate }
    );
    applied.push({ key: node.key, status: res && res.status });
    const page = await g.fetchPage(PAGE);
    html = page.ok ? page.html : null;
  }
  const after = html ? { points: parsePoints(html) } : { points: null };
  return { done: applied.length > 0, applied, pointsLeft: after.points };
}

module.exports = { PAGE, USE, read, spendAll, choose, parseNodes, parsePoints };
