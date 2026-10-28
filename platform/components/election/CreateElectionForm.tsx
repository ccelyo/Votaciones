"use client";

import Link from "next/link";
import { type FormEvent, useRef, useState, useTransition } from "react";

import {
  Icon,
  RiAddLine,
  RiCheckboxCircleFill,
  RiDeleteBinLine,
} from "@/components/icons";
import { createElection } from "@/lib/api";
import type {
  CreatedElection,
  ElectionCreatePayload,
} from "@/lib/types/election";

const INPUT_CLASS = "field";

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
    <form onSubmit={handleSubmit} className="divide-y divide-line">
      {error ? (
        <div role="alert" className="alert alert-error mb-6">
          {error}
        </div>
      ) : null}

      {createdElection ? (
        <output className="alert alert-success mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Icon icon={RiCheckboxCircleFill} size={20} className="shrink-0" />
          <span className="flex-1">
            Elección creada (ID {createdElection.election_id}). Ahora inscribe a
            los votantes en el padrón; sin inscripción nadie puede votar.
          </span>
          <Link
            href={`/admin/elections/${createdElection.election_id}`}
            className="btn btn-primary btn-sm"
          >
            Gestionar padrón
          </Link>
        </output>
      ) : null}

      <FormSection
        step={1}
        title="Información"
        description="Cómo verán la elección los votantes."
      >
        <label htmlFor="election-name" className="field-label">
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
          placeholder="Ej. Representante estudiantil 2026"
        />
      </FormSection>

      <FormSection
        step={2}
        title="Opciones"
        description="Entre 2 y 100 opciones, sin repetir."
      >
        <fieldset className="space-y-3">
          <legend className="sr-only">Opciones de votación</legend>
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
                onChange={(event) =>
                  updateOption(option.id, event.target.value)
                }
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
                  className="btn btn-danger shrink-0 px-3"
                  aria-label={`Eliminar opción ${index + 1}`}
                >
                  <Icon icon={RiDeleteBinLine} size={18} />
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
            className="btn btn-secondary w-full"
          >
            <Icon icon={RiAddLine} size={18} />
            Agregar opción
          </button>
        </fieldset>
      </FormSection>

      <FormSection
        step={3}
        title="Seguridad"
        description="Clave con la que se cifran los votos."
      >
        <label htmlFor="encryption-public-key" className="field-label">
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
        <p id="encryption-public-key-help" className="field-hint">
          Ingresa la clave pública en base64url sin relleno. La clave privada no
          debe compartirse ni enviarse.
        </p>
      </FormSection>

      <FormSection
        step={4}
        title="Periodo"
        description="Hora local de este navegador; se envía en UTC."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="opens-at" className="field-label">
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
            <label htmlFor="closes-at" className="field-label">
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
      </FormSection>

      <div className="pt-6">
        <button
          type="submit"
          disabled={isPending}
          className="btn btn-primary w-full sm:w-auto sm:px-8"
        >
          {isPending ? "Creando elección..." : "Crear elección"}
        </button>
      </div>
    </form>
  );
}

function FormSection({
  step,
  title,
  description,
  children,
}: {
  step: number;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 py-7 first:pt-0 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8">
      <div className="flex gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-white text-sm font-bold text-royal-700">
          {step}
        </span>
        <div>
          <h2 className="font-bold text-navy-900">{title}</h2>
          <p className="mt-0.5 text-sm text-muted">{description}</p>
        </div>
      </div>
      <div>{children}</div>
    </section>
  );
}
