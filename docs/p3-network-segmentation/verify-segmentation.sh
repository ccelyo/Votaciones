#!/usr/bin/env bash
# Verificación de la segmentación de red (escenario de seguridad 3, Prototipo 3).
#
# SOLO LECTURA: conexiones TCP, GET de salud y lectura de logs/contadores. No
# escribe en las bases ni borra nada. Sale con código 1 si alguna comprobación falla.
#
#   docker compose up -d --build
#   bash docs/p3-network-segmentation/verify-segmentation.sh
#
# Los sondeos se ejecutan en contenedores efímeros (imagen espivota/netfw:dev) que
# comparten el espacio de red del contenedor de origen (--network container:...).
# Así se prueba también desde imágenes sin shell (Ballot, Tally y Analytics son
# distroless) y con el certificado mTLS del servicio de origen.
#
# Variables: P (proyecto Compose, por defecto "votaciones"), WEB_PORT,
# GATEWAY_PORT, CERTS_DIR (por defecto .dev-certs).
# Requiere: docker compose, curl y python3.

set -u
P="${P:-votaciones}"
WEB="${WEB_PORT:-3000}"; GW="${GATEWAY_PORT:-8088}"
CERTS="${CERTS_DIR:-.dev-certs}"; CA="$CERTS/ca-public/ca.crt"
IMG="${NETFW_IMAGE:-espivota/netfw:dev}"
PASS=0; FAIL=0
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)

dc()  { docker compose -p "$P" "$@"; }
cid() { dc ps -q "$1" 2>/dev/null | head -1; }
ok()  { PASS=$((PASS+1)); printf '  [OK]    %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  [FALLA] %s\n' "$1"; }

[ -f "$CA" ] || { echo "No se encuentra la CA TLS: $CA (¿se levantó el stack?)" >&2; exit 2; }
docker image inspect "$IMG" >/dev/null 2>&1 || { echo "Falta la imagen $IMG: docker compose build gateway-fw" >&2; exit 2; }
[ -n "$(cid waf)" ] || { echo "El proyecto '$P' no tiene el WAF levantado (P=<proyecto>)" >&2; exit 2; }
CERTS_ABS=$(cd "$CERTS" && pwd)

# probe <origen> <host:puerto ...>  ->  líneas "host:puerto open|blocked|nodns"
#   open    = conecta
#   blocked = el nombre resuelve (comparten red) pero la ACL descarta la conexión
#   nodns   = no comparten red: el nombre no existe para el origen
probe() {
  local src=$1; shift
  docker run --rm --network "container:$(cid "$src")" -e "TARGETS=$*" --entrypoint sh "$IMG" -c '
    for t in $TARGETS; do
      h=${t%:*}; p=${t##*:}
      ( if ! getent hosts "$h" >/dev/null 2>&1 && ! echo "$h" | grep -qE "^[0-9.]+$"; then r=nodns
        elif nc -z -w 3 "$h" "$p" 2>/dev/null; then r=open
        else r=blocked; fi
        echo "$t $r" ) &
    done; wait' 2>/dev/null
}

# expect <A|D> <origen> "<host:puerto ...>" [nota]   (A = debe conectar, D = debe fallar)
expect() {
  local want=$1 src=$2 targets=$3 note=${4:-} t got results
  results=$(probe "$src" $targets | sort)
  # Un sondeo que no corre no debe pasar en silencio.
  [ "$(echo "$results" | grep -c .)" -eq "$(echo $targets | wc -w)" ] \
    || bad "$src: el sondeo no devolvió resultado para todos los destinos ($targets)"
  while read -r t got; do
    [ -n "$t" ] || continue
    case "$want:$got" in
      A:open)  ok "$src -> $t conecta (permitido)";;
      A:*)     bad "$src -> $t debía conectar y NO conecta ($got)";;
      D:nodns) ok "$src -> $t sin red compartida (nombre no resuelve)${note:+ — $note}";;
      D:blocked) ok "$src -> $t descartado por la ACL de entrada${note:+ — $note}";;
      D:*)     bad "$src -> $t debía estar bloqueado y CONECTA${note:+ — $note}";;
    esac
  done <<<"$results"
}

# tls <origen> <cert> <url>: GET con mTLS desde el espacio de red del origen.
tls() {
  docker run --rm --network "container:$(cid "$1")" \
    -v "$CERTS_ABS/$2:/c:ro" -v "$CERTS_ABS/ca-public:/ca:ro" --entrypoint curl "$IMG" \
    -s -o /dev/null -m 8 -w '%{http_code}' --cacert /ca/ca.crt --cert /c/tls.crt --key /c/tls.key "$3" 2>/dev/null
}

# --- 0. ACL de entrada por servicio ------------------------------------------
echo "0. Sidecars de ACL (denegación por defecto) y servicios sin NET_ADMIN"
for svc in waf platform gateway identity election ballot tally analytics notification rabbitmq; do
  rules=$(dc exec -T "$svc-fw" iptables -S INPUT 2>/dev/null)
  if echo "$rules" | grep -q -- '-P INPUT DROP'; then
    ok "$svc-fw: política INPUT DROP, $(echo "$rules" | grep -c -- '--ctstate NEW -j ACCEPT') flujo(s) permitido(s)"
  else bad "$svc-fw no está aplicando la ACL"; fi
  caps=$(docker inspect --format '{{.HostConfig.CapAdd}}' "$(cid "$svc")" 2>/dev/null)
  case "$caps" in *NET_ADMIN*) bad "$svc tiene NET_ADMIN (podría cambiar su ACL)";; *) ok "$svc sin NET_ADMIN";; esac
done

# --- 1. Exposición en el host ------------------------------------------------
echo "1. Puertos publicados en el host (esperado: solo el WAF $WEB/$GW y mobile 8092)"
while read -r svc ports; do
  case "$svc" in
    waf|mobile) [ -n "$ports" ] && ok "$svc publica: $ports" || bad "$svc no publica puertos";;
    *) if echo "$ports" | grep -q -- '->'; then bad "$svc publica puertos: $ports"; else ok "$svc sin puertos en el host"; fi;;
  esac
done < <(docker ps --filter "label=com.docker.compose.project=$P" --format '{{.Label "com.docker.compose.service"}} {{.Ports}}' | sort)

for port in 8000 8001 8080 9091 8090 8100 5672 15672 25672 4369 5432 27017; do
  if python3 -c "import socket,sys; socket.create_connection(('127.0.0.1',$port),2)" 2>/dev/null; then
    if docker ps --filter "label=com.docker.compose.project=$P" --filter "publish=$port" -q | grep -q .; then
      bad "localhost:$port responde desde el host (lo publica el proyecto)"
    else echo "  [AVISO] localhost:$port lo ocupa un proceso del host ajeno al proyecto (no cuenta)"; fi
  else ok "localhost:$port cerrado en el host"; fi
done
c=$(curl -s -o /dev/null -m 8 -w '%{http_code}' --cacert "$CA" "https://localhost:$GW/healthz")
[ "$c" = 200 ] && ok "https://localhost:$GW/healthz (WAF -> Gateway) HTTP $c" || bad "WAF -> Gateway HTTP $c"
c=$(curl -s -o /dev/null -m 8 -w '%{http_code}' --cacert "$CA" "https://localhost:$WEB/")
case "$c" in 2??|3??) ok "https://localhost:$WEB/ (WAF -> Platform) HTTP $c";; *) bad "WAF -> Platform HTTP $c";; esac
c=$(curl -s -o /dev/null -m 15 -w '%{http_code}' --cacert "$CA" "https://localhost:$GW/api/elections/open")
[ "$c" = 200 ] && ok "GET /api/elections/open (WAF -> Gateway -> Identity -> Postgres) HTTP $c" || bad "/api/elections/open HTTP $c"

# --- 2. Flujos permitidos -------------------------------------------------------
echo "2. Flujos permitidos (tabla de dependencias), con mTLS cuando el servicio lo exige"
for spec in "gateway|gateway|https://identity:8000/health" "gateway|gateway|https://ballot:8080/healthz" \
            "gateway|gateway|https://tally:8092/healthz" "gateway|gateway|https://analytics:8090/healthz" \
            "gateway|gateway|https://notification:3000/healthz" "waf|waf|https://gateway:8088/healthz" \
            "waf|waf|https://platform:3000/" "platform|platform|https://gateway:8088/healthz" \
            "tally|tally|https://ballot:8080/healthz"; do
  IFS='|' read -r src cert url <<<"$spec"; c=$(tls "$src" "$cert" "$url")
  case "$c" in 2??|3??) ok "$src -> $url HTTP $c (mTLS)";; *) bad "$src -> $url HTTP $c";; esac
done
expect A identity "ballot:9091 blind-signature:8100 postgres:5432 postgres-census:5432"
expect A ballot "mongo:27017 rabbitmq:5672"
expect A election "postgres-elections:5432 rabbitmq:5672"
expect A tally "rabbitmq:5672"
expect A analytics "mongo-results:27017 rabbitmq:5672"
expect A notification "notifications-mongo:27017 rabbitmq:5672"

# --- 3. Movimiento lateral desde un servicio comprometido ------------------------
echo "3. Conexiones no necesarias (servicio comprometido intentando moverse)"
expect D gateway "ballot:9091" "riesgo 1 del Lab 5 (gRPC de administración de Ballot)"
expect D gateway "postgres:5432 postgres-census:5432 postgres-elections:5432 mongo:27017 mongo-results:27017 notifications-mongo:27017 rabbitmq:5672 rabbitmq:15672 blind-signature:8100 election:8000 platform:3000 waf:8444"
expect D identity "ballot:8080" "riesgo 2 del Lab 5"
expect D identity "mongo:27017 rabbitmq:5672 election:8000 gateway:8088 tally:8092"
expect D notification "rabbitmq:15672" "riesgo 3 del Lab 5 (API de gestión, guest/guest)"
expect D notification "tally:8092" "riesgo 4 del Lab 5"
expect D notification "analytics:8090" "riesgo 5 del Lab 5"
expect D notification "gateway:8088 ballot:8080 ballot:9091 mongo-results:27017"
expect D election "rabbitmq:15672" "riesgo 6 del Lab 5"
expect D election "ballot:9091 identity:8000 postgres:5432"
expect D rabbitmq "election:8000" "riesgo 7 del Lab 5 (Election acepta X-Dev-User)"
expect D rabbitmq "ballot:9091" "riesgo 8 del Lab 5"
expect D rabbitmq "ballot:8080 tally:8092 analytics:8090 notification:3000"
expect D ballot "identity:8000 gateway:8088 tally:8092 rabbitmq:15672 mongo-results:27017"
expect D tally "ballot:9091 gateway:8088 analytics:8090 notification:3000 rabbitmq:15672 mongo:27017"
expect D analytics "tally:8092 notification:3000 gateway:8088 rabbitmq:15672 mongo:27017"
expect D platform "identity:8000 ballot:8080 mongo:27017 waf:8443"
expect D waf "identity:8000 ballot:8080 tally:8092 postgres:5432 mongo:27017 rabbitmq:5672"
expect D blind-signature "identity:8000"
expect D mongo "ballot:8080 ballot:9091"

# --- 4. Atacante externo ----------------------------------------------------------
# Contenedor en edge-net: misma posición que el tráfico que llega a los puertos publicados.
echo "4. Atacante externo en la red de borde (${P}_edge-net)"
ips() { docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$(cid "$1")"; }
attack() { docker run --rm --network "${P}_edge-net" --entrypoint sh "$IMG" -c "$1" 2>/dev/null; }
out=$(attack 'for t in waf:8443 waf:8444; do nc -z -w 3 ${t%:*} ${t#*:} && echo "$t open" || echo "$t blocked"; done')
for t in waf:8443 waf:8444; do echo "$out" | grep -q "^$t open" && ok "atacante -> $t (entrada pública)" || bad "atacante -> $t no conecta"; done
out=$(attack 'for t in gateway:8088 platform:3000 identity:8000 ballot:8080 ballot:9091 tally:8092 postgres:5432 mongo:27017 rabbitmq:5672; do
  getent hosts ${t%:*} >/dev/null 2>&1 && { nc -z -w 3 ${t%:*} ${t#*:} && echo "$t open" || echo "$t blocked"; } || echo "$t nodns"; done')
while read -r t r; do [ "$r" = open ] && bad "atacante -> $t CONECTA" || ok "atacante -> $t ($r)"; done <<<"$out"
# Escaneo de TODAS las IP de los servicios y del WAF. Control positivo: el WAF debe
# verse abierto en 8443/8444 por su IP de edge-net; cualquier otro puerto, abierto
# o "closed" (alcanzable), es una falla. Sin --host-timeout: un host saltado no cuenta.
targets=""; for svc in gateway platform identity ballot tally analytics notification rabbitmq postgres mongo waf; do targets="$targets $(ips "$svc")"; done
PORTS=3000,5432,5672,8000,8080,8088,8090,8092,8443,8444,9091,15672,27017
scan=$(attack "nmap -n -sT -Pn -T4 --max-retries 0 --initial-rtt-timeout 300ms --max-rtt-timeout 500ms -p $PORTS $targets")
nhosts=$(echo $targets | wc -w | tr -d ' '); nports=$(echo "$PORTS" | tr ',' '\n' | wc -l | tr -d ' ')
reached=$(echo "$scan" | awk '/^Nmap scan report/{h=$NF} / (open|closed) /{print h":"$1}' | sort | tr '\n' ' ')
edge=$(docker inspect --format '{{with index .NetworkSettings.Networks "'"${P}_edge-net"'"}}{{.IPAddress}}{{end}}' "$(cid waf)")
filtered=$(echo "$scan" | grep -c ' filtered ')
echo "$scan" | grep -qi 'skipping host' && bad "nmap saltó hosts: el escaneo no es concluyente"
[ "$reached" = "$edge:8443/tcp $edge:8444/tcp " ] && ok "nmap: solo $edge:8443/8444 (WAF) responde" || bad "nmap alcanzó: $reached"
[ "$filtered" -eq $((nhosts * nports - 2)) ] && ok "nmap: $filtered de $((nhosts * nports)) puertos filtered en $nhosts IP (todas las de los servicios)" \
  || bad "nmap: $filtered puertos filtered, se esperaban $((nhosts * nports - 2))"

# --- 5. Registro de intentos denegados ---------------------------------------------
echo "5. Registro de los intentos denegados (docker compose logs <servicio>-fw)"
sleep 1
for svc in ballot rabbitmq gateway identity notification election tally analytics; do
  n=$(dc logs --no-log-prefix --since "$START" "$svc-fw" 2>/dev/null | grep -c 'Flags \[S\]')
  [ "$n" -gt 0 ] && ok "$svc-fw registró $n intento(s) denegado(s)" || bad "$svc-fw no registró los intentos denegados"
done
echo "   Ejemplo (ballot-fw):"
dc logs --no-log-prefix --since "$START" ballot-fw 2>/dev/null | grep 'Flags \[S\]' | head -3 | cut -c1-110 | sed 's/^/        /'
echo "   Contadores de la ACL de Ballot:"
dc exec -T ballot-fw iptables -L INPUT -v -n 2>/dev/null | sed 's/^/        /'

# --- 6. Reinicio de un servicio (opcional: reinicia Ballot) ---------------------------
if [ -n "${RESTART_TEST:-}" ]; then
  echo "6. Reinicio de Ballot (RESTART_TEST=1): el sidecar debe reaplicar la ACL solo"
  policy() { docker run --rm --network "container:$(cid ballot)" --cap-add NET_ADMIN --entrypoint iptables "$IMG" -S INPUT 2>/dev/null | head -1; }
  dc restart ballot >/dev/null 2>&1; t0=$(date +%s)
  for _ in $(seq 1 30); do [ "$(policy)" = "-P INPUT DROP" ] && break; sleep 1; done
  dt=$(( $(date +%s) - t0 ))
  [ "$(policy)" = "-P INPUT DROP" ] && ok "ACL de ballot reaplicada ${dt} s después del reinicio" || bad "la ACL de ballot no se reaplicó en 30 s"
  expect D gateway "ballot:9091" "tras el reinicio"
  expect A identity "ballot:9091"
fi

echo
printf 'Resumen: %d correctas, %d fallidas\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
