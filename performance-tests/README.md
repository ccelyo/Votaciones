# Laboratorio 6 – Performance Testing con k6

Pruebas de rendimiento de **`GET /api/auth/me`** a través del API Gateway de Votaciones. Todo el trabajo del laboratorio vive en esta carpeta; no se modificó ningún microservicio ni `docker-compose.yml`.

## Qué se prueba

```
k6 (Nodo B) ──HTTP──▶ Gateway :8088 ──▶ Identity :8000 ──▶ PostgreSQL (users, sessions, roles)
                       valida JWT RS256    valida JWT + sesión
                       (JWKS de Identity)  (SELECT sessions⋈users⋈roles)
```

- Endpoint: `GET {BASE_URL}/api/auth/me` con `Authorization: Bearer <JWT>` (ruta `auth/me`, acceso `user`, ver `gateway/src/routes.ts`).
- Solo lectura: ninguna escritura durante la ventana de medición.
- El frontend (`platform`, puerto 3000) se despliega junto con el resto y se verifica con un *smoke check*, pero la carga va directa al Gateway.

## Topología

| | Nodo A (SUT) | Nodo B (generador) |
|---|---|---|
| Rol | Despliegue completo de Votaciones (Docker) | k6 + análisis |
| Máquina | Equipo distinto del B | Equipo distinto del A, sin Votaciones |
| Recomendado | Linux, ≥4 vCPU, ≥8 GB | Linux, ≥4 vCPU, ≥8 GB, cableado o misma red/VPC |

| Conexión | Puerto | Uso |
|---|---|---|
| B → A | TCP **8088** | Carga (Gateway) |
| B → A | TCP **3000** | Verificar el frontend desplegado |
| B ↔ A | ICMP | RTT base |
| No se abren | 8000, 8080, 9091, 5432, 27017, 5672 (redes internas); 8001 y 15672 solo loopback | Segmentación del Lab 5 |

En el firewall de A, permitir 8088 y 3000 solo desde la IP de B. `run-level.sh` rechaza `BASE_URL` con `localhost`/`127.0.0.1` para garantizar la independencia del nodo.

## Metodología

- **Carga cerrada, sin think time:** N VUs concurrentes; cada uno envía la siguiente petición al recibir la respuesta (sin `sleep`). La concurrencia es constante e igual a N. Tras la saturación, por la Ley de Little, `latencia ≈ VUs / throughput`, así que la latencia crece linealmente aunque el sistema solo esté saturado; por eso el knee se define con el **throughput** y se corrobora con latencia y errores.
- **Niveles independientes:** 1, 50, 200, 500 y 2000 VUs, cada uno en un proceso k6 distinto, con pausa de 60 s entre niveles.
- **Fases iguales en todos los niveles:** ramp-up de 30 s (0→N) + carga sostenida de 120 s (N). Solo la fase sostenida entra en los resultados (cada petición se etiqueta `phase:ramp|sustain|setup`).
- **Calentamiento:** una corrida previa a la campaña (50 VUs, 60 s) que se descarta, más el ramp-up de cada nivel.
- **Repeticiones:** pasada exploratoria (1 por nivel) → `analyze.py` propone el intervalo del knee → ≥3 repeticiones del nivel candidato (se reporta la mediana y el rango). Si el knee queda entre dos niveles, se pueden añadir niveles de refinamiento (p. ej. 100, 300, 1000).
- **Timeout** de 30 s por petición; los timeouts y errores de red cuentan como error. Sin umbrales de aborto: interesa observar la sobrecarga.

### Autenticación y usuarios

2000 VUs **no** son 2000 identidades. Los VUs fijan la concurrencia; las identidades son filas distintas de `users`/`sessions`. Un JWT compartido sería funcionalmente válido (no hay límite por usuario ni caché por token) pero maximiza la localidad de caché en PostgreSQL y es poco defendible.

Solución: en `setup()` (fuera de la ventana medida) se hace login + MFA con los **14 usuarios sembrados** (4 `admin`, 10 `votante`, ver `identity/seed_dev_users.sql`) y cada VU usa `tokens[(VU-1) % 14]`. Los tokens se generan en cada ejecución (TTL 3600 s). No se modifica Identity ni se crean usuarios. `TOKENS_PER_USER` (por defecto 1) permite varias sesiones por usuario.

**Limitación:** 2000 VUs sobre 14 identidades y 14 sesiones. El trabajo del servidor por petición es el mismo que con identidades únicas.

Escrituras: solo `setup()` inserta ≈28 filas (`mfa_challenges`, `sessions`) por ejecución, en el despliegue aislado `votaciones-perf`. `RESET=1 bash performance-tests/deploy/nodeA-down.sh` restaura el seed.

### Límite de tasa del Gateway

El Gateway limita peticiones por IP y por minuto (default 300, login 20). Desde un único generador, sin cambios, casi todo sería 429. `deploy/docker-compose.perf.yml` fija `GATEWAY_RATE_LIMIT_DEFAULT=0` y `GATEWAY_RATE_LIMIT_LOGIN=0` **solo en el despliegue de pruebas**; el pre-vuelo de `setup()` aborta si `RateLimit-Limit` no es `0`. No se fijan límites de CPU ni memoria.

## Estructura

```
performance-tests/
  deploy/        docker-compose.perf.yml, nodeA-up.sh, nodeA-down.sh, nodeA-monitor.sh
  k6/            auth_me.js, lib/config.js, lib/auth.js
  scripts/       collect-env.sh, run-level.sh, run-campaign.sh
  analysis/      analyze.py, requirements.txt
  results/       env/ (equipos), summary/runs/ (1 JSON por corrida), summary/ (CSV, knee), figures/, raw/ (monitoreo, no versionado)
  REPORT.md      informe (plantilla a completar con los resultados)
```

## Ejecución

Requisitos: Nodo A con Docker y Compose; Nodo B con [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/), Python 3 y `bash`. Ambos con este repo en la rama `lab6/performance-testing`. Las credenciales de desarrollo están en el encabezado de `docker-compose.yml`; se pasan por variables de entorno y no se guardan en archivos.

### Windows (PowerShell, sin WSL)

Cada script de bash tiene su equivalente `.ps1` (`deploy/nodeA-up.ps1`, `deploy/nodeA-monitor.ps1`, `scripts/collect-env.ps1`, `scripts/run-level.ps1`, `scripts/run-campaign.ps1`). Desde la raíz del repo, en PowerShell:

```powershell
# Nodo A (Docker Desktop)
.\performance-tests\deploy\nodeA-up.ps1                      # levanta y espera /readyz  (-Down / -Down -Reset para bajar)
.\performance-tests\scripts\collect-env.ps1 -Role A
.\performance-tests\deploy\nodeA-monitor.ps1                 # en otra terminal durante la campaña

# Nodo B (k6)
.\performance-tests\scripts\collect-env.ps1 -Role B -AIp <IP_TAILSCALE_A>
$env:BASE_URL = 'http://<IP_TAILSCALE_A>:8088'; $env:LAB_PASSWORD = '...'; $env:LAB_MFA_CODE = '...'
$env:RAMP_S = '5'; $env:HOLD_S = '25'; .\performance-tests\scripts\run-level.ps1 -Vus 1   # smoke
Remove-Item Env:RAMP_S, Env:HOLD_S
.\performance-tests\scripts\run-campaign.ps1                                 # calentamiento + 1,50,200,500,2000
python performance-tests\analysis\analyze.py
.\performance-tests\scripts\run-campaign.ps1 -Levels <knee> -Reps 3 -NoWarmup
```

Si se usa Tailscale, `BASE_URL` lleva la IP `100.x.y.z` del Nodo A. En Windows, Docker Desktop publica 8088 y 3000 en todas las interfaces; el firewall de A debe permitir TCP 8088 y 3000 desde la interfaz de Tailscale.

### Linux / bash

**Nodo A**
```bash
bash performance-tests/deploy/nodeA-up.sh              # compose + override, espera /readyz
bash performance-tests/scripts/collect-env.sh A        # características del equipo
bash performance-tests/deploy/nodeA-monitor.sh &       # docker stats + conexiones Postgres durante la campaña
```

**Nodo B**
```bash
ulimit -n 65535
A_IP=<IP_NODO_A> bash performance-tests/scripts/collect-env.sh B
curl -s http://<IP_NODO_A>:8088/readyz ; curl -sI http://<IP_NODO_A>:3000 | head -1   # smoke: gateway y frontend

export BASE_URL=http://<IP_NODO_A>:8088 LAB_PASSWORD='...' LAB_MFA_CODE='...'
bash performance-tests/scripts/run-campaign.sh                          # calentamiento + 1,50,200,500,2000
pip install -r performance-tests/analysis/requirements.txt
python performance-tests/analysis/analyze.py                            # tabla, knee propuesto y curva
bash performance-tests/scripts/run-campaign.sh --levels <nivel_knee> --reps 3 --no-warmup
python performance-tests/analysis/analyze.py
```

Humo previo (1 VU, 30 s): `RAMP_S=5 HOLD_S=25 bash performance-tests/scripts/run-level.sh 1`.
Duración estimada: pasada completa ≈ 18 min; 3 repeticiones del knee ≈ 11 min.

## Criterio del knee

`analyze.py` calcula, por nivel, el throughput sostenido (mediana si hay repeticiones) y su ganancia respecto al nivel anterior. El **knee** es el intervalo en que la ganancia cae por debajo del 10 % (meseta): se reporta el último nivel que aún crecía y el primero saturado, y se corrobora con la latencia p95 (≥2× la del último nivel eficiente) y la tasa de error (>1 %). Como comprobación cruzada se aplica Kneedle (Satopaa et al., 2011) a la curva throughput-vs-VUs.

## Validez de una corrida

Una corrida se descarta si: hubo respuestas 429 (el limitador debe estar desactivado); la CPU del Nodo B superó ~80 % (`results/raw/*-hostB.txt`, columnas `us+sy`), porque entonces el límite es el generador; o el Nodo B y el A son el mismo equipo.

## Problemas conocidos

- **Identity** corre con 1 worker uvicorn, hilos por defecto para endpoints síncronos y pool SQLAlchemy de 5+10 conexiones con `pool_timeout` de 30 s: a alta concurrencia se esperan esperas y 500 por agotamiento del pool. Es parte del sistema evaluado y no se modifica.
- El **Gateway** es un proceso Node único y escribe un log JSON por petición; ambos forman parte del costo medido.
- **Docker Desktop (Windows/macOS)** como Nodo A añade un proxy de puertos y limita la memoria (WSL2); documentarlo en `results/env/` o usar Linux.
- **2000 VUs:** `ulimit -n`, puertos efímeros y CPU/RAM del Nodo B; evitar Wi-Fi.
- Primer arranque: Notification y Analytics pueden registrar `ECONNREFUSED` hasta que RabbitMQ abre AMQP (ver `docs/lab5-network-segmentation/README.md`); esperar a que `/readyz` quede en `ok`.
