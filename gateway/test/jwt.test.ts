import assert from "node:assert/strict";
import { test } from "node:test";

import { signJwt, verifyJwt } from "../src/jwt.ts";

const SECRET = "secreto-de-pruebas";
const NOW = 1_800_000_000_000;
const exp = NOW / 1000 + 3600;
const options = { secret: SECRET, now: () => NOW };

test("acepta un token válido y lee los roles", () => {
  const token = signJwt({ sub: 7, roles: ["voter", "admin"], exp }, SECRET);
  assert.deepEqual(verifyJwt(token, options), { userId: "7", roles: ["voter", "admin"] });
});

test("acepta el claim role como texto", () => {
  const token = signJwt({ sub: "7", role: "admin", exp }, SECRET);
  assert.deepEqual(verifyJwt(token, options).roles, ["admin"]);
});

test("rechaza una firma con otro secreto", () => {
  const token = signJwt({ sub: "7", exp }, "otro");
  assert.throws(() => verifyJwt(token, options), /invalid signature/);
});

test("rechaza un token expirado", () => {
  const token = signJwt({ sub: "7", exp: NOW / 1000 - 120 }, SECRET);
  assert.throws(() => verifyJwt(token, options), /expired/);
});

test("rechaza alg none", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "7", exp })).toString("base64url");
  assert.throws(() => verifyJwt(`${header}.${payload}.`, options), /unsupported algorithm/);
});

test("rechaza un payload alterado", () => {
  const [header, , signature] = signJwt({ sub: "7", roles: ["voter"], exp }, SECRET).split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "7", roles: ["admin"], exp })).toString("base64url");
  assert.throws(() => verifyJwt(`${header}.${forged}.${signature}`, options), /invalid signature/);
});

test("valida emisor y audiencia cuando están configurados", () => {
  const token = signJwt({ sub: "7", exp, iss: "espivota-auth", aud: "espivota" }, SECRET);
  assert.doesNotThrow(() =>
    verifyJwt(token, { ...options, issuer: "espivota-auth", audience: "espivota" }),
  );
  assert.throws(() => verifyJwt(token, { ...options, issuer: "otro" }), /issuer/);
  assert.throws(() => verifyJwt(token, { ...options, audience: "otro" }), /audience/);
});

test("exige exp y sub", () => {
  assert.throws(() => verifyJwt(signJwt({ sub: "7" }, SECRET), options), /exp/);
  assert.throws(() => verifyJwt(signJwt({ exp }, SECRET), options), /sub/);
});
