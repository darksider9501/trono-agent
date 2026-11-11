/**
 * Live state snapshot (read-only).
 * Usage: node scripts/trono/state.js [--port=9777]
 */
const { Game } = require('./lib/game');

const portArg = process.argv.find((a) => a.startsWith('--port='));

(async () => {
  const g = await Game.connect({ port: portArg ? parseInt(portArg.split('=')[1], 10) : undefined });
  try {
    if (!(await g.isLoggedIn())) {
      console.error('SESSION_DOWN: no active player state (logged out or tab missing)');
      process.exit(3);
    }
    const snap = await g.state();
    console.log(JSON.stringify(snap, null, 2));
  } finally {
    g.close();
  }
})().catch((e) => {
  console.error(`${e.code || 'ERROR'}: ${e.message}`);
  process.exit(1);
});
