/**
 * Daily quests reader for Defiende el Trono (read-only).
 *
 * Daily quests are the highest-value free income: they reset at 09:00 server time,
 * feed the activity bar (20/40/60/80/100 -> 15 gold + 25 EXP each), and cost no HP.
 *
 *   node scripts/trono/dailies.js            # inventory + what can be claimed
 *   node scripts/trono/dailies.js --json
 */
const { Game } = require('./lib/game');

const asJson = process.argv.includes('--json');

const BASE = '/pages/quests_main.php?cat=diarias';

function parseRows(html) {
  const rows = [];
  const re = /<a[^>]*class="qb-row[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]{0,1400}?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const href = m[1].replace(/&amp;/g, '&');
    const body = m[2];
    const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const title = (body.match(/qb-row__title[^>]*>([\s\S]*?)</) || [])[1];
    const badges = [...body.matchAll(/qb-badge[^>]*>([\s\S]*?)</g)].map((b) => clean(b[1]));
    const sel = /sel=([a-z0-9_]+)/.exec(href);
    rows.push({
      key: sel ? sel[1] : null,
      href,
      title: clean(title),
      badges,
      state: /estado=(\w+)/.exec(href)?.[1] || null
    });
  }
  return rows;
}

function parseDetail(html) {
  const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const section = html.match(/id="mission-detail"[\s\S]*?<\/section>/);
  const chunk = section ? section[0] : '';
  const text = clean(chunk).slice(0, 900);
  const forms = [...chunk.matchAll(/<form[\s\S]{0,1200}?<\/form>/g)].map((f) => {
    const fields = [...f[0].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)].map((x) => `${x[1]}=${x[2]}`);
    const btn = clean((f[0].match(/<button[^>]*>([\s\S]*?)<\/button>/) || [])[1]);
    const action = /action="([^"]*)"/.exec(f[0])?.[1] || '(self)';
    return { action, fields, btn };
  });
  return { text, forms, hasForms: forms.length > 0 };
}

(async () => {
  const g = await Game.connect();
  try {
    const page = await g.fetchPage(BASE);
    if (!page.ok) throw new Error(`quests page HTTP ${page.status}`);
    const rows = parseRows(page.html);
    const progress = page.text.match(/ACTIVIDAD DIARIA\s*(\d+)\s*\/\s*(\d+)/i);

    const out = {
      activity: progress ? `${progress[1]}/${progress[2]}` : null,
      quests: []
    };

    for (const row of rows.slice(0, 12)) {
      const detail = await g.fetchPage(row.href.replace(/^\//, '/'));
      const parsed = detail.ok ? parseDetail(detail.html) : { text: '', forms: [] };
      out.quests.push({ ...row, detail: parsed });
    }

    if (asJson) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (process.argv.includes('--text')) {
      const main = page.html.match(/<main[\s\S]*?<\/main>/i);
      const text = (main ? main[0] : page.html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      console.log(text.slice(0, 3000));
      return;
    }

    console.log(`actividad diaria: ${out.activity || '?'}`);
    console.log(`misiones diarias: ${out.quests.length}`);
    for (const q of out.quests) {
      console.log(`\n- ${q.title || q.key}  [${(q.badges || []).join(' | ')}]`);
      if (q.detail.text) console.log(`  ${q.detail.text.slice(0, 260)}`);
      for (const f of q.detail.forms) {
        console.log(`  form ${f.action} :: ${f.fields.join('&')}  -> "${f.btn}"`);
      }
    }
    if (!out.quests.length) console.log('(no daily quest rows parsed — check selectors)');
  } finally {
    g.close();
  }
})().catch((e) => {
  console.error(`ERROR ${e.code || ''} ${e.message}`);
  process.exit(1);
});
