/**
 * Single-driver lock.
 *
 * The game rotates the session instance on every activity ping: two processes
 * beating the same account invalidate each other, the tab gets redirected to the
 * lobby, and every in-flight Runtime.evaluate dies with "Inspected target navigated".
 * So exactly one process may drive the CloakBrowser tab at a time.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs');
const LOCK = path.join(DIR, 'driver.lock');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function current() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (raw && raw.pid && alive(raw.pid)) return raw;
  } catch (e) {}
  return null;
}

function acquire(name, opts = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const holder = current();
  if (holder && !opts.force) {
    return { ok: false, holder };
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, name, at: new Date().toISOString() }), 'utf8');
  return { ok: true };
}

function release() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    if (raw && raw.pid === process.pid) fs.unlinkSync(LOCK);
  } catch (e) {}
}

module.exports = { acquire, release, current, LOCK };
