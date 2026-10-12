"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Icon,
  type RemixiconComponentType,
  RiAddCircleLine,
  RiCloseLine,
  RiHomeLine,
  RiLogoutBoxLine,
} from "@/components/icons";
import type { User } from "@/lib/types/user";

type SidebarProps = {
  user: User;
  isOpen: boolean;
  isLoggingOut: boolean;
  onClose: () => void;
  onLogout: () => void;
};

type NavigationItem = {
  href: string;
  label: string;
  icon: RemixiconComponentType;
  adminOnly?: boolean;
};

const NAVIGATION_ITEMS: NavigationItem[] = [
  { href: "/", label: "Inicio", icon: RiHomeLine },
  {
    href: "/admin/elections/new",
    label: "Crear votación",
    icon: RiAddCircleLine,
    adminOnly: true,
  },
];

function getInitial(user: User): string {
  const displayName = user.full_name || user.username || user.email || "";
  return (displayName.trim()[0] ?? "?").toUpperCase();
}

export function AppSidebar({
  user,
  isOpen,
  isLoggingOut,
  onClose,
  onLogout,
}: SidebarProps) {
  const pathname = usePathname();
  const displayName = user.full_name || user.username || "Usuario";
  const displayDetail = user.email || user.username || "";

  return (
    <>
      {isOpen ? (
        <div className="fixed inset-x-0 bottom-0 top-16 z-50">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-black/40"
            aria-label="Cerrar menú"
            onClick={onClose}
          />
          <aside
            id="user-sidebar"
            role="dialog"
            aria-modal="true"
            aria-label="Menú de usuario"
            className="absolute inset-y-0 right-0 flex w-[min(20rem,85vw)] flex-col border-l border-border bg-surface shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-800 text-base font-semibold text-white">
                  {getInitial(user)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {displayName}
                  </p>
                  <p className="truncate text-xs text-muted">{displayDetail}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="ml-3 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-background hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
                aria-label="Cerrar menú"
              >
                <Icon icon={RiCloseLine} size={22} />
              </button>
            </div>

            <nav aria-label="Opciones de usuario" className="flex-1 px-3 py-5">
              <ul className="space-y-1">
                {NAVIGATION_ITEMS.filter(
                  (item) => !item.adminOnly || user.role === "admin",
                ).map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={pathname === item.href ? "page" : undefined}
                      className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors ${
                        pathname === item.href
                          ? "bg-emerald-50 text-emerald-900"
                          : "text-muted hover:bg-background hover:text-foreground"
                      }`}
                    >
                      <Icon icon={item.icon} size={20} />
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="border-t border-border p-3">
              <button
                type="button"
                onClick={onLogout}
                disabled={isLoggingOut}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Icon icon={RiLogoutBoxLine} size={20} />
                {isLoggingOut ? "Cerrando sesión..." : "Cerrar sesión"}
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
