# Desplegar el agente en GitHub Actions

## Por qué Actions y no una VM

La VM gratuita de Oracle pide tarjeta y aplica OFAC: el registro desde Cuba se
rechaza. Actions no pide tarjeta y es alcanzable. Lo que se paga a cambio:

| | Oracle VM | GitHub Actions |
|---|---|---|
| Tarjeta | Sí | No |
| Alcanzable desde Cuba | No | Sí |
| Proceso eterno | Sí | No (6 h max) |
| IP | Datacenter | Azure datacenter |
| Coste | Gratis | Gratis (repo público) |

El riesgo de baneo por IP de datacenter **no desaparece**: se acepta como parte
del experimento.

## Lo que hay que entender antes de empezar

**El runner es efímero.** Cada job arranca en una máquina limpia. Si `state/` y
`logs/` no se persisten, el agente reloguea en cada job y el patrón de logins se
vuelve una huella peor que la que se intentaba evitar. El workflow los guarda en
un cache de Actions.

**Un job vive 6 h como máximo.** El agente sabe salir solo con
`--max-minutes=330`, unos 25 minutos antes del corte. Sin eso, el SIGKILL de
GitHub llega a mitad de un tick y deja el lock tomado.

**El cron no es un reloj.** El mínimo real es 5 minutos y en horas pico GitHub
retrasa jobs 10-20 minutos. Con 4 jobs diarios de ~5h30, la cobertura es ~22 h
de 24. Los huecos son ruido aceptable.

**La dormancia nocturna la aplica el agente, no el cron.** El job arranca a las
03:00 hora Cuba (07:00 UTC), entra al silencio, duerme sin emitir un request y
despierta entre 05:30 y 06:30. Si el silencio fuera un cron que no lanza el job,
el agente no podría escribir el ticker y parecería caído.

## Pasos

### 1. Crear el repositorio

Tiene que ser **público**: los minutos de Actions son ilimitados solo en repos
públicos. En privado, 2000 min/mes se agotan en ~3 días con este uso.

Antes de subir, confirmar que no viaja ningún secreto:

```bash
git grep -n -E 'darksider|password|token.*[A-Za-z0-9]{16}' -- scripts/trono
```

`state/` y `logs/` están en `.gitignore`, así que `session.json` no viaja.

### 2. Subir el código

```bash
git remote add origin git@github.com:TU_USUARIO/TU_REPO.git
git push -u origin task/trono-4
```

### 3. Secrets

Settings > Secrets and variables > Actions > New repository secret:

| Nombre | Valor |
|---|---|
| `TRONO_USER` | el usuario del juego |
| `TRONO_PASS` | la contraseña del juego |

`lib/credentials.js` los lee de `process.env` **antes** de mirar
`~/.trono/credentials.json`, así que en el runner no hace falta archivo.

**Nunca** escribir esas credenciales en el workflow. El `.env` no existe en el
repo y no debe existir.

### 4. Primer arranque manual

Actions > trono-agent > Run workflow. Mirar el job:

- debe decir `http session headless (…)` o `http session from disk verified`
- el log tiene que mostrar `state {...}` con el nivel y el oro
- antes de terminar: `presupuesto de 330 min agotado — saliendo limpio`

Para una prueba corta, cambiar `TRONO_MAX_MINUTES` a `5` y disparar a mano. No
gastar 6 h en la primera corrida.

### 5. Comprobar la persistencia

Correr dos veces seguidas. En la segunda, el agente debe decir
`http session from disk verified` en vez de `login headless`. Si vuelve a
loguear, el cache no está guardando `state/` y hay que revisar la clave.

## Trampas ya conocidas

**El cache de Actions es inmutable.** Si se usa la misma clave dos veces, la
segunda escritura falla en silencio. Por eso la clave lleva `run_id` y
`run_attempt`, con `restore-keys` para recuperar el más reciente.

**`.gitignore` de este repo es una whitelist y bloquea `.github/`.** Empieza con
`*` e incluye explícitamente solo `scripts/` y `docs/`. Un workflow nuevo queda
ignorado y `git status` no lo muestra: se sube el repo y Actions no encuentra
nada que ejecutar. Ya está corregido con `!/.github/workflows/**`, pero si se
agrega otra carpeta de nivel superior hay que re-incluirla también. Verificar
siempre:

```bash
git check-ignore -v .github/workflows/trono-agent.yml   # exit 1 = visible
```

**El `driver.lock` vive en `logs/`, no en `state/`.** `lib/driverlock.js` resuelve
`path.join(__dirname, '..', 'logs')`. Borrar `state/driver.lock` no hace nada.

**Un lock que viaja en el cache bloquea el job siguiente.** Verificado contra
`lib/driverlock.js`: si el job anterior murió por SIGKILL, su `driver.lock` llega
a un runner que es **otra máquina**. Si el `pid` guardado existe en el nuevo
runner (colisión de PIDs, y los runners frescos usan PIDs bajos), `alive()`
devuelve true; `sameMachine` es false, así que el TTL de 15 min **no aplica**; y
`current()` lo declara vivo incluso con un heartbeat de 35 minutos. El agente
imprime `another driver is active` y sale al instante: se pierden las 6 h.

Por eso el workflow hace `rm -f logs/driver.lock` antes de arrancar y otra vez
antes de guardar el cache. Es seguro porque `concurrency` garantiza que no hay
dos jobs de este repo a la vez.

**`cancel-in-progress: false` es obligatorio.** Dos jobs simultáneos sobre la
misma cuenta se rotan el `DTTSESS` y los dos quedan en 401.

**El silencio debe acotarse al presupuesto.** `sleepWhileQuiet()` acepta
`{ deadline }`: sin eso, si la ventana de dormancia cae dentro de un job,
dormiría más allá del corte de GitHub y moriría de SIGKILL sin liberar el lock.

**No subir `logs/` ni `state/` al repo.** Contienen la cookie de sesión.

**NUNCA cachear `state/session.json`.** Es el riesgo más caro de todo esto y no
tiene nada que ver con que baneen la cuenta. La documentación de Actions lo dice
sin rodeos:

> Anyone who can open a pull request against your repository can read the
> contents of caches in the base branch. Don't write secrets, tokens, or
> credentials to a cached path.

`session.json` guarda la cookie `DTTSESS` **viva**. En un repo público cualquiera
abre un PR, lee el cache, se queda con la sesión y puede retirar el oro a su
propia wallet. Eso no es "perder la cuenta por baneo": es que te la vacíen.

Por eso el workflow borra `state/session.json` antes de guardar el cache. Lo que
se persiste es `learning.json` y `control.json`; la sesión se regenera con un
login headless (9,9 s, verificado). El costo es pasar de ~2,2 a ~4 logins/día.
Barato comparado con publicar una credencial.

**`cache-mode: write` está declarado explícitamente** en el workflow. El default
es `write` para triggers confiables, pero si algún día se agrega un trigger
influenciable por terceros el default baja a `read` y los guardados fallan en
silencio (con warning, sin romper el job). Declararlo deja el contrato visible.

**No subir `logs/` completo como artifact.** `market-probe.json` pesa 185 KB de
estado del jugador y `runner.log` 378 KB. En un repo público un artifact es
descargable por cualquiera con la URL. El workflow sube solo `runner.log` y
`ticker.json`. Verificado: `runner.log` no contiene `DTTSESS`.

## Coste

Repo público: 0. Sin tarjeta, sin verificación de país.

Repo privado: 2000 min/mes gratis. Este agente consume ~330 min por job × 4
jobs/día = 1320 min/día. Se agota en menos de dos días.

## Qué mirar si se banea la cuenta del juego

El experimento lo contempla. Señales en el log: `AUTH: … 401` en cada request,
o el login headless devolviendo un error distinto de credenciales. En ese caso
el agente se detiene solo y el ticker queda en `stopped`.

No hay nada que reintentar: un baneo por IP no se arregla relogeando.
