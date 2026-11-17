#!/usr/bin/env bash
# Nodo A: levanta el SUT (frontend + gateway + identity + BD y dependencias).
# Uso: bash performance-tests/deploy/nodeA-up.sh   (desde la raíz del repo)
set -euo pipefail

cd "$(dirname "$0")/../.."
P="${P:-votaciones-perf}"
GATEWAY_PORT="${GATEWAY_PORT:-8088}"
WEB_PORT="${WEB_PORT:-3000}"
export COMPOSE_PARALLEL_LIMIT="${COMPOSE_PARALLEL_LIMIT:-1}"

COMPOSE=(docker compose -f docker-compose.yml -f performance-tests/deploy/docker-compose.perf.yml -p "$P")

"${COMPOSE[@]}" config --quiet
# `platform` arrastra al gateway y a todo lo que este necesita (depends_on).
# No se levantan `mobile` ni `election`: el Gateway no depende de ellos.
"${COMPOSE[@]}" up -d --build platform

echo "Esperando a que el Gateway reporte todos los servicios en ok (hasta 5 min)..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${GATEWAY_PORT}/readyz" >/dev/null 2>&1; then
    echo "Gateway listo:"; curl -s "http://127.0.0.1:${GATEWAY_PORT}/readyz"; echo
    echo "Frontend:"; curl -sI "http://127.0.0.1:${WEB_PORT}" | head -1
    exit 0
  fi
  sleep 5
done
echo "El Gateway no quedó listo. Revisa: ${COMPOSE[*]} ps / logs" >&2
exit 1
