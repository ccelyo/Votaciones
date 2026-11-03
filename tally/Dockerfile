# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tally .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/tally /tally
ENV TALLY_HTTP_ADDR=:8092
EXPOSE 8092
USER nonroot:nonroot
ENTRYPOINT ["/tally"]
