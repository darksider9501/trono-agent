/**
 * Selftest de lib/quiet.js: formato de las ventanas, estado (entrar, quedarse,
 * salir) y algunos invariantes. Correr con: node tools/quiet-selftest.js
 */
'use strict';

const quiet = require('../lib/quiet');

const asserts = [];
const ok = (cond, msg) => asserts.push({ ok: !!cond, msg });

// --- formato ---
ok(quiet.fmt(0) === '00:00', `fmt(0) === '00:00' (es ${quiet.fmt(0)})`);ok(quiet.fmt(7 * 60) === '07:00', `fmt(420) === '07:00' (es ${quiet.fmt(420)})`);
ok(quiet.fmt(23 * 60 + 59) === '23:59', 'fmt(1439) === \'23:59\'');
ok(quiet.fmt(60) === '01:00', 'fmt(60) === \'01:00\'');
ok(quiet.fmt(139) === '02:19', 'fmt(139) === \'02:19\'');
ok(quiet.fmt(840) === '14:00', 'fmt(840) === \'14:00\'');

// --- ventanas ---
const ivs = quiet.intervals();
ok(Array.isArray(ivs), 'intervals() devuelve array');
ok(ivs.length >= 1, 'al menos una ventana de silencio configurada');
for (const iv of ivs) {
  ok(iv.s < iv.e, `interval [${iv.s}, ${iv.e}) coherente`);
}

// --- estado actual ---
const now = Date.now();
const s = quiet.state();
ok(typeof s.quiet === 'boolean', 'state().quiet es boolean');
ok(typeof s.until === 'number' || s.until === null || s.until === Infinity, 'state().until es numero/null');
if (s.quiet) {
  ok(s.until > now, 'quiet: until está en el futuro');
  const exit1 = quiet.firstQuietEnd(now + 60000);
  ok(exit1 !== null && exit1 > now, 'quiet: firstQuietEnd() no devuelve null y está en el futuro');
  ok(!quiet.state(exit1).quiet, 'quiet: el estado al final del silencio ya no es quiet');
} else {
  ok(s.until === Infinity || s.until > now, 'no quiet: until vacío o futuro');
}
// Estabilidad: dos llamadas seguidas dan lo mismo.
ok(s.quiet === quiet.state().quiet, 'state() es estable en dos llamadas');

// --- ciclo enter/exit ---
const enter = quiet.firstQuietStart(Date.now() - 3 * 24 * 3600000);
if (enter) {
  ok(quiet.state(enter).quiet === true, 'cycle: state(enter).quiet === true');
  const exit1 = quiet.firstQuietEnd(enter + 1);
  ok(exit1 !== null, 'cycle: firstQuietEnd() devuelve instante');
  ok(exit1 > enter, 'cycle: exit > enter');
  ok(!quiet.state(exit1).quiet, 'cycle: state(exit) no es quiet');
  ok(quiet.inAnyQuiet(cubaMinute(enter)), 'cycle: enter está en una ventana real');
}

function cubaMinute(ms) {
  return quiet.parts(ms).t;
}

// --- regresión h12/h23 (el bug: en-US devuelve "03 PM" sin hourCycle) ---
// La Habana es UTC-5 (invierno) o UTC-4 (verano). A las 18:00Z son siempre las
// 13:00 o 14:00 locales: nunca madrugada. Con h12 esto daba 01:00-02:00 y
// abría una falsa ventana de silencio toda la tarde.
for (const iso of ['2026-01-15T18:00:00Z', '2026-07-15T18:00:00Z', '2026-11-19T18:00:00Z']) {
  const t = quiet.parts(Date.parse(iso)).t;
  ok(t >= 12 * 60, `regresión h23: ${iso} cae de tarde en La Habana (t=${quiet.fmt(t)})`);
  ok(!quiet.inAnyQuiet(t), `regresión h23: ${iso} no está en silencio`);
}
// A las 06:00Z son las 01:00 o 02:00 locales: siempre dentro de la ventana.
for (const iso of ['2026-01-15T06:00:00Z', '2026-07-15T06:00:00Z']) {
  const t = quiet.parts(Date.parse(iso)).t;
  ok(t < 7 * 60, `regresión h23: ${iso} cae de madrugada (t=${quiet.fmt(t)})`);
  ok(quiet.inAnyQuiet(t), `regresión h23: ${iso} está en silencio`);
}

const failed = asserts.filter((a) => !a.ok);
for (const a of asserts) console.log((a.ok ? '  ok   ' : '  FAIL ') + a.msg);
console.log(failed.length ? `\n  SELFTEST FALLO: ${failed.length}/${asserts.length}` : `\n  SELFTEST OK: ${asserts.length}/${asserts.length}`);
process.exit(failed.length ? 1 : 0);
