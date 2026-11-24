// Consistencia CLI ↔ catálogo (escenario de seguridad 2): toda operación de la CLI de
// administración (admin-cli/) debe existir en el catálogo del Gateway. Si la CLI
// necesitara una ruta que no está aquí, solo funcionaría saltándose el Gateway.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Router } from "../src/router.ts";
import { ROUTES } from "../src/routes.ts";

const router = new Router(ROUTES);
const CLI_SOURCES = join(import.meta.dirname, "..", "..", "admin-cli", "src", "main");

// Operaciones que ejecuta cada comando de la CLI (ver admin-cli/README.md).
const CLI_OPERATIONS: [string, string, string][] = [
  ["login", "POST", "/api/auth/login"],
  ["login", "POST", "/api/auth/login/mfa"],
  ["whoami", "GET", "/api/auth/me"],
  ["logout", "POST", "/api/auth/logout"],
  ["users list", "GET", "/api/auth/users"],
  ["users create", "POST", "/api/auth/users"],
  ["users disable|enable", "PATCH", "/api/auth/users/20"],
  ["elections list", "GET", "/api/elections"],
  ["elections create", "POST", "/api/elections"],
  ["elections open", "POST", "/api/elections/7/open"],
  ["elections close", "POST", "/api/elections/7/close"],
  ["elections status|tally", "GET", "/api/elections/7/status"],
  ["elections results|tally", "GET", "/api/ballots/elections/7/results"],
  ["voters list", "GET", "/api/identity/elections/7/voters"],
  ["voters add", "POST", "/api/identity/elections/7/voters"],
  ["voters set", "PATCH", "/api/identity/elections/7/voters/5"],
];

test("cada operación de la CLI está en el catálogo del Gateway", () => {
  for (const [command, method, path] of CLI_OPERATIONS) {
    const result = router.match(method, path);
    assert.equal(result.kind, "found", `${command}: ${method} ${path}`);
    if (result.kind !== "found") continue;
    // Salvo los resultados (ruta anónima), todo lo administrativo exige sesión.
    if (!command.startsWith("login") && !path.startsWith("/api/ballots/")) {
      assert.notEqual(result.match.route.access, "public", `${command}: ${path}`);
    }
  }
});

function javaFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return javaFiles(full);
    return name.endsWith(".java") ? [full] : [];
  });
}

test("los literales /api/ del código de la CLI son prefijos de rutas del catálogo", { skip: !existsSync(CLI_SOURCES) }, () => {
  const literals = new Set<string>();
  for (const file of javaFiles(CLI_SOURCES)) {
    for (const match of readFileSync(file, "utf8").matchAll(/"(\/[a-z][^"]*)"/g)) {
      const literal = match[1] as string;
      // Raíces de las rutas internas de identity; "/voters", "/open", etc. son sufijos.
      if (/^\/(login|logout|users|elections|auth)\b/.test(literal)) {
        assert.fail(`ruta interna en la CLI: ${literal} (${file})`);
      }
      if (literal.startsWith("/api/") && literal !== "/api/") literals.add(literal);
    }
  }
  assert.ok(literals.size > 0);
  for (const literal of literals) {
    assert.ok(
      ROUTES.some((route) => route.path.startsWith(literal)),
      `${literal} no es prefijo de ninguna ruta del catálogo`,
    );
  }
});
