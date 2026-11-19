/**
 * The decisive test: after the login POST, does the collected cookie actually
 * open player_state?
 *
 * The previous probe judged success by looking for `sessionIdleConfig` in the
 * LOGIN RESPONSE, which is a guess about markup. The only thing that proves a
 * session exists is the API answering with a player. Reset the jar between
 * attempts so a stale cookie cannot fake a win.
 */
const { GameHttp, DEFAULT_UA } = require('../lib/httptransport');
const credentials = require('../lib/credentials');

const csrfRe = new RegExp('<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"', 'i');

async function tryLogin(label, { user, pass }) {
  const g = new GameHttp({ ua: DEFAULT_UA, cookies: [] });
  const landing = await g._fetch('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
  const csrfBefore = (csrfRe.exec(landing.text) || [])[1];
  const cookieBefore = g.cookies.map((c) => `${c.name}=${String(c.value).slice(0, 8)}`).join(',');

  const body = new URLSearchParams({ csrf: csrfBefore, username: user, password: pass, remember: '1' }).toString();
  await g._fetch('/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', referer: 'https://defiendeeltrono.com/' },
    body
  });

  const cookieAfter = g.cookies.map((c) => `${c.name}=${String(c.value).slice(0, 8)}`).join(',');

  // THE TEST: does the API accept this cookie?
  let state = null;
  try {
    const ps = await g.apiGet('/api/player_state.php');
    state = ps;
  } catch (e) {
    state = { ok: false, error: e.message };
  }

  const ok = !!(state && state.ok && state.state && state.state.player);
  console.log(`\n  [${label}]`);
  console.log(`    cookie antes : ${cookieBefore}`);
  console.log(`    cookie despues: ${cookieAfter}`);
  console.log(`    cookie cambio : ${cookieBefore !== cookieAfter ? 'SI' : 'no'}`);
  console.log(`    player_state  : ${ok ? 'AUTENTICADO' : 'rechazado'}`);
  if (ok) {
    const s = state.state;
    console.log(`      usuario : ${s.player.username}`);
    console.log(`      nivel   : ${s.hero.hero_level}`);
    console.log(`      oro     : ${s.economy.gold}`);
    console.log(`      hp      : ${s.hero.vitals.current.hp}/${s.hero.vitals.max.hp}`);
  } else {
    console.log(`      detalle : ${JSON.stringify(state).slice(0, 200)}`);
  }
  return ok;
}

(async () => {
  const c = credentials.load();
  const real = await tryLogin('credencial REAL', { user: c.username, pass: c.password });
  const wrong = await tryLogin('password FALSA (control)', { user: c.username, pass: 'clave_incorrecta_999' });

  console.log('\n  ===== RESULTADO =====');
  console.log('  real autentica : ' + real);
  console.log('  falsa autentica: ' + wrong + ' (debe ser false)');
  if (real && !wrong) console.log('  >> el login headless FUNCIONA. Solo fallaba el criterio de exito.');
  else if (!real) console.log('  >> el login headless no abre sesion todavia.');
})();
