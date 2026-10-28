// Catálogo de endpoints del API Gateway (actividad CR-01 del plan del prototipo 2).
//
// Cada ruta pública `/api/...` se traduce a una ruta del servicio que la atiende.
// Blind Signature no aparece: según la vista C&C solo es accesible desde Identity.

export type ServiceName =
  | "auth"
  | "election"
  | "identity"
  | "ballot"
  | "tally"
  | "analytics"
  | "notifications";

/**
 * - `public`: sin autenticación.
 * - `user`: requiere un JWT válido.
 * - `admin`: requiere un JWT válido con el rol `admin`.
 * - `anonymous`: ruta de votación. No acepta ni reenvía credenciales ni datos
 *   que identifiquen al votante (Authorization, cookies, IP, User-Agent).
 */
export type Access = "public" | "user" | "admin" | "anonymous";

/** Cuota de peticiones por minuto que aplica a la ruta. */
export type RateTier = "login" | "default" | "ballot";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RouteDefinition {
  method: Method;
  path: string;
  service: ServiceName;
  upstreamPath: string;
  access: Access;
  rateTier?: RateTier;
  description: string;
  /** La ruta depende de un contrato que el servicio aún no ha publicado. */
  provisional?: boolean;
}

export const ROUTES: readonly RouteDefinition[] = [
  // --- Auth (Julian) -------------------------------------------------------
  { method: "POST", path: "/api/auth/login", service: "auth", upstreamPath: "/login", access: "public", rateTier: "login", description: "Usuario y contraseña; devuelve el reto MFA" },
  { method: "POST", path: "/api/auth/login/mfa", service: "auth", upstreamPath: "/login/mfa", access: "public", rateTier: "login", description: "Código MFA; devuelve el token de sesión" },
  { method: "GET", path: "/api/auth/me", service: "auth", upstreamPath: "/auth/me", access: "user", description: "Usuario autenticado" },
  { method: "POST", path: "/api/auth/logout", service: "auth", upstreamPath: "/logout", access: "user", description: "Revoca la sesión" },
  { method: "GET", path: "/api/auth/users", service: "auth", upstreamPath: "/users", access: "admin", description: "Directorio de usuarios" },

  // --- Election (Fabian) ---------------------------------------------------
  { method: "GET", path: "/api/elections/open", service: "election", upstreamPath: "/elections/open", access: "public", description: "Elecciones abiertas" },
  { method: "GET", path: "/api/elections", service: "election", upstreamPath: "/elections", access: "admin", description: "Todas las elecciones" },
  { method: "POST", path: "/api/elections", service: "election", upstreamPath: "/elections", access: "admin", description: "Crea una elección" },
  { method: "GET", path: "/api/elections/:electionId/parameters", service: "election", upstreamPath: "/elections/:electionId/parameters", access: "user", description: "Opciones, ventana de tiempo y clave del token" },
  { method: "GET", path: "/api/elections/:electionId/status", service: "election", upstreamPath: "/elections/:electionId/status", access: "admin", description: "Estado y participación" },
  { method: "POST", path: "/api/elections/:electionId/close", service: "election", upstreamPath: "/elections/:electionId/close", access: "admin", description: "Cierra la urna" },

  // --- Identity (Kevin) ----------------------------------------------------
  { method: "GET", path: "/api/identity/keys", service: "identity", upstreamPath: "/keys", access: "public", description: "Claves públicas de identidad" },
  { method: "GET", path: "/api/identity/elections/:electionId/eligibility", service: "identity", upstreamPath: "/elections/:electionId/eligibility", access: "user", description: "Elegibilidad del votante" },
  { method: "POST", path: "/api/identity/tokens/blind", service: "identity", upstreamPath: "/tokens/blind", access: "user", description: "Firma ciega del token (Identity → Blind Signature)" },
  { method: "POST", path: "/api/identity/vote-confirmation", service: "identity", upstreamPath: "/vote-confirmation", access: "user", description: "Marca al votante como participante" },
  { method: "GET", path: "/api/identity/elections/:electionId/voters", service: "identity", upstreamPath: "/elections/:electionId/voters", access: "admin", description: "Padrón de la elección" },
  { method: "POST", path: "/api/identity/elections/:electionId/voters", service: "identity", upstreamPath: "/elections/:electionId/voters", access: "admin", description: "Inscribe un votante" },
  { method: "PATCH", path: "/api/identity/elections/:electionId/voters/:userId", service: "identity", upstreamPath: "/elections/:electionId/voters/:userId", access: "admin", description: "Cambia la elegibilidad" },

  // --- Ballot (Andres): ruta anónima ----------------------------------------
  { method: "POST", path: "/api/ballots", service: "ballot", upstreamPath: "/v1/ballots", access: "anonymous", rateTier: "ballot", description: "Papeleta cifrada + token anónimo; devuelve el recibo" },
  { method: "GET", path: "/api/ballots/elections/:electionId/parameters", service: "ballot", upstreamPath: "/v1/elections/:electionId/parameters", access: "anonymous", rateTier: "ballot", description: "Parámetros publicados de la urna" },
  { method: "GET", path: "/api/ballots/elections/:electionId/results", service: "ballot", upstreamPath: "/v1/elections/:electionId/results", access: "anonymous", rateTier: "ballot", description: "Conteo agregado de una urna cerrada" },

  // --- Tally (Sebastian) ---------------------------------------------------
  { method: "POST", path: "/api/tally/elections/:electionId", service: "tally", upstreamPath: "/v1/tally/elections/:electionId", access: "admin", description: "Lanza el escrutinio", provisional: true },
  { method: "GET", path: "/api/tally/elections/:electionId", service: "tally", upstreamPath: "/v1/tally/elections/:electionId", access: "user", description: "Conteo oficial", provisional: true },

  // --- Analytics (Sergio): analytics/CONTRACTS.md §4 ----------------------
  { method: "GET", path: "/api/analytics/summary", service: "analytics", upstreamPath: "/v1/analytics/summary", access: "user", description: "Resumen de todas las elecciones" },
  { method: "GET", path: "/api/analytics/elections", service: "analytics", upstreamPath: "/v1/analytics/elections", access: "user", description: "Elecciones con informe" },
  { method: "GET", path: "/api/analytics/elections/:electionId", service: "analytics", upstreamPath: "/v1/analytics/elections/:electionId", access: "user", description: "Informe completo" },
  { method: "GET", path: "/api/analytics/elections/:electionId/results", service: "analytics", upstreamPath: "/v1/analytics/elections/:electionId/results", access: "user", description: "Resultados por opción" },
  { method: "GET", path: "/api/analytics/elections/:electionId/participation", service: "analytics", upstreamPath: "/v1/analytics/elections/:electionId/participation", access: "user", description: "Participación en tiempo real" },
  { method: "GET", path: "/api/analytics/elections/:electionId/turnout", service: "analytics", upstreamPath: "/v1/analytics/elections/:electionId/turnout", access: "user", description: "Línea de tiempo de participación" },
  { method: "POST", path: "/api/analytics/elections/:electionId/recompute", service: "analytics", upstreamPath: "/v1/analytics/elections/:electionId/recompute", access: "admin", description: "Recalcula el informe" },

  // --- Notifications (Camilo) ----------------------------------------------
  { method: "GET", path: "/api/notifications", service: "notifications", upstreamPath: "/v1/notifications", access: "user", description: "Historial de notificaciones del usuario", provisional: true },
];

/** Ruta de salud de cada servicio, usada por `GET /readyz`. */
export const HEALTH_PATHS: Record<ServiceName, string> = {
  auth: "/health",
  election: "/health",
  identity: "/health",
  ballot: "/healthz",
  tally: "/healthz",
  analytics: "/healthz",
  notifications: "/healthz",
};
