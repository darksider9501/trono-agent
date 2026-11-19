/**
 * Horario de silencio del agente de "Defiende el Trono": sin HTTP (login,
 * heartbeat, diarias, fights...) entre las 00:00 y las 07:00 hora Cuba
 * (America/Havana).
 *
 * Por qué Intl.DateTimeFormat y no un offset fijo de UTC-5: Cuba se mueve
 * (cambio de horario por solsticio/llegada de luz). Hardcodear -5 pasa
 * desapercibido medio año. Si el tz data del ICU falta, this module olfa y
 * disfrutimos: cero silencio (mejor a la larga que el agente tan bien anotado).
 *
 * Uso:
 *   const q = require('./lib/quiet');
 *   q.state()          // { quiet: bool, until: epochMs | null }
 *   await q.sleepWhileQuiet();
 */
'use strict';

const QUITE_ENABLED = process.env.TRONO_QUIET !== '0';
const START = parseH(process.env.TRONO_QUIET_START || '00'); // minutos del día
const END = parseH(process.env.TRONO_QUIET_END || '07');
const TZ = process.env.TRONO_TZ || 'America/Havana';

function parseH(s) {
  const m = String(s).trim().toUpperCase().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10);
}

let tzSupported = true;

function parts(nowMs) {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // SIN esto, en-US devuelve h12 ("03" + dayPeriod "PM") y las 15:53 se
      // leen como 03:55 -> falsa ventana de silencio toda la tarde.
      hourCycle: 'h23',
    });
    const map = {};
    for (const p of f.formatToParts(nowMs)) if (p.type !== 'literal') map[p.type] = p.value;
    return {
      y: Number(map.year),
      m: Number(map.month),
      d: Number(map.day),
      t: (Number(map.hour) % 24) * 60 + Number(map.minute),
    };
  } catch {
    // ICU sin tz data de Cuba: mejor no silenciar, mejor no hacer nada.
    if (tzSupported) {
      tzSupported = false;
      console.warn(`[quiet] Intl no soporta la zona ${TZ} en este Node; silencio desactivado`);
    }
    return { y: 0, m: 1, d: 1, t: 999 };
  }
}

function intervals() {
  if (!tzSupported) return [];
  return intervalsImpl();
}

function intervalsImpl() {
  if (!QUITE_ENABLED || START === END) return [];
  if (START < END) return [{ s: START, e: END }];
  return [{ s: START, e: 1440 }, { s: 0, e: END }];
}

function inAnyQuiet(t) {
  for (const iv of intervals()) if (t >= iv.s && t < iv.e) return true;
  return false;
}

const LIMIT_MS = 5 * 24 * 3600000;

/** Primera epoch >= fromMs que está dentro de algún intervalo de silencio. */
function firstQuietStart(fromMs) {
  const limit = fromMs + LIMIT_MS;
  for (let x = Math.floor((fromMs + 60000) / 60000) * 60000; x <= limit; x += 60000) {
    if (inAnyQuiet(parts(x).t)) return x;
  }
  return null;
}

/** Primera epoch >= fromMs que sale de un intervalo de silencio. */
function firstQuietEnd(fromMs) {
  const limit = fromMs + LIMIT_MS;
  for (let x = Math.floor((fromMs + 60000) / 60000) * 60000; x <= limit; x += 60000) {
    if (!inAnyQuiet(parts(x).t)) return x;
  }
  return null;
}

function state(nowMs = Date.now()) {
  if (inAnyQuiet(parts(nowMs).t)) {
    return { quiet: true, until: firstQuietEnd(nowMs) || Infinity };
  }
  return { quiet: false, until: firstQuietStart(nowMs) };
}

function fmt(m) {
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

async function sleepWhileQuiet() {
  for (;;) {
    const s = state();
    if (!s.quiet) return;
    const ms = s.until === Infinity ? 3600000 : Math.max(1000, s.until - Date.now());
    await new Promise((r) => setTimeout(r, Math.min(ms, 300000)));
  }
}

module.exports = {
  state,
  sleepWhileQuiet,
  intervals,
  firstQuietStart,
  firstQuietEnd,
  inAnyQuiet,
  parts,
  TZ,
  START,
  END,
  quietEnabled: QUITE_ENABLED,
  fmt,
};
