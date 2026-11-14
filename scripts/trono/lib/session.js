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
const { GameHttp } = require('./httptransport');

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

module.exports = { SESSION_PATH, fromBrowser, verify, save, load, clear, ageMinutes, closeIdleBrowser };
