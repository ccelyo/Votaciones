import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createGateway } from "../src/app.ts";
import { type GatewayConfig, loadConfig } from "../src/config.ts";
import { identityClaims, jwks, newKey, signHs256WithPublicKey, signRs256 } from "./keys.ts";

const KEY = newKey("identity-k1");

interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

// Servicio falso que registra lo que recibe y responde 200 JSON, o `nextResponse`
// cuando una prueba necesita otra respuesta del upstream.
interface FakeResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

let recorded: Recorded[] = [];
let upstream: Server;
let upstreamUrl: string;
let slowDelayMs = 0;
let nextResponse: FakeResponse | undefined;

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
    if (nextResponse) {
      res.statusCode = nextResponse.status;
      for (const [name, value] of Object.entries(nextResponse.headers ?? {})) res.setHeader(name, value);
      res.end(nextResponse.body);
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Set-Cookie", "upstream=1");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(() => upstream.close());

// JWKS falso de identity, separado del servicio para no mezclar sus peticiones.
let jwksServer: Server;
let jwksUrl: string;
let jwksRequests = 0;

before(async () => {
  jwksServer = createServer((_req, res) => {
    jwksRequests += 1;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(jwks(KEY)));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/.well-known/jwks.json`;
});

after(() => jwksServer.close());

beforeEach(() => {
  recorded = [];
  slowDelayMs = 0;
  nextResponse = undefined;
});

let logs: Record<string, unknown>[] = [];

async function startGateway(env: Record<string, string>): Promise<{ url: string; close: () => void }> {
  const config: GatewayConfig = loadConfig({
    GATEWAY_AUTH_URL: upstreamUrl,
    GATEWAY_ELECTION_URL: upstreamUrl,
    GATEWAY_IDENTITY_URL: upstreamUrl,
    GATEWAY_BALLOT_URL: upstreamUrl,
    GATEWAY_ANALYTICS_URL: upstreamUrl,
    GATEWAY_TALLY_URL: upstreamUrl,
    GATEWAY_ALLOWED_ORIGINS: "http://localhost:3000",
    GATEWAY_SESSION_CHECK: "off",
    ...env,
  });
  const gateway = createGateway(config, { log: (entry) => logs.push(entry) });
  const server = createServer((req, res) => void gateway.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

const voterToken = signRs256(identityClaims({ sub: "42", role: "voter" }), KEY);
const adminToken = signRs256(identityClaims({ sub: "1", role: "admin", username: "admin" }), KEY);

describe("modo jwt", () => {
  let gw: { url: string; close: () => void };
  before(async () => {
    gw = await startGateway({ GATEWAY_JWKS_URL: jwksUrl });
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

  test("rechaza HS256 aunque se firme con la clave pública del JWKS", async () => {
    const forged = signHs256WithPublicKey(identityClaims({ sub: "1", role: "admin" }), KEY);
    const response = await fetch(`${gw.url}/api/elections`, {
      headers: { Authorization: `Bearer ${forged}` },
    });
    assert.equal(response.status, 401);
    assert.equal(recorded.length, 0);
  });

  test("rechaza un token de otro emisor o audiencia", async () => {
    for (const overrides of [{ iss: "otro" }, { aud: "otro" }]) {
      const token = signRs256(identityClaims(overrides), KEY);
      const response = await fetch(`${gw.url}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 401);
    }
    assert.equal(recorded.length, 0);
  });

  test("cachea el JWKS entre peticiones", async () => {
    const before = jwksRequests;
    for (let i = 0; i < 3; i += 1) {
      await fetch(`${gw.url}/api/auth/me`, { headers: { Authorization: `Bearer ${voterToken}` } });
    }
    assert.ok(jwksRequests - before <= 1);
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
    // El navegador de otro origen puede leer el id de correlación.
    assert.equal(allowed.headers.get("access-control-expose-headers"), "X-Request-Id");

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

  test("publica el catálogo de rutas sin topología interna", async () => {
    const response = await fetch(`${gw.url}/api`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown> & { routes: Record<string, unknown>[] };
    assert.equal(body.authMode, undefined);
    assert.ok(body.routes.some((r) => r.path === "/api/ballots" && r.access === "anonymous"));
    for (const route of body.routes) {
      assert.deepEqual(Object.keys(route).sort(), ["access", "description", "method", "path"]);
    }
    // Las rutas públicas son contrato externo; las descripciones no nombran servicios internos.
    assert.doesNotMatch(JSON.stringify(body.routes.map((r) => r.description)), /identity →|blind signature|:8000/i);
    assert.doesNotMatch(JSON.stringify(body), /identity:|:8000|https?:\/\//i);
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
      const body = (await response.json()) as { error: { message: string } };
      assert.doesNotMatch(body.error.message, /election|identity/i);
      const ready = await fetch(`${gw.url}/readyz`);
      assert.equal(ready.status, 503);
      // Hacia afuera solo el estado global; el detalle por servicio queda en el log.
      assert.deepEqual(await ready.json(), { status: "degraded" });
      assert.ok(
        logs.some((entry) => (entry.services as Record<string, string> | undefined)?.election === "unreachable"),
      );
    } finally {
      gw.close();
    }
  });
});

test("responde 503 si no puede obtener el JWKS de identity", async () => {
  const gw = await startGateway({ GATEWAY_JWKS_URL: "http://127.0.0.1:1/.well-known/jwks.json" });
  try {
    const response = await fetch(`${gw.url}/api/auth/me`, {
      headers: { Authorization: `Bearer ${voterToken}` },
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "auth_unavailable");
    assert.equal(recorded.length, 0);
  } finally {
    gw.close();
  }
});

test("la configuración exige el JWKS en modo jwt y rechaza el secreto HS256", () => {
  assert.throws(() => loadConfig({ GATEWAY_AUTH_MODE: "jwt" }), /GATEWAY_JWKS_URL/);
  assert.throws(() => loadConfig({ GATEWAY_JWT_SECRET: "s" }), /RS256/);
  assert.equal(loadConfig({}).authMode, "passthrough");
  const config = loadConfig({ GATEWAY_JWKS_URL: "http://identity:8000/.well-known/jwks.json" });
  assert.equal(config.authMode, "jwt");
  assert.equal(config.jwtIssuer, "votaciones-identity");
  assert.equal(config.jwtAudience, "votaciones");
});

test("la configuración segura exige material mTLS y upstreams HTTPS", () => {
  assert.throws(() => loadConfig({ GATEWAY_TLS_REQUIRED: "true" }), /GATEWAY_TLS_REQUIRED/);
  assert.throws(
    () =>
      loadConfig({
        GATEWAY_UPSTREAM_TLS_REQUIRED: "true",
        GATEWAY_BALLOT_URL: "http://ballot:8080",
      }),
    /GATEWAY_UPSTREAM_TLS_REQUIRED/,
  );
  assert.throws(
    () =>
      loadConfig({
        GATEWAY_UPSTREAM_TLS_REQUIRED: "true",
        GATEWAY_UPSTREAM_TLS_CA_FILE: "/ca.pem",
        GATEWAY_UPSTREAM_TLS_CERT_FILE: "/client.pem",
        GATEWAY_UPSTREAM_TLS_KEY_FILE: "/client.key",
        GATEWAY_BALLOT_URL: "http://ballot:8080",
      }),
    /must use https/,
  );
});

describe("operaciones administrativas en el catálogo", () => {
  let gw: { url: string; close: () => void };
  before(async () => {
    gw = await startGateway({ GATEWAY_JWKS_URL: jwksUrl });
  });
  after(() => gw.close());

  const operations = [
    { method: "POST", path: "/api/auth/users", upstream: "/users", body: '{"username":"u","password":"p","role":"voter"}' },
    { method: "PATCH", path: "/api/auth/users/5", upstream: "/users/5", body: '{"is_active":false}' },
    { method: "POST", path: "/api/elections/7/open", upstream: "/elections/7/open" },
  ];

  test("un votante recibe 403 y no llega al servicio", async () => {
    for (const op of operations) {
      const response = await fetch(`${gw.url}${op.path}`, {
        method: op.method,
        headers: { Authorization: `Bearer ${voterToken}`, "Content-Type": "application/json" },
        body: op.body,
      });
      assert.equal(response.status, 403, op.path);
    }
    assert.equal(recorded.length, 0);
  });

  test("un administrador llega a la ruta del servicio", async () => {
    for (const op of operations) {
      const response = await fetch(`${gw.url}${op.path}`, {
        method: op.method,
        headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
        body: op.body,
      });
      assert.equal(response.status, 200, op.path);
    }
    assert.deepEqual(
      recorded.map((r) => `${r.method} ${r.url}`),
      operations.map((op) => `${op.method} ${op.upstream}`),
    );
    assert.equal(recorded[1]?.body, '{"is_active":false}');
  });

  test("DELETE sobre un usuario no existe: 405 con Allow: PATCH", async () => {
    const response = await fetch(`${gw.url}/api/auth/users/5`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "PATCH");
    assert.equal(recorded.length, 0);
  });
});

// --- mediación completa: comprobación de la sesión en identity ---------------

interface FakeSession {
  id: number;
  role: string;
  revoked?: boolean;
}

describe("comprobación de sesión en identity", () => {
  // Identity falso: responde /auth/me según el estado de cada token y aplica el
  // logout y la desactivación como lo haría identity.
  const sessionsByToken = new Map<string, FakeSession>();
  const inactiveUsers = new Set<number>();
  let meCalls = 0;
  let identityForwards: string[] = [];
  let identityServer: Server;
  let identityUrl: string;
  let gw: { url: string; close: () => void };

  function token(sub: string, role: string, jti: string): string {
    return signRs256(identityClaims({ sub, role, jti }), KEY);
  }

  const voter = token("42", "voter", "s-voter");
  const admin = token("1", "admin", "s-admin");
  const revoked = token("43", "voter", "s-revoked");
  const deactivated = token("44", "admin", "s-deactivated");
  const demoted = token("45", "admin", "s-demoted");

  before(async () => {
    identityServer = createServer(async (req, res) => {
      for await (const _ of req) {
        // Descarta el cuerpo.
      }
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const session = sessionsByToken.get(bearer);
      const active = session && !session.revoked && !inactiveUsers.has(session.id);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/auth/me") {
        meCalls += 1;
        if (!active) {
          res.statusCode = 401;
          res.end('{"error":{"code":"unauthenticated","message":"invalid or expired session"}}');
          return;
        }
        res.end(JSON.stringify({ id: session.id, username: `u${session.id}`, role: session.role }));
        return;
      }
      identityForwards.push(`${req.method} ${req.url}`);
      if (req.url === "/logout" && session) {
        session.revoked = true;
        res.statusCode = 204;
        res.end();
        return;
      }
      // Como identity (`user_id: int`), acepta `05`. Con `?raw=1` responde sin `id`.
      const user = /^\/users\/(\d+)(\?raw=1)?$/.exec(req.url ?? "");
      if (req.method === "PATCH" && user) {
        inactiveUsers.add(Number(user[1]));
        res.end(user[2] ? "{}" : JSON.stringify({ id: Number(user[1]), is_active: false }));
        return;
      }
      res.end("{}");
    });
    await new Promise<void>((resolve) => identityServer.listen(0, "127.0.0.1", resolve));
    identityUrl = `http://127.0.0.1:${(identityServer.address() as AddressInfo).port}`;
    gw = await startGateway({
      GATEWAY_JWKS_URL: jwksUrl,
      GATEWAY_AUTH_URL: identityUrl,
      GATEWAY_SESSION_CHECK: "identity",
      GATEWAY_SESSION_CACHE_TTL_MS: "60000",
    });
  });

  after(() => {
    gw.close();
    identityServer.close();
  });

  beforeEach(() => {
    sessionsByToken.clear();
    inactiveUsers.clear();
    sessionsByToken.set(voter, { id: 42, role: "voter" });
    sessionsByToken.set(admin, { id: 1, role: "admin" });
    sessionsByToken.set(revoked, { id: 43, role: "voter", revoked: true });
    sessionsByToken.set(deactivated, { id: 44, role: "admin" });
    sessionsByToken.set(demoted, { id: 45, role: "voter" });
    inactiveUsers.add(44);
    meCalls = 0;
    identityForwards = [];
  });

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { error: { code: string } }).error.code;
  }

  test("un token revocado se rechaza con 401 sin contactar el servicio", async () => {
    const response = await fetch(`${gw.url}/api/analytics/summary`, {
      headers: { Authorization: `Bearer ${revoked}` },
    });
    assert.equal(response.status, 401);
    assert.equal(await errorCode(response), "invalid_token");
    assert.equal(recorded.length, 0);
  });

  test("un usuario desactivado no puede lanzar el escrutinio", async () => {
    const response = await fetch(`${gw.url}/api/tally/elections/1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deactivated}` },
    });
    assert.equal(response.status, 401);
    assert.equal(recorded.length, 0);
  });

  test("el rol vigente en identity prevalece sobre el claim del JWT", async () => {
    const response = await fetch(`${gw.url}/api/analytics/elections/1/recompute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${demoted}` },
    });
    assert.equal(response.status, 403);
    assert.equal(recorded.length, 0);
  });

  test("propaga el rol comprobado en identity", async () => {
    const response = await fetch(`${gw.url}/api/analytics/summary`, {
      headers: { Authorization: `Bearer ${demoted}` },
    });
    assert.equal(response.status, 200);
    assert.equal(recorded[0]?.headers["x-user-roles"], "voter");
  });

  test("cachea la sesión comprobada entre peticiones", async () => {
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${gw.url}/api/analytics/summary`, {
        headers: { Authorization: `Bearer ${voter}` },
      });
      assert.equal(response.status, 200);
    }
    assert.equal(meCalls, 1);
    assert.equal(recorded.length, 2);
  });

  test("tras el logout, la misma sesión se rechaza sin esperar a la caché", async () => {
    const headers = { Authorization: `Bearer ${voter}` };
    assert.equal((await fetch(`${gw.url}/api/analytics/summary`, { headers })).status, 200);
    const logout = await fetch(`${gw.url}/api/auth/logout`, { method: "POST", headers });
    assert.equal(logout.status, 204);
    assert.deepEqual(identityForwards, ["POST /logout"]);

    const callsBefore = meCalls;
    const after = await fetch(`${gw.url}/api/analytics/summary`, { headers });
    assert.equal(after.status, 401);
    assert.equal(meCalls, callsBefore + 1);
    assert.equal(recorded.length, 1);
  });

  test("desactivar un usuario invalida sus sesiones en caché", async () => {
    const headers = { Authorization: `Bearer ${voter}` };
    assert.equal((await fetch(`${gw.url}/api/analytics/summary`, { headers })).status, 200);
    const patch = await fetch(`${gw.url}/api/auth/users/42`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
      body: '{"is_active":false}',
    });
    assert.equal(patch.status, 200);
    const after = await fetch(`${gw.url}/api/analytics/summary`, { headers });
    assert.equal(after.status, 401);
    assert.equal(recorded.length, 1);
  });

  for (const path of ["/api/auth/users/0042", "/api/auth/users/042?raw=1"]) {
    test(`desactivar con un id no canónico (${path}) también invalida la caché`, async () => {
      const headers = { Authorization: `Bearer ${voter}` };
      assert.equal((await fetch(`${gw.url}/api/analytics/summary`, { headers })).status, 200);
      const patch = await fetch(`${gw.url}${path}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
        body: '{"is_active":false}',
      });
      assert.equal(patch.status, 200);
      const after = await fetch(`${gw.url}/api/analytics/summary`, { headers });
      assert.equal(after.status, 401);
      assert.equal(recorded.length, 1);
    });
  }

  test("la línea de acceso del log indica si la petición llegó al servicio", async () => {
    const rejected = await fetch(`${gw.url}/api/tally/elections/1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${revoked}` },
    });
    assert.equal(rejected.status, 401);
    const accepted = await fetch(`${gw.url}/api/analytics/summary`, { headers: { Authorization: `Bearer ${voter}` } });
    assert.equal(accepted.status, 200);
    const access = (response: Response) =>
      logs.find((e) => e.requestId === response.headers.get("x-request-id") && "status" in e);
    assert.equal(access(rejected)?.forwarded, false);
    assert.equal(access(accepted)?.forwarded, true);
    assert.equal(recorded.length, 1);
  });

  test("/api/auth/me no consulta la sesión dos veces", async () => {
    const response = await fetch(`${gw.url}/api/auth/me`, { headers: { Authorization: `Bearer ${voter}` } });
    assert.equal(response.status, 200);
    assert.equal(meCalls, 1);
  });

  test("la papeleta no provoca consultas de sesión ni lleva el JWT", async () => {
    const response = await fetch(`${gw.url}/api/ballots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${revoked}`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(meCalls, 0);
    assert.equal(recorded[0]?.headers.authorization, undefined);
  });

  test("las rutas públicas no consultan la sesión", async () => {
    assert.equal((await fetch(`${gw.url}/api/elections/open`)).status, 200);
    assert.equal(meCalls, 0);
  });

  test("si identity no responde, falla cerrado con 503", async () => {
    const down = await startGateway({
      GATEWAY_JWKS_URL: jwksUrl,
      GATEWAY_AUTH_URL: "http://127.0.0.1:1",
      GATEWAY_SESSION_CHECK: "identity",
    });
    try {
      const response = await fetch(`${down.url}/api/analytics/summary`, {
        headers: { Authorization: `Bearer ${voter}` },
      });
      assert.equal(response.status, 503);
      assert.equal(await errorCode(response), "auth_unavailable");
      assert.equal(recorded.length, 0);
    } finally {
      down.close();
    }
  });
});

test("la configuración de la comprobación de sesión exige identity y modo jwt", () => {
  const jwt = { GATEWAY_JWKS_URL: "http://identity:8000/.well-known/jwks.json" };
  assert.equal(loadConfig(jwt).sessionCheck, "off");
  assert.throws(() => loadConfig({ ...jwt, GATEWAY_SESSION_CHECK: "identity" }), /GATEWAY_AUTH_URL/);
  assert.throws(
    () => loadConfig({ GATEWAY_SESSION_CHECK: "identity", GATEWAY_AUTH_URL: "http://identity:8000" }),
    /GATEWAY_AUTH_MODE=jwt/,
  );
  assert.throws(() => loadConfig({ GATEWAY_SESSION_CHECK: "siempre" }), /identity u off/);
  const config = loadConfig({ ...jwt, GATEWAY_SESSION_CHECK: "identity", GATEWAY_AUTH_URL: "http://identity:8000" });
  assert.equal(config.sessionCheck, "identity");
  assert.equal(config.sessionCacheTtlMs, 5000);
  assert.equal(config.sessionCacheMax, 10000);
});

// --- ocultamiento de topología y tecnología ---------------------------------

describe("respuestas saneadas", () => {
  let gw: { url: string; close: () => void };
  before(async () => {
    gw = await startGateway({ GATEWAY_JWKS_URL: jwksUrl });
  });
  after(() => gw.close());

  const LEAKS = /identity|:8000|uvicorn|pydantic|starlette|page not found|nginx|blind/i;
  const auth = { Authorization: `Bearer ${adminToken}` };

  test("un 500 del servicio se convierte en 502 genérico con requestId", async () => {
    nextResponse = { status: 500, body: "Internal Server Error\n  at identity:8000 (uvicorn)" };
    const response = await fetch(`${gw.url}/api/analytics/summary`, { headers: auth });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.doesNotMatch(text, LEAKS);
    const body = JSON.parse(text) as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, "upstream_error");
    assert.equal(body.error.requestId, response.headers.get("x-request-id"));
    assert.ok(logs.some((e) => e.requestId === body.error.requestId && e.upstreamStatus === 500 && e.service === "analytics"));
  });

  test("un 503 del servicio conserva el estado y Retry-After, no el detalle", async () => {
    nextResponse = {
      status: 503,
      body: '{"error":{"code":"blind_signature_unavailable","message":"blind signature service unreachable"}}',
      headers: { "Content-Type": "application/json", "Retry-After": "5" },
    };
    const response = await fetch(`${gw.url}/api/identity/tokens/blind`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.doesNotMatch(await response.text(), LEAKS);
  });

  test("el 422 del framework de validación se reescribe sin revelar el framework ni la entrada", async () => {
    nextResponse = {
      status: 422,
      body: JSON.stringify({
        detail: [{ type: "string_type", loc: ["body", "username"], msg: "Input should be a valid string", input: 1, url: "https://errors.pydantic.dev/2.9/v/string_type" }],
      }),
      headers: { "Content-Type": "application/json" },
    };
    const response = await fetch(`${gw.url}/api/auth/login`, { method: "POST", body: '{"username":1}' });
    assert.equal(response.status, 422);
    const text = await response.text();
    assert.doesNotMatch(text, LEAKS);
    assert.doesNotMatch(text, /detail|string_type/);
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "invalid_request");
  });

  test("el 404 en texto plano del servidor HTTP de Go se reescribe a JSON", async () => {
    nextResponse = { status: 404, body: "404 page not found", headers: { "Content-Type": "text/plain" } };
    const response = await fetch(`${gw.url}/api/ballots/elections/9/results`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = (await response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "not_found");
    assert.doesNotMatch(body.error.message, LEAKS);
  });

  test("los códigos de error de Ballot llegan intactos (no regresión del voto)", async () => {
    nextResponse = { status: 409, body: '{"error":"token_already_spent"}', headers: { "Content-Type": "application/json" } };
    const response = await fetch(`${gw.url}/api/ballots`, { method: "POST", body: "{}" });
    assert.equal(response.status, 409);
    // `error` sigue siendo la cadena que platform interpreta; se añade solo el requestId.
    assert.deepEqual(await response.json(), {
      error: "token_already_spent",
      requestId: response.headers.get("x-request-id"),
    });
  });

  test("los errores de identity con formato acordado conservan código y mensaje", async () => {
    const body = '{"error":{"code":"election_closed","message":"a closed election cannot be reopened"}}';
    nextResponse = { status: 409, body, headers: { "Content-Type": "application/json" } };
    const response = await fetch(`${gw.url}/api/elections/7/open`, { method: "POST", headers: auth });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: {
        code: "election_closed",
        message: "a closed election cannot be reopened",
        requestId: response.headers.get("x-request-id"),
      },
    });
  });

  test("un 4xx con formato acordado pierde los campos adicionales del servicio", async () => {
    nextResponse = {
      status: 400,
      body: JSON.stringify({
        error: { code: "bad", message: { trace: "identity:8000" }, detail: "uvicorn", host: "identity" },
        service: "identity",
      }),
      headers: { "Content-Type": "application/json" },
    };
    const response = await fetch(`${gw.url}/api/elections/7/open`, { method: "POST", headers: auth });
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.doesNotMatch(text, LEAKS);
    const body = JSON.parse(text) as { error: Record<string, unknown> };
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
    assert.equal(body.error.code, "bad");
    assert.equal(body.error.message, "La solicitud no es válida.");

    nextResponse = {
      status: 404,
      body: '{"error":"election_not_found","service":"tally","host":"tally:8095"}',
      headers: { "Content-Type": "application/json" },
    };
    const tally = await fetch(`${gw.url}/api/tally/elections/7`, { headers: auth });
    assert.deepEqual(Object.keys(await tally.json()).sort(), ["error", "requestId"]);
  });

  test("descarta un Location absoluto hacia un host interno", async () => {
    nextResponse = { status: 201, body: "{}", headers: { Location: "https://identity:8000/elections/9" } };
    const response = await fetch(`${gw.url}/api/elections`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("location"), null);
  });

  test("conserva un Location relativo dentro de /api/", async () => {
    nextResponse = { status: 201, body: "{}", headers: { Location: "/api/elections/9" } };
    const response = await fetch(`${gw.url}/api/elections`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(response.headers.get("location"), "/api/elections/9");
  });

  test("todas las respuestas llevan X-Request-Id", async () => {
    for (const path of ["/api", "/healthz", "/api/no-existe", "/api/elections/open"]) {
      const response = await fetch(`${gw.url}${path}`);
      assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/, path);
    }
  });

  test("los errores propios del Gateway no nombran servicios internos", async () => {
    const responses = [
      await fetch(`${gw.url}/api/no-existe`),
      await fetch(`${gw.url}/api/auth/users/1`, { method: "DELETE" }),
      await fetch(`${gw.url}/api/notifications`, { headers: auth }),
    ];
    for (const response of responses) {
      const text = await response.text();
      assert.doesNotMatch(text, /identity|election|analytics|notification|ballot|tally/i, text);
      assert.ok((JSON.parse(text) as { error: { requestId: string } }).error.requestId);
    }
  });

  test("/readyz solo informa el estado global", async () => {
    const response = await fetch(`${gw.url}/readyz`);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["status"]);
  });

  test("/readyz reutiliza el resultado unos segundos en lugar de consultar cada servicio", async () => {
    const fresh = await startGateway({ GATEWAY_JWKS_URL: jwksUrl });
    try {
      await Promise.all([1, 2, 3].map(() => fetch(`${fresh.url}/readyz`)));
      const first = recorded.length;
      assert.ok(first > 0);
      await fetch(`${fresh.url}/readyz`);
      // Una sola ronda (una consulta por servicio configurado) para las cuatro peticiones.
      assert.equal(first, 6);
      assert.equal(recorded.length, first);
    } finally {
      fresh.close();
    }
  });
});
