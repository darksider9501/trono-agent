#!/usr/bin/env node
/**
 * Generic read-only endpoint probe.
 *
 * Asks the game for a list of GET endpoints through the authenticated tab and
 * writes the raw payloads to one JSON file. Used to measure income surfaces
 * (world boss, dungeon, arena, quests) without mutating anything.
 *
 * It reuses lib/game and the driver lock instead of opening its own CDP client:
 * the production runner owns tab 9777 and a second driver invalidates the
 * session. It refuses to start while a driver is active, so the agent must be
 * stopped first.
 *
 *   node scripts/trono/probe.js --out logs/surfaces.json \
 *     --get /api/world_boss_event.php --get /api/group_arena.php
 */
const fs = require('fs');
const path = require('path');
const { Game } = require('./lib/game');
const lock = require('./lib/driverlock');
const credentials = require('./lib/credentials');

function parseArgs(argv) {
  const out = { out: path.join(__dirname, 'logs', 'probe.json'), gets: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(__dirname, '..', '..', argv[(i += 1)] || out.out);
    else if (a === '--get') out.gets.push(argv[(i += 1)]);
    else if (a.startsWith('/')) out.gets.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.gets.length) {
    console.log('nothing to probe — pass at least one --get /api/...');
    process.exit(2);
  }

  const held = lock.current();
  if (held) {
    console.log(`driver busy (pid ${held.pid}, ${held.name}) — stop the agent and retry`);
    process.exit(2);
  }
  if (!lock.acquire('probe')) {
    console.log('could not acquire the driver lock');
    process.exit(2);
  }

  let g = null;
  const results = [];
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

    for (const p of args.gets) {
      const r = await g.apiGet(p).catch((e) => ({ ok: false, error: e.message }));
      const entry = {
        path: p,
        ok: !!(r && r.ok),
        data: r && r.ok ? r.data : undefined,
        error: r && !r.ok ? r.message || r.error || 'failed' : undefined
      };
      // A compact line per endpoint keeps the console readable while the raw
      // payload goes to the file.
      const size = entry.data === undefined ? 0 : JSON.stringify(entry.data).length;
      console.log(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${p}  ${entry.ok ? size + ' bytes' : entry.error}`);
      results.push(entry);
    }

    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    console.log(`\nwritten to ${args.out}`);
  } finally {
    if (g) {
      try {
        g.close();
      } catch (_) {
        // A failed close must not hide the result.
      }
    }
    lock.release();
  }
}

main().catch((e) => {
  console.error(`probe failed: ${e.message}`);
  process.exit(1);
});
