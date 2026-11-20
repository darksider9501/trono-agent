/**
 * Selftest de lib/quiet.js: formato, sorteo de la ventana, determinismo por
 * fecha, cobertura sin huecos ni solapes, y la regresion de zona horaria.
 *
 * Correr con: node tools/quiet-selftest.js
 */
'use strict';

const quiet = require('../lib/quiet');

const asserts = [];
const ok = (cond, msg) => asserts.push({ ok: !!cond, msg });

// --- formato ---
ok(quiet.fmt(0) === '00:00', `fmt(0) === '00:00' (es ${quiet.fmt(0)})`);
ok(quiet.fmt(7 * 60) === '07:00', `fmt(420) === '07:00' (es ${quiet.fmt(420)})`);
ok(quiet.fmt(23 * 60 + 59) === '23:59', 'fmt(1439) === \'23:59\'');
ok(quiet.fmt(60) === '01:00', 'fmt(60) === \'01:00\'');
ok(quiet.fmt(139) === '02:19', 'fmt(139) === \'02:19\'');
ok(quiet.fmt(840) === '14:00', 'fmt(840) === \'14:00\'');
ok(quiet.fmt(null) === '--:--', 'fmt(null) === \'--:--\'');
ok(quiet.fmt(-60) === '23:00', 'fmt(-60) envuelve a 23:00');

// --- zona horaria: offset fijo UTC-4, NO Intl/America/Havana ---
ok(quiet.OFFSET_MIN === -240, `offset por defecto es -240 (es ${quiet.OFFSET_MIN})`);
ok(quiet.tzLabel() === 'UTC-4', `tzLabel() === 'UTC-4' (es ${quiet.tzLabel()})`);

// 2026-11-20T11:40:00Z debe ser 07:40 en Cuba. Con la tzdata (UTC-5) daria 06:40.
const pNov = quiet.parts(Date.parse('2026-11-20T11:40:00Z'));
ok(pNov.t === 7 * 60 + 40, `2026-11-20T11:40Z -> 07:40 local (es ${quiet.fmt(pNov.t)})`);
// El mismo instante un ano despues: sin DST, tiene que dar igual.
const pNov2 = quiet.parts(Date.parse('2027-11-20T11:40:00Z'));
ok(pNov2.t === 7 * 60 + 40, `2027-11-20T11:40Z -> 07:40 local (es ${quiet.fmt(pNov2.t)})`);
// Julio sigue siendo UTC-4.
const pJul = quiet.parts(Date.parse('2026-07-15T16:00:00Z'));
ok(pJul.t === 12 * 60, `2026-07-15T16:00Z -> 12:00 local (es ${quiet.fmt(pJul.t)})`);
// Enero tambien: si alguien reintroduce DST, esto explota.
const pJan = quiet.parts(Date.parse('2026-01-15T16:00:00Z'));
ok(pJan.t === 12 * 60, `2026-01-15T16:00Z -> 12:00 local (es ${quiet.fmt(pJan.t)})`);

// --- roundtrip local -> epoch -> local ---
for (const [y, mo, d, H, M] of [
  [2026, 11, 20, 23, 45],
  [2026, 11, 21, 0, 15],
  [2026, 11, 21, 5, 30],
  [2026, 3, 1, 12, 0],
  [2026, 12, 31, 23, 59],
]) {
  const ms = quiet.localToEpoch(y, mo, d, H, M);
  const p = quiet.parts(ms);
  ok(
    p.y === y && p.m === mo && p.d === d && p.H === H && p.M === M,
    `roundtrip ${y}-${mo}-${d} ${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`,
  );
}

// --- sorteo de la ventana: rangos exactos ---
const NIGHTS = [];
for (let i = 0; i < 120; i += 1) {
  const t = new Date(Date.UTC(2026, 10, 1) + i * 86400000);
  NIGHTS.push(quiet.keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()));
}

let rangeOk = true;
let durationOk = true;
let orderOk = true;
let enteredAfter2330 = true;
let wokeBefore0630 = true;
const enterSeen = new Set();
const wakeSeen = new Set();

for (const key of NIGHTS) {
  const w = quiet.windowFor(key);
  enterSeen.add(w.enterMin);
  wakeSeen.add(w.wakeMin);
  // 23:30 .. 00:29 -> 1410..1469, normalizado a %1440 queda 1410..1439 y 0..29
  if (!(w.enterMin >= 1410 || w.enterMin <= 29)) { rangeOk = false; }
  if (!(w.wakeMin >= 330 && w.wakeMin <= 389)) { rangeOk = false; }
  if (!(w.durationMin > 0)) durationOk = false;
  if (!(w.startMs < w.wakeMs)) orderOk = false;

  const e = quiet.parts(w.startMs);
  const k = quiet.parts(w.wakeMs);
  // Se acuesta entre 23:30 y 00:29 (hora local del dia que corresponde).
  if (!(e.t >= 1410 || e.t <= 29)) enteredAfter2330 = false;
  // Despierta entre 05:30 y 06:29.
  if (!(k.t >= 330 && k.t <= 389)) wokeBefore0630 = false;
}

ok(rangeOk, 'las 120 noches caen en los rangos pedidos (acuesta 23:30-00:29, despierta 05:30-06:29)');
ok(durationOk, 'todas las ventanas tienen duracion positiva');
ok(orderOk, 'startMs < wakeMs en todas');
ok(enteredAfter2330, 'la hora de acostarse respeta 23:30-00:29 en hora local');
ok(wokeBefore0630, 'la hora de despertar respeta 05:30-06:29 en hora local');

// El sorteo tiene que VARIAR: si todas las noches dieran lo mismo seria un
// horario fijo disfrazado.
ok(enterSeen.size > 1, `la hora de acostarse varia entre noches (${enterSeen.size} valores distintos)`);
ok(wakeSeen.size > 1, `la hora de despertar varia entre noches (${wakeSeen.size} valores distintos)`);

// --- regresion: el sorteo NO puede ser una recta ---
// Con FNV-1a sin finalizador (16777619 = -1 mod 60) las fechas consecutivas
// daban 00:07, 00:08, 00:09... un horario que se corre un minuto por noche.
// Un patron asi es MAS delator que un horario fijo. Se exige que la diferencia
// entre noches consecutivas no sea casi siempre la misma.
function notMonotonic(vals, label) {
  const deltas = [];
  for (let i = 1; i < vals.length; i += 1) {
    // Normaliza el salto de medianoche (1410 -> 0 no es -1410, es +30).
    let d = vals[i] - vals[i - 1];
    if (d > 720) d -= 1440;
    if (d < -720) d += 1440;
    deltas.push(d);
  }
  const counts = new Map();
  for (const d of deltas) counts.set(d, (counts.get(d) || 0) + 1);
  const top = Math.max(...counts.values());
  const ratio = top / deltas.length;
  // Ninguna diferencia concreta puede dominar mas del 25% de las noches.
  ok(ratio <= 0.25, `${label}: sin progresion dominante (la diferencia mas comun es ${(ratio * 100).toFixed(0)}% de las noches)`);
}

const enterVals = NIGHTS.map((k) => quiet.windowFor(k).enterMin);
const wakeVals = NIGHTS.map((k) => quiet.windowFor(k).wakeMin);
notMonotonic(enterVals, 'acostarse');
notMonotonic(wakeVals, 'despertar');

// El delta +1 noche a noche es el sintoma exacto del bug viejo.
let consecutivePlusOne = 0;
for (let i = 1; i < enterVals.length; i += 1) {
  if (enterVals[i] - enterVals[i - 1] === 1) consecutivePlusOne += 1;
}
ok(consecutivePlusOne < 5, `sin la progresion +1 del bug viejo (${consecutivePlusOne} de ${enterVals.length - 1} noches)`);

// Reparto razonable: con 120 noches y 60 valores posibles, casi todos deberian
// aparecer al menos una vez.
ok(enterSeen.size >= 40, `el sorteo de acostarse cubre el rango (${enterSeen.size}/60 valores en 120 noches)`);
ok(wakeSeen.size >= 40, `el sorteo de despertar cubre el rango (${wakeSeen.size}/60 valores en 120 noches)`);

// --- determinismo: misma fecha, misma ventana, siempre ---
let deterministic = true;
for (const key of NIGHTS.slice(0, 30)) {
  const a = quiet.windowFor(key);
  const b = quiet.windowFor(key);
  if (a.startMs !== b.startMs || a.wakeMs !== b.wakeMs) deterministic = false;
}
ok(deterministic, 'windowFor() es determinista para la misma fecha');

// --- cobertura: sin huecos entre noches consecutivas ---
let noGap = true;
let noOverlap = true;
for (let i = 1; i < NIGHTS.length; i += 1) {
  const prev = quiet.windowFor(NIGHTS[i - 1]);
  const cur = quiet.windowFor(NIGHTS[i]);
  if (!(prev.wakeMs <= cur.startMs)) noOverlap = false;
  // Tampoco queremos un agujero enorme: despierta y vuelve a acostarse el mismo dia.
  if (!(cur.startMs - prev.wakeMs < 24 * 3600000)) noGap = false;
}
ok(noOverlap, 'las ventanas de noches consecutivas no se solapan');
ok(noGap, 'no hay huecos de mas de 24 h entre ventanas consecutivas');

// --- inAnyQuiet: bordes exactos ---
const wTest = quiet.windowFor('2026-11-21');
ok(quiet.inAnyQuiet(wTest.startMs), 'inAnyQuiet(startMs) === true (borde de entrada incluido)');
ok(quiet.inAnyQuiet(wTest.wakeMs - 1), 'inAnyQuiet(wakeMs - 1) === true');
ok(!quiet.inAnyQuiet(wTest.wakeMs), 'inAnyQuiet(wakeMs) === false (borde de salida excluido)');
ok(!quiet.inAnyQuiet(wTest.startMs - 1), 'inAnyQuiet(startMs - 1) === false');

// --- state / currentWindow / firstQuietEnd ---
const sIn = quiet.state(wTest.startMs + 60000);
ok(sIn.quiet === true, 'state() dentro de la ventana: quiet === true');
ok(sIn.until === wTest.wakeMs, 'state().until === wakeMs de la ventana vigente');
ok(quiet.state(wTest.wakeMs).quiet === false, 'state() en el borde de salida: quiet === false');
ok(quiet.firstQuietEnd(wTest.startMs + 1) === wTest.wakeMs, 'firstQuietEnd() dentro: devuelve wakeMs');
ok(quiet.firstQuietEnd(wTest.wakeMs + 1) === wTest.wakeMs + 1, 'firstQuietEnd() fuera: devuelve el mismo instante');

// --- estabilidad ---
const now = Date.now();
const s1 = quiet.state();
const s2 = quiet.state();
ok(s1.quiet === s2.quiet, 'state() es estable en dos llamadas');
ok(typeof s1.quiet === 'boolean', 'state().quiet es boolean');
ok(typeof s1.until === 'number' || s1.until === null, 'state().until es numero o null');

// --- intervals(): puede cruzar medianoche, s > e es legal ---
const ivs = quiet.intervals();
ok(Array.isArray(ivs), 'intervals() devuelve array');
ok(ivs.length === 1, `intervals() devuelve una ventana (${ivs.length})`);
if (ivs.length === 1) {
  const iv = ivs[0];
  const crosses = iv.s > iv.e;
  ok(
    crosses || iv.s < iv.e,
    `interval [${quiet.fmt(iv.s)}, ${quiet.fmt(iv.e)}) es coherente (${crosses ? 'cruza medianoche' : 'mismo dia'})`,
  );
  ok(typeof iv.key === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iv.key), `interval.key es fecha valida (${iv.key})`);
}

// --- el instante actual, reportado para diagnostico ---
const pNow = quiet.parts(now);
const sNow = quiet.state(now);
const minsTo = sNow.until === null ? null : Math.round((sNow.until - now) / 60000);
console.log(
  `  [info] ahora: ${quiet.fmt(pNow.t)} ${quiet.tzLabel()} (${quiet.keyOf(pNow.y, pNow.m, pNow.d)})` +
  `  quiet=${sNow.quiet}` +
  (minsTo !== null ? `  ${sNow.quiet ? 'despierta en' : 'se acuesta en'} ${minsTo} min` : ''),
);

const failed = asserts.filter((a) => !a.ok);
for (const a of asserts) console.log((a.ok ? '  ok   ' : '  FAIL ') + a.msg);
console.log(
  failed.length
    ? `\n  SELFTEST FALLO: ${failed.length}/${asserts.length}`
    : `\n  SELFTEST OK: ${asserts.length}/${asserts.length}`,
);
process.exit(failed.length ? 1 : 0);
