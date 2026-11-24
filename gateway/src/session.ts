// Mediación completa (escenario de seguridad 2, Prototipo 3).
//
// El JWT de identity se valida sin estado (firma, iss, aud, exp), así que por sí
// solo no refleja un `POST /logout` ni la desactivación de un usuario hasta que
// expira (1 h). Antes de reenviar una petición autenticada, el Gateway pregunta a
// identity (`GET /auth/me`, por el mismo canal mTLS) si la sesión sigue vigente y
// qué rol tiene el usuario en la base de datos. El resultado positivo se guarda
// unos segundos por hash del token para no llamar a identity en cada petición.

import { createHash } from "node:crypto";

import type { Principal } from "./jwt.ts";

/** identity rechazó la sesión (revocada, usuario desactivado o inexistente). */
export class SessionRevokedError extends Error {}

/** No se pudo consultar la sesión: el Gateway falla cerrado (503). */
export class SessionUnavailableError extends Error {}

export interface SessionVerifierOptions {
  /** URL de identity (Auth), p. ej. https://identity:8000. */
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tiempo máximo que se reutiliza una sesión ya comprobada. */
  ttlMs?: number;
  /** Número máximo de sesiones en caché. */
  maxEntries?: number;
  timeoutMs?: number;
}

export interface SessionVerifier {
  verify(token: string, principal: Principal): Promise<Principal>;
  invalidateToken(token: string): void;
  invalidateUser(userId: string): void;
}

interface Entry {
  principal: Principal;
  expiresAt: number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionVerifier(options: SessionVerifierOptions): SessionVerifier {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 5_000;
  const maxEntries = Math.max(1, options.maxEntries ?? 10_000);
  const timeoutMs = options.timeoutMs ?? 2_000;
  const meUrl = `${options.url.replace(/\/+$/, "")}/auth/me`;

  // Map conserva el orden de inserción: la primera clave es la más antigua.
  const cache = new Map<string, Entry>();
  const byUser = new Map<string, Set<string>>();
  // Se incrementa en cada invalidación. Una consulta a identity que estaba en vuelo
  // cuando se invalidó (logout o PATCH concurrentes) no guarda su resultado: si lo
  // hiciera, el token revocado volvería a la caché durante otro TTL completo.
  let generation = 0;

  function remove(hash: string): void {
    const entry = cache.get(hash);
    if (!entry) return;
    cache.delete(hash);
    const hashes = byUser.get(entry.principal.userId);
    hashes?.delete(hash);
    if (hashes?.size === 0) byUser.delete(entry.principal.userId);
  }

  function store(hash: string, principal: Principal): void {
    const ttlLimit = now() + ttlMs;
    const expiresAt = principal.expiresAt !== undefined ? Math.min(ttlLimit, principal.expiresAt * 1000) : ttlLimit;
    if (expiresAt <= now()) return;
    remove(hash);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      remove(oldest);
    }
    cache.set(hash, { principal, expiresAt });
    let hashes = byUser.get(principal.userId);
    if (!hashes) byUser.set(principal.userId, (hashes = new Set()));
    hashes.add(hash);
  }

  async function verify(token: string, principal: Principal): Promise<Principal> {
    const hash = hashToken(token);
    const cached = cache.get(hash);
    if (cached) {
      if (cached.expiresAt > now()) return cached.principal;
      remove(hash);
    }

    const startedAt = generation;
    let response: Response;
    try {
      response = await doFetch(meUrl, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SessionUnavailableError(`session check failed: ${String(error)}`);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new SessionRevokedError(`session rejected (http ${response.status})`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SessionUnavailableError(`session check failed (http ${response.status})`);
    }

    let body: { id?: unknown; role?: unknown };
    try {
      body = (await response.json()) as { id?: unknown; role?: unknown };
    } catch {
      throw new SessionUnavailableError("session check returned an invalid body");
    }
    if (body === null || typeof body !== "object" || body.id === undefined || body.id === null) {
      throw new SessionUnavailableError("session check returned an invalid body");
    }
    // El token pertenece a otro usuario que el que dice el JWT: no se acepta.
    if (String(body.id) !== principal.userId) {
      throw new SessionRevokedError("session subject mismatch");
    }
    // El rol vigente es el de la base de datos de identity, no el del claim.
    const verified: Principal = {
      userId: String(body.id),
      roles: typeof body.role === "string" && body.role ? [body.role] : [],
      ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
    };
    // Si hubo una invalidación mientras se consultaba, la respuesta se usa para esta
    // petición (identity la emitió antes de la revocación) pero no se cachea.
    if (generation === startedAt) store(hash, verified);
    return verified;
  }

  return {
    verify,
    invalidateToken(token) {
      generation += 1;
      remove(hashToken(token));
    },
    invalidateUser(userId) {
      generation += 1;
      for (const hash of [...(byUser.get(userId) ?? [])]) remove(hash);
    },
  };
}
