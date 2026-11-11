/**
 * Autonomous login / session recovery for Defiende el Trono.
 *
 * Checks the session and, only if it is dead, logs in with the stored
 * credentials. Never prints the password.
 *
 * Usage:
 *   node scripts/trono/login.js            # login only if session is dead
 *   node scripts/trono/login.js --force    # force a fresh login
 *   node scripts/trono/login.js --save     # store credentials (then exit)
 *
 * Exit codes: 0 session alive, 3 login rejected, 1 error, 2 no credentials.
 */
const { Game } = require('./lib/game');
const credentials = require('./lib/credentials');

const args = process.argv.slice(2);
const force = args.includes('--force');
const saveIdx = args.indexOf('--save');

(async () => {
  if (saveIdx !== -1) {
    const username = args[saveIdx + 1];
    const password = args[saveIdx + 2];
    if (!username || !password) {
      console.error('usage: node scripts/trono/login.js --save <username> <password>');
      process.exit(1);
    }
    const file = credentials.save({ username, password });
    console.log(`credentials stored at ${file}`);
    return;
  }

  const creds = credentials.load();
  if (!creds) {
    console.error(`NO_CREDENTIALS: expected ${credentials.FILE} or TRONO_USER/TRONO_PASS`);
    process.exit(2);
  }

  const g = await Game.connect();
  try {
    if (args.includes('--wipe')) {
      const removed = await g.clearSession();
      console.log(`session cookies dropped: ${removed.join(', ') || 'none matched'}`);
    }
    if (!force && !args.includes('--wipe') && (await g.isLoggedIn())) {
      console.log('session active, no login needed');
      return;
    }
    const res = await g.login(creds);
    if (!res.ok) {
      console.error(`LOGIN_FAILED: ${JSON.stringify(res).slice(0, 300)}`);
      process.exit(3);
    }
    console.log(`logged in as ${creds.username} (${res.skipped || 'fresh'})`);
  } finally {
    g.close();
  }
})().catch((e) => {
  console.error(`${e.code || 'ERROR'}: ${e.message}`);
  process.exit(1);
});
