/**
 * Self-test for lib/driverlock.js.
 *
 * The bug this pins down, from 2026-11-18: the lock file named pid 2228. That
 * process had exited and Windows had recycled the number onto `svchost.exe`, so
 * `process.kill(2228, 0)` kept succeeding and the lock read as held by a live
 * driver that did not exist. The runner exited with "another driver is active"
 * on every start, permanently, and the only way out was deleting the file by
 * hand. A PID is not an identity.
 *
 * Run: node tools/driverlock-selftest.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK = path.join(__dirname, '..', 'logs', 'driver.lock');
const lock = require('../lib/driverlock');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
}

// Never destroy a real lock: back it up and restore it no matter what.
const backup = fs.existsSync(LOCK) ? fs.readFileSync(LOCK, 'utf8') : null;
function writeLock(obj) {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

async function main() {
try {
  // ------------------------------------------------------- the reported bug ---
  // A recycled PID: the number is alive (it is a system process now) but the lock
  // is almost three hours old and never heartbeats. This is the exact state that
  // wedged the agent.
  writeLock({ pid: 2228, name: 'runner', at: '2026-11-18T14:47:08.301Z' });
  check('legacy lock without `host` and without `beat` is stale, not live',
    lock.current() === null, lock.describe());
  check('legacy lock reports why it is stale',
    /STALE/.test(lock.describe()), lock.describe());
  const takeover = lock.acquire('runner');
  check('a stale legacy lock can be taken over',
    takeover.ok === true && typeof takeover.stale === 'string', JSON.stringify(takeover));

  // ------------------------------------------------------- a genuinely live lock ---
  // Our own PID, present, heartbeating now: must NOT be stolen.
  writeLock({ pid: process.pid, name: 'other', host: os.hostname(), at: new Date().toISOString(), beat: Date.now() });
  check('a live, heartbeating holder is respected',
    lock.current() !== null, lock.describe());
  const blocked = lock.acquire('runner');
  check('acquire refuses to steal a live lock',
    blocked.ok === false && blocked.holder && blocked.holder.pid === process.pid, JSON.stringify(blocked));

  // ------------------------------------------------------- heartbeat expiry ---
  const old = Date.now() - lock.TTL_MS - 60000;
  writeLock({ pid: process.pid, name: 'sleepy', host: os.hostname(), at: new Date(old).toISOString(), beat: old });
  check('a holder that stopped heartbeating past the TTL is stale',
    lock.current() === null, lock.describe());

  // Just inside the window must still count as live: the TTL must not be so tight
  // that a long fight or a recovery round trip looks like an abandoned lock.
  const fresh = Date.now() - lock.TTL_MS + 60000;
  writeLock({ pid: process.pid, name: 'slow', host: os.hostname(), at: new Date(fresh).toISOString(), beat: fresh });
  check('a holder just inside the TTL is still live',
    lock.current() !== null, lock.describe());

  // ------------------------------------------------------- dead process ---
  // PID 0 is the idle process and cannot be signalled successfully; use a number
  // that is certainly unused on this machine.
  writeLock({ pid: 999999, name: 'ghost', host: os.hostname(), at: new Date().toISOString(), beat: Date.now() });
  check('a lock whose process is gone is stale',
    lock.current() === null, lock.describe());

  // ------------------------------------------------------- corrupt file ---
  writeLock('{not json');
  check('a corrupt lock file is stale, never "free and fine"',
    lock.current() === null && /unreadable/.test(lock.describe()), lock.describe());

  // ------------------------------------------------------- heartbeat semantics ---
  lock.acquire('runner');
  check('heartbeat succeeds while we own the lock', lock.heartbeat() === true);
  const before = JSON.parse(fs.readFileSync(LOCK, 'utf8')).beat;
  await new Promise((r) => setTimeout(r, 25));
  lock.heartbeat();
  const after = JSON.parse(fs.readFileSync(LOCK, 'utf8')).beat;
  check('heartbeat refreshes the timestamp', after > before, `${before} -> ${after}`);

  // Someone else takes over: our heartbeat must report the loss instead of
  // silently pretending we still drive the tab.
  writeLock({ pid: process.pid + 1 === 0 ? 2 : 424242, name: 'thief', host: os.hostname(), at: new Date().toISOString(), beat: Date.now() });
  check('heartbeat reports false once the lock is not ours', lock.heartbeat() === false);

  // keepAlive must fire onLost exactly once, not on every tick.
  let lostCount = 0;
  const handle = lock.keepAlive(() => { lostCount += 1; }, 5);
  await new Promise((r) => setTimeout(r, 45));
  handle.stop();
  check('keepAlive fires onLost once when the lock is lost', lostCount === 1, `fired ${lostCount}x`);

  // release must not delete a lock owned by someone else.
  writeLock({ pid: 424242, name: 'thief', host: os.hostname(), at: new Date().toISOString(), beat: Date.now() });
  lock.release();
  check('release leaves a lock it does not own', fs.existsSync(LOCK));

  // ...and must delete its own.
  writeLock({ pid: process.pid, name: 'mine', host: os.hostname(), at: new Date().toISOString(), beat: Date.now() });
  lock.release();
  check('release removes our own lock', !fs.existsSync(LOCK));
} finally {
  if (backup !== null) {
    fs.writeFileSync(LOCK, backup, 'utf8');
  } else {
    try {
      fs.unlinkSync(LOCK);
    } catch (e) {}
  }
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <- ' + (r.detail || '')}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
}

main();
