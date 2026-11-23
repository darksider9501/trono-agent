#!/usr/bin/env node
/**
 * Offline self-test for the anti-detection breaker.
 *
 * It never talks to the game. It writes into a throwaway state directory, so a
 * green run proves the logic (trip, block, sticky, weak-marker handling, clear)
 * without any chance of leaving state/halt.json behind and stopping production.
 *
 *   node tools/security-selftest.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

// Must be set before require: lib/security reads it at load time.
const TMP = path.join(os.tmpdir(), `trono-halt-selftest-${Date.now()}`);
process.env.TRONO_STATE_DIR = TMP;
process.env.TRONO_LOG_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const security = require('../lib/security');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function expectHalt(fn, what) {
  try {
    fn();
  } catch (e) {
    assert(e.code === 'SECURITY_HALT', `${what} threw ${e.code || e.name}, expected SECURITY_HALT`);
    return e;
  }
  throw new Error(`${what} did not throw — the agent would have kept talking to the site`);
}

console.log(`selftest state dir: ${TMP}\n`);

check('clean state does not block requests', () => {
  assert(security.isHalted() === false, 'reported halted with no halt file');
  security.assertClear('test');
});

check('a normal game page mentioning "captcha" in prose does not trip', () => {
  security.inspect({
    where: 'fetchPage /pages/help.php',
    status: 200,
    text: '<h1>Ayuda</h1><p>Si ves un captcha, avisa al soporte.</p>'
  });
  assert(security.isHalted() === false, 'tripped on ordinary copy');
});

check('HTTP 403 trips with evidence', () => {
  const err = expectHalt(
    () => security.inspect({ where: 'apiGet /api/player_state.php', status: 403, text: 'Forbidden' }),
    '403'
  );
  const record = security.readHalt();
  assert(record && record.halted, 'no halt file written');
  assert(record.status === 403, `recorded status ${record.status}`);
  assert(record.signals.includes('forbidden'), `signals: ${record.signals.join(', ')}`);
  assert(err.record && err.record.where.includes('player_state'), 'record lost the caller');
});

check('once halted, every read is refused before it is sent', () => {
  expectHalt(() => security.assertClear('apiGet /api/daily_rewards.php'), 'assertClear');
  expectHalt(() => security.assertClear('fetchPage /pages/overview.php'), 'assertClear');
});

check('a challenge page trips on 200 as well', () => {
  security.clear({ ack: 'selftest reset' });
  expectHalt(
    () =>
      security.inspect({
        where: 'fetchPage /pages/overview.php',
        status: 200,
        text: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>'
      }),
    'cloudflare page'
  );
  const record = security.readHalt();
  assert(
    record.signals.includes('cloudflare-challenge'),
    `signals: ${record.signals.join(', ')}`
  );
});

check('rate limit trips', () => {
  security.clear({ ack: 'selftest reset' });
  expectHalt(() => security.inspect({ where: 'heartbeat', status: 429, text: 'Too Many Requests' }), '429');
  assert(security.readHalt().signals.includes('rate-limited'), 'missing rate-limited signal');
});

check('recaptcha / turnstile / datadome trip on any status', () => {
  for (const [marker, expected] of [
    ['<script src="https://www.google.com/recaptcha/api.js"></script>', 'recaptcha'],
    ['<div class="cf-turnstile" data-sitekey="x"></div>', 'turnstile'],
    ['<script src="https://js.datadome.co/tags.js"></script>', 'datadome'],
    ['<script src="https://api.fpjs.io/v3/x"></script>', 'fingerprintjs']
  ]) {
    security.clear({ ack: 'selftest reset' });
    expectHalt(() => security.inspect({ where: 'fetchPage /', status: 200, text: marker }), marker);
    const signals = security.readHalt().signals;
    assert(signals.includes(expected), `${marker} -> ${signals.join(', ')} (expected ${expected})`);
  }
});

check('bot-management cookie is a halt, game cookies are not', () => {
  security.clear({ ack: 'selftest reset' });
  assert(security.cookieSignals('DTTSESS=abc; DEF_REMEMBER=1').length === 0, 'flagged a game cookie');
  assert(security.cookieSignals('_px3=xxx.123').includes('bot-cookie:_px3'), 'missed _px3');
  assert(security.cookieSignals('datadome=abc').includes('bot-cookie:datadome'), 'missed datadome');
  expectHalt(() => security.inspectCookies('DTTSESS=abc; _px3=zzz', 'connect probe'), 'inspectCookies');
});

check('a corrupt halt file still means halted, never "clear"', () => {
  security.clear({ ack: 'selftest reset' });
  fs.writeFileSync(security.HALT_PATH, '{not json', 'utf8');
  assert(security.isHalted() === true, 'corrupt file read as clear');
  expectHalt(() => security.assertClear('apiGet /api/player_state.php'), 'assertClear on corrupt halt');
});

check('clear archives the record and unblocks', () => {
  security.clear({ ack: 'selftest reset' });
  expectHalt(() => security.inspect({ where: 'test', status: 403, text: 'no' }), '403');
  const cleared = security.clear({ ack: 'checked the site by hand, no challenge' });
  assert(cleared && cleared.halted, 'clear returned nothing');
  assert(security.isHalted() === false, 'still halted after clear');
  assert(fs.existsSync(security.HALT_LOG), 'halt history log was not written');
  security.assertClear('test');
});

// Regresion del 2026-11-22: el farm se detuvo un dia entero por la pagina de
// error por defecto del hosting (503, XHTML 1.0 Transitional, <title></title>
// vacio, solo un <style> inline, 370 bytes). No es un gate: ningun WAF contesta
// un documento sin una sola palabra visible.
check('a message-less 5xx is a server flap, not a gate', () => {
  const realPage =
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"> ' +
    '<html xmlns="http://www.w3.org/1999/xhtml"> <head> <meta http-equiv="Content-Type" content="text/html; charset=utf-8" /> ' +
    '<title></title> <style type="text/css"> html{ } body{ mar';

  // La pagina REAL del halt, y los casos degenerados equivalentes.
  for (const [status, body] of [
    [503, realPage],
    [500, ''],
    [502, ''],
    [504, '<html><head><title></title></head><body></body></html>'],
    [503, '   \n\t  ']
  ]) {
    security.clear({ ack: 'selftest reset' });
    let threw = null;
    try {
      security.inspect({ where: 'POST /api/session_activity.php', status, text: body });
    } catch (e) {
      threw = e;
    }
    assert(threw, `${status} len=${body.length} did not throw at all`);
    assert(
      threw.code === 'MAINTENANCE',
      `${status} len=${body.length} threw ${threw.code || threw.name}, expected MAINTENANCE`
    );
    assert(security.isHalted() === false, `${status} len=${body.length} wrote a halt file`);
  }
});

// Un 5xx que SI dice algo no es un flap: el gate gana. Este es el limite que
// hace segura la regla de arriba, porque un WAF siempre escribe palabras.
check('a 5xx that says something still halts', () => {
  for (const body of [
    '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
    '<html><body><h1>Access denied</h1><p>You do not have permission to access this resource.</p></body></html>',
    '<html><body>Request blocked by our security policy. Contact support.</body></html>'
  ]) {
    security.clear({ ack: 'selftest reset' });
    expectHalt(() => security.inspect({ where: 'POST /api/session_activity.php', status: 503, text: body }), '503 + words');
    assert(security.isHalted() === true, `did not halt on: ${body.slice(0, 40)}`);
  }
});

// ...y si trae la firma de un WAF, el gate gana incluso sin texto visible.
check('a 5xx carrying gate markers still halts', () => {
  security.clear({ ack: 'selftest reset' });
  expectHalt(
    () => security.inspect({ where: 'fetchPage /', status: 503, text: '<title>Just a moment...</title>' }),
    '503 + cloudflare challenge'
  );
  assert(security.readHalt().signals.includes('cloudflare-challenge'), 'lost the cloudflare signal');

  security.clear({ ack: 'selftest reset' });
  expectHalt(
    () => security.inspect({ where: 'fetchPage /', status: 503, text: '<script src="https://js.datadome.co/tags.js"></script>' }),
    '503 + datadome'
  );

  // La cabecera es evidencia de que hay un edge delante, aunque el cuerpo venga
  // en blanco: ahi si importa el status, no el texto.
  security.clear({ ack: 'selftest reset' });
  expectHalt(
    () => security.inspect({ where: 'fetchPage /', status: 503, text: '', headers: { server: 'cloudflare' } }),
    '503 empty + cloudflare header'
  );
});

// Un 4xx NO es un flap, ni siquiera vacio: 403/429 son como un gate contesta.
check('an empty 4xx still halts', () => {
  for (const status of [403, 429]) {
    security.clear({ ack: 'selftest reset' });
    expectHalt(() => security.inspect({ where: 'apiGet /api/player_state.php', status, text: '' }), `${status} empty`);
    assert(security.isHalted() === true, `${status} empty body did not halt`);
  }
});

// `supersedeObsoleteHalt` es la UNICA puerta que libera un halt sin un humano.
// Solo puede coincidir con el falso positivo del 22-nov: un 5xx cuya pagina no
// dice una sola palabra, con signal unico y en una ruta del juego. Cualquier
// halt real tiene que quedar intacto.
check('supersede frees only the obsolete message-less 5xx halt', () => {
  const realPage =
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"> ' +
    '<html xmlns="http://www.w3.org/1999/xhtml"> <head> <meta http-equiv="Content-Type" content="text/html; charset=utf-8" /> ' +
    '<title></title> <style type="text/css"> html{ } body{ mar';

  const writeHalt = (rec) => {
    security.clear({ ack: 'selftest reset' });
    fs.writeFileSync(
      security.HALT_PATH,
      JSON.stringify({ halted: true, at: new Date().toISOString(), url: null, cookies: null, ...rec }),
      'utf8'
    );
  };

  // Debe liberar: el caso real, con sus 370 bytes de XHTML mudo.
  writeHalt({ where: 'POST /api/session_activity.php', status: 503, signals: ['service-unavailable'], excerpt: realPage });
  assert(security.supersedeObsoleteHalt() !== null, 'did not free the real false positive');
  assert(security.isHalted() === false, 'still halted after supersede');

  // Debe liberar: cuerpo realmente vacio (misma clase de fallo).
  writeHalt({ where: 'POST /api/tick.php', status: 500, signals: ['service-unavailable'], excerpt: '' });
  assert(security.supersedeObsoleteHalt() !== null, 'did not free an empty-body 500');
  assert(security.isHalted() === false, 'still halted after supersede (empty)');

  // No debe liberar: un gate real que ademas era 5xx.
  writeHalt({
    where: 'fetchPage /',
    status: 503,
    signals: ['cloudflare-challenge', 'service-unavailable'],
    excerpt: '<title>Just a moment...</title>'
  });
  assert(security.supersedeObsoleteHalt() === null, 'freed a halt carrying a strong gate marker');
  assert(security.isHalted() === true, 'a real gate stopped halting');

  // No debe liberar: el cuerpo SI dice algo (aunque no sea un marcador fuerte).
  writeHalt({
    where: 'POST /api/session_activity.php',
    status: 503,
    signals: ['service-unavailable'],
    excerpt: '<html><body><h1>Access denied</h1><p>You do not have permission.</p></body></html>'
  });
  assert(security.supersedeObsoleteHalt() === null, 'freed a halt whose body said something');
  assert(security.isHalted() === true, 'a halt with a message stopped halting');

  // No debe liberar: 403 vacio (un gate no es 5xx).
  writeHalt({ where: 'apiGet /api/player_state.php', status: 403, signals: ['forbidden'], excerpt: '' });
  assert(security.supersedeObsoleteHalt() === null, 'freed a 403');
  assert(security.isHalted() === true, 'a 403 stopped halting');

  security.clear({ ack: 'selftest reset' });
});

// Cleanup: the test owns TMP, and its logs land in the project logs dir only if
// the module wrote there. Keep the throwaway dir small but leave the archive for
// inspection when something fails.
if (fail === 0) {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
