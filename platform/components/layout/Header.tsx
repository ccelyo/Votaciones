"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { Logo } from "@/components/layout/Logo";
import { UserAvatar } from "@/components/layout/UserAvatar";
import { getCurrentUser, logout } from "@/lib/api";
import type { User } from "@/lib/types/user";

export function Header() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [userLoadError, setUserLoadError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const isMockApi = process.env.NEXT_PUBLIC_API_MODE === "mock";

  useEffect(() => {
    let cancelled = false;

    async function loadUser() {
      try {
        const currentUser = await getCurrentUser();
        if (!cancelled) setUser(currentUser);
      } catch (error) {
        if (!cancelled) {
          setUserLoadError(
            error instanceof Error
              ? error.message
              : "No se pudo comprobar la sesión.",
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadUser();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSidebarOpen(false);
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [sidebarOpen]);

  async function handleLogout() {
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      setSidebarOpen(false);
      setUser(null);
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(
        error instanceof Error ? error.message : "No se pudo cerrar sesión.",
      );
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Espivota — Inicio" className="rounded-lg">
          <Logo />
        </Link>

        <div className="flex items-center gap-3" aria-busy={isLoading}>
          {isMockApi ? (
            <span className="badge bg-amber-100 text-amber-900">Demo</span>
          ) : null}
          {isLoading ? (
            <span
              className="h-10 w-28 animate-pulse rounded-xl bg-line/70"
              aria-hidden="true"
            />
          ) : user ? (
            <button
              type="button"
              onClick={() => {
                setLogoutError(null);
                setSidebarOpen(true);
              }}
              className="flex items-center gap-2.5 rounded-xl py-1.5 pl-1.5 pr-3 transition-colors hover:bg-royal-50"
              aria-label="Abrir menú de usuario"
              aria-expanded={sidebarOpen}
              aria-controls="user-sidebar"
            >
              <UserAvatar user={user} size={32} className="rounded-lg" />
              <span className="hidden max-w-40 truncate text-sm font-bold text-navy-900 sm:block">
                {user.full_name || user.username}
              </span>
            </button>
          ) : (
            <>
              <Link href="/login" className="btn btn-primary min-h-10 py-2">
                Iniciar sesión
              </Link>
              {isMockApi ? (
                <Link
                  href="/register"
                  className="btn btn-ghost hidden min-h-10 py-2 sm:inline-flex"
                >
                  Registrarse
                </Link>
              ) : null}
            </>
          )}
        </div>
      </div>

      {userLoadError || logoutError ? (
        <div
          role="alert"
          className="alert alert-error fixed bottom-4 right-4 z-[60] max-w-sm shadow-lg"
        >
          {logoutError ?? userLoadError}
        </div>
      ) : null}
      {user ? (
        <AppSidebar
          user={user}
          isOpen={sidebarOpen}
          isLoggingOut={isLoggingOut}
          onClose={() => setSidebarOpen(false)}
          onLogout={handleLogout}
        />
      ) : null}
    </header>
  );
}
