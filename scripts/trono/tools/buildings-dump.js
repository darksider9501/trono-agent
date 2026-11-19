/** Dump the requirements block of each building, raw, for parser work. */
const { Game } = require('../lib/game');
const lock = require('../lib/driverlock');
const credentials = require('../lib/credentials');

const VIEWS = ['rest_camp', 'hospital', 'arcane_tower', 'stable'];

async function main() {
  if (lock.current()) { console.log('driver busy'); process.exit(2); }
  if (!lock.acquire('buildings-dump').ok) { console.log('no lock'); process.exit(2); }
  let g = null;
  try {
    g = await Game.connect({ spawn: true });
    if (!(await g.isLoggedIn())) {
      const creds = credentials.load();
      const res = await g.login(creds);
      if (!res || !res.ok) throw new Error('login failed');
    }
    for (const v of VIEWS) {
      const page = await g.fetchPage(`/pages/buildings.php?view=${v}`);
      const html = page.html;
      const i = html.search(/REQUISITOS PARA MEJORAR/i);
      console.log('\n' + '#'.repeat(70));
      console.log('# ' + v + '  (idx req: ' + i + ')');
      console.log('#'.repeat(70));
      if (i < 0) {
        // maybe no requirements block: print the upgrade button area
        const b = html.search(/MEJORAR A NIVEL/i);
        console.log(html.slice(Math.max(0, b - 200), b + 1500).replace(/\s+/g, ' ').slice(0, 1600));
        continue;
      }
      console.log(html.slice(i, i + 2200).replace(/\s+/g, ' '));
    }
  } finally {
    try { g.close(); } catch (e) {}
    lock.release();
  }
}
main().catch((e) => { console.log('FATAL ' + e.message); lock.release(); process.exit(1); });
