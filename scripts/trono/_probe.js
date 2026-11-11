/** Temporary read-only DOM probe (delete after use). */
const http = require('http');
const { CdpSession } = require('../lib/cdp');

const PORT = 9777;

function httpGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

const EXPR = process.argv[2] || '1';

(async () => {
  const targets = await httpGetJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('defiendeeltrono.com'));
  if (!page) throw new Error('no tab');
  const s = new CdpSession(page.webSocketDebuggerUrl);
  await s.connect();
  await s.send('Runtime.enable');
  const res = await s.send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true }, 30000);
  if (res.exceptionDetails) {
    console.error('EXC:', JSON.stringify(res.exceptionDetails, null, 2).slice(0, 2000));
  } else {
    console.log(JSON.stringify(res.result.value, null, 2));
  }
  s.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
