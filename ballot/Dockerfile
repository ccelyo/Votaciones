# syntax=docker/dockerfile:1
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ballot .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ballot /ballot
ENV BALLOT_HTTP_ADDR=:8080
EXPOSE 8080 9091
USER nonroot:nonroot
ENTRYPOINT ["/ballot"]
