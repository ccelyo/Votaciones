#!/usr/bin/env bash
# Ejecuta performance_test.js con carga constante para cada nivel de VUs y guarda
# el resumen de k6 en results/vus_<N>.json (+ salida de consola en .txt).
#   ./run_levels.sh                       # niveles por defecto contra localhost:8088
#   BASE_URL=http://<IP>:8088 ./run_levels.sh 1 50 200 500 2000
set -euo pipefail
cd "$(dirname "$0")"
ulimit -n 65536 2>/dev/null || ulimit -n 10240
LEVELS=("$@"); [ ${#LEVELS[@]} -eq 0 ] && LEVELS=(1 50 100 200 500 1000 1500 2000)
mkdir -p results
for v in "${LEVELS[@]}"; do
  if [ "${RESET:-1}" = "1" ]; then
    # Identity puede quedar bloqueado (pool de BD agotado) tras un nivel saturado:
    # se reinicia para que cada nivel arranque con el sistema sano.
    docker restart votaciones-identity-1 >/dev/null
    until [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE_URL:-http://localhost:8088}/api/elections/open")" = "200" ]; do sleep 2; done
    if [ "${WARMUP:-1}" = "1" ]; then
      # Calentamiento: el proceso recién reiniciado tiene el pool vacío y el
      # código sin "calentar"; 10 s a 5 VUs evitan medir un arranque en frío.
      k6 run -q -e VUS=5 -e DURATION=10s -e BASE_URL="${BASE_URL:-http://localhost:8088}" performance_test.js >/dev/null 2>&1 || true
      sleep 3
    fi
  fi
  echo "=== $v VUs ==="
  k6 run -q -e VUS="$v" -e DURATION="${DURATION:-30s}" -e BASE_URL="${BASE_URL:-http://localhost:8088}" \
    --summary-export "results/vus_${v}.json" performance_test.js 2>&1 | tee "results/vus_${v}.txt" \
    | grep -E "http_req_duration|http_req_failed|http_reqs" || true
  sleep 10   # deja que el sistema se recupere entre niveles
done
