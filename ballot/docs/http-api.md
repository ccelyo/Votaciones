# API HTTP de voto y MongoDB (M7)

Servicio `ballot` (Go). API pública, anónima y sin sesión. El navegador debe
llamarla con `fetch(..., { credentials: "omit" })`: el servidor no emite
cookies, no lee cabeceras de identidad, no registra cuerpos ni IPs, y su CORS
nunca permite credenciales.

Todos los campos binarios usan **base64url sin padding**. Los errores
responden `{"error": "<código>"}`.

## `GET /v1/elections/{election_id}/parameters`

Parámetros públicos para construir la papeleta y cegar el token.

```json
{
  "election_id": "gobernacion-antioquia-2027",
  "status": "open",
  "options": ["candidato-1", "candidato-2", "voto-en-blanco"],
  "encryption_public_key": "…",
  "token_keys": [{ "kid": "key-1", "public_key_der": "…", "signature_variant": "RSABSSA-SHA384-PSS-Randomized" }],
  "opens_at": "2027-10-29T13:00:00Z",
  "closes_at": "2027-10-29T21:00:00Z",
  "signed_parameters": "…",
  "parameter_signing_key_id": "params-1",
  "parameter_signature_algorithm": "…",
  "parameter_signature": "…"
}
```

| Código | `error` |
| --- | --- |
| 200 | — |
| 404 | `election_not_found` |

## `POST /v1/ballots`

`Content-Type: application/json`, cuerpo máximo 2 MiB, campos desconocidos
rechazados (no se puede colar `user_id`, etc.).

```json
{
  "election_id": "gobernacion-antioquia-2027",
  "token": "<sobre del token firmado, tal cual>",
  "encrypted_vote": "<base64url>",
  "proof": "<base64url>"
}
```

Respuesta (`201` voto nuevo, `200` reintento idéntico con el mismo recibo):

```json
{
  "election_id": "gobernacion-antioquia-2027",
  "ballot_hash": "<base64url SHA-256>",
  "receipt": "<recibo Ed25519 canónico>",
  "replayed": false
}
```

| Código | `error` | Causa |
| --- | --- | --- |
| 400 | `invalid_request` | JSON inválido, campo desconocido o base64 inválido |
| 400 | `invalid_token` / `invalid_ballot` | Sobre del token o papeleta malformados |
| 403 | `invalid_token_signature` | Firma ciega no válida o `kid` desconocido |
| 403 | `token_election_mismatch` | Token de otra elección o elección inexistente |
| 409 | `token_already_spent` | El token ya se usó con otra papeleta |
| 409 | `election_not_open` | Urna cerrada o fuera de horario |
| 413 | `request_too_large` | Cuerpo > 2 MiB |
| 415 | `unsupported_media_type` | No es `application/json` |
| 422 | `invalid_proof` | Prueba de validez rechazada |
| 503 | `timeout` | Plazo de 10 s excedido |

## `GET /v1/elections/{election_id}/results`

Conteo final agregado. Solo responde con la urna cerrada, para que no haya
resultados parciales mientras se vota. Lee únicamente `encrypted_vote`, nunca
el `_id` (token) ni `seq`, así que el conteo no se puede asociar a un recibo.

En el Prototipo 1 `encrypted_vote` contiene la opción elegida en UTF-8 (sin
cifrar; ver `internal/ballot/tally.go`). La papeleta sigue sin datos del
votante. Las papeletas cuyo contenido no es exactamente una opción (por
ejemplo, las emitidas con el antiguo `stub-encrypted-vote`) cuentan como
inválidas.

```json
{
  "election_id": "gobernacion-antioquia-2027",
  "total_ballots": 4,
  "invalid_ballots": 1,
  "results": [
    { "option": "candidato-1", "votes": 2 },
    { "option": "candidato-2", "votes": 1 },
    { "option": "voto-en-blanco", "votes": 0 }
  ]
}
```

| Código | `error` |
| --- | --- |
| 200 | — |
| 404 | `election_not_found` |
| 409 | `election_not_closed` |

## `GET /healthz`, `GET /readyz`

Liveness y readiness (`readyz` hace ping a MongoDB).

## MongoDB

Base `MONGODB_DATABASE` (por defecto `votaciones`). Requiere **replica set**
(transacciones); Atlas lo es por defecto.

`ballots`:

| Campo | Tipo | Nota |
| --- | --- | --- |
| `_id` | string | SHA-256 hex del token: un token, una papeleta |
| `election_id` | string | |
| `seq` | int64 | Posición en la cadena; índice único `(election_id, seq)` |
| `encrypted_vote` | binary | P1: la opción en UTF-8 |
| `proof` | binary | |
| `previous_hash` | binary(32) | 32 ceros para la primera |
| `ballot_hash` | binary(32) | Índice único `(election_id, ballot_hash)` |

`elections` (registradas por identity vía gRPC):

| Campo | Tipo | Nota |
| --- | --- | --- |
| `_id` | string | `election_id` |
| `options`, `encryption_public_key`, `token_keys[]` | | Parámetros públicos; `token_keys` admite rotación por `kid` |
| `opens_at`, `closes_at` | date | Ventana de votación |
| `signed_parameters`, `parameter_*` | | Firma de identity sobre los parámetros |
| `closed` | bool | Cierre irreversible |
| `seq`, `head_hash` | int64, binary(32) | Cabeza de la cadena = participación |

Cada voto se inserta en una transacción que lee la elección, comprueba que la
urna esté abierta, inserta la papeleta y avanza `seq`/`head_hash` condicionado
al `seq` leído y a `closed: false`. Como todo voto escribe el documento de la
elección, un `CloseElection` concurrente siempre choca con él: cuando el cierre
responde, ya no puede entrar ningún voto, incluso con varias instancias. Si
otra instancia ganó la carrera, se reintenta. El índice único
`(election_id, seq)` impide bifurcaciones.
No se guarda marca de tiempo para no permitir correlacionar la papeleta con
la hora de emisión del token en identidad; el orden lo da `seq`.

## Variables de entorno

| Variable | Default | |
| --- | --- | --- |
| `BALLOT_RECEIPT_PRIVATE_KEY` | — (obligatoria) | Ed25519 de 64 bytes (semilla ‖ clave pública) en base64 |
| `MONGODB_URI` | vacío → memoria | Sin ella elecciones y papeletas se pierden al reiniciar |
| `MONGODB_DATABASE` | `votaciones` | |
| `PORT` / `BALLOT_HTTP_ADDR` | `:8080` | `PORT` lo fija Cloud Run |
| `BALLOT_GRPC_ADDR` | `127.0.0.1:9091` | API admin interna (identity) |
| `BALLOT_ALLOWED_ORIGINS` | vacío | Orígenes CORS separados por coma |

## Local

Ver `.env.example` para una plantilla con todas las variables.

```bash
# Semilla de 32 bytes seguida de su clave pública; 64 bytes aleatorios no sirven.
export BALLOT_RECEIPT_PRIVATE_KEY=$(python -c "import base64;from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey as K;k=K.generate();print(base64.b64encode(k.private_bytes_raw()+k.public_key().public_bytes_raw()).decode())")
docker compose up --build
# Integración contra Mongo real:
MONGODB_TEST_URI="mongodb://localhost:27017/?replicaSet=rs0&directConnection=true" go test ./internal/mongostore/
```

## GCP

Propuesta para el prototipo:

1. **MongoDB Atlas sobre GCP** (región `southamerica-east1` o `us-east1`; GCP no
   tiene región en Colombia) con Private Service Connect hacia la VPC.
2. Imagen en **Artifact Registry**; secretos (`MONGODB_URI`,
   `BALLOT_RECEIPT_PRIVATE_KEY`) en **Secret Manager**.
3. **Cloud Run** detrás del Load Balancer + Cloud Armor, con
   `--ingress internal-and-cloud-load-balancing` y conector/Direct VPC egress.

```bash
gcloud run deploy ballot \
  --image REGION-docker.pkg.dev/PROYECTO/votaciones/ballot:TAG \
  --region REGION --ingress internal-and-cloud-load-balancing \
  --network VPC --subnet SUBNET --vpc-egress private-ranges-only \
  --min-instances 1 \
  --set-secrets MONGODB_URI=mongodb-uri:latest,BALLOT_RECEIPT_PRIVATE_KEY=ballot-receipt-key:latest \
  --set-env-vars MONGODB_DATABASE=votaciones,BALLOT_ALLOWED_ORIGINS=https://FRONTEND
```

### Limitaciones abiertas

- **Lecturas por voto**: cada voto consulta la elección en Mongo (estado,
  clave del token y transacción). Si la carga lo exige, se puede cachear la
  clave pública por `kid`, que es inmutable.
- **gRPC en Cloud Run**: Cloud Run expone un solo puerto, así que la API admin
  gRPC (9091) no es alcanzable desde identity. Opciones: servir gRPC y HTTP en
  el mismo puerto (h2c) restringiendo `/votaciones.ballot.v1.*` al tráfico
  interno, o desplegar en GKE/Compute Engine. Decisión pendiente del equipo.
- **Prueba de validez**: `StructuralProofVerifier` solo valida presencia y
  tamaño. Debe reemplazarse cuando se acuerde el esquema de cifrado/prueba.
