"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppSidebar } from "@/components/layout/AppSidebar";
import { Logo } from "@/components/layout/Logo";
import { UserAvatar } from "@/components/layout/UserAvatar";
import { getCurrentUser, logout } from "@/lib/api";
import type { User } from "@/lib/types/user";

export function Header() {
  const router = useRouter();
  const pathname = usePathname();
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

  const navItems = [
    { href: "/", label: "Elecciones" },
    ...(user?.role === "admin"
      ? [{ href: "/admin", label: "Administración" }]
      : []),
  ];

  return (
    <header className="sticky top-0 z-30 bg-white shadow-[0_1px_0_var(--color-line)]">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-6 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-8">
          <Link href="/" aria-label="Espivota — Inicio" className="rounded">
            <Logo />
          </Link>
          {user ? (
            <nav aria-label="Navegación principal" className="hidden md:block">
              <ul className="flex items-center gap-1">
                {navItems.map((item) => {
                  const active =
                    item.href === "/"
                      ? pathname === "/" || pathname.startsWith("/elections")
                      : pathname.startsWith(item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={`relative flex h-16 items-center px-3 text-sm font-semibold transition-colors ${
                          active
                            ? "text-royal-700 after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:bg-royal-700"
                            : "text-muted hover:text-royal-700"
                        }`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : null}
        </div>

        <div className="flex items-center gap-3" aria-busy={isLoading}>
          {isMockApi ? (
            <span className="badge bg-warning-soft text-warning">Demo</span>
          ) : null}
          {isLoading ? (
            <span
              className="h-9 w-28 animate-pulse rounded bg-line/70"
              aria-hidden="true"
            />
          ) : user ? (
            <button
              type="button"
              onClick={() => {
                setLogoutError(null);
                setSidebarOpen(true);
              }}
              className="flex items-center gap-2.5 rounded-md border border-line py-1 pl-1 pr-3 transition-colors hover:border-royal-600"
              aria-label="Abrir menú de usuario"
              aria-expanded={sidebarOpen}
              aria-controls="user-sidebar"
            >
              <UserAvatar user={user} size={30} className="rounded" />
              <span className="hidden max-w-40 truncate text-sm font-semibold text-ink sm:block">
                {user.full_name || user.username}
              </span>
            </button>
          ) : (
            <>
              <Link href="/login" className="btn btn-primary btn-sm">
                Iniciar sesión
              </Link>
              {isMockApi ? (
                <Link
                  href="/register"
                  className="btn btn-ghost btn-sm hidden sm:inline-flex"
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
