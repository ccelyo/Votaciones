# Informe – Laboratorio 6: Performance Testing

> **Estado: plantilla.** Aún no se han ejecutado pruebas de carga. Las secciones marcadas con `PENDIENTE` se completan con los resultados de `results/summary/summary.csv`, `results/summary/knee.json` y las notas de `results/env/`. No se incluye ningún número que no provenga de una corrida.

## 1. Funcionalidad evaluada
`GET /api/auth/me` vía API Gateway → Identity → PostgreSQL. Justificación: solo lectura, reproducible, atraviesa Gateway (validación JWT RS256), el microservicio Identity (verificación de token y de sesión) y su base de datos. Alternativas descartadas: login (hash argon2 y escrituras), `elections/open` (sin elecciones sembradas, consulta trivial), voto (escritura y criptografía de cliente).

## 2. Entorno
- Nodo A (SUT): `PENDIENTE` — hardware, SO, Docker, commit. Ver `results/env/nodeA-*.txt`.
- Nodo B (k6): `PENDIENTE` — hardware, SO, k6, RTT hacia A. Ver `results/env/nodeB-*.txt`.
- Componentes desplegados en A: PostgreSQL, Identity, API Gateway, frontend (Next.js) y el resto de dependencias del Gateway.

## 3. Metodología
Ver `README.md`: carga cerrada sin think time; niveles 1/50/200/500/2000 independientes; ramp-up 30 s + sostenida 120 s; calentamiento descartado; ≥3 repeticiones del nivel del knee; 14 identidades reales (tokens generados en `setup()`); límite de tasa del Gateway desactivado solo en el despliegue de pruebas.

## 4. Resultados
`PENDIENTE` — tabla de `summary.csv` (VUs, reps, req/s, p50/p95/p99, % error) y figura `results/figures/curve.png`.

## 5. Knee
`PENDIENTE` — intervalo detectado, evidencia (throughput, p95, errores), repeticiones del nivel candidato (mediana y rango) y contraste con el monitoreo de A (`results/raw/sut-*.csv`: CPU por contenedor, conexiones a PostgreSQL).

## 6. Análisis del cuello de botella
`PENDIENTE` — hipótesis a contrastar con el monitoreo: 1 worker uvicorn y pool SQLAlchemy 5+10 en Identity, Gateway monoproceso, CPU de PostgreSQL.

## 7. Validez y limitaciones
- 2000 VUs sobre 14 identidades/sesiones (VUs ≠ identidades).
- Límite de tasa del Gateway desactivado en el despliegue de pruebas (es una defensa en producción).
- Sin límites de recursos en Docker: los resultados dependen del hardware descrito en la sección 2.
- Carga cerrada: la latencia post-saturación crece por construcción (`≈ VUs / throughput`).
- Se verificó que no hubo 429 y que la CPU del Nodo B no se saturó: `PENDIENTE`.
