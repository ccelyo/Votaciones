# Reglas de negocio de una elección (FA-05)

Implementadas en `app/rules.py` y aplicadas por `app/service.py`.

## Estados

```
            PATCH / DELETE
              ┌────┐
              ▼    │
  POST ──▶ draft ──┘ ──open──▶ open ──close (admin)──────────▶ closed
                                 └──fin de la ventana (auto)──▶
```

| Estado | Significado | Visible para votantes | Eventos al entrar |
| --- | --- | --- | --- |
| `draft` | Borrador editable. Sin llaves ni parámetros | No (404) | — |
| `open` | Publicada: parámetros congelados y firmados | Sí | `election.created`, `election.opened` |
| `closed` | Cerrada, irreversible | Sí | `election.closed` |

## Fase (derivada de la ventana de tiempo)

`status` es lo que se guarda; la **fase** se calcula con la hora actual y es lo que
decide si se aceptan papeletas.

| Fase | Condición | ¿Acepta papeletas? |
| --- | --- | --- |
| `draft` | `status = draft` | No |
| `scheduled` | `open` y `now < opens_at` | No |
| `voting` | `open` y `opens_at ≤ now < closes_at` | **Sí** |
| `ended` | `open` y `now ≥ closes_at` (antes del cierre automático) | No |
| `closed` | `status = closed` | No |

Ballot debe aplicar la misma regla con los datos de `election.created` /
`election.closed`: acepta solo si recibió `created`, no recibió `closed` y
`opens_at ≤ now < closes_at`.

## Ventanas de tiempo

| Regla | Valor |
| --- | --- |
| Fechas | RFC 3339 **con zona horaria**; se guardan en UTC |
| `closes_at > opens_at` | Siempre (también en la base: `ck_elections_window`) |
| Duración mínima | 5 minutos |
| Duración máxima | 31 días |
| Al crear / editar | `closes_at` debe estar al menos 5 min en el futuro |
| Al abrir | Igual; si `opens_at` ya pasó, se ajusta a la hora de apertura |
| Cierre automático | Al llegar `closes_at` (`ELECTION_AUTO_CLOSE`), con `closed_at = closes_at` |
| Cierre manual anticipado | Permitido al administrador; `closed_at = min(now, closes_at)` |

## Validaciones de contenido

| Campo | Regla |
| --- | --- |
| `name` | 1 a 150 caracteres, sin espacios al inicio/fin ni caracteres de control |
| `description` | Hasta 1000 caracteres (se permiten saltos de línea) |
| `options` | 2 a 100, únicas, sin espacios al inicio/fin, ≤ 128 bytes UTF-8 cada una |
| `blank_option` | Opcional; debe ser una de `options`. Habilita las métricas de voto en blanco de Analytics |

## Operaciones permitidas por estado

| Operación | `draft` | `open` | `closed` | Error si no |
| --- | --- | --- | --- | --- |
| Editar (`PATCH`) | ✔ | ✘ | ✘ | 409 `invalid_state` |
| Borrar (`DELETE`) | ✔ | ✘ | ✘ | 409 `invalid_state` |
| Abrir | ✔ | ✘ | ✘ | 409 `invalid_state` |
| Cerrar | ✘ | ✔ | ✔ (idempotente, sin nuevo evento) | 409 `invalid_state` |
| Llave privada de la urna | ✘ | ✘ | ✔ | 409 `invalid_state` |
| Ver detalle / parámetros (votante) | 404 | ✔ | ✔ | — |

## Permisos

| Rol | Puede |
| --- | --- |
| Público | `GET /elections/open`, `GET /keys`, salud |
| Usuario autenticado | Detalle y parámetros de elecciones publicadas |
| `admin` | Todo lo anterior + crear, editar, borrar, abrir, cerrar, estado, llave privada |

## Concurrencia y consistencia

- Cada transición bloquea la fila (`SELECT … FOR UPDATE`): dos cierres o aperturas
  simultáneos no generan eventos duplicados.
- Cambio de estado, bitácora y evento se guardan en **la misma transacción**.
