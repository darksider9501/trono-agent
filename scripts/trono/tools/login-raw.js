/**
 * Look at the login POST's RAW response: status, Location, Set-Cookie.
 *
 * `fetch` with redirect:'follow' hides a 302 behind a 200 and rewrites res.url,
 * so a successful login that redirects looks exactly like a re-rendered landing.
 * Read it manually, with redirect:'manual', and print the headers instead of
 * guessing from the body.
 */
const security = require('../lib/security');
const { DEFAULT_UA, BASE } = require('../lib/httptransport');
const credentials = require('../lib/credentials');

const csrfRe = new RegExp('<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"', 'i');

function headerDump(res, label) {
  const h = {};
  for (const [k, v] of res.headers) h[k] = v;
  console.log(`\n  --- ${label} ---`);
  console.log(`    status : ${res.status} ${res.statusText}`);
  console.log(`    url    : ${res.url}`);
  for (const k of ['location', 'set-cookie', 'content-type', 'content-length', 'server', 'cache-control']) {
    if (h[k]) console.log(`    ${k.padEnd(15)}: ${String(h[k]).slice(0, 220)}`);
  }
  const others = Object.keys(h).filter((k) => !['location', 'set-cookie', 'content-type', 'content-length', 'server', 'cache-control'].includes(k));
  if (others.length) console.log(`    otros   : ${others.join(', ')}`);
  return h;
}

async function jar() {
  const out = [];
  const set = (line) => {
    const name = line.split('=')[0].trim();
    const value = line.split(';')[0].slice(name.length + 1).trim();
    if (!name || !value) return;
    const ex = out.find((c) => c.name === name);
    if (ex) ex.value = value;
    else out.push({ name, value });
  };
  const header = () => out.map((c) => `${c.name}=${c.value}`).join('; ');
  return { out, set, header };
}

async function go(label, { manual }) {
  const j = await jar();
  const common = {
    'user-agent': DEFAULT_UA,
    'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  // landing
  let res = await fetch(BASE + '/', { headers: { ...common }, redirect: 'follow' });
  const html = await res.text();
  for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) j.set(line);
  headerDump(res, label + ' / GET landing');
  const csrf = (csrfRe.exec(html) || [])[1];
  console.log(`    cookie en jar : ${j.header() || 'NINGUNA'}`);
  console.log(`    csrf          : ${csrf ? csrf.slice(0, 12) + '...' : 'NO'}`);

  const c = credentials.load();
  const body = new URLSearchParams({ csrf, username: c.username, password: c.password, remember: '1' }).toString();

  res = await fetch(BASE + '/', {
    method: 'POST',
    headers: {
      ...common,
      'content-type': 'application/x-www-form-urlencoded',
      referer: BASE + '/',
      origin: BASE,
      cookie: j.header()
    },
    body,
    redirect: manual ? 'manual' : 'follow'
  });
  const h = headerDump(res, label + ' / POST login (redirect:' + (manual ? 'manual' : 'follow') + ')');
  for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) j.set(line);
  console.log(`    cookie en jar : ${j.header() || 'NINGUNA'}`);
  const txt = await res.text();
  console.log(`    body len      : ${txt.length}`);
  console.log(`    body inicio   : ${txt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 150)}`);

  // now test auth with whatever cookie we hold
  let auth = 'NO';
  try {
    const r2 = await fetch(BASE + '/api/player_state.php', {
      headers: { ...common, accept: 'application/json', cookie: j.header(), referer: BASE + '/pages/overview.php' }
    });
    const t2 = await r2.text();
    let parsed = null;
    try { parsed = JSON.parse(t2); } catch (_) {}
    auth = r2.status + (parsed && parsed.state && parsed.state.player ? ' AUTH OK ' + parsed.state.player.username : ' no-auth');
  } catch (e) {
    auth = 'ERR ' + e.message;
  }
  console.log(`    API tras login: ${auth}`);
  return manual ? h : null;
}

(async () => {
  await go('A', { manual: false });
  await go('B', { manual: true });
})();
