import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Principal } from "../src/jwt.ts";
import { createSessionVerifier, SessionRevokedError, SessionUnavailableError } from "../src/session.ts";

const URL = "https://identity:8000";
const T0 = 1_800_000_000_000;

interface FakeIdentity {
  fetch: typeof fetch;
  calls: { url: string; authorization: string | null }[];
  reply: (status: number, body?: unknown) => void;
  fail: () => void;
}

function fakeIdentity(): FakeIdentity {
  let next: () => Response = () => Response.json({ id: 42, username: "v", role: "voter" });
  const calls: FakeIdentity["calls"] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return next();
  }) as typeof fetch;
  return {
    fetch: fakeFetch,
    calls,
    reply(status, body = {}) {
      next = () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
    fail() {
      next = () => {
        throw new TypeError("fetch failed");
      };
    },
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return { userId: "42", roles: ["admin"], expiresAt: T0 / 1000 + 3600, ...overrides };
}

function setup(options: { ttlMs?: number; maxEntries?: number } = {}) {
  const identity = fakeIdentity();
  let clock = T0;
  const verifier = createSessionVerifier({
    url: URL,
    fetch: identity.fetch,
    now: () => clock,
    ttlMs: options.ttlMs ?? 5_000,
    maxEntries: options.maxEntries,
  });
  return {
    identity,
    verifier,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("createSessionVerifier", () => {
  test("una sesión activa devuelve el rol de identity y consulta /auth/me con el token", async () => {
    const { identity, verifier } = setup();
    const verified = await verifier.verify("tok-a", principal());
    assert.deepEqual(verified.roles, ["voter"]);
    assert.equal(verified.userId, "42");
    assert.deepEqual(identity.calls, [{ url: `${URL}/auth/me`, authorization: "Bearer tok-a" }]);
  });

  test("dentro del TTL no vuelve a consultar identity", async () => {
    const { identity, verifier, advance } = setup();
    await verifier.verify("tok-a", principal());
    advance(4_999);
    await verifier.verify("tok-a", principal());
    assert.equal(identity.calls.length, 1);
  });

  test("al vencer el TTL vuelve a consultar", async () => {
    const { identity, verifier, advance } = setup();
    await verifier.verify("tok-a", principal());
    advance(5_000);
    await verifier.verify("tok-a", principal());
    assert.equal(identity.calls.length, 2);
  });

  test("la caché nunca dura más que el exp del token", async () => {
    const { identity, verifier, advance } = setup({ ttlMs: 60_000 });
    const shortLived = principal({ expiresAt: T0 / 1000 + 2 });
    await verifier.verify("tok-a", shortLived);
    advance(2_000);
    await verifier.verify("tok-a", shortLived);
    assert.equal(identity.calls.length, 2);
  });

  test("401 de identity lanza SessionRevokedError y no se guarda", async () => {
    const { identity, verifier } = setup();
    identity.reply(401, { error: { code: "unauthenticated" } });
    await assert.rejects(verifier.verify("tok-a", principal()), SessionRevokedError);
    await assert.rejects(verifier.verify("tok-a", principal()), SessionRevokedError);
    assert.equal(identity.calls.length, 2);
  });

  test("403 de identity también se trata como sesión no válida", async () => {
    const { identity, verifier } = setup();
    identity.reply(403, { error: { code: "forbidden" } });
    await assert.rejects(verifier.verify("tok-a", principal()), SessionRevokedError);
  });

  test("un error de red falla cerrado con SessionUnavailableError", async () => {
    const { identity, verifier } = setup();
    identity.fail();
    await assert.rejects(verifier.verify("tok-a", principal()), SessionUnavailableError);
  });

  test("un 5xx de identity falla cerrado y no se guarda", async () => {
    const { identity, verifier } = setup();
    identity.reply(500, {});
    await assert.rejects(verifier.verify("tok-a", principal()), SessionUnavailableError);
    identity.reply(200, { id: 42, role: "admin" });
    assert.deepEqual((await verifier.verify("tok-a", principal())).roles, ["admin"]);
  });

  test("rechaza una respuesta de otro usuario distinto del sub del JWT", async () => {
    const { identity, verifier } = setup();
    identity.reply(200, { id: 7, role: "admin" });
    await assert.rejects(verifier.verify("tok-a", principal()), SessionRevokedError);
  });

  test("invalidateToken fuerza una nueva consulta", async () => {
    const { identity, verifier } = setup();
    await verifier.verify("tok-a", principal());
    verifier.invalidateToken("tok-a");
    identity.reply(401, {});
    await assert.rejects(verifier.verify("tok-a", principal()), SessionRevokedError);
    assert.equal(identity.calls.length, 2);
  });

  test("invalidateUser descarta todas las sesiones del usuario y solo las suyas", async () => {
    const { identity, verifier } = setup();
    await verifier.verify("tok-a", principal());
    await verifier.verify("tok-b", principal());
    identity.reply(200, { id: 9, role: "voter" });
    await verifier.verify("tok-c", principal({ userId: "9" }));
    assert.equal(identity.calls.length, 3);

    verifier.invalidateUser("42");
    identity.reply(200, { id: 42, role: "voter" });
    await verifier.verify("tok-a", principal());
    await verifier.verify("tok-b", principal());
    identity.reply(200, { id: 9, role: "voter" });
    await verifier.verify("tok-c", principal({ userId: "9" }));
    assert.equal(identity.calls.length, 5);
  });

  test("maxEntries expulsa la entrada más antigua", async () => {
    const { identity, verifier } = setup({ maxEntries: 2 });
    await verifier.verify("tok-a", principal());
    await verifier.verify("tok-b", principal());
    await verifier.verify("tok-c", principal());
    assert.equal(identity.calls.length, 3);
    await verifier.verify("tok-c", principal());
    await verifier.verify("tok-b", principal());
    assert.equal(identity.calls.length, 3);
    await verifier.verify("tok-a", principal());
    assert.equal(identity.calls.length, 4);
  });

  // Una consulta en vuelo cuando llega el logout o el PATCH no debe volver a cachear
  // la sesión revocada durante otro TTL.
  for (const kind of ["token", "user"] as const) {
    test(`una invalidación (${kind}) durante la consulta impide cachear su resultado`, async () => {
      const calls: string[] = [];
      let release: (() => void) | undefined;
      const deferredFetch = (async (input: string | URL | Request) => {
        calls.push(String(input));
        if (calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return Response.json({ id: 42, role: "voter" });
      }) as typeof fetch;
      const verifier = createSessionVerifier({ url: URL, fetch: deferredFetch, now: () => T0, ttlMs: 60_000 });
      const pending = verifier.verify("tok", principal());
      await new Promise((resolve) => setImmediate(resolve));
      if (kind === "token") verifier.invalidateToken("tok");
      else verifier.invalidateUser("42");
      release?.();
      assert.equal((await pending).userId, "42");
      await verifier.verify("tok", principal());
      assert.equal(calls.length, 2);
      // Sin nuevas invalidaciones, la segunda respuesta sí se cachea.
      await verifier.verify("tok", principal());
      assert.equal(calls.length, 2);
    });
  }
});
