/**
 * Manual redirect chain with cookie capture at EVERY hop.
 *
 * `fetch({redirect:'follow'})` collapses the whole chain into one response. The
 * only Set-Cookie the caller ever sees is the last hop's. If the login answers
 * 302 with the authenticated session on it (PHP's session_regenerate_id) and the
 * redirect target re-issues an ANONYMOUS cookie, following blindly throws away
 * the real session and keeps the empty one.
 *
 * That is exactly the shape observed: credentials accepted (cookie rotates),
 * API still 401.
 */
const { DEFAULT_UA, BASE } = require('../lib/httptransport');
const credentials = require('../lib/credentials');

const csrfRe = new RegExp('<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"', 'i');

const HEADERS = {
  'user-agent': DEFAULT_UA,
  'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

function makeJar() {
  const out = [];
  return {
    absorb(headers) {
      const list = headers.getSetCookie ? headers.getSetCookie() : [];
      for (const line of list) {
        const first = line.split(';')[0];
        const eq = first.indexOf('=');
        if (eq < 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        const pathM = /;\s*path=([^;]+)/i.exec(line);
        const path = pathM ? pathM[1].trim() : '/';
        if (/^deleted$/i.test(value)) {
          const i = out.findIndex((c) => c.name === name && c.path === path);
          if (i >= 0) out.splice(i, 1);
          continue;
        }
        const ex = out.find((c) => c.name === name && c.path === path);
        if (ex) ex.value = value;
        else out.push({ name, value, path });
      }
    },
    header(url) {
      const u = new URL(url);
      return out
        .filter((c) => u.pathname.startsWith(c.path))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    },
    dump() {
      return out.map((c) => `${c.name}=${String(c.value).slice(0, 12)}(path ${c.path})`).join(', ') || 'VACIO';
    }
  };
}

/** Fetch following redirects BY HAND, absorbing cookies on every hop. */
async function chain(url, opts, jar) {
  let cur = url;
  let method = opts.method || 'GET';
  let body = opts.body;
  const hops = [];

  for (let i = 0; i < 8; i++) {
    const res = await fetch(cur, {
      method,
      headers: { ...HEADERS, ...(opts.headers || {}), cookie: jar.header(cur) },
      body,
      redirect: 'manual'
    });
    const setc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    jar.absorb(res.headers);
    hops.push({
      url: cur,
      status: res.status,
      location: res.headers.get('location'),
      setCookie: setc.map((c) => c.split(';')[0])
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { hops, final: null };
      cur = new URL(loc, cur).href;
      // A redirect after a POST: browsers switch to GET.
      if (res.status === 303 || res.status === 302 || res.status === 301) {
        method = 'GET';
        body = undefined;
        opts.headers = {};
      }
      continue;
    }
    const text = await res.text();
    return { hops, final: { url: cur, status: res.status, text } };
  }
  return { hops, final: null };
}

(async () => {
  const jar = makeJar();
  const creds = credentials.load();

  // 1. landing
  const land = await chain(BASE + '/', {}, jar);
  console.log('=== landing ===');
  land.hops.forEach((h, i) => console.log(`  hop${i}: ${h.status} setCookie=[${h.setCookie}]`));
  console.log('  jar: ' + jar.dump());
  const csrf = (csrfRe.exec(land.final.text) || [])[1];
  console.log('  csrf: ' + (csrf ? 'si' : 'NO'));
  if (!csrf) process.exit(1);

  // 2. POST login
  const body = new URLSearchParams({ csrf, username: creds.username, password: creds.password, remember: '1' }).toString();
  const login = await chain(
    BASE + '/',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', referer: BASE + '/', origin: BASE },
      body
    },
    jar
  );

  console.log('\n=== POST login ===');
  login.hops.forEach((h, i) => {
    console.log(`  hop${i}: ${h.status}  ${h.url}`);
    if (h.location) console.log(`          location: ${h.location}`);
    if (h.setCookie.length) console.log(`          setCookie: ${h.setCookie.join(' | ')}`);
  });
  console.log('  jar final: ' + jar.dump());

  // 3. does the jar authenticate?
  const ps = await fetch(BASE + '/api/player_state.php', {
    headers: {
      ...HEADERS,
      accept: 'application/json',
      cookie: jar.header(BASE + '/'),
      referer: BASE + '/pages/overview.php'
    }
  });
  const psText = await ps.text();
  let parsed = null;
  try { parsed = JSON.parse(psText); } catch (_) {}
  const ok = !!(parsed && parsed.state && parsed.state.player);
  console.log('\n=== API ===');
  console.log('  status: ' + ps.status);
  console.log('  auth  : ' + (ok ? 'OK ' + parsed.state.player.username + ' lv' + parsed.state.hero.hero_level + ' gold ' + parsed.state.economy.gold : 'NO'));
  if (!ok) console.log('  body  : ' + psText.slice(0, 160));
})();
