/**
 * Discriminate WHY the login POST is ignored.
 *
 * If a deliberately WRONG password produces the exact same response as the real
 * one, the server never evaluated the credentials at all: the POST is being
 * dropped before authentication (wrong endpoint, missing header, or a mechanism
 * the browser supplies and we do not). If the wrong password DOES produce a
 * different message, then the POST is processed and our real credential is the
 * thing being rejected.
 */
const { GameHttp, DEFAULT_UA, BASE } = require('../lib/httptransport');
const credentials = require('../lib/credentials');

const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const csrfRe = new RegExp('<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"', 'i');

async function post(label, { user, pass, path = '/', headers = {}, csrfOverride = null }) {
  const g = new GameHttp({ ua: DEFAULT_UA, cookies: [] });
  const landing = await g._fetch('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
  const csrf = csrfOverride !== null ? csrfOverride : (csrfRe.exec(landing.text) || [])[1];

  const body = new URLSearchParams({ csrf, username: user, password: pass, remember: '1' }).toString();
  const res = await g._fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...headers },
    body
  });

  const logged = res.text.includes('sessionIdleConfig') || res.text.includes('gameSidebar');
  console.log(`\n  [${label}]`);
  console.log(`    status=${res.status}  len=${res.text.length}  loggedIn=${logged}  url=${res.url}`);
  // Any sentence that does not appear on the pristine landing is a server message.
  const pristine = strip(landing.text);
  const body2 = strip(res.text);
  const novel = body2.split(/(?<=[.!?])\s+/).filter((x) => x.length > 8 && !pristine.includes(x.slice(0, 40)));
  novel.slice(0, 3).forEach((x) => console.log(`    + "${x.slice(0, 160)}"`));
  return { len: res.text.length, logged };
}

(async () => {
  const c = credentials.load();
  console.log('  baseline landing = 10903 bytes (medido antes)');

  const real = await post('credencial REAL', { user: c.username, pass: c.password });
  const wrong = await post('password FALSA', { user: c.username, pass: 'esto_no_es_la_clave_123' });
  const nouser = await post('usuario INEXISTENTE', { user: 'zz_no_existe_zz', pass: 'x' });
  const nocsrf = await post('sin csrf', { user: c.username, pass: c.password, csrfOverride: '' });
  const origine = await post('+ Origin', {
    user: c.username,
    pass: c.password,
    headers: { origin: BASE }
  });

  console.log('\n  ===== VEREDICTO =====');
  const same = real.len === wrong.len && wrong.len === nouser.len;
  console.log('  real vs falsa vs inexistente identicos: ' + same);
  if (same) {
    console.log('  >> el servidor NO evalua credenciales: el POST se descarta antes.');
    console.log('  >> la credencial no es el problema.');
  } else {
    console.log('  >> el POST SI se procesa: la credencial o su formato es el problema.');
  }
  console.log('  sin csrf difiere: ' + (nocsrf.len !== real.len));
  console.log('  con origin difiere: ' + (origine.len !== real.len));
})();
