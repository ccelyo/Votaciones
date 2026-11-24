# Prototipo 3 — Resultados de las pruebas

Equipo **2c** · Sistema **espivota** · Atributo de calidad: **Seguridad**

Todas las pruebas se ejecutaron en vivo sobre el despliegue completo del
prototipo 3 (`docker compose up -d --build`, Docker 28.3.3, un host). Las salidas
completas están en [`evidencias/`](./evidencias/).

## Resumen

| # | Escenario | Patrón | Tácticas | Prueba | Resultado |
|---|---|---|---|---|---|
| 1 | Conexión interceptada o par sin certificado válido | Secure Channel | Cifrar el canal; autenticar a los pares (mTLS) | Sondas TLS/mTLS desde el WAF y el host | 4/4 conexiones inválidas rechazadas; 2/2 válidas aceptadas; TLS 1.3 en el borde |
| 2 | Token revocado o usuario desactivado; operaciones de la CLI; reconocimiento de la topología | Reverse Proxy | Autorizar actores (mediación completa); limitar el acceso; limitar la exposición | `verify-reverse-proxy.sh` | **56/56** |
| 3 | Atacante que intenta alcanzar servicios, bases o el broker sin pasar por el borde | Network Segmentation | Limitar la exposición; limitar el acceso; separar entidades; detectar intrusiones | `verify-segmentation.sh` (`RESTART_TEST=1`) | **174/174** |
| 4 | Petición con SQLi, XSS, LFI, RCE, Log4Shell o firma de escáner | Web Application Firewall | Detectar intrusiones; validar la entrada; mantener un registro de auditoría | `verify-waf.sh` | **25/25** (16 ataques bloqueados, 9 legítimas permitidas) |
| 5 | Votante que intenta una operación administrativa | RBAC | Autorizar actores; mínimo privilegio | `rbac_live.py` | **7/7** |
| — | Flujo de voto completo a través de todos los controles | — | — | `e2e_vote.py` | Correcto: voto, recibo, reenvío idempotente, cierre y escrutinio |

## Escenario 1: Secure Channel

| Prueba | Esperado | Resultado |
|---|---|---|
| Cliente → WAF (`:8088`) con la autoridad de certificación local | TLS verificado | TLS 1.3, `Verify return code: 0 (ok)` |
| Cliente → WAF por HTTP plano | Rechazo | 400 |
| WAF → Gateway con certificado de cliente | 200 | 200 |
| WAF → Gateway sin certificado de cliente | Rechazo | Handshake rechazado |
| WAF → Gateway por HTTP plano | Rechazo | Conexión rechazada |
| WAF → Gateway sin confiar en la autoridad de certificación | Rechazo | Certificado no verificado |
| WAF → Platform con / sin certificado de cliente | 200 / rechazo | 200 / handshake rechazado |
| Identity → Ballot por gRPC con mTLS | Funciona | El flujo de voto emite y recibe la papeleta |

Pruebas unitarias: Gateway 96/96, Identity 144/144 y CLI 29/29.

## Escenario 2: Reverse Proxy

| Prueba | Resultado |
|---|---|
| Solo `waf` (3000, 8088) y `mobile` (8092) publican puertos; ningún servicio interno es alcanzable desde el host | 17/17 |
| 10 operaciones de la CLI de administración por WAF → Gateway (`/api/...`), incluidas `users create` y `elections open` | 10/10 |
| Token revocado: 401 de inmediato y tras 6 s, sin reenvío al servicio (log del Gateway: `forwarded=false`) | 6/6 |
| Usuario desactivado: 401 de inmediato y tras 6 s, sin reenvío al servicio | 5/5 |
| Las respuestas (catálogo, salud, 404, 405, 422, 413 y 403) no revelan servicios, hosts ni frameworks | 11/11 |
| La ruta de votación no pasa por la comprobación de sesión | 1/1 |
| Configuración de la sesión en el Gateway y la CLI sin rutas internas (estático) | 6/6 |
| **Total** | **56/56** |

**Corrección hecha durante la prueba.** El 413 del WAF (cuerpo mayor de 1 MB)
devolvía la página HTML de nginx. Se corrigió en
`waf/nginx/templates/conf.d/default.conf.template` con `client_max_body_size 0`
en la ubicación interna de error. Después se repitieron las pruebas de los
escenarios 2 y 4.

## Escenario 3: Network Segmentation

| Prueba | Resultado |
|---|---|
| Conexiones laterales no autorizadas descartadas por las ACL | 65/65 |
| Escaneo `nmap` de 37 IP internas | 479 de 481 puertos `filtered`; los 2 abiertos son la entrada del WAF |
| Flujos legítimos de la tabla de dependencias (con mTLS donde aplica) | 22/22 permitidos |
| Intentos denegados registrados en el log de cada sidecar | 8/8 |
| ACL reaplicada tras reiniciar Ballot | 1 s |
| **Total** | **174/174** |

## Escenario 4: Web Application Firewall

| Prueba | Resultado |
|---|---|
| Ataques bloqueados con 403 (SQLi, XSS, LFI, RCE, Log4Shell, escáneres, SSRF) | 16/16 |
| Peticiones legítimas permitidas | 9/9 |
| Bloqueo registrado en el audit log con IDs de reglas (ej. XSS: 941100, 941110, 941160, 941390, 949110) | Sí |
| Respuesta de bloqueo sin revelar el servidor | `{"error":{"code":"forbidden",...}}` |

## Escenario 5: RBAC

| Actor | Operación | Esperado | Resultado |
|---|---|---|---|
| Votante | `GET /api/auth/users` | 403 | 403 |
| Votante | `POST /api/elections` | 403 | 403 |
| Votante | `POST /api/auth/users` | 403 | 403 |
| Votante | `POST /api/tally/elections/1` | 403 | 403 |
| Votante | `GET /api/elections/open` | 200 | 200 |
| Sin token | `GET /api/auth/users` | 401 | 401 |
| Administrador | `GET /api/auth/users` | 200 | 200 |

## Procedimiento para reproducir

```bash
docker compose build gateway-fw      # la imagen netfw una sola vez (evita una carrera al construir los 10 sidecars)
docker compose up -d --build
export VOTACIONES_TLS_CA_FILE=$PWD/.dev-certs/ca-public/ca.crt
bash docs/p3-waf/verify-waf.sh
RESTART_TEST=1 bash docs/p3-network-segmentation/verify-segmentation.sh
bash docs/p3-reverse-proxy/verify-reverse-proxy.sh
CA=$VOTACIONES_TLS_CA_FILE python3 docs/entregables/P3/evidencias/rbac_live.py
identity/.venv/bin/python docs/demo/e2e_vote.py   # requiere el paquete cryptography
```

Los puertos 3000 y 8088 del host deben estar libres.

## Limitaciones

- Fuera del canal mTLS quedan Identity → Blind Signature (HTTP con token
  interno), AMQP hacia RabbitMQ y las bases de datos. Todos van por redes
  internas aisladas (escenario 3).
- La latencia adicional del WAF (~5 ms) se midió antes de activar TLS y no se
  repitió.
