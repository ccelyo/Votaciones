import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createGateway } from "../src/app.ts";
import { type GatewayConfig, loadConfig } from "../src/config.ts";
import { signJwt } from "../src/jwt.ts";

const SECRET = "secreto-de-pruebas";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

// Servicio falso que registra lo que recibe y responde 200 JSON.
let recorded: Recorded[] = [];
let upstream: Server;
let upstreamUrl: string;
let slowDelayMs = 0;

before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    recorded.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    if (slowDelayMs) await new Promise((resolve) => setTimeout(resolve, slowDelayMs));
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Set-Cookie", "upstream=1");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(() => upstream.close());

beforeEach(() => {
  recorded = [];
  slowDelayMs = 0;
});

async function startGateway(env: Record<string, string>): Promise<{ url: string; close: () => void }> {
  const config: GatewayConfig = loadConfig({
    GATEWAY_AUTH_URL: upstreamUrl,
    GATEWAY_ELECTION_URL: upstreamUrl,
    GATEWAY_IDENTITY_URL: upstreamUrl,
    GATEWAY_BALLOT_URL: upstreamUrl,
    GATEWAY_ANALYTICS_URL: upstreamUrl,
    GATEWAY_ALLOWED_ORIGINS: "http://localhost:3000",
    ...env,
  });
  const gateway = createGateway(config, { log: () => {} });
  const server = createServer((req, res) => void gateway.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

const exp = Math.floor(Date.now() / 1000) + 3600;
const voterToken = signJwt({ sub: "42", roles: ["voter"], exp }, SECRET);
const adminToken = signJwt({ sub: "1", roles: ["admin"], exp }, SECRET);

describe("modo jwt", () => {
  let gw: { url: string; close: () => void };
  before(async () => {
    gw = await startGateway({ GATEWAY_JWT_SECRET: SECRET });
  });
  after(() => gw.close());

  test("enruta una ruta pública reescribiendo la ruta y conservando la consulta", async () => {
    const response = await fetch(`${gw.url}/api/analytics/elections?limit=5`, {
      headers: { Authorization: `Bearer ${voterToken}` },
    });
    assert.equal(response.status, 200);
    assert.equal(recorded[0]?.url, "/v1/analytics/elections?limit=5");
  });

  test("las rutas públicas no exigen token", async () => {
    const response = await fetch(`${gw.url}/api/elections/open`);
    assert.equal(response.status, 200);
    assert.equal(recorded[0]?.url, "/elections/open");
  });

  test("rechaza una ruta protegida sin token", async () => {
    const response = await fetch(`${gw.url}/api/auth/me`);
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "unauthenticated");
    assert.equal(recorded.length, 0);
  });

  test("rechaza un token inválido", async () => {
    const response = await fetch(`${gw.url}/api/auth/me`, {
      headers: { Authorization: "Bearer no-es-un-jwt" },
    });
    assert.equal(response.status, 401);
    assert.equal(recorded.length, 0);
  });

  test("exige el rol admin en las rutas de administración", async () => {
    const forbidden = await fetch(`${gw.url}/api/elections`, {
      headers: { Authorization: `Bearer ${voterToken}` },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(recorded.length, 0);

    const allowed = await fetch(`${gw.url}/api/elections`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(allowed.status, 200);
  });

  test("propaga la identidad validada y descarta la que envía el cliente", async () => {
    await fetch(`${gw.url}/api/auth/me`, {
      headers: {
        Authorization: `Bearer ${voterToken}`,
        "X-User-Id": "1",
        "X-User-Roles": "admin",
        Cookie: "sesion=abc",
      },
    });
    const headers = recorded[0]?.headers ?? {};
    assert.equal(headers["x-user-id"], "42");
    assert.equal(headers["x-user-roles"], "voter");
    assert.equal(headers.authorization, `Bearer ${voterToken}`);
    assert.equal(headers.cookie, undefined);
    assert.ok(headers["x-request-id"]);
  });

  test("la ruta de Ballot es anónima: no reenvía credenciales ni datos del cliente", async () => {
    const response = await fetch(`${gw.url}/api/ballots`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${voterToken}`,
        Cookie: "espivota_session=abc",
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.7",
        "User-Agent": "navegador-del-votante",
        Referer: "http://localhost:3000/elections/1/vote",
      },
      body: JSON.stringify({ election_id: "1", token: "t", encrypted_vote: "v", proof: "p" }),
    });
    assert.equal(response.status, 200);
    const request = recorded[0] as Recorded;
    assert.equal(request.url, "/v1/ballots");
    assert.equal(request.body, '{"election_id":"1","token":"t","encrypted_vote":"v","proof":"p"}');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["x-forwarded-for"], undefined);
    assert.equal(request.headers.referer, undefined);
    assert.equal(request.headers["x-user-id"], undefined);
    assert.equal(request.headers["x-request-id"], undefined);
    assert.notEqual(request.headers["user-agent"], "navegador-del-votante");
  });

  test("no expone Blind Signature", async () => {
    const response = await fetch(`${gw.url}/api/blind-signature/sign`, { method: "POST" });
    assert.equal(response.status, 404);
  });

  test("responde 503 si el servicio no está configurado", async () => {
    const response = await fetch(`${gw.url}/api/notifications`, {
      headers: { Authorization: `Bearer ${voterToken}` },
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "service_not_configured");
  });

  test("no reenvía las cookies que fija el servicio", async () => {
    const response = await fetch(`${gw.url}/api/elections/open`);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("content-type"), "application/json");
  });

  test("responde 405 si el método no corresponde", async () => {
    const response = await fetch(`${gw.url}/api/elections/open`, { method: "DELETE" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  });

  test("CORS: solo los orígenes permitidos reciben Access-Control-Allow-Origin", async () => {
    const allowed = await fetch(`${gw.url}/api/elections/open`, {
      headers: { Origin: "http://localhost:3000" },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3000");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null);

    const other = await fetch(`${gw.url}/api/elections/open`, {
      headers: { Origin: "https://malicioso.example" },
    });
    assert.equal(other.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(`${gw.url}/api/ballots`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  });

  test("publica el catálogo de rutas", async () => {
    const response = await fetch(`${gw.url}/api`);
    const body = (await response.json()) as { authMode: string; routes: { path: string; available: boolean }[] };
    assert.equal(body.authMode, "jwt");
    assert.ok(body.routes.some((r) => r.path === "/api/ballots" && r.available));
    assert.ok(body.routes.some((r) => r.path === "/api/notifications" && !r.available));
  });
});

describe("modo passthrough", () => {
  test("exige un Bearer pero delega su validación en el servicio", async () => {
    const gw = await startGateway({});
    try {
      assert.equal((await fetch(`${gw.url}/api/elections`)).status, 401);
      const response = await fetch(`${gw.url}/api/elections`, {
        headers: { Authorization: "Bearer sesion-opaca" },
      });
      assert.equal(response.status, 200);
      assert.equal(recorded[0]?.headers.authorization, "Bearer sesion-opaca");
      assert.equal(recorded[0]?.headers["x-user-id"], undefined);
    } finally {
      gw.close();
    }
  });
});

describe("protecciones", () => {
  test("limita la tasa de intentos de inicio de sesión", async () => {
    const gw = await startGateway({ GATEWAY_RATE_LIMIT_LOGIN: "2" });
    try {
      const login = () => fetch(`${gw.url}/api/auth/login`, { method: "POST", body: "{}" });
      assert.equal((await login()).status, 200);
      assert.equal((await login()).status, 200);
      const blocked = await login();
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);
      // Las demás cuotas no se ven afectadas.
      assert.equal((await fetch(`${gw.url}/api/elections/open`)).status, 200);
    } finally {
      gw.close();
    }
  });

  test("rechaza cuerpos demasiado grandes", async () => {
    const gw = await startGateway({ GATEWAY_MAX_BODY_BYTES: "16" });
    try {
      const response = await fetch(`${gw.url}/api/ballots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relleno: "x".repeat(100) }),
      });
      assert.equal(response.status, 413);
      assert.equal(recorded.length, 0);
    } finally {
      gw.close();
    }
  });

  test("responde 504 si el servicio tarda demasiado", async () => {
    const gw = await startGateway({ GATEWAY_UPSTREAM_TIMEOUT_MS: "50" });
    slowDelayMs = 300;
    try {
      assert.equal((await fetch(`${gw.url}/api/elections/open`)).status, 504);
    } finally {
      gw.close();
    }
  });

  test("responde 502 si el servicio no está disponible", async () => {
    const gw = await startGateway({ GATEWAY_ELECTION_URL: "http://127.0.0.1:1" });
    try {
      const response = await fetch(`${gw.url}/api/elections/open`);
      assert.equal(response.status, 502);
      const ready = await fetch(`${gw.url}/readyz`);
      assert.equal(ready.status, 503);
      assert.equal(((await ready.json()) as { services: Record<string, string> }).services.election, "unreachable");
    } finally {
      gw.close();
    }
  });
});

test("la configuración exige secreto en modo jwt", () => {
  assert.throws(() => loadConfig({ GATEWAY_AUTH_MODE: "jwt" }), /GATEWAY_JWT_SECRET/);
  assert.equal(loadConfig({}).authMode, "passthrough");
  assert.equal(loadConfig({ GATEWAY_JWT_SECRET: "s" }).authMode, "jwt");
});
