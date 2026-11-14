/**
 * Defiende el Trono — automation core.
 *
 * Everything runs INSIDE the authenticated CloakBrowser tab (CDP, port 9777)
 * via Runtime.evaluate + in-page fetch. Cookies, CSRF, TLS and fingerprint
 * stay identical to a real player: no Playwright, no synthetic clicks.
 *
 * Mutating helpers refuse to run unless { allowMutate: true } is passed.
 *
 * Usage:
 *   const { Game } = require('./lib/game');
 *   const g = await Game.connect();
 *   const s = await g.state();
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { CdpSession, sleep } = require('../../lib/cdp');
const security = require('./security');

const HOST = 'defiendeeltrono.com';
const LAUNCHER = path.join('C:\\Users\\Dioneldis\\.cloakbrowser', 'launch-trono.ps1');
const DEFAULT_PORT = 9777;

class MutationBlocked extends Error {
  constructor(op) {
    super(`MUTATION_BLOCKED: ${op} requires { allowMutate: true }`);
    this.name = 'MutationBlocked';
    this.code = 'MUTATION_BLOCKED';
  }
}

function httpGetJson(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(new Error(`bad JSON from ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${url}`)));
  });
}

/**
 * Replay an in-page request that died at the socket.
 *
 * Same rule as the HTTP transport (lib/httptransport.js): `Failed to fetch`
 * inside the page is a socket, not a policy, and replaying a read is free. When
 * it still fails after both replays the error is marked retryable, because
 * reopening a browser cannot fix a network that is down.
 */
const NET_RETRY_DELAYS = [400, 1200];
const NET_ERROR = /Failed to fetch|NetworkError|net::ERR_|ERR_INTERNET_DISCONNECTED/i;

async function withNetRetry(fn, { replayable = true } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (!replayable || !NET_ERROR.test(String((e && e.message) || ''))) throw e;
      if (attempt >= NET_RETRY_DELAYS.length) {
        e.retryable = true;
        throw e;
      }
      await sleep(NET_RETRY_DELAYS[attempt]);
    }
  }
}

const PAGE_PARSE = `(html) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const csrf = new Set();
  for (const el of doc.querySelectorAll('[data-csrf]')) {
    const v = el.getAttribute('data-csrf');
    if (v && /^[0-9a-f]{32,}$/i.test(v)) csrf.add(v.toLowerCase());
  }
  for (const el of doc.querySelectorAll('input[name=csrf]')) {
    if (el.value && /^[0-9a-f]{16,}$/i.test(el.value)) csrf.add(el.value.toLowerCase());
  }
  const apis = {};
  for (const el of doc.querySelectorAll('[data-api]')) {
    const a = el.getAttribute('data-api');
    if (!a) continue;
    const key = el.className ? null : null;
    apis[a.replace(/^\\.\\.\\//, '/').replace(/^\\//, '/')] = true;
  }
  const forms = [...doc.querySelectorAll('form')].map((f) => ({
    action: (f.getAttribute('action') || '').replace(/^\\.\\.\\//, '/').replace(/^\\//, '/'),
    method: (f.getAttribute('method') || 'get').toLowerCase(),
    fields: [...f.elements].map((e) => ({
      name: e.name || null,
      type: e.type || null,
      value: (e.value || '').slice(0, 64),
      text: e.tagName === 'BUTTON' ? clean(e.textContent).slice(0, 48) : null,
      disabled: !!e.disabled
    })).filter((x) => x.name || x.text)
  }));
  const body = doc.body ? doc.body.innerText || doc.body.textContent || '' : '';
  return {
    title: clean(doc.title),
    csrf: [...csrf],
    apis: Object.keys(apis),
    forms,
    text: clean(body).slice(0, 20000)
  };
}`;

class Game {
  constructor(session, port) {
    this.session = session;
    this.port = port;
    this._seq = 0;
  }

  static async connect(options = {}) {
    // A halted agent must not even open a socket to the site. Checked before the
    // CDP probe so the failure is the halt, not a mysterious connection error.
    security.assertClear('Game.connect');
    const port = options.port || DEFAULT_PORT;
    const listUrl = `http://127.0.0.1:${port}/json/list`;
    let targets = null;

    // The Hub's pre_launch starts the browser, and a Hub stop/start closes it, so
    // a failed first probe usually means "starting right now", not "down".
    // Spawning on that first failure is exactly what produced two game windows
    // sharing one profile: the launcher was called while the real instance was
    // still coming up. Wait for the window we were told to wait for.
    const graceMs = options.graceMs === undefined ? 20000 : options.graceMs;
    const graceDeadline = Date.now() + graceMs;
    while (Date.now() < graceDeadline) {
      try {
        targets = await httpGetJson(listUrl, 2500);
        break;
      } catch (_) {
        await sleep(1000);
      }
    }

    if (!targets) {
      if (options.spawn === false) {
        throw new Error(`CDP ${port} not reachable and spawn disabled`);
      }
      if (!fs.existsSync(LAUNCHER)) throw new Error(`missing launcher: ${LAUNCHER}`);
      // Last check right before launching: the launcher itself refuses to start a
      // second instance, but a stale port check is not enough on its own.
      const deadline = Date.now() + 40000;
      execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', LAUNCHER], { stdio: 'ignore' });
      while (Date.now() < deadline) {
        await sleep(1200);
        try {
          targets = await httpGetJson(listUrl, 2500);
          break;
        } catch (_) {}
      }
      if (!targets) throw new Error(`CDP ${port} did not come up within 40s`);
    }

    const gamePages = targets.filter((t) => t.type === 'page' && (t.url || '').includes(HOST));
    if (!gamePages.length) {
      throw new Error(
        `no ${HOST} tab on CDP ${port}; open targets: ${targets.map((t) => t.url).join(', ')}`
      );
    }
    // A hard kill makes Chrome restore the previous session, so restarting used to
    // leave two game tabs on screen. Keep one and close the rest: they share a
    // session and only split attention.
    for (const extra of gamePages.slice(1)) {
      try {
        await httpGetJson(`http://127.0.0.1:${port}/json/close/${extra.id}`, 1500);
      } catch (_) {
        // Losing the race against a tab that already closed itself is fine.
      }
    }
    const page = gamePages[0];
    const session = new CdpSession(page.webSocketDebuggerUrl);
    await session.connect();
    await session.send('Runtime.enable');
    const game = new Game(session, port);
    // Never hand back a tab that cannot resolve a relative URL.
    await game.waitForDocument();
    // Baseline cookie check. A vendor cookie already parked in the profile means
    // a layer exists (or existed) — better to report it than to play through it.
    try {
      const cookieString = await game.evalInPage('document.cookie', 8000);
      security.inspectCookies(cookieString, 'connect: document.cookie');
    } catch (e) {
      if (e && e.code === 'SECURITY_HALT') throw e;
      // The tab may be mid-navigation; every request still gets inspected.
    }
    return game;
  }

  /**
   * Wait until the tab's *document* is really the game.
   *
   * A CDP target can already advertise the game URL while its document is still
   * `about:blank` (fresh spawn, or a restored tab mid-commit). Any relative
   * fetch then dies with "Failed to parse URL from /", which looked like a
   * session bug the first time it happened.
   */
  async waitForDocument(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    let navigated = false;
    while (Date.now() < deadline) {
      let info = null;
      try {
        info = await this.evalInPage('({href: location.href, ready: document.readyState})', 5000);
      } catch (_) {}
      if (info && info.href && info.href.includes(HOST)) return true;
      if (!navigated) {
        try {
          await this.session.send('Page.navigate', { url: `https://${HOST}/` }, 10000);
          navigated = true;
        } catch (_) {}
      }
      await sleep(1000);
    }
    throw new Error(`tab never landed on ${HOST}`);
  }

  async evalInPage(expression, timeoutMs = 30000) {
    const res = await this.session.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
      timeoutMs + 10000
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page error: ${d.text || (d.exception && d.exception.description) || 'unknown'}`);
    }
    return res.result.value;
  }

  /**
   * Ask the browser to exit.
   *
   * Only ever called after the exported session was proven over plain HTTP
   * (lib/session.js `verify`). If that proof fails the browser stays open: it is
   * the only way back into the account.
   */
  async closeBrowser() {
    try {
      await this.session.send('Browser.close', {}, 5000);
    } catch (_) {
      // The socket dies with the browser; that is the expected outcome.
    }
  }

  close() {
    try {
      this.session.close();
    } catch (e) {}
  }

  /** Fetch a game page from inside the tab and parse it. */
  async fetchPage(pagePath) {
    const url = pagePath.startsWith('http') ? pagePath : `https://${HOST}${pagePath}`;
    security.assertClear(`fetchPage ${pagePath}`);
    // X-Game-View is mandatory: without it the server returns the public landing
    // page (~10.9 KB) even when the session is valid, instead of the game view.
    const raw = await withNetRetry(() =>
      this.evalInPage(`(async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Game-View': '1' } });
      return { ok: r.ok, status: r.status, html: await r.text() };
    })()`)
    );
    // Inspect before deciding anything: a 403 or an interstitial here is the
    // first thing an added anti-bot layer would show, and it must stop the agent
    // rather than be treated as a transient page error to retry.
    security.inspect({ where: `fetchPage ${pagePath}`, url, status: raw && raw.status, text: (raw && raw.html) || '' });
    if (!raw || !raw.ok) {
      return { ok: false, status: raw && raw.status, url, html: '', text: '', csrf: [], forms: [], apis: [] };
    }
    const parsed = await this.evalInPage(`(${PAGE_PARSE})(${JSON.stringify(raw.html)})`);
    return { ok: true, status: raw.status, url, html: raw.html, ...parsed };
  }

  /** Fresh 64-hex CSRF token from the page that owns the action. */
  async csrfFor(pagePath) {
    const page = await this.fetchPage(pagePath);
    if (!page.ok) throw new Error(`cannot read ${pagePath} (HTTP ${page.status}) — session down?`);
    if (!page.csrf.length) throw new Error(`no csrf token found on ${pagePath} — logged out?`);
    return page.csrf[0];
  }

  async apiGet(apiPath) {
    for (let attempt = 0; ; attempt += 1) {
      security.assertClear(`apiGet ${apiPath}`);
      const r = await withNetRetry(() =>
        this.evalInPage(`(async () => {
        const r = await fetch(${JSON.stringify(apiPath)}, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        const t = await r.text();
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        return { status: r.status, json: j, raw: j ? null : t.slice(0, 400), sample: t.slice(0, 2000) };
      })()`)
      );
      if (!r) throw new Error(`empty response from ${apiPath}`);
      security.inspect({ where: `apiGet ${apiPath}`, url: apiPath, status: r.status, text: r.sample || r.raw || '' });
      if (r.status === 401 || r.status === 403) throw new Error(`AUTH: ${apiPath} -> ${r.status}`);
      if (r.json) return r.json;
      // 2xx with a non-JSON body: partial answer, not a state. See httptransport.
      const worthReplaying = r.status === 200 || r.status >= 500;
      if (worthReplaying && attempt < NET_RETRY_DELAYS.length) {
        await sleep(NET_RETRY_DELAYS[attempt]);
        continue;
      }
      return { ok: false, status: r.status, raw: r.raw };
    }
  }

  async apiPost(apiPath, payload = {}, opts = {}) {
    if (!opts.allowMutate) throw new MutationBlocked(`POST ${apiPath}`);
    if (!opts.csrf) throw new Error('apiPost needs opts.csrf (use csrfFor(pagePath))');
    security.assertClear(`apiPost ${apiPath}`);
    const r = await this.evalInPage(`(async () => {
      const r = await fetch(${JSON.stringify(apiPath)}, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': ${JSON.stringify(opts.csrf)} },
        body: JSON.stringify(${JSON.stringify(payload || {})})
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, json: j, raw: j ? null : t.slice(0, 400), sample: t.slice(0, 2000) };
    })()`);
    security.inspect({
      where: `apiPost ${apiPath}`,
      url: apiPath,
      status: r && r.status,
      text: (r && (r.sample || r.raw)) || ''
    });
    return (r && r.json) || { ok: false, status: r && r.status, raw: r && r.raw };
  }

  async postForm(actionPath, fields = {}, opts = {}) {
    if (!opts.allowMutate) throw new MutationBlocked(`FORM ${actionPath}`);
    security.assertClear(`postForm ${actionPath}`);
    const body = Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const r = await this.evalInPage(`(async () => {
      const r = await fetch(${JSON.stringify(actionPath)}, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: ${JSON.stringify(body)}
      });
      const t = await r.text();
      return { status: r.status, redirected: r.redirected, finalUrl: r.url, len: t.length, sample: t.slice(0, 2000) };
    })()`);
    security.inspect({
      where: `postForm ${actionPath}`,
      url: actionPath,
      status: r && r.status,
      text: (r && r.sample) || ''
    });
    if (r) delete r.sample;
    return r;
  }

  /**
   * Idle-session config scraped from any game page.
   * The game kills the session after `timeoutMs` (3 min) without TRUSTED input
   * (session-idle.js ignores synthetic events), so a bot must renew explicitly.
   */
  async idleConfig() {
    let page = await this.fetchPage('/pages/overview.php');
    if (!page.ok) throw new Error(`cannot read overview.php (HTTP ${page.status})`);
    let m = page.html.match(/id="sessionIdleConfig"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      // Same distinction the HTTP transport makes: a cut-off render of a page
      // that clearly IS the game is transient, a page with no game shell at all
      // is a genuine logged-out page. Only the first deserves a second look.
      if (!/gameSidebar/i.test(page.html)) {
        throw new Error('sessionIdleConfig not found — not logged in?');
      }
      await sleep(1500);
      page = await this.fetchPage('/pages/overview.php');
      m = page.ok ? page.html.match(/id="sessionIdleConfig"[^>]*>([\s\S]*?)<\/script>/) : null;
      if (!m) {
        const err = new Error('sessionIdleConfig missing from a rendered game page (partial page)');
        err.retryable = true;
        throw err;
      }
    }
    return JSON.parse(m[1]);
  }

  /**
   * Autonomous login. The landing page ("/") carries a guest CSRF and posts
   * urlencoded {csrf, username, password, remember}. Used only when the session
   * is already dead; a healthy session is left untouched.
   */
  async login({ username, password, remember = true }) {
    security.assertClear('login');
    const probe = await this.evalInPage(`(async () => {
      const r = await fetch('/', { credentials: 'same-origin', cache: 'no-store' });
      const h = await r.text();
      const d = new DOMParser().parseFromString(h, 'text/html');
      const c = d.querySelector('input[name="csrf"]');
      return { status: r.status, csrf: c && c.value, hasGame: h.includes('sessionIdleConfig'), sample: h.slice(0, 2000) };
    })()`);
    // A login page that turns into a captcha is the one place this must stop
    // cold: retrying an authentication challenge is what marks the account.
    security.inspect({ where: 'login probe', url: '/', status: probe && probe.status, text: (probe && probe.sample) || '' });
    if (probe.hasGame) return { ok: true, skipped: 'session_already_active' };
    if (!probe.csrf) return { ok: false, error: 'no csrf on landing page' };

    const body = new URLSearchParams({
      csrf: probe.csrf,
      username,
      password,
      ...(remember ? { remember: '1' } : {})
    }).toString();

    const res = await this.evalInPage(`(async () => {
      const r = await fetch('/', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: ${JSON.stringify(body)}
      });
      const h = await r.text();
      return {
        status: r.status,
        finalUrl: r.url,
        len: h.length,
        looksLoggedIn: h.includes('sessionIdleConfig') || h.includes('gameSidebar'),
        sample: h.slice(0, 2000)
      };
    })()`);
    security.inspect({ where: 'login post', url: '/', status: res && res.status, text: (res && res.sample) || '' });
    if (res) delete res.sample;

    const alive = await this.isLoggedIn();
    return { ok: alive, ...res };
  }

  /** Renew the session the same way the game client does for a real player. */
  async heartbeat(cfg) {
    security.assertClear('heartbeat');
    const body = new URLSearchParams({
      action: 'activity',
      csrf: cfg.csrf,
      idle_ms: String(Math.max(0, 1500 + Math.floor(Math.random() * 1500)))
    }).toString();
    const r = await this.evalInPage(`(async () => {
      const r = await fetch(${JSON.stringify(cfg.endpoint)}, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: ${JSON.stringify(body)}
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, json: j, raw: j ? null : t.slice(0, 200), sample: t.slice(0, 2000) };
    })()`);
    security.inspect({
      where: 'heartbeat',
      url: cfg && cfg.endpoint,
      status: r && r.status,
      text: (r && (r.sample || r.raw)) || ''
    });
    const alive = r && r.status === 200 && (!r.json || r.json.ok !== false);
    return { alive, status: r && r.status, response: r && (r.json || r.raw) };
  }

  /** Drop the game session cookies (recovery path for a stuck/broken session). */
  async clearSession() {
    const removed = [];
    for (const name of ['DTTSESS', 'DEF_REMEMBER']) {
      for (const domain of ['defiendeeltrono.com', '.defiendeeltrono.com']) {
        try {
          await this.session.send('Network.deleteCookies', { name, domain });
          removed.push(`${name}@${domain}`);
        } catch (e) {
          // domain may not hold that cookie; ignore
        }
      }
    }
    return removed;
  }

  /** True when the session still resolves a player. */
  async isLoggedIn() {
    try {
      const r = await this.apiGet('/api/player_state.php');
      return !!(r && r.ok && r.state && r.state.player);
    } catch (e) {
      return false;
    }
  }

  /** Normalized snapshot built from GET reads only. */
  async state() {
    const [ps, dr, dp, ha] = await Promise.all([
      this.apiGet('/api/player_state.php'),
      this.apiGet('/api/daily_rewards.php'),
      this.apiGet('/api/daily_production.php'),
      this.apiGet('/api/hero_attributes.php')
    ]);
    if (!ps || !ps.ok) throw new Error('player_state unavailable — session expired?');

    const st = ps.state;
    const hero = st.hero || {};
    const vit = hero.vitals || {};
    const cur = vit.current || {};
    const max = vit.max || {};
    const attr = (ha && ha.data) || {};

    return {
      timestamp: new Date().toISOString(),
      user: {
        id: st.player.user_id,
        name: st.player.username,
        characterId: st.player.character_id,
        kingdomId: st.kingdom && st.kingdom.kingdom_id
      },
      hero: {
        key: hero.hero_key,
        level: hero.hero_level,
        exp: hero.hero_exp,
        expToNext: hero.hero_exp_to_next,
        hp: `${cur.hp}/${max.hp}`,
        mana: `${cur.mana}/${max.mana}`,
        stamina: `${cur.stamina}/${max.stamina}`,
        // regeneration values are per MINUTE (0.1667/min stamina = 10/h, matching the HUD label)
        staminaRegenPerMinute: (vit.regeneration && vit.regeneration.stamina) || 0,
        staminaPerHour: Math.round(((vit.regeneration && vit.regeneration.stamina) || 0) * 60),
        // hp/mana regeneration drop to 0 whenever a combat is still "active"
        hpRegenPerMinute: (vit.regeneration && vit.regeneration.hp) || 0,
        manaRegenPerMinute: (vit.regeneration && vit.regeneration.mana) || 0,
        restingBuilding: vit.resting_building || null
      },
      attributes: {
        pointsTotal: attr.points_total,
        spent: attr.points_spent,
        available: attr.points_available,
        allocated: attr.allocated,
        derived: attr.derived
      },
      dailyLogin: dr && dr.ok ? {
        available: dr.data.available,
        day: dr.data.day,
        claims: dr.data.total_claims,
        resetHour: dr.data.reset_hour,
        inSeconds: dr.data.remaining_seconds
      } : null,
      production: dp && dp.ok ? {
        perDay: dp.data.total_per_day,
        available: dp.data.available,
        claimAvailable: dp.data.claim_available,
        inSeconds: dp.data.seconds_to_next,
        capped: dp.data.capped
      } : null
    };
  }
}

module.exports = { Game, MutationBlocked, sleep, DEFAULT_PORT, HOST };
