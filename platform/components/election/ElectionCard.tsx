"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { getCurrentUser } from "@/lib/api";
import type { Election } from "@/lib/types/election";

type ElectionCardProps = {
  election: Election;
};

export function ElectionCard({ election }: ElectionCardProps) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      const user = await getCurrentUser();
      if (!cancelled) {
        setIsAuthenticated(user !== null);
      }
    }

    checkSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const votePath = `/elections/${election.id}/vote`;

  return (
    <article className="flex h-full flex-col rounded-2xl border border-border bg-surface p-6 shadow-sm">
      <div className="flex-1">
        <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
          Abierta
        </span>
        <h2 className="mt-4 text-lg font-semibold text-foreground">
          {election.name}
        </h2>
        <dl className="mt-4 space-y-2 text-sm text-muted">
          <div className="flex gap-2">
            <dt className="font-medium text-foreground">Inicia:</dt>
            <dd>
              <time dateTime={election.starts_at}>{election.starts_at}</time>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-medium text-foreground">Finaliza:</dt>
            <dd>
              <time dateTime={election.ends_at}>{election.ends_at}</time>
            </dd>
          </div>
        </dl>
      </div>

      {isAuthenticated === null ? (
        <span
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full bg-emerald-800 px-5 py-2 text-sm font-semibold text-white opacity-60"
          aria-live="polite"
        >
          Verificando sesión...
        </span>
      ) : (
        <Link
          href={
            isAuthenticated
              ? votePath
              : `/login?next=${encodeURIComponent(votePath)}`
          }
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full bg-emerald-800 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
        >
          {isAuthenticated ? "Votar" : "Inicia sesión para participar"}
        </Link>
      )}
    </article>
  );
}
