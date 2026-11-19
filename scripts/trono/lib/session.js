/**
 * Session hand-off: the browser owns the login, HTTP owns the loop.
 *
 * The browser is the only piece that costs real memory (measured: 6 processes,
 * 511-936 MB working set), and the only piece whose job cannot be done over
 * HTTP: authenticating. So the flow is:
 *
 *   1. open the browser, ensure the session is alive (login if needed)
 *   2. copy the cookie + User-Agent out of the tab over CDP
 *   3. PROVE the copy works: call player_state from plain Node with that cookie
 *   4. only if step 3 succeeded, close the browser
 *
 * Step 3 is the gate. Closing the browser on an unverified cookie would leave
 * the account with no way back in until someone notices, so `handoff()` refuses
 * to close anything it could not prove.
 *
 * state/session.json holds a live credential. It is the agent's own session, it
 * is short-lived server-side (PHP idles it out), and it never leaves this
 * machine.
 */
const fs = require('fs');
const path = require('path');
const { GameHttp, DEFAULT_UA } = require('./httptransport');

const STATE_DIR = process.env.TRONO_STATE_DIR || path.join(__dirname, '..', 'state');
const SESSION_PATH = path.join(STATE_DIR, 'session.json');

/** Cookies worth carrying: the PHP session plus the remember-me token. */
const KEEP = /^(DTTSESS|DEF_REMEMBER)$/i;

/** Read the session out of the live tab (HttpOnly cookies need the protocol). */
async function fromBrowser(g) {
  let cookies = null;
  for (const attempt of [
    () => g.session.send('Storage.getCookies', {}),
    () => g.session.send('Network.getCookies', { urls: ['https://defiendeeltrono.com/'] })
  ]) {
    try {
      const res = await attempt();
      if (res && res.cookies) {
        cookies = res.cookies;
        break;
      }
    } catch (_) {}
  }
  if (!cookies) throw new Error('cannot read cookies over CDP');

  const mine = cookies.filter((c) => KEEP.test(c.name));
  if (!mine.some((c) => /^DTTSESS$/i.test(c.name))) {
    throw new Error(`no DTTSESS cookie among: ${cookies.map((c) => c.name).join(', ')}`);
  }
  const ua = await g.evalInPage('navigator.userAgent');
  return {
    exportedAt: new Date().toISOString(),
    ua,
    cookies: mine.map((c) => ({ name: c.name, value: c.value })),
    browserGold: null
  };
}

/**
 * Prove the cookie works outside the browser. Read-only: player_state only, so
 * a failed attempt costs nothing and cannot trip anything on the game side.
 */
async function verify(session) {
  const http = new GameHttp(session);
  try {
    const ps = await http.apiGet('/api/player_state.php');
    if (!ps || !ps.ok || !ps.state || !ps.state.player) {
      return { ok: false, error: 'player_state not ok', status: ps && ps.status };
    }
    return {
      ok: true,
      gold: ps.state.economy ? ps.state.economy.gold : null,
      hp: ps.state.hero ? ps.state.hero.vitals.current.hp : null,
      level: ps.state.hero ? ps.state.hero.hero_level : null,
      user: ps.state.player.username
    };
  } catch (e) {
    // A dead socket is not a dead session. Conflating them made a 20s network
    // blip throw away a valid cookie and launch a browser for nothing.
    const network = /^network:|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket/i.test(
      e.message || ''
    );
    return { ok: false, error: e.message, network };
  }
}

/**
 * Log in over plain HTTP, with no browser at all.
 *
 * This is what makes a cloud box possible. `fromBrowser` reads an HttpOnly
 * cookie over CDP, so it can only ever work on the machine that owns a Chrome
 * window. A VPS has no tab, no CDP port and no fingerprint to copy: the only way
 * in is the login form itself, which `GameHttp.login` already POSTs correctly
 * (csrf, form-encoded body, redirect:follow).
 *
 * The security property from `handoff` is preserved: nothing is written to
 * session.json until `verify` proved the collected cookie actually opens
 * player_state. A login that returns 200 but leaves a dead cookie is worthless,
 * and saving it would make the next run start from a lie.
 *
 * Returns {ok, session?, error?}. Never throws for a bad credential: the caller
 * decides whether that is fatal or worth a retry.
 */
async function loginHeadless({ credentials: creds } = {}) {
  const c = creds || require('./credentials').load();
  if (!c || !c.username || !c.password) {
    return { ok: false, error: 'no credentials (state/credentials.json or TRONO_USER/TRONO_PASS)' };
  }

  // An empty cookie jar is legal now: this transport exists to collect one.
  const http = new GameHttp({ ua: DEFAULT_UA, cookies: [] });
  let res;
  try {
    res = await http.login({ username: c.username, password: c.password, remember: true });
  } catch (e) {
    // A network failure is not a rejected password. Keep them distinguishable:
    // retrying a login into an outage is the pattern that gets accounts flagged.
    const network = /^network:|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(
      e.message || ''
    );
    return { ok: false, error: e.message, network };
  }

  if (!res || !res.ok) {
    return {
      ok: false,
      error: res ? `login not accepted (status ${res.status}, ${res.len}b)` : 'login returned nothing',
      status: res && res.status
    };
  }

  const collected = http.cookies.filter((x) => KEEP.test(x.name));
  if (!collected.some((x) => /^DTTSESS$/i.test(x.name))) {
    return {
      ok: false,
      error: `login succeeded but no DTTSESS came back (got: ${http.cookies.map((x) => x.name).join(', ') || 'none'})`
    };
  }

  const session = {
    exportedAt: new Date().toISOString(),
    ua: http.ua,
    cookies: collected.map((x) => ({ name: x.name, value: x.value })),
    browserGold: null,
    source: 'headless'
  };

  // Prove it before trusting it. Same gate as the browser handoff.
  const check = await verify(session);
  if (!check.ok) {
    return { ok: false, error: `cookie did not verify: ${check.error}`, network: check.network };
  }
  return { ok: true, session, check };
}

/**
 * Session as the runner wants it: load it, and if it is dead or absent, rebuild
 * it over HTTP instead of demanding a browser.
 *
 * `--force` style recovery is deliberately explicit: this is the only path the
 * agent has when it wakes up cold on a machine that never saw a Chrome window.
 */
async function ensure({ login = true } = {}) {
  const saved = load();
  if (saved) {
    const v = await verify(saved);
    if (v.ok) return { ok: true, session: saved, via: 'saved', check: v };
    if (v.network) return { ok: false, via: 'saved', error: v.error, network: true };
    clear();
  }
  if (!login) return { ok: false, error: 'no usable session and login disabled' };
  const out = await loginHeadless();
  if (!out.ok) return out;
  save(out.session, { verified: true, goldAtHandoff: out.check.gold, hpAtHandoff: out.check.hp });
  return { ok: true, session: out.session, via: 'headless', check: out.check };
}

function save(session, extra = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const record = { ...session, ...extra, savedAt: new Date().toISOString() };
  fs.writeFileSync(SESSION_PATH, JSON.stringify(record, null, 2), 'utf8');
  return record;
}

function load() {
  try {
    if (!fs.existsSync(SESSION_PATH)) return null;
    const s = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    if (!s || !Array.isArray(s.cookies) || !s.cookies.length) return null;
    return s;
  } catch (_) {
    return null;
  }
}

/** Forget the session (used when the server invalidates it). */
function clear() {
  try {
    if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
  } catch (_) {}
}

function ageMinutes(session) {
  if (!session || !session.savedAt) return null;
  return Math.round((Date.now() - Date.parse(session.savedAt)) / 60000);
}

/**
 * Close a browser that nothing is using.
 *
 * The Hub's `pre_launch` always opens the browser in hybrid mode, because only a
 * browser can log in. When the saved session still verifies, nobody touches that
 * browser and it stays alive forever at ~600 MB a pop (measured: three leftover
 * instances = 20 processes / 4.1 GB).
 *
 * It talks to the BROWSER-level CDP socket from /json/version, not to the game
 * tab, so it never becomes a second driver on the page.
 */
async function closeIdleBrowser(port = 9777) {
  let version = null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
    version = await r.json();
  } catch (_) {
    return 'none open';
  }
  const ws = version && version.webSocketDebuggerUrl;
  if (!ws) return 'none open';

  const { CdpSession } = require('../../lib/cdp');
  const s = new CdpSession(ws);
  try {
    await s.connect();
    await s.send('Browser.close', {}, 5000);
    return 'closed';
  } catch (e) {
    return `close failed: ${e.message}`;
  } finally {
    try {
      s.close();
    } catch (_) {}
  }
}

module.exports = {
  SESSION_PATH,
  fromBrowser,
  loginHeadless,
  ensure,
  verify,
  save,
  load,
  clear,
  ageMinutes,
  closeIdleBrowser
};
