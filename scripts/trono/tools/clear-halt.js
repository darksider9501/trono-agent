#!/usr/bin/env node
/**
 * Human-only release of a security halt.
 *
 * The breaker in lib/security.js stops every request when the game starts
 * showing a challenge, a captcha, a WAF or bot-management cookies. That stop is
 * deliberately sticky: automatic restarts (the Hub) must not look like a human
 * deciding the coast is clear.
 *
 *   node tools/clear-halt.js                        # show the halt, change nothing
 *   node tools/clear-halt.js --ack="checked, it was a false positive"
 *
 * Clearing archives the record to logs/security-halt.cleared.log so the episode
 * is auditable, then deletes state/halt.json so the agent may run again.
 */
const security = require('../lib/security');

const ackArg = process.argv.slice(2).find((a) => a.startsWith('--ack='));
const ack = ackArg ? ackArg.slice('--ack='.length).trim() : '';
const MIN_ACK = 10;

const halt = security.readHalt();

if (!halt) {
  console.log('no halt active - the agent is free to run');
  process.exit(0);
}

console.log('SECURITY HALT ACTIVE');
console.log('--------------------');
console.log(`  when    : ${halt.at || 'unknown'}`);
console.log(`  where   : ${halt.where}`);
if (halt.url) console.log(`  url     : ${halt.url}`);
if (halt.status !== null && halt.status !== undefined) console.log(`  status  : ${halt.status}`);
console.log(`  signals : ${(halt.signals || []).join(', ')}`);
if (halt.cookies && halt.cookies.length) console.log(`  cookies : ${halt.cookies.join(', ')}`);
if (halt.excerpt) console.log(`  evidence: ${halt.excerpt.slice(0, 300)}`);
console.log('');
console.log('The agent will not send a single request to the game until this is cleared.');
console.log('Open the game in a browser yourself first and check what it shows.');

if (!ack) {
  console.log('');
  console.log('Refusing to clear without an acknowledgement.');
  console.log('Re-run with what you actually saw, e.g.:');
  console.log('  node tools/clear-halt.js --ack="opened the site, no captcha, game loaded normally"');
  process.exit(1);
}

if (ack.length < MIN_ACK) {
  console.log('');
  console.log(`Acknowledgement too short (${ack.length} chars, minimum ${MIN_ACK}). Say what you checked.`);
  process.exit(1);
}

const cleared = security.clear({ ack });
console.log('');
console.log(`cleared. halt archived to ${security.HALT_LOG.replace(/\.log$/, '.cleared.log')}`);
console.log('Restart the agent when you want it back online.');
