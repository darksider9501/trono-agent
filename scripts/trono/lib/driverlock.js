/**
 * Single-driver lock.
 *
 * The game rotates the session instance on every activity ping: two processes
 * beating the same account invalidate each other, the tab gets redirected to the
 * lobby, and every in-flight Runtime.evaluate dies with "Inspected target navigated".
 * So exactly one process may drive the CloakBrowser tab at a time.
 *
 * Staleness is decided by a HEARTBEAT, not by `kill(pid, 0)` alone.
 *
 * On 2026-11-18 the lock file named pid 2228. That process had died and Windows
 * recycled the number onto `svchost.exe`, so `kill(2228, 0)` kept succeeding and
 * `current()` kept reporting a live holder that did not exist. The runner refused
 * to start ("another driver is active") forever, with no way out but deleting the
 * file by hand. A PID is not an identity.
 *
 * Now the holder must also keep its `beat` field fresh. A lock whose owner stopped
 * heartbeating is declared stale and can be taken, which covers the recycled-PID
 * case and the crash-without-release case with the same rule.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', 'logs');
const LOCK = path.join(DIR, 'driver.lock');

/**
 * How long a holder may go without heartbeating before its lock is considered
 * abandoned. Deliberately generous: ticks are 90s apart and a long fight or a
 * role-recovery round trip can take several minutes. A stale lock pauses the
 * agent, which is annoying; a false "stale" verdict runs two drivers at once,
 * which corrupts the session. Asymmetric costs, so the timeout leans long.
 */
const TTL_MS = 15 * 60 * 1000;

const HOST = os.hostname();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (e) {
    return null;
  }
}

/** Why a lock is not usable, or null when it is a live holder. */
function problem(raw) {
  if (!raw) return 'unreadable';
  if (!raw.pid) return 'no pid';
  if (!alive(raw.pid)) return 'holder is gone';
  // A holder on another machine cannot heartbeat into this file reliably, so its
  // age is the only signal we have. Treat it as live until the TTL says otherwise.
  //
  // A lock written before the heartbeat existed has no `host` field at all, and
  // those must be age-checked too — otherwise the very lock this change was made
  // for (pid 2228, recycled onto svchost, 189 minutes old) still reads as live
  // forever. An absent `host` means "this machine", not "unknown machine".
  const beat = Number(raw.beat || Date.parse(raw.at) || 0);
  const sameMachine = !raw.host || raw.host === HOST;
  if (sameMachine && beat && Date.now() - beat > TTL_MS) {
    return `holder stopped heartbeating ${Math.round((Date.now() - beat) / 60000)}m ago`;
  }
  return null;
}

/** The live holder, or null when the lock is free or stale. */
function current() {
  const raw = read();
  if (!raw) return null;
  return problem(raw) ? null : raw;
}

/** One line describing the lock, stale or not. For logs and diagnostics. */
function describe() {
  if (!fs.existsSync(LOCK)) return 'no lock';
  const raw = read();
  if (!raw) return 'lock file present but unreadable — treated as stale';
  const why = problem(raw);
  const beat = Number(raw.beat || Date.parse(raw.at) || 0);
  const age = beat ? `${Math.round((Date.now() - beat) / 60000)}m` : '?';
  return `${raw.name || '?'} pid ${raw.pid} beat ${age}${why ? ` — STALE: ${why}` : ''}`;
}

function acquire(name, opts = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const raw = read();
  const holder = raw && !problem(raw) ? raw : null;
  if (holder && !opts.force) {
    return { ok: false, holder };
  }
  const stale = raw && problem(raw) ? problem(raw) : null;
  fs.writeFileSync(
    LOCK,
    JSON.stringify({ pid: process.pid, name, host: HOST, at: new Date().toISOString(), beat: Date.now() }),
    'utf8'
  );
  return { ok: true, stale };
}

/**
 * Refresh the timestamp, but only if we still own the lock.
 *
 * Returns false when someone else took it, which is the signal to stop driving
 * the tab immediately: our session is already invalidated at that point and every
 * further evaluate would die with "Inspected target navigated".
 */
function heartbeat() {
  const raw = read();
  if (!raw || raw.pid !== process.pid) return false;
  try {
    raw.beat = Date.now();
    fs.writeFileSync(LOCK, JSON.stringify(raw), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Keep the lock fresh in the background. Returns a handle with `stop()`.
 *
 * `onLost` fires the first time a heartbeat finds the lock owned by someone else.
 * It is not called on transient write errors: losing the file and losing the lock
 * are different failures.
 */
function keepAlive(onLost, everyMs = 60000) {
  let lost = false;
  const timer = setInterval(() => {
    if (heartbeat()) return;
    if (lost) return;
    lost = true;
    if (typeof onLost === 'function') {
      try {
        onLost();
      } catch (e) {}
    }
  }, everyMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

function release() {
  try {
    const raw = read();
    if (raw && raw.pid === process.pid) fs.unlinkSync(LOCK);
  } catch (e) {}
}

module.exports = { acquire, release, current, describe, heartbeat, keepAlive, LOCK, TTL_MS };
