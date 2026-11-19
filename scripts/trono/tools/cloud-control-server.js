#!/usr/bin/env node
/**
 * Control server del agente de "Defiende el Trono" en la nube (Oracle).
 *
 * Lo corre el agente clonado en el VM de la nube. El Hub del usuario lo consulta
 * por HTTP para ver el estado de ejecución, y para pausar/resumir/detener el
 * agente de la nube.
 *
 * Endpoints (autenticado con Bearer token: TRONO_CLOUD_TOKEN, o el token en
 * ~/.trono/cloud.json; si ambos vacíos, el servidor acepta todo —
 * desarrollo local sobre el control loop):
 *
 *   GET  /api/health          -> { ok: true, machine, uptime_s }
 *   GET  /api/status          -> estado completo del agente de la nube:
 *                                 alive, pid, paused, quiet, uptime_s,
 *                                 last_activity, log_tail
 *   POST /api/control/pause   -> pausa la ejecución del agente (loop)
 *   POST /api/control/resume  -> despega: paused=false, stop=false
 *   POST /api/control/stop    -> detiene el agente (runner sorte se sale)
 *
 * Arrancar en la nube: node tools/cloud-control-server.js
 */
'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const control = require('../lib/control');
const quiet = require('../lib/quiet');

const PORT = Number(process.env.TRONO_CLOUD_PORT || 8091);
// Default 0.0.0.0 conserva el comportamiento historico. En una VM publica se
// ata a una IP concreta (o a 127.0.0.1 con un tunel delante) para no regalar
// el puerto a internet: sin esto, el token es lo unico que separa al mundo de
// la cuenta del juego.
const HOST = process.env.TRONO_CLOUD_HOST || '0.0.0.0';
const MACHINE = process.env.TRONO_MACHINE || 'oracle';
const START_MS = Date.now();

const CFG = control.cloudConfig();
const TOKEN = process.env.TRONO_CLOUD_TOKEN || (CFG && CFG.token) || '';
const CLOUD_JSON_PATH = process.env.TRONO_CLOUD_JSON || path.join(os.homedir(), '.trono', 'cloud.json');

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function ctrlPatch(patch) {
  control.writeControl({ source: 'cloud-control-server', ...patch });
}

function agentStatus() {
  const ticker = control.readTicker() || {};
  return {
    alive: control.pidAlive(ticker.pid),
    pid: ticker.pid || null,
    paused: control.readControl().paused,
    quiet: quiet.state().quiet,
    uptime_s: Math.floor((Date.now() - START_MS) / 1000),
    last_activity: ticker.at || null,
    last_tick: ticker.tick ?? null,
    log_tail: control.readFileTail(control.LOG_FILE, 40),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const authenticated = TOKEN ? req.headers['authorization'] === `Bearer ${TOKEN}` : true;

  if (url.pathname === '/api/health' && req.method === 'GET') {
    if (!authenticated) return sendJson(res, 401, { ok: false, error: 'token requerido' });
    return sendJson(res, 200, {
      ok: true,
      server: 'trono-cloud-control',
      machine: MACHINE,
      uptime_s: Math.floor((Date.now() - START_MS) / 1000),
    });
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    if (!authenticated) return sendJson(res, 401, { ok: false, error: 'token requerido' });
    const st = agentStatus();
    return sendJson(res, 200, { ok: true, machine: MACHINE, uptime_s: st.uptime_s, agent: st });
  }

  if (url.pathname.startsWith('/api/control/') && req.method === 'POST') {
    if (!authenticated) return sendJson(res, 401, { ok: false, error: 'token requerido' });
    const action = url.pathname.replace('/api/control/', '');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (action === 'pause') {
        ctrlPatch({ paused: true, note: 'pausado via Hub (nube)' });
        sendJson(res, 200, { ok: true, action: 'pause', note: 'agente: loop detenido; sin requests' });
      } else if (action === 'resume') {
        ctrlPatch({ paused: false, stop: false, note: 'resumido via Hub (nube)' });
        sendJson(res, 200, { ok: true, action: 'resume', note: 'agente: loop volvio a actuar' });
      } else if (action === 'stop') {
        ctrlPatch({ stop: true, note: 'detención pedida via Hub (nube)' });
        sendJson(res, 200, { ok: true, action: 'stop', note: 'agente: sorte un segundo y sale' });
      } else {
        sendJson(res, 404, { ok: false, error: 'acción no reconocida' });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'no encontrado' });
});

try {
  fs.mkdirSync(path.dirname(CLOUD_JSON_PATH), { recursive: true });
} catch {}

server.listen(PORT, HOST, () => {
  const auth = TOKEN ? 'token requerido' : 'SIN TOKEN (dev)';
  console.log(`[trono-cloud] control server: http://${HOST}:${PORT}  (${auth})`);
  console.log(`[trono-cloud] status: GET /api/status | health: GET /api/health`);
  console.log(`[trono-cloud] controles: POST /api/control/{pause,resume,stop}`);
});
