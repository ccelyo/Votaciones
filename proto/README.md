# Contratos compartidos

`ballot.proto` es el contrato gRPC de administración entre `identity` y `ballot`.
Su API registra parámetros públicos de una elección, añade claves de
verificación de tokens para permitir rotación por `kid`, cierra la urna, cuenta
participación y consulta su estado. No expone papeletas ni resultados.

## Generación

Ejecutar desde la raíz del monorepo. Los archivos generados se versionan dentro
de cada servicio.

**Go (`ballot`)**:

```bash
protoc -I . \
  --go_out=. --go_opt=module=github.com/ccelyo/Votaciones \
  --go-grpc_out=. --go-grpc_opt=module=github.com/ccelyo/Votaciones \
  proto/ballot.proto
```

Generadores usados por `ballot`:

```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.2
```

**Python (`identity`)**:

```bash
python -m grpc_tools.protoc -I proto \
  --python_out=identity/app/pb \
  --grpc_python_out=identity/app/pb \
  ballot.proto

# El generador emite un import absoluto; dentro del paquete debe ser relativo.
sed -i '' 's/^import ballot_pb2 as ballot__pb2/from . import ballot_pb2 as ballot__pb2/' \
  identity/app/pb/ballot_pb2_grpc.py   # en Linux: sed -i sin ''
```

## Estado de acuerdos

- Los métodos y mensajes gRPC están implementados en Go.
- El primer prototipo usa un listener gRPC interno sin mTLS, por decisión de
  alcance. La identidad del cliente y el despliegue de red quedan pendientes.
- El formato de `signed_parameters`, la firma de esos bytes y el formato exacto
  del token deben acordarse con M1/M6. La propuesta de token está descrita en
  `ballot/docs/qa/happy-path.md`.
- El contrato del adaptador Mongo para insertar el token gastado y la papeleta
  completa en una operación atómica debe acordarse con M7.

## Compatibilidad

- No reutilizar ni renumerar campos existentes.
- Para retirar un campo, marcar su número y nombre como `reserved`.
- Añadir campos para cambios compatibles.
