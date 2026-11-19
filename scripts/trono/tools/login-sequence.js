/**
 * The login rotates DTTSESS (proven: a wrong password does not), yet the API
 * answers 401. So the session is CREATED but not yet usable.
 *
 * Hypothesis: the API requires the session to be promoted by loading a game
 * page first — the browser always does that before any fetch. Test the
 * sequence, and the browser-only headers along with it.
 */
const { GameHttp, DEFAULT_UA, BASE } = require('../lib/httptransport');
const credentials = require('../lib/credentials');

const csrfRe = new RegExp('<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"', 'i');

/** Headers a real Chrome sends that a bare fetch does not. */
const CHROME = {
  'sec-ch-ua': '"Chromium";v="146", "Not(A:Brand";v="24", "Google Chrome";v="146"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  'upgrade-insecure-requests': '1',
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
};

async function run(label, { chrome, visitPage }) {
  const g = new GameHttp({ ua: DEFAULT_UA, cookies: [] });
  const c = credentials.load();

  const landHeaders = chrome ? CHROME : { accept: 'text/html,application/xhtml+xml' };
  const landing = await g._fetch('/', { headers: landHeaders });
  const csrf = (csrfRe.exec(landing.text) || [])[1];

  const body = new URLSearchParams({ csrf, username: c.username, password: c.password, remember: '1' }).toString();
  const res = await g._fetch('/', {
    method: 'POST',
    headers: {
      ...(chrome ? CHROME : {}),
      'content-type': 'application/x-www-form-urlencoded',
      accept: chrome ? CHROME.accept : 'text/html,application/xhtml+xml',
      referer: BASE + '/',
      origin: BASE,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-user': '?1',
      'sec-fetch-dest': 'document'
    },
    body
  });

  const cookie = g.cookies.map((x) => `${x.name}=${String(x.value).slice(0, 10)}`).join(',');

  let pageNote = '';
  if (visitPage) {
    const p = await g.fetchPage(visitPage);
    pageNote = `page ${visitPage}: ok=${p.ok} status=${p.status} loggedIn=${/sessionIdleConfig|gameSidebar/.test(p.html)}`;
  }

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
  console.log(`    post   : status=${res.status} len=${res.text.length}`);
  console.log(`    cookie : ${cookie}`);
  if (pageNote) console.log(`    ${pageNote}`);
  console.log(`    auth   : ${auth ? 'OK ' + detail : 'NO ' + detail}`);
  return auth;
}

(async () => {
  await run('solo POST (control)', {});
  await run('POST + headers Chrome', { chrome: true });
  await run('POST + visitar overview antes del API', { visitPage: '/pages/overview.php' });
  await run('POST + Chrome + visitar overview', { chrome: true, visitPage: '/pages/overview.php' });
})();
