import { readFileSync } from "node:fs";
import { request } from "node:https";

const requestHealth = request(
  {
    host: "localhost",
    port: Number(process.env.GATEWAY_PORT ?? 8088),
    path: "/healthz",
    method: "GET",
    ca: readFileSync(process.env.GATEWAY_TLS_CLIENT_CA_FILE!),
    cert: readFileSync(process.env.GATEWAY_TLS_CERT_FILE!),
    key: readFileSync(process.env.GATEWAY_TLS_KEY_FILE!),
    rejectUnauthorized: true,
    timeout: 2000,
  },
  (response) => {
    response.resume();
    process.exitCode = response.statusCode === 200 ? 0 : 1;
  },
);
requestHealth.on("error", () => {
  process.exitCode = 1;
});
requestHealth.end();
