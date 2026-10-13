# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ballot .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ballot /ballot
# Dentro del contenedor el gRPC debe escuchar en todas las interfaces para que
# identity lo alcance por la red de Docker; publícalo en el host solo en 127.0.0.1.
ENV BALLOT_HTTP_ADDR=:8080 \
    BALLOT_GRPC_ADDR=0.0.0.0:9091
EXPOSE 8080 9091
USER nonroot:nonroot
ENTRYPOINT ["/ballot"]
