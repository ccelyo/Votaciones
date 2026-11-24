# CLI de administración (Java)

Cliente de consola para los administradores. Habla **solo con el API Gateway**
(`https://localhost:8088`, WAF → Gateway) y únicamente por rutas `/api/...` de su catálogo:
inicia sesión con usuario, contraseña y MFA, guarda el **JWT** y lo usa para crear, abrir y
cerrar urnas, gestionar el padrón y los usuarios, lanzar el escrutinio y consultar resultados.
`ApiClient` rechaza cualquier ruta que no empiece por `/api/`, así que la CLI no puede
saltarse el WAF ni el Gateway llamando directamente a un servicio (escenario de seguridad 2).

Los resultados se leen de la API pública de `ballot` **sin credenciales**: la CLI nunca envía el
JWT a la zona de votación.

## Compilar

Requiere JDK 21. No hace falta instalar Maven: se usa el wrapper.

```bash
cd admin-cli
./mvnw package            # Windows: mvnw.cmd package — compila, prueba y genera el jar
java -jar target/votaciones-admin.jar --help
```

Con un alias queda más cómodo: `alias votaciones-admin='java -jar /ruta/admin-cli/target/votaciones-admin.jar'`.

## Configuración

| Variable / opción | Por defecto | Uso |
|---|---|---|
| `VOTACIONES_API_URL` / `--api-url` | `https://localhost:8088` | API Gateway |
| `VOTACIONES_TLS_CA_FILE` | — | CA de confianza para validar el certificado del Gateway (útil con la CA local de desarrollo) |
| `VOTACIONES_HOME` | `~/.votaciones` | Carpeta de `session.json` (JWT, usuario, rol, `exp`) |

La sesión guardada solo se usa contra la misma `--api-url` con la que se inició y no se envía si
su `exp` ya pasó. Los resultados se consultan por la ruta anónima del Gateway; el JWT no se envía
a Ballot. `--json` imprime la respuesta del servidor tal cual (útil en scripts).

## Comandos

```text
votaciones-admin login [-u USUARIO] [--password-stdin] [--mfa-code CÓDIGO]
votaciones-admin whoami
votaciones-admin logout

votaciones-admin elections list
votaciones-admin elections create --name NOMBRE --option A --option B [...]
                                  [--opens now|FECHA] (--closes FECHA | --duration 8h)
                                  (--encryption-key BASE64URL | --encryption-key-file ARCHIVO)
                                  [--draft]
votaciones-admin elections open ID           # publica en ballot una urna en borrador
votaciones-admin elections close ID [--yes]  # irreversible: pide confirmación
votaciones-admin elections status ID         # estado en identity y ballot + papeletas
votaciones-admin elections tally ID [--yes]  # escrutinio: cierra si hace falta y cuenta
votaciones-admin elections results ID        # conteo de una urna ya cerrada

votaciones-admin voters list ELECCIÓN
votaciones-admin voters add ELECCIÓN USUARIO_ID... [--ineligible]
votaciones-admin voters set ELECCIÓN USUARIO_ID (--eligible | --ineligible)

votaciones-admin users list
votaciones-admin users create USUARIO [--role admin|voter] [--password-stdin]
votaciones-admin users disable|enable USUARIO_ID
```

Las fechas son `now` o ISO-8601: `2026-11-03T08:00` (hora local) o con zona
(`2026-11-03T13:00:00Z`). Las duraciones: `90m`, `8h`, `2d`.

Sin `--password-stdin`, las contraseñas se piden sin eco.

## Ejemplo

```text
PS> $env:VOTACIONES_TLS_CA_FILE="..\.dev-certs\ca-public\ca.crt"
PS> votaciones-admin login -u admin1
Contraseña:
Código MFA: 123456
Sesión iniciada como admin1 (admin) en https://localhost:8088. Expira: 2026-11-02T20:20:05.

PS> votaciones-admin elections create --name "Consejo Estudiantil 2026" `
    --option Alpha --option Beta --option "Voto en blanco" `
    --duration 8h --encryption-key cHVibGlj --draft
Urna 1 creada (draft).
Para publicarla: votaciones-admin elections open 1

PS> votaciones-admin elections open 1
Urna 1: open.

PS> votaciones-admin voters add 1 2 3

PS> votaciones-admin elections tally 1
La urna 1 sigue abierta. Cerrarla es irreversible. ¿Cerrar y escrutar? [s/N] s
Urna 1 cerrada.
Resultados de la urna 1
OPCIÓN          VOTOS  %
Alpha           2      66.7%
Beta            1      33.3%
Voto en blanco  0      0.0%
Papeletas: 3 (válidas 3, inválidas 0)
```

## Códigos de salida

| Código | Significado |
|---|---|
| `0` | Éxito (o el usuario canceló una confirmación) |
| `1` | Error del servidor o de red (se imprime `Error <HTTP> <código>: <mensaje>`) |
| `2` | Uso incorrecto: opción inválida, fecha mal escrita, id no numérico |
| `3` | Sin sesión, sesión expirada o rechazada (`401`): ejecutar `login` |

## Pruebas

`./mvnw test` levanta un servidor HTTP en memoria que hace de API Gateway
(`FakeServer`) y ejecuta la CLI real. Una prueba ejecuta todos los comandos y comprueba que
cada petición va a una ruta `/api/...`. Cubre el login con MFA, la sesión (ausente, vencida, de
otro servidor, rechazada), el cuerpo exacto de cada operación administrativa, las
confirmaciones, el escrutinio sin enviar credenciales a ballot y el mapeo de errores.

## Estructura

| Archivo | Responsabilidad |
|---|---|
| `AdminCli.java` | Comando raíz, opciones globales, manejo de errores y códigos de salida |
| `ApiClient.java` | HTTP/JSON (HTTP/1.1) hacia el Gateway, solo rutas `/api/...`, y traducción de errores |
| `SessionStore.java` | `session.json`: JWT y claims (`username`, `role`, `exp`) |
| `commands/` | `login`, `logout`, `whoami`, `elections`, `voters`, `users` |
