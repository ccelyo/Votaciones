#!/usr/bin/env bash
# Registra las características del equipo para contextualizar los resultados.
# No impone límites ni modifica nada; no vuelca variables de entorno (secretos).
#
# Uso:
#   Nodo A:  bash performance-tests/scripts/collect-env.sh A
#   Nodo B:  A_IP=<IP_del_nodo_A> bash performance-tests/scripts/collect-env.sh B
set -uo pipefail

ROLE="${1:?Uso: collect-env.sh A|B}"
cd "$(dirname "$0")/../.."
OUT="performance-tests/results/env/node${ROLE}-$(hostname)-$(date +%Y%m%dT%H%M%S).txt"

section() { printf '\n== %s ==\n' "$1"; }
try() { "$@" 2>&1 || echo "(no disponible: $1)"; }

{
  echo "Rol: Nodo ${ROLE} ($([ "$ROLE" = A ] && echo 'SUT: despliegue de Votaciones' || echo 'generador de carga k6'))"
  echo "Fecha (UTC): $(date -u +%FT%TZ)"
  echo "Hostname: $(hostname)"

  section "Direcciones IP"
  try hostname -I || true
  command -v ip >/dev/null && ip -brief addr 2>&1

  section "Sistema operativo"
  try uname -a
  [ -r /etc/os-release ] && grep -E '^(PRETTY_NAME|VERSION)=' /etc/os-release
  [ -r /proc/version ] && grep -qi microsoft /proc/version && echo "WSL detectado: el SO anfitrión es Windows"

  section "CPU"
  command -v lscpu >/dev/null && lscpu | grep -E 'Model name|^CPU\(s\)|Thread|Core|Socket|MHz|L3'
  echo "nproc: $(nproc 2>/dev/null)"
  [ -r /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor ] && \
    echo "governor: $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)"

  section "Memoria"
  try free -h

  section "Disco"
  command -v lsblk >/dev/null && lsblk -d -o NAME,SIZE,ROTA,TYPE,MODEL 2>&1
  df -h . 2>&1 | head -3

  section "Límites del proceso"
  echo "ulimit -n (archivos abiertos): $(ulimit -n)"
  [ -r /proc/sys/net/ipv4/ip_local_port_range ] && echo "rango de puertos efímeros: $(cat /proc/sys/net/ipv4/ip_local_port_range)"

  section "Repositorio"
  echo "rama: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  echo "commit: $(git rev-parse HEAD 2>/dev/null)"
  echo "cambios sin commitear: $(git status --porcelain 2>/dev/null | wc -l)"

  if [ "$ROLE" = A ]; then
    section "Docker (SUT)"
    try docker version --format 'cliente {{.Client.Version}} / servidor {{.Server.Version}}'
    try docker info --format 'CPUs asignadas a Docker: {{.NCPU}}
Memoria total para Docker (bytes): {{.MemTotal}}
SO del daemon: {{.OperatingSystem}}
Driver: {{.Driver}}'
    section "Contenedores y imágenes del proyecto"
    try docker ps --filter "name=${P:-votaciones-perf}-" --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
  else
    section "k6 (generador)"
    try k6 version
    section "Red hacia el Nodo A"
    if [ -n "${A_IP:-}" ]; then
      echo "Nodo A: ${A_IP}"
      try ping -c 50 -i 0.2 -q "$A_IP"
      command -v traceroute >/dev/null && try traceroute -n -m 8 "$A_IP"
      command -v ip >/dev/null && echo "ruta local: $(ip route get "$A_IP" 2>/dev/null | head -1)"
    else
      echo "(define A_IP para medir RTT y pérdida)"
    fi
  fi

  section "Notas manuales (completar a mano)"
  echo "- Tipo de equipo (portátil/sobremesa/VM + proveedor y tipo de instancia):"
  echo "- Conexión de red (cable/Wi-Fi, velocidad del enlace):"
  echo "- Plan de energía / conectado a corriente:"
  echo "- Otras cargas en el equipo durante la prueba:"
} | tee "$OUT"

echo
echo "Guardado en $OUT"
