#!/usr/bin/env bash
# Validación del Reverse Proxy de aplicación (escenario de seguridad 2, Prototipo 3).
#
# Comprueba que el API Gateway, detrás del WAF, es el único intermediario hacia los
# servicios y que:
#   - toda operación de la CLI de administración va por rutas /api/... del catálogo;
#   - un token revocado (logout) o de un usuario desactivado se rechaza con 401 de
#     inmediato (y sigue rechazado tras GATEWAY_SESSION_CACHE_TTL_MS) sin llegar al
#     servicio destino (`forwarded: false` en la línea de acceso del Gateway);
#   - las respuestas, también los errores del propio WAF, no revelan servicios,
#     hosts, puertos ni frameworks internos;
#   - la ruta anónima de votación no pasa por la comprobación de sesión del Gateway.
#
# Uso:
#   bash docs/p3-reverse-proxy/verify-reverse-proxy.sh --static
#       Sin daemon de Docker: revisa docker-compose.yml y el código de la CLI.
#   bash docs/p3-reverse-proxy/verify-reverse-proxy.sh --selftest
#       Prueba la lectura del log del Gateway con líneas sintéticas.
#   bash docs/p3-reverse-proxy/verify-reverse-proxy.sh [API_URL]
#       Con el stack levantado (docker compose up -d). Por defecto API_URL=https://localhost:8088.
#
# Variables: VOTACIONES_TLS_CA_FILE (CA local), MFA (código MFA de desarrollo, 123456),
# GATEWAY_SESSION_CACHE_TTL_MS (5000), ADMIN_USER/ADMIN_PASSWORD (admin1/prueba123).
# Requiere curl y python3 (y java para ejecutar la CLI real, si está compilada).
# Sale con código 1 si alguna comprobación falla.

set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ✔ %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf '  ✘ %s\n' "$*"; }

finish() {
  echo
  echo "Resultado: $pass correctos, $fail fallidos."
  [ "$fail" -eq 0 ]
  exit $?
}

for tool in curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Falta $tool." >&2; exit 2; }
done

# --- comprobaciones estáticas (también se ejecutan en modo en vivo) -----------

static_checks() {
  echo "Estático 1. Solo el WAF y mobile publican puertos (docker compose config)"
  local config
  if ! config=$(docker compose config --format json 2>/dev/null); then
    bad "docker compose config falló"
    return
  fi
  printf '%s' "$config" | python3 -c '
import json, sys
cfg = json.load(sys.stdin)
services = cfg.get("services", {})
expected = {"waf": {"3000", "8088"}, "mobile": {"8092"}}
internal = ["identity", "gateway", "platform", "ballot", "tally", "analytics", "blind-signature", "election"]
for name, published in expected.items():
    got = {str(p.get("published")) for p in services.get(name, {}).get("ports", [])}
    print(("OK " if got == published else "BAD ") + f"{name} publica {sorted(got)} (esperado {sorted(published)})")
for name in internal:
    if name not in services:
        print(f"OK {name} no existe como servicio separado (sin puertos)")
        continue
    ports = services[name].get("ports", [])
    print(("OK " if not ports else "BAD ") + f"{name} sin puertos en el host" + ("" if not ports else f": {ports}"))
others = sorted(n for n, s in services.items() if s.get("ports") and n not in expected)
print(("OK " if not others else "BAD ") + "ningún otro servicio publica puertos" + ("" if not others else f": {others}"))
' > "$TMP/ports.txt"
  while read -r verdict rest; do
    if [ "$verdict" = OK ]; then ok "$rest"; else bad "$rest"; fi
  done < "$TMP/ports.txt"

  echo "Estático 2. El Gateway comprueba la sesión en identity"
  printf '%s' "$config" | python3 -c '
import json, sys
env = json.load(sys.stdin)["services"]["gateway"].get("environment", {})
print(env.get("GATEWAY_SESSION_CHECK", ""))
print(env.get("GATEWAY_AUTH_URL", ""))
print(env.get("GATEWAY_SESSION_CACHE_TTL_MS", ""))
' > "$TMP/gwenv.txt"
  local check url ttl
  { read -r check; read -r url; read -r ttl; } < "$TMP/gwenv.txt"
  [ "$check" = identity ] && ok "GATEWAY_SESSION_CHECK=identity" || bad "GATEWAY_SESSION_CHECK='$check' (esperado identity)"
  case "$url" in
    https://identity:*) ok "GATEWAY_AUTH_URL=$url (mTLS hacia identity)";;
    *) bad "GATEWAY_AUTH_URL='$url' (esperado https://identity:...)";;
  esac
  [ -n "$ttl" ] && ok "GATEWAY_SESSION_CACHE_TTL_MS=$ttl" || bad "GATEWAY_SESSION_CACHE_TTL_MS no definido"

  echo "Estático 3. La CLI no usa rutas internas de los servicios"
  # Todo literal que empiece por "/" en admin-cli/src/main debe ser una ruta /api/... o
  # uno de los sufijos/patrones conocidos que se concatenan a una ruta /api/. Un
  # literal como "/users", "/tokens/blind", "/keys" o "/v1/..." hace fallar la comprobación.
  local hits
  hits=$(grep -rnoE '"/[^"]*"' admin-cli/src/main 2>/dev/null | python3 -c '
import sys
allowed = {"\"/\"", "\"//\"", "\"/+$\"", "\"/voters\"", "\"/results\"", "\"/close\"", "\"/status\"", "\"/open\""}
for line in sys.stdin:
    location, _, literal = line.rstrip("\n").rpartition(":")
    if literal.startswith("\"/api/") or literal in allowed:
        continue
    print(f"{location}: {literal}")
')
  if [ -z "$hits" ]; then
    ok "todos los literales de ruta de admin-cli/src/main son /api/... o sufijos conocidos"
  else
    bad "rutas fuera de /api/ en la CLI:"; printf '%s\n' "$hits" | sed 's/^/      /'
  fi
  if grep -q 'requireCatalogPath(path);' admin-cli/src/main/java/votaciones/admin/ApiClient.java; then
    ok "ApiClient.send() valida cada ruta con requireCatalogPath"
  else
    bad "ApiClient.send() no valida la ruta (requireCatalogPath)"
  fi
  # La evidencia de comportamiento es la prueba Java, no el texto del código.
  if [ -x admin-cli/mvnw ] || [ -f admin-cli/mvnw ]; then
    if command -v java >/dev/null 2>&1 && (cd admin-cli && sh ./mvnw -o -q test \
        -Dtest='AdminCliTest#everyCommandUsesOnlyGatewayApiRoutes+apiClientRejectsRoutesOutsideTheGatewayCatalog' \
        >"$TMP/mvn.log" 2>&1); then
      ok "pruebas de la CLI: todos los comandos piden solo /api/ y ApiClient rechaza rutas internas"
    elif command -v java >/dev/null 2>&1; then
      bad "pruebas de la CLI fallaron (ver mvnw test):"; tail -20 "$TMP/mvn.log" | sed 's/^/      /'
    else
      echo "  [AVISO] sin java: no se ejecutaron las pruebas de rutas de la CLI (no cuenta como correcto)"
    fi
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# forward_state <log> <requestId>: lee la línea de acceso del Gateway para ese
# requestId (formato de `docker compose logs`: "gateway-1  | {json}") y responde
# "forwarded", "not_forwarded", "unknown" (línea sin el campo) o "absent".
forward_state() {
  python3 -c '
import json, sys
path, rid = sys.argv[1], sys.argv[2]
state = "absent"
try:
    lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
except OSError:
    lines = []
for line in lines:
    start = line.find("{")
    if start < 0 or rid not in line:
        continue
    try:
        entry = json.loads(line[start:])
    except ValueError:
        continue
    if entry.get("requestId") != rid or "status" not in entry:
        continue
    forwarded = entry.get("forwarded")
    state = "forwarded" if forwarded is True else "not_forwarded" if forwarded is False else "unknown"
print(state)' "$1" "$2"
}

# expect_not_forwarded <descripción> <archivo .hdr>: exige que el Gateway registrara la
# petición y que no la reenviara. Cualquier otra cosa (log ilegible, sin línea) falla.
expect_not_forwarded() {
  local desc="$1" hdr="$2" rid state
  rid=$(grep -i '^x-request-id:' "$hdr" | tr -d '\r' | awk '{print $2}')
  if [ -z "$rid" ]; then bad "$desc: la respuesta no trae X-Request-Id"; return; fi
  # El Gateway escribe la línea de acceso después de responder: se reintenta unos segundos.
  local attempt
  state=absent
  for attempt in 1 2 3 4 5; do
    if ! docker compose logs --no-color gateway > "$TMP/gateway.log" 2>/dev/null; then
      bad "$desc: no se pudo leer el log del Gateway (docker compose logs gateway)"; return
    fi
    state=$(forward_state "$TMP/gateway.log" "$rid")
    [ "$state" = absent ] || break
    sleep 1
  done
  if [ "$state" = not_forwarded ]; then
    ok "$desc: log del Gateway, requestId $rid con forwarded=false (no llegó al servicio)"
  else
    bad "$desc: requestId $rid en el log del Gateway: $state"
  fi
}

if [ "${1:-}" = "--selftest" ]; then
  echo "Reverse Proxy · autoprueba de la lectura del log"
  echo
  cat > "$TMP/self.log" <<'LOG'
gateway-1  | {"level":"info","requestId":"r-no","method":"POST","route":"/api/tally/elections/:electionId","service":"tally","forwarded":false,"status":401,"ms":3}
gateway-1  | {"level":"warn","requestId":"r-yes","message":"upstream error","upstreamStatus":500,"service":"tally"}
gateway-1  | {"level":"info","requestId":"r-yes","method":"POST","route":"/api/tally/elections/:electionId","service":"tally","forwarded":true,"status":502,"ms":9}
gateway-1  | {"level":"info","requestId":"r-old","method":"GET","route":"/api","status":200,"ms":1}
LOG
  for case in "r-no not_forwarded" "r-yes forwarded" "r-old unknown" "r-missing absent"; do
    set -- $case
    got=$(forward_state "$TMP/self.log" "$1")
    [ "$got" = "$2" ] && ok "$1 -> $got" || bad "$1 -> $got (esperado $2)"
  done
  got=$(forward_state "$TMP/no-existe.log" r-no)
  [ "$got" = absent ] && ok "log ilegible -> absent" || bad "log ilegible -> $got"
  finish
fi

if [ "${1:-}" = "--static" ]; then
  echo "Reverse Proxy · modo estático (sin daemon de Docker)"
  echo
  static_checks
  finish
fi

# --- modo en vivo -----------------------------------------------------------------

API="${1:-https://localhost:8088}"
TLS_CA="${VOTACIONES_TLS_CA_FILE:-.dev-certs/ca-public/ca.crt}"
MFA="${MFA:-123456}"
ADMIN_USER="${ADMIN_USER:-admin1}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-prueba123}"
TTL_MS="${GATEWAY_SESSION_CACHE_TTL_MS:-5000}"
TTL_S=$(( (TTL_MS + 999) / 1000 ))
STAMP=$(date +%s)
RP_USER="rp-$STAMP"
RP_PASSWORD="Rp-prueba-$STAMP"
if [ ! -f "$TLS_CA" ]; then
  echo "No se encuentra la CA TLS: $TLS_CA (define VOTACIONES_TLS_CA_FILE)." >&2
  exit 2
fi
case "$TLS_CA" in /*) ;; *) TLS_CA="$ROOT/$TLS_CA";; esac

# req <nombre> <curl args...>: guarda cuerpo en $TMP/<nombre>.body, cabeceras en
# $TMP/<nombre>.hdr y devuelve el código HTTP en stdout.
req() {
  local name="$1"
  shift
  curl -s -o "$TMP/$name.body" -D "$TMP/$name.hdr" -w '%{http_code}' --cacert "$TLS_CA" \
    -A "verify-reverse-proxy" --max-time 30 "$@"
}

json_field() { # json_field <archivo> <campo>
  python3 -c 'import json,sys
try:
    v = json.load(open(sys.argv[1]))
    for k in sys.argv[2].split("."):
        v = v[k]
    print(v)
except Exception:
    print("")' "$1" "$2"
}

login() { # login <usuario> <contraseña> -> token (vacío si falla)
  local code
  code=$(req login -H 'Content-Type: application/json' -X POST "$API/api/auth/login" \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}")
  [ "$code" = 200 ] || { echo ""; return; }
  local challenge
  challenge=$(json_field "$TMP/login.body" challenge_id)
  code=$(req mfa -H 'Content-Type: application/json' -X POST "$API/api/auth/login/mfa" \
    -d "{\"challenge_id\":\"$challenge\",\"code\":\"$MFA\"}")
  [ "$code" = 200 ] || { echo ""; return; }
  json_field "$TMP/mfa.body" access_token
}

echo "Reverse Proxy · API $API (TTL de la caché de sesión: ${TTL_MS} ms)"
echo
static_checks

echo "1. Los servicios no son alcanzables desde el host"
# 8000 identity, 8001 blind-signature, 8080 ballot, 8090 analytics, 8100 election.
for port in 8000 8001 8080 8090 8100; do
  if python3 -c "import socket; socket.create_connection(('127.0.0.1',$port),2)" 2>/dev/null; then
    # Igual que verify-segmentation.sh: un proceso del host ajeno al proyecto no cuenta.
    if docker ps --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-votaciones}" \
        --filter "publish=$port" -q 2>/dev/null | grep -q .; then
      bad "localhost:$port acepta conexiones desde el host (lo publica el proyecto)"
    else
      echo "  [AVISO] localhost:$port lo ocupa un proceso del host ajeno al proyecto (no cuenta)"
    fi
  else
    ok "localhost:$port cerrado"
  fi
done
code=$(req health "$API/healthz")
[ "$code" = 200 ] && ok "WAF -> Gateway /healthz HTTP $code" || bad "WAF -> Gateway /healthz HTTP $code"

# --- 2-3. CLI 100 % vía WAF -> Gateway --------------------------------------------
echo "2-3. Operaciones de la CLI de administración por /api/..."
JAR="admin-cli/target/votaciones-admin.jar"
ADMIN=""
ELECTION=""
RP_ID=""
if [ -f "$JAR" ] && command -v java >/dev/null 2>&1; then
  export VOTACIONES_HOME="$TMP/cli-home"
  export VOTACIONES_TLS_CA_FILE="$TLS_CA"
  cli() { java -jar "$JAR" --api-url "$API" "$@"; }
  if printf '%s\n' "$ADMIN_PASSWORD" | cli login -u "$ADMIN_USER" --password-stdin --mfa-code "$MFA" >/dev/null; then
    ok "cli login (POST /api/auth/login + /api/auth/login/mfa)"
    ADMIN=$(json_field "$VOTACIONES_HOME/session.json" access_token)
  else
    bad "cli login"
  fi
  run_cli() { # run_cli <descripción> <args...>
    local desc="$1"; shift
    if cli "$@" > "$TMP/cli.out" 2> "$TMP/cli.err"; then ok "cli $desc"; else bad "cli $desc: $(cat "$TMP/cli.err")"; fi
  }
  run_cli whoami whoami
  run_cli "users list" users list
  if printf '%s\n' "$RP_PASSWORD" | cli --json users create "$RP_USER" --role admin --password-stdin > "$TMP/user.json" 2> "$TMP/cli.err"; then
    ok "cli users create $RP_USER (POST /api/auth/users)"; RP_ID=$(json_field "$TMP/user.json" id)
  else bad "cli users create: $(cat "$TMP/cli.err")"; fi
  run_cli "elections list" elections list
  if cli --json elections create --name "Reverse proxy $STAMP" --option A --option B --duration 1h \
      --encryption-key cHVibGlj --draft > "$TMP/election.json" 2> "$TMP/cli.err"; then
    ok "cli elections create --draft"; ELECTION=$(json_field "$TMP/election.json" election_id)
  else bad "cli elections create: $(cat "$TMP/cli.err")"; fi
  if [ -n "$ELECTION" ]; then
    run_cli "elections open $ELECTION (POST /api/elections/:id/open)" elections open "$ELECTION"
    run_cli "elections status $ELECTION" elections status "$ELECTION"
    run_cli "voters list $ELECTION" voters list "$ELECTION"
    run_cli "elections close $ELECTION" elections close "$ELECTION" --yes
  else
    bad "sin elección de prueba: open/status/voters/close no se ejecutaron"
  fi
else
  echo "  [AVISO] No hay $JAR o java: se usan las mismas rutas con curl."
  ADMIN=$(login "$ADMIN_USER" "$ADMIN_PASSWORD")
  [ -n "$ADMIN" ] && ok "login de $ADMIN_USER (POST /api/auth/login + /mfa)" || bad "login de $ADMIN_USER"
  A=(-H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json')
  expect2xx() { # expect2xx <descripción> <código>
    case "$2" in 2??) ok "$1 HTTP $2";; *) bad "$1 HTTP $2";; esac
  }
  expect2xx "GET /api/auth/me" "$(req me "${A[@]}" "$API/api/auth/me")"
  expect2xx "GET /api/auth/users" "$(req users "${A[@]}" "$API/api/auth/users")"
  code=$(req user "${A[@]}" -X POST "$API/api/auth/users" \
    -d "{\"username\":\"$RP_USER\",\"password\":\"$RP_PASSWORD\",\"role\":\"admin\"}")
  expect2xx "POST /api/auth/users ($RP_USER)" "$code"; RP_ID=$(json_field "$TMP/user.body" id)
  expect2xx "GET /api/elections" "$(req elections "${A[@]}" "$API/api/elections")"
  now=$(date +%s)
  code=$(req election "${A[@]}" -X POST "$API/api/elections" -d "{\"name\":\"Reverse proxy $STAMP\",\"options\":[\"A\",\"B\"],\"encryption_public_key\":\"cHVibGlj\",\"opens_at\":$now,\"closes_at\":$((now + 3600)),\"open\":false}")
  expect2xx "POST /api/elections" "$code"; ELECTION=$(json_field "$TMP/election.body" election_id)
  if [ -n "$ELECTION" ]; then
    expect2xx "POST /api/elections/$ELECTION/open" "$(req open "${A[@]}" -X POST "$API/api/elections/$ELECTION/open")"
    expect2xx "GET /api/elections/$ELECTION/status" "$(req status "${A[@]}" "$API/api/elections/$ELECTION/status")"
    expect2xx "GET /api/identity/elections/$ELECTION/voters" "$(req voters "${A[@]}" "$API/api/identity/elections/$ELECTION/voters")"
    expect2xx "POST /api/elections/$ELECTION/close" "$(req close "${A[@]}" -X POST "$API/api/elections/$ELECTION/close")"
  else
    bad "sin elección de prueba: open/status/voters/close no se ejecutaron"
  fi
fi
[ -n "$ADMIN" ] || { echo "  Sin sesión de administrador: no se puede continuar."; finish; }

# --- 4. Revocación (logout) ----------------------------------------------------------
echo "4. Un token revocado se rechaza de inmediato y tras ${TTL_S} s, sin llegar al servicio"
T=$(login "$ADMIN_USER" "$ADMIN_PASSWORD")
if [ -z "$T" ]; then
  bad "no se pudo obtener el token de prueba"
else
  # Esta petición deja la sesión en la caché del Gateway: el logout debe invalidarla.
  code=$(req sum1 -H "Authorization: Bearer $T" "$API/api/analytics/summary")
  [ "$code" = 200 ] && ok "antes del logout: GET /api/analytics/summary HTTP 200" || bad "antes del logout: HTTP $code"
  code=$(req logout -H "Authorization: Bearer $T" -X POST "$API/api/auth/logout")
  [ "$code" = 204 ] && ok "POST /api/auth/logout HTTP 204" || bad "logout HTTP $code"
  # Sin esperar: el logout pasó por el Gateway, que descarta la sesión de su caché.
  code=$(req sum2 -H "Authorization: Bearer $T" "$API/api/analytics/summary")
  err=$(json_field "$TMP/sum2.body" error.code)
  [ "$code" = 401 ] && [ "$err" = invalid_token ] && ok "revocado, sin esperar: GET /api/analytics/summary 401 invalid_token" \
    || bad "revocado, sin esperar: GET /api/analytics/summary HTTP $code $err"
  code=$(req tally -H "Authorization: Bearer $T" -X POST "$API/api/tally/elections/${ELECTION:-1}")
  err=$(json_field "$TMP/tally.body" error.code)
  [ "$code" = 401 ] && [ "$err" = invalid_token ] && ok "revocado, sin esperar: POST /api/tally/elections/${ELECTION:-1} 401 invalid_token" \
    || bad "revocado: POST /api/tally HTTP $code $err"
  expect_not_forwarded "revocado: POST /api/tally" "$TMP/tally.hdr"
  # Y sigue rechazado cuando ya no queda nada en la caché (TTL vencido).
  sleep $((TTL_S + 1))
  code=$(req sum2b -H "Authorization: Bearer $T" "$API/api/analytics/summary")
  err=$(json_field "$TMP/sum2b.body" error.code)
  [ "$code" = 401 ] && [ "$err" = invalid_token ] && ok "revocado, tras ${TTL_S}+1 s: 401 invalid_token" \
    || bad "revocado, tras el TTL: HTTP $code $err"
fi

# --- 5. Desactivación ----------------------------------------------------------------
echo "5. Un usuario desactivado pierde el acceso sin esperar al exp del JWT"
if [ -z "$RP_ID" ]; then
  bad "no se creó $RP_USER: no se puede probar la desactivación"
else
  T2=$(login "$RP_USER" "$RP_PASSWORD")
  if [ -z "$T2" ]; then
    bad "login de $RP_USER"
  else
    code=$(req sum3 -H "Authorization: Bearer $T2" "$API/api/analytics/summary")
    [ "$code" = 200 ] && ok "$RP_USER activo: HTTP 200" || bad "$RP_USER activo: HTTP $code"
    code=$(req disable -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -X PATCH \
      "$API/api/auth/users/$RP_ID" -d '{"is_active":false}')
    [ "$code" = 200 ] && ok "PATCH /api/auth/users/$RP_ID {is_active:false} HTTP 200" || bad "PATCH usuario HTTP $code"
    code=$(req sum4 -H "Authorization: Bearer $T2" "$API/api/analytics/summary")
    [ "$code" = 401 ] && ok "desactivado, sin esperar: HTTP 401" || bad "desactivado, sin esperar: HTTP $code"
    expect_not_forwarded "desactivado: GET /api/analytics/summary" "$TMP/sum4.hdr"
    sleep $((TTL_S + 1))
    code=$(req sum5 -H "Authorization: Bearer $T2" "$API/api/analytics/summary")
    [ "$code" = 401 ] && ok "desactivado, tras ${TTL_S}+1 s: HTTP 401" || bad "desactivado, tras el TTL: HTTP $code"
  fi
fi

# --- 6. Ocultamiento de topología y tecnología -----------------------------------------
echo "6. Las respuestas no revelan servicios, hosts ni frameworks"
LEAKS='identity:|:8000|uvicorn|pydantic|starlette|errors\.pydantic|page not found|nginx|x-powered-by|"service"|"available"|"authMode"'
H=(-H "Authorization: Bearer $ADMIN")
probe() { # probe <nombre> <descripción> <tipo: ok|error|edge> <curl args...>
  # edge: error generado por el WAF (no llega al Gateway): no lleva X-Request-Id.
  local name="$1" desc="$2" kind="$3"
  shift 3
  local code
  code=$(req "$name" "$@")
  local leak
  leak=$(cat "$TMP/$name.hdr" "$TMP/$name.body" | grep -Eio "$LEAKS" | sort -u | tr '\n' ' ')
  local shape=1
  if [ "$kind" = error ] || [ "$kind" = edge ]; then
    python3 -c 'import json,sys
b = json.load(open(sys.argv[1]))
e = b.get("error")
sys.exit(0 if isinstance(e, str) or (isinstance(e, dict) and isinstance(e.get("code"), str) and "message" in e) else 1)' \
      "$TMP/$name.body" 2>/dev/null || shape=0
  fi
  local rid=1
  [ "$kind" = edge ] || grep -qi '^x-request-id:' "$TMP/$name.hdr" || rid=0
  local status_ok=1
  case "$kind:$code" in error:4??|error:5??|edge:4??|edge:5??|ok:*) ;; *) status_ok=0;; esac
  if [ -z "$leak" ] && [ "$shape" = 1 ] && [ "$rid" = 1 ] && [ "$status_ok" = 1 ]; then
    ok "$desc HTTP $code"
  else
    bad "$desc HTTP $code (fugas: ${leak:-ninguna}; formato de error: $shape; X-Request-Id: $rid)"
  fi
}
probe p_api      "GET /api (catálogo)"                         ok    "$API/api"
probe p_ready    "GET /readyz"                                 ok    "$API/readyz"
probe p_missing  "GET /api/no-existe"                          error "$API/api/no-existe"
probe p_delete   "DELETE /api/auth/users/1"                    error "${H[@]}" -X DELETE "$API/api/auth/users/1"
probe p_422      "POST /api/auth/login {\"username\":1}"       error -H 'Content-Type: application/json' -X POST "$API/api/auth/login" -d '{"username":1}'
probe p_results  "GET /api/ballots/elections/999999/results"   error "$API/api/ballots/elections/999999/results"
probe p_blind    "POST /api/identity/tokens/blind (vacío)"     error "${H[@]}" -H 'Content-Type: application/json' -X POST "$API/api/identity/tokens/blind" -d ''
# Errores que genera el propio WAF (nunca llegan al Gateway): página JSON, no la de nginx.
python3 -c 'import sys; sys.stdout.write("{\"x\":\"" + "a" * (2 * 1024 * 1024) + "\"}")' > "$TMP/big.json"
probe p_413      "WAF: cuerpo de 2 MB (límite 1 MB)"           edge  -H 'Content-Type: application/json' -X POST "$API/api/auth/login" --data-binary "@$TMP/big.json"
probe p_crs      "WAF: XSS bloqueado por CRS"                  edge  "$API/api/elections/open?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E"
probe p_crs_web  "WAF (web): XSS bloqueado por CRS"            edge  "${API%:*}:3000/?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E"
[ "$(cat "$TMP/p_crs.hdr" | head -1 | awk '{print $2}')" = 403 ] && ok "el WAF sigue bloqueando con 403" \
  || bad "la petición con XSS no recibió 403 del WAF"

# --- 7. Anonimato intacto -----------------------------------------------------------------
echo "7. La ruta de votación no pasa por la comprobación de sesión del Gateway"
# Solo se mide que el Gateway no aplica la sesión (no responde 401 invalid_token a un
# token revocado). Que Ballot no reciba Authorization ni x-user-id lo cubren las
# pruebas unitarias del Gateway ("la ruta de Ballot es anónima..." y "la papeleta no
# provoca consultas de sesión ni lleva el JWT"), no esta comprobación en vivo.
code=$(req ballot -H "Authorization: Bearer ${T:-x}" -H 'Content-Type: application/json' -X POST "$API/api/ballots" -d '{}')
err=$(json_field "$TMP/ballot.body" error)
# Ballot también usa el código "invalid_token" (400, token de voto inválido): lo que
# delata la comprobación de sesión del Gateway es el 401, no el código.
case "$code" in
  401) bad "POST /api/ballots: el Gateway aplicó la comprobación de sesión (401 $(json_field "$TMP/ballot.body" error.code))";;
  4??) ok "POST /api/ballots con un token revocado: HTTP $code de Ballot ($err), sin 401 de sesión del Gateway";;
  *) bad "POST /api/ballots con cuerpo inválido: HTTP $code";;
esac

# --- 8. Limpieza ----------------------------------------------------------------------------
echo
echo "Datos de prueba: el usuario $RP_USER${RP_ID:+ (id $RP_ID)} queda desactivado (identity no permite borrar)"
echo "y la elección ${ELECTION:-?} queda cerrada."
finish
