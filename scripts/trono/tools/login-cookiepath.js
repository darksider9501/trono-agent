/**
 * The landing sets `DTTSESS=deleted` scoped to path=/public/pages.
 * That is a DELETE for a cookie the site used to keep there — not our session.
 *
 * So which path does the real session cookie live on, and does the login POST
 * need a cookie at all? Compare a fresh jar against the browser's live one.
 */
const { DEFAULT_UA, BASE } = require('../lib/httptransport');

(async () => {
  const common = {
    'user-agent': DEFAULT_UA,
    'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  console.log('=== cada Set-Cookie de la landing, completo ===');
  const res = await fetch(BASE + '/', { headers: common });
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  console.log('  cantidad: ' + list.length);
  list.forEach((c, i) => console.log(`  [${i}] ${c}`));

  console.log('');
  console.log('=== headers de la landing que hablen de cache/sesion ===');
  for (const [k, v] of res.headers) {
    if (/cookie|cache|vary|turbo|expires|pragma/i.test(k)) console.log(`  ${k}: ${String(v).slice(0, 200)}`);
  }

  console.log('');
  console.log('=== la cookie del navegador: que path tiene? ===');
  console.log('  (del CDP: DTTSESS nckd5qjl58skv3qco0n88nrikt, path=/, httpOnly, secure, sameSite=Lax)');
  console.log('');
  console.log('=== el sitio usa /public/pages como base? ===');
  for (const p of ['/public/pages/', '/public/pages/index.php']) {
    try {
      const r = await fetch(BASE + p, { headers: common, redirect: 'manual' });
      console.log(`  ${p} -> ${r.status} location=${r.headers.get('location') || '-'} setcookie=${(r.headers.getSetCookie() || []).join(' | ').slice(0, 120) || '-'}`);
    } catch (e) {
      console.log(`  ${p} -> ERR ${e.message}`);
    }
  }
})();
