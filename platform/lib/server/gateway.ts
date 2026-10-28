// Cliente del API Gateway para el Servidor SSR. Solo se ejecuta en el servidor:
// el navegador nunca conoce la URL del Gateway ni el token de sesión.
import "server-only";

import { cookies } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { cache } from "react";

import type { AdminElection, Election } from "@/lib/types/election";
import type { CurrentUser, User } from "@/lib/types/user";

export const GATEWAY_URL = (
  process.env.GATEWAY_URL ?? "http://localhost:8088"
).replace(/\/+$/, "");
export const SESSION_COOKIE = "espivota_session";

/** En modo mock los datos viven en el navegador y el servidor no puede leerlos. */
export const SERVER_DATA_ENABLED = process.env.NEXT_PUBLIC_API_MODE !== "mock";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

async function gatewayGet<T>(path: string): Promise<T> {
  const token = await sessionToken();
  const response = await fetch(`${GATEWAY_URL}${path}`, {
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new GatewayError(
      `Gateway ${path} (${response.status})`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

/**
 * Usuario de la sesión actual, o null si no hay sesión válida. Se memoriza por
 * petición: Header y las guardas comparten una sola llamada al Gateway.
 */
export const getSessionUser = cache(async (): Promise<User | null> => {
  if (!(await sessionToken())) return null;
  try {
    return await gatewayGet<CurrentUser>("/api/auth/me");
  } catch (error) {
    unstable_rethrow(error);
    if (!(error instanceof GatewayError && error.status === 401)) {
      console.error("No se pudo comprobar la sesión:", error);
    }
    return null;
  }
});

/**
 * Redirige al login o al inicio si el usuario no es administrador. Devuelve
 * true cuando la verificación se hizo en el servidor (false en modo mock, donde
 * la hace el navegador).
 */
export async function requireAdmin(nextPath: string): Promise<boolean> {
  if (!SERVER_DATA_ENABLED) return false;
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  if (user.role !== "admin") redirect("/");
  return true;
}

/** Devuelve undefined si falla, para que el navegador reintente la carga. */
async function optional<T>(load: () => Promise<T>): Promise<T | undefined> {
  if (!SERVER_DATA_ENABLED) return undefined;
  try {
    return await load();
  } catch (error) {
    unstable_rethrow(error);
    console.error("Carga en el servidor fallida:", error);
    return undefined;
  }
}

export function loadOpenElections(): Promise<Election[] | undefined> {
  return optional(() => gatewayGet<Election[]>("/api/elections/open"));
}

export function loadAllElections(): Promise<AdminElection[] | undefined> {
  return optional(() => gatewayGet<AdminElection[]>("/api/elections"));
}
