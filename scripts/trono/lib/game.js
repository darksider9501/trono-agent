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
    const port = options.port || DEFAULT_PORT;
    let targets;
    try {
      targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`, 2500);
    } catch (e) {
      if (options.spawn === false) {
        throw new Error(`CDP ${port} not reachable and spawn disabled (${e.message})`);
      }
      if (!fs.existsSync(LAUNCHER)) throw new Error(`missing launcher: ${LAUNCHER}`);
      execFileSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', LAUNCHER], { stdio: 'ignore' });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        await sleep(1200);
        try {
          targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`, 2500);
          break;
        } catch (_) {}
      }
      if (!targets) throw new Error(`CDP ${port} did not come up within 30s`);
      await sleep(3000);
      targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`, 2500);
    }

    const page = targets.find((t) => t.type === 'page' && (t.url || '').includes(HOST));
    if (!page) {
      throw new Error(
        `no ${HOST} tab on CDP ${port}; open targets: ${targets.map((t) => t.url).join(', ')}`
      );
    }
    const session = new CdpSession(page.webSocketDebuggerUrl);
    await session.connect();
    await session.send('Runtime.enable');
    return new Game(session, port);
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

  close() {
    try {
      this.session.close();
    } catch (e) {}
  }

  /** Fetch a game page from inside the tab and parse it. */
  async fetchPage(pagePath) {
    const url = pagePath.startsWith('http') ? pagePath : `https://${HOST}${pagePath}`;
    // X-Game-View is mandatory: without it the server returns the public landing
    // page (~10.9 KB) even when the session is valid, instead of the game view.
    const raw = await this.evalInPage(`(async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'same-origin', cache: 'no-store', headers: { 'X-Game-View': '1' } });
      return { ok: r.ok, status: r.status, html: await r.text() };
    })()`);
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
    const r = await this.evalInPage(`(async () => {
      const r = await fetch(${JSON.stringify(apiPath)}, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, json: j, raw: j ? null : t.slice(0, 400) };
    })()`);
    if (!r) throw new Error(`empty response from ${apiPath}`);
    if (r.status === 401 || r.status === 403) throw new Error(`AUTH: ${apiPath} -> ${r.status}`);
    if (!r.json) return { ok: false, status: r.status, raw: r.raw };
    return r.json;
  }

  async apiPost(apiPath, payload = {}, opts = {}) {
    if (!opts.allowMutate) throw new MutationBlocked(`POST ${apiPath}`);
    if (!opts.csrf) throw new Error('apiPost needs opts.csrf (use csrfFor(pagePath))');
    const r = await this.evalInPage(`(async () => {
      const r = await fetch(${JSON.stringify(apiPath)}, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': ${JSON.stringify(opts.csrf)} },
        body: JSON.stringify(${JSON.stringify(payload || {})})
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch (e) {}
      return { status: r.status, json: j, raw: j ? null : t.slice(0, 400) };
    })()`);
    return (r && r.json) || { ok: false, status: r && r.status, raw: r && r.raw };
  }

  async postForm(actionPath, fields = {}, opts = {}) {
    if (!opts.allowMutate) throw new MutationBlocked(`FORM ${actionPath}`);
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
      return { status: r.status, redirected: r.redirected, finalUrl: r.url, len: t.length };
    })()`);
    return r;
  }

  /**
   * Idle-session config scraped from any game page.
   * The game kills the session after `timeoutMs` (3 min) without TRUSTED input
   * (session-idle.js ignores synthetic events), so a bot must renew explicitly.
   */
  async idleConfig() {
    const page = await this.fetchPage('/pages/overview.php');
    if (!page.ok) throw new Error(`cannot read overview.php (HTTP ${page.status})`);
    const m = page.html.match(/id="sessionIdleConfig"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('sessionIdleConfig not found — not logged in?');
    return JSON.parse(m[1]);
  }

  /**
   * Autonomous login. The landing page ("/") carries a guest CSRF and posts
   * urlencoded {csrf, username, password, remember}. Used only when the session
   * is already dead; a healthy session is left untouched.
   */
  async login({ username, password, remember = true }) {
    const probe = await this.evalInPage(`(async () => {
      const r = await fetch('/', { credentials: 'same-origin', cache: 'no-store' });
      const h = await r.text();
      const d = new DOMParser().parseFromString(h, 'text/html');
      const c = d.querySelector('input[name="csrf"]');
      return { status: r.status, csrf: c && c.value, hasGame: h.includes('sessionIdleConfig') };
    })()`);
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
        looksLoggedIn: h.includes('sessionIdleConfig') || h.includes('gameSidebar')
      };
    })()`);

    const alive = await this.isLoggedIn();
    return { ok: alive, ...res };
  }

  /** Renew the session the same way the game client does for a real player. */
  async heartbeat(cfg) {
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
      return { status: r.status, json: j, raw: j ? null : t.slice(0, 200) };
    })()`);
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
