"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { listAllElections } from "@/lib/api";
import { STATUS_CLASS, STATUS_LABEL } from "@/lib/election-status";
import { formatDate } from "@/lib/format";
import type { AdminElection } from "@/lib/types/election";

type AdminElectionsProps = {
  /** Elecciones cargadas por el Servidor SSR; si faltan, las carga el navegador. */
  initialElections?: AdminElection[];
};

export function AdminElections({ initialElections }: AdminElectionsProps) {
  const [elections, setElections] = useState<AdminElection[] | null>(
    initialElections ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const renderedOnServer = initialElections !== undefined;

  useEffect(() => {
    if (renderedOnServer) return;
    listAllElections()
      .then(setElections)
      .catch((loadError: unknown) =>
        setError(
          loadError instanceof Error
            ? loadError.message
            : "No se pudieron cargar las elecciones.",
        ),
      );
  }, [renderedOnServer]);

  return (
    <section className="card" aria-labelledby="admin-elections-h">
      <header className="border-b border-line px-5 py-4">
        <h2 id="admin-elections-h" className="text-lg font-bold text-ink">
          Elecciones registradas
        </h2>
      </header>
      {error ? (
        <div className="p-5">
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        </div>
      ) : elections === null ? (
        <p className="p-5 text-sm text-muted" aria-live="polite">
          Cargando elecciones...
        </p>
      ) : elections.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="font-semibold text-ink">Aún no hay elecciones</p>
          <p className="mt-1 text-sm text-muted">
            Crea la primera para empezar a inscribir votantes.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Elección</th>
                <th scope="col">Estado</th>
                <th scope="col">Apertura</th>
                <th scope="col">Cierre</th>
                <th scope="col">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {elections.map((election) => (
                <tr key={election.id}>
                  <td>
                    <span className="font-semibold text-ink">
                      {election.name}
                    </span>
                    <span className="block text-xs text-subtle">
                      ID {election.id}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[election.status]}`}>
                      {STATUS_LABEL[election.status]}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-muted">
                    {election.starts_at ? formatDate(election.starts_at) : "—"}
                  </td>
                  <td className="whitespace-nowrap text-muted">
                    {election.ends_at ? formatDate(election.ends_at) : "—"}
                  </td>
                  <td className="text-right">
                    <Link
                      href={`/admin/elections/${election.id}`}
                      className="btn btn-secondary btn-sm"
                    >
                      Gestionar
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
