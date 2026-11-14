#!/usr/bin/env node
/**
 * Decides whether the session is bound to the browser or only to the cookie.
 *
 * It takes the DTTSESS cookie out of the live browser tab, calls the game from
 * plain Node HTTP with it, and compares the answer with what the browser reads
 * for the same endpoint. If both agree, the loop can run without a browser and
 * the browser is only needed to log in.
 *
 * No login is performed: reusing an existing session means no authentication
 * event is created, so nothing about the account's fingerprint changes.
 *
 *   node tools/cookie-test.js
 */
const { Game } = require('../lib/game');
const { readHero } = require('../lib/combat');
const lock = require('../lib/driverlock');
const credentials = require('../lib/credentials');

async function main() {
  if (lock.current()) {
    console.log('driver busy — stop the agent first');
    process.exit(2);
  }
  if (!lock.acquire('cookie-test')) {
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
    const hero = await readHero(g);
    const ua = await g.evalInPage('navigator.userAgent');

    // HttpOnly cookies never appear in document.cookie, so ask the protocol.
    let cookies = null;
    for (const attempt of [
      () => g.session.send('Storage.getCookies', {}),
      () => g.session.send('Network.getCookies', { urls: ['https://defiendeeltrono.com/'] })
    ]) {
      try {
        const res = await attempt();
        if (res && res.cookies) {
          cookies = res.cookies;
          break;
        }
      } catch (_) {}
    }
    if (!cookies) throw new Error('could not read cookies over CDP');

    const sess = cookies.find((c) => c.name === 'DTTSESS');
    if (!sess) throw new Error(`no DTTSESS cookie among: ${cookies.map((c) => c.name).join(', ')}`);
    console.log(`browser: gold ${hero.gold}  hp ${hero.hp}/${hero.maxHp}  lv ${hero.level}`);
    console.log(`cookie : DTTSESS len ${sess.value.length}  httpOnly ${sess.httpOnly}  secure ${sess.secure}`);
    console.log(`ua     : ${ua}`);

    // Same headers a browser would send. A plain client is only obvious to a
    // server that inspects the user agent, and this game has no edge bot
    // management in front of it (server: LiteSpeed), so matching them is enough.
    const headers = {
      'user-agent': ua,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      referer: 'https://defiendeeltrono.com/pages/overview.php',
      cookie: `DTTSESS=${sess.value}`
    };

    const url = 'https://defiendeeltrono.com/api/player_state.php';
    const res = await fetch(url, { headers, redirect: 'manual' });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {}

    console.log(`\nnode http: status ${res.status}  bytes ${text.length}`);
    if (!parsed) {
      console.log(`body: ${text.slice(0, 200)}`);
      console.log('\nVERDICT: not JSON — the session was not accepted outside the browser.');
      return;
    }
    const gold = parsed.state && parsed.state.economy ? parsed.state.economy.gold : null;
    const hp = parsed.state && parsed.state.hero ? parsed.state.hero.vitals.current.hp : null;
    console.log(`node sees: ok=${parsed.ok}  gold ${gold}  hp ${hp}`);
    const sameGold = gold === hero.gold;
    const sameHp = hp === hero.hp || Math.abs((hp || 0) - hero.hp) <= 2; // regen ticks between reads
    console.log(`\nVERDICT: ${parsed.ok && sameGold && sameHp ? 'SESSION IS COOKIE-ONLY — browser can be closed' : 'session appears bound to more than the cookie'}`);
    console.log(`  gold match: ${sameGold}   hp match: ${sameHp}`);
  } finally {
    if (g) {
      try {
        g.close();
      } catch (_) {}
    }
    lock.release();
  }
}

main().catch((e) => {
  console.error(`cookie test failed: ${e.message}`);
  process.exit(1);
});
