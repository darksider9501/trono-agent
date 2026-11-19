/**
 * Does the login POST need `X-Game-View: 1`?
 *
 * lib/httptransport.js states that without this header the server answers the
 * public landing "even with a valid session". The login POST does not send it.
 * If that header is what promotes the request from anonymous-visitor to game
 * client, its absence explains a session that rotates the cookie but never
 * authenticates.
 */
const { GameHttp, DEFAULT_UA, BASE } = require('../lib/httptransport');
const credentials = require('../lib/credentials');

const csrfRe = new RegExp('<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"', 'i');

async function attempt(label, { postHeaders, postPath = '/', landingHeaders }) {
  const g = new GameHttp({ ua: DEFAULT_UA, cookies: [] });
  const landing = await g._fetch('/', {
    headers: { accept: 'text/html,application/xhtml+xml', ...(landingHeaders || {}) }
  });
  const csrf = (csrfRe.exec(landing.text) || [])[1];
  const c = credentials.load();

  const body = new URLSearchParams({ csrf, username: c.username, password: c.password, remember: '1' }).toString();
  const res = await g._fetch(postPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml',
      referer: BASE + '/',
      ...(postHeaders || {})
    },
    body
  });

  let auth = false;
  let detail = '';
  try {
    const ps = await g.apiGet('/api/player_state.php');
    auth = !!(ps && ps.ok && ps.state && ps.state.player);
    if (auth) detail = `${ps.state.player.username} lv${ps.state.hero.hero_level} gold ${ps.state.economy.gold}`;
  } catch (e) {
    detail = e.message;
  }

  console.log(`\n  [${label}]`);
  console.log(`    post  : status=${res.status} len=${res.text.length} path=${postPath}`);
  console.log(`    auth  : ${auth ? 'OK — ' + detail : 'NO — ' + detail}`);
  return auth;
}

(async () => {
  await attempt('baseline (sin X-Game-View)', {});
  await attempt('POST + X-Game-View: 1', { postHeaders: { 'x-game-view': '1' } });
  await attempt('POST + X-Game-View en landing y POST', {
    landingHeaders: { 'x-game-view': '1' },
    postHeaders: { 'x-game-view': '1' }
  });
  await attempt('POST a /index.php + X-Game-View', {
    postPath: '/index.php',
    postHeaders: { 'x-game-view': '1' }
  });
})();
