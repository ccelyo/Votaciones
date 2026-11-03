# Census (PostgreSQL)

Base de datos del padrón electoral, según la vista C&C del Prototipo 2
(`Identity → SQL → Census`). No es un servicio: **Identity** es el único que la
consulta (`identity/app/db/census.py`, `identity/app/services/voter_roll.py`).

- `schema.sql`: tablas `voter_roll` e `issued_credentials`; se carga al crear el
  contenedor `postgres-census` del `docker-compose.yml`.
- Independiente de Auth: sin claves foráneas hacia usuarios ni elecciones.
- Anonimato: solo se guarda el día de emisión de la credencial, nunca hora exacta,
  mensaje cegado ni firma.

## Inicialización en Cloud SQL (una sola vez)

En Docker Compose `schema.sql` se carga solo al crear el volumen. En Cloud SQL **no hay
carga automática**: hay que hacerlo a mano. Pasos para el responsable de infraestructura
(valores entre `<>` los define el proyecto; no se ha ejecutado nada):

1. En la instancia de Cloud SQL (puede ser la de Identity), crear la base y un usuario propios:
   ```sql
   CREATE DATABASE census;
   CREATE USER census WITH PASSWORD '<CLAVE>';   -- la clave va a Secret Manager, no al repo
   ```
2. Dar permisos sobre esa base (conectado a `census`):
   ```sql
   GRANT ALL ON SCHEMA public TO census;
   ```
3. Cargar el esquema desde una máquina con acceso (Cloud SQL Auth Proxy o IP privada):
   ```bash
   psql "postgresql://census:<CLAVE>@<HOST>:5432/census?sslmode=require" -f census/schema.sql
   ```
   Ejecutarlo **una vez** sobre la base vacía (no usa `IF NOT EXISTS`; repetirlo falla).
4. Guardar la URL como secreto `IDENTITY_CENSUS_DATABASE_URL` del servicio `identity`.

Los cambios futuros del esquema no se aplican solos: requieren un script de migración manual.
Ver también `blind-signature/DEPLOY.md` (orden de despliegue).
