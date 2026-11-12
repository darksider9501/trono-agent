#!/usr/bin/env node
/**
 * Read-only market probe.
 *
 * Dumps the player market through /api/market_search.php and writes the raw
 * payload to logs/market-probe.json. It never buys, sells or bids: the endpoint
 * is a public GET, so this costs nothing and changes nothing.
 *
 * It refuses to run while a driver is active. The production runner owns the tab
 * at CDP 9777 and a second driver invalidates the session, so this must be run
 * with the agent stopped:
 *
 *   node scripts/trono/market-probe.js [maxPages]
 *
 * Sort is price-asc, which is what a spread analysis needs: the cheapest listing
 * of each item type is the real ask, and the gap to the next one is the depth.
 */
const fs = require('fs');
const path = require('path');
const { Game } = require('./lib/game');
const lock = require('./lib/driverlock');
const credentials = require('./lib/credentials');

const OUT = path.join(__dirname, 'logs', 'market-probe.json');

function keysOf(items) {
  const set = new Set();
  for (const it of items) for (const k of Object.keys(it || {})) set.add(k);
  return [...set].sort();
}

async function main() {
  const held = lock.current();
  if (held) {
    console.log(`driver busy (pid ${held.pid}, ${held.name}) — stop the agent and retry`);
    process.exit(2);
  }
  if (!lock.acquire('market-probe')) {
    console.log('could not acquire the driver lock');
    process.exit(2);
  }

  let g = null;
  try {
    g = await Game.connect({ spawn: true });
    if (!(await g.isLoggedIn())) {
      const creds = credentials.load();
      if (!creds) throw new Error('no credentials available');
      const res = await g.login(creds);
      if (!res || !res.ok) throw new Error(`login failed: ${(res && (res.error || res.message)) || 'unknown'}`);
      console.log('logged in');
    } else {
      console.log('session already alive');
    }

    const maxPages = Math.max(1, Number(process.argv[2] || 12));
    const perPage = 24;
    const pages = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const qs = `?page=${page}&per_page=${perPage}&q=&category=all&rarity=all&slot=all&sort=price-asc`;
      const r = await g.apiGet(`/api/market_search.php${qs}`);
      if (!r || !r.ok || !r.data) {
        console.log(`page ${page} failed: ${(r && (r.message || r.error)) || 'no data'}`);
        break;
      }
      pages.push(r.data);
      if (page >= Number(r.data.total_pages || 1)) break;
    }

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), pages }, null, 2));

    const first = pages[0] || {};
    const items = pages.flatMap((p) => p.items || []);
    console.log(`\n=== market snapshot ===`);
    console.log(`  pages read: ${pages.length}  total listings: ${first.total ?? '?'}  total_pages: ${first.total_pages ?? '?'}`);
    console.log(`  items captured: ${items.length}`);
    console.log(`  category_counts: ${JSON.stringify(first.category_counts || {})}`);
    console.log(`\n  item fields: ${keysOf(items).join(', ')}`);
    if (items[0]) console.log(`\n  first item: ${JSON.stringify(items[0]).slice(0, 700)}`);
    console.log(`\n  written to ${OUT}`);
  } finally {
    if (g) {
      try {
        await g.close();
      } catch (_) {
        // A failed close must not hide the result.
      }
    }
    lock.release();
  }
}

main().catch((e) => {
  console.error(`market probe failed: ${e.message}`);
  process.exit(1);
});
