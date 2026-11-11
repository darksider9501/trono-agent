/**
 * Session keep-alive for Defiende el Trono.
 *
 * The game expires the session after 3 minutes without TRUSTED user input
 * (assets/js/session-idle.js: `if (!event.isTrusted ...) return;`). Synthetic
 * clicks never count, so the only reliable renewal is the same call the client
 * makes for a real player: POST /api/session_activity.php action=activity.
 *
 * Usage:
 *   node scripts/trono/keepalive.js                 # runs forever, 45s cadence
 *   node scripts/trono/keepalive.js --once          # single beat, then exit
 *   node scripts/trono/keepalive.js --every=30
 *
 * Exit codes: 0 ok, 3 session dead (401/403 or expire), 1 error.
 */
const fs = require('fs');
const path = require('path');
const { Game, sleep } = require('./lib/game');

const args = process.argv.slice(2);
const once = args.includes('--once');
const everyArg = args.find((a) => a.startsWith('--every='));
const everyMs = (everyArg ? parseInt(everyArg.split('=')[1], 10) : 45) * 1000;

const LOG_DIR = path.join(__dirname, 'logs');
const LOG = path.join(LOG_DIR, 'keepalive.log');

function log(line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}`;
  console.log(text);
  try {
    // keep the log small: rotate at ~512 KB
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 512 * 1024) {
      fs.renameSync(LOG, LOG + '.1');
    }
    fs.appendFileSync(LOG, text + '\n', 'utf8');
  } catch (e) {
    console.error('log write failed:', e.message);
  }
}

(async () => {
  const g = await Game.connect();
  try {
    let cfg = await g.idleConfig();
    let beats = 0;

    for (;;) {
      const beat = await g.heartbeat(cfg);
      beats += 1;
      if (!beat.alive) {
        log(`SESSION_DEAD status=${beat.status} resp=${JSON.stringify(beat.response).slice(0, 200)}`);
        process.exit(3);
      }
      if (once || beats === 1) {
        log(`beat ok status=${beat.status} timeout=${cfg.timeoutMs}ms endpoint=${cfg.endpoint}`);
      }
      if (once) return;

      // Refresh the CSRF/config occasionally: it is bound to the session instance.
      if (beats % 10 === 0) {
        try {
          cfg = await g.idleConfig();
        } catch (e) {
          log(`config refresh failed: ${e.message}`);
        }
      }
      // jitter so the cadence is not a perfect metronome
      await sleep(everyMs + Math.floor(Math.random() * 8000));
    }
  } finally {
    g.close();
  }
})().catch((e) => {
  log(`ERROR ${e.code || ''} ${e.message}`);
  process.exit(1);
});
