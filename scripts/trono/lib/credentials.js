/**
 * Credential store for Defiende el Trono.
 *
 * Never hardcode secrets in scripts or agent files. Credentials live outside
 * any repository at %USERPROFILE%\.trono\credentials.json (ACL-restricted to
 * the current user), or in TRONO_USER / TRONO_PASS env vars.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.trono');
const FILE = path.join(DIR, 'credentials.json');

function load() {
  const envUser = process.env.TRONO_USER;
  const envPass = process.env.TRONO_PASS;
  if (envUser && envPass) return { username: envUser, password: envPass, source: 'env' };
  if (!fs.existsSync(FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw.username || !raw.password) return null;
    return { username: raw.username, password: raw.password, source: FILE };
  } catch (e) {
    return null;
  }
}

function save({ username, password }) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ username, password }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return FILE;
}

module.exports = { load, save, FILE };
