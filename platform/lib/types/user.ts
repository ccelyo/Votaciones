export type UserRole = "voter" | "admin";

export interface User {
  id: number;
  email: string;
  full_name: string;
  role: UserRole;
};

export interface LoginPayload {
  email: string;
  password: string;
};

export interface RegisterPayload {
  full_name: string;
  email: string;
  password: string;
};

export interface MessageResponse {
  message: string;
}