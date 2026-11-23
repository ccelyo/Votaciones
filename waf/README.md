# WAF de borde (escenario de seguridad 4, Prototipo 3)

Web Application Firewall delante de la Web SSR y del API Gateway. Inspecciona cada
petición HTTP externa con **ModSecurity v3 + OWASP Core Rule Set 4.25 LTS** y bloquea
con `403` las maliciosas (SQLi, XSS, *path traversal*, inyección de comandos,
Log4Shell, escáneres…) antes de que lleguen a los servicios.

Usa la imagen oficial `owasp/modsecurity-crs` (tag fijado en `docker-compose.yml`).
En este directorio solo está la configuración propia del proyecto.

| Puerto del host | Entrada del WAF | Servicio interno |
|---|---|---|
| `${WEB_PORT:-3000}` | `:8080` | `platform:3000` (Web SSR) |
| `${GATEWAY_PORT:-8088}` | `:8088` | `gateway:8088` (API Gateway) |

`platform` y `gateway` ya no publican puertos: solo se llega a ellos a través del WAF.

## Archivos

- `nginx/templates/conf.d/default.conf.template`: reemplaza la plantilla de la imagen,
  que solo admite un *backend*, con dos `server` (web y API). Sobrescribe `X-Forwarded-For`
  con la IP real del cliente (el Gateway la usa para el límite de tasa), limita el cuerpo
  a 1 MB y da 90 s de *timeout* (el escrutinio síncrono de Tally puede tardar hasta 70 s).
- `rules/REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf`: exclusiones propias, cargadas antes
  del CRS. Hoy está vacía porque el flujo completo de voto pasa sin falsos positivos.
  Cada exclusión futura debe indicar el ID de la regla y el falso positivo que corrige.

## Configuración (variables del servicio `waf`)

| Variable | Valor | Efecto |
|---|---|---|
| `MODSEC_RULE_ENGINE` | `On` (`WAF_RULE_ENGINE`) | `DetectionOnly` registra sin bloquear, útil para afinar |
| `BLOCKING_PARANOIA` | `1` | Nivel recomendado para producción (pocos falsos positivos) |
| `ANOMALY_INBOUND` / `ANOMALY_OUTBOUND` | `5` / `4` | Umbral de la puntuación de anomalía; una regla crítica suma 5 |
| `ALLOWED_METHODS` | `GET HEAD POST OPTIONS PUT PATCH DELETE` | Métodos que usa la API |
| `MODSEC_AUDIT_LOG` | `/dev/stdout` (JSON) | Cada bloqueo se registra en `docker compose logs waf` |

## Validar

```bash
docker compose up -d --build
bash docs/p3-waf/verify-waf.sh     # 16 ataques → 403, 9 peticiones legítimas → pasan
python3 docs/demo/e2e_vote.py      # flujo de voto completo a través del WAF
```

Para ver qué reglas bloquearon una petición:

```bash
docker compose logs --no-log-prefix waf | grep '^{"transaction' | \
  python3 -c 'import sys,json
for l in sys.stdin:
    t=json.loads(l)["transaction"]
    print(t["response"]["http_code"], t["request"]["uri"], [m["details"]["ruleId"] for m in t["messages"]])'
```

## Pruebas de desempeño

Todas las VUs de k6 salen de la misma IP. Hay que desactivar el límite de tasa del
Gateway (`docs/lab6-performance/docker-compose.perf.yml`); el WAF no bloquea a k6.

## Segmentación de red

El WAF está solo en `edge-net` (la única red de borde que publica puertos) y en dos redes
internas propias: `waf-web-net` con `platform` y `waf-api-net` con `gateway`. No alcanza
ningún otro servicio ni base de datos. Ver `docs/lab5-network-segmentation/README.md`.
