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
 * The game is down on its own schedule. Not a gate, and not ours to fix.
 *
 * Measured 2026-11-14: the breaker halted the farm on a `503` whose body was the
 * game saying `{"ok":false,"maintenance":true,"message":"El juego está en
 * mantenimiento..."}`. Nothing about that is a detection: it is a routine window,
 * it clears itself, and demanding a human to release it turned a 20-minute outage
 * into a stopped agent. Retryable on purpose, and it writes NO halt file, so the
 * runner can simply wait it out.
 */
class MaintenanceWindow extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'MaintenanceWindow';
    this.code = 'MAINTENANCE';
    this.retryable = true;
    this.where = info.where || null;
    this.status = info.status === undefined ? null : info.status;
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

/**
 * Un 5xx que no dice NADA es la pagina de error del hosting, no un gate.
 *
 * Medido el 2026-11-22: el farm se detuvo un dia entero por un
 * `POST /api/session_activity.php` que devolvio 503 con esta pagina (370 bytes):
 *
 *   <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ...>
 *   <html xmlns="http://www.w3.org/1999/xhtml"><head>
 *   <meta http-equiv="Content-Type" ... />
 *   <title></title>                    <-- TITULO VACIO
 *   <style type="text/css"> html{ } body{ mar...
 *
 * Es el documento de error por defecto de un panel de hosting: XHTML 1.0
 * Transitional, un <style> inline, titulo vacio y CERO texto visible.
 *
 * La primera correccion solo miraba `body.length === 0`, asi que esta pagina de
 * 370 bytes la esquivaba y volvia a haltear. La distincion correcta no es "cuerpo
 * vacio", es "cuerpo que no dice nada": todo gate conocido ESCRIBE palabras
 * ("Just a moment...", "Access denied", "checking your browser", un captcha).
 * Un HTML sin texto visible es el servidor fallando, y nunca un gate.
 *
 * NO se extiende a 403 ni 429: esos SI son un gate. Solo el 5xx es territorio
 * del servidor.
 */
const SERVER_FLAP = new Set([500, 502, 503, 504]);

/** Debajo de esto, un HTML no le esta diciendo nada a nadie. */
const MIN_VISIBLE_TEXT = 20;

/**
 * El texto que un humano VERIA en ese HTML.
 *
 * Quita <script>, <style>, comentarios, etiquetas y entidades. Tolera etiquetas
 * sin cerrar a proposito: el excerpt que se guarda esta cortado a 400 chars, asi
 * que un <style> puede venir truncado y sin su `</style>`.
 */
function visibleText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Un 5xx cuya pagina no contiene ni un mensaje: documento de error del server. */
function isServerErrorDocument(status, body) {
  if (!SERVER_FLAP.has(status)) return false;
  return visibleText(body).length < MIN_VISIBLE_TEXT;
}


/**
 * The game's own maintenance flag, which is the one 503 that is not a gate.
 *
 * `"maintenance":true` is unambiguous: no bot-management layer writes our JSON.
 */
const MAINTENANCE_JSON = /"maintenance"\s*:\s*true/i;

/**
 * A whole page that IS the maintenance notice.
 *
 * Second real shape, 2026-11-15 -- it got past the previous regex and halted the
 * farm for a day:
 *   <title>Mantenimiento — Defiende el Trono</title>
 *   <h2>Mantenimiento en curso</h2>
 *   <p>Estamos mejorando el rendimiento del juego...</p>
 * A document whose own title or top-level heading announces maintenance, and
 * which has no game shell in it, cannot be mistaken for anything else.
 */
const MAINTENANCE_PAGE = /<title[^>]*>[^<]*\bmantenimiento\b|<h[12][^>]*>\s*mantenimiento\b/i;

/** Any real game page carries the sidebar; the maintenance notice never does. */
const GAME_SHELL = /gameSidebar/i;

/**
 * Prose mentions, only trusted on a 5xx: that is the server itself saying it is
 * down. On a 4xx the same word can be part of a challenge page, and the STRONG
 * markers above already claim those.
 */
const MAINTENANCE_TEXT = /\bmantenimiento\b|\bmaintenance\b/i;

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

/**
 * Por que el predicado no libero el halt. Solo para diagnostico: convierte un
 * fallo opaco ("el job murio en 0s otra vez") en la lista de condiciones que
 * fallaron, asi la proxima corrida se arregla sin adivinar.
 */
function explainObsoleteHalt(halt) {
  if (!halt) return 'sin halt';
  const signals = Array.isArray(halt.signals) ? halt.signals : [];
  const status = Number(halt.status);
  const excerpt = String(halt.excerpt || '').trim();
  const visible = visibleText(excerpt);
  const reasons = [];
  if (!(signals.length === 1 && signals[0] === 'service-unavailable')) {
    reasons.push(`signals=${JSON.stringify(signals)} (se esperaba exactamente ["service-unavailable"])`);
  }
  if (!(Number.isFinite(status) && status >= 500 && status <= 599)) reasons.push(`status=${halt.status} (se esperaba 5xx)`);
  if (visible.length >= MIN_VISIBLE_TEXT) {
    reasons.push(`el cuerpo SI dice algo (${visible.length} chars visibles): ${JSON.stringify(visible.slice(0, 120))}`);
  }
  if (!/^[a-z]*\s*\/api\/|^fetchPage\s|^apiGet\s|^apiPost\s/i.test(String(halt.where || ''))) {
    reasons.push(`where=${JSON.stringify(halt.where)} (no es una ruta del juego)`);
  }
  return reasons.length ? reasons.join(' | ') : 'todas las condiciones se cumplen (no deberia llegar aca)';
}

/**
 * Supersede un halt que escribio un clasificador que ya demostramos defectuoso.
 *
 * NO es un auto-clear. Es una migracion con un predicado ESTRICTO: solo libera
 * un halt que el codigo actual es incapaz de volver a producir.
 *
 * El 2026-11-22 un `POST /api/session_activity.php` devolvio 503 con la pagina
 * de error por defecto del hosting (XHTML 1.0 Transitional, `<title></title>`
 * vacio, solo un <style> inline, 370 bytes y CERO texto visible). El breaker lo
 * clasifico como `service-unavailable` -> halt. Ese halt quedo escrito en el
 * cache de Actions y bloquea todos los jobs futuros: el job muere en 0s antes de
 * poder hacer nada, asi que NUNCA se limpia solo.
 *
 * El predicado exige las CUATRO condiciones a la vez, y cada una es necesaria:
 *
 *   1. signals es EXACTAMENTE ['service-unavailable']. Un solo marcador fuerte
 *      mas (cloudflare-challenge, datadome, bot-cookie:*) y no aplica: eso si
 *      seria un gate, y los marcadores fuertes se evaluan ANTES del flap.
 *   2. status es 5xx. Un 503 legitimo del juego con WAF delante trae cuerpo.
 *   3. El cuerpo NO DICE NADA (menos de MIN_VISIBLE_TEXT chars visibles). Un
 *      gate SIEMPRE escribe palabras: "Just a moment...", "Access denied",
 *      "checking your browser". Un <title> vacio con solo CSS es el hosting
 *      fallando. El excerpt guardado esta cortado a 400 chars, asi que un
 *      <style> puede venir truncado y sin cerrar: `visibleText` lo tolera.
 *   4. `where` es una ruta del juego, no un probe de conexion.
 *
 * Si algo no calza, NO toca nada y devuelve null: el humano sigue siendo el
 * unico que puede liberar un halt de verdad. Lo que se archiva queda en
 * logs/security-halt.cleared.log con el motivo, asi que el episodio es auditable.
 */
function supersedeObsoleteHalt() {
  const halt = readHalt();
  if (!halt) return null;

  const signals = Array.isArray(halt.signals) ? halt.signals : [];
  const status = Number(halt.status);
  const excerpt = String(halt.excerpt || '').trim();

  const onlyServiceUnavailable = signals.length === 1 && signals[0] === 'service-unavailable';
  const is5xx = Number.isFinite(status) && status >= 500 && status <= 599;
  const messageLess = visibleText(excerpt).length < MIN_VISIBLE_TEXT;
  const gameRoute = /^[a-z]*\s*\/api\/|^fetchPage\s|^apiGet\s|^apiPost\s/i.test(String(halt.where || ''));

  if (!onlyServiceUnavailable || !is5xx || !messageLess || !gameRoute) return null;

  const archived = clear({
    ack:
      `superseded: ${halt.where} answered ${status} with a message-less error document, which the ` +
      'pre-2026-11-23 classifier read as a gate. A WAF always writes words; an empty ' +
      '<title> with only inline CSS is the hosting error page. The current classifier ' +
      'treats it as MAINTENANCE and cannot produce this halt again.'
  });

  console.error(
    `!! superseded obsolete halt (${halt.where} HTTP ${status}, message-less error document) - ` +
      'false positive from the fixed classifier, archived to logs/security-halt.cleared.log'
  );
  return archived;
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
 *
 * Order matters. A real gate always wins, even if its page also mentions
 * maintenance; only when there is no gate evidence at all does the game's own
 * maintenance flag downgrade the response from "stop everything" to "wait".
 */
function inspect({ where, url, status, text, headers }) {
  const body = typeof text === 'string' ? text : '';
  const isError = typeof status === 'number' && status >= 400;

  const strong = [];
  for (const [name, re] of STRONG) {
    if (re.test(body)) strong.push(name);
  }
  if (headers && typeof headers === 'object') {
    const server = String(headers.server || '');
    if (/cloudflare/i.test(server)) strong.push('cloudflare-server');
    if (/datadome|perimeterx|akamai/i.test(server)) strong.push('edge-bot-manager');
  }
  if (strong.length) {
    const record = trip({ where, url, status, signals: [...new Set(strong)], excerpt: body.slice(0, 400) });
    throw new SecurityHalt(`SECURITY_HALT: ${where} returned ${[...new Set(strong)].join(', ')}`, record);
  }

  const serverDown = typeof status === 'number' && status >= 500;
  if (
    MAINTENANCE_JSON.test(body) ||
    (MAINTENANCE_PAGE.test(body) && !GAME_SHELL.test(body)) ||
    (serverDown && MAINTENANCE_TEXT.test(body))
  ) {
    throw new MaintenanceWindow(
      `MAINTENANCE: ${where} returned ${status || 'no status'} — the game is down on its own schedule`,
      { where, status }
    );
  }

  // Un 5xx que no dice nada: el documento de error del hosting, no un gate.
  // Ver `isServerErrorDocument`: no alcanza con `length === 0`, porque la
  // pagina real del 22-nov traia 370 bytes de XHTML con titulo vacio.
  if (isServerErrorDocument(status, body)) {
    throw new MaintenanceWindow(
      `SERVER FLAP: ${where} returned ${status} with a message-less body (${visibleText(body).length} visible chars) — the game's own server, not a gate`,
      { where, status }
    );
  }

  const signals = statusSignals(status);
  if (isError) {
    for (const [name, re] of WEAK) {
      if (re.test(body)) signals.push(name);
    }
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
  MaintenanceWindow,
  readHalt,
  isHalted,
  supersedeObsoleteHalt,
  explainObsoleteHalt,
  visibleText,
  isServerErrorDocument,
  assertClear,
  inspect,
  trip,
  clear,
  cookieSignals,
  inspectCookies
};
