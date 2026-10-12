"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState, useTransition } from "react";

import {
  castVote,
  getCurrentUser,
  getElectionForVoting,
  getVoteForCurrentUser,
  isMockApiEnabled,
} from "@/lib/api";
import type { Election, ElectionVote } from "@/lib/types/election";

type ElectionVoteFormProps = {
  electionId: string;
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("es", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ElectionVoteForm({ electionId }: ElectionVoteFormProps) {
  const router = useRouter();
  const [election, setElection] = useState<Election | null>(null);
  const [existingVote, setExistingVote] = useState<ElectionVote | null>(null);
  const [selectedOption, setSelectedOption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;

    async function loadElection() {
      const parsedId = Number(electionId);
      if (!Number.isSafeInteger(parsedId) || parsedId <= 0) {
        setError("El identificador de la elección no es válido.");
        setIsLoading(false);
        return;
      }

      try {
        const [user, currentElection, vote] = await Promise.all([
          getCurrentUser(),
          getElectionForVoting(parsedId),
          getVoteForCurrentUser(parsedId),
        ]);
        if (cancelled) return;

        if (!user) {
          router.replace(
            `/login?next=${encodeURIComponent(`/elections/${parsedId}/vote`)}`,
          );
          return;
        }
        if (!currentElection) {
          setError("No se encontró la elección solicitada.");
          return;
        }
        if (!currentElection.options?.length) {
          setError("Esta elección no tiene opciones disponibles para votar.");
          return;
        }

        setElection(currentElection);
        setExistingVote(vote);
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "No se pudo cargar la elección.",
          );
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadElection();
    return () => {
      cancelled = true;
    };
  }, [electionId, router]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!selectedOption) {
      setError("Selecciona una opción antes de confirmar tu voto.");
      return;
    }

    startTransition(async () => {
      try {
        const vote = await castVote(Number(electionId), selectedOption);
        setExistingVote(vote);
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "No se pudo registrar el voto.",
        );
      }
    });
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <Link
        href="/"
        className="text-sm font-semibold text-emerald-800 hover:underline"
      >
        ← Volver al inicio
      </Link>

      {isLoading ? (
        <p className="mt-8 text-sm text-muted" aria-live="polite">
          Cargando elección...
        </p>
      ) : error && !election ? (
        <div
          className="mt-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950"
          role="alert"
        >
          {error}
        </div>
      ) : election ? (
        <>
          <header className="mb-8 mt-6">
            {isMockApiEnabled() ? (
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
                Modo de prueba — el voto se guarda solo en este navegador
              </p>
            ) : null}
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              {election.name}
            </h1>
            <p className="mt-3 text-sm text-muted">
              Disponible hasta {formatDate(election.ends_at)}.
            </p>
          </header>

          {error ? (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
            >
              {error}
            </div>
          ) : null}

          {existingVote ? (
            <section
              aria-live="polite"
              className="rounded-2xl border border-emerald-300 bg-emerald-50 p-6 text-emerald-950"
            >
              <h2 className="font-semibold">Tu voto ya fue registrado</h2>
              <p className="mt-2 text-sm">
                Opción seleccionada: <strong>{existingVote.option}</strong>
              </p>
            </section>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
            >
              <fieldset className="space-y-3">
                <legend className="mb-4 text-base font-semibold text-foreground">
                  Selecciona una opción
                </legend>
                {election.options?.map((option) => (
                  <label
                    key={option}
                    className={`flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors ${
                      selectedOption === option
                        ? "border-emerald-700 bg-emerald-50"
                        : "border-border hover:bg-background"
                    }`}
                  >
                    <input
                      type="radio"
                      name="election-option"
                      value={option}
                      checked={selectedOption === option}
                      onChange={() => setSelectedOption(option)}
                      className="size-4 accent-emerald-800"
                    />
                    <span className="text-sm font-medium text-foreground">
                      {option}
                    </span>
                  </label>
                ))}
              </fieldset>
              {!isMockApiEnabled() ? (
                <p className="mt-5 text-sm text-amber-900">
                  El envío real del voto todavía no está conectado al backend;
                  puedes probar este flujo activando el modo mock.
                </p>
              ) : null}
              <button
                type="submit"
                disabled={isPending || !isMockApiEnabled()}
                className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-emerald-800 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPending ? "Registrando voto..." : "Confirmar voto"}
              </button>
            </form>
          )}
        </>
      ) : null}
    </main>
  );
}
