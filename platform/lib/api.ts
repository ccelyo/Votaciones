import type { Election, ElectionEstatus } from "@/lib/types/election";
import type { LoginPayload, RegisterPayload, MessageResponse, User } from "@/lib/types/user";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

type ApiOptions = RequestInit & {
  json?: unknown;
};

type ApiErrorBody = {
  detail?: string | { msg?: string }[];
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
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export function login(payload: LoginPayload): Promise<User> {
  return apiFetch<User>("/login", {
    method: "POST",
    json: payload,
  });
}

export function register(payload: RegisterPayload): Promise<MessageResponse> {
  return apiFetch<MessageResponse>("/register", {
    method: "POST",
    json: payload,
  });
}

export function getElections(status: ElectionEstatus): Promise<Election[]> {
  const query = new URLSearchParams({ status });
  return apiFetch<Election[]>(`/elections?${query}`);
}

export async function getCurrentUser(): Promise<User | null> {
  try {
    return await apiFetch<User>("/auth/me");
  } catch {
    return null;
  }
}