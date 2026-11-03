# Eventos de elección que consume Ballot

Ballot escucha la cola durable `ballot.elections`, enlazada al exchange
`election.events` (topic) con las routing keys `election.created` y
`election.closed`. Usa la misma variable `BALLOT_RABBITMQ_URI` que el aviso
`votes.cast`. Si la variable está vacía, la urna sigue recibiendo elecciones
por el gRPC interno.

Un evento repetido no duplica la elección ni vuelve a abrir una urna cerrada.

## `election.created`

El contrato de analytics lleva la elección, las opciones y la ventana de
tiempo. Con solo eso Ballot confirma el mensaje y no abre la urna: faltan las
claves para verificar el token.

Para que la urna acepte papeletas, el mismo evento incluye además los
parámetros públicos, en base64url sin padding. Analytics ignora estos campos.

```json
{
  "election_id": "consejo-superior-2026",
  "name": "Consejo Superior Universitario 2026",
  "options": ["candidata-1", "voto-en-blanco"],
  "blank_option": "voto-en-blanco",
  "opens_at": "2026-10-20T13:00:00Z",
  "closes_at": "2026-10-20T21:00:00Z",
  "encryption_public_key": "…",
  "token_keys": [
    {
      "kid": "key-1",
      "public_key_der": "…",
      "signature_variant": "RSABSSA-SHA384-PSS-Randomized"
    }
  ],
  "signed_parameters": "…",
  "parameter_signing_key_id": "params-1",
  "parameter_signature_algorithm": "Ed25519",
  "parameter_signature": "…"
}
```

`public_key_der` es la clave pública RSA en SPKI DER, la misma que hoy viaja
por `RegisterElection`.

## `election.closed`

```json
{ "election_id": "consejo-superior-2026", "closed_at": "2026-10-20T21:00:00Z" }
```

Cierra la urna. A partir de ese momento Ballot rechaza papeletas nuevas con
`election_not_open`. Si la elección todavía no está registrada, el mensaje se
confirma y queda anotado en el log.
