# M4 — Frontend B: votación y criptografía (Prototype 1)

Todo el texto visible está en español.

## Rutas (M4; M3 posee /login y /admin)

- `/elecciones/[id]/votar` — elige opción → obtiene token anónimo → cifra y envía.
- `/elecciones/[id]/recibo?recibo=…` — muestra y verifica el recibo Ed25519.

Demo sin backend: usa la elección `eleccion-demo`.

## Librería `lib/m4/`

| Archivo | Qué hace | Paridad con Go |
|---|---|---|
| `token.ts` | Mensaje canónico, sobre base64url JSON, `TokenID = hex(SHA-256(sobre))` | `ballot/internal/token/token.go` |
| `blind.ts` | Armazón puro-TS `preparar/cegar/descegar` con BigInt + `SPKI DER → (n,e)` | `circl/blindrsa` (PSS exacto pendiente M6) |
| `encryptor.ts` | Interfaz `Cifrador` + `CifradorSimulado` (`stub-encrypted-vote` / `stub-benaloh-proof`) | `happy_path_test.go:19-26` |
| `receipt.ts` | Sobre de recibo + `verificarRecibo` (WebCrypto Ed25519) | `token/receipt.go` |
| `api.ts` | Tipos propuestos `GET parámetros` / `POST papeletas`; `enviarPapeleta` usa `credentials:"omit"` | `01-Prototype.md §9, §15` (pendiente M1/M6/M7) |
| `tokenStore.ts` | Token solo en memoria (nunca `localStorage`/cookies/URL) | Separación identidad↔papeleta |
| `mocks.ts` | Elección demo + recibo demo con firma Ed25519 real | Solo P1 |

## Reglas de anonimato

- `POST /papeletas`: `credentials: "omit"`, solo `Content-Type: application/json`, sin
  `Authorization` ni cookies.
- Reintento idéntico (mismo token + misma papeleta) devuelve el mismo recibo byte a byte;
  token reutilizado con otra papeleta es `409 doble-voto` (paridad con `SpendReplay`/`SpendConflict`
  de `ballot/internal/ballot/acceptor.go`).

## Pendientes (ver `platform/M4_REMINDER.md`)

- M6: variante RSABSSA exacta, codificación PSS y vectores de interop TS↔Go.
- M7: `POST /ballots` final, `ProofVerifier` real, `CommitStore` Mongo.
- M1: firma de parámetros de elección.
- P2: `CifradorElGamal` real + alcance Benaloh.

## Probar

Cuando haya Node disponible:

```bash
cd platform
node --test lib/m4/__tests__/token.test.ts
npm run dev # abrir /elecciones/eleccion-demo/votar
```
