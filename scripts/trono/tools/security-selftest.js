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
