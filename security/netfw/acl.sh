#!/bin/sh
# ACL de entrada de un servicio (escenario de seguridad 3: Network Segmentation).
#
# Docker separa por red, no por puerto: dos contenedores que comparten red se
# alcanzan en todos los puertos. Este script añade el filtro por puerto y por
# origen en el espacio de red del servicio protegido:
#
#   - Denegación por defecto de toda conexión NUEVA entrante.
#   - Solo se aceptan las conexiones de FW_ALLOW: "proto:puerto:origen[:destino] ...",
#     p. ej. "tcp:8080:10.89.31.0/24 tcp:9091:10.89.40.0/24". El destino sirve
#     para los puertos publicados: el cliente puede venir de cualquier IP, pero
#     solo se acepta si entra por la dirección del servicio en la red publicada.
#   - Loopback (healthchecks, DNS interno de Docker) y respuestas a conexiones
#     ya establecidas siguen pasando. La salida no se filtra.
#   - Cada intento denegado se registra (NFLOG + tcpdump): docker compose logs <servicio>-fw.
#
# Variables: FW_NAME (etiqueta del log) y FW_ALLOW (vacía = no acepta conexiones entrantes).
set -eu

FW_NAME="${FW_NAME:-service}"
FW_ALLOW="${FW_ALLOW:-}"

# Solo la tabla filter. La tabla nat contiene las reglas del DNS interno de Docker.
iptables -P INPUT ACCEPT
iptables -F INPUT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -m conntrack --ctstate INVALID -j DROP

for rule in $FW_ALLOW; do
  IFS=: read -r proto port src dst <<EOF
$rule
EOF
  iptables -A INPUT -p "$proto" -s "$src" -d "${dst:-0.0.0.0/0}" --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
  echo "permitido: $proto/$port desde $src${dst:+ hacia $dst}"
done

# Todo lo demás: registrar (con límite, para no inundar el log en un escaneo) y descartar.
iptables -A INPUT -m limit --limit 30/min --limit-burst 60 \
  -j NFLOG --nflog-group 1 --nflog-prefix "SEG-DENY $FW_NAME"
iptables -A INPUT -j DROP
iptables -P INPUT DROP

# Las redes del proyecto no usan IPv6; se cierra igual por si el motor lo activa.
ip6tables -P INPUT ACCEPT 2>/dev/null && ip6tables -F INPUT 2>/dev/null \
  && ip6tables -A INPUT -i lo -j ACCEPT 2>/dev/null \
  && ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
  && ip6tables -P INPUT DROP 2>/dev/null || true

echo "ACL de $FW_NAME aplicada (denegación por defecto). Intentos denegados:"
tcpdump -n -l -tttt -i nflog:1 &
TCPDUMP=$!
trap 'kill "$TCPDUMP" 2>/dev/null; exit 0' TERM INT

# Si el servicio se reinicia, Docker le crea un espacio de red nuevo y este
# sidecar se queda en el viejo (solo con loopback): la ACL dejaría de aplicarse.
# Al detectarlo se sale con error; `restart: unless-stopped` vuelve a arrancar el
# sidecar, que se une al espacio de red actual y reaplica las reglas.
while kill -0 "$TCPDUMP" 2>/dev/null; do
  sleep 2
  if ! grep -qE '^ *eth[0-9]+:' /proc/net/dev; then
    echo "El espacio de red de $FW_NAME cambió (servicio reiniciado): se reaplica la ACL"; exit 1
  fi
  if ! iptables -S INPUT 2>/dev/null | grep -q -- '-P INPUT DROP'; then
    echo "La ACL de $FW_NAME fue modificada: se reaplica"; exit 1
  fi
done
exit 1
