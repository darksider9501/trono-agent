/**
 * Defiende el Trono — asset/endpoint mapper (read-only).
 *
 * Downloads every referenced /assets/js/*.js through the authenticated tab,
 * then extracts the real action surface: /api/*.php endpoints, actions/*.php
 * handlers, and the params each one receives.
 *
 * Usage: node scripts/trono/assets.js --port=9777
 * Output: scripts/trono/state/js/<file>.js + state/endpoints.json
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { CdpSession, sleep } = require('../lib/cdp');

const PORT = parseInt((process.argv.find((a) => a.startsWith('--port=')) || '--port=9777').split('=')[1], 10);
const ROOT = path.join(__dirname, 'state');
const HOST = 'defiendeeltrono.com';

function httpGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

const FETCH_ASSET = `(async (u) => {
  const r = await fetch(u, { credentials: 'same-origin' });
  return { ok: r.ok, status: r.status, body: await r.text() };
})`;

async function main() {
  const targets = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page' && (t.url || '').includes(HOST));
  if (!page) throw new Error(`No ${HOST} tab on CDP ${PORT}`);

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

  fs.mkdirSync(path.join(ROOT, 'js'), { recursive: true });

  // 1. Collect asset URLs from every harvested page.
  const assets = new Set();
  const inlineRefs = new Set();
  const pageDir = path.join(ROOT, 'pages');
  if (!fs.existsSync(pageDir)) throw new Error('Run harvest.js first (no state/pages)');
  for (const f of fs.readdirSync(pageDir).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(pageDir, f), 'utf8');
    for (const m of html.matchAll(/<script[^>]+src="(\/assets\/[^"]+)"/g)) assets.add(m[1]);
    for (const m of html.matchAll(/fetch\(\s*["'\\]*([^"'\\\s)]+\.php[^"'\\\s)]*)/g)) inlineRefs.add(m[1]);
    for (const m of html.matchAll(/["'](\/api\/[a-z_0-9]+\.php)["']/g)) inlineRefs.add(m[1]);
  }

  // 2. Download.
  const endpoints = {};
  const addRef = (url, src) => {
    const key = url.replace(/^\/+/, '');
    if (!endpoints[key]) endpoints[key] = { url, sources: [] };
    if (!endpoints[key].sources.includes(src)) endpoints[key].sources.push(src);
  };

  const list = [...assets].sort();
  console.log(`Downloading ${list.length} assets...`);
  for (const a of list) {
    const r = await evalInPage(`${FETCH_ASSET}(${JSON.stringify(a)})`);
    if (!r.ok) {
      console.log(`FAIL ${a} ${r.status}`);
      continue;
    }
    const name = a.split('?')[0].replace(/^\//, '').replace(/\//g, '__');
    fs.writeFileSync(path.join(ROOT, 'js', name), r.body, 'utf8');
    for (const m of r.body.matchAll(/["'`](\/?(?:api|actions)\/[a-z_0-9]+\.php)["'`]/g)) addRef(m[1], name);
    for (const m of r.body.matchAll(/fetch\(\s*["'`](\/[^"'`\s]+)["'`]/g)) addRef(m[1], name);
    await sleep(250 + Math.random() * 500);
  }

  for (const u of inlineRefs) addRef(u, 'inline');

  // 3. Inline actions posted from page markup.
  for (const f of fs.readdirSync(pageDir).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(pageDir, f), 'utf8');
    for (const m of html.matchAll(/(?:action|data-api|data-url|data-endpoint)="([^"]*(?:api|actions)\/[a-z_0-9]+\.php)"/g)) {
      addRef(m[1], 'page:' + f.replace('.html', ''));
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    assetCount: list.length,
    endpoints: Object.entries(endpoints)
      .map(([k, v]) => ({ path: k, url: v.url, sources: v.sources }))
      .sort((a, b) => a.path.localeCompare(b.path))
  };
  fs.writeFileSync(path.join(ROOT, 'endpoints.json'), JSON.stringify(out, null, 2), 'utf8');

  console.log(`\n${out.endpoints.length} endpoints:`);
  for (const e of out.endpoints) console.log(`  ${e.path}  <- ${e.sources.slice(0, 3).join(', ')}`);
  session.close();
}

main().catch((e) => {
  console.error('ASSETS ERROR:', e.message);
  process.exit(1);
});
