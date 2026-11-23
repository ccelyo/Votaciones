# Escenario 5: Control de acceso basado en roles (RBAC)

**Responsable:** Kevin David Rodriguez Riveros · **Componente:** `identity/` (Auth + Identity) · **Rama:** `feat/p3-rbac`

## A. Identificación del escenario

| Elemento | Valor |
|---|---|
| Escenario | 5 — Autorización de operaciones administrativas |
| Atributo de calidad | Seguridad |
| Patrón | *Role-Based Access Control* (RBAC) |
| Táctica | *Authorize Actors* (categoría *Resist Attacks*) |
| Propiedades protegidas | Integridad del padrón electoral, de los usuarios y del ciclo de vida de las urnas; confidencialidad del padrón y del directorio de usuarios |

El sistema separa dos zonas: Identity conoce al votante y Ballot recibe la papeleta sin saber quién la emite. Este escenario solo trata la primera. Su objetivo es que un actor ya autenticado únicamente ejecute las operaciones que le corresponden a su rol.

## B. Escenario de calidad

| Parte | Descripción |
|---|---|
| **Fuente del estímulo** | Un usuario interno con cuenta válida y rol `voter`, que ya inició sesión con contraseña y MFA y tiene un JWT RS256 vigente. |
| **Estímulo** | Intenta una operación administrativa sobre el padrón: consultarlo (`GET /elections/{id}/voters`), inscribirse (`POST /elections/{id}/voters`) o cambiar la elegibilidad de otro votante (`PATCH /elections/{id}/voters/{user_id}`). Variantes: alterar el claim `role` del token, añadir cabeceras `X-User-Roles: admin` o `X-Dev-Roles: admin`, o usar un rol que no existe en el catálogo. |
| **Artefacto** | El servicio Identity, en concreto la capa de autorización (`core/auth.py`, `core/permissions.py`) que protege las rutas de `api/routes.py`, y los datos de Census y de la base de Auth. |
| **Entorno** | Operación normal, con la autenticación de desarrollo desactivada (`IDENTITY_DEV_AUTH=false`). La petición puede llegar por el camino WAF → Gateway → Identity o directamente a Identity desde la red interna. |
| **Respuesta** | Identity autentica al actor, obtiene su rol desde la base de datos y comprueba que ese rol tenga el permiso de la ruta (`census:read` o `census:write`). Como el rol `voter` no lo tiene, responde `403 forbidden` sin ejecutar la operación. Si el token no es válido o la sesión fue revocada, responde `401 unauthenticated`. |
| **Medida de la respuesta** | El 100 % de las 11 operaciones administrativas intentadas por un votante se rechazan con 403. Las 15 rutas protegidas sin token responden 401. Tras los intentos denegados, el padrón, los usuarios, las urnas y las credenciales emitidas quedan idénticos y Ballot no recibe ninguna orden. Todo esto lo verifican pruebas automatizadas (sección G). |

## C. Problema en la implementación del Prototipo 2

En P2 la autorización de Identity era una sola dependencia, `require_admin`, que comprobaba si el rol del usuario era `admin`. Funcionaba, pero tenía cuatro limitaciones:

1. **No había permisos granulares.** Gestionar usuarios, modificar el padrón y cerrar una urna exigían la misma condición: ser admin. La política no tenía nombre propio ni podía revisarse por operación.
2. **El rol se comparaba dentro del código de autenticación** y no en un catálogo central, así que no había un único lugar donde leer o auditar qué puede hacer cada rol. Además, la lista de roles asignables estaba duplicada en `services/users.py`.
3. **Las operaciones del votante solo exigían una sesión cualquiera.** `/tokens/blind`, `/vote-confirmation`, `/eligibility` y `/parameters` aceptaban cualquier rol autenticado, incluido uno que no existiera en el modelo, en vez de denegar por defecto.
4. **Nada verificaba que todas las rutas estuvieran clasificadas.** Una ruta nueva podía quedar sin protección sin que ninguna prueba lo detectara.

## D. Decisión arquitectónica

Se pasó de "comprobar un rol" a "comprobar un permiso", con un mapa central rol → permisos en el servidor. No hubo migración de base de datos ni cambios en el formato del JWT.

- **`Permission`** (`core/permissions.py`): enumeración con el catálogo de permisos. Cada permiso corresponde a operaciones que existen hoy en `api/routes.py`.
- **`ROLE_PERMISSIONS`**: mapa de solo lectura (`MappingProxyType`) de cada rol a su conjunto de permisos. Es la única fuente de verdad, y los roles asignables (`ROLES`) se derivan de él.
- **`permissions_for(roles)`**: une los permisos de los roles del actor. Un rol que no está en el mapa no aporta ninguno, así que **se deniega por defecto**.
- **`require_permission(p)`** (`core/auth.py`): fábrica de dependencias de FastAPI. Reutiliza `get_principal`, que valida el JWT RS256 y la sesión (no revocada, no vencida, usuario activo) y lee el rol desde la base de datos. Luego exige el permiso `p`. FastAPI resuelve la dependencia antes de validar el cuerpo y ejecutar la ruta, por lo que una petición denegada nunca llega a la operación protegida.
- **`require_admin`** se conserva por compatibilidad. Las rutas de Identity ya no lo usan.

Dos principios guían la decisión:

- **El rol sale de la base de datos**, no del claim del JWT ni de cabeceras enviadas por el cliente. Por eso un token manipulado no eleva privilegios: la firma deja de ser válida. Por la misma razón, `X-User-Roles` o `X-Dev-Roles` no tienen efecto.
- **El mínimo privilegio** queda explícito: el rol `voter` solo tiene `voting:participate`, que opera exclusivamente sobre el propio usuario autenticado.

## E. Matriz de roles y permisos

| Permiso | Operaciones protegidas | `admin` | `voter` |
|---|---|:-:|:-:|
| `users:read` | `GET /users` | ✔ | — |
| `users:write` | `POST /users`, `PATCH /users/{id}` | ✔ | — |
| `census:read` | `GET /elections/{id}/voters` | ✔ | — |
| `census:write` | `POST /elections/{id}/voters`, `PATCH /elections/{id}/voters/{user_id}` | ✔ | — |
| `elections:read` | `GET /elections`, `GET /elections/{id}/status` | ✔ | — |
| `elections:manage` | `POST /elections`, `POST /elections/{id}/open`, `POST /elections/{id}/close` | ✔ | — |
| `voting:participate` | `GET /elections/{id}/parameters`, `GET /elections/{id}/eligibility`, `POST /tokens/blind`, `POST /vote-confirmation` | ✔ (\*) | ✔ |

Rutas sin permiso adicional:
- **Públicas:** `POST /login`, `POST /login/mfa`, `GET /elections/open`, `GET /.well-known/jwks.json`, `GET /keys`, `GET /` y `GET /health`.
- **Solo sesión:** `GET /auth/me` y `POST /logout`, que operan sobre la propia sesión.

Cualquier otro rol (por ejemplo, uno creado directamente en la base de datos) no tiene permisos.

(\*) **Decisión de compatibilidad.** En P2, un administrador inscrito en el padrón podía solicitar su credencial y votar. Se mantuvo ese comportamiento asignando `voting:participate` al rol `admin`, y así quedó documentado en el código. Retirarlo aplicaría separación de funciones entre administrar y votar, y basta con quitar una línea de `ROLE_PERMISSIONS`. Queda pendiente de decisión del grupo. El padrón y la restricción de una credencial por votante y elección se aplican igual a ambos roles.

## F. Componentes y archivos

| Archivo | Responsabilidad |
|---|---|
| `identity/app/core/permissions.py` (nuevo) | Catálogo `Permission`, mapa `ROLE_PERMISSIONS`, roles asignables `ROLES` y funciones `permissions_for` / `has_permission`. No depende de ningún otro módulo de la aplicación. |
| `identity/app/core/auth.py` | Añade `require_permission`, que reúne la autenticación existente (`get_principal`) y la autorización por permiso. Mantiene `require_admin`. |
| `identity/app/api/routes.py` | Cada ruta protegida declara su permiso con `Depends(require_permission(Permission.X))`: 11 de administración y 4 del votante. La lógica de las rutas no cambia. |
| `identity/app/services/users.py` | La validación del rol al crear usuarios usa `ROLES` del catálogo central en lugar de una lista propia. |
| `identity/tests/test_rbac.py` (nuevo) | 47 pruebas del escenario, con JWT reales (login + MFA) y `dev_auth=False`. |
| `identity/README.md` | Tabla de endpoints con el permiso de cada ruta y la sección «Control de acceso por roles (RBAC)». |

No se modificaron el Gateway, el WAF, `docker-compose.yml`, Blind Signature ni los demás servicios.

## G. Pruebas y resultados

**Resultado global de la suite de Identity:** 93 pruebas originales + 47 nuevas = **140 pruebas, todas aprobadas**. Las 93 originales pasan sin modificaciones. La suite del Gateway, que no fue tocado, se mantiene en 46/46.

Las pruebas nuevas no usan las cabeceras de desarrollo. Cada actor inicia sesión con contraseña y MFA y usa el JWT RS256 que emite Identity, de modo que se ejercitan la firma, la sesión en la base de datos, el rol leído de la base y el permiso.

| Grupo | Pruebas | Qué demuestra |
|---|---|---|
| Catálogo | `test_catalog_only_knows_the_existing_roles`, `test_voter_only_participates_and_admin_administers`, `test_unknown_roles_get_no_permissions` (6 casos) | Solo existen `admin` y `voter`; el votante no tiene permisos administrativos; los roles desconocidos o mal escritos (`ADMIN`, `admin `, vacío…) no obtienen permisos. |
| Clasificación de rutas | `test_every_route_declares_the_expected_permission` | Cada ruta del router declara el permiso esperado. Una ruta nueva sin clasificar, o un permiso cambiado, hace fallar la prueba. |
| 401 sin sesión | `test_protected_routes_without_token_are_401` (15 casos) | Todas las rutas protegidas exigen autenticación. |
| JWT inválidos y roles manipulados | `test_invalid_token_is_401_on_census` (3 casos), `test_voter_token_forged_as_admin_is_401` | Texto arbitrario, segmentos falsos, `alg: none` y un token de votante con el claim `role` cambiado a `admin` se rechazan con 401. |
| Sesiones revocadas | `test_revoked_admin_session_is_401_on_admin_routes` | Tras `POST /logout`, el token del administrador deja de servir en Identity. |
| Cabeceras falsificadas | `test_dev_headers_are_ignored_when_dev_auth_is_off`, `test_client_supplied_role_headers_do_not_grant_permissions` | `X-Dev-*` no autentica con `dev_auth` desactivado; `X-User-Roles: admin` no concede permisos; con un Bearer presente, `X-Dev-Roles` se ignora. |
| 403 por falta de permiso | `test_voter_cannot_perform_administrative_operations` (11 casos) | El votante recibe 403 `forbidden` en cada operación administrativa. |
| Roles desconocidos | `test_unknown_role_is_denied_everywhere_but_its_own_session`, `test_unknown_dev_role_is_denied` | Un usuario con un rol fuera del catálogo puede consultar su propia sesión, pero recibe 403 en las rutas administrativas y en las del votante. |
| Integridad ante denegación | `test_denied_modifications_leave_the_data_untouched` | Seis intentos de modificación del votante (inscribirse, cambiar elegibilidad ajena, crear un admin, desactivar al admin, cerrar y crear urnas) reciben 403. El padrón, los usuarios, las urnas y las credenciales emitidas quedan idénticos, y Ballot no recibe cierre ni registro. |
| Funcionamiento permitido | `test_admin_performs_its_operations`, `test_voter_completes_the_anonymous_flow_with_a_real_session` | El administrador ejecuta todas sus operaciones. El votante completa su flujo de voto con sesión real. |

**Prueba de mutación (manual).** Para comprobar que las pruebas detectan un debilitamiento real del control, se cambió temporalmente el permiso de `GET /elections/{id}/voters` de `census:read` a `voting:participate`, lo que daría acceso al padrón a cualquier votante. Fallaron tres pruebas:
- `test_every_route_declares_the_expected_permission`
- `test_voter_cannot_perform_administrative_operations[GET /elections/{e}/voters]`
- `test_client_supplied_role_headers_do_not_grant_permissions`

Al restaurar el archivo, la suite volvió a pasar completa.

**Orden de evaluación.** Se verificó que la autorización se evalúa antes que la validación del cuerpo: un votante que envía un cuerpo inválido a `POST /users` recibe 403 y no 422, y sin token recibe 401. Así no se revela información sobre el contrato de las rutas administrativas a quien no puede usarlas.

## H. Preservación del anonimato del voto

El escenario solo actúa sobre la zona de identidad y no cambia nada del mecanismo que separa al votante de su papeleta:

- No se modificaron `services/tokens.py` (emisión de la credencial), `clients/blind_signature.py`, el servicio Blind Signature, `core/jwt_tokens.py`, `services/sessions.py` ni el contrato de parámetros firmados.
- Las rutas del votante solo añaden la comprobación de `voting:participate` antes de ejecutarse. La lógica de elegibilidad, la reserva única de la credencial en Census y la firma ciega son las mismas.
- Blind Signature sigue recibiendo únicamente `election_id` y el mensaje cegado. La prueba existente `test_blind_signature_service_never_receives_the_voter_identity` sigue pasando.
- Identity sigue sin almacenar el mensaje cegado, la firma ni el token (`test_identity_stores_no_link_between_user_and_token`). Census conserva solo el día de emisión.
- El mecanismo no registra nada nuevo: no hay bitácora con marcas de tiempo de emisión o confirmación que pudiera cruzarse con la llegada de papeletas a Ballot.
- La ruta de votación del Gateway (`/api/ballots`) sigue siendo anónima y no forma parte de este cambio.
- `test_voter_completes_the_anonymous_flow_with_a_real_session` recorre el flujo completo con un JWT real: elegibilidad, parámetros, cegado, firma ciega, desciegue y verificación de la credencial, y confirmación de participación.

## I. Limitaciones y trabajo coordinado

Estos puntos están identificados y **no están resueltos** en este escenario. Los dos primeros corresponden al Gateway y quedan para coordinar con Sergio (escenario 2, Reverse Proxy):

1. **Revocación de sesiones en el Gateway.** El Gateway valida el JWT sin estado y acepta un token revocado (o de un usuario desactivado) hasta su `exp`, que es de una hora. Identity sí lo rechaza en sus propias rutas, pero las operaciones administrativas que el Gateway envía a servicios sin autorización propia (el escrutinio en Tally y `recompute` en Analytics) siguen aceptándolo durante esa ventana. Una alternativa es que el Gateway consulte el estado de la sesión en Identity solo para las rutas `admin`.
2. **Rutas administrativas sin entrada en el Gateway.** `POST /users`, `PATCH /users/{id}` y `POST /elections/{id}/open` existen en Identity, y están protegidas por permiso, pero no aparecen en el catálogo del Gateway. Por eso la CLI de administración se comunica directamente con Identity, sin pasar por el WAF, el Gateway ni su límite de tasa.
3. **Fuera del alcance de este escenario**, para coordinar con los responsables de cada componente:
   - Tally y Analytics delegan toda la autorización en el Gateway.
   - El servicio Election mantiene la autenticación de desarrollo activa en `docker-compose.yml` (`ELECTION_DEV_AUTH=true`, publicado solo en loopback).
   - El canal gRPC de administración hacia Ballot no tiene autenticación.

## J. Consecuencias de la decisión

**Beneficios**
- La política de acceso está en un solo archivo y se puede leer y auditar por operación.
- Mínimo privilegio y denegación por defecto explícitos: un rol nuevo o mal escrito no obtiene permisos por accidente.
- La autorización no depende del Gateway ni de las cabeceras del cliente. Identity se protege aunque se acceda a él directamente.
- Cambiar los permisos de un rol tiene efecto inmediato sin reemitir tokens, porque el rol se lee de la base de datos en cada petición.
- No hubo migración de datos, cambio del contrato JWT ni impacto en Platform, Mobile, la CLI o el Gateway.
- La prueba de clasificación de rutas evita regresiones silenciosas cuando se añadan endpoints.

**Costos**
- Cada ruta protegida consulta la sesión en la base de datos. Esa consulta ya existía en P2; el permiso se evalúa en memoria y no añade consultas.
- Añadir una ruta exige declarar su permiso y actualizar la matriz de pruebas, lo cual es intencional.

**Limitaciones**
- Los permisos se aplican dentro de Identity. El Gateway sigue autorizando por rol (`admin`) y no conoce el catálogo de permisos.
- La asignación rol → permisos es estática, definida en código. Cambiarla requiere un despliegue de Identity.
- El modelo conserva solo dos roles. La granularidad está preparada para separar responsabilidades en el futuro, pero hoy `admin` tiene todos los permisos administrativos.
- `require_admin` se mantiene por compatibilidad aunque ninguna ruta de Identity lo usa ya.
- La autenticación de desarrollo (`X-Dev-*`) sigue existiendo para pruebas. Está desactivada por defecto y el Gateway descarta esas cabeceras.

## K. Procedimiento de demostración

Requisitos: `uv` instalado; desde la raíz del repositorio en la rama `feat/p3-rbac`.

```bash
cd identity

# 1. Suite completa: 140 pruebas (93 originales + 47 de RBAC)
uv run pytest -q

# 2. Pruebas del escenario 5 con el nombre de cada caso (matriz 401/403 ruta por ruta)
uv run pytest tests/test_rbac.py -v

# 3. Escenario principal: el votante intenta modificar el padrón y nada cambia
uv run pytest tests/test_rbac.py -v -k "denied_modifications or voter_cannot_perform"

# 4. Toda ruta está clasificada con su permiso
uv run pytest tests/test_rbac.py -v -k "every_route_declares"

# 5. Manipulación: token alterado, cabeceras falsificadas, rol desconocido y sesión revocada
uv run pytest tests/test_rbac.py -v -k "forged or headers or unknown_role or revoked"

# 6. El voto anónimo sigue funcionando y Blind Signature no recibe la identidad del votante
uv run pytest -v -k "anonymous_flow or never_receives_the_voter_identity or no_link_between_user_and_token"
```

**Prueba de mutación en vivo.** En `identity/app/api/routes.py`, dentro de `list_voters`, cambiar `Permission.CENSUS_READ` por `Permission.VOTING_PARTICIPATE`. Luego ejecutar `uv run pytest tests/test_rbac.py -q`: deben fallar las tres pruebas de la sección G. Por último, deshacer el cambio y volver a ejecutar la suite.

**Pruebas que conviene mostrar:**
1. `test_denied_modifications_leave_the_data_untouched` (estímulo → 403 → datos sin cambios).
2. `test_voter_cannot_perform_administrative_operations` (11 operaciones, 11 respuestas 403).
3. `test_every_route_declares_the_expected_permission` (no hay rutas sin clasificar).
4. `test_voter_token_forged_as_admin_is_401` y `test_client_supplied_role_headers_do_not_grant_permissions` (el rol no se puede falsificar).
5. `test_voter_completes_the_anonymous_flow_with_a_real_session` (el anonimato se mantiene).
