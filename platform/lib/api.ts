import * as mockApi from "@/lib/mock-api";
import type {
  CreatedElection,
  Election,
  ElectionCreatePayload,
  ElectionEstatus,
  ElectionVote,
} from "@/lib/types/election";
import type {
  CurrentUser,
  LoginChallenge,
  LoginPayload,
  MessageResponse,
  MfaLoginResponse,
  RegisterPayload,
  User,
} from "@/lib/types/user";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const USE_MOCK_API = process.env.NEXT_PUBLIC_API_MODE === "mock";
const SESSION_STORAGE_KEY = "votaciones.auth.session";

type StoredAuthSession = {
  accessToken: string;
  expiresAt: number;
};

type ElectionParametersResponse = {
  election_id: string;
  name: string;
  options: string[];
  opens_at: number;
  closes_at: number;
};

type ApiOptions = RequestInit & {
  json?: unknown;
};

type ApiErrorBody = {
  detail?: string | { msg?: string }[];
  error?: { message?: string };
};

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function getStoredAuthSession(): StoredAuthSession | null {
  if (typeof window === "undefined") return null;
  const storedValue = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!storedValue) return null;

  try {
    const session = JSON.parse(storedValue) as StoredAuthSession;
    if (
      typeof session.accessToken !== "string" ||
      !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= Date.now()
    ) {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!API_URL) {
    throw new Error(
      "Configura NEXT_PUBLIC_API_URL para conectarte con la API.",
    );
  }

  const { json, headers, ...rest } = options;
  const requestHeaders = new Headers(headers);
  if (json !== undefined)
    requestHeaders.set("Content-Type", "application/json");
  const accessToken = getStoredAuthSession()?.accessToken;
  if (accessToken) requestHeaders.set("Authorization", `Bearer ${accessToken}`);

  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    cache: "no-store",
    credentials: "include",
    headers: requestHeaders,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  if (!response.ok) {
    const responseBody = await response.text();
    let errorBody: ApiErrorBody | null = null;

    if (responseBody) {
      try {
        errorBody = JSON.parse(responseBody) as ApiErrorBody;
      } catch {
        throw new Error(responseBody);
      }
    }

    let message = `Error de API (${response.status}).`;
    if (typeof errorBody?.detail === "string") {
      message = errorBody.detail;
    } else if (Array.isArray(errorBody?.detail) && errorBody.detail[0]?.msg) {
      message = errorBody.detail[0].msg;
    } else if (errorBody?.error?.message) {
      message = errorBody.error.message;
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function login(payload: LoginPayload): Promise<User | LoginChallenge> {
  if (USE_MOCK_API) return mockApi.login(payload);
  return apiFetch<LoginChallenge>("/login", {
    method: "POST",
    json: payload,
  });
}

export async function completeMfaLogin(
  challengeId: string,
  code: string,
): Promise<void> {
  if (USE_MOCK_API) {
    throw new Error("El inicio de sesión mock no requiere verificación MFA.");
  }

  const result = await apiFetch<MfaLoginResponse>("/login/mfa", {
    method: "POST",
    json: { challenge_id: challengeId, code },
  });
  if (
    result.token_type !== "bearer" ||
    !result.access_token ||
    !Number.isFinite(result.expires_in) ||
    result.expires_in <= 0
  ) {
    throw new Error("La API devolvió una sesión no válida.");
  }

  window.sessionStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      accessToken: result.access_token,
      expiresAt: Date.now() + result.expires_in * 1000,
    } satisfies StoredAuthSession),
  );
}

export function logout(): Promise<void> {
  if (USE_MOCK_API) return mockApi.logout();
  if (!getStoredAuthSession()) return Promise.resolve();
  return apiFetch<void>("/logout", { method: "POST" }).finally(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }
  });
}

export function register(payload: RegisterPayload): Promise<MessageResponse> {
  if (USE_MOCK_API) return mockApi.register(payload);
  return Promise.reject(
    new Error("El registro no está disponible en el servicio actual."),
  );
}

export function getElections(status: ElectionEstatus): Promise<Election[]> {
  if (USE_MOCK_API) return mockApi.getElections(status);
  if (status !== "open") return Promise.resolve([]);
  return apiFetch<Election[]>("/elections/open");
}

export function isMockApiEnabled(): boolean {
  return USE_MOCK_API;
}

export async function getElectionForVoting(
  electionId: number,
): Promise<Election | null> {
  if (USE_MOCK_API) return mockApi.getElectionForVoting(electionId);

  const parameters = await apiFetch<ElectionParametersResponse>(
    `/elections/${encodeURIComponent(electionId)}/parameters`,
  );
  return {
    id: electionId,
    name: parameters.name,
    options: parameters.options,
    starts_at: new Date(parameters.opens_at * 1000).toISOString(),
    ends_at: new Date(parameters.closes_at * 1000).toISOString(),
    created_at: "",
  };
}

export function getVoteForCurrentUser(
  electionId: number,
): Promise<ElectionVote | null> {
  if (USE_MOCK_API) return mockApi.getVoteForCurrentUser(electionId);
  return Promise.resolve(null);
}

export function castVote(
  electionId: number,
  option: string,
): Promise<ElectionVote> {
  if (USE_MOCK_API) return mockApi.castVote(electionId, option);
  return Promise.reject(
    new Error(
      "La emisión real del voto aún no está integrada en el backend. Activa el modo mock para probar este flujo.",
    ),
  );
}

export function createElection(
  payload: ElectionCreatePayload,
): Promise<CreatedElection> {
  if (USE_MOCK_API) return mockApi.createElection(payload);
  return apiFetch<CreatedElection>("/elections", {
    method: "POST",
    json: payload,
  });
}

export async function getCurrentUser(): Promise<User | null> {
  if (USE_MOCK_API) return mockApi.getCurrentUser();
  if (!getStoredAuthSession()) return null;

  try {
    return await apiFetch<CurrentUser>("/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    throw error;
  }
}
