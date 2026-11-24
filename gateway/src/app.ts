// API Gateway: enrutamiento REST/JSON, validación de JWT, CORS y límites de tasa.
//
// Es el reverse proxy de aplicación del sistema (escenario de seguridad 2): el único
// intermediario entre los clientes externos (detrás del WAF) y los servicios. Además
// de la allowlist de rutas, revalida cada sesión contra identity (mediación completa)
// y sanea las respuestas para no revelar servicios, hosts ni frameworks internos.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { GatewayConfig } from "./config.ts";
import { createJwksResolver, JwksUnavailableError, JwtError, type Principal, verifyJwt } from "./jwt.ts";
import { RateLimiter } from "./rateLimit.ts";
import { buildUpstreamPath, Router } from "./router.ts";
import { HEALTH_PATHS, type RouteDefinition, ROUTES, type ServiceName } from "./routes.ts";
import { createSessionVerifier, SessionRevokedError, SessionUnavailableError } from "./session.ts";

export interface GatewayDeps {
  fetch?: typeof fetch;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

// Cabeceras que el Gateway reenvía. Todo lo demás (cookies, X-Forwarded-*,
// cabeceras de identidad enviadas por el cliente, etc.) se descarta.
const REQUEST_HEADERS = ["accept", "accept-language", "content-type"];
// `Location` no está aquí: se filtra aparte para no revelar hosts internos.
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified", "retry-after"];
const ALLOWED_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type, Accept, Accept-Language";
// Un cliente de otro origen (la app web en :8092) solo puede leer las cabeceras listadas.
const EXPOSED_HEADERS = "X-Request-Id";
// `/readyz` es público y cada consulta abre una petición mTLS por servicio: se reutiliza
// el resultado unos segundos y las consultas simultáneas comparten la misma ronda.
const READINESS_CACHE_MS = 2_000;

// Código genérico para los 4xx del servicio que no traen el formato de error acordado
// (p. ej. el 422 de validación del framework o el "404 page not found" en texto plano).
const CLIENT_ERRORS: Record<number, [string, string]> = {
  400: ["invalid_request", "La solicitud no es válida."],
  401: ["unauthenticated", "Se requiere autenticación."],
  403: ["forbidden", "No tienes permiso para esta operación."],
  404: ["not_found", "Recurso no encontrado."],
  409: ["conflict", "La solicitud entra en conflicto con el estado actual."],
  422: ["invalid_request", "La solicitud no es válida."],
};

interface Authenticated {
  principal: Principal | null;
  token: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function createGateway(config: GatewayConfig, deps: GatewayDeps = {}) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const router = new Router(ROUTES);
  const limiter = new RateLimiter(config.rateLimits, now);
  const jwks = config.jwksUrl
    ? createJwksResolver({ url: config.jwksUrl, fetch: doFetch, now })
    : undefined;
  // Mediación completa: misma conexión mTLS que el resto de upstreams (deps.fetch).
  const sessions =
    config.sessionCheck === "identity" && config.upstreams.auth
      ? createSessionVerifier({
          url: config.upstreams.auth,
          fetch: doFetch,
          now,
          ttlMs: config.sessionCacheTtlMs,
          maxEntries: config.sessionCacheMax,
        })
      : undefined;

  function clientKey(req: IncomingMessage): string {
    if (config.trustForwardedFor) {
      const forwarded = req.headers["x-forwarded-for"];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    }
  }

  async function authenticate(
    req: IncomingMessage,
    route: RouteDefinition,
    requestId: string,
  ): Promise<Authenticated | null> {
    // Las rutas públicas y la zona anónima de votación salen aquí: Ballot nunca
    // provoca una consulta de sesión ni recibe el JWT.
    if (route.access === "public" || route.access === "anonymous") return null;

    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ", 2);
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new HttpError(401, "unauthenticated", "Se requiere autenticación.");
    }
    // Modo de transición: el servicio valida la sesión y los roles.
    if (config.authMode === "passthrough" || !jwks) return { principal: null, token };

    let principal: Principal;
    try {
      principal = await verifyJwt(token, {
        keys: jwks,
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
        now,
      });
    } catch (error) {
      if (error instanceof JwtError) {
        throw new HttpError(401, "invalid_token", "El token de sesión no es válido o expiró.");
      }
      if (error instanceof JwksUnavailableError) {
        log({ level: "error", message: error.message });
        throw new HttpError(503, "auth_unavailable", "No se pudo validar la sesión. Intenta más tarde.");
      }
      throw error;
    }
    // `/auth/me` ya lo valida identity contra la sesión: no hace falta preguntarle dos veces.
    if (sessions && route.upstreamPath !== "/auth/me") {
      try {
        principal = await sessions.verify(token, principal);
      } catch (error) {
        if (error instanceof SessionRevokedError) {
          throw new HttpError(401, "invalid_token", "La sesión no es válida o fue revocada.");
        }
        if (error instanceof SessionUnavailableError) {
          log({ level: "error", requestId, message: error.message });
          throw new HttpError(503, "auth_unavailable", "No se pudo validar la sesión. Intenta más tarde.");
        }
        throw error;
      }
    }
    // Con la comprobación de sesión activa, el rol es el vigente en identity, no el del claim.
    if (route.access === "admin" && !principal.roles.includes("admin")) {
      throw new HttpError(403, "forbidden", "Se requiere el rol de administrador.");
    }
    return { principal, token };
  }

  async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    if (req.method === "GET" || req.method === "HEAD") return undefined;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > config.maxBodyBytes) {
      throw new HttpError(413, "request_too_large", "El cuerpo de la petición es demasiado grande.");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > config.maxBodyBytes) {
        throw new HttpError(413, "request_too_large", "El cuerpo de la petición es demasiado grande.");
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  function upstreamHeaders(
    req: IncomingMessage,
    route: RouteDefinition,
    principal: Principal | null,
    requestId: string,
  ): Headers {
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    // La ruta de votación no lleva nada que permita vincular la papeleta con el votante.
    // La zona de votación es anónima: Ballot nunca recibe el JWT ni datos de identidad,
    // aunque en el futuro se le añada una ruta que no sea `anonymous`.
    if (route.access === "anonymous" || route.service === "ballot") return headers;

    headers.set("x-request-id", requestId);
    if (req.headers.authorization) headers.set("authorization", req.headers.authorization);
    if (principal) {
      headers.set("x-user-id", principal.userId);
      headers.set("x-user-roles", principal.roles.join(","));
    }
    return headers;
  }

  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteDefinition,
    params: Record<string, string>,
    search: string,
    requestId: string,
    trace: { forwarded: boolean },
  ): Promise<number> {
    const auth = await authenticate(req, route, requestId);
    const principal = auth?.principal ?? null;
    const base = config.upstreams[route.service];
    if (!base) {
      log({ level: "warn", requestId, message: "service not configured", service: route.service });
      throw new HttpError(503, "service_not_configured", "El servicio no está disponible.");
    }
    const body = await readBody(req);
    const target = `${base}${buildUpstreamPath(route.upstreamPath, params)}${search}`;

    let upstream: Response;
    // Desde aquí la petición sale hacia el servicio: queda en la línea de acceso del log
    // (`forwarded: true`), que es la evidencia de si un rechazo llegó o no al destino.
    trace.forwarded = true;
    try {
      upstream = await doFetch(target, {
        method: route.method,
        headers: upstreamHeaders(req, route, principal, requestId),
        body: body ? new Uint8Array(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (error) {
      // El nombre del servicio y la causa van solo al log, nunca al cliente.
      log({ level: "warn", requestId, message: "upstream request failed", service: route.service, error: String(error) });
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new HttpError(504, "upstream_timeout", "El servicio no respondió a tiempo.");
      }
      throw new HttpError(502, "upstream_unavailable", "El servicio no está disponible.");
    }

    const payload = Buffer.from(await upstream.arrayBuffer());
    const status = upstream.status;

    // 5xx: el cuerpo puede llevar trazas, hosts o nombres de dependencias internas.
    if (status >= 500) {
      log({ level: "warn", requestId, message: "upstream error", upstreamStatus: status, service: route.service });
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) res.setHeader("Retry-After", retryAfter);
      sendJson(res, status === 503 || status === 504 ? status : 502, {
        error: { code: "upstream_error", message: "El servicio no pudo completar la solicitud.", requestId },
      });
      return status === 503 || status === 504 ? status : 502;
    }

    if (status >= 400) {
      // Solo sale el código (y un mensaje de texto) del formato acordado: cualquier otro
      // campo del servicio se descarta y se añade el requestId para correlacionar.
      const agreed = agreedError(payload);
      if (!agreed) {
        log({ level: "info", requestId, message: "upstream error normalized", upstreamStatus: status, service: route.service });
      }
      const [code, message] = CLIENT_ERRORS[status] ?? ["request_error", "No se pudo completar la solicitud."];
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) res.setHeader("Retry-After", retryAfter);
      if (agreed && agreed.message === undefined) {
        // `{"error":"<código>"}` (Ballot, Tally, Analytics): los clientes leen `error` como cadena.
        sendJson(res, status, { error: agreed.code, requestId });
      } else {
        sendJson(res, status, {
          error: { code: agreed?.code ?? code, message: agreed?.message || message, requestId },
        });
      }
      return status;
    }

    res.statusCode = status;
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    const location = upstream.headers.get("location");
    if (location) {
      if (location.startsWith("/api/") && !location.startsWith("//")) {
        res.setHeader("Location", location);
      } else {
        log({ level: "warn", requestId, message: "upstream Location dropped", service: route.service });
      }
    }
    if (!res.hasHeader("cache-control")) res.setHeader("Cache-Control", "no-store");
    res.end(payload);

    if (sessions && auth && status >= 200 && status < 300) {
      if (route.path === "/api/auth/logout") sessions.invalidateToken(auth.token);
      if (route.method === "PATCH" && route.path === "/api/auth/users/:userId") {
        const userId = patchedUserId(payload, params.userId);
        if (userId) sessions.invalidateUser(userId);
      }
    }
    return status;
  }

  /**
   * Id del usuario modificado, tal como lo indexa la caché (`sub` del JWT). Se toma del
   * cuerpo 2xx de identity (`{id, ...}`): el parámetro de la ruta puede venir como
   * `05` o `+5` y identity lo interpreta como 5. Si el cuerpo no lo trae, se normaliza
   * el parámetro cuando es un entero decimal.
   */
  function patchedUserId(payload: Buffer, param: string | undefined): string | undefined {
    try {
      const id = (JSON.parse(payload.toString("utf8")) as { id?: unknown }).id;
      if (typeof id === "number" || (typeof id === "string" && id)) return String(id);
    } catch {
      // Cuerpo no JSON: se usa el parámetro.
    }
    const match = /^\s*([+-]?)(\d+)\s*$/.exec(param ?? "");
    if (!match) return param;
    const digits = String(BigInt(match[2] ?? "0"));
    return match[1] === "-" && digits !== "0" ? `-${digits}` : digits;
  }

  /**
   * Formato de error que los clientes ya interpretan y que no revela tecnología:
   * `{"error":"<código>"}` (Ballot, Tally, Analytics; platform decide con esos códigos)
   * o `{"error":{"code":...,"message":...}}` (Identity). Devuelve solo el código y, en
   * el segundo caso, el mensaje si es una cadena (`""` si no lo es); el resto se descarta.
   * `undefined` si el cuerpo no tiene ese formato y debe reescribirse por completo.
   */
  function agreedError(payload: Buffer): { code: string; message?: string } | undefined {
    let body: unknown;
    try {
      body = JSON.parse(payload.toString("utf8"));
    } catch {
      return undefined;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return { code: error };
    if (error === null || typeof error !== "object") return undefined;
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code !== "string") return undefined;
    return { code, message: typeof message === "string" ? message : "" };
  }

  type Readiness = { ok: boolean; services: Record<string, string> };
  let readinessCache: { at: number; result: Promise<Readiness> } | undefined;

  function cachedReadiness(): Promise<Readiness> {
    if (!readinessCache || now() - readinessCache.at >= READINESS_CACHE_MS) {
      readinessCache = { at: now(), result: readiness() };
    }
    return readinessCache.result;
  }

  async function readiness(): Promise<Readiness> {
    // El detalle por servicio solo va al log: hacia afuera revelaría la topología.
    const services: Record<string, string> = {};
    const entries = Object.entries(config.upstreams) as [ServiceName, string][];
    await Promise.all(
      entries.map(async ([service, base]) => {
        try {
          const response = await doFetch(`${base}${HEALTH_PATHS[service]}`, {
            signal: AbortSignal.timeout(2000),
          });
          services[service] = response.ok ? "ok" : `http ${response.status}`;
        } catch {
          services[service] = "unreachable";
        }
      }),
    );
    return { ok: Object.values(services).every((s) => s === "ok"), services };
  }

  /** Catálogo público: qué operaciones existen y qué acceso exigen, sin topología interna. */
  function catalog() {
    return {
      routes: ROUTES.map((route) => ({
        method: route.method,
        path: route.path,
        access: route.access,
        description: route.description,
      })),
    };
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    const requestId = randomUUID();
    const url = new URL(req.url ?? "/", "http://gateway.local");
    const method = (req.method ?? "GET").toUpperCase();
    let route: RouteDefinition | undefined;
    let status = 500;
    const trace = { forwarded: false };

    res.setHeader("X-Content-Type-Options", "nosniff");
    // Correlaciona la respuesta con el log del Gateway, que guarda el detalle que se oculta.
    res.setHeader("X-Request-Id", requestId);
    applyCors(req, res);

    try {
      if (method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
        res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        res.setHeader("Access-Control-Max-Age", "600");
        res.statusCode = status = 204;
        res.end();
        return;
      }

      if (method === "GET" && url.pathname === "/healthz") {
        sendJson(res, (status = 200), { status: "ok" });
        return;
      }
      if (method === "GET" && url.pathname === "/readyz") {
        const result = await cachedReadiness();
        if (!result.ok) log({ level: "warn", requestId, message: "readiness degraded", services: result.services });
        sendJson(res, (status = result.ok ? 200 : 503), { status: result.ok ? "ready" : "degraded" });
        return;
      }
      if (method === "GET" && url.pathname === "/api") {
        sendJson(res, (status = 200), catalog());
        return;
      }

      const result = router.match(method, url.pathname);
      if (result.kind === "not-found") {
        throw new HttpError(404, "not_found", "Ruta no encontrada.");
      }
      if (result.kind === "method-not-allowed") {
        throw new HttpError(405, "method_not_allowed", "Método no permitido.", {
          Allow: result.allow.join(", "),
        });
      }
      route = result.match.route;

      const decision = limiter.check(route.rateTier ?? "default", clientKey(req));
      res.setHeader("RateLimit-Limit", String(decision.limit));
      res.setHeader("RateLimit-Remaining", String(decision.remaining));
      if (!decision.allowed) {
        throw new HttpError(429, "rate_limited", "Demasiadas peticiones. Intenta más tarde.", {
          "Retry-After": String(decision.resetSeconds),
        });
      }

      status = await forward(req, res, route, result.match.params, url.search, requestId, trace);
    } catch (error) {
      const httpError =
        error instanceof HttpError
          ? error
          : new HttpError(500, "internal_error", "Error interno del Gateway.");
      if (!(error instanceof HttpError)) {
        log({ level: "error", requestId, message: String(error) });
      }
      status = httpError.status;
      if (!res.headersSent) {
        for (const [name, value] of Object.entries(httpError.headers)) res.setHeader(name, value);
        sendJson(res, status, { error: { code: httpError.code, message: httpError.message, requestId } });
      } else {
        res.end();
      }
    } finally {
      // Nunca se registran IP, cuerpo ni la ruta concreta de la papeleta.
      log({
        level: "info",
        requestId,
        method,
        route: route?.path ?? url.pathname,
        service: route?.service,
        // true solo si la petición salió hacia el servicio destino.
        forwarded: trace.forwarded,
        status,
        ms: now() - started,
      });
    }
  }

  return { handle, catalog };
}
