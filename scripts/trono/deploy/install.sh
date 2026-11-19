#!/usr/bin/env bash
#
# Instalador del agente Trono en una VM Linux.
#
#   sudo ./deploy/install.sh            # instala y arranca
#   sudo ./deploy/install.sh --dry-run  # solo valida, no toca nada
#
# Es idempotente: se puede correr dos veces sin romper nada. No escribe
# secretos: si falta el token o las credenciales, avisa y para.

set -euo pipefail

SERVICE_USER="trono"
APP_ROOT="/opt/trono"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="/etc/trono/trono.env"
LOG_DIR="/var/log/trono"
DRY_RUN=0

[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if (( DRY_RUN )); then printf '    [dry-run] %s\n' "$*"; else "$@"; fi
}

# --- preflight --------------------------------------------------------------

[[ $EUID -eq 0 ]] || die "correr con sudo"
command -v node >/dev/null || die "falta node (apt install nodejs)"
(( DRY_RUN )) || {
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  (( NODE_MAJOR >= 18 )) || die "Node >= 18 requerido, hay $(node -v)"
}

[[ -f "$SRC_DIR/runner.js" ]] || die "no encuentro runner.js en $SRC_DIR"
[[ -f "$SRC_DIR/tools/cloud-control-server.js" ]] || die "falta el control server"

# --- validaciones que fallan mejor ahora que a las 3 de la manana ------------

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$SRC_DIR/deploy/trono.env.example" ]]; then
    warn "$ENV_FILE no existe; lo creo desde el ejemplo — HAY QUE EDITARLO"
    run install -d -m 750 /etc/trono
    run install -o root -g root -m 640 "$SRC_DIR/deploy/trono.env.example" "$ENV_FILE"
  else
    die "falta $ENV_FILE y no hay ejemplo"
  fi
fi

if grep -q 'CAMBIAR_ESTO' "$ENV_FILE" 2>/dev/null; then
  warn "el token de $ENV_FILE sigue siendo el de ejemplo"
fi

CREDS="/home/${SERVICE_USER}/.trono/credentials.json"
if [[ ! -f "$CREDS" ]]; then
  warn "no hay credenciales en $CREDS"
  warn "el agente va a fallar el login headless. Crear con:"
  warn "  sudo -u $SERVICE_USER install -m 600 /dev/null $CREDS   # y editar"
fi

# --- usuario y directorios --------------------------------------------------

if ! id "$SERVICE_USER" &>/dev/null; then
  info "creando usuario $SERVICE_USER"
  run useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

info "preparando $APP_ROOT y $LOG_DIR"
run install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$APP_ROOT"
run install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$LOG_DIR"
run install -d -o root -g root -m 750 /etc/trono

# --- codigo -----------------------------------------------------------------

# state/ y logs/ son gitignored: si se sobrescriben en cada deploy, se pierde la
# sesion y el aprendizaje. Se copian aparte y solo si no existen.
info "copiando codigo a $APP_ROOT/scripts/trono"
run install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 750 "$APP_ROOT/scripts"
if (( DRY_RUN )); then
  printf '    [dry-run] rsync %s/ -> %s/scripts/trono/\n' "$SRC_DIR" "$APP_ROOT"
else
  if command -v rsync >/dev/null; then
    rsync -a --delete \
      --exclude 'state/' --exclude 'logs/' --exclude 'node_modules/' \
      --exclude '*.bak' \
      "$SRC_DIR/" "$APP_ROOT/scripts/trono/"
  else
    cp -a "$SRC_DIR/." "$APP_ROOT/scripts/trono/"
  fi
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_ROOT/scripts/trono"
fi

for d in state logs; do
  if [[ -d "$SRC_DIR/$d" && ! -d "$APP_ROOT/scripts/trono/$d" ]]; then
    info "sembrando $d/ (no viaja en git)"
    run cp -a "$SRC_DIR/$d" "$APP_ROOT/scripts/trono/$d"
    run chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_ROOT/scripts/trono/$d"
  fi
done

# state/ tiene session.json: 700, no 750.
run chmod 700 "$APP_ROOT/scripts/trono/state" 2>/dev/null || true

# --- systemd ----------------------------------------------------------------

info "instalando unidades systemd"
run install -m 644 "$SRC_DIR/deploy/trono-runner.service"  /etc/systemd/system/
run install -m 644 "$SRC_DIR/deploy/trono-control.service" /etc/systemd/system/
run systemctl daemon-reload
run systemctl enable trono-runner trono-control

if (( DRY_RUN )); then
  info "dry-run: no arranco los servicios"
  exit 0
fi

info "arrancando"
systemctl restart trono-control trono-runner
sleep 5

# --- verificacion -----------------------------------------------------------

fail=0
for u in trono-control trono-runner; do
  if systemctl is-active --quiet "$u"; then
    printf '    %-16s activo\n' "$u"
  else
    printf '    %-16s CAIDO\n' "$u"
    fail=1
  fi
done

TOKEN="$(grep -E '^TRONO_CLOUD_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)"
if [[ -n "${TOKEN:-}" && "$TOKEN" != *CAMBIAR_ESTO* ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
          http://127.0.0.1:8091/api/health || echo 000)"
  printf '    /api/health con token: %s\n' "$code"
  [[ "$code" == "200" ]] || fail=1

  code_noauth="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8091/api/health || echo 000)"
  printf '    /api/health sin token: %s (esperado 401)\n' "$code_noauth"
  [[ "$code_noauth" == "401" ]] || warn "esperaba 401 sin token"
fi

echo
if (( fail )); then
  warn "algo no arranco. Mirar:"
  echo "    journalctl -u trono-runner -n 50 --no-pager"
  echo "    journalctl -u trono-control -n 50 --no-pager"
  exit 1
fi

info "listo. Log: $LOG_DIR/runner.log"
echo "    El arranque en frio debe decir 'login headless' en el journal."
