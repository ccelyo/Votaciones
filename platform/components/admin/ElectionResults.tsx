"use client";

import { useEffect, useState } from "react";

import { obtenerResultados, type ResultadosEleccion } from "@/lib/m4/api";

/**
 * Conteo final de una elección cerrada. Solo muestra totales por opción:
 * las papeletas son anónimas y no hay forma de saber quién votó por quién.
 */
export function ElectionResults({ electionId }: { electionId: number }) {
  const [results, setResults] = useState<ResultadosEleccion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    obtenerResultados(String(electionId))
      .then((loaded) => {
        if (loaded) setResults(loaded);
        else
          setError("Los resultados se publican cuando la elección se cierra.");
      })
      .catch((loadError: unknown) =>
        setError(
          loadError instanceof Error
            ? loadError.message
            : "No se pudieron cargar los resultados.",
        ),
      )
      .finally(() => setIsLoading(false));
  }, [electionId]);

  const valid = results
    ? results.totalPapeletas - results.papeletasInvalidas
    : 0;
  const maxVotes = results
    ? Math.max(0, ...results.resultados.map((result) => result.votos))
    : 0;

  return (
    <section className="card" aria-labelledby="results-h">
      <header className="border-b border-line px-5 py-4">
        <h2 id="results-h" className="text-lg font-bold text-ink">
          Resultados
        </h2>
        <p className="text-sm text-muted">
          Conteo de las papeletas anónimas de la urna. No incluye datos de quién
          votó.
        </p>
      </header>
      <div className="p-5">
        {isLoading ? (
          <p className="text-sm text-muted" aria-live="polite">
            Contando votos...
          </p>
        ) : error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : results ? (
          <>
            <ol className="space-y-4">
              {results.resultados.map((result) => {
                const share =
                  valid > 0 ? Math.round((result.votos / valid) * 100) : 0;
                const isLeader = maxVotes > 0 && result.votos === maxVotes;
                return (
                  <li key={result.opcion}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <span className="font-semibold text-ink">
                        {result.opcion}
                      </span>
                      <span className="whitespace-nowrap text-sm text-muted">
                        <span className="font-bold text-ink">
                          {result.votos}
                        </span>{" "}
                        {result.votos === 1 ? "voto" : "votos"} · {share} %
                      </span>
                    </div>
                    <span
                      className="block h-2.5 overflow-hidden rounded-full bg-canvas"
                      aria-hidden
                    >
                      <span
                        className={`block h-full rounded-full ${isLeader ? "bg-royal-700" : "bg-royal-500/50"}`}
                        style={{ width: `${share}%` }}
                      />
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-5 border-t border-line pt-4 text-sm text-muted">
              {results.totalPapeletas}{" "}
              {results.totalPapeletas === 1 ? "papeleta" : "papeletas"} en la
              urna
              {results.papeletasInvalidas > 0
                ? ` · ${results.papeletasInvalidas} sin una opción válida (no se cuentan)`
                : ""}
              .
            </p>
          </>
        ) : null}
      </div>
    </section>
  );
}
