// Conector interno Cliente navegador → Servidor SSR (vista C&C P2).
//
// El navegador solo habla con su propio origen. Este manejador reenvía cada
// petición /api/* al API Gateway y custodia la sesión en una cookie httpOnly:
// el token nunca llega a JavaScript.

import type { NextRequest } from "next/server";

import { GATEWAY_URL, SESSION_COOKIE } from "@/lib/server/gateway";

const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type"];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
];

type Context = { params: Promise<{ path: string[] }> };

function isBallotPath(path: string[]): boolean {
  return path[0] === "ballots";
}

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

function json(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function proxy(
  request: NextRequest,
  { params }: Context,
): Promise<Response> {
  const { path } = await params;
  const method = request.method;

  // La cookie es SameSite=Strict; además se rechazan peticiones de otros orígenes.
  if (method !== "GET" && method !== "HEAD" && !sameOrigin(request)) {
    return json(403, "forbidden_origin", "Origen no permitido.");
  }

  const target = `${GATEWAY_URL}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const anonymous = isBallotPath(path);
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  // La papeleta viaja sin sesión, cookies ni IP: no se puede vincular con el votante.
  if (!anonymous) {
    if (token) headers.set("authorization", `Bearer ${token}`);
    const forwardedFor = request.headers.get("x-forwarded-for");
    if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);
  }

  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return json(
      502,
      "gateway_unavailable",
      "No se pudo contactar el API Gateway.",
    );
  }

  const route = path.join("/");
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const secure = request.nextUrl.protocol === "https:";

  // Inicio de sesión: el token se guarda en la cookie y no se entrega al navegador.
  if (route === "auth/login/mfa" && method === "POST" && upstream.ok) {
    const session = (await upstream.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (
      !session.access_token ||
      !session.expires_in ||
      session.expires_in <= 0
    ) {
      return json(
        502,
        "invalid_session",
        "Auth devolvió una sesión no válida.",
      );
    }
    const response = Response.json(
      { token_type: session.token_type, expires_in: session.expires_in },
      { status: upstream.status },
    );
    response.headers.append(
      "set-cookie",
      sessionCookie(session.access_token, session.expires_in, secure),
    );
    return response;
  }

  const response = new Response(
    upstream.status === 204 ? null : upstream.body,
    {
      status: upstream.status,
      headers: responseHeaders,
    },
  );
  // Al cerrar sesión, o si la sesión ya no es válida, se borra la cookie.
  if (
    (route === "auth/logout" && method === "POST") ||
    (token && !anonymous && upstream.status === 401)
  ) {
    response.headers.append("set-cookie", sessionCookie("", 0, secure));
  }
  return response;
}

function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PATCH,
  proxy as PUT,
  proxy as DELETE,
};
