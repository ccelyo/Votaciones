import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import next from "next";

const port = Number(process.env.PORT ?? 3000);
const certFile = process.env.PLATFORM_TLS_CERT_FILE;
const keyFile = process.env.PLATFORM_TLS_KEY_FILE;
const caFile = process.env.PLATFORM_TLS_CLIENT_CA_FILE;
const tlsRequired = process.env.PLATFORM_TLS_REQUIRED === "true";

if (tlsRequired && (!certFile || !keyFile || !caFile)) {
  throw new Error(
    "PLATFORM_TLS_REQUIRED needs TLS_CERT_FILE, TLS_KEY_FILE and TLS_CLIENT_CA_FILE",
  );
}

const app = next({ dev: false, hostname: "0.0.0.0", port });
await app.prepare();
const handle = app.getRequestHandler();
const tlsOptions = tlsRequired
  ? {
      cert: readFileSync(certFile),
      key: readFileSync(keyFile),
      ca: readFileSync(caFile),
      minVersion: "TLSv1.2",
      requestCert: true,
      rejectUnauthorized: true,
    }
  : undefined;
const server = tlsOptions
  ? createServer(tlsOptions, (request, response) => void handle(request, response))
  : (await import("node:http")).createServer((request, response) =>
      void handle(request, response),
    );

if (tlsRequired) {
  server.on("secureConnection", (socket) => {
    const sans = socket.getPeerCertificate().subjectaltname?.split(", ") ?? [];
    if (!socket.authorized || !sans.includes("DNS:waf")) socket.destroy();
  });
}

server.listen(port, "0.0.0.0", () => {
  console.log(`Platform listening on ${tlsRequired ? "https" : "http"} port ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
