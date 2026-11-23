#!/usr/bin/env bash
# Nodo A: baja el SUT. Con RESET=1 borra además los volúmenes del proyecto
# votaciones-perf (usuarios, sesiones creadas por setup() y claves), lo que
# deja la base como el seed original. Solo afecta al proyecto de pruebas.
set -euo pipefail

cd "$(dirname "$0")/../.."
P="${P:-votaciones-perf}"
COMPOSE=(docker compose -f docker-compose.yml -f performance-tests/deploy/docker-compose.perf.yml -p "$P")

if [ "${RESET:-0}" = "1" ]; then
  "${COMPOSE[@]}" down -v
else
  "${COMPOSE[@]}" down
fi
