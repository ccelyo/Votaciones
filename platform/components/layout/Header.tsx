"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, RiMenuLine } from "@/components/icons";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { Logo } from "@/components/layout/Logo";
import { getCurrentUser, logout } from "@/lib/api";
import type { User } from "@/lib/types/user";

const ROUTES = {
  home: "/",
  login: "/login",
  register: "/register",
} as const;

type HeaderProps = {
  activePath?: (typeof ROUTES)[keyof typeof ROUTES];
  variant?: "marketing";
};

function AuthActionsSkeleton() {
  return (
    <>
      <span
        className="hidden h-10 w-[8.75rem] shrink-0 rounded-full bg-border/70 motion-reduce:animate-none sm:block"
        aria-hidden="true"
      />
      <span
        className="h-10 w-[6.75rem] shrink-0 rounded-full bg-border/70 motion-reduce:animate-none"
        aria-hidden="true"
      />
    </>
  );
}

function GuestAuthActions({
  activePath,
}: {
  activePath?: HeaderProps["activePath"];
}) {
  const isMockApi = process.env.NEXT_PUBLIC_API_MODE === "mock";

  return (
    <>
      <Link
        href={ROUTES.login}
        aria-current={activePath === ROUTES.login ? "page" : undefined}
        className="ds-btn ds-btn-ghost ds-btn-pill shrink-0 px-4 py-2 text-sm"
      >
        Iniciar sesión
      </Link>
      {isMockApi ? (
        <Link
          href={ROUTES.register}
          aria-current={activePath === ROUTES.register ? "page" : undefined}
          className="ds-btn ds-btn-primary ds-btn-pill shrink-0 px-4 py-2 text-sm"
        >
          Registrarse
        </Link>
      ) : null}
    </>
  );
}

export function Header({ activePath }: HeaderProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [userLoadError, setUserLoadError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  // Consulta de sesión
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
        if (!cancelled) {
          setIsLoading(false);
        }
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
    <header className="z-20 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-4 sm:px-6">
      <Link
        href={ROUTES.home}
        aria-label="Votaciones — Inicio"
        className="inline-flex shrink-0 items-center"
      >
        <Logo />
      </Link>

      <div className="flex items-center gap-3" aria-busy={isLoading}>
        {process.env.NEXT_PUBLIC_API_MODE === "mock" ? (
          <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            Demo
          </span>
        ) : null}
        {isLoading ? (
          <AuthActionsSkeleton />
        ) : user ? (
          <button
            type="button"
            onClick={() => {
              setLogoutError(null);
              setSidebarOpen(true);
            }}
            className="inline-flex size-11 items-center justify-center rounded-full text-foreground transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
            aria-label="Abrir menú de usuario"
            aria-expanded={sidebarOpen}
            aria-controls="user-sidebar"
          >
            <Icon icon={RiMenuLine} size={24} />
          </button>
        ) : (
          <GuestAuthActions activePath={activePath} />
        )}
      </div>
      {userLoadError ? (
        <div
          role="alert"
          className="fixed bottom-4 right-4 z-[60] max-w-sm rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-lg"
        >
          {userLoadError}
        </div>
      ) : null}
      {user ? (
        <>
          <AppSidebar
            user={user}
            isOpen={sidebarOpen}
            isLoggingOut={isLoggingOut}
            onClose={() => setSidebarOpen(false)}
            onLogout={handleLogout}
          />
          {logoutError ? (
            <div
              role="alert"
              className="fixed bottom-4 right-4 z-[60] max-w-sm rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 shadow-lg"
            >
              {logoutError}
            </div>
          ) : null}
        </>
      ) : null}
    </header>
  );
}
