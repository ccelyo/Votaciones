# Despliegue de Blind Signature en Google Cloud Run

Guía para el responsable de infraestructura. Nada de esto se ejecuta desde el repositorio:
`cloudbuild.yaml` solo construye la imagen y actualiza un servicio que ya existe.

Los nombres entre `<...>` son valores del proyecto GCP (los define infraestructura). No se
versiona ningún secreto: los valores viven en Secret Manager.

## 1. Variables de entorno y secretos

| Variable | Dónde | Valor |
|---|---|---|
| `BLINDSIG_API_KEY` | **Secret Manager** → variable del servicio `blind-signature` | **Obligatoria.** Cadena aleatoria larga (p. ej. `openssl rand -base64 32`). Si falta o está vacía, el servicio **no inicia** |
| `BLINDSIG_KEYS_DIR` | variable normal | `/app/keys` (ya es el valor de la imagen) |
| `IDENTITY_BLIND_SIGNATURE_API_KEY` | **Secret Manager** → servicio `identity` | **El mismo valor** que `BLINDSIG_API_KEY` (puede ser el mismo secreto). Identity lo envía en la cabecera `X-Internal-Token` |
| `IDENTITY_BLIND_SIGNATURE_URL` | variable normal del servicio `identity` | URL de Cloud Run de `blind-signature`, sin `/` final |
| `IDENTITY_CENSUS_DATABASE_URL` | **Secret Manager** → servicio `identity` | `postgresql://census:<CLAVE>@<IP_PRIVADA_CLOUD_SQL>:5432/census?sslmode=require` |

El valor de `dev-only-blindsig-token` que aparece en `docker-compose.yml` es solo para
desarrollo local: **no usarlo en Cloud Run**.

**Comportamiento del secreto en la aplicación:**
- `BLINDSIG_API_KEY` es **obligatoria**. Si la variable no existe o está vacía, el servicio **no
  inicia** (`RuntimeError: BLINDSIG_API_KEY is required ...`) y Cloud Run marcará la revisión como
  fallida. El mensaje de error no incluye el valor del secreto.
- `GET /v1/keys/{election_id}` y `POST /v1/sign` **requieren siempre** la cabecera
  `X-Internal-Token` con el secreto; sin ella, o con otro valor, responden `401`.
- `GET /health` permanece **público** (sin token) para los healthchecks.
- El secreto nunca se escribe en logs ni en mensajes de error.

## 2. Crear el servicio (una sola vez)

El primer despliegue lo hace una persona con permisos; después lo actualiza el trigger. Ejemplo
(sustituir los valores entre `<>`; no se ha ejecutado):

```bash
gcloud run deploy blind-signature \
  --image us-central1-docker.pkg.dev/<PROYECTO>/votaciones/blind-signature:latest \
  --region us-central1 \
  --port 8100 \
  --ingress internal \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --service-account <SA_BLIND_SIGNATURE> \
  --set-secrets BLINDSIG_API_KEY=blindsig-api-key:latest \
  --add-volume name=keys,type=cloud-storage,bucket=<BUCKET_CLAVES> \
  --add-volume-mount volume=keys,mount-path=/app/keys
```

- `--port 8100`: la imagen escucha en 8100, no en el 8080 por defecto.
- `--max-instances 1`: limitación operativa del prototipo; ver §5. No subirlo hasta resolver la
  concurrencia. **Por sí solo no garantiza exclusión mutua distribuida.**
- `--ingress internal`: no es accesible desde Internet. El Gateway no tiene ruta hacia este servicio.
- `--allow-unauthenticated`: decisión de despliegue del prototipo (alternativa A). Significa que
  **Cloud Run/IAM no pide credenciales de Google**; no es "servicio público": el acceso real lo
  limita `--ingress internal` + la red VPC (§3) + el secreto `X-Internal-Token`.

Después: crear el trigger de Cloud Build sobre `blind-signature/**` que use
`blind-signature/cloudbuild.yaml` (igual que el de `identity/`), y verificar que el repositorio
de Artifact Registry `votaciones` existe (lo usan identity y ballot).

## 3. Conectar Identity con Blind Signature (comunicación interna)

**Modelo de seguridad elegido (alternativa A).** Hay dos capas, y ninguna es autenticación IAM:

| Capa | Qué hace | Quién la configura |
|---|---|---|
| **Red:** `--ingress internal` + VPC | Solo acepta peticiones originadas dentro de la red del proyecto. Es la restricción principal. | Infraestructura |
| **Aplicación:** secreto `X-Internal-Token` | Siempre exigido en `/v1/sign` y `/v1/keys/{election_id}`: responde 401 si la cabecera falta o no coincide con `BLINDSIG_API_KEY`. `/health` es público. | `BLINDSIG_API_KEY` en Secret Manager (infraestructura); la validación ya está en el código |

- `--allow-unauthenticated` **no equivale a autenticación IAM**: Google no verifica quién llama.
  Quien pueda enviar tráfico desde dentro de la VPC solo queda detenido por el secreto compartido.
- El secreto compartido es una **protección adicional** a la restricción de red, no un sustituto:
  es un valor estático, sin identidad por llamante ni caducidad, y si se filtra no hay otra barrera
  salvo la red. Por eso la restricción de red debe estar bien configurada.
- Identity es el único cliente autorizado **por arquitectura y configuración de red**: ningún otro
  servicio (ni el Gateway) debe tener ruta ni egreso hacia este servicio, y el secreto solo se
  comparte con Identity.
- `BLINDSIG_API_KEY` es obligatoria: el servicio no arranca sin ella, así que no existe un
  despliegue que acepte llamadas sin secreto (salvo `/health`). Aun así, el secreto solo protege si
  se mantiene en Secret Manager y se comparte únicamente con Identity.

**Qué debe estar configurado para que Identity pueda acceder:**
1. Con `--ingress internal`, Blind Signature solo acepta tráfico que llegue desde la red VPC del
   proyecto. Identity debe **enviar su tráfico saliente por la VPC** (Direct VPC egress o conector
   de acceso a VPC con `--vpc-egress all-traffic`). Identity ya usa VPC para llegar a Cloud SQL
   por IP privada; hay que comprobar que el egreso incluya las llamadas a `*.run.app`. Si no se
   configura bien, las peticiones de Identity llegan como externas y Cloud Run las rechaza (403/404).
   *(Comportamiento a confirmar por infraestructura: depende de cómo esté configurada la VPC y
   Private Google Access.)*
2. Identity llama a `IDENTITY_BLIND_SIGNATURE_URL` con la cabecera `X-Internal-Token`, cuyo valor
   es `IDENTITY_BLIND_SIGNATURE_API_KEY` (el **mismo** secreto que `BLINDSIG_API_KEY`). Blind
   Signature responde 401 en `/v1/sign` y `/v1/keys/{election_id}` si la cabecera falta o no
   coincide; `/health` no la requiere.
3. Alternativa descartada por ahora: `--no-allow-unauthenticated` (autenticación IAM con token de
   identidad de Google). Exigiría que Identity obtenga y envíe ese token; el cliente actual no lo
   hace. Puede adoptarse más adelante sin cambiar el contrato.
4. Prueba de humo desde Identity (o desde una VM en la VPC):
   - `curl https://<URL_BLIND_SIGNATURE>/health` → `200` sin token.
   - `curl https://<URL_BLIND_SIGNATURE>/v1/keys/prueba` → `401` (sin token).
   - `curl -H "X-Internal-Token: $TOKEN" https://<URL_BLIND_SIGNATURE>/v1/keys/prueba` → `200`.

## 4. Orden de despliegue

1. Cloud SQL: crear base y usuario `census` y cargar el esquema (ver `census/README.md`).
2. Secret Manager: crear los secretos de §1.
3. Crear `blind-signature` en Cloud Run (§2) y probarlo.
4. Añadir las variables a `identity` y **solo entonces** dejar que el trigger despliegue la nueva
   versión de Identity. Si Identity se despliega antes, la creación de urnas y la emisión de
   tokens fallan con 502.

## 5. Persistencia de claves RSA y concurrencia entre instancias

Cloud Run tiene disco efímero: sin volumen, las claves se pierden al reiniciar y los tokens ya
emitidos dejan de verificar en Ballot (que guarda la clave pública antigua). Se necesita un
volumen persistente en `/app/keys`.

**Opción propuesta: bucket de Cloud Storage montado (Cloud Storage FUSE).**
- Bucket privado (acceso uniforme, sin acceso público), con permisos solo para la cuenta de
  servicio de `blind-signature` (`roles/storage.objectUser` sobre ese bucket).
- Activar versionado del bucket para poder recuperar una clave sobrescrita.
- Opcional: cifrado con clave propia (CMEK).
- Las claves son archivos PEM sin cifrar (`election-<id>.pem`); la protección es el IAM del bucket.

**Limitaciones de concurrencia (análisis; NO implementado):**

| Situación | Qué ocurre hoy | Riesgo |
|---|---|---|
| Varias peticiones simultáneas dentro de una instancia | Un candado en memoria (`threading.Lock`) las serializa | Ninguno |
| Dos instancias piden a la vez la clave de una elección **sin clave aún** | El candado no cruza instancias. El archivo se crea con `O_EXCL`; sobre Cloud Storage FUSE la exclusividad no está garantizada hasta que se cierra el archivo, y el caché de metadatos puede no mostrar de inmediato el archivo que creó otra instancia | Dos claves distintas para la misma elección; gana la última escritura. Si Ballot ya registró la primera clave pública, las firmas dejarían de verificar |
| Instancias leyendo una clave ya creada | Solo lectura | Ninguno |

En la práctica el riesgo es bajo: la clave de una elección se crea una sola vez, cuando Identity
crea la urna (`GET /v1/keys/{id}`), y los ids de elección son distintos por cada creación. Pero no
está garantizado por diseño.

**Mitigación inmediata (sin código):** `--max-instances 1`, como en §2. Es la que recomiendo para
el prototipo. Efecto: sin escalado horizontal (aceptable: la firma es una operación ligera).

**Límite de esta mitigación:** `--max-instances 1` limita el escalado, pero **no garantiza por sí
solo exclusión mutua distribuida**. Cloud Run puede tener momentáneamente dos instancias al
reemplazar una revisión (despliegue nuevo con tráfico migrando) o al reiniciar una instancia, y
el candado en memoria no cruza procesos. La carrera sigue siendo posible, aunque improbable;
conviene no desplegar nuevas revisiones mientras se crean urnas.

**Soluciones distribuidas posibles (a explicar y aprobar antes de implementar):**
1. **Creación atómica en Cloud Storage con la API** (`google-cloud-storage`, escritura con
   `if_generation_match=0`): crea el objeto solo si no existe; si otra instancia lo creó antes, se
   lee el existente. Elimina la carrera sin infraestructura nueva. Costo: dependencia nueva y un
   segundo almacén de claves en el código (el actual usa archivos).
2. **Guardar las claves en Secret Manager**, un secreto por elección, con la misma lógica de
   "crear si no existe". Más gestionado, pero más caro y con límites de cuota.
3. **Guardar las claves en una tabla de Cloud SQL** (`INSERT ... ON CONFLICT DO NOTHING`).
   Atómico por definición, pero mezcla las claves privadas con una base de datos y necesita una
   base propia para Blind Signature (hoy no tiene ninguna).

Recomendación: `--max-instances 1` ahora, y la opción 1 si se necesita escalar.
