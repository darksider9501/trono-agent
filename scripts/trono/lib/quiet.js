/**
 * Ventana de dormancia del agente de "Defiende el Trono".
 *
 * El agente no emite un solo HTTP (login, heartbeat, diarias, peleas) entre la
 * hora de acostarse y la de despertar. La ventana es ALEATORIA por noche:
 *
 *   se acuesta  entre 23:30 y 00:30 hora Cuba
 *   despierta   entre 05:30 y 06:30 hora Cuba
 *
 * Por que aleatoria: un horario fijo es una huella. Un proceso que se conecta
 * todos los dias al segundo 0 de la misma hora se distingue de un humano mas
 * facil que uno que se mueve en una hora de margen. No es una garantia contra
 * nada, es solo no regalar el patron.
 *
 * ---------------------------------------------------------------------------
 * ZONA HORARIA: OFFSET FIJO UTC-4, NO Intl/America/Havana.
 *
 * Cuba decidio mantener el horario de verano de forma permanente: la hora real
 * del pais es UTC-4 todo el ano, sin cambio en noviembre. La tzdata (2026e)
 * todavia registra la vuelta a UTC-5 el 2026-11-02, asi que Intl y cualquier
 * libreria que consulte la base de zonas devuelve UNA HORA DE MENOS y adelanta
 * la dormancia. El reloj de Windows, que sigue en horario de verano, marca la
 * hora correcta.
 *
 * Por eso este modulo NO consulta Intl: resta un offset fijo. Si el pais
 * volviera a mover el reloj, se cambia TRONO_TZ_OFFSET_MIN y listo.
 *
 * Las dos puntas se sortean por separado y la duracion sale de la resta, no al
 * reves: asi la hora de despertar cumple su rango aunque la de acostarse caiga
 * en cualquier punto del suyo.
 *
 * La semilla es la fecha de la noche, no el reloj: un reinicio del proceso a
 * las 03:00 vuelve a calcular EXACTAMENTE la misma ventana. Si se sorteara en
 * cada arranque, cada reinicio cambiaria la hora de despertar y el agente
 * podria no dormir nunca.
 *
 * Uso:
 *   const q = require('./lib/quiet');
 *   q.state()              // { quiet, until, window }
 *   await q.sleepWhileQuiet();
 *
 * Override deterministico (tests y puestas en marcha):
 *   TRONO_QUIET_START=00:00 TRONO_QUIET_END=07:00 node runner.js
 * Con las dos variables puestas la ventana es fija y no se sortea nada.
 */
'use strict';

// Minutos respecto de UTC. -240 = UTC-4 = hora real de Cuba (DST permanente).
const OFFSET_MIN = Number.isFinite(Number(process.env.TRONO_TZ_OFFSET_MIN))
  ? Number(process.env.TRONO_TZ_OFFSET_MIN)
  : -240;

const ENABLED = process.env.TRONO_QUIET !== '0';

// Puntas del sorteo, en minutos desde medianoche local.
const ENTER_FROM = 23 * 60 + 30; // 23:30
const ENTER_SPAN = 60;           // +[0,60)  -> 23:30 .. 00:29
const WAKE_FROM = 5 * 60 + 30;   // 05:30
const WAKE_SPAN = 60;            // +[0,60)  -> 05:30 .. 06:29

// Override fijo. Si las dos estan puestas, no se sortea nada.
const FIXED_START = process.env.TRONO_QUIET_START;
const FIXED_END = process.env.TRONO_QUIET_END;
const HAS_FIXED = !!(FIXED_START && FIXED_END);

function parseH(s) {
  const m = String(s).trim().toUpperCase().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2] || '0', 10);
}

const FIX_S = HAS_FIXED ? parseH(FIXED_START) : null;
const FIX_E = HAS_FIXED ? parseH(FIXED_END) : null;

/** Etiqueta legible de la zona, para logs. */
function tzLabel() {
  const sign = OFFSET_MIN < 0 ? '-' : '+';
  const abs = Math.abs(OFFSET_MIN);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

/** Partes locales (offset fijo). `t` es minuto del dia local. */
function parts(ms) {
  const d = new Date(ms + OFFSET_MIN * 60000);
  const H = d.getUTCHours();
  const M = d.getUTCMinutes();
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    H,
    M,
    S: d.getUTCSeconds(),
    t: H * 60 + M,
  };
}

/** Epoch de una hora de pared local. Offset constante: una sola resta. */
function localToEpoch(y, mo, d, H, M) {
  return Date.UTC(y, mo - 1, d, H, M, 0) - OFFSET_MIN * 60000;
}

/** FNV-1a de 32 bits. Estable entre procesos y entre versiones de Node. */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Finalizador murmur3 (fmix32). NO es cosmetico: FNV-1a sola tiene avalancha
 * pesima entre cadenas que difieren en el ultimo caracter, y las fechas son
 * exactamente eso ("2026-11-20" -> "2026-11-21"). Peor: 16777619 = -1 (mod 60),
 * asi que hash % 60 sobre fechas consecutivas devolvia 00:07, 00:08, 00:09...
 * un horario que se corre un minuto por noche, mas delator que uno fijo.
 * El finalizador mezcla los bits altos hacia los bajos y rompe esa progresion.
 */
function mix32(h) {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Entero uniforme en [0, span) a partir de una semilla de texto.
 *
 * Se escala en vez de usar `%`: el modulo de una potencia de dos se queda con
 * los bits bajos, que son justo los que peor se mezclan. La division usa los
 * 32 bits completos. El sesgo por no ser divisor exacto de 2^32 es de ~1e-8
 * con span=60, invisible.
 */
function pick(text, span) {
  return Math.floor((mix32(hash32(text)) / 4294967296) * span);
}

function keyOf(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(y, m, d, delta) {
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Ventana de la noche que DESPIERTA en la fecha `key`.
 *
 * Se ancla al dia del despertar, no al de acostarse, porque acostarse puede
 * caer despues de medianoche (00:29 del mismo dia en que se despierta). Anclar
 * al despertar hace que cada fecha tenga exactamente una ventana y no haya
 * noches duplicadas ni huecos en los cambios de mes.
 */
function windowFor(key) {
  const [y, mo, d] = key.split('-').map(Number);

  if (HAS_FIXED) {
    const prev = addDays(y, mo, d, -1);
    const startMs = FIX_S < FIX_E
      ? localToEpoch(y, mo, d, Math.floor(FIX_S / 60), FIX_S % 60)
      : localToEpoch(prev.y, prev.m, prev.d, Math.floor(FIX_S / 60), FIX_S % 60);
    const wakeMs = localToEpoch(y, mo, d, Math.floor(FIX_E / 60), FIX_E % 60);
    return {
      key,
      startMs,
      wakeMs,
      enterMin: FIX_S,
      wakeMin: FIX_E,
      durationMin: Math.round((wakeMs - startMs) / 60000),
      fixed: true,
    };
  }

  const enterMin = ENTER_FROM + pick(key + '#enter', ENTER_SPAN);       // 1410..1469
  const wakeMin = WAKE_FROM + pick(key + '#wake', WAKE_SPAN);           // 330..389

  const prev = addDays(y, mo, d, -1);
  // enterMin >= 1440 significa que se acuesta pasada la medianoche, o sea el
  // mismo dia en que despierta. Si no, cae el dia anterior.
  const startMs = enterMin >= 1440
    ? localToEpoch(y, mo, d, 0, enterMin - 1440)
    : localToEpoch(prev.y, prev.m, prev.d, Math.floor(enterMin / 60), enterMin % 60);
  const wakeMs = localToEpoch(y, mo, d, Math.floor(wakeMin / 60), wakeMin % 60);

  return {
    key,
    startMs,
    wakeMs,
    enterMin: enterMin % 1440,
    wakeMin,
    durationMin: Math.round((wakeMs - startMs) / 60000),
    fixed: false,
  };
}

/** Claves de las ventanas que podrian contener un instante dado. */
function candidateKeys(ms) {
  const p = parts(ms);
  const out = [];
  for (const delta of [-1, 0, 1]) {
    const q = addDays(p.y, p.m, p.d, delta);
    out.push(keyOf(q.y, q.m, q.d));
  }
  return out;
}

function inAnyQuiet(ms) {
  if (!ENABLED) return false;
  for (const key of candidateKeys(ms)) {
    const w = windowFor(key);
    if (ms >= w.startMs && ms < w.wakeMs) return true;
  }
  return false;
}

/** Ventana vigente o la proxima. null si el silencio esta desactivado. */
function currentWindow(nowMs) {
  if (!ENABLED) return null;
  for (const key of candidateKeys(nowMs)) {
    const w = windowFor(key);
    if (nowMs >= w.startMs && nowMs < w.wakeMs) return w;
  }
  return null;
}

function nextWindow(nowMs) {
  if (!ENABLED) return null;
  let best = null;
  for (const key of candidateKeys(nowMs)) {
    const w = windowFor(key);
    if (w.startMs > nowMs && (!best || w.startMs < best.startMs)) best = w;
  }
  return best;
}

function state(nowMs = Date.now()) {
  if (!ENABLED) return { quiet: false, until: null, window: null };
  const cur = currentWindow(nowMs);
  if (cur) return { quiet: true, until: cur.wakeMs, window: cur };
  const nxt = nextWindow(nowMs);
  return { quiet: false, until: nxt ? nxt.startMs : null, window: nxt };
}

/**
 * Ventanas nominales de la noche actual, en minutos del dia.
 * `s` puede ser mayor que `e`: significa que la ventana cruza medianoche.
 * Se mantiene para el selftest y para inspeccion; la logica real usa epoch.
 */
function intervals(nowMs = Date.now()) {
  if (!ENABLED) return [];
  const s = state(nowMs);
  const w = s.window || currentWindow(nowMs);
  if (!w) return [];
  return [{ s: w.enterMin, e: w.wakeMin, key: w.key }];
}

/** Primera epoch >= fromMs dentro de una ventana. */
function firstQuietStart(fromMs) {
  if (!ENABLED) return null;
  if (inAnyQuiet(fromMs)) return fromMs;
  const w = nextWindow(fromMs);
  return w ? w.startMs : null;
}

/** Primera epoch >= fromMs fuera de una ventana. */
function firstQuietEnd(fromMs) {
  if (!ENABLED) return null;
  const cur = currentWindow(fromMs);
  if (cur) return cur.wakeMs;
  return fromMs;
}

function fmt(m) {
  if (m === null || m === undefined) return '--:--';
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

/** Formatea una epoch como hora local de Cuba. */
function fmtMs(ms) {
  const p = parts(ms);
  return `${fmt(p.t)} (${keyOf(p.y, p.m, p.d)})`;
}

async function sleepWhileQuiet() {
  for (;;) {
    const s = state();
    if (!s.quiet) return;
    const ms = s.until === null ? 3600000 : Math.max(1000, s.until - Date.now());
    // Trozos de 5 min: un resume humano o un cambio de reloj no esperan al
    // final de la ventana entera.
    await new Promise((r) => setTimeout(r, Math.min(ms, 300000)));
  }
}

module.exports = {
  state,
  sleepWhileQuiet,
  intervals,
  currentWindow,
  nextWindow,
  windowFor,
  firstQuietStart,
  firstQuietEnd,
  inAnyQuiet,
  parts,
  localToEpoch,
  hash32,
  mix32,
  pick,
  keyOf,
  fmt,
  fmtMs,
  tzLabel,
  OFFSET_MIN,
  ENTER_FROM,
  ENTER_SPAN,
  WAKE_FROM,
  WAKE_SPAN,
  quietEnabled: ENABLED,
  fixedWindow: HAS_FIXED,
};
