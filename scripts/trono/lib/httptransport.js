/**
 * GameHttp — the same agent, without a browser.
 *
 * Measured on 2026-11-12: the game session is cookie-only. Taking the DTTSESS
 * cookie out of the live tab and calling the API from a plain Node process
 * returned the same gold and the same HP the browser saw
 * (`tools/cookie-test.js`). There is no edge bot management in front of this
 * site (server: LiteSpeed, no Cloudflare/DataDome/PerimeterX anywhere in the
 * page), so the transport adds no detectable surface that the browser did not
 * already expose — the browser itself is what costs 500-900 MB.
 *
 * This class is a drop-in for `Game` on the read/write surface the agent uses:
 * fetchPage, csrfFor, apiGet, apiPost, postForm, login, heartbeat, idleConfig,
 * isLoggedIn, state, close.
 *
 * Two rules it does NOT break:
 *   - the anti-detection breaker runs on every request, exactly like in the
 *     browser transport (lib/security.js);
 *   - the headers are the browser's own (same UA, same Accept-Language, same
 *     Referer), so the only difference the server can see is the TLS stack that
 *     is not inspected in the first place.
 *
 * Why the duplicated read logic (state/idleConfig/isLoggedIn/csrfFor) instead of
 * sharing it with Game: Game is the production path and stays byte-identical.
 * Duplicating 60 lines of glue is cheaper than a refactor that could break the
 * farm.
 */
const security = require('./security');

const HOST = 'defiendeeltrono.com';
const BASE = `https://${HOST}`;

function absolute(p) {
  if (/^https?:\/\//i.test(p)) return p;
  return BASE + (p.startsWith('/') ? p : '/' + p);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long to wait before replaying a request whose socket died.
 *
 * Measured on 2026-11-13: roughly one `fetch failed` every 10 minutes, and each
 * one cost a full 90 s sleep because the tick treated an empty socket as a state
 * problem. Nearly all of them were one-shot: the same request a second later
 * succeeded. Two replays stay under two seconds, so the tick budget does not
 * change and a genuinely dead network still fails fast enough to recover.
 */
const NET_RETRY_DELAYS = [400, 1200];

/**
 * Codes that prove the request never reached the server.
 *
 * Only these make a POST safe to replay. Connection refused, DNS failure and a
 * TLS handshake failure cannot have been applied server-side. A reset or a
 * timeout mid-flight may have been: replaying a fight action would double-spend
 * stamina, which is strictly worse than the failure it is trying to hide.
 */
const NEVER_SENT =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|EHOSTUNREACH|ENETUNREACH|CERT_/i;

/** The game shell: present in every real game page, absent from the public landing. */
const GAME_SHELL = /gameSidebar/i;

function causeCode(e) {
  const c = e && e.cause;
  return String((c && (c.code || c.errno)) || (e && (e.code || e.errno)) || '');
}

/** Minimal HTML parse: only what the agent actually consumes. */
function parsePage(html) {
  const csrf = new Set();
  for (const m of html.matchAll(/data-csrf="([0-9a-f]{32,})"/gi)) csrf.add(m[1].toLowerCase());
  for (const m of html.matchAll(/<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"/gi)) {
    csrf.add(m[1].toLowerCase());
  }
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [, ''])[1].replace(/\s+/g, ' ').trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, csrf: [...csrf], text: text.slice(0, 20000), forms: [], apis: [] };
}

class GameHttp {
  /**
   * @param {object} session {ua, cookies:[{name,value}]}
   */
  constructor(session) {
    if (!session || !Array.isArray(session.cookies) || !session.cookies.length) {
      throw new Error('GameHttp needs a session with cookies (see lib/session.js)');
    }
    this.session = session;
    this.ua = session.ua || '';
    this.cookies = session.cookies.map((c) => ({ name: c.name, value: c.value }));
  }

  /** Nothing to close: the whole point of this transport. */
  close() {}

  cookieHeader() {
    return this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Adopt a rotated session cookie (PHP regenerates the id on login). */
  _absorb(res) {
    let lists = [];
    try {
      lists = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    } catch (_) {
      return;
    }
    for (const line of lists) {
      const name = line.split('=')[0].trim();
      const value = line.split(';')[0].slice(name.length + 1).trim();
      if (!name || !value || /^deleted$/i.test(value)) continue;
      const existing = this.cookies.find((c) => c.name === name);
      if (existing) existing.value = value;
      else this.cookies.push({ name, value });
    }
  }

  /**
   * One request, with the breaker around it and browser-identical headers.
   */
  async _fetch(pathname, opts = {}) {
    const url = absolute(pathname);
    const where = `${opts.method || 'GET'} ${pathname.split('?')[0]}`;
    security.assertClear(where);

    const headers = {
      'user-agent': this.ua,
      'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
      referer: `${BASE}/pages/overview.php`,
      cookie: this.cookieHeader(),
      ...(opts.headers || {})
    };

    let res = null;
    let last = null;
    let tries = 0;
    // A dead socket is not a security event, and usually not a state change
    // either: replay it. GETs always; POSTs only when the request provably never
    // left (NEVER_SENT), because a mutation may already have been applied.
    while (tries < 1 + NET_RETRY_DELAYS.length) {
      tries += 1;
      try {
        res = await fetch(url, {
          method: opts.method || 'GET',
          headers,
          body: opts.body,
          redirect: 'follow',
          cache: 'no-store'
        });
        break;
      } catch (e) {
        last = e;
        const replays = ((opts.method || 'GET').toUpperCase() === 'GET') || NEVER_SENT.test(causeCode(e));
        if (!replays || tries > NET_RETRY_DELAYS.length) break;
        await sleep(NET_RETRY_DELAYS[tries - 1]);
      }
    }
    if (!res) {
      const err = new Error(`network: ${last.message}${tries > 1 ? ` (replayed ${tries - 1}x)` : ''}`);
      // A network that is down is not a session problem, and rebuilding the
      // transport cannot fix it. Marking it retryable keeps the runner from
      // relogging into an outage -- the repeated-authentication pattern that
      // actually gets an account flagged.
      err.retryable = true;
      throw err;
    }

    const text = await res.text();
    this._absorb(res);
    // Same gate as the browser path: 403/429/challenge/captcha stops the agent.
    security.inspect({ where, url, status: res.status, text });
    return { status: res.status, text, url: res.url };
  }

  async fetchPage(pagePath) {
    // X-Game-View is mandatory: without it the server answers the public landing
    // page even with a valid session.
    const r = await this._fetch(pagePath, { headers: { 'X-Game-View': '1', accept: 'text/html,application/xhtml+xml' } });
    if (r.status < 200 || r.status >= 400) {
      return { ok: false, status: r.status, url: absolute(pagePath), html: '', text: '', csrf: [], forms: [], apis: [] };
    }
    return { ok: true, status: r.status, url: r.url, html: r.text, ...parsePage(r.text) };
  }

  async csrfFor(pagePath) {
    const page = await this.fetchPage(pagePath);
    if (!page.ok) throw new Error(`cannot read ${pagePath} (HTTP ${page.status}) — session down?`);
    if (!page.csrf.length) throw new Error(`no csrf token found on ${pagePath} — logged out?`);
    return page.csrf[0];
  }

  async apiGet(apiPath) {
    for (let attempt = 0; ; attempt += 1) {
      const r = await this._fetch(apiPath, { headers: { accept: 'application/json, text/plain, */*' } });
      let json = null;
      try {
        json = JSON.parse(r.text);
      } catch (_) {}
      if (r.status === 401 || r.status === 403) throw new Error(`AUTH: ${apiPath} -> ${r.status}`);
      if (json) return json;
      // A 2xx whose body is not JSON is a partial or truncated answer, not a
      // state: the same request a second later parses. Calling that
      // "player_state unavailable — session expired?" declared the session dead
      // over a hiccup, and did it while the cookie was perfectly valid.
      const worthReplaying = r.status === 200 || r.status >= 500;
      if (worthReplaying && attempt < NET_RETRY_DELAYS.length) {
        await sleep(NET_RETRY_DELAYS[attempt]);
        continue;
      }
      return { ok: false, status: r.status, raw: r.text.slice(0, 400) };
    }
  }

  async apiPost(apiPath, payload = {}, opts = {}) {
    if (!opts.allowMutate) throw new Error(`MUTATION_BLOCKED: POST ${apiPath} requires { allowMutate: true }`);
    if (!opts.csrf) throw new Error('apiPost needs opts.csrf (use csrfFor(pagePath))');
    const r = await this._fetch(apiPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': opts.csrf,
        accept: 'application/json, text/plain, */*'
      },
      body: JSON.stringify(payload || {})
    });
    let json = null;
    try {
      json = JSON.parse(r.text);
    } catch (_) {}
    return json || { ok: false, status: r.status, raw: r.text.slice(0, 400) };
  }

  async postForm(actionPath, fields = {}, opts = {}) {
    if (!opts.allowMutate) throw new Error(`MUTATION_BLOCKED: FORM ${actionPath} requires { allowMutate: true }`);
    const body = Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const r = await this._fetch(actionPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml'
      },
      body
    });
    return { status: r.status, redirected: r.url !== absolute(actionPath), finalUrl: r.url, len: r.text.length };
  }

  /**
   * A form POST whose answer is JSON, and whose answer we must READ.
   *
   * `postForm` above drops the body, which is fine for the legacy actions that
   * answer with a redirect. The talent board (v3, 2026-11-16) answers
   * `{ok, message, model}` and the caller needs both the verdict and the new
   * ranks: a 200 carrying `ok:false` is a rejection, not a success. Retry rules
   * are unchanged — this still goes through `_fetch`, so a mutation is only
   * replayed when the request provably never left.
   */
  async postFormJson(actionPath, fields = {}, opts = {}) {
    if (!opts.allowMutate) throw new Error(`MUTATION_BLOCKED: FORM ${actionPath} requires { allowMutate: true }`);
    const body = Object.entries(fields)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const r = await this._fetch(actionPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body
    });
    let json = null;
    try {
      json = JSON.parse(r.text);
    } catch (_) {}
    if (!json) return { ok: false, status: r.status, raw: r.text.slice(0, 400) };
    return { ...json, status: r.status };
  }

  async idleConfig() {
    let page = await this.fetchPage('/pages/overview.php');
    if (!page.ok) throw new Error(`cannot read overview.php (HTTP ${page.status})`);
    let m = page.html.match(/id="sessionIdleConfig"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) {
      // Two very different failures look identical from here, and telling them
      // apart is the whole point:
      //   - no game shell  -> this really is a logged-out page; retrying is noise
      //                       and the caller must re-login.
      //   - game shell but no config -> the page was cut off mid-render while the
      //     session was alive. That is what killed a run 7 s after start, because
      //     the message contains "session" and the runner treats that as fatal.
      if (!GAME_SHELL.test(page.html)) {
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

  async login({ username, password, remember = true }) {
    security.assertClear('login');
    const landing = await this._fetch('/', { headers: { accept: 'text/html,application/xhtml+xml' } });
    if (landing.text.includes('sessionIdleConfig')) return { ok: true, skipped: 'session_already_active' };
    const csrf = (/<input[^>]*name="csrf"[^>]*value="([0-9a-f]{16,64})"/i.exec(landing.text) || [])[1];
    if (!csrf) return { ok: false, error: 'no csrf on landing page' };

    const body = new URLSearchParams({
      csrf,
      username,
      password,
      ...(remember ? { remember: '1' } : {})
    }).toString();

    const res = await this._fetch('/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html,application/xhtml+xml'
      },
      body
    });
    const alive = await this.isLoggedIn().catch(() => false);
    return {
      ok: alive,
      status: res.status,
      len: res.text.length,
      looksLoggedIn: res.text.includes('sessionIdleConfig') || res.text.includes('gameSidebar')
    };
  }

  async heartbeat(cfg) {
    security.assertClear('heartbeat');
    const body = new URLSearchParams({
      action: 'activity',
      csrf: cfg.csrf,
      idle_ms: String(Math.max(0, 1500 + Math.floor(Math.random() * 1500)))
    }).toString();
    try {
      const r = await this._fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json, text/plain, */*'
        },
        body
      });
      let json = null;
      try {
        json = JSON.parse(r.text);
      } catch (_) {}
      return { alive: r.status === 200 && (!json || json.ok !== false), status: r.status, response: json };
    } catch (e) {
      return { alive: false, status: null, error: e.message };
    }
  }

  async clearSession() {
    const removed = this.cookies.map((c) => c.name);
    this.cookies = [];
    return removed;
  }

  async isLoggedIn() {
    try {
      const r = await this.apiGet('/api/player_state.php');
      return !!(r && r.ok && r.state && r.state.player);
    } catch (e) {
      return false;
    }
  }

  /** Same normalized snapshot as Game.state() — the runner logs these fields. */
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
        staminaRegenPerMinute: (vit.regeneration && vit.regeneration.stamina) || 0,
        staminaPerHour: Math.round(((vit.regeneration && vit.regeneration.stamina) || 0) * 60),
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

module.exports = { GameHttp, parsePage, BASE, HOST };
