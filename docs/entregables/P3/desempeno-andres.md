# Desempeño y escalabilidad

**Responsable:** Andrés · **Rama:** `feat/p3-performance`

Medí `GET /api/elections/open`, la pantalla de elecciones abiertas del votante. La petición recorre el borde de esta versión:

```
k6 --HTTPS--> WAF (TLS + ModSecurity) --> Gateway (TLS) --> Identity --> PostgreSQL
```

En el Lab 6 medí el mismo endpoint contra el Gateway en HTTP. Aquí dejé puestos el WAF, TLS y la segmentación de red, y volví a correr k6.

## Escenario

| Parte | Qué usé |
|---|---|
| Fuente | k6, varios usuarios virtuales a la vez, con 1 s de espera entre peticiones. |
| Estímulo | `GET /api/elections/open` durante 30 s, en niveles de 1 a 800 VUs. |
| Artefacto | WAF, Gateway, Identity y PostgreSQL. |
| Entorno | Stack local en Docker Desktop. Límite de tasa del Gateway en 0. Certificado de desarrollo. |
| Respuesta | 200 mientras el sistema aguanta. Al pasarse, Identity deja de conseguir conexión y la petición termina en timeout. |
| Medida | Latencia, req/s, % de error, CPU y memoria. La rodilla es el último nivel sin errores en el que el throughput todavía crece con las VUs. |

## Condiciones

| | |
|---|---|
| Equipo | FELIPE, Intel i5-12400 (12 hilos), 32 GB RAM |
| Generador | k6 0.54.0 dentro de Docker, en la misma máquina. Comparte CPU con el sistema. |
| Duración | 30 s por nivel, pausa de 1 s. Calentamiento de 10 s a 5 VUs, descartado. |
| TLS | El certificado no lo emite una autoridad de certificación pública. k6 no verifica el nombre, pero el handshake sí se hace. |
| Límite de tasa | `GATEWAY_RATE_LIMIT_DEFAULT=0` con `docs/lab6-performance/docker-compose.perf.yml`. Todas las VUs salen de la misma IP; con el límite puesto la prueba mediría 429 y no la capacidad. |
| Commit | `189c55f` |

No hubo 403 del WAF ni 429 del Gateway. User-Agent: `espivota-perf/p3`.

## Latencia, throughput y errores

Los números son la mediana de las repeticiones. El detalle de cada corrida está en `docs/p3-performance/results/`.

| VUs | Reps | req/s | Promedio | p95 | Errores | Limpias |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2 | 1,0 | 10 ms | 12 ms | 0 % | 2/2 |
| 25 | 2 | 24,4 | 18 ms | 35 ms | 0 % | 2/2 |
| 50 | 4 | 48,6 | 21 ms | 65 ms | 0 % | 4/4 |
| 75 | 2 | 72,3 | 24 ms | 67 ms | 0 % | 2/2 |
| 100 | 2 | 95,9 | 26 ms | 67 ms | 0 % | 2/2 |
| 125 | 2 | 119,2 | 29 ms | 68 ms | 0 % | 2/2 |
| 150 | 4 | 142,6 | 30 ms | 58 ms | 0 % | 4/4 |
| 175 | 2 | 165,1 | 34 ms | 83 ms | 0 % | 2/2 |
| 200 | 4 | 188,4 | 38 ms | 106 ms | 0 % (mediana) | 3/4 |
| 250 | 2 | 231,2 | 56 ms | 186 ms | 0 % | 2/2 |
| 300 | 2 | 269,3 | 83 ms | 180 ms | 0 % | 2/2 |
| 350 | 2 | 15,5 | 20 s | 30 s | 68 % | 0/2 |
| 400 | 2 | 24,8 | 20 s | 30 s | 65–100 % | 0/2 |
| 600 | 2 | 19,2 | 29 s | 30 s | 100 % | 0/2 |
| 800 | 2 | 25,7 | 29 s | 30 s | 100 % | 0/2 |

A 200 VUs una de las cuatro corridas se cayó (10 req/s, 58 % de error, promedio 18 s). Las otras tres quedaron en ~189 req/s y 0 % de error. 250 y 300 volvieron a salir limpias, así que no tomé 200 como la rodilla.

Descarté una repetición de 300 y otra de 350: las lancé 8 s después de un colapso, con el pool de Identity todavía lleno. Las dos de 300 que dejé, y las dos de 350, arrancan con el servicio recién reiniciado.

## Recursos

`docker stats` cada 3 s. CPU en % de un núcleo (puede pasar de 100). Memoria en MiB, promedio de las corridas de ese nivel.

| VUs | WAF CPU (pico) | Gateway CPU (pico) | Identity CPU (pico) | Postgres CPU (pico) | Memoria máxima |
|---:|---:|---:|---:|---:|---|
| 50 | 21 % (30) | 21 % (40) | 18 % (54) | 4 % (13) | Identity 131 MiB |
| 150 | 62 % (110) | 39 % (53) | 42 % (63) | 7 % (14) | Identity 131 MiB |
| 250 | 98 % (189) | 56 % (94) | 67 % (110) | 23 % (47) | Identity 142 MiB |
| 300 | 127 % (184) | 61 % (94) | 92 % (149) | 32 % (55) | Gateway 137 MiB |
| 350 | 1 % (15) | 1 % (6) | 2 % (22) | 1 % (3) | Gateway 182 MiB |

Platform no recibe esta carga: queda en 0 % de CPU y 41 MiB. Por debajo de 300 VUs nadie se acerca a quedarse sin memoria. En el colapso la CPU baja porque los hilos se quedan esperando conexión, y la memoria de Identity sube (541 MiB a 800 VUs).

## Rodilla

**300 VUs.** Es el último nivel limpio en las dos corridas: 269 req/s, promedio 83 ms, p95 180 ms, 0 % de error. El throughput sigue creciendo casi en línea con las VUs (1 req/s con 1 VU, 269 con 300).

**350 VUs ya no.** Cae a ~16 req/s, el promedio se va a 20 s y falla cerca del 70 %. De ahí para arriba el error es total y el throughput se queda entre 15 y 26 req/s.

El corte lo provoca el pool de SQLAlchemy de Identity: 5 conexiones más 10 de overflow, timeout de 30 s. Cuando se llena, Identity responde 500. El Gateway espera el upstream hasta 70 s y responde 504. k6 corta a los 30 s, así que en el resumen esos fallos salen como status 0, no como 5xx. Lo confirmé en los logs de Identity y del Gateway.

Mientras aguanta, el que más CPU gasta es el WAF. No es el que tumba la prueba: a 300 VUs todavía responde, y el que se queda sin conexiones es Identity.

## Qué cambié para poder medir

No toqué la lógica de los servicios. Reutilicé el script del Lab 6 (`docs/p3-performance/open_elections.js`) apuntando a `https://localhost:8088`, y el override que apaga el límite de tasa.

En `docker-compose.yml` faltaba el bloque `networks:` y varios servicios (Identity, Ballot, Election, Tally, Analytics, Notification) no estaban enganchados a sus redes. Compose no arrancaba. Volví a poner las redes que el archivo ya referenciaba, las del Lab 5 más `edge-net`, `waf-web-net` y `waf-api-net`.

Para repetir:

```powershell
.\docs\p3-performance\run-campaign.ps1
python docs/p3-performance/analyze.py
```
