/** Find the JS that performs login, and read what it actually sends. */
const { GameHttp, DEFAULT_UA, BASE } = require('../lib/httptransport');

(async () => {
  const g = new GameHttp({ ua: DEFAULT_UA, cookies: [] });
  const r = await g._fetch('/', { headers: { accept: 'text/html,application/xhtml+xml' } });

  const srcs = [...r.text.matchAll(/<script[^>]*src="([^"]+)"/gi)].map((m) => m[1]);
  console.log('  scripts en la landing: ' + srcs.length);
  srcs.forEach((s) => console.log('   - ' + s));

  for (const src of srcs) {
    if (!/auth|login|session|main|app|index/i.test(src)) continue;
    try {
      const res = await g._fetch(src, { headers: { accept: '*/*' } });
      const t = res.text;
      console.log(`\n  ===== ${src} (${t.length} bytes) =====`);
      if (/login|signin|auth/i.test(t)) {
        // Print every context around a login-ish identifier.
        const re = /[\s\S]{0,120}(?:login|signin|\/auth)[\s\S]{0,260}/gi;
        let m, n = 0;
        while ((m = re.exec(t)) && n < 8) {
          console.log('  ... ' + m[0].replace(/\s+/g, ' ').slice(0, 380));
          n++;
        }
        if (!n) console.log('  (sin contexto de login)');
      } else {
        console.log('  (no menciona login)');
      }
    } catch (e) {
      console.log(`  ! ${src}: ${e.message}`);
    }
  }
})();
