# syntax=docker/dockerfile:1
# Node 22.18+ ejecuta TypeScript de forma nativa: no hay paso de compilación
# y el Gateway no tiene dependencias en tiempo de ejecución.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    GATEWAY_PORT=8088
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 8088
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD wget -qO- http://127.0.0.1:8088/healthz >/dev/null || exit 1
CMD ["node", "src/server.ts"]
