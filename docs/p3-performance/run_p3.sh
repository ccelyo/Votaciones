#!/usr/bin/env bash
# Campaña del análisis general del P3: cada ruta × cada nivel de VUs (hasta la rodilla y uno después).
#   docker compose -f docker-compose.yml -f docs/lab6-performance/docker-compose.perf.yml up -d gateway   # sin límite de tasa
#   bash docs/p3-performance/run_p3.sh            # niveles por defecto: 1 50 100 150 200
set -euo pipefail
cd "$(dirname "$0")"
ulimit -n 65536 2>/dev/null || ulimit -n 10240
LEVELS=("$@"); [ ${#LEVELS[@]} -eq 0 ] && LEVELS=(1 50 100 150 200)
OUT="${OUT:-results/mac}"; mkdir -p "$OUT"
URL="${BASE_URL:-https://localhost:8088}"
ROUTES="${ROUTES:-open me}"
# Un JWT por votante sembrado, obtenido una sola vez (login + MFA) para toda la campaña.
if [ -z "${TOKENS:-}" ]; then
  TOKENS=$(for i in $(seq 1 10); do
    c=$(curl -sk "$URL/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"votante$i\",\"password\":\"${LAB_PASSWORD:-prueba123}\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["challenge_id"])')
    curl -sk "$URL/api/auth/login/mfa" -H 'Content-Type: application/json' -d "{\"challenge_id\":\"$c\",\"code\":\"${LAB_MFA_CODE:-123456}\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'
  done | paste -sd, -)
fi
export TOKENS
for route in $ROUTES; do
  for v in "${LEVELS[@]}"; do
    # Tras un nivel saturado Identity queda con el pool de BD agotado: se reinicia,
    # se espera a que responda y se calienta 10 s a 5 VUs antes de medir.
    docker restart votaciones-identity-1 >/dev/null
    until [ "$(curl -sk -o /dev/null -w '%{http_code}' "$URL/api/elections/open")" = "200" ]; do sleep 2; done
    k6 run -q -e TOKENS="$TOKENS" -e ROUTE=$route -e VUS=5 -e DURATION=10s p3_load.js >/dev/null 2>&1 || true
    sleep 3
    echo "=== $route · $v VUs ==="
    k6 run -q -e TOKENS="$TOKENS" -e ROUTE=$route -e VUS=$v -e DURATION="${DURATION:-30s}" \
      --summary-export "$OUT/${route}_${v}.json" p3_load.js > "$OUT/${route}_${v}.txt" 2>&1 || true
    grep -E "http_req_duration\{|status_" "$OUT/${route}_${v}.txt" || true
    sleep 5
  done
done
