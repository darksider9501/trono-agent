/**
 * Read-only building report: level, requirements, upgradeability, next-level gain.
 *
 * Parses the actual `building-requirement` markup instead of guessing, so the
 * numbers printed here are the numbers the game will charge. It never posts to a
 * mutating endpoint; `allowMutate` is never passed.
 *
 * Run with the production runner stopped (it owns the driver lock):
 *   node tools/buildings-report.js
 */
const { Game } = require('../lib/game');
const lock = require('../lib/driverlock');
const credentials = require('../lib/credentials');

const VIEWS = ['rest_camp', 'hospital', 'arcane_tower', 'stable', 'smithy'];

const clean = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&aacute;/g, 'a').replace(/&eacute;/g, 'e').replace(/&iacute;/g, 'i')
    .replace(/&oacute;/g, 'o').replace(/&uacute;/g, 'u').replace(/&ntilde;/g, 'n')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Every requirement row the page renders. The `is-ready` / `is-missing` class is
 * the game's own verdict, so we trust the class for the satisfied flag and keep
 * the have/need split for the report.
 */
function parseRequirements(html) {
  const out = [];
  const re =
    /<div class="building-requirement\s+(is-ready|is-missing)"[\s\S]{0,600}?<span>([^<]{1,60})<\/span>\s*<b>([^<]{1,40})<\/b>\s*<em>([^<]{1,6})<\/em>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 20) {
    const have = m[3].split('/')[0].trim();
    const need = (m[3].split('/')[1] || '').trim();
    out.push({
      label: clean(m[2]),
      have: Number(have.replace(/[^0-9.]/g, '')) || 0,
      need: Number(need.replace(/[^0-9.]/g, '')) || 0,
      ok: m[1] === 'is-ready'
    });
  }
  return out;
}

/** "AL SIGUIENTE NIVEL" block: the effect the upgrade buys. */
function nextLevel(html) {
  const i = html.search(/AL SIGUIENTE NIVEL/i);
  if (i < 0) return null;
  const raw = clean(html.slice(i + 15, i + 700));
  const j = raw.search(/DESCANSO DEL H/);
  return (j > 0 ? raw.slice(0, j) : raw).slice(0, 230);
}

function currentLevel(html) {
  const m = /building-level[^>]*>\s*(\d+)\s*</i.exec(html) ||
    /"level"\s*:\s*(\d+)/.exec(html) ||
    /NIVEL\s*(\d+)/i.exec(clean(html));
  return m ? Number(m[1]) : null;
}

async function main() {
  if (lock.current()) {
    console.log('driver busy — stop the agent first');
    process.exit(2);
  }
  if (!lock.acquire('buildings-report').ok) {
    console.log('could not acquire the driver lock');
    process.exit(2);
  }

  let g = null;
  try {
    g = await Game.connect({ spawn: true });
    if (!(await g.isLoggedIn())) {
      const creds = credentials.load();
      const res = await g.login(creds);
      if (!res || !res.ok) throw new Error('login failed');
    }
    const state = await g.apiGet('/api/player_state.php');
    const gold = state.state.economy.gold;
    const heroLevel = state.state.hero.hero_level;

    const report = [];
    for (const view of VIEWS) {
      let row = { view, level: null, reqs: [], upgradeable: false, next: null, error: null };
      try {
        const page = await g.fetchPage(`/pages/buildings.php?view=${view}`);
        const html = page.html;
        row.level = currentLevel(html);
        row.reqs = parseRequirements(html);
        row.next = nextLevel(html);
        row.upgradeable = row.reqs.length > 0 && row.reqs.every((r) => r.ok);
        if (/disabled[^>]*>\s*REQUISITOS INCOMPLETOS/i.test(html)) row.upgradeable = false;
      } catch (e) {
        row.error = e.message;
      }
      report.push(row);
    }

    console.log(JSON.stringify({ gold, heroLevel, report }, null, 2));
  } finally {
    try { g.close(); } catch (e) {}
    lock.release();
  }
}

main().catch((e) => {
  console.log(`FATAL ${e.code || ''} ${e.message}`);
  lock.release();
  process.exit(1);
});
