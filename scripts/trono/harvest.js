/**
 * Defiende el Trono — read-only page harvester.
 *
 * Reads every game page through the authenticated CloakBrowser tab (CDP 9777)
 * using same-origin fetch INSIDE the page, so cookies, CSRF and the browser
 * fingerprint stay intact. No navigation, no clicks, no state mutation.
 *
 * Usage:
 *   node scripts/trono/harvest.js --port=9777 [--max=60] [--only=quests,map]
 *
 * Output:
 *   scripts/trono/state/pages/<slug>.html   raw server HTML
 *   scripts/trono/state/text/<slug>.txt     visible text
 *   scripts/trono/state/index.json          machine summary (forms/buttons/links)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { CdpSession, sleep } = require('../lib/cdp');

const PORT = parseInt(argOf('--port', '9777'), 10);
const MAX = parseInt(argOf('--max', '60'), 10);
const ONLY = argOf('--only', '');
const ROOT = path.join(__dirname, 'state');
const HOST = 'defiendeeltrono.com';

const SEEDS = [
  '/pages/overview.php',
  '/pages/heroes.php',
  '/pages/inventory.php',
  '/pages/quests_main.php',
  '/pages/map.php',
  '/pages/dungeon.php',
  '/pages/bosses.php',
  '/pages/arena.php',
  '/pages/skills.php',
  '/pages/talents.php',
  '/pages/runes.php',
  '/pages/buildings.php?view=smithy',
  '/pages/buildings.php?view=rest_camp',
  '/pages/buildings.php?view=arcane_tower',
  '/pages/buildings.php?view=hospital',
  '/pages/buildings.php?view=stable',
  '/pages/kingdoms.php',
  '/pages/market.php',
  '/pages/consumables.php',
  '/pages/player_market.php',
  '/pages/auctions.php',
  '/pages/shop.php',
  '/pages/wallet.php',
  '/pages/economy.php',
  '/pages/streamers.php',
  '/pages/friends.php',
  '/pages/groups.php',
  '/pages/messages.php',
  '/pages/ranking.php',
  '/pages/events.php',
  '/pages/profile.php',
  '/pages/referrals.php',
  '/pages/support.php',
  '/pages/news.php',
  '/pages/feedback.php',
  '/pages/options.php',
  '/pages/account.php'
];

function argOf(flag, def) {
  const hit = process.argv.find((a) => a.startsWith(flag + '='));
  return hit ? hit.slice(flag.length + 1) : def;
}

function slug(url) {
  return url
    .replace(/^\/?pages\//, '')
    .replace(/^\/?auth\//, 'auth-')
    .replace(/^\/+/, '')
    .replace(/\.php.*$/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-');
}

function httpGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout ' + url));
    });
  });
}

const EXTRACT = `(async (u) => {
  try {
    const res = await fetch(u, { credentials: 'same-origin', headers: { 'Accept': 'text/html' } });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const forms = [...doc.querySelectorAll('form')].map((f) => ({
      action: f.getAttribute('action'),
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fields: [...f.elements].map((e) => ({
        tag: e.tagName.toLowerCase(),
        type: e.type || null,
        name: e.name || null,
        id: e.id || null,
        value: (e.value || '').slice(0, 40),
        text: e.tagName === 'BUTTON' ? clean(e.textContent).slice(0, 40) : null,
        disabled: !!e.disabled
      }))
    }));
    const buttons = [...doc.querySelectorAll('button, [role=button], input[type=submit]')].map((b) => ({
      text: clean(b.textContent || b.value).slice(0, 60),
      cls: (b.className || '').toString().slice(0, 60),
      disabled: !!b.disabled,
      data: [...b.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + '=' + a.value.slice(0, 40))
    }));
    const links = [...new Set([...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')))]
      .filter((h) => h && !h.startsWith('#') && !h.startsWith('mailto') && !h.match(/^https?:\\/\\/(?!defiendeeltrono)/));
    const headings = [...doc.querySelectorAll('h1,h2,h3')].map((h) => clean(h.textContent).slice(0, 70));
    const text = clean(doc.body ? doc.body.innerText || doc.body.textContent : '');
    return {
      ok: res.ok, status: res.status, bytes: html.length, html,
      title: clean(doc.title), forms, buttons, links, headings, text
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
})`;

async function main() {
  const targets = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page' && (t.url || '').includes(HOST));
  if (!page) throw new Error(`No ${HOST} tab found on CDP ${PORT}. Is the game profile open?`);

  const session = new CdpSession(page.webSocketDebuggerUrl);
  await session.connect();
  await session.send('Runtime.enable');

  const evalInPage = async (expr) => {
    const res = await session.send(
      'Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30000 },
      40000
    );
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'eval failed');
    return res.result.value;
  };

  for (const d of ['pages', 'text']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

  const queue = [...new Set(SEEDS)].filter((u) => !ONLY || ONLY.split(',').some((k) => u.includes(k)));
  const seen = new Set();
  const index = [];
  let fetched = 0;

  while (queue.length && fetched < MAX) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const r = await evalInPage(`${EXTRACT}(${JSON.stringify(url)})`);
    fetched += 1;
    const name = slug(url);

    if (!r.ok) {
      index.push({ url, name, ok: false, status: r.status || null, error: r.error || `HTTP ${r.status}` });
      console.log(`FAIL ${url} ${r.error || r.status}`);
      await sleep(800 + Math.random() * 1200);
      continue;
    }

    fs.writeFileSync(path.join(ROOT, 'pages', name + '.html'), r.html, 'utf8');
    fs.writeFileSync(path.join(ROOT, 'text', name + '.txt'), r.text, 'utf8');
    delete r.html;
    index.push({ url, name, ...r, text: r.text.slice(0, 400) });

    for (const l of r.links) {
      if (!l.startsWith('/pages/') && !l.startsWith('/auth/')) continue;
      if (l.startsWith('/auth/logout')) continue;
      if (!seen.has(l) && !queue.includes(l)) queue.push(l);
    }

    console.log(
      `OK   ${name.padEnd(28)} ${String(r.bytes).padStart(7)}B forms=${r.forms.length} links=${r.links.length}`
    );
    await sleep(700 + Math.random() * 1500);
  }

  fs.writeFileSync(
    path.join(ROOT, 'index.json'),
    JSON.stringify({ harvestedAt: new Date().toISOString(), port: PORT, count: index.length, pages: index }, null, 2),
    'utf8'
  );
  session.close();
  console.log(`\nDone: ${index.length} pages -> ${ROOT}`);
}

main().catch((e) => {
  console.error('HARVEST ERROR:', e.message);
  process.exit(1);
});
