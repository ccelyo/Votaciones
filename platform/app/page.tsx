import { connection } from "next/server";

import { ElectionCard } from "@/components/election/ElectionCard";
import { Header } from "@/components/layout/Header";
import { getElections } from "@/lib/api";

export default async function HomePage() {
  await connection();

  let openElections: Awaited<ReturnType<typeof getElections>> = [];
  let loadError: string | null = null;

  try {
    openElections = await getElections("open");
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : "No se pudieron cargar las elecciones.";
  }

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-emerald-800 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Saltar al contenido principal
      </a>

      <Header />

      <main
        id="main-content"
        className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:px-8"
      >
        {loadError ? (
          <div
            className="mb-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
            role="alert"
          >
            {loadError}
          </div>
        ) : null}

        <section aria-labelledby="active-elections-heading">
          <header className="mb-6">
            <h1
              id="active-elections-heading"
              className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
            >
              Elecciones activas
              {openElections.length > 0 && (
                <span className="ml-2 align-middle text-base font-normal text-muted">
                  ({openElections.length})
                </span>
              )}
            </h1>

            <p className="mt-2 text-sm leading-6 text-muted">
              Consulta las elecciones disponibles y participa.
            </p>
          </header>

          {openElections.length > 0 ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {openElections.map((election) => (
                <ElectionCard key={election.id} election={election} />
              ))}
            </div>
          ) : !loadError ? (
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
      </main>
    </div>
  );
}
