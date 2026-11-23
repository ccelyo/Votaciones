import "server-only";

import { readFileSync } from "node:fs";
import { Agent } from "undici";

const required = process.env.PLATFORM_GATEWAY_TLS_REQUIRED === "true";
const caFile = process.env.PLATFORM_GATEWAY_TLS_CA_FILE;
const certFile = process.env.PLATFORM_GATEWAY_TLS_CERT_FILE;
const keyFile = process.env.PLATFORM_GATEWAY_TLS_KEY_FILE;

if (required && (!caFile || !certFile || !keyFile)) {
  throw new Error(
    "PLATFORM_GATEWAY_TLS_REQUIRED needs TLS_CA_FILE, TLS_CERT_FILE and TLS_KEY_FILE",
  );
}

const dispatcher = required
  ? new Agent({
      connect: {
        ca: readFileSync(caFile!),
        cert: readFileSync(certFile!),
        key: readFileSync(keyFile!),
        rejectUnauthorized: true,
      },
    })
  : undefined;

export function fetchGateway(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const secureInit = { ...init, redirect: "manual" as const };
  if (!dispatcher) return fetch(input, secureInit);
  return fetch(input, {
    ...secureInit,
    dispatcher,
  } as RequestInit & { dispatcher: Agent });
}
