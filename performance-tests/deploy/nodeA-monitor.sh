#!/usr/bin/env bash
# Nodo A: muestrea el consumo de los contenedores y las conexiones a Postgres
# mientras corre la campaña. Detener con Ctrl+C o `kill`.
# Uso: bash performance-tests/deploy/nodeA-monitor.sh [intervalo_s]
#
# Salida (results/raw/sut-<fecha>.csv): ts,container,cpu_pct,mem_usage,mem_pct
# y results/raw/sut-pg-<fecha>.csv: ts,connections,active
set -uo pipefail

cd "$(dirname "$0")/../.."
P="${P:-votaciones-perf}"
INTERVAL="${1:-2}"
STAMP="$(date +%Y%m%dT%H%M%S)"
OUT="performance-tests/results/raw/sut-${STAMP}.csv"
PG="performance-tests/results/raw/sut-pg-${STAMP}.csv"

echo "ts,container,cpu_pct,mem_usage,mem_pct" > "$OUT"
echo "ts,connections,active" > "$PG"
echo "Monitoreando cada ${INTERVAL}s -> $OUT y $PG"

while true; do
  TS="$(date +%s)"
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}}' \
    | grep "^${P}-" | sed "s/^/${TS},/" >> "$OUT"

  docker exec "${P}-postgres-1" psql -U votaciones -d votaciones -tAF, -c \
    "select count(*), count(*) filter (where state='active') from pg_stat_activity where datname='votaciones'" \
    2>/dev/null | sed "s/^/${TS},/" >> "$PG"

  sleep "$INTERVAL"
done
