# syntax=docker/dockerfile:1
# Node 22.19+ ejecuta TypeScript de forma nativa; Undici configura el cliente mTLS.
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production \
    GATEWAY_PORT=8088
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --chown=node:node src ./src
USER node
EXPOSE 8088
HEALTHCHECK --interval=5s --timeout=3s --retries=20 \
  CMD node src/healthcheck.ts
CMD ["node", "src/server.ts"]
