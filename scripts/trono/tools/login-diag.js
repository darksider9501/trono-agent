/**
 * Diagnose the headless login: where exactly does it stop?
 * Read-only except for the login POST itself (which the agent does anyway).
 */
const { GameHttp, DEFAULT_UA } = require('../lib/httptransport');
const credentials = require('../lib/credentials');

const strip = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const creds = credentials.load();
  if (!creds) {
    console.log('  sin credenciales');
    process.exit(1);
  }
  console.log('  creds source : ' + creds.source);
  console.log('  usuario      : ' + creds.username);
  console.log('  password len : ' + creds.password.length);
  console.log('');

  const g = new GameHttp({ ua: DEFAULT_UA, cookies: [] });

  const landing = await g._fetch('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
  console.log('  1. landing    status=' + landing.status + '  len=' + landing.text.length);
  console.log('     loggedIn ya : ' + landing.text.includes('sessionIdleConfig'));
  console.log('     cookies      : ' + (g.cookies.map((c) => c.name).join(', ') || 'NINGUNA'));

  const csrfRe = new RegExp('<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"', 'i');
  const csrf = (csrfRe.exec(landing.text) || [])[1];
  console.log('     csrf         : ' + (csrf ? csrf.slice(0, 14) + '... (' + csrf.length + ' chars)' : 'NO ENCONTRADO'));

  if (!csrf) {
    console.log('\n  >> sin csrf no hay login. Busco inputs ocultos:');
    const inputs = landing.text.match(/<input[^>]*>/gi) || [];
    inputs.slice(0, 10).forEach((x) => console.log('     ' + strip(x).slice(0, 120)));
    process.exit(1);
  }

  const body = new URLSearchParams({
    csrf,
    username: creds.username,
    password: creds.password,
    remember: '1'
  }).toString();

  const res = await g._fetch('/', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml' },
    body
  });

  console.log('');
  console.log('  2. POST login status=' + res.status + '  len=' + res.text.length);
  console.log('     cookies      : ' + (g.cookies.map((c) => c.name).join(', ') || 'NINGUNA'));
  console.log('     DTTSESS      : ' + (g.cookies.some((c) => /^DTTSESS$/i.test(c.name)) ? 'SI' : 'NO'));
  console.log('     loggedIn html: ' + res.text.includes('sessionIdleConfig'));

  console.log('');
  console.log('  3. mensajes de error del servidor:');
  const pats = [
    /class="[^"]*(?:error|alert|danger|warning)[^"]*"[^>]*>([\s\S]{3,200}?)</i,
    /(Credenciales[^<.]{0,100})/i,
    /(incorrect\w*[^<.]{0,100})/i,
    /(inv[lá]lid\w*[^<.]{0,100})/i,
    /(bloquead\w*[^<.]{0,100})/i,
    /(demasiad\w*[^<.]{0,100})/i,
    /(intent\w*[^<.]{0,100})/i,
    /(captcha[^<.]{0,100})/i
  ];
  let hits = 0;
  for (const p of pats) {
    const m = p.exec(res.text);
    if (m) {
      console.log('     >> ' + strip(m[1] || m[0]).slice(0, 160));
      hits++;
    }
  }
  if (!hits) console.log('     (ninguno reconocido)');

  console.log('');
  console.log('  4. primer texto visible del body:');
  console.log('     ' + strip(res.text).slice(0, 400));
})();
