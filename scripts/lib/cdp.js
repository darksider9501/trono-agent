/**
 * CDP adapter for CloakBrowser — NO playwright/puppeteer/selenium.
 * Anti-ban rule: CloakBrowser + CDP port 9222 is the only navigation engine.
 *
 * Provides a Playwright-compatible surface used by routines/scout/brain:
 *   page.evaluate, page.keyboard.*, page.mouse.*, page.getByRole/getByText,
 *   page.goto, page.url, page.waitForTimeout, page.$, context.pages/close.
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const DEFAULT_CLOAK =
  process.env.CLOAKBROWSER_BIN ||
  path.join(
    'C:\\Users\\Dioneldis\\.cloakbrowser',
    'chromium-146.0.7680.177.5',
    'chrome.exe'
  );
const DEFAULT_PROFILE = 'C:\\ai_gaming_bot\\gigaverse\\profile1';
const DEFAULT_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const DEFAULT_SEED = parseInt(process.env.AGENT_FINGERPRINT_SEED || '42871', 10);
const CDP_TIMEOUT_MS = parseInt(process.env.CDP_TIMEOUT_MS || '45000', 10);
// Persistently load unpacked extensions (Chrome Web Store blocks non-Chrome).
const LOAD_EXTENSIONS = [
  path.join(
    DEFAULT_PROFILE,
    'Default',
    'Extensions',
    'acmacodkjbdgmoleebolmdjonilkdbch',
    '0.94.9_0'
  )
].filter((p) => fs.existsSync(p));

const KEY_MAP = {
  a: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' },
  b: { key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, text: 'b' },
  c: { key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, text: 'c' },
  d: { key: 'd', code: 'KeyD', windowsVirtualKeyCode: 68, text: 'd' },
  e: { key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69, text: 'e' },
  f: { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, text: 'f' },
  g: { key: 'g', code: 'KeyG', windowsVirtualKeyCode: 71, text: 'g' },
  h: { key: 'h', code: 'KeyH', windowsVirtualKeyCode: 72, text: 'h' },
  i: { key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73, text: 'i' },
  j: { key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, text: 'j' },
  k: { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, text: 'k' },
  l: { key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76, text: 'l' },
  m: { key: 'm', code: 'KeyM', windowsVirtualKeyCode: 77, text: 'm' },
  n: { key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, text: 'n' },
  o: { key: 'o', code: 'KeyO', windowsVirtualKeyCode: 79, text: 'o' },
  p: { key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80, text: 'p' },
  q: { key: 'q', code: 'KeyQ', windowsVirtualKeyCode: 81, text: 'q' },
  r: { key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, text: 'r' },
  s: { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, text: 's' },
  t: { key: 't', code: 'KeyT', windowsVirtualKeyCode: 84, text: 't' },
  u: { key: 'u', code: 'KeyU', windowsVirtualKeyCode: 85, text: 'u' },
  v: { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, text: 'v' },
  w: { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, text: 'w' },
  x: { key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, text: 'x' },
  y: { key: 'y', code: 'KeyY', windowsVirtualKeyCode: 89, text: 'y' },
  z: { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, text: 'z' },
  '1': { key: '1', code: 'Digit1', windowsVirtualKeyCode: 49, text: '1' },
  '2': { key: '2', code: 'Digit2', windowsVirtualKeyCode: 50, text: '2' },
  '3': { key: '3', code: 'Digit3', windowsVirtualKeyCode: 51, text: '3' },
  '4': { key: '4', code: 'Digit4', windowsVirtualKeyCode: 52, text: '4' },
  '5': { key: '5', code: 'Digit5', windowsVirtualKeyCode: 53, text: '5' },
  '6': { key: '6', code: 'Digit6', windowsVirtualKeyCode: 54, text: '6' },
  '7': { key: '7', code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' },
  '8': { key: '8', code: 'Digit8', windowsVirtualKeyCode: 56, text: '8' },
  '9': { key: '9', code: 'Digit9', windowsVirtualKeyCode: 57, text: '9' },
  '0': { key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, text: '0' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
  control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }
};

function keyInfo(key) {
  const k = String(key).toLowerCase();
  if (KEY_MAP[k]) return KEY_MAP[k];
  const ch = String(key);
  // Only a single character produces text. A named key that is missing from
  // KEY_MAP (e.g. "Delete") must stay a raw key event: sending its name as
  // `text` makes CDP reject the whole dispatch with "Invalid 'text' parameter".
  return {
    key: ch,
    code: ch.length === 1 ? `Key${ch.toUpperCase()}` : ch,
    windowsVirtualKeyCode: 0,
    text: ch.length === 1 ? ch : undefined
  };
}

function serializeMatcher(value) {
  if (value instanceof RegExp) {
    return { __regex: value.source, flags: value.flags };
  }
  return value;
}

function deserializeMatcher(value) {
  if (value && typeof value === 'object' && value.__regex !== undefined) {
    return new RegExp(value.__regex, value.flags || '');
  }
  return value;
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`timeout GET ${url}`));
    });
    req.on('error', reject);
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCdp(port, timeoutMs = CDP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const version = await httpGet(`http://127.0.0.1:${port}/json/version`, 1500);
      if (version && version.webSocketDebuggerUrl) return version;
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error(`CDP not ready on port ${port}: ${lastErr ? lastErr.message : 'timeout'}`);
}

class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this._id = 0;
    this._pending = new Map();
    this._closed = false;
    this._handlers = new Map();
  }

  /** Subscribe to a CDP event (e.g. Network.requestWillBeSent). Returns an unsubscribe fn. */
  on(method, handler) {
    if (!this._handlers.has(method)) this._handlers.set(method, new Set());
    this._handlers.get(method).add(handler);
    return () => this._handlers.get(method)?.delete(handler);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      const onOpen = () => {
        cleanup();
        resolve(this);
      };
      const onError = (ev) => {
        cleanup();
        reject(new Error(`CDP WebSocket error: ${ev && ev.message ? ev.message : 'unknown'}`));
      };
      const cleanup = () => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        } catch (e) {
          return;
        }
        if (msg.method) {
          const handlers = this._handlers.get(msg.method);
          if (handlers) {
            for (const h of handlers) {
              try {
                h(msg.params);
              } catch (e) {
                // a broken handler must not kill the socket
              }
            }
          }
        }
        if (msg.id == null) return;
        const entry = this._pending.get(msg.id);
        if (!entry) return;
        this._pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
        else entry.resolve(msg.result);
      });
      ws.addEventListener('close', () => {
        this._closed = true;
        for (const [, entry] of this._pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('CDP closed'));
        }
        this._pending.clear();
      });
    });
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (!this.ws || this._closed) {
      return Promise.reject(new Error('CDP session closed'));
    }
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP timeout ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  close() {
    try {
      if (this.ws) this.ws.close();
    } catch (e) {}
    this._closed = true;
  }
}

class Locator {
  constructor(page, query) {
    this.page = page;
    this.query = query;
    this._first = false;
  }

  first() {
    const loc = new Locator(this.page, this.query);
    loc._first = true;
    return loc;
  }

  async count() {
    return this.page._countMatches(this.query);
  }

  async click(options = {}) {
    const point = await this.page._clickPoint(this.query, this._first);
    if (!point) {
      throw new Error(`Locator.click: no match for ${JSON.stringify(this.query)}`);
    }
    const delay = options.delay || 0;
    if (delay) await sleep(delay);
    await this.page.mouse.move(point.x, point.y);
    await sleep(30 + Math.random() * 60);
    await this.page.mouse.click(point.x, point.y);
  }
}

class CdpPage {
  constructor(session, targetId, browser) {
    this._session = session;
    this._targetId = targetId;
    this._browser = browser;
    this._url = 'about:blank';
    this.keyboard = {
      down: async (key) => this._key('down', key),
      up: async (key) => this._key('up', key),
      press: async (key) => {
        await this._key('down', key);
        await sleep(20 + Math.random() * 40);
        await this._key('up', key);
      },
      type: async (text, options = {}) => {
        const delay = options.delay || 0;
        for (const ch of String(text)) {
          await this._key('down', ch);
          await this._key('up', ch);
          if (delay) await sleep(delay);
        }
      }
    };
    this.mouse = {
      move: async (x, y) => {
        await this._session.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(x),
          y: Math.round(y),
          button: 'none'
        });
      },
      click: async (x, y, options = {}) => {
        const button = options.button || 'left';
        const clickCount = options.clickCount || 1;
        await this._session.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: Math.round(x),
          y: Math.round(y),
          button,
          clickCount,
          buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4
        });
        await sleep(20 + Math.random() * 50);
        await this._session.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: Math.round(x),
          y: Math.round(y),
          button,
          clickCount,
          buttons: 0
        });
      }
    };
  }

  async _key(action, key) {
    const info = keyInfo(key);
    if (action === 'down') {
      const params = {
        type: info.text ? 'keyDown' : 'rawKeyDown',
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.windowsVirtualKeyCode || 0,
        nativeVirtualKeyCode: info.windowsVirtualKeyCode || 0
      };
      if (info.text) params.text = info.text;
      await this._session.send('Input.dispatchKeyEvent', params);
      if (info.text) {
        await this._session.send('Input.dispatchKeyEvent', {
          type: 'char',
          key: info.key,
          text: info.text
        }).catch(() => {});
      }
    } else {
      await this._session.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.windowsVirtualKeyCode || 0,
        nativeVirtualKeyCode: info.windowsVirtualKeyCode || 0
      });
    }
  }

  async evaluate(fn, arg) {
    let expression;
    if (typeof fn === 'function') {
      const src = fn.toString();
      expression = arg !== undefined ? `(${src})(${JSON.stringify(arg)})` : `(${src})()`;
    } else {
      expression = String(fn);
    }
    const res = await this._session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (res.exceptionDetails) {
      const detail =
        res.exceptionDetails.exception && res.exceptionDetails.exception.description
          ? res.exceptionDetails.exception.description
          : res.exceptionDetails.text || 'evaluate failed';
      throw new Error(detail);
    }
    return res.result ? res.result.value : undefined;
  }

  url() {
    return this._url;
  }

  async goto(url, options = {}) {
    const timeout = options.timeout || CDP_TIMEOUT_MS;
    const started = Date.now();
    await this._session.send('Page.navigate', { url }).catch((e) => {
      // fall through to readiness poll
    });
    let last = '';
    while (Date.now() - started < timeout) {
      try {
        last = await this.evaluate(() => location.href);
        this._url = last || url;
        const ready = await this.evaluate(() => document.readyState);
        if (ready === 'interactive' || ready === 'complete') {
          if (last && last !== 'about:blank') return;
        }
      } catch (e) {
        // target may be navigating
      }
      await sleep(200);
    }
    this._url = last || url;
    return;
  }

  async waitForTimeout(ms) {
    await sleep(ms);
  }

  getByRole(role, options = {}) {
    return new Locator(this, {
      kind: 'role',
      role,
      name: serializeMatcher(options.name),
      exact: !!options.exact
    });
  }

  getByText(text, options = {}) {
    return new Locator(this, {
      kind: 'text',
      text: serializeMatcher(text),
      exact: !!options.exact
    });
  }

  async $(selector) {
    const box = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height
      };
    }, selector);
    if (!box) return null;
    const page = this;
    return {
      selector,
      async click() {
        await page.mouse.move(box.x, box.y);
        await sleep(30);
        await page.mouse.click(box.x, box.y);
      },
      async dispose() {}
    };
  }

  async _countMatches(query) {
    const count = await this.evaluate((q) => {
      const nameM = q.name && typeof q.name === 'object' && q.name.__regex !== undefined
        ? new RegExp(q.name.__regex, q.name.flags || '')
        : q.name;
      const textM = q.text && typeof q.text === 'object' && q.text.__regex !== undefined
        ? new RegExp(q.text.__regex, q.text.flags || '')
        : q.text;

      const accessible = (el) =>
        [
          el.innerText || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.value || '',
          el.getAttribute('name') || ''
        ]
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

      if (q.kind === 'role') {
        const sel =
          q.role === 'button'
            ? 'button, [role="button"], input[type="button"], input[type="submit"]'
            : `[role="${q.role}"]`;
        const els = Array.from(document.querySelectorAll(sel));
        return els.filter((el) => {
          const label = accessible(el);
          if (nameM instanceof RegExp) return nameM.test(label) || nameM.test(el.innerText || '');
          if (typeof nameM === 'string' && nameM) {
            return q.exact ? label === nameM : label.toLowerCase().includes(nameM.toLowerCase());
          }
          return true;
        }).length;
      }

      if (q.kind === 'text') {
        const sel = 'button, a, [role="button"], label, span, div, p, li, h1, h2, h3, h4, td, th';
        const els = Array.from(document.querySelectorAll(sel));
        let n = 0;
        for (const el of els) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          if (textM instanceof RegExp) {
            if (textM.test(t)) n++;
          } else if (typeof textM === 'string' && textM) {
            if (q.exact ? t === textM : t.includes(textM)) n++;
          }
        }
        return n;
      }
      return 0;
    }, query);
    return typeof count === 'number' ? count : 0;
  }

  async _clickPoint(query, preferFirst) {
    const qIn = Object.assign({}, query, { preferFirst: !!preferFirst });
    return this.evaluate((q) => {
      const nameM = q.name && typeof q.name === 'object' && q.name.__regex !== undefined
        ? new RegExp(q.name.__regex, q.name.flags || '')
        : q.name;
      const textM = q.text && typeof q.text === 'object' && q.text.__regex !== undefined
        ? new RegExp(q.text.__regex, q.text.flags || '')
        : q.text;

      const accessible = (el) =>
        [
          el.innerText || '',
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.value || '',
          el.getAttribute('name') || ''
        ]
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

      const pick = (el) => {
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };

      if (q.kind === 'role') {
        const sel =
          q.role === 'button'
            ? 'button, [role="button"], input[type="button"], input[type="submit"]'
            : `[role="${q.role}"]`;
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const label = accessible(el);
          if (nameM instanceof RegExp) {
            if (nameM.test(label) || nameM.test(el.innerText || '')) return pick(el);
          } else if (typeof nameM === 'string' && nameM) {
            const ok = q.exact ? label === nameM : label.toLowerCase().includes(nameM.toLowerCase());
            if (ok) return pick(el);
          } else {
            return pick(el);
          }
        }
        return null;
      }

      if (q.kind === 'text') {
        const sel = 'button, a, [role="button"], label, span, div, p, li, h1, h2, h3, h4, td, th';
        const els = Array.from(document.querySelectorAll(sel));
        let best = null;
        let bestScore = -1;
        for (const el of els) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t) continue;
          let match = false;
          if (textM instanceof RegExp) match = textM.test(t);
          else if (typeof textM === 'string' && textM) {
            match = q.exact ? t === textM : t.includes(textM);
          }
          if (!match) continue;
          const score = t.length;
          if (score < bestScore || bestScore < 0) {
            best = el;
            bestScore = score;
          }
          if (q.preferFirst) return pick(el);
        }
        return pick(best);
      }
      return null;
    }, qIn);
  }

  async close() {
    try {
      await this._session.send('Target.closeTarget', { targetId: this._targetId });
    } catch (e) {}
  }
}

class CdpContext {
  constructor(browser) {
    this._browser = browser;
    this._pages = [];
  }

  pages() {
    return this._pages.slice();
  }

  async newPage(url = 'about:blank') {
    return this._browser._attachNewPage(url);
  }

  async close() {
    await this._browser.close();
  }
}

class Browser {
  constructor({ port, version, owned }) {
    this.port = port;
    this.version = version;
    this.owned = owned; // true if we spawned this process
    this.child = null;
    this.context = new CdpContext(this);
    this._pageSessions = [];
  }

  static async ensure(options = {}) {
    const profile = options.profile || DEFAULT_PROFILE;
    const port = options.port || DEFAULT_PORT;
    const seed = options.seed || DEFAULT_SEED;
    const spawnIfNeeded = options.spawn !== false;

    let version = null;
    try {
      version = await httpGet(`http://127.0.0.1:${port}/json/version`, 2000);
    } catch (e) {
      version = null;
    }

    let owned = false;
    if (!version) {
      if (!spawnIfNeeded) {
        throw new Error(`CDP not available on port ${port} and spawn disabled`);
      }
      if (!fs.existsSync(DEFAULT_CLOAK)) {
        throw new Error(`CloakBrowser binary missing: ${DEFAULT_CLOAK}`);
      }
      if (!fs.existsSync(profile)) {
        fs.mkdirSync(profile, { recursive: true });
      }
      const args = [
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        `--user-data-dir=${profile}`,
        '--no-sandbox',
        `--fingerprint=${seed}`,
        '--fingerprint-platform=windows',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--start-maximized',
        '--enable-extensions',
        ...(LOAD_EXTENSIONS.length
          ? [`--load-extension=${LOAD_EXTENSIONS.join(',')}`]
          : []),
        'about:blank'
      ];
      // `detached: true` is what keeps the browser alive after this process
      // exits. With it false the child shares our console and Windows tears the
      // whole tree down when node ends, which is how the game session was lost
      // on every restart even though the login cookies lived on disk.
      const child = spawn(DEFAULT_CLOAK, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref?.();
      version = await waitForCdp(port, CDP_TIMEOUT_MS);
      owned = true;
      const browser = new Browser({ port, version, owned });
      browser.child = child;
      await browser._loadPages();
      return browser;
    }

    // Reuse existing CDP endpoint (do NOT kill chrome processes).
    const browser = new Browser({ port, version, owned: false });
    await browser._loadPages();
    return browser;
  }

  async _loadPages() {
    const targets = await httpGet(`http://127.0.0.1:${this.port}/json`, 3000).catch(() => []);
    const pages = (targets || []).filter((t) => t.type === 'page');
    for (const t of pages) {
      if (!t.webSocketDebuggerUrl) continue;
      try {
        const session = new CdpSession(t.webSocketDebuggerUrl);
        await session.connect();
        await session.send('Page.enable').catch(() => {});
        await session.send('Runtime.enable').catch(() => {});
        const page = new CdpPage(session, t.id, this);
        page._url = t.url || 'about:blank';
        this.context._pages.push(page);
        this._pageSessions.push(session);
      } catch (e) {
        // skip unusable target
      }
    }
    if (this.context._pages.length === 0) {
      await this._attachNewPage('about:blank');
    }
  }

  async _attachNewPage(url = 'about:blank') {
    const versionSession = new CdpSession(this.version.webSocketDebuggerUrl);
    await versionSession.connect();
    try {
      const { targetId } = await versionSession.send('Target.createTarget', { url });
      const targets = await httpGet(`http://127.0.0.1:${this.port}/json`, 3000);
      const t = targets.find((x) => x.id === targetId);
      if (!t || !t.webSocketDebuggerUrl) {
        throw new Error('created target missing ws url');
      }
      const session = new CdpSession(t.webSocketDebuggerUrl);
      await session.connect();
      await session.send('Page.enable').catch(() => {});
      await session.send('Runtime.enable').catch(() => {});
      const page = new CdpPage(session, targetId, this);
      page._url = url;
      this.context._pages.push(page);
      this._pageSessions.push(session);
      return page;
    } finally {
      versionSession.close();
    }
  }

  async pickPage(predicate) {
    const pages = this.context.pages();
    if (predicate) {
      const hit = pages.find(predicate);
      if (hit) return hit;
    }
    return pages[0] || (await this._attachNewPage());
  }

  async close() {
    // Only close if we spawned it OR caller asks. Never kill unrelated chrome.exe.
    for (const s of this._pageSessions) {
      try {
        s.close();
      } catch (e) {}
    }
    if (this.owned && this.child) {
      try {
        this.child.kill();
      } catch (e) {}
    }
  }
}

/**
 * Ensure CloakBrowser is reachable over CDP and return { browser, context, page }.
 */
async function ensureBrowser(options = {}) {
  const browser = await Browser.ensure(options);
  const gameUrl = options.gameUrl;
  const page = await browser.pickPage((p) => {
    const u = p.url();
    if (gameUrl) return u.includes(new URL(gameUrl).hostname);
    return u && u !== 'about:blank' && u !== '';
  });
  return { browser, context: browser.context, page };
}

module.exports = {
  ensureBrowser,
  Browser,
  CdpPage,
  CdpSession,
  sleep,
  DEFAULT_PROFILE,
  DEFAULT_PORT,
  DEFAULT_SEED
};
