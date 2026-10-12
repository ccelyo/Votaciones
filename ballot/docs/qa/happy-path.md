# QA del Happy Path

Alcance de esta primera versión: `ballot/` y `proto/`. No se implementan los
servicios Python o Next.js. Las pruebas simulan identidad y navegador con
claves y pruebas criptográficas de prueba; el cifrado y Benaloh son stubs. No se
añaden Redis, Pub/Sub ni servicios auxiliares.

## Paso → prueba → estado

| Paso | Prueba / componente | Estado |
| --- | --- | --- |
| 1. Login y MFA | Pertenece a `identity`; no está en este repo de Go. | Fuera de alcance; no probado aquí. |
| 2. Token anónimo | `internal/token`: verificación RSABSSA, elección incorrecta, firma alterada, `kid` rotado y vectores RFC 9474. La prueba genera y finaliza una firma ciega localmente. | Cubierto en Go; cliente Python de M6 pendiente. |
| 3. Parámetros de elección | `RegisterElection` y `AddTokenVerificationKey` en `internal/server`, vía `bufconn`; valida parámetros y permite añadir un `kid` sin invalidar tokens previos. | Cubierto en memoria; formato firmado y verificación de esa firma pendientes de acuerdo M1/M6. |
| 4. Cifrado local | El test E2E entrega ciphertext de prueba a `internal/ballot.Acceptor`. | Stub; cifrado real es de platform. |
| 5. Auditoría Benaloh | El test entrega una prueba de validez de prueba mediante `ProofVerifier`. | Stub; Benaloh real es de platform. |
| 6. Envío HTTP sin sesión | `internal/httpapi`: `POST /v1/ballots` y `GET /v1/elections/{id}/parameters` (ver `docs/http-api.md`). Tests con `httptest`: recibo, replay, doble voto, firma falsa, elección errónea, cierre, CORS sin credenciales. | Cubierto en Go. |
| 7. Validación y registro | `Acceptor.Accept` verifica token y prueba. `CommitStore.Commit` elige el hash anterior, calcula el nuevo hash e inserta el documento completo. El fake usa `tokenID` como clave y prueba replay, conflicto, cadena y concurrencia. | Adaptador `internal/mongostore` (transacción, `_id` = tokenID, `seq` único) probado contra MongoDB 8.0 replica set real: concurrencia, carrera cierre/voto y elecciones persistidas en `elections`. |
| 8. Recibo firmado | `SignReceipt` / `VerifyReceipt`, Ed25519. El test repite la petición y compara el recibo serializado byte a byte. La clave se carga desde `BALLOT_RECEIPT_PRIVATE_KEY`. | Cubierto en Go; entrega HTTP al navegador pendiente de M7. |
| 9. Cierre y participación | `CloseElection` impide nuevos votos; `CountBallots` devuelve participación desde el repositorio configurado. Se prueba cierre repetido y voto posterior al cierre. | Cubierto en memoria; descifrado y resultados fuera de alcance. |

## Contratos propuestos pendientes de acuerdo

### Token con firma ciega

- Variante propuesta: `RSABSSA-SHA384-PSS-Randomized`, implementada con
  `github.com/cloudflare/circl/blindsign/blindrsa` v1.6.5.
- Mensaje que el navegador ciega:
  `"votaciones.ballot.anonymous-token.v1\0" || uint16_be(len(election_id)) || election_id || nonce`.
- `nonce` contiene 32 bytes aleatorios. RSABSSA añade el prefijo aleatorio de
  32 bytes; `prepared_message` es ese prefijo seguido del mensaje anterior.
- Sobre del token: JSON compacto con `v`, `kid`, `election_id`, `nonce`,
  `prepared_message` y `signature`, serializado como base64url sin padding.
- Las claves RSA llegan como DER SubjectPublicKeyInfo y `kid` permite mantener
  claves anteriores durante la rotación.
- `tokenID` es SHA-256 hexadecimal del sobre token exacto. M6 debe aceptar este
  encoding y compartir vectores con Go antes de fijarlo.

### Commit atómico y MongoDB

`SpentTokenStore.MarkSpent(ctx, electionID, tokenID, ballotHash)` cubre el
resultado `New`, `Replay` o `Conflict`, pero no recibe ciphertext ni prueba.
Por eso no basta, por sí solo, para insertar toda la papeleta junto con el token
gastado. Se propone que M7 implemente `CommitStore.Commit(ctx, BallotSubmission)`:
una inserción con `tokenID` como `_id`, ciphertext y prueba, devolviendo el
documento completo persistido. El adaptador calcula `previous_hash` y
`ballot_hash` del lado servidor; el navegador no envía el hash anterior. En
`Replay`, debe devolver el documento original para que el recibo sea idéntico.
Una papeleta diferente con el mismo token devuelve `Conflict`. La API y la
serialización Mongo quedan pendientes de acuerdo M7.

La primera versión asume un solo proceso `ballot`: el fake serializa inserciones
en memoria, y el guardado/cierre se coordinan dentro de ese proceso. Con Mongo,
M7 debe serializar la selección de la cabeza y la inserción; varias instancias
requieren coordinación adicional o un diseño de cadena distinto. La primera
versión usa `MemoryCommitStore` y no afirma persistencia entre reinicios.

### Hash de papeleta y recibo

- El hash propuesto es SHA-256 sobre el dominio
  `votaciones.ballot.encrypted-ballot.v1\0`, seguido de campos con longitud
  big-endian de 32 bits, la elección, ciphertext y prueba, y al final el hash
  anterior de 32 bytes. La primera papeleta usa 32 bytes cero como anterior.
- El recibo firma con Ed25519 el dominio
  `votaciones.ballot.receipt.v1\0`, la longitud y bytes de `election_id`, y el
  hash de papeleta de 32 bytes. No contiene token, datos personales ni voto
  claro. Ed25519 produce la misma firma para reintentos idénticos.
- El algoritmo y la canonicalización de la firma de parámetros de elección
  todavía necesitan una clave de verificación de identity y acuerdo M1/M6.

## Pruebas ejecutables

Ejecutar estos comandos desde `ballot/`. Todas las pruebas usan Go, `bufconn` y
dobles en memoria; no requieren PostgreSQL, MongoDB, Redis, Docker ni servicios
externos. La revisión se ejecutó con Go 1.27.2 y una revisión de Staticcheck
compatible con su formato de datos.

```bash
go install honnef.co/go/tools/cmd/staticcheck@v0.7.0-0.dev.0.20261009230814-452d5bb86b45
go test ./... -count=1
go test -race -cover ./...
go vet ./...
staticcheck ./...
govulncheck ./...
```

Las suites incluyen vectores RFC 9474, firmas y hashes alterados, elección
incorrecta, rotación de claves, token repetido/conflictivo, cierre irreversible,
recibos válidos/inválidos, casos de error gRPC con `bufconn`, health check,
límite de tamaño y concurrencia. No se ha ejecutado carga con k6/vegeta ni se ha
verificado una instancia Mongo real en esta primera versión.

## Pendientes de integración

- M6: confirmar variante, envelope, canonicalización y ejecutar un cliente Python
  real contra el servidor Go.
- M7: integrar handler HTTP, verificador de prueba, `CommitStore` Mongo insert-only,
  serialización de la cadena, conteo desde Mongo y devolución del recibo original en Replay.
- M1: acordar canonicalización y clave para verificar parámetros firmados.
- mTLS queda pospuesto por instrucción del alcance MVP. El listener inicia en
  `127.0.0.1:9091`; si se configura para otra interfaz, debe permanecer en la red
  interna y fuera del balanceador público.
- El proceso no registra tokens ni papeletas. Sus logs se limitan a arranque,
  apagado y errores operativos del listener.
