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
    <section
      aria-labelledby="active-elections-heading"
      className="card p-6 sm:p-8"
    >
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-5">
        <div>
          <p className="eyebrow">Ahora</p>
          <h2
            id="active-elections-heading"
            className="font-display mt-1 text-2xl font-bold text-navy-900 sm:text-3xl"
          >
            Elecciones abiertas
          </h2>
        </div>
        {!isLoading && elections.length > 0 ? (
          <span className="badge bg-royal-50 text-royal-700">
            {elections.length}{" "}
            {elections.length === 1 ? "disponible" : "disponibles"}
          </span>
        ) : null}
      </header>

      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
          {[0, 1, 2].map((key) => (
            <div
              key={key}
              className="h-52 animate-pulse rounded-2xl border border-line bg-canvas"
            />
          ))}
          <span className="sr-only" aria-live="polite">
            Cargando elecciones...
          </span>
        </div>
      ) : elections.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {elections.map((election, index) => (
            <ElectionCard
              key={election.id}
              election={election}
              index={index}
              isAuthenticated={isAuthenticated ?? false}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center px-6 py-14 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-royal-50 text-royal-600">
            <Icon icon={RiInboxLine} size={28} />
          </span>
          <p className="font-display mt-4 text-lg font-bold text-navy-900">
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
