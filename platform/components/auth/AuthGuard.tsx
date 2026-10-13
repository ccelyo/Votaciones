"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

import { getCurrentUser } from "@/lib/api";
import type { User } from "@/lib/types/user";

type AdminGuardProps = {
  children: ReactNode;
};

export function AdminGuard({ children }: AdminGuardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkAccess() {
      try {
        const currentUser = await getCurrentUser();
        if (cancelled) return;

        setUser(currentUser);
        setIsLoading(false);

        if (!currentUser) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        } else if (currentUser.role !== "admin") {
          router.replace("/");
        }
      } catch (checkError) {
        if (cancelled) return;
        setError(
          checkError instanceof Error
            ? checkError.message
            : "No se pudieron verificar los permisos.",
        );
        setIsLoading(false);
      }
    }

    checkAccess();
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  if (isLoading) {
    return (
      <main
        className="mx-auto flex min-h-[50vh] max-w-7xl items-center justify-center px-4 text-sm text-muted"
        aria-live="polite"
      >
        Verificando permisos...
      </main>
    );
  }

  if (error) {
    return (
      <main
        role="alert"
        className="mx-auto flex min-h-[50vh] max-w-7xl items-center justify-center px-4 text-sm text-danger"
      >
        No se pudieron verificar los permisos: {error}
      </main>
    );
  }

  if (user?.role !== "admin") return null;

  return children;
}
