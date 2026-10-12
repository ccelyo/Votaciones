"use client";

import { type FormEvent, useRef, useState, useTransition } from "react";

import { createElection } from "@/lib/api";
import type {
  CreatedElection,
  ElectionCreatePayload,
} from "@/lib/types/election";

const INPUT_CLASS =
  "w-full rounded-xl border border-border bg-background px-4 py-3 text-sm text-foreground outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/20";

function toEpochSeconds(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

export function CreateElectionForm() {
  const [name, setName] = useState("");
  const [options, setOptions] = useState([
    { id: 0, value: "" },
    { id: 1, value: "" },
  ]);
  const nextOptionId = useRef(2);
  const [encryptionPublicKey, setEncryptionPublicKey] = useState("");
  const [opensAt, setOpensAt] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createdElection, setCreatedElection] =
    useState<CreatedElection | null>(null);
  const [isPending, startTransition] = useTransition();

  function updateOption(id: number, value: string) {
    setOptions((current) =>
      current.map((option) =>
        option.id === id ? { ...option, value } : option,
      ),
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setCreatedElection(null);

    const electionName = name.trim();
    const electionOptions = options.map((option) => option.value.trim());
    const openEpoch = toEpochSeconds(opensAt);
    const closeEpoch = toEpochSeconds(closesAt);
    const publicKey = encryptionPublicKey.trim();

    if (!electionName || electionName.length > 150) {
      setError("El nombre debe tener entre 1 y 150 caracteres.");
      return;
    }
    if (
      electionOptions.length < 2 ||
      electionOptions.length > 100 ||
      electionOptions.some(
        (option) => !option || new TextEncoder().encode(option).length > 128,
      )
    ) {
      setError(
        "Agrega entre 2 y 100 opciones; cada una debe tener máximo 128 bytes.",
      );
      return;
    }
    if (new Set(electionOptions).size !== electionOptions.length) {
      setError("Las opciones no pueden repetirse.");
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(publicKey)) {
      setError(
        "La clave pública debe estar codificada en base64url sin relleno.",
      );
      return;
    }
    if (
      !Number.isFinite(openEpoch) ||
      !Number.isFinite(closeEpoch) ||
      openEpoch <= 0 ||
      closeEpoch <= openEpoch
    ) {
      setError(
        "Verifica las fechas: el cierre debe ser posterior a la apertura.",
      );
      return;
    }
    if (closeEpoch <= Math.floor(Date.now() / 1000)) {
      setError("La fecha de cierre debe estar en el futuro.");
      return;
    }

    const payload: ElectionCreatePayload = {
      name: electionName,
      options: electionOptions,
      encryption_public_key: publicKey,
      opens_at: openEpoch,
      closes_at: closeEpoch,
    };

    startTransition(async () => {
      try {
        setCreatedElection(await createElection(payload));
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "No se pudo crear la elección.",
        );
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          {error}
        </div>
      ) : null}

      {createdElection ? (
        <output className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-950">
          Elección creada correctamente (ID: {createdElection.election_id},{" "}
          estado: {createdElection.status}).
        </output>
      ) : null}

      <div>
        <label
          htmlFor="election-name"
          className="mb-2 block text-sm font-medium"
        >
          Nombre de la elección
        </label>
        <input
          id="election-name"
          name="name"
          type="text"
          required
          maxLength={150}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={INPUT_CLASS}
          autoComplete="off"
        />
      </div>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">
          Opciones de votación
        </legend>
        {options.map((option, index) => (
          <div key={option.id} className="flex items-center gap-3">
            <label htmlFor={`election-option-${index}`} className="sr-only">
              Opción {index + 1}
            </label>
            <input
              id={`election-option-${index}`}
              type="text"
              required
              maxLength={128}
              value={option.value}
              onChange={(event) => updateOption(option.id, event.target.value)}
              className={INPUT_CLASS}
              placeholder={`Opción ${index + 1}`}
            />
            {options.length > 2 ? (
              <button
                type="button"
                onClick={() =>
                  setOptions((current) =>
                    current.filter(
                      (currentOption) => currentOption.id !== option.id,
                    ),
                  )
                }
                className="shrink-0 text-sm font-medium text-red-700 hover:text-red-900"
                aria-label={`Eliminar opción ${index + 1}`}
              >
                Eliminar
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          disabled={options.length >= 100}
          onClick={() =>
            setOptions((current) => [
              ...current,
              { id: nextOptionId.current++, value: "" },
            ])
          }
          className="text-sm font-semibold text-emerald-800 hover:text-emerald-950 disabled:cursor-not-allowed disabled:opacity-50"
        >
          + Agregar opción
        </button>
      </fieldset>

      <div>
        <label
          htmlFor="encryption-public-key"
          className="mb-2 block text-sm font-medium"
        >
          Clave pública de cifrado (base64url)
        </label>
        <textarea
          id="encryption-public-key"
          name="encryption_public_key"
          required
          rows={3}
          value={encryptionPublicKey}
          onChange={(event) => setEncryptionPublicKey(event.target.value)}
          className={`${INPUT_CLASS} resize-y font-mono`}
          aria-describedby="encryption-public-key-help"
        />
        <p
          id="encryption-public-key-help"
          className="mt-2 text-xs leading-5 text-muted"
        >
          Ingresa la clave pública en base64url sin relleno. La clave privada no
          debe compartirse ni enviarse.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="opens-at" className="mb-2 block text-sm font-medium">
            Fecha y hora de apertura
          </label>
          <input
            id="opens-at"
            name="opens_at"
            type="datetime-local"
            required
            value={opensAt}
            onChange={(event) => setOpensAt(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="closes-at" className="mb-2 block text-sm font-medium">
            Fecha y hora de cierre
          </label>
          <input
            id="closes-at"
            name="closes_at"
            type="datetime-local"
            required
            value={closesAt}
            onChange={(event) => setClosesAt(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
      </div>
      <p className="-mt-4 text-xs text-muted">
        Las fechas se envían como epoch UTC; las horas corresponden a la zona
        horaria local de este navegador.
      </p>

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-emerald-800 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? "Creando elección..." : "Crear elección"}
      </button>
    </form>
  );
}
