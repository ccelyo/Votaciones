import type { RouteDefinition } from "./routes.ts";

export interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}

export type MatchResult =
  | { kind: "found"; match: RouteMatch }
  | { kind: "method-not-allowed"; allow: string[] }
  | { kind: "not-found" };

interface CompiledRoute {
  route: RouteDefinition;
  segments: string[];
  staticCount: number;
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export class Router {
  readonly #routes: CompiledRoute[];

  constructor(routes: readonly RouteDefinition[]) {
    this.#routes = routes
      .map((route) => {
        const segments = splitPath(route.path);
        return {
          route,
          segments,
          staticCount: segments.filter((s) => !s.startsWith(":")).length,
        };
      })
      // Los segmentos fijos ganan a los parámetros: /elections/open antes que /elections/:id.
      .sort((a, b) => b.staticCount - a.staticCount);
  }

  match(method: string, pathname: string): MatchResult {
    let segments: string[];
    try {
      segments = splitPath(pathname).map((s) => decodeURIComponent(s));
    } catch {
      return { kind: "not-found" };
    }

    const allow = new Set<string>();
    for (const compiled of this.#routes) {
      const params = matchSegments(compiled.segments, segments);
      if (!params) continue;
      if (compiled.route.method === method) {
        return { kind: "found", match: { route: compiled.route, params } };
      }
      allow.add(compiled.route.method);
    }
    if (allow.size > 0) return { kind: "method-not-allowed", allow: [...allow] };
    return { kind: "not-found" };
  }
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i] as string;
    const value = actual[i] as string;
    if (expected.startsWith(":")) {
      if (!value) return null;
      params[expected.slice(1)] = value;
    } else if (expected !== value) {
      return null;
    }
  }
  return params;
}

/** Sustituye `:param` en la ruta del servicio, codificando cada valor. */
export function buildUpstreamPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]\w*)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Falta el parámetro ${name}`);
    return encodeURIComponent(value);
  });
}
