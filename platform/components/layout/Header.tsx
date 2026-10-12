"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { getCurrentUser } from "@/lib/api";
import { Icon, RiArrowDownSLine } from "@/components/icons";
import { Logo } from "@/components/layout/Logo";
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

function getInitial(fullName: string): string {
  return (fullName.trim()[0] ?? "?").toUpperCase();
}

function formatShortName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  const lastInitial = parts[parts.length - 1][0]?.toUpperCase() ?? "";
  return `${parts[0]} ${lastInitial}.`;
}

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

function GuestAuthActions({ activePath }: { activePath?: HeaderProps["activePath"] }) {
  return (
    <>
      <Link
        href={ROUTES.login}
        aria-current={activePath === ROUTES.login ? "page" : undefined}
        className="ds-btn ds-btn-ghost ds-btn-pill shrink-0 px-4 py-2 text-sm"
      >
        Iniciar sesión
      </Link>
      <Link
        href={ROUTES.register}
        aria-current={activePath === ROUTES.register ? "page" : undefined}
        className="ds-btn ds-btn-primary ds-btn-pill shrink-0 px-4 py-2 text-sm"
      >
        Registrarse
      </Link>
    </>
  );
}

function UserMenu({
  user,
  menuOpen,
  menuRef,
  onToggleMenu,
}: {
  user: User;
  menuOpen: boolean;
  menuRef: React.RefObject<HTMLDivElement | null>;
  onToggleMenu: () => void;
}) {
  return (
    <div className="relative shrink-0" ref={menuRef}>
      <button
        type="button"
        onClick={onToggleMenu}
        className="header-user-trigger"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <span className="header-user-avatar" aria-hidden="true">
          {getInitial(user.full_name)}
        </span>
        <span className="hidden max-w-[7.5rem] truncate sm:inline">
          {formatShortName(user.full_name)}
        </span>
        <Icon
          icon={RiArrowDownSLine}
          size={16}
          className={`shrink-0 text-subtle transition-transform duration-200 ${
            menuOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {menuOpen && (
        <div role="menu" className="header-menu">
          <div className="header-menu-user">
            <p className="truncate text-sm font-semibold text-foreground">{user.full_name}</p>
            <p className="mt-0.5 truncate text-xs text-subtle">{user.email}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function Header({ activePath }: HeaderProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  // Consulta de sesión
  useEffect(() => {
    let cancelled = false;

    async function loadUser() {
      const currentUser = await getCurrentUser();
      if (!cancelled) {
        setUser(currentUser);
        setIsLoading(false);
      }
    }

    loadUser();

    return () => {
      cancelled = true;
    };
  }, []);

  // Cerrar el menú al hacer clic fuera
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
        {isLoading ? (
          <AuthActionsSkeleton />
        ) : user ? (
          <UserMenu
            user={user}
            menuOpen={menuOpen}
            menuRef={menuRef}
            onToggleMenu={() => setMenuOpen((open) => !open)}
          />
        ) : (
          <GuestAuthActions activePath={activePath} />
        )}
      </div>
    </header>
  );
}