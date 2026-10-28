# syntax=docker/dockerfile:1
FROM rust:1.89-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked --bins \
    && mkdir -p /out && cp target/release/analytics target/release/publish-sample /out/

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /out/analytics /analytics
# Solo para desarrollo: `docker compose exec analytics /publish-sample`.
COPY --from=build /out/publish-sample /publish-sample
ENV ANALYTICS_HTTP_ADDR=0.0.0.0:8090
EXPOSE 8090
USER nonroot:nonroot
ENTRYPOINT ["/analytics"]
