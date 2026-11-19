/**
 * Read-only building upgrade survey.
 *
 * Scans every building the game exposes, extracts the level, the active bonuses,
 * the next-level effect and the upgrade requirements (gold + materials), and
 * prints one table. It NEVER posts anything: `allowMutate` is not passed and no
 * mutating endpoint is touched, so the hero's gold and inventory are untouched.
 *
 * Run with the agent stopped (the production runner owns the driver lock):
 *   node tools/buildings-survey.js
 */
const { Game } = require('../lib/game');
const lock = require('../lib/driverlock');
const credentials = require('../lib/credentials');

const VIEWS = [
  { view: 'rest_camp', name: 'Santuario de Resistencia' },
  { view: 'hospital', name: 'Hospital' },
  { view: 'arcane_tower', name: 'Torre Arcana' },
  { view: 'stable', name: 'Establo' },
  { view: 'smithy', name: 'Herrería' }
];

/** Strip tags and collapse whitespace so a table row stays on one line. */
const clean = (s) =>
  String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Pull the requirement rows. The page renders them as label/value pairs inside
 * the upgrade panel; the markup varies per building, so match on the labels the
 * game actually prints rather than on a class name that will drift.
 */
function requirements(html) {
  const out = [];
  const re = /(Oro|Madera|Piedra|Hierro|Cuero|Cristal|Esencia|Gemas?|Materiales?|Nivel de (?:Reino|Héroe|Herrería))\s*<\/[^>]+>\s*<[^>]+>([^<]{1,40})/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 14) {
    out.push(`${clean(m[1])}: ${clean(m[2])}`);
  }
  return out;
}

/** The "AL SIGUIENTE NIVEL" panel: what the next level would actually give. */
function nextLevel(html) {
  const i = html.search(/AL SIGUIENTE NIVEL/i);
  if (i < 0) return null;
  return clean(html.slice(i, i + 900)).slice(0, 320);
}

/** Active bonuses block. */
function activeBonuses(html) {
  const i = html.search(/BENEFICIOS ACTIVOS/i);
  if (i < 0) return null;
  return clean(html.slice(i, i + 900)).slice(0, 320);
}

async function main() {
  if (lock.current()) {
    console.log('driver busy — stop the agent first');
    process.exit(2);
  }
  if (!lock.acquire('buildings-survey').ok) {
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
    console.log(`gold ${gold}   hero lv${heroLevel}\n`);

    for (const b of VIEWS) {
      console.log('='.repeat(72));
      console.log(b.name);
      console.log('='.repeat(72));
      try {
        const page = await g.fetchPage(`/pages/buildings.php?view=${b.view}`);
        const html = page.html;

        const lvl =
          /Nivel\s*<\/[^>]*>\s*<[^>]*>\s*(\d+)/i.exec(html) ||
          /(?:NIVEL|Nivel)\s*(\d+)/.exec(clean(html));
        console.log(`  nivel: ${lvl ? lvl[1] : '?'}`);

        const act = activeBonuses(html);
        console.log(`  activo: ${act || '-'}`);

        const next = nextLevel(html);
        console.log(`  siguiente: ${next || '-'}`);

        const reqs = requirements(html);
        if (reqs.length) {
          console.log('  requisitos:');
          for (const r of reqs) console.log(`    - ${r}`);
        } else {
          console.log('  requisitos: (no parseados)');
        }

        const canPay = /Puedes mejorar|Listo para mejorar|can-upgrade/i.test(html);
        console.log(`  ¿mejorable ahora?: ${canPay ? 'SI' : 'no detectado'}`);
      } catch (e) {
        console.log(`  ERROR: ${e.message}`);
      }
      console.log('');
    }
  } finally {
    try {
      g.close();
    } catch (e) {}
    lock.release();
  }
}

main().catch((e) => {
  console.log(`FATAL ${e.code || ''} ${e.message}`);
  lock.release();
  process.exit(1);
});
