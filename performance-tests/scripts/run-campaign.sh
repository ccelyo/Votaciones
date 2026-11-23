#!/usr/bin/env bash
# Nodo B: campaña de niveles, cada uno en un proceso k6 independiente.
# Uso:
#   bash performance-tests/scripts/run-campaign.sh                       # 1,50,200,500,2000 (1 rep)
#   bash performance-tests/scripts/run-campaign.sh --levels 200 --reps 3 # repeticiones del knee
# Opciones: --levels a,b,c  --reps N  --cooldown S (60)  --campaign ID  --no-warmup
# RESET_CMD (opcional): comando que se ejecuta antes de cada nivel, p. ej. un
# `ssh nodoA docker compose ... restart gateway identity`. Apagado por defecto.
set -euo pipefail

cd "$(dirname "$0")/../.."
LEVELS="1,50,200,500,2000"
REPS=1
COOLDOWN=60
CAMPAIGN="$(date +%Y%m%dT%H%M%S)"
WARMUP=1

while [ $# -gt 0 ]; do
  case "$1" in
    --levels) LEVELS="$2"; shift 2 ;;
    --reps) REPS="$2"; shift 2 ;;
    --cooldown) COOLDOWN="$2"; shift 2 ;;
    --campaign) CAMPAIGN="$2"; shift 2 ;;
    --no-warmup) WARMUP=0; shift ;;
    *) echo "Opción desconocida: $1" >&2; exit 2 ;;
  esac
done

export CAMPAIGN
RUN="bash performance-tests/scripts/run-level.sh"

if [ "$WARMUP" = 1 ]; then
  MODE=warmup $RUN
  echo "Calentamiento listo; pausa de ${COOLDOWN}s."
  sleep "$COOLDOWN"
fi

IFS=',' read -r -a LIST <<< "$LEVELS"
TOTAL=$(( ${#LIST[@]} * REPS )); N=0
for rep in $(seq 1 "$REPS"); do
  for level in "${LIST[@]}"; do
    N=$((N + 1))
    [ -n "${RESET_CMD:-}" ] && { echo "RESET_CMD..."; bash -c "$RESET_CMD"; sleep 20; }
    $RUN "$level" "$rep" "$CAMPAIGN"
    if [ "$N" -lt "$TOTAL" ]; then echo "Enfriamiento ${COOLDOWN}s..."; sleep "$COOLDOWN"; fi
  done
done

echo "Campaña ${CAMPAIGN} terminada. Siguiente: python performance-tests/analysis/analyze.py"
