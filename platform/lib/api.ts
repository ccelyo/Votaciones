import * as mockApi from "@/lib/mock-api";
import type {
  CreatedElection,
  Election,
  ElectionCreatePayload,
  ElectionEstatus,
  ElectionVote,
} from "@/lib/types/election";
import type {
  LoginPayload,
  MessageResponse,
  RegisterPayload,
  User,
} from "@/lib/types/user";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";
const USE_MOCK_API = process.env.NEXT_PUBLIC_API_MODE === "mock";

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

async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  if (!API_URL) {
    throw new Error(
      "Configura NEXT_PUBLIC_API_URL para conectarte con la API.",
    );
  }

  const { json, headers, ...rest } = options;
  const response = await fetch(`${API_URL}${path}`, {
    ...rest,
    cache: "no-store",
    credentials: "include",
    headers: {
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
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
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function login(payload: LoginPayload): Promise<User> {
  if (USE_MOCK_API) return mockApi.login(payload);
  return apiFetch<User>("/login", {
    method: "POST",
    json: payload,
  });
}

export function logout(): Promise<void> {
  if (USE_MOCK_API) return mockApi.logout();
  return apiFetch<void>("/logout", {
    method: "POST",
  });
}

export function register(payload: RegisterPayload): Promise<MessageResponse> {
  if (USE_MOCK_API) return mockApi.register(payload);
  return apiFetch<MessageResponse>("/register", {
    method: "POST",
    json: payload,
  });
}

export function getElections(status: ElectionEstatus): Promise<Election[]> {
  if (USE_MOCK_API) return mockApi.getElections(status);
  const query = new URLSearchParams({ status });
  return apiFetch<Election[]>(`/elections?${query}`);
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
  try {
    return await apiFetch<User>("/auth/me");
  } catch {
    return null;
  }
}
