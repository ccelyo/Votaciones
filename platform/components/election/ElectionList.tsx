"use client";

import { useEffect, useState } from "react";

import { ElectionCard } from "@/components/election/ElectionCard";
import { getElections } from "@/lib/api";
import type { Election } from "@/lib/types/election";

export function ElectionList() {
  const [elections, setElections] = useState<Election[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadElections() {
      try {
        const openElections = await getElections("open");
        if (!cancelled) setElections(openElections);
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
    <section aria-labelledby="active-elections-heading">
      {error ? (
        <div
          className="mb-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <header className="mb-6">
        <h1
          id="active-elections-heading"
          className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
        >
          Elecciones activas
          {elections.length > 0 && (
            <span className="ml-2 align-middle text-base font-normal text-muted">
              ({elections.length})
            </span>
          )}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          Consulta las elecciones disponibles y participa.
        </p>
      </header>

      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted" aria-live="polite">
          Cargando elecciones...
        </p>
      ) : elections.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {elections.map((election) => (
            <ElectionCard key={election.id} election={election} />
          ))}
        </div>
      ) : !error ? (
        <div className="rounded-2xl border border-dashed border-border bg-surface px-6 py-12 text-center">
          <p className="font-medium text-foreground">
            No hay elecciones activas en este momento.
          </p>
          <p className="mt-2 text-sm text-muted">
            Vuelve más tarde para consultar las próximas elecciones.
          </p>
        </div>
      ) : null}
    </section>
  );
}
