"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  Icon,
  RiCheckboxCircleFill,
  RiCheckLine,
  RiFileCopyLine,
  RiLockLine,
  RiPrinterLine,
  RiShieldCheckLine,
} from "@/components/icons";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  castVote,
  getCurrentUser,
  getElectionForVoting,
  getEligibility,
  getVoteForCurrentUser,
  isMockApiEnabled,
} from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Election, ElectionVote, Eligibility } from "@/lib/types/election";

type ElectionVoteFormProps = {
  electionId: string;
};

type Step = "select" | "confirm" | "done";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const STEPS: { key: Step; label: string }[] = [
  { key: "select", label: "Selección" },
  { key: "confirm", label: "Confirmación" },
  { key: "done", label: "Comprobante" },
];

export function ElectionVoteForm({ electionId }: ElectionVoteFormProps) {
  const router = useRouter();
  const [election, setElection] = useState<Election | null>(null);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [vote, setVote] = useState<ElectionVote | null>(null);
  const [selectedOption, setSelectedOption] = useState("");
  const [step, setStep] = useState<Step>("select");
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
        const user = await getCurrentUser();
        if (cancelled) return;
        if (!user) {
          router.replace(
            `/login?next=${encodeURIComponent(`/elections/${parsedId}/vote`)}`,
          );
          return;
        }

        const [currentElection, status, existingVote] = await Promise.all([
          getElectionForVoting(parsedId),
          getEligibility(parsedId),
          getVoteForCurrentUser(parsedId),
        ]);
        if (cancelled) return;

        if (!currentElection) {
          setError("No se encontró la elección solicitada.");
          return;
        }
        if (!currentElection.options?.length) {
          setError("Esta elección no tiene opciones disponibles para votar.");
          return;
        }

        setElection(currentElection);
        setEligibility(status);
        if (existingVote) {
          setVote(existingVote);
          setStep("done");
        }
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

  function submitVote() {
    setError(null);
    startTransition(async () => {
      try {
        setVote(await castVote(Number(electionId), selectedOption));
        setStep("done");
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "No se pudo registrar el voto.",
        );
      }
    });
  }

  const canVote =
    eligibility?.is_eligible === true && eligibility.has_voted === false;

  return (
    <>
      <PageHeader
        eyebrow="Votación"
        title={election?.name ?? "Votación"}
        description={
          election
            ? `Disponible hasta el ${formatDate(election.ends_at)}`
            : undefined
        }
        breadcrumbs={[
          { href: "/", label: "Elecciones" },
          { label: election?.name ?? "Votación" },
        ]}
      />

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {isLoading ? (
          <div className="space-y-4" aria-live="polite">
            <div className="h-12 animate-pulse rounded bg-line/60" />
            <div className="h-64 animate-pulse rounded bg-line/40" />
            <span className="sr-only">Cargando elección...</span>
          </div>
        ) : error && !election ? (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        ) : election && eligibility ? (
          <>
            {isMockApiEnabled() ? (
              <p className="alert alert-warning mb-6">
                Modo de prueba: el voto se guarda solo en este navegador.
              </p>
            ) : null}

            {step === "done" && vote ? (
              <VoteReceipt vote={vote} electionName={election.name} />
            ) : !eligibility.is_eligible ? (
              <div className="alert alert-warning" role="alert">
                <p className="font-bold">
                  No estás inscrito en el padrón de esta elección
                </p>
                <p className="mt-1">
                  Solo pueden votar las personas habilitadas por la entidad
                  organizadora. Si crees que se trata de un error, comunícate
                  con la administración antes del cierre.
                </p>
              </div>
            ) : eligibility.has_voted ? (
              <output className="alert alert-success block">
                <p className="font-bold">Ya registraste tu voto</p>
                <p className="mt-1">
                  Tu participación en esta elección ya quedó registrada. Cada
                  persona puede votar una sola vez.
                </p>
              </output>
            ) : (
              <>
                <Stepper current={step} />

                {eligibility.token_issued ? (
                  <p className="alert alert-warning mt-6">
                    Ya se emitió tu credencial anónima para esta elección. Si el
                    envío anterior no se completó, es posible que no puedas
                    volver a votar.
                  </p>
                ) : null}

                {error ? (
                  <div role="alert" className="alert alert-error mt-6">
                    {error}
                  </div>
                ) : null}

                {step === "select" ? (
                  <form
                    className="card mt-6"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (selectedOption) setStep("confirm");
                    }}
                  >
                    <fieldset className="p-5 sm:p-6">
                      <legend className="float-left mb-4 w-full">
                        <span className="block text-lg font-bold text-ink">
                          Selecciona una opción
                        </span>
                        <span className="mt-1 block text-sm font-normal text-muted">
                          Marca solo una. Podrás revisarla antes de enviarla.
                        </span>
                      </legend>
                      <div className="clear-both space-y-3">
                        {election.options?.map((option, index) => {
                          const selected = selectedOption === option;
                          return (
                            <label
                              key={option}
                              className={`flex cursor-pointer items-center gap-4 rounded-md border-2 p-4 transition-colors ${
                                selected
                                  ? "border-royal-700 bg-royal-50"
                                  : "border-line hover:border-royal-600/50"
                              }`}
                            >
                              <input
                                type="radio"
                                name="election-option"
                                value={option}
                                checked={selected}
                                onChange={() => setSelectedOption(option)}
                                className="size-5 shrink-0 accent-royal-700"
                              />
                              <span
                                className="flex size-9 shrink-0 items-center justify-center rounded border border-line bg-canvas text-sm font-bold text-ink"
                                aria-hidden
                              >
                                {LETTERS[index] ?? index + 1}
                              </span>
                              <span className="flex-1 text-base font-semibold text-ink">
                                {option}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                    <div className="flex flex-col-reverse gap-3 border-t border-line bg-canvas px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                      <Link href="/" className="btn btn-ghost">
                        Cancelar
                      </Link>
                      <button
                        type="submit"
                        disabled={!selectedOption}
                        className="btn btn-primary"
                      >
                        Continuar
                      </button>
                    </div>
                  </form>
                ) : (
                  <section className="card mt-6" aria-labelledby="confirm-h">
                    <div className="p-5 sm:p-6">
                      <h2 id="confirm-h" className="text-lg font-bold text-ink">
                        Confirma tu voto
                      </h2>
                      <p className="mt-1 text-sm text-muted">
                        Revisa tu selección. Una vez enviado, el voto no se
                        puede modificar.
                      </p>
                      <div className="security-paper relative mt-5 overflow-hidden rounded-md border border-line p-6">
                        <span
                          className="absolute inset-y-0 left-0 w-1 bg-royal-700"
                          aria-hidden
                        />
                        <p className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.14em] text-muted">
                          Papeleta · {election.name}
                        </p>
                        <p className="mt-3 flex items-center gap-3 text-2xl font-bold text-ink">
                          <span className="flex size-7 items-center justify-center rounded border-2 border-royal-700 text-royal-700">
                            <Icon icon={RiCheckLine} size={18} />
                          </span>
                          {selectedOption}
                        </p>
                      </div>
                      <ul className="mt-5 space-y-2 text-sm text-muted">
                        <li className="flex gap-2">
                          <Icon
                            icon={RiLockLine}
                            size={18}
                            className="mt-0.5 shrink-0 text-royal-700"
                          />
                          El voto se cifra en este dispositivo antes de
                          enviarse.
                        </li>
                        <li className="flex gap-2">
                          <Icon
                            icon={RiShieldCheckLine}
                            size={18}
                            className="mt-0.5 shrink-0 text-royal-700"
                          />
                          Se envía con una credencial anónima, sin tus datos
                          personales.
                        </li>
                      </ul>
                    </div>
                    <div className="flex flex-col-reverse gap-3 border-t border-line bg-canvas px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          setStep("select");
                        }}
                        disabled={isPending}
                        className="btn btn-ghost"
                      >
                        Cambiar selección
                      </button>
                      <button
                        type="button"
                        onClick={submitVote}
                        disabled={isPending || !canVote}
                        className="btn btn-primary"
                      >
                        {isPending
                          ? "Enviando voto..."
                          : "Confirmar y enviar voto"}
                      </button>
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        ) : null}
      </main>
    </>
  );
}

function Stepper({ current }: { current: Step }) {
  const currentIndex = STEPS.findIndex((item) => item.key === current);
  return (
    <ol className="flex items-center gap-3" aria-label="Pasos para votar">
      {STEPS.map((item, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <li
            key={item.key}
            className="flex flex-1 items-center gap-3"
            aria-current={active ? "step" : undefined}
          >
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                done
                  ? "bg-success text-white"
                  : active
                    ? "bg-royal-700 text-white"
                    : "border-2 border-line bg-white text-subtle"
              }`}
            >
              {done ? <Icon icon={RiCheckLine} size={16} /> : index + 1}
            </span>
            <span
              className={`text-sm font-semibold ${active ? "text-ink" : "text-muted"}`}
            >
              {item.label}
            </span>
            {index < STEPS.length - 1 ? (
              <span
                className="hidden h-px flex-1 bg-line sm:block"
                aria-hidden
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function VoteReceipt({
  vote,
  electionName,
}: {
  vote: ElectionVote;
  electionName: string;
}) {
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
    <>
      <Stepper current="done" />
      <output className="mt-6 flex items-start gap-3 rounded-md border border-line bg-white p-4">
        <Icon
          icon={RiCheckboxCircleFill}
          size={26}
          className="shrink-0 text-success"
        />
        <span>
          <span className="block font-bold text-ink">
            Tu voto fue registrado
          </span>
          <span className="block text-sm text-muted">
            Opción elegida: <strong className="text-ink">{vote.option}</strong>.
            Esta información solo se muestra en tu pantalla.
          </span>
        </span>
      </output>

      {vote.receipt ? (
        <section
          aria-labelledby="receipt-h"
          className="security-paper relative mt-6 overflow-hidden rounded-md border border-line print:border-black"
        >
          <Image
            src="/logo.png"
            alt=""
            width={220}
            height={220}
            className="pointer-events-none absolute -bottom-10 -right-8 opacity-[0.06] select-none"
          />
          <div className="relative p-6 sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
              <div>
                <p className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.14em] text-muted">
                  <span className="h-px w-8 bg-royal-700" aria-hidden />
                  Espivota
                </p>
                <h2 id="receipt-h" className="mt-2 text-2xl font-bold text-ink">
                  Comprobante de votación
                </h2>
              </div>
              <span className="badge border border-success/30 bg-success-soft text-success">
                Firmado por la urna
              </span>
            </div>

            <dl className="grid gap-4 py-5 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-subtle">
                  Elección
                </dt>
                <dd className="mt-1 font-semibold text-ink">{electionName}</dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-subtle">
                  Fecha de emisión
                </dt>
                <dd className="mt-1 font-semibold text-ink">
                  {formatDate(vote.created_at)}
                </dd>
              </div>
            </dl>

            <p className="text-xs font-bold uppercase tracking-wider text-subtle">
              Código del comprobante
            </p>
            <code className="mt-2 block max-h-40 overflow-auto break-all rounded border border-line bg-white/80 p-4 font-mono text-xs leading-relaxed text-navy-800">
              {vote.receipt}
            </code>
            <p className="mt-3 text-sm text-muted">
              Consérvalo: prueba que tu papeleta quedó registrada, sin revelar
              por quién votaste.
            </p>

            <div className="mt-5 flex flex-wrap gap-3 print:hidden">
              <button
                type="button"
                onClick={copyReceipt}
                className="btn btn-secondary"
              >
                <Icon icon={copied ? RiCheckLine : RiFileCopyLine} size={18} />
                {copied ? "Copiado" : "Copiar código"}
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                className="btn btn-ghost"
              >
                <Icon icon={RiPrinterLine} size={18} />
                Imprimir
              </button>
              <Link href="/" className="btn btn-ghost">
                Volver a elecciones
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <div className="mt-6">
          <Link href="/" className="btn btn-secondary">
            Volver a elecciones
          </Link>
        </div>
      )}
    </>
  );
}
