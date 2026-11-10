#!/usr/bin/env bash
# Verificación de la segmentación de red (Laboratorio 5).
#
# Secciones 1, 2a y 3: SOLO LECTURA (conexiones TCP y GET sin autenticación).
# Sección 2b: ESCRIBE en las bases. El login y el MFA insertan filas en
#   mfa_challenges y sessions (Postgres de Identity) y se crea una elección de
#   prueba (Postgres + Ballot). Con SKIP_WRITE=1 la sección 2b se omite por completo.
#
#   SKIP_WRITE=1 bash docs/lab5-network-segmentation/verify-segmentation.sh   # solo lectura
#
#   docker compose -p votaciones up -d --build <servicios sin mobile>
#   bash docs/lab5-network-segmentation/verify-segmentation.sh
#
# No borra nada. Sale con código 1 si alguna comprobación obligatoria falla.
# Requiere: docker compose, curl y python (python3 o python). Proyecto Compose: P (por defecto "votaciones").

P="${P:-votaciones}"
WEB="${WEB_PORT:-3000}"; GW="${GATEWAY_PORT:-8088}"; RMQ="${RABBITMQ_UI_PORT:-15672}"; ELEC="${ELECTION_PORT:-8001}"
PASS=0; FAIL=0; RISK=0
dc() { docker compose -p "$P" "$@"; }
ok()   { PASS=$((PASS+1)); printf '  [OK]    %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  [FALLA] %s\n' "$1"; }
risk() { RISK=$((RISK+1)); printf '  [RIESGO] %s\n' "$1"; }
PY=python3; python3 -c "" >/dev/null 2>&1 || PY=python
json() { $PY -I -c "import sys,json;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }

# --- 1. Puertos publicados en el host --------------------------------------
echo "1. Puertos del host (esperado: solo $WEB, $GW, y 127.0.0.1:$RMQ/$ELEC)"
http() { curl -s -o /dev/null -m 4 -w '%{http_code}' "$1" 2>/dev/null; }
for spec in "Platform|http://localhost:$WEB/login" "Gateway|http://localhost:$GW/healthz" \
            "RabbitMQ UI|http://127.0.0.1:$RMQ/" "Election (dev)|http://127.0.0.1:$ELEC/health"; do
  name=${spec%%|*}; url=${spec#*|}; code=$(http "$url")
  case "$code" in 2??|3??|401) ok "$name responde en $url (HTTP $code)";; *) bad "$name NO responde en $url (HTTP $code)";; esac
done
for spec in "Identity|8000" "Ballot|8080" "Ballot gRPC|9091" "Tally|8092" "Analytics|8090" "Notification|8091" \
            "RabbitMQ AMQP|5672" "Mongo|27017" "Postgres|5432"; do
  name=${spec%%|*}; port=${spec#*|}; code=$(http "http://localhost:$port/")
  if [ "$code" = "000" ]; then ok "$name (localhost:$port) NO publicado"; else bad "$name (localhost:$port) responde HTTP $code"; fi
done

# --- 2a. Comunicación entre servicios (solo lectura) -----------------------
echo "2a. Comunicación HTTP (solo lectura, sin autenticación)"
G="http://localhost:$GW"
code() { curl -s -o /dev/null -m 8 -w '%{http_code}' "$@"; }
for spec in "identity|8000|/health" "ballot|8080|/healthz" "tally|8092|/healthz" "analytics|8090|/healthz" "notification|3000|/healthz"; do
  IFS='|' read -r svc port path <<<"$spec"
  # -O- y redirección local: en Git Bash (Windows) un "/dev/null" como argumento se convierte en "nul".
  if dc exec -T gateway wget -q -O- -T 4 "http://$svc:$port$path" >/dev/null 2>&1; then ok "gateway -> http://$svc:$port$path responde"; else bad "gateway -> http://$svc:$port$path no responde"; fi
done
[ "$(code "$G/api/elections/open")" = 200 ] && ok "GET /api/elections/open (Gateway -> Identity -> Postgres)" || bad "/api/elections/open"
bc=$(code "$G/api/ballots/elections/no-existe/parameters"); case "$bc" in 200|404) ok "GET /api/ballots/... (Gateway -> Ballot -> Mongo, HTTP $bc)";; *) bad "/api/ballots (HTTP $bc)";; esac
[ "$(code "http://localhost:$WEB/api/elections/open")" = 200 ] && ok "Platform proxy /api/* -> Gateway -> Identity" || bad "Platform proxy"

# --- 2b. Flujo autenticado (ESCRIBE: sesiones y una elección de prueba) -----
if [ -n "$SKIP_WRITE" ]; then echo "2b. Flujo autenticado OMITIDO (SKIP_WRITE=1)"; else
echo "2b. Flujo autenticado (escribe en Identity y Ballot)"
ch=$(curl -s -m 8 -X POST "$G/api/auth/login" -H 'content-type: application/json' -d '{"username":"admin1","password":"prueba123"}' | json "['challenge_id']")
[ -n "$ch" ] && ok "login admin1 -> challenge MFA" || bad "login admin1"
tok=$(curl -s -m 8 -X POST "$G/api/auth/login/mfa" -H 'content-type: application/json' -d "{\"challenge_id\":\"$ch\",\"code\":\"123456\"}" | json "['access_token']")
[ -n "$tok" ] && ok "MFA -> access_token (JWT)" || bad "MFA"
A="authorization: Bearer $tok"
[ "$(code "$G/api/auth/me" -H "$A")" = 200 ] && ok "GET /api/auth/me (Gateway -> Identity, valida JWT con JWKS)" || bad "/api/auth/me"
[ "$(code "$G/api/analytics/summary" -H "$A")" = 200 ] && ok "GET /api/analytics/summary (Gateway -> Analytics -> Mongo Results)" || bad "/api/analytics/summary"
nc_=$(code "$G/api/notifications" -H "$A"); case "$nc_" in 200|404) ok "GET /api/notifications (Gateway -> Notification, HTTP $nc_)";; *) bad "/api/notifications (HTTP $nc_)";; esac
tc=$(code "$G/api/tally/elections/no-existe" -H "$A"); case "$tc" in 200|404) ok "GET /api/tally/... (Gateway -> Tally, HTTP $tc)";; *) bad "/api/tally (HTTP $tc)";; esac
  key=$($PY -I -c "import os,base64;print(base64.urlsafe_b64encode(os.urandom(32)).rstrip(b'=').decode())")
  now=$(date +%s)
  body="{\"name\":\"Prueba segmentacion\",\"options\":[\"A\",\"B\"],\"encryption_public_key\":\"$key\",\"opens_at\":$now,\"closes_at\":$((now+3600)),\"open\":true}"
  c=$(curl -s -o /tmp/elec.json -m 15 -w '%{http_code}' -X POST "$G/api/elections" -H "$A" -H 'content-type: application/json' -d "$body")
  [ "$c" = 201 ] && ok "POST /api/elections -> Identity -> Ballot gRPC 9091 (RegisterElection)" || bad "crear elección (HTTP $c): $(head -c 200 /tmp/elec.json 2>/dev/null)"
fi

# --- 3. Aislamiento entre redes --------------------------------------------
# Estados: A = debe conectar. D = debe fallar. R = conecta aunque no hace falta (riesgo documentado).
echo "3. Matriz de conectividad entre contenedores (origen -> destino:puerto)"
probe() { # origen host puerto -> imprime "open" o "closed"
  local src=$1 host=$2 port=$3
  case $src in
    identity|election) dc exec -T "$src" python -c "import socket,sys
try: socket.create_connection(('$host',$port),2); print('open')
except Exception: print('closed')" 2>/dev/null ;;
    *) dc exec -T "$src" sh -c "nc -z -w 2 $host $port >/dev/null 2>&1 && echo open || echo closed" 2>/dev/null ;;
  esac
}
t() { # estado origen destino puerto [nota]
  local want=$1 src=$2 host=$3 port=$4 note=$5 got; got=$(probe "$src" "$host" "$port" | tr -d '\r' | tail -1)
  local label="$src -> $host:$port"
  case "$want:$got" in
    A:open) ok "$label conecta (permitido)";;
    A:*)    bad "$label debía conectar y NO conecta";;
    D:closed) ok "$label bloqueado (denegado)";;
    D:*)    bad "$label debía estar bloqueado y CONECTA";;
    R:open) risk "$label conecta, no es necesario: $note";;
    R:*)    ok "$label ya no conecta (riesgo mitigado)";;
  esac
}
t A gateway identity 8000;  t A gateway ballot 8080;   t A gateway tally 8092
t A gateway analytics 8090; t A gateway notification 3000
t D gateway rabbitmq 5672;  t D gateway postgres 5432; t D gateway mongo 27017
t D gateway blind-signature 8100; t D gateway election 8000
t R gateway ballot 9091 "gRPC admin de Ballot sin autenticación, alcanzable desde Gateway"
t A platform gateway 8088;  t D platform identity 8000; t D platform ballot 8080; t D platform mongo 27017
t A identity postgres 5432; t A identity postgres-census 5432; t A identity blind-signature 8100
t A identity ballot 9091;   t D identity mongo 27017;  t D identity rabbitmq 5672; t D identity election 8000
t R identity ballot 8080 "comparte vote-link-net con Ballot (HTTP público de Ballot)"
t A notification rabbitmq 5672; t A notification notifications-mongo 27017
t D notification ballot 8080; t D notification ballot 9091; t D notification identity 8000; t D notification mongo-results 27017
t R notification rabbitmq 15672 "API de gestión de RabbitMQ con guest/guest desde messaging-net"
t R notification tally 8092 "comparte messaging-net con Tally"
t R notification analytics 8090 "comparte messaging-net con Analytics"
t A election postgres-elections 5432; t A election rabbitmq 5672
t D election ballot 8080; t D election ballot 9091; t D election identity 8000; t D election mongo 27017
t R election rabbitmq 15672 "dev-access-net compartida con RabbitMQ (API de gestión, guest/guest)"
t R rabbitmq election 8000 "dev-access-net: RabbitMQ alcanza Election (acepta X-Dev-User sin token)"
t R rabbitmq ballot 9091 "mq-ballot-net: RabbitMQ alcanza el gRPC de Ballot"

echo
printf 'Resumen: %d correctas, %d fallidas, %d riesgos confirmados (conexiones no necesarias)\n' "$PASS" "$FAIL" "$RISK"
[ "$FAIL" -eq 0 ]
