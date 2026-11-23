#!/usr/bin/env bash
# Nodo B: ejecuta UN nivel de carga (un proceso k6) y guarda su resumen.
# Uso: bash performance-tests/scripts/run-level.sh <vus> [repeticion] [campaña]
#   o: MODE=warmup bash performance-tests/scripts/run-level.sh
#
# Variables: BASE_URL, LAB_PASSWORD, LAB_MFA_CODE (obligatorias); RAMP_S, HOLD_S,
# TOKENS_PER_USER, TIMEOUT (opcionales).
set -euo pipefail

cd "$(dirname "$0")/../.."
MODE="${MODE:-level}"
VUS="${1:-}"
REP="${2:-1}"
CAMPAIGN="${3:-${CAMPAIGN:-$(date +%Y%m%dT%H%M%S)}}"

: "${BASE_URL:?Define BASE_URL, p. ej. http://<IP_NODO_A>:8088}"
: "${LAB_PASSWORD:?Define LAB_PASSWORD (ver encabezado de docker-compose.yml)}"
: "${LAB_MFA_CODE:?Define LAB_MFA_CODE (ver encabezado de docker-compose.yml)}"
command -v k6 >/dev/null || { echo "k6 no está instalado en este nodo" >&2; exit 1; }

# El generador debe ser un equipo distinto del SUT.
case "$BASE_URL" in
  *localhost*|*127.0.0.1*|*://[[]::1[]]*)
    echo "BASE_URL apunta a este mismo equipo: el lab exige un nodo independiente." >&2; exit 1 ;;
esac

if [ "$MODE" = warmup ]; then
  NAME="warmup"
  SUMMARY="performance-tests/results/raw/${CAMPAIGN}-warmup.json"   # se descarta
else
  : "${VUS:?Uso: run-level.sh <vus> [repeticion] [campaña]}"
  NAME="vus$(printf '%04d' "$VUS")-rep${REP}"
  SUMMARY="performance-tests/results/summary/runs/${CAMPAIGN}-${NAME}.json"
  export VUS
fi
mkdir -p "$(dirname "$SUMMARY")" performance-tests/results/raw

# Carga del propio generador (para comprobar que no se saturó). Solo Linux.
HOSTLOG="performance-tests/results/raw/${CAMPAIGN}-${NAME}-hostB.txt"
if command -v vmstat >/dev/null; then
  vmstat -n 5 > "$HOSTLOG" &
  VMSTAT_PID=$!
  trap 'kill "$VMSTAT_PID" 2>/dev/null || true' EXIT
fi

echo ">>> ${NAME} (modo ${MODE}) -> ${SUMMARY}"
# k6 expone el entorno del proceso como __ENV; las variables vacías usan el valor por defecto.
export MODE BASE_URL LAB_PASSWORD LAB_MFA_CODE
export SUMMARY_FILE="$SUMMARY"
k6 run --quiet performance-tests/k6/auth_me.js
