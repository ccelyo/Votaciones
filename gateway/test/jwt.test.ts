import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createJwksResolver, JwksUnavailableError, verifyJwt } from "../src/jwt.ts";
import {
  AUDIENCE,
  identityClaims,
  ISSUER,
  jwks,
  newKey,
  signHs256WithPublicKey,
  signRs256,
} from "./keys.ts";

const NOW = 1_800_000_000_000;
const key = newKey("k1");
const other = newKey("k2");

function resolverFor(...keys: ReturnType<typeof newKey>[]) {
  const map = new Map(keys.map((k) => [k.kid, k.publicKey]));
  return async (kid: string) => map.get(kid);
}

const options = { keys: resolverFor(key), issuer: ISSUER, audience: AUDIENCE, now: () => NOW };
const claims = (overrides: Record<string, unknown> = {}) => identityClaims(overrides, NOW);

describe("verifyJwt", () => {
  test("acepta el token de identity y lee el rol", async () => {
    const token = signRs256(claims({ role: "admin", sub: "7" }), key);
    assert.deepEqual(await verifyJwt(token, options), { userId: "7", roles: ["admin"] });
  });

  test("rechaza la firma de una clave que no corresponde al kid", async () => {
    const token = signRs256(claims(), { ...other, kid: "k1" });
    await assert.rejects(verifyJwt(token, options), /invalid signature/);
  });

  test("rechaza un kid que no está en el JWKS", async () => {
    await assert.rejects(verifyJwt(signRs256(claims(), other), options), /unknown kid/);
  });

  test("rechaza un token sin kid", async () => {
    await assert.rejects(verifyJwt(signRs256(claims(), key, { kid: undefined }), options), /missing kid/);
  });

  test("rechaza alg none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims())).toString("base64url");
    await assert.rejects(verifyJwt(`${header}.${payload}.`, options), /unsupported algorithm/);
  });

  test("rechaza HS256 firmado con la clave pública (confusión de algoritmo)", async () => {
    const token = signHs256WithPublicKey(claims({ role: "admin" }), key);
    await assert.rejects(verifyJwt(token, options), /unsupported algorithm/);
  });

  test("rechaza un payload alterado", async () => {
    const [header, , signature] = signRs256(claims(), key).split(".");
    const forged = Buffer.from(JSON.stringify(claims({ role: "admin" }))).toString("base64url");
    await assert.rejects(verifyJwt(`${header}.${forged}.${signature}`, options), /invalid signature/);
  });

  test("aplica exp y nbf con 30 s de tolerancia", async () => {
    const now = NOW / 1000;
    await assert.doesNotReject(verifyJwt(signRs256(claims({ exp: now - 20 }), key), options));
    await assert.rejects(verifyJwt(signRs256(claims({ exp: now - 31 }), key), options), /expired/);
    await assert.doesNotReject(verifyJwt(signRs256(claims({ nbf: now + 20 }), key), options));
    await assert.rejects(verifyJwt(signRs256(claims({ nbf: now + 31 }), key), options), /not yet valid/);
  });

  test("exige iss y aud de identity", async () => {
    await assert.rejects(verifyJwt(signRs256(claims({ iss: "otro" }), key), options), /issuer/);
    await assert.rejects(verifyJwt(signRs256(claims({ aud: "otro" }), key), options), /audience/);
    await assert.rejects(verifyJwt(signRs256(claims({ iss: undefined }), key), options), /issuer/);
  });

  test("exige exp y sub en texto", async () => {
    await assert.rejects(verifyJwt(signRs256(claims({ exp: undefined }), key), options), /exp/);
    await assert.rejects(verifyJwt(signRs256(claims({ sub: undefined }), key), options), /sub/);
    await assert.rejects(verifyJwt(signRs256(claims({ sub: 42 }), key), options), /sub/);
  });

  test("rechaza tokens mal formados", async () => {
    await assert.rejects(verifyJwt("no-es-un-jwt", options), /malformed/);
    await assert.rejects(verifyJwt("a.b.c", options), /malformed/);
  });
});

function fakeFetch(body: () => unknown) {
  const calls: string[] = [];
  const doFetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const value = body();
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, doFetch };
}

describe("createJwksResolver", () => {
  const url = "http://identity:8000/.well-known/jwks.json";

  test("descarga el JWKS una vez y lo cachea", async () => {
    const { calls, doFetch } = fakeFetch(() => jwks(key));
    const resolve = createJwksResolver({ url, fetch: doFetch });
    assert.ok(await resolve("k1"));
    assert.ok(await resolve("k1"));
    assert.deepEqual(calls, [url]);
  });

  test("recarga ante un kid desconocido (rotación), con un intervalo mínimo", async () => {
    let published = jwks(key);
    let clock = 0;
    const { calls, doFetch } = fakeFetch(() => published);
    const resolve = createJwksResolver({ url, fetch: doFetch, now: () => clock, refreshCooldownMs: 30_000 });

    assert.ok(await resolve("k1"));
    published = jwks(key, other);
    // Dentro del intervalo no se vuelve a pedir: un kid inventado no inunda a identity.
    clock = 10_000;
    assert.equal(await resolve("k2"), undefined);
    assert.equal(calls.length, 1);

    clock = 31_000;
    assert.ok(await resolve("k2"));
    assert.equal(calls.length, 2);
  });

  test("ignora claves que no son RSA de firma o de menos de 2048 bits", async () => {
    const small = newKey("small", 1024);
    const enc = { ...jwks(newKey("enc")).keys[0], use: "enc" };
    const { doFetch } = fakeFetch(() => ({ keys: [...jwks(small).keys, enc, { kty: "EC", kid: "ec" }] }));
    const resolve = createJwksResolver({ url, fetch: doFetch });
    assert.equal(await resolve("small"), undefined);
    assert.equal(await resolve("enc"), undefined);
    assert.equal(await resolve("ec"), undefined);
  });

  test("si identity no responde y no hay caché, lo señala como no disponible", async () => {
    const { doFetch } = fakeFetch(() => new Error("ECONNREFUSED"));
    const resolve = createJwksResolver({ url, fetch: doFetch });
    await assert.rejects(resolve("k1"), JwksUnavailableError);
  });

  test("con caché, un fallo al recargar no invalida las claves conocidas", async () => {
    let fail = false;
    let clock = 0;
    const { doFetch } = fakeFetch(() => (fail ? new Error("down") : jwks(key)));
    const resolve = createJwksResolver({ url, fetch: doFetch, now: () => clock, refreshCooldownMs: 0 });
    assert.ok(await resolve("k1"));
    fail = true;
    clock = 1;
    assert.equal(await resolve("k2"), undefined);
    assert.ok(await resolve("k1"));
  });
});
