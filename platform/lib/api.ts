import { enviarPapeleta } from "@/lib/m4/api";
import {
  cegarPss,
  claveDesdeDerSpki,
  finalizarPss,
  prepararToken,
} from "@/lib/m4/blind";
import { CifradorTextoPlano } from "@/lib/m4/encryptor";
import { aBase64Url, deBase64Url, serializarSobre } from "@/lib/m4/token";
import {
  borrarTokenAnonimo,
  guardarTokenAnonimo,
  obtenerTokenAnonimo,
} from "@/lib/m4/tokenStore";
import * as mockApi from "@/lib/mock-api";
import type {
  AdminElection,
  CreatedElection,
  Election,
  ElectionCreatePayload,
  ElectionEstatus,
  ElectionSummary,
  ElectionVote,
  Eligibility,
  VoterRollEntry,
} from "@/lib/types/election";
import type {
  CurrentUser,
  DirectoryUser,
  LoginChallenge,
  LoginPayload,
  MessageResponse,
  MfaLoginResponse,
  RegisterPayload,
  User,
} from "@/lib/types/user";

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
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
  token_key: {
    kid: string;
    public_key_der: string;
    variant: string;
  };
};

type BlindTokenResponse = {
  kid: string;
  variant: string;
  blind_signature: string;
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

export async function castVote(
  electionId: number,
  option: string,
): Promise<ElectionVote> {
  if (USE_MOCK_API) return mockApi.castVote(electionId, option);

  const user = await getCurrentUser();
  if (!user) throw new Error("Debes iniciar sesión para votar.");
  const parameters = await apiFetch<ElectionParametersResponse>(
    `/elections/${encodeURIComponent(electionId)}/parameters`,
  );
  if (!parameters.options.includes(option)) {
    throw new Error("Selecciona una opción válida.");
  }
  const electionRef = parameters.election_id;

  // Identidad emite un solo token por votante: si un envío anterior falló,
  // se reutiliza el token guardado en memoria en lugar de pedir otro.
  let signedToken = obtenerTokenAnonimo(electionRef);
  if (!signedToken) {
    signedToken = await requestAnonymousToken(
      electionRef,
      parameters.token_key,
    );
    guardarTokenAnonimo(electionRef, signedToken);
  }

  const { ciphertext, proof } = await new CifradorTextoPlano().cifrar(
    option,
    electionRef,
  );
  const result = await enviarPapeleta({
    electionId: electionRef,
    votoCifrado: ciphertext,
    prueba: proof,
    tokenFirmado: signedToken,
  });
  borrarTokenAnonimo();

  // Marca has_voted en el padrón; el voto ya quedó registrado aunque falle.
  await apiFetch("/vote-confirmation", {
    method: "POST",
    json: { election_id: electionRef },
  }).catch(() => undefined);

  return {
    election_id: electionId,
    user_id: user.id,
    option,
    created_at: new Date().toISOString(),
    receipt: result.recibo,
  };
}

async function requestAnonymousToken(
  electionRef: string,
  tokenKey: ElectionParametersResponse["token_key"],
): Promise<string> {
  const publicKeyDer = deBase64Url(tokenKey.public_key_der);
  const { prepared, nonce } = prepararToken(electionRef);
  const { cegado, estado } = await cegarPss(
    prepared,
    claveDesdeDerSpki(publicKeyDer),
    tokenKey.variant,
  );

  let response: BlindTokenResponse;
  try {
    response = await apiFetch<BlindTokenResponse>("/tokens/blind", {
      method: "POST",
      json: { election_id: electionRef, blinded_token: aBase64Url(cegado) },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      throw new Error(
        /already issued/i.test(error.message)
          ? "Ya se emitió tu token para esta elección; tu voto ya fue registrado o el envío anterior no se completó."
          : "La elección no está abierta.",
      );
    }
    if (error instanceof ApiError && error.status === 403) {
      throw new Error("No estás habilitado en el padrón de esta elección.");
    }
    throw error;
  }

  const signature = await finalizarPss(
    deBase64Url(response.blind_signature),
    estado,
    publicKeyDer,
    response.variant,
  );
  return serializarSobre({
    version: 1,
    kid: response.kid,
    electionId: electionRef,
    nonce,
    preparedMessage: prepared,
    signature,
  });
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

// ---- Padrón y administración -----------------------------------------------

export function getEligibility(electionId: number): Promise<Eligibility> {
  if (USE_MOCK_API) return mockApi.getEligibility(electionId);
  return apiFetch<Eligibility>(
    `/elections/${encodeURIComponent(electionId)}/eligibility`,
  );
}

export function listAllElections(): Promise<AdminElection[]> {
  if (USE_MOCK_API) return mockApi.listAllElections();
  return apiFetch<AdminElection[]>("/elections");
}

export function getElectionSummary(
  electionId: number,
): Promise<ElectionSummary> {
  if (USE_MOCK_API) return mockApi.getElectionSummary(electionId);
  return apiFetch<ElectionSummary>(
    `/elections/${encodeURIComponent(electionId)}/status`,
  );
}

export async function closeElection(electionId: number): Promise<void> {
  if (USE_MOCK_API) return mockApi.closeElection(electionId);
  await apiFetch(`/elections/${encodeURIComponent(electionId)}/close`, {
    method: "POST",
  });
}

export function listUsers(): Promise<DirectoryUser[]> {
  if (USE_MOCK_API) return mockApi.listUsers();
  return apiFetch<DirectoryUser[]>("/users");
}

export function getVoterRoll(electionId: number): Promise<VoterRollEntry[]> {
  if (USE_MOCK_API) return mockApi.getVoterRoll(electionId);
  return apiFetch<VoterRollEntry[]>(
    `/elections/${encodeURIComponent(electionId)}/voters`,
  );
}

export async function enrollVoter(
  electionId: number,
  userId: number,
): Promise<void> {
  if (USE_MOCK_API) return mockApi.enrollVoter(electionId, userId);
  await apiFetch(`/elections/${encodeURIComponent(electionId)}/voters`, {
    method: "POST",
    json: { user_id: userId, is_eligible: true },
  });
}

export async function setVoterEligibility(
  electionId: number,
  userId: number,
  isEligible: boolean,
): Promise<void> {
  if (USE_MOCK_API)
    return mockApi.setVoterEligibility(electionId, userId, isEligible);
  await apiFetch(
    `/elections/${encodeURIComponent(electionId)}/voters/${userId}`,
    { method: "PATCH", json: { is_eligible: isEligible } },
  );
}
