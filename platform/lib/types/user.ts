export type UserRole = "voter" | "admin";

export interface User {
  id: number;
  username?: string;
  email?: string;
  full_name?: string;
  role: UserRole;
}

export interface LoginPayload {
  username: string;
  password: string;
}

export interface RegisterPayload {
  full_name: string;
  email: string;
  password: string;
}

export interface MessageResponse {
  message: string;
}

export interface LoginChallenge {
  mfa_required: true;
  challenge_id: string;
}

/** Respuesta del Servidor SSR: el token queda en una cookie httpOnly. */
export interface MfaLoginResponse {
  token_type: "bearer";
  expires_in: number;
}

export interface CurrentUser extends User {
  username: string;
  role: UserRole;
}

export interface DirectoryUser {
  id: number;
  username: string;
  role: UserRole;
}
