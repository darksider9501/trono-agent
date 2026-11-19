/**
 * Canal de control del agente de "Defiende el Trono":
 *  - estado local de la máquina: state/control.json (pausa/stop) y state/ticker.json
 *    (liveness: pid + última vez que el loop salió).
 *  - configuración de la nube: ~/.trono/cloud.json (equivalente en la VM: el
 *    control server lee el mismo archivo; si el VM corre otro OS, se exporta
 *    TRONO_CLOUD_JSON a su path real).
 *  - health check del control server de la nube (Bearer token).
 */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const STATE_DIR = process.env.TRONO_STATE_DIR || path.join(__dirname, '..', 'state');
const CONTROL_PATH = path.join(STATE_DIR, 'control.json');
const TICKER_PATH = path.join(STATE_DIR, 'ticker.json');
// El runner loguea en logs/runner.log (siguiendo a lib/); fíjate en
// TRONO_LOG_FILE para sobreponer.
const LOG_FILE = process.env.TRONO_LOG_FILE || path.join(__dirname, '..', 'logs', 'runner.log');
const CLOUD_JSON = process.env.TRONO_CLOUD_JSON || path.join(os.homedir(), '.trono', 'cloud.json');

function cloudConfig() {
  try {
    const d = JSON.parse(fs.readFileSync(CLOUD_JSON, 'utf8'));
    // El placeholder no es una URL de nube válida: lo tratamos como "no configurada".
    if (d && typeof d.url === 'string' && d.url && !d.url.toLowerCase().includes('your_oracle_vm')) {
      return d;
    }
    return null;
  } catch {
    return null;
  }
}

function readControl() {
  try {
    const d = JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8'));
    return { paused: !!d.paused, stop: !!d.stop, ts: d.ts || null, note: d.note || '' };
  } catch {
    return { paused: false, stop: false, ts: null, note: '' };
  }
}

function writeControl(patch) {
  const next = { ...readControl(), ...patch, ts: new Date().toISOString() };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(CONTROL_PATH, JSON.stringify(next) + '\n');
  } catch {
    // control files are sugar, not mission-critical
  }
}

function readTicker() {
  try {
    return JSON.parse(fs.readFileSync(TICKER_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeTicker(obj) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(TICKER_PATH, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...obj }) + '\n');
  } catch {
    // same as writeControl: best effort
  }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFileTail(file, n) {
  try {
    const c = fs.readFileSync(file, 'utf8');
    return c.split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

/** HTTP(S) GET con respuesta parseada como JSON. null si falla. */
function httpGet(url, headers, rejectUnauthorized, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: 'GET', headers, timeout: timeoutMs, rejectUnauthorized },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          if (body.length > 65536) res.pause();
          body += d;
          if (body.length > 65536) {
            res.destroy();
            resolve(null);
            return;
          }
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Si la nube está viva, responde: { url, machine }. */
async function cloudHealth(timeoutMs = 4000) {
  const cfg = cloudConfig();
  if (!cfg) return null;
  const auth = cfg.token ? { authorization: `Bearer ${cfg.token}` } : {};
  const ok = await httpGet(new URL('/api/health', cfg.url), auth, !cfg.insecure, timeoutMs);
  if (ok && ok.ok) {
    return { url: cfg.url, machine: cfg.machine || null, token: !!cfg.token };
  }
  return null;
}

async function cloudOwnerActive() {
  const h = await cloudHealth();
  return !!h;
}

module.exports = {
  STATE_DIR,
  CONTROL_PATH,
  TICKER_PATH,
  LOG_FILE,
  CLOUD_JSON,
  cloudConfig,
  readControl,
  writeControl,
  readTicker,
  writeTicker,
  pidAlive,
  readFileTail,
  httpGet,
  cloudHealth,
  cloudOwnerActive,
};
