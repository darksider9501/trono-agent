/**
 * Compare the landing page against the login POST response, and try the header
 * variants that a PHP anti-bot or a CSRF guard might require.
 *
 * Read-only in spirit: it only submits the login form, never a game mutation.
 */
const { GameHttp, DEFAULT_UA, BASE } = require('../lib/httptransport');
const credentials = require('../lib/credentials');

const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const csrfRe = new RegExp('<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"', 'i');

/** Lines of visible text that are in b but not in a. */
function diffText(a, b) {
  const ta = strip(a).split(/(?<=[.!?])\s+/);
  const sb = new Set(ta);
  return strip(b)
    .split(/(?<=[.!?])\s+/)
    .filter((x) => x.length > 3 && !sb.has(x));
}

async function attempt(label, { referer, extraHeaders, remember }) {
  const g = new GameHttp({ ua: DEFAULT_UA, cookies: [] });
  const landing = await g._fetch('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
  const csrf = (csrfRe.exec(landing.text) || [])[1];
  const creds = credentials.load();

  const body = new URLSearchParams({
    csrf,
    username: creds.username,
    password: creds.password,
    ...(remember ? { remember: '1' } : {})
  }).toString();

  const res = await g._fetch('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml',
      ...(referer ? { referer } : {}),
      ...(extraHeaders || {})
    },
    body
  });

  const logged = res.text.includes('sessionIdleConfig') || res.text.includes('gameSidebar');
  const csrfAfter = (csrfRe.exec(res.text) || [])[1];
  const cookies = g.cookies.map((c) => c.name).join(',');

  console.log(`\n  [${label}]`);
  console.log(`    status=${res.status} len=${res.text.length} loggedIn=${logged}`);
  console.log(`    url final: ${res.url}`);
  console.log(`    cookies  : ${cookies}`);
  console.log(`    csrf rotado: ${csrfAfter && csrfAfter !== csrf ? 'SI' : 'no'}`);
  if (!logged) {
    const d = diffText(landing.text, res.text).slice(0, 4);
    d.forEach((x) => console.log(`    + "${strip(x).slice(0, 150)}"`));
  }
  return logged;
}

(async () => {
  console.log('  referer actual del codigo: ' + BASE + '/pages/overview.php');
  console.log('  (un login real viene de la landing, no de overview)');

  await attempt('referer = overview.php (actual)', { referer: BASE + '/pages/overview.php', remember: true });
  await attempt('referer = / (landing)', { referer: BASE + '/', remember: true });
  await attempt('sin referer', { remember: true });
  await attempt('referer=/ + X-Requested-With', {
    referer: BASE + '/',
    extraHeaders: { 'x-requested-with': 'XMLHttpRequest' },
    remember: true
  });
  await attempt('referer=/ sin remember', { referer: BASE + '/', remember: false });
})();
