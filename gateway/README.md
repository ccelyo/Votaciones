# API Gateway (TypeScript)

Punto de entrada único de los clientes (Web SSR, App móvil y CLI) hacia los servicios
lógicos, según la vista C&C del prototipo 2 (`docs/entregables/P2/cc-view-p2.html`).
Responsabilidades: enrutamiento REST/JSON, validación de JWT, CORS y límites de tasa.
No contiene lógica de votación, identidad ni análisis.

Está escrito en TypeScript y se ejecuta directamente con Node ≥ 22.18 (eliminación de
tipos nativa), sin paso de compilación ni dependencias en tiempo de ejecución.

## Ejecutar

```bash
docker compose up --build            # desde la raíz: levanta todo el sistema
curl localhost:8088/api              # catálogo de rutas y servicios disponibles
curl localhost:8088/readyz           # salud de cada servicio configurado
```

Sin Docker:

```bash
pnpm install
GATEWAY_IDENTITY_URL=http://localhost:8000 pnpm start
pnpm test        # pruebas (node:test)
pnpm typecheck   # tsc --noEmit
```

## Catálogo de endpoints (CR-01)

La fuente de verdad es [`src/routes.ts`](src/routes.ts); `GET /api` lo devuelve en JSON.
Acceso: **public** sin token · **user** JWT válido · **admin** JWT con rol `admin` ·
**anonymous** ruta de votación sin credenciales.

| Método | Ruta pública | Servicio | Ruta del servicio | Acceso |
| --- | --- | --- | --- | --- |
| POST | `/api/auth/login` | Auth | `/login` | public |
| POST | `/api/auth/login/mfa` | Auth | `/login/mfa` | public |
| GET | `/api/auth/me` | Auth | `/auth/me` | user |
| POST | `/api/auth/logout` | Auth | `/logout` | user |
| GET | `/api/auth/users` | Auth | `/users` | admin |
| GET | `/api/elections/open` | Election | `/elections/open` | public |
| GET · POST | `/api/elections` | Election | `/elections` | admin |
| GET | `/api/elections/:id/parameters` | Election | `/elections/:id/parameters` | user |
| GET | `/api/elections/:id/status` | Election | `/elections/:id/status` | admin |
| POST | `/api/elections/:id/close` | Election | `/elections/:id/close` | admin |
| GET | `/api/identity/keys` | Identity | `/keys` | public |
| GET | `/api/identity/elections/:id/eligibility` | Identity | `/elections/:id/eligibility` | user |
| POST | `/api/identity/tokens/blind` | Identity | `/tokens/blind` | user |
| POST | `/api/identity/vote-confirmation` | Identity | `/vote-confirmation` | user |
| GET · POST | `/api/identity/elections/:id/voters` | Identity | `/elections/:id/voters` | admin |
| PATCH | `/api/identity/elections/:id/voters/:userId` | Identity | `/elections/:id/voters/:userId` | admin |
| POST | `/api/ballots` | Ballot | `/v1/ballots` | anonymous |
| GET | `/api/ballots/elections/:id/parameters` | Ballot | `/v1/elections/:id/parameters` | anonymous |
| GET | `/api/ballots/elections/:id/results` | Ballot | `/v1/elections/:id/results` | anonymous |
| POST | `/api/tally/elections/:id` | Tally | `/v1/tally/elections/:id` | admin · provisional |
| GET | `/api/tally/elections/:id` | Tally | `/v1/tally/elections/:id` | user · provisional |
| GET | `/api/analytics/summary` | Analytics | `/v1/analytics/summary` | user |
| GET | `/api/analytics/elections` | Analytics | `/v1/analytics/elections` | user |
| GET | `/api/analytics/elections/:id[/results\|/participation\|/turnout]` | Analytics | `/v1/analytics/elections/:id[...]` | user |
| POST | `/api/analytics/elections/:id/recompute` | Analytics | `/v1/analytics/elections/:id/recompute` | admin |
| GET | `/api/notifications` | Notifications | `/v1/notifications` | user · provisional |

- **Blind Signature no tiene ruta**: según la vista solo es accesible desde Identity.
- Las rutas **provisionales** dependen de contratos que Tally y Notifications aún no han
  publicado. Hay que confirmarlas con Sebastian y Camilo.
- Un servicio sin URL configurada responde `503 service_not_configured`.
- La consulta (`?limit=…`) se reenvía tal cual.

## Contrato JWT con Auth (CR-04 / JU-05)

Propuesta para acordar con Julian:

- Algoritmo **HS256** con un secreto compartido (`GATEWAY_JWT_SECRET` en el Gateway).
  Se rechaza cualquier otro `alg`, incluido `none`.
- Claims obligatorios: `sub` (id del usuario) y `exp`. Opcionales: `nbf`, `iss`
  (`GATEWAY_JWT_ISSUER`) y `aud` (`GATEWAY_JWT_AUDIENCE`); si están configurados en
  el Gateway, se exigen. Se toleran 30 s de desfase de reloj.
- Roles: `roles` (lista) o `role` (texto). `admin` habilita las rutas de administración.
- El token llega en `Authorization: Bearer <jwt>`. Con un token válido, el Gateway
  reenvía al servicio `Authorization`, `X-User-Id` y `X-User-Roles`. Las cabeceras
  `X-User-*` que envíe el cliente se descartan siempre.

**Modo de transición (`passthrough`)**: mientras Auth no emita JWT (hoy `identity`
emite sesiones opacas), el Gateway arranca en este modo si no hay `GATEWAY_JWT_SECRET`.
Exige un Bearer en las rutas `user` y `admin`, y es el servicio quien valida la sesión
y el rol. Cuando Auth emita JWT, basta con definir `GATEWAY_JWT_SECRET` para pasar al
modo `jwt`.

## Ruta anónima de votación

En las rutas `anonymous` (Ballot) el Gateway solo reenvía `Content-Type`, `Accept` y
`Accept-Language`. No reenvía `Authorization`, cookies, `X-Forwarded-For`, `User-Agent`,
`Referer` ni `X-Request-Id`, y no registra IP, cuerpo ni identificadores. Así Ballot no
puede vincular una papeleta con el votante. El Servidor SSR de la web aplica la misma
regla antes de llegar al Gateway.

## Otras protecciones

- **CORS**: solo los orígenes de `GATEWAY_ALLOWED_ORIGINS` reciben
  `Access-Control-Allow-Origin`, sin credenciales (la autenticación va en la cabecera
  `Authorization`, no en cookies). La web no lo necesita porque llama al Gateway desde su
  servidor; está para clientes de navegador que llamen directamente.
- **Límites de tasa** por cliente y minuto: `login` 20, `default` 300, `ballot` 600.
  Responde `429` con `Retry-After`. La cuota es por IP de origen; detrás del Servidor SSR
  todas las peticiones de la web comparten la IP del contenedor, salvo que un proxy de
  borde envíe `X-Forwarded-For` (`GATEWAY_TRUST_FORWARDED_FOR=true`). Las papeletas nunca
  llevan la IP del votante, así que su cuota es compartida y más alta.
- Tiempo máximo por servicio (`504`), servicio caído (`502`), cuerpo máximo de 1 MiB
  (`413`), método no permitido (`405` con `Allow`). Las cookies que fije un servicio no
  se reenvían.
- Errores propios del Gateway: `{"error": {"code": "...", "message": "..."}}`.

## Configuración

| Variable | Por defecto | Uso |
| --- | --- | --- |
| `GATEWAY_PORT` | `8088` | Puerto HTTP |
| `GATEWAY_AUTH_URL` … `GATEWAY_NOTIFICATIONS_URL` | — | URL base de cada servicio: `AUTH`, `ELECTION`, `IDENTITY`, `BALLOT`, `TALLY`, `ANALYTICS`, `NOTIFICATIONS` |
| `GATEWAY_AUTH_MODE` | `jwt` si hay secreto, si no `passthrough` | Modo de autenticación |
| `GATEWAY_JWT_SECRET` · `_ISSUER` · `_AUDIENCE` | — | Validación del JWT |
| `GATEWAY_ALLOWED_ORIGINS` | — | Orígenes CORS, separados por coma |
| `GATEWAY_RATE_LIMIT_LOGIN` · `_DEFAULT` · `_BALLOT` | `20` · `300` · `600` | Peticiones por minuto (`0` desactiva) |
| `GATEWAY_TRUST_FORWARDED_FOR` | `false` | Usar `X-Forwarded-For` como IP del cliente |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | `10000` | Tiempo máximo por petición al servicio |
| `GATEWAY_MAX_BODY_BYTES` | `1048576` | Tamaño máximo del cuerpo |

En `docker-compose.yml`, Auth y Election apuntan por ahora a `identity`, que todavía
contiene esas funciones. Cuando Julian y Fabian separen sus servicios, solo cambian
`GATEWAY_AUTH_URL` y `GATEWAY_ELECTION_URL`, sin tocar los clientes.

| Módulo | Responsabilidad |
| --- | --- |
| `src/routes.ts` | Catálogo de rutas, acceso y cuotas |
| `src/router.ts` | Coincidencia de rutas y construcción de la ruta del servicio |
| `src/jwt.ts` | Validación HS256 |
| `src/rateLimit.ts` | Ventana fija por cliente y cuota |
| `src/config.ts` | Variables de entorno |
| `src/app.ts` | CORS, autenticación, reenvío y errores |
| `src/server.ts` | Servidor HTTP |
