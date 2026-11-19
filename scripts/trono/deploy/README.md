# Despliegue en la nube (Oracle Cloud Always Free ARM)

El agente corre en una VM sin navegador y sin X. No hay CDP, no hay pestaña y no
hay huella que copiar: la entrada a la cuenta es el formulario de login por HTTP.

Esta guia asume Ubuntu 22.04/24.04 ARM en Oracle Cloud Always Free (4 OCPU /
24 GB). Cualquier VPS Debian sirve igual; los unicos requisitos son Node >= 18 y
salida HTTPS a `defiendeeltrono.com`.

---

## 0. Antes de empezar: por que esto puede costar la cuenta

Pasar de una IP residencial a una IP de datacenter es visible para el servidor
del juego. No hay forma de medirlo desde aqui ni de disimularlo de forma
defendible. Es una decision del humano, no un detalle de implementacion.

Mitigacion posible, no garantia: correr el agente detras de la misma ventana de
silencio nocturno y con el mismo ritmo de ticks que en local. Un patron de
actividad identico al de siempre es menos sospechoso que uno nuevo.

---

## 1. Crear el usuario y el arbol

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin trono
sudo mkdir -p /opt/trono /etc/trono /var/log/trono
sudo chown -R trono:trono /opt/trono /var/log/trono
sudo chmod 750 /etc/trono
```

## 2. Copiar el codigo

`state/` y `logs/` estan en `.gitignore`, asi que **no viajan con el repo**. Hay
que llevarlos aparte o el agente arranca sin sesion (lo cual ahora funciona,
pero cuesta un login extra en cada arranque).

```bash
# desde la maquina local
rsync -av --exclude node_modules \
  "scripts/trono/" trono@<IP>:/opt/trono/scripts/trono/

# state/ y logs/ van por separado: no estan en git
rsync -av "scripts/trono/state/" trono@<IP>:/opt/trono/scripts/trono/state/
sudo chown -R trono:trono /opt/trono/scripts/trono/state
sudo chmod 700 /opt/trono/scripts/trono/state
```

No hay `package.json` y no hay dependencias npm: el agente usa solo la libreria
estandar de Node. Eso es lo que permite correr en una ARM de 1 GB sin build.

## 3. Credenciales

Van fuera del repo y fuera de `/etc/trono`. La ruta la fija `lib/credentials.js`:

```bash
sudo -u trono mkdir -p /home/trono/.trono
sudo -u trono install -m 600 /dev/null /home/trono/.trono/credentials.json
```

Contenido (`username` / `password` del juego):

```json
{
  "username": "darksider95",
  "password": "..."
}
```

`TRONO_USER` / `TRONO_PASS` en el entorno tambien funcionan y tienen prioridad,
pero entonces las credenciales quedan visibles en `/proc/<pid>/environ` para
cualquier proceso del mismo usuario. El archivo con `600` es preferible.

## 4. Configuracion

```bash
sudo install -o root -g trono -m 640 deploy/trono.env.example /etc/trono/trono.env
sudo -e /etc/trono/trono.env     # poner el token real
```

El token se genera con `openssl rand -hex 24`. **Es el mismo que va en
`~/.trono/cloud.json` del Hub**, y sin el, `/api/control/*` responde 401 — que es
lo correcto, pero deja al Hub sin poder pausar.

## 5. Servicios

```bash
sudo install -m 644 deploy/trono-runner.service  /etc/systemd/system/
sudo install -m 644 deploy/trono-control.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now trono-runner trono-control
```

Los dos son unidades distintas y eso es deliberado: si el runner se cae, el Hub
tiene que seguir pudiendo consultar `/api/health` para distinguir "agente caido"
de "VM apagada". Con una sola unidad, una caida del runner mataba tambien el
canal de diagnostico.

## 6. Verificar

```bash
# el servicio esta vivo
systemctl status trono-runner --no-pager

# arranque en frio: tiene que decir "login headless"
sudo journalctl -u trono-runner -n 30 --no-pager

# el log que lee el Hub
sudo tail -f /var/log/trono/runner.log

# el control server responde
curl -s -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8091/api/health
curl -s -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:8091/api/status
# sin token -> 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8091/api/health
```

## 7. Conectar el Hub

En la maquina de la casa:

```json
// C:\Users\Dioneldis\.trono\cloud.json
{
  "url": "https://<IP-o-dominio-de-la-VM>:8091",
  "token": "<el mismo token>",
  "machine": "oracle",
  "insecure": true
}
```

`insecure: true` acepta el certificado autofirmado. Solo es aceptable porque el
trafico va cifrado igual; lo que se pierde es la validacion de identidad del
servidor, o sea que un MITM activo podria presentarse. Si la VM tiene dominio y
certificado valido (Let's Encrypt), poner `insecure: false` y preferir `:443`
delante de un reverse proxy.

## 8. Firewall

Abrir el 8091 **solo a la IP de la casa**, no a `0.0.0.0/0`:

```bash
sudo ufw allow from <IP-CASA> to any port 8091 proto tcp
sudo ufw enable
```

Y en la consola de Oracle, la Security List de la VCN: TCP 8091 desde
`<IP-CASA>/32`. Por defecto Oracle bloquea todo salvo el 22.

Alternativa mejor que abrir el puerto: un tunel WireGuard o Tailscale, y dejar
`TRONO_CLOUD_HOST=127.0.0.1`. El control server nunca toca internet.

---

## Trampas que ya costaron tiempo

**El silencio nocturno no es un timer de systemd.** Un `OnCalendar` que apague el
servicio dejaria al agente sin poder escribir `state/ticker.json`, y el Hub lo
leeria como caido. La ventana vive dentro del loop: el proceso sigue vivo, el
ticker sigue fresco, y no sale un solo request. La sesion se cae sola y se
reloguea a las 07:00.

**`TRONO_MODE=http` con `state/session.json` ausente.** Hasta hace poco eso
lanzaba una excepcion ("run once in hybrid to create it"), que en una VM recien
creada es un bucle de reinicio infinito. Ahora hace login headless. Verificado:
arranque en frio, `http session headless (darksider95 lv9)` en 8,5 s.

**`TRONO_LOG_FILE` lo respeta el control server desde siempre, y el runner no.**
Si divergen, el runner escribe en `logs/runner.log` y el Hub lee la ruta del
entorno: panel en blanco con el agente trabajando. Ya esta alineado, pero es el
primer sitio donde mirar si el log no aparece.

**`state/` escribe tanto el runner como el control server.** Los dos necesitan
`ReadWritePaths` en su unidad. Si solo uno lo tiene, la pausa desde el Hub falla
con `EROFS` en el journal y el agente sigue peleando.

**El agente no necesita el navegador para operar.** 0 dependencias npm, login por
POST HTTP, CPU real medida en 4,7 s por cada 0,68 h de reloj. Una ARM Always Free
va sobrada.

---

## Apagar y volver a local

```bash
sudo systemctl stop trono-runner trono-control
```

Con la nube apagada, `~/.trono/cloud.json` deja de responder y el Hub vuelve a
tratar el agente como local: `start_agent` lanza el runner de la casa otra vez.
No hay que tocar la configuracion del Hub para alternar; el dueno se decide por
`/api/health`.

Si las dos instancias corren a la vez, se rotan el `DTTSESS` mutuamente y las
dos quedan en 401. Un solo dueno, y el dueno es la nube.
