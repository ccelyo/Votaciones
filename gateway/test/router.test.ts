import assert from "node:assert/strict";
import { test } from "node:test";

import { buildUpstreamPath, Router } from "../src/router.ts";
import { ROUTES } from "../src/routes.ts";

const router = new Router(ROUTES);

test("los segmentos fijos tienen prioridad sobre los parámetros", () => {
  const result = router.match("GET", "/api/elections/open");
  assert.equal(result.kind, "found");
  assert.equal(result.kind === "found" && result.match.route.upstreamPath, "/elections/open");
});

test("extrae y decodifica los parámetros", () => {
  const result = router.match("GET", "/api/elections/consejo%202026/parameters");
  assert.equal(result.kind, "found");
  assert.deepEqual(result.kind === "found" && result.match.params, { electionId: "consejo 2026" });
});

test("responde 405 con los métodos permitidos", () => {
  const result = router.match("DELETE", "/api/elections");
  assert.equal(result.kind, "method-not-allowed");
  assert.deepEqual(result.kind === "method-not-allowed" && result.allow.sort(), ["GET", "POST"]);
});

test("Blind Signature no está expuesto en el Gateway", () => {
  assert.ok(ROUTES.every((route) => !/blind-signature/.test(route.path)));
  assert.equal(router.match("POST", "/api/blind-signature/sign").kind, "not-found");
});

test("la única forma de llegar a Ballot es por rutas anónimas", () => {
  for (const route of ROUTES.filter((r) => r.service === "ballot")) {
    assert.equal(route.access, "anonymous", route.path);
  }
});

test("las rutas del catálogo son únicas", () => {
  const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("codifica los parámetros al construir la ruta del servicio", () => {
  assert.equal(
    buildUpstreamPath("/v1/elections/:electionId/results", { electionId: "a/b" }),
    "/v1/elections/a%2Fb/results",
  );
});
