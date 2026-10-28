// API Gateway: enrutamiento REST/JSON, validación de JWT, CORS y límites de tasa.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { GatewayConfig } from "./config.ts";
import { JwtError, type Principal, verifyJwt } from "./jwt.ts";
import { RateLimiter } from "./rateLimit.ts";
import { buildUpstreamPath, Router } from "./router.ts";
import { HEALTH_PATHS, type RouteDefinition, ROUTES, type ServiceName } from "./routes.ts";

export interface GatewayDeps {
  fetch?: typeof fetch;
  now?: () => number;
  log?: (entry: Record<string, unknown>) => void;
}

// Cabeceras que el Gateway reenvía. Todo lo demás (cookies, X-Forwarded-*,
// cabeceras de identidad enviadas por el cliente, etc.) se descarta.
const REQUEST_HEADERS = ["accept", "accept-language", "content-type"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified", "location", "retry-after"];
const ALLOWED_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type, Accept, Accept-Language";

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
    }
  }

  function authenticate(req: IncomingMessage, route: RouteDefinition): Principal | null {
    if (route.access === "public" || route.access === "anonymous") return null;

    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ", 2);
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new HttpError(401, "unauthenticated", "Se requiere autenticación.");
    }
    // Modo de transición: el servicio valida la sesión y los roles.
    if (config.authMode === "passthrough") return null;

    let principal: Principal;
    try {
      principal = verifyJwt(token, {
        secret: config.jwtSecret as string,
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
        now,
      });
    } catch (error) {
      if (error instanceof JwtError) {
        throw new HttpError(401, "invalid_token", "El token de sesión no es válido o expiró.");
      }
      throw error;
    }
    if (route.access === "admin" && !principal.roles.includes("admin")) {
      throw new HttpError(403, "forbidden", "Se requiere el rol de administrador.");
    }
    return principal;
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
    if (route.access === "anonymous") return headers;

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
  ): Promise<number> {
    const principal = authenticate(req, route);
    const base = config.upstreams[route.service];
    if (!base) {
      throw new HttpError(503, "service_not_configured", `El servicio ${route.service} no está disponible.`);
    }
    const body = await readBody(req);
    const target = `${base}${buildUpstreamPath(route.upstreamPath, params)}${search}`;

    let upstream: Response;
    try {
      upstream = await doFetch(target, {
        method: route.method,
        headers: upstreamHeaders(req, route, principal, requestId),
        body: body ? new Uint8Array(body) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new HttpError(504, "upstream_timeout", `El servicio ${route.service} no respondió a tiempo.`);
      }
      throw new HttpError(502, "upstream_unavailable", `No se pudo contactar el servicio ${route.service}.`);
    }

    const payload = Buffer.from(await upstream.arrayBuffer());
    res.statusCode = upstream.status;
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (!res.hasHeader("cache-control")) res.setHeader("Cache-Control", "no-store");
    res.end(payload);
    return upstream.status;
  }

  async function readiness(): Promise<{ ok: boolean; services: Record<string, string> }> {
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

  function catalog() {
    return {
      authMode: config.authMode,
      routes: ROUTES.map((route) => ({
        method: route.method,
        path: route.path,
        service: route.service,
        access: route.access,
        description: route.description,
        available: Boolean(config.upstreams[route.service]),
        ...(route.provisional ? { provisional: true } : {}),
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

    res.setHeader("X-Content-Type-Options", "nosniff");
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
        const result = await readiness();
        sendJson(res, (status = result.ok ? 200 : 503), result);
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

      status = await forward(req, res, route, result.match.params, url.search, requestId);
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
        sendJson(res, status, { error: { code: httpError.code, message: httpError.message } });
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
        status,
        ms: now() - started,
      });
    }
  }

  return { handle, catalog };
}
