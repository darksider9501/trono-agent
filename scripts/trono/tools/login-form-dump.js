/** Dump the real login form from the landing page: action, method, input names. */
const { GameHttp, DEFAULT_UA } = require('../lib/httptransport');

const strip = (s) => String(s || '').replace(/\s+/g, ' ').trim();

(async () => {
  const g = new GameHttp({ ua: DEFAULT_UA, cookies: [] });
  const r = await g._fetch('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
  const html = r.text;

  console.log('  len = ' + html.length);
  console.log('');
  console.log('=== todos los <form> ===');
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  console.log('  formas encontradas: ' + forms.length);
  forms.forEach((f, i) => {
    const open = /<form[^>]*>/i.exec(f)[0];
    console.log('\n  [#] ' + strip(open).slice(0, 300));
    const inputs = f.match(/<(?:input|button|select)[^>]*>/gi) || [];
    inputs.forEach((x) => console.log('      ' + strip(x).slice(0, 240)));
  });

  console.log('');
  console.log('=== cualquier input suelto (fuera de form) ===');
  const loose = (html.match(/<input[^>]*>/gi) || []).filter((x) => !forms.some((f) => f.includes(x)));
  loose.slice(0, 12).forEach((x) => console.log('  ' + strip(x).slice(0, 220)));

  console.log('');
  console.log('=== scripts que mencionan login/auth ===');
  const scripts = (html.match(/<script[^>]*src="[^"]*"/gi) || []).filter((s) => /auth|login|session/i.test(s));
  scripts.slice(0, 10).forEach((s) => console.log('  ' + strip(s).slice(0, 200)));

  console.log('');
  console.log('=== fetch/XHR de login dentro del HTML inline ===');
  const inline = html.match(/<script(?![^>]*src=)[^>]*>[\s\S]*?<\/script>/gi) || [];
  let n = 0;
  for (const blk of inline) {
    if (/login|auth|signin|csrf/i.test(blk)) {
      const m = (blk.match(/[\s\S]{0,80}(?:login|auth|signin)[\s\S]{0,120}/gi) || []).slice(0, 4);
      m.forEach((x) => {
        console.log('  ...' + strip(x).slice(0, 200));
        n++;
      });
    }
  }
  if (!n) console.log('  (nada inline)');
})();
