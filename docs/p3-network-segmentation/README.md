# Escenario de seguridad 3 — Network Segmentation (Prototipo 3)

Responsable: Fabián Espitia. Parte de la base del Laboratorio 5
([`docs/lab5-network-segmentation`](../lab5-network-segmentation/README.md)) y la
ajusta al sistema del Prototipo 3 (mTLS, WAF de borde).

## Qué cambió respecto al Laboratorio 5

| # | Cambio | Motivo |
|---|---|---|
| 1 | Se restauraron las redes de Ballot, Identity, Election, Tally, Analytics y Notification y el bloque `networks:` | Al integrar Secure Channel (PR #36) se perdieron: `docker compose config` fallaba con `service "blind-signature" refers to undefined network signer-net` y el sistema no arrancaba |
| 2 | ACL de entrada por servicio: sidecar `<servicio>-fw` (`security/netfw`) | Docker aísla por red, no por puerto. El Lab 5 dejó 8 conexiones abiertas que no hacían falta. El sidecar aplica la misma ACL del núcleo del Lab 5 (denegación por defecto + NFLOG) en el espacio de red de cada servicio |
| 3 | `messaging-net` se dividió en una red por cliente (`mq-ballot-net`, `mq-election-net`, `mq-tally-net`, `mq-analytics-net`, `mq-notification-net`) | Una red por conexión: Tally, Analytics y Notification ya no se ven entre sí |
| 4 | La UI de RabbitMQ (15672) deja de publicarse y desaparece `dev-access-net`; Election sale de esa red | Election ya no publica el 8001. Y las redes no internas se enrutan entre sí a través del host: el escaneo desde `edge-net` encontró la API de gestión (guest/guest) abierta, y la ACL no puede distinguir ese tráfico del host (ver «Hallazgos»). Opcional para desarrollo: `docker-compose.rabbitmq-ui.yml` |
| 5 | Subredes fijas `10.89.N.0/24` | Las ACL filtran por red de origen |
| 6 | `dev-certificates` con `network_mode: none` | Solo escribe archivos; sin esto Compose creaba la red `default` |
| 7 | Nuevo `verify-segmentation.sh` | El del Lab 5 usaba `http://` (ahora todo es mTLS) y no podía probar desde imágenes distroless |

## Diseño

Dos controles complementarios:

1. **Redes (zonas).** Una red por conexión de la vista C&C (23 redes, 21
   `internal`). Dos servicios solo se ven si comparten red. Solo `edge-net`
   (WAF) y `mobile-net` (archivos estáticos) son no internas: ambas son puntos
   de entrada públicos.
2. **ACL de entrada (puertos).** Cada servicio que recibe conexiones tiene un
   sidecar con `network_mode: service:<servicio>` y `NET_ADMIN`. El servicio no
   recibe `NET_ADMIN`, así que un servicio comprometido no puede cambiar sus reglas.

| Servicio | Acepta conexiones nuevas solo en | Desde |
|---|---|---|
| waf | 8443, 8444 | cualquier cliente, solo por su IP de `edge-net` (puertos publicados) |
| platform | 3000 | `waf-web-net` (WAF) |
| gateway | 8088 | `waf-api-net` (WAF), `frontend-net` (Platform) |
| identity | 8000 | `gw-identity-net` (Gateway) |
| ballot | 8080 | `gw-ballot-net` (Gateway), `tally-ballot-net` (Tally) |
| ballot | 9091 (gRPC) | `vote-link-net` (Identity) |
| tally | 8092 | `gw-tally-net` (Gateway) |
| analytics | 8090 | `gw-analytics-net` (Gateway) |
| notification | 3000 | `gw-notification-net` (Gateway) |
| rabbitmq | 5672 | `mq-*-net` (sus 5 clientes) |
| rabbitmq | 15672 | nadie (con el override de desarrollo: solo el host) |
| election | — | nadie (el Gateway enruta `/api/elections` a Identity) |

Las bases de datos no necesitan sidecar: cada una comparte red solo con su dueño.
Loopback (healthchecks, DNS interno de Docker) y las respuestas a conexiones
establecidas siempre pasan. La salida no se filtra.

## Uso

```bash
docker compose up -d --build
bash docs/p3-network-segmentation/verify-segmentation.sh       # solo lectura
docker compose logs -f ballot-fw                                # intentos denegados
docker compose exec ballot-fw iptables -L INPUT -v -n           # contadores
```

Para cambiar las subredes (si chocan con una red local), editar el bloque
`networks:` y los `FW_ALLOW` de `docker-compose.yml`. Si Election vuelve a
recibir tráfico del Gateway (`GATEWAY_ELECTION_URL=https://election:8000`), hay
que añadir una red `gw-election-net` y su origen a `FW_ALLOW` de `election-fw`.

## Resultados

Ejecución completa en [`resultados.txt`](resultados.txt): **172 comprobaciones
correctas, 0 fallidas** (Docker Desktop 29.9.2, stack completo sin `mobile`).

| Comprobación | Resultado |
|---|---|
| ACL de los 10 sidecars con política `INPUT DROP`; ningún servicio con `NET_ADMIN` | 20/20 |
| Puertos en el host: solo el WAF publica (3000, 8088); 11 puertos internos cerrados (el 5432 lo ocupa un Postgres local, ajeno al proyecto) | OK |
| Flujos permitidos con mTLS (Gateway → 5 servicios, WAF → Platform/Gateway, Platform → Gateway, Tally → Ballot) | 9/9 HTTP 200 |
| Flujos permitidos TCP (servicio → su base, → RabbitMQ, Identity → Ballot gRPC / firma ciega) | 13/13 |
| Movimiento lateral desde un servicio comprometido (65 pares origen → destino) | 65/65 bloqueados: 27 por la ACL (comparten red), 38 por no compartir red |
| Los 8 riesgos que dejó el Lab 5 | 8/8 mitigados (6 por la ACL, 2 por la división de `messaging-net`) |
| Atacante en `edge-net`: nombres internos | 9/9 no resuelven |
| Atacante en `edge-net`: `nmap` a las 37 IP de los servicios, 13 puertos | 479/481 `filtered`; solo responde el WAF en 8443/8444 (control positivo) |
| Registro: cada sidecar con intentos denegados los muestra en su log, en el mismo segundo | 8/8 |
| Reinicio de Ballot: la ACL se reaplica sola | 1–3 s |
| Flujo de voto completo (`docs/demo/e2e_vote.py`) con la segmentación activa | OK, 0 paquetes legítimos descartados |

Pruebas adicionales hechas a mano:

- **Manipulación:** borrar la ACL de Ballot desde fuera (`iptables -P INPUT ACCEPT; iptables -F INPUT`):
  el sidecar lo detecta y la reaplica en menos de 6 s.
- **Mutación del verificador:** con `ballot-fw` detenido y sin reglas, el script
  falla en 9 comprobaciones (todas las conexiones hacia Ballot). Las pruebas no pasan en vacío.

## Hallazgos durante la implementación

1. **El merge de Secure Channel rompió el compose.** `main` no arrancaba
   (`undefined network signer-net`). Se restauró la segmentación sobre la configuración mTLS.
2. **Un servicio que se reinicia pierde su ACL.** Docker le crea un espacio de
   red nuevo y el sidecar queda en el viejo. Es el mismo límite que el Lab 5
   documentó para `gateway-route`. El sidecar ahora vigila su espacio de red y,
   si pierde las interfaces o le cambian la política, sale, Docker lo reinicia y
   la ACL se reaplica.
3. **Las redes no internas se enrutan entre sí a través del host**, y el tráfico
   llega enmascarado con la IP del gateway del bridge. Desde `edge-net` se llegaba
   a la API de gestión de RabbitMQ en `dev-access-net`, aunque la ACL solo
   permitía `10.89.12.1` (el host). Por eso la UI ya no se publica por defecto.
4. **En Docker Desktop, el tráfico de los puertos publicados llega con origen
   `192.168.65.1`** (en Linux, con la IP real del cliente). La entrada del WAF se
   filtra por destino (su IP en `edge-net`), no por origen.
5. **Una versión anterior del escaneo pasaba en vacío:** con `--host-timeout`,
   nmap se saltaba todos los hosts y no reportaba puertos abiertos. Ahora un host
   saltado es falla, se exige el total de puertos `filtered` y hay un control positivo.

## Limitaciones

- Al arrancar un servicio pasan unos segundos antes de que su sidecar aplique la
  ACL (también tras un reinicio: 1–3 s medidos). Durante ese intervalo la
  protección es solo la de las redes.
- Las ACL filtran la entrada, no la salida.
- Election acepta `X-Dev-User` (`ELECTION_DEV_AUTH=true`) y las credenciales de
  RabbitMQ siguen siendo `guest/guest`. La segmentación reduce quién llega a
  esos puntos, pero no reemplaza la autenticación.
- Las subredes fijas pueden chocar con redes existentes del equipo (ver «Uso»).
- No se probó `mobile` (solo sirve archivos estáticos en `mobile-net`).
- En el primer arranque, RabbitMQ falló una vez con `eacces` sobre
  `.erlang.cookie` y arrancó al reiniciarlo. No tiene que ver con la red.
