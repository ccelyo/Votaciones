import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { createGateway } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createUpstreamTransport, loadGatewayTlsOptions } from "./transport.ts";

const config = loadConfig();
const upstreamTransport = createUpstreamTransport(config);
const gateway = createGateway(config, { fetch: upstreamTransport.fetch });

const handler = (req: Parameters<typeof gateway.handle>[0], res: Parameters<typeof gateway.handle>[1]) => {
  void gateway.handle(req, res);
};
const tlsOptions = loadGatewayTlsOptions(config);
const server = tlsOptions
  ? createHttpsServer(tlsOptions, handler)
  : createHttpServer(handler);

if (tlsOptions) {
  server.on("secureConnection", (socket) => {
    const sans: string[] = socket.getPeerCertificate().subjectaltname?.split(", ") ?? [];
    if (
      !socket.authorized ||
      !sans.some((san) => san === "DNS:waf" || san === "DNS:platform" || san === "DNS:gateway")
    ) {
      socket.destroy();
    }
  });
}

server.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "gateway listening",
      port: config.port,
      authMode: config.authMode,
      services: config.upstreams,
      tls: Boolean(tlsOptions),
    }),
  );
  if (config.authMode === "passthrough") {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "GATEWAY_AUTH_MODE=passthrough: los servicios validan la sesión; define GATEWAY_JWKS_URL para validar el JWT RS256 de identity",
      }),
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void upstreamTransport.close().finally(() => process.exit(0));
    });
  });
}
