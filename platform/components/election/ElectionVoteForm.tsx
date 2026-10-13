"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState, useTransition } from "react";

import {
  Icon,
  RiArrowLeftLine,
  RiCheckboxCircleFill,
  RiCheckLine,
  RiFileCopyLine,
  RiLockLine,
  RiShieldCheckLine,
  RiTimeLine,
} from "@/components/icons";
import {
  castVote,
  getCurrentUser,
  getElectionForVoting,
  getVoteForCurrentUser,
  isMockApiEnabled,
} from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Election, ElectionVote } from "@/lib/types/election";

type ElectionVoteFormProps = {
  electionId: string;
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

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
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
      <Link
        href="/"
        className="btn btn-ghost -ml-3 min-h-9 px-3 py-1.5 text-sm"
      >
        <Icon icon={RiArrowLeftLine} size={18} />
        Elecciones
      </Link>

      {isLoading ? (
        <div className="mt-6 space-y-4" aria-live="polite">
          <div className="h-10 w-2/3 animate-pulse rounded-xl bg-line/70" />
          <div className="h-64 animate-pulse rounded-2xl bg-line/50" />
          <span className="sr-only">Cargando elección...</span>
        </div>
      ) : error && !election ? (
        <div className="alert alert-error mt-6" role="alert">
          {error}
        </div>
      ) : election ? (
        <>
          <header className="reveal mt-4">
            {isMockApiEnabled() ? (
              <p className="badge mb-3 bg-amber-100 text-amber-900">
                Modo de prueba: el voto se guarda solo en este navegador
              </p>
            ) : null}
            <p className="eyebrow">Elección</p>
            <h1 className="font-display mt-1 text-3xl font-bold text-navy-900 sm:text-4xl">
              {election.name}
            </h1>
            <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-muted">
              <Icon icon={RiTimeLine} size={16} />
              Disponible hasta el {formatDate(election.ends_at)}
            </p>
          </header>

          {existingVote ? (
            <VoteConfirmation vote={existingVote} />
          ) : (
            <form
              onSubmit={handleSubmit}
              className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
            >
              <fieldset
                className="reveal space-y-3"
                style={{ "--i": 1 } as React.CSSProperties}
              >
                <legend className="mb-3 text-sm font-bold text-navy-900">
                  Elige una opción
                </legend>
                {election.options?.map((option, index) => {
                  const selected = selectedOption === option;
                  return (
                    <label
                      key={option}
                      className={`flex cursor-pointer items-center gap-4 rounded-2xl border-2 bg-white p-4 transition-all sm:p-5 ${
                        selected
                          ? "border-royal-600 shadow-[var(--shadow-lift)]"
                          : "border-line hover:border-royal-500/40"
                      }`}
                    >
                      <input
                        type="radio"
                        name="election-option"
                        value={option}
                        checked={selected}
                        onChange={() => setSelectedOption(option)}
                        className="peer sr-only"
                      />
                      <span
                        className={`font-display flex size-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-royal-600 peer-focus-visible:ring-offset-2 ${
                          selected
                            ? "bg-royal-700 text-white"
                            : "bg-royal-50 text-royal-700"
                        }`}
                        aria-hidden
                      >
                        {LETTERS[index] ?? index + 1}
                      </span>
                      <span className="flex-1 text-base font-bold text-navy-900 sm:text-lg">
                        {option}
                      </span>
                      <span
                        className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                          selected
                            ? "border-royal-600 bg-royal-600 text-white"
                            : "border-line"
                        }`}
                        aria-hidden
                      >
                        {selected ? (
                          <Icon icon={RiCheckLine} size={14} />
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              <aside
                className="reveal lg:sticky lg:top-24 lg:self-start"
                style={{ "--i": 2 } as React.CSSProperties}
              >
                <div className="card p-5">
                  <p className="text-xs font-bold uppercase tracking-wider text-subtle">
                    Tu selección
                  </p>
                  <p
                    className={`font-display mt-2 min-h-8 text-xl font-bold ${
                      selectedOption ? "text-navy-900" : "text-subtle"
                    }`}
                    aria-live="polite"
                  >
                    {selectedOption || "Ninguna aún"}
                  </p>

                  {error ? (
                    <div role="alert" className="alert alert-error mt-4">
                      {error}
                    </div>
                  ) : null}

                  <button
                    type="submit"
                    disabled={isPending || !selectedOption}
                    className="btn btn-primary mt-5 w-full"
                  >
                    {isPending ? "Enviando voto..." : "Confirmar voto"}
                  </button>
                  <p className="mt-3 text-center text-xs text-subtle">
                    Una vez enviado, el voto no se puede cambiar.
                  </p>

                  <ul className="mt-5 space-y-3 border-t border-line pt-5 text-sm text-muted">
                    <li className="flex gap-2.5">
                      <Icon
                        icon={RiLockLine}
                        size={18}
                        className="mt-0.5 shrink-0 text-royal-600"
                      />
                      Tu voto se cifra en este dispositivo.
                    </li>
                    <li className="flex gap-2.5">
                      <Icon
                        icon={RiShieldCheckLine}
                        size={18}
                        className="mt-0.5 shrink-0 text-royal-600"
                      />
                      Se envía sin tu identidad, con un token anónimo.
                    </li>
                  </ul>
                </div>
              </aside>
            </form>
          )}
        </>
      ) : null}
    </main>
  );
}

function VoteConfirmation({ vote }: { vote: ElectionVote }) {
  const [copied, setCopied] = useState(false);

  async function copyReceipt() {
    if (!vote.receipt) return;
    try {
      await navigator.clipboard.writeText(vote.receipt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-live="polite" className="reveal card mt-8 overflow-hidden">
      <div className="band flex items-center gap-4 px-6 py-6 sm:px-8">
        <Icon icon={RiCheckboxCircleFill} size={44} className="shrink-0" />
        <div>
          <h2 className="font-display text-2xl font-bold">
            Tu voto fue registrado
          </h2>
          <p className="text-white/80">
            Opción elegida:{" "}
            <strong className="text-white">{vote.option}</strong>
          </p>
        </div>
      </div>

      {vote.receipt ? (
        <div className="p-6 sm:p-8">
          <h3 className="font-bold text-navy-900">Tu recibo</h3>
          <p className="mt-1 text-sm text-muted">
            Guárdalo: prueba que tu papeleta quedó registrada, sin revelar por
            quién votaste.
          </p>
          <code className="mt-4 block max-h-40 overflow-auto break-all rounded-xl bg-canvas p-4 font-mono text-xs leading-relaxed text-navy-800 ring-1 ring-line">
            {vote.receipt}
          </code>
          <button
            type="button"
            onClick={copyReceipt}
            className="btn btn-secondary mt-4"
          >
            <Icon icon={copied ? RiCheckLine : RiFileCopyLine} size={18} />
            {copied ? "Copiado" : "Copiar recibo"}
          </button>
        </div>
      ) : (
        <div className="p-6 sm:p-8">
          <Link href="/" className="btn btn-secondary">
            Volver a las elecciones
          </Link>
        </div>
      )}
    </section>
  );
}
