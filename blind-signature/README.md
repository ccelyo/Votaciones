# Blind Signature (Python)

Firma ciega RSA (RFC 9474, `RSABSSA-SHA384-PSS-Randomized`). Componente independiente
de la vista C&C del Prototipo 2: **solo lo llama Identity** (`REST/JSON`), en la red
interna de Docker. No tiene `ports` en el compose y el Gateway no tiene ruta hacia él.

## Contrato

| Endpoint | Request | Response |
|---|---|---|
| `GET /v1/keys/{election_id}` | – | `{election_id, kid, variant, public_key_der}` (SPKI DER, base64url). Crea la clave de la elección si no existe. |
| `POST /v1/sign` | `{election_id, blinded_message}` (base64url, 256 bytes) | `{kid, variant, blind_signature}` |
| `GET /health` | – | `{status: "ok"}` |

Errores: `400` mensaje cegado inválido o `election_id` inválido, `401` si falta o no coincide `X-Internal-Token`,
`422` si el body trae campos extra (p. ej. `user_id`).

`/v1/keys/*` y `/v1/sign` exigen **siempre** la cabecera `X-Internal-Token` (secreto compartido con
Identity, comparado en tiempo constante). Solo `/health` es público, para el healthcheck. El secreto
nunca se imprime en logs ni en mensajes de error; si `BLINDSIG_API_KEY` falta o está vacía el
servicio **no arranca** (`RuntimeError: BLINDSIG_API_KEY is required ...`).

## Anonimato

- El esquema es estricto (`extra=forbid`): el servicio **no puede** recibir identidad del votante.
- No guarda ni registra el mensaje cegado ni la firma; no tiene base de datos.
- Una clave RSA-2048 por elección (`keys/election-<id>.pem`, modo 0600, volumen Docker).
  La privada nunca sale del servicio.
- El navegador ciega y desciega; el servicio solo ejecuta `BlindSign` (`s = m^d mod n`).

## Configuración

| Variable | Defecto |
|---|---|
| `BLINDSIG_KEYS_DIR` | `./keys` |
| `BLINDSIG_API_KEY` | **obligatoria**: sin ella el servicio no arranca |

## Ejecutar y probar

```bash
uv sync
uv run pytest                     # incluye los vectores RFC 9474 (ballot/internal/token/testdata)
uv run uvicorn app.main:app --port 8100
```

## Despliegue en Cloud Run

Ver [`DEPLOY.md`](DEPLOY.md) (variables, secretos, conexión interna con Identity, persistencia
de claves y concurrencia) y [`cloudbuild.yaml`](cloudbuild.yaml).
