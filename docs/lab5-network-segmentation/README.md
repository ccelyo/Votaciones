# Laboratorio 5 – Network Segmentation (implementación base)

Implementación base del patrón **Network Segmentation** sobre el entorno Docker Compose de Espivota. Este documento cubre la preparación del entorno (redes, asignación de servicios y puertos) y su verificación. Las configuraciones específicas de endurecimiento del patrón quedan para el compañero responsable del núcleo (ver [Limitaciones y riesgos pendientes](#7-limitaciones-y-riesgos-pendientes)).

## 1. Objetivo

Que cada servicio solo pueda comunicarse con los servicios con los que tiene una dependencia real, y que desde el host solo se publiquen los puntos de entrada necesarios. Todo con cambios en `docker-compose.yml`, sin modificar el código de ningún microservicio.

## 2. Estado anterior

- `docker-compose.yml` no declaraba redes: los 17 servicios compartían la red `default`, de modo que cualquier contenedor alcanzaba a cualquier otro (por ejemplo, Platform a Mongo o Notification a la base del censo).
- Se publicaban en el host los puertos de Platform (3000), Gateway (8088), Identity (8000), Election (8001), Ballot (8080), Mobile (8092), Analytics (8090), Notification (8091) y la UI de RabbitMQ (15672). Identity, Ballot, Analytics y Notification se podían llamar directamente, saltándose la validación de JWT, los roles y el límite de peticiones del Gateway.
- Las bases de datos no se publicaban, pero eran alcanzables desde cualquier contenedor.

## 3. Redes implementadas

Criterio: **una red por conexión** del diagrama C&C. Dos servicios solo se ven si comparten red. Las redes `internal: true` no tienen salida a Internet ni al host (ningún servicio necesita salida a Internet en ejecución; el build de imágenes no usa estas redes).

| Red | internal | Miembros | Conexión |
|---|---|---|---|
| `frontend-net` | no | platform, gateway | Platform → Gateway (HTTP 8088) |
| `mobile-net` | no | mobile | Solo archivos estáticos; publica 8092 |
| `dev-access-net` | no | election, rabbitmq | Puertos solo en loopback (ver nota) |
| `gw-identity-net` | sí | gateway, identity | HTTP 8000 |
| `gw-ballot-net` | sí | gateway, ballot | HTTP 8080 |
| `gw-tally-net` | sí | gateway, tally | HTTP 8092 |
| `gw-analytics-net` | sí | gateway, analytics | HTTP 8090 |
| `gw-notification-net` | sí | gateway, notification | HTTP 3000 |
| `vote-link-net` | sí | identity, ballot | gRPC 9091 |
| `tally-ballot-net` | sí | tally, ballot | HTTP 8080 (volcado de papeletas) |
| `signer-net` | sí | identity, blind-signature | HTTP 8100 |
| `identity-data-net` | sí | identity, postgres, postgres-census | PostgreSQL 5432 |
| `ballot-data-net` | sí | ballot, mongo | MongoDB 27017 |
| `election-data-net` | sí | election, postgres-elections | PostgreSQL 5432 |
| `results-data-net` | sí | analytics, mongo-results | MongoDB 27017 |
| `notif-data-net` | sí | notification, notifications-mongo | MongoDB 27017 |
| `mq-ballot-net` | sí | ballot, rabbitmq | AMQP 5672 |
| `messaging-net` | sí | tally, analytics, notification, rabbitmq | AMQP 5672 |

Son 17 redes. Ballot tiene su propia red hacia RabbitMQ porque guarda los votos y su gRPC no tiene autenticación; así Analytics, Notification y Tally no comparten red con Ballot por el bus de mensajes.

**Nota sobre `dev-access-net`:** un contenedor conectado solo a redes `internal` no puede publicar puertos. Election (puerto de desarrollo) y la UI de RabbitMQ necesitan publicar, así que comparten esta red no interna y sus puertos se enlazan solo a `127.0.0.1`.

**Principio importante:** Docker aísla por **red**, no por puerto. Si dos servicios comparten red, se ven en todos los puertos que el destino tenga abiertos. La separación de redes **no** impide, por ejemplo, que el Gateway alcance el puerto gRPC 9091 de Ballot (ver riesgo 1).

## 4. Cambios en `docker-compose.yml`

Solo se modificó este archivo de configuración (más los documentos de esta carpeta).

- Se añadió el bloque `networks:` con las 17 redes y la clave `networks:` en los 17 servicios (los 16 de las pruebas más `mobile`).
- Se dejaron de publicar al host: **Identity (8000), Ballot (8080), Analytics (8090) y Notification (8091)**. Tally y todas las bases de datos ya no se publicaban.
- **Election (8001)** y la **UI de RabbitMQ (15672)** pasaron de todas las interfaces a `127.0.0.1`.
- **Se mantienen publicados:** Platform (3000), Gateway (8088) y Mobile (8092). El Gateway sigue publicado porque la app `mobile` (Flutter web) lo llama desde el navegador con `http://localhost:8088`.
- Se actualizó el comentario de cabecera y se añadieron comentarios breves.
- **No se cambiaron:** volúmenes, healthchecks, variables de entorno, `depends_on` ni código de microservicios. En particular `BALLOT_GRPC_ADDR` sigue en `0.0.0.0:9091`.

## 5. Reproducción

Requisitos: Docker Desktop en ejecución, `curl` y Python. Desde la raíz del repositorio:

```bash
git switch lab5/network-segmentation-base
docker compose config --quiet            # valida el compose

# Construir de una en una (evita saturar la memoria) y levantar todo menos mobile
SERVICES="postgres postgres-census blind-signature mongo ballot identity postgres-elections election gateway platform rabbitmq tally mongo-results analytics notifications-mongo notification"
COMPOSE_PARALLEL_LIMIT=1 docker compose -p votaciones build $SERVICES
docker compose -p votaciones up -d --no-build $SERVICES
docker compose -p votaciones ps -a

# Verificación en SOLO LECTURA (recomendada)
SKIP_WRITE=1 bash docs/lab5-network-segmentation/verify-segmentation.sh
```

Para parar sin borrar datos: `docker compose -p votaciones stop`. Evite `down -v`: borra los volúmenes.

### Verificación: `verify-segmentation.sh`

Script en esta carpeta. Tiene tres partes de **solo lectura** y una que **escribe**:

| Sección | Qué comprueba | Escribe |
|---|---|---|
| 1 | Puertos publicados en el host (deben responder solo 3000, 8088, `127.0.0.1:15672` y `127.0.0.1:8001`; el resto, no) | No |
| 2a | HTTP Gateway → servicios (`/health`, `/healthz`), rutas públicas del Gateway y proxy de Platform | No |
| 2b | Login, MFA, JWT, analytics/notificaciones/tally con token y creación de una elección de prueba (Identity → Ballot por gRPC) | **Sí**: inserta filas en `mfa_challenges` y `sessions` de Postgres y crea una elección |
| 3 | Matriz de conectividad entre contenedores (conecta / bloqueado / conecta sin necesidad) | No (solo conexiones TCP) |

**`SKIP_WRITE=1` omite por completo la sección 2b.** Sin esa variable, el script la ejecuta y escribe en las bases del proyecto `votaciones`. Variables opcionales: `P` (proyecto Compose, por defecto `votaciones`), `WEB_PORT`, `GATEWAY_PORT`, `RABBITMQ_UI_PORT`, `ELECTION_PORT`. Sale con código 1 si falla alguna comprobación obligatoria; los riesgos no hacen fallar el script, solo se reportan.

## 6. Pruebas ejecutadas y resultados

Se ejecutó `SKIP_WRITE=1 bash docs/lab5-network-segmentation/verify-segmentation.sh` sobre el proyecto `votaciones` (16 servicios, sin `mobile`):

**Resultado: 54 correctas, 0 fallidas, 8 riesgos confirmados.**

- **Despliegue:** las 17 redes se crearon sin problemas de rangos de direcciones, los 16 contenedores quedaron en ejecución y los que tienen healthcheck, `healthy`. Los volúmenes `kevin-p2_*` de un proyecto anterior y el proyecto `broker-pattern` no se tocaron.
- **Puertos del host (13/13 correctas):** responden Platform 3000, Gateway 8088, RabbitMQ UI `127.0.0.1:15672` y Election `127.0.0.1:8001`. No están publicados Identity 8000, Ballot 8080, gRPC 9091, Tally 8092, Analytics 8090, Notification 8091, AMQP 5672, Mongo 27017 ni Postgres 5432.
- **Comunicación (8/8 correctas):** Gateway → identity, ballot, tally, analytics y notification por HTTP; `GET /api/elections/open` (Gateway → Identity → Postgres); `GET /api/ballots/...` (Gateway → Ballot → Mongo; 404 esperado por elección inexistente); proxy de Platform hacia el Gateway.
- **Conexiones permitidas:** gateway a los 5 servicios HTTP; platform → gateway; identity → postgres, postgres-census, blind-signature y ballot:9091; notification → rabbitmq y su Mongo; election → postgres-elections y rabbitmq.
- **Conexiones denegadas (bloqueadas):** gateway → rabbitmq, postgres, mongo, blind-signature, election; platform → identity, ballot, mongo; identity → mongo, rabbitmq, election; notification → ballot (8080 y 9091), identity, mongo-results; election → ballot (8080 y 9091), identity, mongo.

### Lo que NO se probó

- **La sección 2b no se ejecutó**: no se probaron login, MFA, JWT validado por el Gateway, rutas autenticadas de analytics, notificaciones o tally, ni la creación de elecciones (que ejercita Identity → Ballot por gRPC en la práctica).
- **El flujo completo de voto no se probó**: firma ciega, emisión de papeleta, recibo y resultados. Requiere el cliente criptográfico de firma ciega.
- **`mobile` no se construyó ni se levantó.**
- **Orígenes sin shell:** ballot, tally y analytics usan imágenes distroless; sus conexiones salientes (tally → ballot, ballot → mongo, analytics → mongo-results, etc.) no se probaron directamente. Se deducen de la membresía de redes y del arranque correcto (ballot conectó con Mongo y RabbitMQ; analytics y tally arrancaron sin errores).
- **Ausencia de salida a Internet** en las redes `internal`: es el comportamiento documentado de Docker, no se midió.
- **Arranque de RabbitMQ:** en el primer arranque Notification y Analytics registraron `ECONNREFUSED` porque el puerto AMQP abre unos segundos después de que el healthcheck (`rabbitmq-diagnostics ping`) pase. Se recuperaron solos en segundos. Es una carrera de arranque previa a la segmentación; no se modificó.

## 7. Limitaciones y riesgos pendientes

Los 8 riesgos son conexiones que **sí funcionan** y no son necesarias; salieron de la matriz del script (estado «riesgo»). Su solución (endurecimiento propio del patrón) queda fuera de esta implementación base y le corresponde a quien implemente el núcleo.

| # | Conexión | Causa | Impacto |
|---|---|---|---|
| 1 | gateway → ballot:**9091** | El gRPC de Ballot escucha en `0.0.0.0` y no tiene autenticación; Gateway y Ballot comparten `gw-ballot-net`. | Un Gateway comprometido podría registrar o cerrar elecciones. |
| 2 | identity → ballot:8080 | Comparten `vote-link-net`, y Ballot sirve HTTP y gRPC en todas sus interfaces. | Bajo: es la API HTTP pública de Ballot. |
| 3 | notification → rabbitmq:15672 | `messaging-net` incluye a RabbitMQ y la UI/API de gestión escucha en todas sus interfaces; credenciales `guest/guest`. | Un servicio comprometido podría administrar el broker. |
| 4 | notification → tally:8092 | Comparten `messaging-net`. | Bajo: no necesita ese acceso. |
| 5 | notification → analytics:8090 | Comparten `messaging-net`. | Bajo. |
| 6 | election → rabbitmq:15672 | `dev-access-net` compartida con RabbitMQ; mismas credenciales. | Igual que el riesgo 3. |
| 7 | rabbitmq → election:8000 | `dev-access-net`; Election acepta `X-Dev-User` sin token (`ELECTION_DEV_AUTH=true`). | RabbitMQ comprometido podría actuar como admin de Election. |
| 8 | rabbitmq → ballot:9091 | `mq-ballot-net`. | Igual que el riesgo 1. |

### Qué corresponde resolver (propuesta para el responsable del núcleo)

- **Riesgos 1 y 8 (gRPC de Ballot):** autenticación o mTLS en el gRPC (Identity ya tiene `IDENTITY_BALLOT_GRPC_TLS`), o enlazar el listener a la interfaz de `vote-link-net`. Esto último exige IP fija con `ipam` y modificar `BALLOT_GRPC_ADDR`; **no se hizo** porque cambia el comportamiento del servicio. Alternativa fuera de Compose: reglas por IP y puerto en la cadena `DOCKER-USER` de iptables (solo Linux; no aplica a Docker Desktop en Windows).
- **Riesgos 3, 6 y 7:** usuarios y permisos por servicio en RabbitMQ en vez de `guest/guest`, y desactivar `ELECTION_DEV_AUTH` fuera de desarrollo. Mover la UI de gestión a una red solo para ella evitaría el 3 y el 6.
- **Mongo y RabbitMQ sin autenticación** y credenciales públicas por defecto en todo el compose (solo desarrollo).
- **Pruebas negativas automatizadas** y endurecimiento de contenedores (`cap_drop`, `read_only`, etc.).
- **Aviso al equipo:** `localhost:8000`, `8080`, `8090` y `8091` ya no responden desde el host; cualquier README o prueba local que los use debe pasar por el Gateway (`localhost:8088`) o por Platform. Cuando Identity o Ballot publiquen eventos en RabbitMQ, hay que unirlos a la red de mensajería correspondiente. Cuando el Gateway enrute a Election, hay que crear una red `gw-election-net` y retirar el puerto de desarrollo.
- Con 17 redes conviene vigilar el rango de direcciones de Docker en equipos con muchas redes previas (aquí no hubo problema).
