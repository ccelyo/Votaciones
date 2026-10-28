import { createServer } from "node:http";

import { createGateway } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const gateway = createGateway(config);

const server = createServer((req, res) => {
  void gateway.handle(req, res);
});

server.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "gateway listening",
      port: config.port,
      authMode: config.authMode,
      services: config.upstreams,
    }),
  );
  if (config.authMode === "passthrough") {
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "GATEWAY_AUTH_MODE=passthrough: los servicios validan la sesión; define GATEWAY_JWT_SECRET cuando Auth emita JWT",
      }),
    );
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
