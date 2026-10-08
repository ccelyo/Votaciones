# proto

Shared gRPC contracts for the voting system.

This folder is the single source of truth for how services talk to each other. The `.proto` files here define the messages and RPC methods used between `identity` (Python) and `ballot` (Go), over gRPC with mTLS.

## Generating code

Generated code lives inside each service, not here. Run from the repository root.

**Go** (`ballot`):

```bash
protoc --go_out=. --go_opt=module=github.com/ccelyo/Votaciones \
       --go-grpc_out=. --go-grpc_opt=module=github.com/ccelyo/Votaciones \
       proto/ballot.proto
```

**Python** (`identity`):

```bash
python -m grpc_tools.protoc -I proto \
       --python_out=identity/app/pb \
       --grpc_python_out=identity/app/pb \
       proto/ballot.proto
```

## Guidelines

- Never reuse or renumber an existing field; mark removed fields as `reserved`.
- Add new fields instead of changing the type of existing ones.
- Regenerate code in every service after editing a `.proto` file.
