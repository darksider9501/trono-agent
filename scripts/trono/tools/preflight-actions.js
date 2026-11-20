#!/usr/bin/env node
/**
 * Preflight del despliegue en GitHub Actions.
 *
 * Verifica las condiciones que, si fallan, lo hacen EN SILENCIO: un workflow
 * ignorado por git, un cache con la cookie de sesion, un lock que bloquea el
 * job siguiente, un presupuesto de tiempo mayor que el timeout del job.
 *
 * Uso:
 *   node scripts/trono/tools/preflight-actions.js
 *   node scripts/trono/tools/preflight-actions.js --json
 *
 * Solo lectura: no escribe, no hace requests al juego, no toca el lock.
 * Sale con 1 si hay algun bloqueante.
 *
 * El parseo del YAML se delega a Python/pyyaml. Escribir un parser YAML a mano
 * para no agregar dependencias seria peor: un parser a medias sobre un archivo
 * que decide si se publica una credencial es exactamente el tipo de fragilidad
 * que este script existe para detectar.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const JSON_MODE = process.argv.includes('--json');

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Solo se usa para descubrir la raiz del repo, antes de que ROOT exista.
 * Todo lo demas usa g(), que corre desde ROOT.
 */
function git(args, cwd) {
  try {
    const out = execFileSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, out: out.trim() };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === 'number' ? e.status : -1,
      out: String(e.stderr || e.stdout || e.message || '').trim(),
    };
  }
}

let ROOT;
{
  const r = git(['rev-parse', '--show-toplevel']);
  if (!r.ok) {
    console.error('No es un repositorio git: ' + process.cwd());
    process.exit(1);
  }
  ROOT = r.out;
}

const WF = '.github/workflows/trono-agent.yml';
const TRONO_REL = 'scripts/trono';
const results = [];

/**
 * Todos los comandos git corren desde la raiz del repo.
 *
 * Sin `cwd: ROOT`, un script lanzado desde scripts/trono interpreta cada
 * pathspec relativo a ese subdirectorio y responde "ignorado" o "no existe"
 * sobre rutas que nunca miro. Fue el bug real de la primera version.
 */
function g(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, out: out.trim() };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === 'number' ? e.status : -1,
      out: String(e.stderr || e.stdout || e.message || '').trim(),
    };
  }
}

/**
 * Parte el workflow en steps.
 *
 * Los checks anteriores buscaban patrones en el archivo entero, y por eso eran
 * ciegos: habia dos `rm -f logs/driver.lock` (uno antes de correr, otro antes
 * de cachear), asi que borrar uno dejaba al otro matcheando. Un check tiene que
 * saber EN QUE STEP esta el patron, no solo que el patron existe.
 */
function steps() {
  const txt = fs.readFileSync(path.join(ROOT, WF), 'utf8');
  // Cada step empieza con "- " en la indentacion de la lista (6 espacios).
  const parts = txt.split(/\n(?=\s{6}-\s)/);
  return parts.map((body) => {
    const nameM = body.match(/-\s+name:\s*(.+)/);
    const usesM = body.match(/uses:\s*([\w./@-]+)/);
    return {
      name: (nameM ? nameM[1] : usesM ? usesM[1] : '').trim().replace(/^['"]|['"]$/g, ''),
      body,
    };
  });
}

/** Indice del step cuyo nombre matchea, o -1. */
function stepIndex(re) {
  return steps().findIndex((s) => re.test(s.name));
}

function stepBody(re) {
  const s = steps().find((x) => re.test(x.name));
  return s ? s.body : null;
}

/**
 * true cuando el artifact sube el directorio logs/ completo.
 *
 * Se mira el `path:` del step, no el archivo entero: `logs/` como linea suelta
 * sube todo el directorio; `logs/runner.log` sube un archivo.
 */
function uploadsWholeLogsDir() {
  const body = stepBody(/upload/i);
  if (!body) return false;
  const pathBlock = body.split(/path:\s*\|/)[1];
  if (!pathBlock) return false;
  const lines = pathBlock
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^[a-z-]+:\s/.test(l));
  return lines.some((l) => /(^|\/)logs\/?$/.test(l));
}

/**
 * true cuando git realmente ignora la ruta.
 *
 * `git check-ignore -q` sale 0 si la ruta esta ignorada, 1 si NO lo esta
 * (incluido el caso de una negacion `!`), y 128 en error. Hay que correrlo
 * desde la raiz: un pathspec relativo al cwd miente.
 */
function isIgnored(rel) {
  const r = g(['check-ignore', '-q', '--', rel]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`git check-ignore fallo (exit ${r.code}): ${r.out}`);
}

function isTracked(rel) {
  const r = g(['ls-files', '--', rel]);
  return r.ok && r.out.length > 0;
}


/**
 * @param {string} section
 * @param {string} name
 * @param {boolean} blocking  true = impide disparar el job
 * @param {() => {pass:boolean, detail?:string, fix?:string}|boolean} fn
 */
function check(section, name, blocking, fn) {
  let r;
  try {
    r = fn();
  } catch (e) {
    r = { pass: false, detail: 'excepcion: ' + e.message };
  }
  if (r === true) r = { pass: true };
  if (r && typeof r.pass === 'undefined') r = { pass: !!r };
  results.push({
    section,
    name,
    blocking,
    pass: r.pass,
    detail: r.detail || '',
    fix: r.fix || '',
  });
}

function py(script, arg) {
  const r = execFileSync('python', ['-c', script, arg], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(r);
}

// ---------------------------------------------------------------------------
// 1. El workflow existe y git lo ve
// ---------------------------------------------------------------------------
let wf = null;

check('workflow', 'el archivo del workflow existe', true, () => {
  const p = path.join(ROOT, WF);
  return { pass: fs.existsSync(p), detail: p, fix: 'crear el workflow' };
});

check('workflow', 'git NO lo ignora (whitelist de .gitignore)', true, () => {
  const ign = isIgnored(WF);
  return {
    pass: !ign,
    detail: ign ? 'IGNORADO por .gitignore' : 'visible para git',
    fix: 'agregar !/.github/workflows/** al .gitignore',
  };
});

check('workflow', 'esta commiteado (no solo en disco)', true, () => {
  if (!isTracked(WF)) {
    return { pass: false, detail: 'no esta en HEAD', fix: 'git add .github && git commit' };
  }
  const dirty = g(['status', '--porcelain', '--', WF]);
  return {
    pass: !dirty.out,
    detail: dirty.out ? 'commiteado pero con cambios sin guardar' : 'en HEAD y limpio',
    fix: 'commitear los cambios pendientes',
  };
});

// ---------------------------------------------------------------------------
// 2. El YAML parsea y sus numeros son coherentes
// ---------------------------------------------------------------------------
check('workflow', 'el YAML parsea', true, () => {
  wf = py(
    [
      'import sys, json, yaml',
      'd = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))',
      'print(json.dumps(d, default=str))',
    ].join('\n'),
    WF,
  );
  return { pass: true, detail: 'parsea sin error' };
});

if (wf) {
  const job = (wf.jobs && wf.jobs.run) || {};
  const env = job.env || {};

  check('tiempos', 'TRONO_MAX_MINUTES < timeout-minutes (margen para salir limpio)', true, () => {
    const max = parseInt(env.TRONO_MAX_MINUTES, 10);
    const timeout = parseInt(job['timeout-minutes'], 10);
    if (!Number.isFinite(max) || !Number.isFinite(timeout)) {
      return { pass: false, detail: `max=${env.TRONO_MAX_MINUTES} timeout=${job['timeout-minutes']}` };
    }
    const margin = timeout - max;
    return {
      pass: margin >= 10,
      detail: `max ${max} min, timeout ${timeout} min, margen ${margin} min`,
      fix: 'dejar >= 10 min de margen: GitHub corta con SIGKILL a mitad de tick',
    };
  });

  check('tiempos', 'timeout-minutes <= 360 (limite duro de un job)', true, () => {
    const t = parseInt(job['timeout-minutes'], 10);
    return { pass: t <= 360, detail: `${t} min`, fix: 'bajar a <= 355' };
  });

  check('tiempos', 'TRONO_LOOP < TRONO_MAX_MINUTES', true, () => {
    const loop = parseInt(env.TRONO_LOOP, 10);
    const max = parseInt(env.TRONO_MAX_MINUTES, 10);
    return { pass: loop > 0 && loop < max * 60, detail: `loop ${loop}s vs ${max} min de vida` };
  });

  check('dormancia', 'TRONO_TZ_OFFSET_MIN = -240 (Cuba, UTC-4 fijo)', true, () => {
    const v = String(env.TRONO_TZ_OFFSET_MIN);
    return {
      pass: v === '-240',
      detail: v,
      fix: 'Cuba mantiene horario de verano permanente: UTC-4',
    };
  });

  check('dormancia', 'TRONO_QUIET no esta en 0', true, () => {
    const v = String(env.TRONO_QUIET);
    return { pass: v !== '0', detail: `TRONO_QUIET=${v}` };
  });

  check('concurrencia', 'concurrency.cancel-in-progress = false', true, () => {
    const cc = wf.concurrency || {};
    return {
      pass: cc['cancel-in-progress'] === false,
      detail: JSON.stringify(cc),
      fix: 'dos jobs sobre la misma cuenta se rotan el DTTSESS y ambos dan 401',
    };
  });

  check('concurrencia', 'hay grupo de concurrencia', true, () => {
    return { pass: !!wf.concurrency && !!wf.concurrency.group, detail: (wf.concurrency || {}).group || 'falta' };
  });
}

// ---------------------------------------------------------------------------
// 3. Credenciales: que no se filtren
// ---------------------------------------------------------------------------
check('secretos', 'no hay usuario/contrasena hardcodeados en el arbol versionado', true, () => {
  const r = g(['grep', '-n', '-I', '-E', 'darksider[0-9]*\\s*[:=]\\s*["\\x27]|password\\s*[:=]\\s*["\\x27][^"\\x27]{4,}', '--', '.']);
  // 1 = sin coincidencias, que es lo que queremos.
  if (r.code === 1) return { pass: true, detail: 'sin credenciales' };
  if (!r.ok) return { pass: true, detail: 'sin coincidencias' };
  return {
    pass: false,
    detail: r.out.split('\n').slice(0, 5).join(' | '),
    fix: 'las credenciales van en Settings > Secrets, nunca en el repo',
  };
});

check('secretos', 'el workflow referencia los secrets de Actions', true, () => {
  const txt = fs.readFileSync(path.join(ROOT, WF), 'utf8');
  const hasUser = /\$\{\{\s*secrets\.TRONO_USER\s*\}\}/.test(txt);
  const hasPass = /\$\{\{\s*secrets\.TRONO_PASS\s*\}\}/.test(txt);
  return {
    pass: hasUser && hasPass,
    detail: `TRONO_USER=${hasUser} TRONO_PASS=${hasPass}`,
    fix: 'usar ${{ secrets.TRONO_USER }} y ${{ secrets.TRONO_PASS }}',
  };
});

check('secretos', 'state/session.json esta gitignored', true, () => {
  const rel = 'scripts/trono/state/session.json';
  const ign = isIgnored(rel);
  return {
    pass: ign,
    detail: ign ? 'ignorado' : 'NO ignorado',
    fix: 'agregar scripts/trono/state/ al .gitignore (contiene DTTSESS)',
  };
});

check('secretos', 'session.json NO se cachea (cookie DTTSESS legible por cualquiera)', true, () => {
  const names = steps().map((s) => s.name);
  const runIdx = names.findIndex((n) => /run agent/i.test(n));
  const saveIdx = names.findIndex((n) => /save state/i.test(n));
  if (runIdx < 0 || saveIdx < 0) return { pass: false, detail: 'faltan los steps Run agent / Save state' };

  const between = steps().slice(runIdx + 1, saveIdx);
  const purge = between.find((s) => /rm\s+-f[^\n]*state\/session\.json/.test(s.body));
  if (!purge) {
    return {
      pass: false,
      detail: 'ningun step borra state/session.json antes de cachear',
      fix: 'agregar "rm -f scripts/trono/state/session.json" entre Run agent y Save state',
    };
  }
  return { pass: true, detail: `se borra en "${purge.name}"` };
});

check('secretos', 'el artifact no sube el directorio logs/ completo', false, () => {
  const whole = uploadsWholeLogsDir();
  return {
    pass: !whole,
    detail: whole
      ? 'el path del artifact incluye logs/ entero (market-probe.json: 185 KB de estado del jugador)'
      : 'solo archivos concretos',
    fix: 'subir solo logs/runner.log y state/ticker.json',
  };
});

// ---------------------------------------------------------------------------
// 4. El lock: el fallo mas caro de todos
// ---------------------------------------------------------------------------
check('lock', 'el workflow borra el driver.lock ANTES de arrancar el agente', true, () => {
  const body = stepBody(/run agent/i);
  if (!body) return { pass: false, detail: 'no encuentro el step "Run agent"' };
  // El lock vivo de lib/driverlock.js esta en logs/, no en state/.
  const rmLogs = /rm\s+-f[^\n]*logs\/driver\.lock/.test(body);
  return {
    pass: rmLogs,
    detail: rmLogs ? 'si, en el step "Run agent"' : 'falta el rm dentro del step "Run agent"',
    fix:
      'lib/driverlock.js usa path.join(__dirname,"..","logs"). El lock que viaja en el ' +
      'cache es logs/driver.lock: si el pid colisiona en la maquina nueva el TTL no aplica ' +
      'y el agente sale al instante',
  };
});

check('lock', 'el workflow borra el driver.lock ANTES de guardar el cache', true, () => {
  const names = steps().map((s) => s.name);
  const runIdx = names.findIndex((n) => /run agent/i.test(n));
  const saveIdx = names.findIndex((n) => /save state/i.test(n));
  if (runIdx < 0 || saveIdx < 0) {
    return { pass: false, detail: `steps: run=${runIdx} save=${saveIdx}` };
  }
  if (saveIdx < runIdx) {
    return { pass: false, detail: 'Save state va antes de Run agent', fix: 'reordenar los steps' };
  }
  // Un step entre ambos tiene que borrar el lock, y con if: always().
  const between = steps().slice(runIdx + 1, saveIdx);
  const purge = between.find((s) => /rm\s+-f[^\n]*logs\/driver\.lock/.test(s.body));
  return {
    pass: !!purge,
    detail: purge ? `en "${purge.name}"` : 'ningun step entre Run agent y Save state borra el lock',
    fix: 'agregar un step "if: always()" que haga rm -f scripts/trono/logs/driver.lock',
  };
});

check('lock', 'no hay un driver.lock huerfano en disco', false, () => {
  const p = path.join(ROOT, TRONO_REL, 'logs', 'driver.lock');
  if (!fs.existsSync(p)) return { pass: true, detail: 'sin lock' };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { pass: false, detail: 'lock ilegible', fix: 'borrarlo a mano' };
  }
  const beat = Number(raw.beat || Date.parse(raw.at) || 0);
  const ageMin = beat ? Math.round((Date.now() - beat) / 60000) : -1;
  return {
    pass: false,
    detail: `holder pid ${raw.pid} (${raw.name}), beat hace ${ageMin} min`,
    fix: 'rm scripts/trono/logs/driver.lock (el runner lo recrea)',
  };
});

// ---------------------------------------------------------------------------
// 5. Estado del repo: que se publicaria
// ---------------------------------------------------------------------------
check('repo', 'hay un remote configurado', false, () => {
  const r = g(['remote']);
  return {
    pass: !!r.out,
    detail: r.out ? r.out.replace(/\n/g, ', ') : 'sin remote',
    fix: 'git remote add origin git@github.com:USUARIO/REPO.git',
  };
});

check('repo', 'no se versiona nada de state/ ni logs/', true, () => {
  const r = g(['ls-files', '--', 'scripts/trono/state', 'scripts/trono/logs']);
  return {
    pass: !r.out,
    detail: r.out ? 'ARCHIVOS VERSIONADOS: ' + r.out.split('\n').slice(0, 5).join(', ') : 'nada versionado',
    fix: 'git rm --cached los archivos de state/ y logs/',
  };
});

check('repo', 'el tamano del repo es razonable para publicar', false, () => {
  const r = g(['count-objects', '-v']);
  const kib = r.out.match(/size-pack:\s*([\d.]+)\s*KiB/);
  const mib = r.out.match(/size-pack:\s*([\d.]+)\s*MiB/);
  if (kib) return { pass: parseFloat(kib[1]) < 51200, detail: `${kib[1]} KiB` };
  if (mib) return { pass: parseFloat(mib[1]) < 50, detail: `${mib[1]} MiB` };
  return { pass: true, detail: 'sin objetos empaquetados' };
});

/**
 * Lo que se publica es todo el arbol versionado, no solo scripts/trono.
 * Un repo "compartido" como este puede arrastrar proyectos ajenos sin que
 * nadie lo note hasta que la URL es publica.
 *
 * Los archivos que empiezan con "_" son sondas y scripts de un solo uso. No
 * son secretos, pero tampoco son algo que quieras explicar en un repo publico.
 */
check('repo', 'nada de otros proyectos en el arbol versionado', true, () => {
  const r = g(['ls-files']);
  const files = r.out ? r.out.split('\n') : [];
  const stray = files.filter((f) => !/^(\.gitignore|\.github\/|scripts\/|docs\/)/.test(f));
  return {
    pass: stray.length === 0,
    detail: stray.length ? 'FUERA DE LUGAR: ' + stray.slice(0, 5).join(', ') : `${files.length} archivos, todos bajo scripts/ y docs/`,
    fix: 'revisar la whitelist del .gitignore',
  };
});

check('repo', 'las sondas de un solo uso (_probe, _check_*) quedan fuera', false, () => {
  const r = g(['ls-files', '--', 'scripts/trono']);
  const probes = (r.out ? r.out.split('\n') : []).filter((f) => /\/_[^/]+\.js$/.test(f));
  return {
    pass: probes.length === 0,
    detail: probes.length ? `${probes.length}: ${probes.map((p) => path.basename(p)).join(', ')}` : 'ninguna versionada',
    fix: 'son utiles en local pero no aportan al repo publico (opcional quitarlas)',
  };
});

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------
if (JSON_MODE) {
  console.log(JSON.stringify({ root: ROOT, results }, null, 2));
} else {
  let section = null;
  for (const r of results) {
    if (r.section !== section) {
      section = r.section;
      console.log('');
      console.log(C.b(r.section.toUpperCase()));
    }
    const mark = r.pass ? C.ok('  ok  ') : r.blocking ? C.bad(' BLOQ ') : C.warn(' warn ');
    console.log(`${mark} ${r.name}`);
    if (r.detail && (r.detail.length < 90 || !r.pass)) console.log(C.dim(`         ${r.detail}`));
    if (!r.pass && r.fix) console.log(C.dim(`         -> ${r.fix}`));
  }

  const blocking = results.filter((r) => !r.pass && r.blocking);
  const warns = results.filter((r) => !r.pass && !r.blocking);
  console.log('');
  console.log(
    `  ${results.filter((r) => r.pass).length} ok   ` +
      `${C.bad(String(blocking.length))} bloqueantes   ` +
      `${C.warn(String(warns.length))} avisos`,
  );

  if (blocking.length === 0) {
    console.log('');
    console.log(C.ok('  LISTO PARA DISPARAR EL JOB'));
    if (warns.length) console.log(C.dim('  (los avisos no impiden correr, pero conviene leerlos)'));
  } else {
    console.log('');
    console.log(C.bad('  NO DISPARAR TODAVIA'));
    console.log(C.dim('  Un bloqueante aca es un fallo silencioso en GitHub: no da error, solo pierde horas.'));
  }
  console.log('');
}

process.exit(results.some((r) => !r.pass && r.blocking) ? 1 : 0);

