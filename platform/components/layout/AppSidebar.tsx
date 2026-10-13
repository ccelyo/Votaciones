"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";

import {
  Icon,
  type RemixiconComponentType,
  RiAddCircleLine,
  RiCloseLine,
  RiHomeLine,
  RiLogoutBoxRLine,
} from "@/components/icons";
import { UserAvatar } from "@/components/layout/UserAvatar";
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
  { href: "/", label: "Elecciones", icon: RiHomeLine },
  {
    href: "/admin/elections/new",
    label: "Crear elección",
    icon: RiAddCircleLine,
    adminOnly: true,
  },
];

export function AppSidebar({
  user,
  isOpen,
  isLoggingOut,
  onClose,
  onLogout,
}: SidebarProps) {
  const pathname = usePathname();
  if (!isOpen) return null;

  const displayName = user.full_name || user.username || "Usuario";

  // Portal: el header usa backdrop-filter, que confinaría el `fixed` a su caja.
  return createPortal(
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-navy-950/40 backdrop-blur-[2px]"
        aria-label="Cerrar menú"
        onClick={onClose}
      />
      <aside
        id="user-sidebar"
        role="dialog"
        aria-modal="true"
        aria-label="Menú de usuario"
        className="absolute inset-y-0 right-0 flex w-[min(20rem,88vw)] animate-[slide-in_0.25s_ease-out] flex-col bg-white shadow-2xl"
      >
        <div className="band px-5 pb-6 pt-5">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex size-9 items-center justify-center rounded-lg text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              aria-label="Cerrar menú"
            >
              <Icon icon={RiCloseLine} size={22} />
            </button>
          </div>
          <UserAvatar
            user={user}
            size={56}
            className="rounded-xl ring-2 ring-white/70"
          />
          <p className="font-display mt-3 truncate text-lg font-bold">
            {displayName}
          </p>
          <p className="text-sm text-white/75">
            {user.role === "admin" ? "Administrador" : "Votante"}
          </p>
        </div>

        <nav aria-label="Opciones de usuario" className="flex-1 p-3">
          <ul className="space-y-1">
            {NAVIGATION_ITEMS.filter(
              (item) => !item.adminOnly || user.role === "admin",
            ).map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold transition-colors ${
                      active
                        ? "bg-royal-50 text-royal-700"
                        : "text-muted hover:bg-canvas hover:text-navy-900"
                    }`}
                  >
                    <Icon icon={item.icon} size={20} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-line p-3">
          <button
            type="button"
            onClick={onLogout}
            disabled={isLoggingOut}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-bold text-danger transition-colors hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Icon icon={RiLogoutBoxRLine} size={20} />
            {isLoggingOut ? "Cerrando sesión..." : "Cerrar sesión"}
          </button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
