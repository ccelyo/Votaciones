# Escenario de seguridad 2 — Reverse Proxy (Prototipo 3)

El API Gateway (`gateway/`), detrás del WAF, pasa a ser el **reverse proxy de
aplicación** del sistema: el único intermediario entre los clientes externos (web, app
móvil y CLI de administración) y los servicios. Escenario de calidad y patrón:
[`docs/entregables/P3/p3_2c.md`](../entregables/P3/p3_2c.md#escenario-2-reverse-proxy).

Este escenario resuelve los dos pendientes que el escenario 5 (RBAC) dejó abiertos:

1. El Gateway validaba el JWT sin estado y aceptaba tokens revocados (`POST /logout`) o
   de usuarios desactivados hasta su `exp` (1 h). Tally y Analytics no revalidan la
   sesión, así que esos tokens seguían sirviendo contra ellos.
2. `POST /users`, `PATCH /users/{id}` y `POST /elections/{id}/open` existían en Identity
   pero no en el catálogo del Gateway, y la CLI de administración los llamaba
   directamente sobre Identity (rutas sin `/api`), saltándose el WAF y el Gateway.

## Qué cambió

| # | Cambio | Archivos | Motivo |
|---|---|---|---|
| 1 | Tres rutas nuevas en el catálogo, con acceso `admin`: `POST /api/auth/users`, `PATCH /api/auth/users/:userId`, `POST /api/elections/:electionId/open` | `gateway/src/routes.ts` | Sin ellas la CLI solo funcionaba contra Identity directamente |
| 2 | **Mediación completa**: antes de reenviar una ruta `user` o `admin`, el Gateway consulta `GET /auth/me` en Identity (mTLS) y usa el rol vigente en la base de datos. Caché de 5 s por `sha256(token)`, nunca más allá del `exp`; se invalida al instante tras `logout` o `PATCH` de usuario | `gateway/src/session.ts` (nuevo), `app.ts`, `config.ts`, `jwt.ts`, `docker-compose.yml` | El JWT por sí solo no refleja la revocación ni la desactivación |
| 3 | La CLI usa solo rutas `/api/...` del Gateway; `ApiClient` rechaza cualquier otra | `admin-cli/src/main/...` | La CLI deja de depender de rutas internas |
| 4 | Respuestas saneadas: 5xx genérico, 4xx reconstruidos (solo código, mensaje de texto y `requestId`), `Location` filtrado, catálogo y `/readyz` sin topología (y `/readyz` con caché de 2 s), mensajes sin nombre de servicio, `X-Request-Id` en toda respuesta (expuesto por CORS) y `forwarded: true\|false` en la línea de acceso del log | `gateway/src/app.ts` | El proxy filtraba servicios, hosts, frameworks y estado interno |
| 5 | (Opcional, P2) `X-Powered-By` oculto en el WAF y en Next.js; errores propios del WAF (403 de CRS, 413, 502/504…) como JSON sin la página de nginx; Identity deja de reenviar el `detail` de Blind Signature; platform reenvía `X-Request-Id` | `waf/nginx/templates/conf.d/default.conf.template`, `platform/next.config.ts`, `platform/app/api/[...path]/route.ts`, `identity/app/clients/blind_signature.py` | Defensa en profundidad en el borde y en el origen |
| 6 | Nuevo `verify-reverse-proxy.sh` (modo `--static` y en vivo) | `docs/p3-reverse-proxy/` | Medida del escenario |

## Diseño

```text
 Cliente (web, app, CLI)
        │ HTTPS
        ▼
 ┌──────────────┐   inspecciona contenido (escenario 4)
 │ WAF (borde)  │
 └──────┬───────┘ mTLS
        ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ API Gateway = reverse proxy de aplicación (escenario 2)         │
 │  1. allowlist de rutas (catálogo)       → 404/405               │
 │  2. JWT RS256 (firma, iss, aud, exp)    → 401                   │
 │  3. sesión vigente en Identity ──────── GET /auth/me (mTLS) ─┐  │
 │     caché ≤ 5 s, invalidación en logout/PATCH  → 401 / 503   │  │
 │  4. rol vigente (BD de Identity)        → 403                │  │
 │  5. reenvío mTLS con cabeceras de la allowlist               │  │
 │  6. saneo de la respuesta (5xx, 4xx, Location, cabeceras)    │  │
 └───────┬───────────────┬───────────────┬──────────────────────┼──┘
         ▼               ▼               ▼                      ▼
     Ballot          Tally / Analytics  Notification         Identity
  (anónima: sin JWT                                     (Auth, Election,
   ni consulta de sesión)                                 padrón)
```

Diferencia con los otros escenarios: el WAF (4) inspecciona **contenido**; la
segmentación (3) restringe **conectividad L3/L4**; el reverse proxy (2) controla **qué
operaciones existen hacia afuera, quién las ejecuta en este instante y qué se revela de
los servidores internos**.

### Tácticas

- **Autorizar actores (mediación completa)**: cada petición autenticada se revalida contra
  la sesión vigente (revocación, `is_active`, rol actual). El rol que decide `admin` es el
  de Identity, no el claim.
- **Limitar el acceso**: el catálogo del Gateway es el único camino; las operaciones
  administrativas que faltaban entran con `access: "admin"` y la CLI deja de usar rutas
  internas.
- **Limitar la exposición (capa de aplicación)**: catálogo y `/readyz` depurados, errores
  normalizados, `Location` filtrado, mensajes sin nombre de servicio.
- **No confiar en el cliente ni en el upstream**: el Gateway sanea en los dos sentidos.
- **Registro de auditoría**: `X-Request-Id` en cada respuesta; el log del Gateway guarda el
  servicio, el estado del upstream y el detalle que se oculta al cliente.

### Comportamiento

| Situación | Respuesta del Gateway | ¿Llega al servicio? |
|---|---|---|
| Token revocado o usuario desactivado (Identity responde 401/403 en `/auth/me`) | `401 invalid_token` | No |
| Claim `role=admin` pero Identity dice `voter`, ruta `admin` | `403 forbidden` | No |
| Identity no responde a la consulta de sesión | `503 auth_unavailable` (falla cerrado) | No |
| Ruta `public` o `anonymous` (Ballot) | Sin consulta de sesión | Sí, sin JWT hacia Ballot |
| Servicio responde 5xx (incluso con código acordado, p. ej. `ballot_unavailable` de Identity) | `502` (o `503`/`504`) `upstream_error`, cuerpo descartado; el código original queda en el log | — |
| Servicio responde 4xx con `{"error":"<código>"}` | `{"error":"<código>","requestId":"..."}`; cualquier otro campo se descarta | — |
| Servicio responde 4xx con `{"error":{"code":...}}` | `{"error":{"code","message","requestId"}}` (`message` solo si es texto); el resto se descarta | — |
| Servicio responde 4xx con otro formato (422 de validación, `404 page not found`, HTML) | Mismo estado, `{"error":{"code","message","requestId"}}` | — |
| `Location` absoluta o fuera de `/api/` | Se descarta (y se registra) | — |

La caché es local a cada réplica del Gateway. En la réplica que atiende el `logout` o la
desactivación, el efecto es inmediato; en las demás, como mucho
`GATEWAY_SESSION_CACHE_TTL_MS` (5 s). Una consulta a `/auth/me` que estaba en vuelo cuando
llegó la invalidación no guarda su resultado (contador de generación en `session.ts`), y
tras un `PATCH` se invalida el id que devuelve Identity en el cuerpo, no el texto de la
ruta (`/users/05` es el usuario 5).

Cada línea de acceso del log del Gateway lleva `forwarded`: `false` si la petición se
rechazó antes de salir hacia el servicio. Es la evidencia en vivo de "sin llegar al servicio".

## Uso

Sin daemon de Docker (revisa `docker-compose.yml`, los literales de ruta de la CLI y, si
hay `java`, ejecuta las dos pruebas de rutas de `AdminCliTest`):

```bash
bash docs/p3-reverse-proxy/verify-reverse-proxy.sh --static
bash docs/p3-reverse-proxy/verify-reverse-proxy.sh --selftest   # lectura del log con líneas sintéticas
```

Con el stack levantado:

```bash
docker compose up -d --build
(cd admin-cli && ./mvnw -q package)        # opcional: usa la CLI real
export VOTACIONES_TLS_CA_FILE=.dev-certs/ca-public/ca.crt
bash docs/p3-reverse-proxy/verify-reverse-proxy.sh            # API por defecto: https://localhost:8088
```

El modo en vivo inicia sesión 3 veces (por debajo del límite `login` de 20/min), crea el
usuario `rp-<timestamp>` (administrador) y una urna de prueba. Identity no permite borrar
usuarios, así que el usuario queda **desactivado** y la urna **cerrada**.

Pruebas unitarias (sin Docker):

```bash
cd gateway && pnpm test && pnpm typecheck
cd admin-cli && ./mvnw test
```

## Resultados

### Pruebas unitarias y estáticas (ejecutadas)

| Comprobación | Resultado |
|---|---|
| `gateway`: `pnpm test` (node:test) | 96 pruebas, 96 correctas (antes del escenario: 47) |
| `gateway`: `pnpm typecheck` | Sin errores |
| `admin-cli`: `./mvnw test` | 29 pruebas, 29 correctas (antes: 27) |
| `identity`: `pytest` | 144 correctas (tras el cambio opcional de `blind_signature.py`) |
| `docker compose config --quiet` | Válido |
| `verify-reverse-proxy.sh --static` | 17 correctos, 0 fallidos (con `java` y la caché de Maven; sin `java` son 16 y un aviso, y con `mvnw -o` sin caché la prueba de la CLI falla) |
| `verify-reverse-proxy.sh --selftest` | 5 correctos, 0 fallidos |
| `platform`: `tsc --noEmit` | Sin errores en `route.ts`; 1 error previo ajeno (`lib/server/secure-fetch.ts`: falta `undici` en `node_modules`) |
| Plantilla del WAF | **No validada** con `nginx -t` (no hay nginx ni Docker en la máquina) |

```
$ bash docs/p3-reverse-proxy/verify-reverse-proxy.sh --static
Reverse Proxy · modo estático (sin daemon de Docker)

Estático 1. Solo el WAF y mobile publican puertos (docker compose config)
  ✔ waf publica ['3000', '8088'] (esperado ['3000', '8088'])
  ✔ mobile publica ['8092'] (esperado ['8092'])
  ✔ identity sin puertos en el host
  ✔ gateway sin puertos en el host
  ✔ platform sin puertos en el host
  ✔ ballot sin puertos en el host
  ✔ tally sin puertos en el host
  ✔ analytics sin puertos en el host
  ✔ blind-signature sin puertos en el host
  ✔ election sin puertos en el host
  ✔ ningún otro servicio publica puertos
Estático 2. El Gateway comprueba la sesión en identity
  ✔ GATEWAY_SESSION_CHECK=identity
  ✔ GATEWAY_AUTH_URL=https://identity:8000 (mTLS hacia identity)
  ✔ GATEWAY_SESSION_CACHE_TTL_MS=5000
Estático 3. La CLI no usa rutas internas de los servicios
  ✔ todos los literales de ruta de admin-cli/src/main son /api/... o sufijos conocidos
  ✔ ApiClient.send() valida cada ruta con requireCatalogPath
  ✔ pruebas de la CLI: todos los comandos piden solo /api/ y ApiClient rechaza rutas internas

Resultado: 17 correctos, 0 fallidos.
```

Lo que cubren las pruebas unitarias del Gateway para este escenario:

- `test/session.test.ts`: caché dentro y fuera del TTL, límite por `exp`, 401/403 →
  revocada sin guardar, red caída o 5xx → no disponible, `id` distinto del `sub`,
  `invalidateToken`, `invalidateUser`, expulsión por `maxEntries` y una invalidación
  durante una consulta en vuelo (no se cachea).
- `test/gateway.test.ts`, con un Identity falso: token revocado y usuario desactivado → 401
  con 0 peticiones al servicio; claim `admin` con rol `voter` en Identity → 403; Identity
  caído → 503; una sola consulta para dos peticiones; `logout` y `PATCH` de usuario
  invalidan la caché, también con un id no canónico (`/users/0042`, con o sin `id` en la
  respuesta); `forwarded` en la línea de acceso; la papeleta no consulta la sesión ni lleva
  `authorization`; rutas nuevas (403 al votante, reenvío del administrador, `DELETE` → 405
  `Allow: PATCH`); normalización (500 → 502 con `requestId`, 503 sin "blind", 422 de
  pydantic, `404 page not found`, código de Ballot conservado, campos adicionales de un
  4xx descartados, `Location`, catálogo, `/readyz` y su caché); CORS expone `X-Request-Id`.
- `test/cli-catalog.test.ts`: cada operación de la CLI está en el catálogo y el código de la
  CLI no contiene rutas internas.
- `AdminCliTest`: todos los comandos (incluidos `users create/disable/enable` y
  `elections open`) solo hacen peticiones a `/api/...`; `ApiClient` rechaza rutas sin
  `/api/` o con segmentos `..`/`.` (también como `%2e`), `%2f`, `\` o `//`.

### En vivo (pendiente)

Docker no estaba disponible al implementar el escenario, así que el modo en vivo de
`verify-reverse-proxy.sh` **no se ha ejecutado**. Al ejecutarlo debe dar N de N correctos
(17 estáticas + unas 35 en vivo, según si la CLI está compilada) y 0 fallidos:

1. Los puertos de los servicios (8000, 8001, 8080, 8090, 8100) cerrados en el host.
2. Login de administrador por `/api/auth/login` + `/api/auth/login/mfa`.
3. CLI real (o `curl` equivalente): `whoami`, `users list`, `users create`, `elections
   list/create/open/status/close` y `voters list`, todas con salida 0.
4. Token revocado: **inmediatamente** después del `logout`, `GET /api/analytics/summary`
   y `POST /api/tally/elections/:id` → `401 invalid_token`, y la línea de acceso del
   Gateway para ese `requestId` tiene `forwarded=false` (si el log no se puede leer o no
   aparece la línea, la comprobación falla). Tras `TTL + 1 s`, sigue en 401.
5. Usuario desactivado: `401` inmediatamente después del `PATCH` (con `forwarded=false`
   en el log) y tras `TTL + 1 s`.
6. Ocultamiento: `GET /api`, `/readyz`, `/api/no-existe`, `DELETE /api/auth/users/1`, el
   422 de login, `GET /api/ballots/elections/999999/results` y `POST
   /api/identity/tokens/blind` vacío, sin `identity:`, `:8000`, `uvicorn`, `pydantic`,
   `starlette`, `page not found`, `nginx`, `X-Powered-By` ni claves `service`, con formato
   de error acordado y `X-Request-Id`. Además, errores que genera el propio WAF: cuerpo
   de 2 MB, XSS bloqueado por CRS en `:8088` y en `:3000` → JSON sin `nginx` (sin
   `X-Request-Id`, porque no llegan al Gateway), y el XSS sigue recibiendo 403.
7. La votación no pasa por la comprobación de sesión del Gateway: `POST /api/ballots` con
   un token revocado y cuerpo inválido → 4xx de Ballot, no `401 invalid_token`. Que Ballot
   no reciba `Authorization` ni `x-user-*` no se mide en vivo; lo cubren las pruebas
   unitarias del Gateway.

## Hallazgos durante la implementación

- La CLI no funcionaba contra el Gateway: llamaba a `/login`, `/users`, `/elections/...`
  (rutas de Identity) sobre `https://localhost:8088`, que responde 404 a todo lo que no
  esté en el catálogo. Solo funcionaba apuntando a Identity directamente.
- El padrón vive bajo `/api/identity/elections/:id/voters`, no bajo
  `/api/elections/...`: la CLI necesita dos constructores de ruta distintos.
- La descripción pública de `POST /api/identity/tokens/blind` nombraba un servicio
  interno ("Identity → Blind Signature"); se cambió a "Firma ciega del token de voto".
- Ballot responde sus 4xx como `{"error":"<código>"}` y `platform/lib/m4/api.ts` decide
  con esos códigos (`token_already_spent`, `election_not_open`…). La normalización
  conserva `error` como cadena y solo añade `requestId` al nivel superior; una prueba lo fija.
- `/healthz` y el SAN `DNS:gateway` (en `server.ts`) se mantienen: el healthcheck del
  contenedor llama a `/healthz` con el certificado del propio Gateway.

## Limitaciones

- **Rendimiento**: cada token añade una llamada mTLS a Identity cada 5 s como mucho. Los
  votantes en la ruta anónima no se ven afectados. **No está medido**: el escenario k6 del
  laboratorio de rendimiento solo llama a `GET /api/auth/me`, que se exime de la consulta
  de sesión, así que sus cifras no incluyen la ida y vuelta extra; hace falta un escenario
  sobre una ruta mediada (p. ej. `GET /api/analytics/summary`).
- **Disponibilidad**: falla cerrado. Si Identity cae, todas las rutas `user`/`admin`
  responden 503 (antes solo dependían del JWKS en caché). Votar no se ve afectado.
- **Ventana residual**: la caché es en memoria por proceso. Con más de una réplica del
  Gateway, una revocación tarda hasta el TTL completo (5 s) en las otras réplicas.
- **Compatibilidad** (cambios visibles para los clientes):
  - un cliente que leyera el `detail` del 422 recibe ahora `error.message` genérico.
    Platform (`lib/api.ts`) y mobile (`gateway.dart`) ya usan `error.message` como
    alternativa;
  - los 5xx con código propio de Identity (`ballot_unavailable`,
    `blind_signature_unavailable`, p. ej. en un `elections close` parcial) llegan como
    `502 upstream_error`: el cliente ya no distingue qué servicio falló (sus códigos nombran
    servicios internos). El código original queda en el log del Gateway con el mismo
    `requestId`. Ningún cliente del repositorio decide con esos códigos;
  - los 4xx llevan `requestId` y pierden cualquier campo fuera de `code`/`message`.
- `GATEWAY_SESSION_CHECK` vale `off` por defecto (pruebas y desarrollo); Compose lo fija en
  `identity` y el modo `--static` del script lo comprueba.
- `GATEWAY_ELECTION_URL` sigue apuntando a Identity (Election aún vive allí).
- Las páginas de error propias del WAF (403 de ModSecurity, 413, 502/504…) ahora son JSON
  (`error_page` + `location = /__edge_error.json`), pero la plantilla **no se ha validado**
  con `nginx -t` ni en vivo. `/readyz` sigue siendo público (lo usan `gateway/README.md` y
  el despliegue de rendimiento); para limitar el abuso, el Gateway reutiliza su resultado
  2 s y agrupa las consultas simultáneas.
- `docs/demo/cli_demo.sh` sigue usando `http://localhost:8000` (Identity directo) y queda
  obsoleto: debe apuntar a `https://localhost:8088`.
