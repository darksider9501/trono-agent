/**
 * Structural explorer: maps every game section into machine-readable JSON.
 *
 * For each page it records:
 *   - every API endpoint referenced (data-api / data-*-url / inline fetch)
 *   - every form: action, method, fields, submit label
 *   - every data-* config attribute with a short value (economy knobs live there)
 *   - the cleaned main text (human summary)
 *
 * READ ONLY: it never submits anything.
 *
 *   node scripts/trono/explore.js --discover            # all nav sections
 *   node scripts/trono/explore.js --only=buildings      # one group
 *   node scripts/trono/explore.js --url=/pages/bosses.php
 */
const fs = require('fs');
const path = require('path');
const { Game, sleep } = require('./lib/game');
const lock = require('./lib/driverlock');

const OUT_DIR = path.join(__dirname, 'state', 'sections');
const JSON_OUT = path.join(__dirname, 'state', 'sections.json');

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const singleUrl = (args.find((a) => a.startsWith('--url=')) || '').split('=')[1] || null;

const BUILDING_VIEWS = ['fortress', 'gold_mine', 'mana_sanctum', 'essence_well', 'relic_vault', 'workshop', 'walls', 'smithy', 'rest_camp', 'arcane_tower', 'hospital', 'stable'];

function extract(page) {
  const html = page.html;
  const main = (html.match(/<main[\s\S]*?<\/main>/i) || [])[0] || html;

  const endpoints = new Set();
  for (const m of html.matchAll(/data-api="([^"]+)"/g)) endpoints.add(m[1]);
  for (const m of html.matchAll(/data-[a-z-]*url="(\/api\/[^"]+)"/g)) endpoints.add(m[1]);
  for (const m of html.matchAll(/["'](\/api\/[a-z_0-9]+\.php)["']/g)) endpoints.add(m[1]);
  for (const m of html.matchAll(/["'](\/actions\/[a-z_0-9]+\.php)["']/g)) endpoints.add(m[1]);

  const forms = [...main.matchAll(/<form[\s\S]{0,2000}?<\/form>/g)].map((f) => {
    const html2 = f[0];
    const fields = [...html2.matchAll(/<(?:input|select)[^>]*name="([^"]+)"[^>]*?(?:value="([^"]*)")?[^>]*>/g)].map((x) => ({
      name: x[1],
      value: (x[2] || '').slice(0, 40)
    }));
    const btn = (html2.match(/<button[^>]*>([\s\S]*?)<\/button>/) || [])[1] || '';
    return {
      action: (html2.match(/action="([^"]*)"/) || [])[1] || '(self)',
      method: ((html2.match(/method="([^"]*)"/) || [])[1] || 'get').toLowerCase(),
      fields,
      button: btn.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50)
    };
  });

  const config = {};
  for (const m of main.matchAll(/data-([a-z-]{3,40})="([^"]{0,300})"/g)) {
    const k = m[1];
    if (/^(api|.*url|csrf|.*-csrf|visual|icon|asset|audio|signature)/.test(k)) continue;
    if (config[k] === undefined) config[k] = m[2].slice(0, 160);
  }

  const text = main
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    status: page.status,
    bytes: html.length,
    endpoints: [...endpoints],
    forms: forms.filter((f) => f.fields.length || f.button),
    config,
    text: text.slice(0, 4000)
  };
}

async function discover(g) {
  const page = await g.fetchPage('/pages/overview.php');
  const nav = page.html.match(/<aside[^>]*id="gameSidebar"[\s\S]*?<\/aside>/i) || page.html.match(/<nav[\s\S]*?<\/nav>/i);
  const scope = nav ? nav[0] : page.html;
  const hrefs = [...new Set([...scope.matchAll(/href="(\/pages\/[^"#]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&')))];
  return hrefs;
}

function groupOf(url) {
  const m = /\/pages\/([a-z_0-9]+)\.php/.exec(url);
  return m ? m[1] : 'other';
}

(async () => {
  const holder = lock.current();
  if (holder) {
    console.error(
      `another driver is active (pid ${holder.pid}, ${holder.name}). ` +
        `Stop it first: the game rotates the session instance and two drivers kill each other.`
    );
    process.exit(2);
  }
  const got = lock.acquire('explore');
  if (!got.ok) {
    console.error(`cannot acquire driver lock (pid ${got.holder.pid})`);
    process.exit(2);
  }

  const g = await Game.connect();
  try {
    let urls;
    if (singleUrl) {
      urls = [singleUrl];
    } else {
      const nav = await discover(g);
      urls = nav;
      // Buildings expose one view per building key: enumerate them explicitly.
      for (const view of BUILDING_VIEWS) urls.push(`/pages/buildings.php?view=${view}`);
      urls = [...new Set(urls)];
    }

    if (only) urls = urls.filter((u) => u.includes(only));

    let store = {};
    if (fs.existsSync(JSON_OUT)) {
      try {
        store = JSON.parse(fs.readFileSync(JSON_OUT, 'utf8'));
      } catch (e) {
        store = {};
      }
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });

    console.log(`exploring ${urls.length} pages` + (only ? ` (filter: ${only})` : ''));
    for (const url of urls) {
      const page = await g.fetchPage(url);
      const data = extract(page);
      const key = url.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '_');
      store[url] = { group: groupOf(url), exploredAt: new Date().toISOString(), ...data };
      fs.writeFileSync(path.join(OUT_DIR, `${key}.html`), page.html, 'utf8');
      console.log(`  ${url} -> ${data.bytes}B, ${data.endpoints.length} endpoints, ${data.forms.length} forms`);
      await sleep(250);
    }
    fs.writeFileSync(JSON_OUT, JSON.stringify(store, null, 2), 'utf8');
    console.log(`saved: ${JSON_OUT} (${Object.keys(store).length} entries)`);
  } finally {
    g.close();
    lock.release();
  }
})().catch((e) => {
  console.error(`ERROR ${e.code || ''} ${e.message}`);
  lock.release();
  process.exit(1);
});
