/**
 * Anti-detection circuit breaker.
 *
 * The agent runs inside the authenticated tab and speaks to the game over
 * in-page fetch. That is invisible while the game stays a plain PHP app, but it
 * is the worst possible posture the day the site adds an anti-bot layer: a bot
 * that keeps retrying a challenge is exactly what gets fingerprint-documented
 * and banned.
 *
 * So every network helper in lib/game.js asks this module twice:
 *
 *   security.assertClear(where)                 // before: refuse to emit anything
 *   security.inspect({ where, url, status, text })  // after: watch what came back
 *
 * If a challenge appears, `inspect` writes state/halt.json and throws. From then
 * on `assertClear` throws for every request, including reads, so the agent stops
 * touching the site instead of retrying into a ban. The halt file survives
 * restarts on purpose: a Hub restart must not silently resume.
 *
 * Only a human clears it:  node tools/clear-halt.js --ack="<what you found>"
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.TRONO_STATE_DIR || path.join(__dirname, '..', 'state');
const LOG_DIR = process.env.TRONO_LOG_DIR || path.join(__dirname, '..', 'logs');
const HALT_PATH = path.join(STATE_DIR, 'halt.json');
const HALT_LOG = path.join(LOG_DIR, 'security-halt.log');

class SecurityHalt extends Error {
  constructor(message, record) {
    super(message);
    this.name = 'SecurityHalt';
    this.code = 'SECURITY_HALT';
    this.record = record;
  }
}

/**
 * Strong markers: a string that has no business appearing in game UI. Hitting
 * one means a human-verification interstitial, not a game page.
 */
const STRONG = [
  ['cloudflare-challenge', /just a moment\.\.\.|cf-chl-|checking your browser|cdn-cgi\/challenge/i],
  ['cloudflare-ray', /cloudflare ray id|__cf_chl_/i],
  ['turnstile', /cf-turnstile|challenges\.cloudflare\.com/i],
  ['datadome', /datadome|dd_cookie_test|geo\.captcha-delivery\.com/i],
  ['perimeterx', /perimeterx|px-captcha|_pxhd|captcha\.px-cloud\.net/i],
  ['akamai', /_abck|bm-verify|ak_bmsc/i],
  ['hcaptcha', /h-captcha|hcaptcha\.com/i],
  ['recaptcha', /g-recaptcha|recaptcha\/api\.js|www\.google\.com\/recaptcha/i],
  ['fingerprintjs', /fingerprintjs|fpjs\.io|api\.fpjs/i],
  ['human-check', /verify (?:that )?you are (?:a )?human|unusual traffic|access denied|request blocked|bot detected/i]
];

/**
 * Weak markers: the literal word "captcha" can legitimately appear in game copy
 * (help text, a support link). Only count it when the response is already an
 * error, so a normal page can never trip the breaker on prose alone.
 */
const WEAK = [['captcha-mention', /captcha/i]];

/** Status codes that mean "a gate answered instead of the game". */
const STATUS_SIGNALS = {
  403: 'forbidden',
  429: 'rate-limited',
  503: 'service-unavailable'
};

/** Cookie names set by bot-management vendors. A new one is a new layer. */
const BOT_COOKIE = /^(__cf|cf_clearance|_px|_pxhd|datadome|dd_|_abck|ak_bmsc|bm_sz|incap_ses|visid_incap)/i;

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Current halt record, or null. Never throws: a corrupt file still means halted. */
function readHalt() {
  try {
    if (!fs.existsSync(HALT_PATH)) return null;
    const raw = fs.readFileSync(HALT_PATH, 'utf8');
    try {
      return { ...JSON.parse(raw), unreadable: false };
    } catch (_) {
      return { halted: true, at: null, where: 'unknown', signals: ['halt-file-corrupt'], excerpt: raw.slice(0, 400) };
    }
  } catch (_) {
    return { halted: true, at: null, where: 'unknown', signals: ['halt-file-unreadable'] };
  }
}

function isHalted() {
  return !!readHalt();
}

/** Loud, greppable line. The console watcher colours this one red. */
function shout(msg) {
  console.error(`!! SECURITY HALT: ${msg}`);
}

/**
 * Record the halt and stop everything.
 *
 * Written before throwing so the decision survives a crash: the next process
 * reads the file and refuses to run even if the stack that detected this is gone.
 */
function trip({ where, url, status, signals, excerpt, cookies }) {
  const record = {
    halted: true,
    at: new Date().toISOString(),
    where: where || 'unknown',
    url: url || null,
    status: status === undefined ? null : status,
    signals: signals && signals.length ? signals : ['unspecified'],
    excerpt: (excerpt || '').replace(/\s+/g, ' ').slice(0, 400),
    cookies: cookies || null,
    note: 'Human action required. Inspect the site, then clear with: node tools/clear-halt.js --ack="<reason>"'
  };

  ensureDirs();
  fs.writeFileSync(HALT_PATH, JSON.stringify(record, null, 2), 'utf8');
  try {
    fs.appendFileSync(HALT_LOG, JSON.stringify(record) + '\n', 'utf8');
  } catch (_) {}

  shout(`${record.where}${record.status ? ` HTTP ${record.status}` : ''} — signals: ${record.signals.join(', ')}`);
  shout(`stopping all requests. Halt file: ${HALT_PATH}`);
  shout(record.excerpt ? `evidence: ${record.excerpt.slice(0, 200)}` : 'evidence: no body');
  return record;
}

/**
 * Refuse to emit a request while halted. Called by every helper in game.js, so
 * a halted agent cannot even read a page: reads are requests too, and a bot
 * polling a challenge page is the pattern that gets the account flagged.
 */
function assertClear(where) {
  const halt = readHalt();
  if (!halt) return;
  const since = halt.at || 'unknown time';
  throw new SecurityHalt(
    `SECURITY_HALT: refusing ${where} — halted at ${since} (${halt.signals.join(', ')} in ${halt.where}). ` +
      `Human must clear ${HALT_PATH}`,
    halt
  );
}

/** What the status code alone says. */
function statusSignals(status) {
  const hit = STATUS_SIGNALS[status];
  return hit ? [hit] : [];
}

/**
 * Inspect a response and trip if it looks like a gate.
 *
 * `text` is optional: a HEAD-like caller may only have a status. Strong markers
 * are checked on any status; weak ones only on an error status, to keep game
 * copy from tripping the breaker.
 */
function inspect({ where, url, status, text, headers }) {
  const signals = statusSignals(status);
  const body = typeof text === 'string' ? text : '';
  const isError = typeof status === 'number' && status >= 400;

  for (const [name, re] of STRONG) {
    if (re.test(body)) signals.push(name);
  }
  if (isError) {
    for (const [name, re] of WEAK) {
      if (re.test(body)) signals.push(name);
    }
  }
  if (headers && typeof headers === 'object') {
    const server = String(headers.server || '');
    if (/cloudflare/i.test(server)) signals.push('cloudflare-server');
    if (/datadome|perimeterx|akamai/i.test(server)) signals.push('edge-bot-manager');
  }

  if (!signals.length) return { ok: true };

  // De-duplicate while keeping order, so the report reads like a diagnosis.
  const unique = [...new Set(signals)];
  // A 403 with no other evidence is still a gate: the game never 403s a
  // logged-in read, so the safe reading is "something new is in front of us".
  const record = trip({ where, url, status, signals: unique, excerpt: body.slice(0, 400) });
  throw new SecurityHalt(`SECURITY_HALT: ${where} returned ${unique.join(', ')}`, record);
}

/**
 * Best-effort look at the cookies the page can see.
 *
 * HttpOnly cookies are invisible here, but the vendors that matter set a
 * script-readable one (`_px3`, `datadome`, `_abck`, `__cf_bm`). A cookie name
 * that was not there before means a layer was added, which is worth stopping on
 * even before it blocks anything.
 */
function cookieSignals(cookieString) {
  const found = [];
  for (const part of String(cookieString || '').split(';')) {
    const name = part.split('=')[0].trim();
    if (name && BOT_COOKIE.test(name)) found.push(`bot-cookie:${name}`);
  }
  return found;
}

/** Trip on bot-management cookies; returns the names seen when clean. */
function inspectCookies(cookieString, where) {
  const found = cookieSignals(cookieString);
  if (!found.length) return [];
  const record = trip({
    where: where || 'cookie probe',
    url: null,
    status: null,
    signals: [...new Set(found)],
    excerpt: `document.cookie: ${String(cookieString).slice(0, 200)}`,
    cookies: found
  });
  throw new SecurityHalt(`SECURITY_HALT: bot-management cookies present (${found.join(', ')})`, record);
}

/** Human acknowledgement. Returns the record that was cleared. */
function clear({ ack, who = process.env.USERNAME || 'human' }) {
  const record = readHalt();
  if (!record) return null;
  ensureDirs();
  fs.appendFileSync(
    HALT_LOG.replace(/\.log$/, '.cleared.log'),
    JSON.stringify({ ...record, clearedAt: new Date().toISOString(), clearedBy: who, ack: ack || null }) + '\n',
    'utf8'
  );
  fs.unlinkSync(HALT_PATH);
  return record;
}

module.exports = {
  HALT_PATH,
  HALT_LOG,
  SecurityHalt,
  readHalt,
  isHalted,
  assertClear,
  inspect,
  trip,
  clear,
  cookieSignals,
  inspectCookies
};
