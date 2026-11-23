import { readFileSync } from "node:fs";
import { Agent } from "undici";

import type { GatewayConfig } from "./config.ts";

export function createUpstreamTransport(config: GatewayConfig): {
  fetch: typeof fetch;
  close: () => Promise<void>;
} {
  if (!config.upstreamTlsRequired) {
    return { fetch, close: async () => {} };
  }
  const dispatcher = new Agent({
    connect: {
      ca: readFileSync(config.upstreamTlsCaFile!),
      cert: readFileSync(config.upstreamTlsCertFile!),
      key: readFileSync(config.upstreamTlsKeyFile!),
      rejectUnauthorized: true,
    },
  });
  const secureFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Agent });
  return { fetch: secureFetch, close: () => dispatcher.close() };
}

export function loadGatewayTlsOptions(config: GatewayConfig) {
  if (!config.tlsRequired) return undefined;
  return {
    cert: readFileSync(config.tlsCertFile!),
    key: readFileSync(config.tlsKeyFile!),
    ca: readFileSync(config.tlsClientCaFile!),
    minVersion: "TLSv1.2" as const,
    requestCert: true,
    rejectUnauthorized: true,
  };
}
