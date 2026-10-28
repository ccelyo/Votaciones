"use client";

import { useEffect, useState } from "react";

import { ElectionCard } from "@/components/election/ElectionCard";
import { Icon, RiInboxLine } from "@/components/icons";
import { getCurrentUser, getElections } from "@/lib/api";
import type { Election } from "@/lib/types/election";

export function ElectionList() {
  const [elections, setElections] = useState<Election[]>([]);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadElections() {
      try {
        const [openElections, user] = await Promise.all([
          getElections("open"),
          getCurrentUser().catch(() => null),
        ]);
        if (cancelled) return;
        setElections(openElections);
        setIsAuthenticated(user !== null);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "No se pudieron cargar las elecciones.",
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadElections();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-labelledby="active-elections-heading" className="card self-start">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2
          id="active-elections-heading"
          className="text-lg font-bold text-ink"
        >
          Elecciones abiertas
        </h2>
        {!isLoading && elections.length > 0 ? (
          <span className="text-sm text-muted">
            {elections.length}{" "}
            {elections.length === 1 ? "elección" : "elecciones"}
          </span>
        ) : null}
      </header>

      {error ? (
        <div className="p-5">
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        </div>
      ) : isLoading ? (
        <div className="space-y-3 p-5" aria-live="polite">
          {[0, 1].map((key) => (
            <div key={key} className="h-20 animate-pulse rounded bg-canvas" />
          ))}
          <span className="sr-only">Cargando elecciones...</span>
        </div>
      ) : elections.length > 0 ? (
        <ul className="divide-y divide-line">
          {elections.map((election, index) => (
            <ElectionCard
              key={election.id}
              election={election}
              index={index}
              isAuthenticated={isAuthenticated ?? false}
            />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <Icon icon={RiInboxLine} size={32} className="text-subtle" />
          <p className="mt-3 font-semibold text-ink">
            No hay elecciones abiertas
          </p>
          <p className="mt-1 max-w-sm text-sm text-muted">
            Cuando se abra una elección en la que puedas participar, aparecerá
            aquí.
          </p>
        </div>
      )}
    </section>
  );
}
