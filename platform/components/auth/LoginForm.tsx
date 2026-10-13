"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { Icon, RiCheckLine } from "@/components/icons";
import { completeMfaLogin, login } from "@/lib/api";

const INPUT_CLASS = "field";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedNextPath = searchParams.get("next");
  const nextPath =
    requestedNextPath?.startsWith("/") &&
    !requestedNextPath.startsWith("//") &&
    !requestedNextPath.includes("\\")
      ? requestedNextPath
      : "/";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      try {
        const result = await login({ username, password });
        if ("challenge_id" in result) {
          setChallengeId(result.challenge_id);
        } else {
          router.push(nextPath);
          router.refresh();
        }
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "No se pudo iniciar sesión.",
        );
      }
    });
  }

  function handleMfaSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!challengeId) return;

    startTransition(async () => {
      try {
        await completeMfaLogin(challengeId, mfaCode);
        router.push(nextPath);
        router.refresh();
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "No se pudo verificar el código MFA.",
        );
      }
    });
  }

  return (
    <form
      onSubmit={challengeId ? handleMfaSubmit : handleSubmit}
      className="space-y-5"
    >
      <ol
        className="flex items-center gap-2 text-xs font-bold"
        aria-label="Pasos"
      >
        <li
          className={`flex items-center gap-2 ${challengeId ? "text-success" : "text-royal-700"}`}
          aria-current={challengeId ? undefined : "step"}
        >
          <span
            className={`flex size-6 items-center justify-center rounded-full text-white ${challengeId ? "bg-success" : "bg-royal-700"}`}
          >
            {challengeId ? <Icon icon={RiCheckLine} size={14} /> : "1"}
          </span>
          Credenciales
        </li>
        <li className="h-px flex-1 bg-line" aria-hidden />
        <li
          className={`flex items-center gap-2 ${challengeId ? "text-royal-700" : "text-subtle"}`}
          aria-current={challengeId ? "step" : undefined}
        >
          <span
            className={`flex size-6 items-center justify-center rounded-full ${challengeId ? "bg-royal-700 text-white" : "bg-canvas text-subtle ring-1 ring-line"}`}
          >
            2
          </span>
          Verificación
        </li>
      </ol>

      {error ? (
        <div role="alert" className="alert alert-error">
          {error}
        </div>
      ) : null}

      {challengeId ? (
        <>
          <p className="text-sm text-muted">
            Ingresa el código de verificación de 6 dígitos.
          </p>
          <div>
            <label htmlFor="mfa-code" className="field-label">
              Código MFA
            </label>
            <input
              id="mfa-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              required
              value={mfaCode}
              onChange={(event) =>
                setMfaCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              className={`${INPUT_CLASS} text-center font-mono text-2xl tracking-[0.5em]`}
              placeholder="••••••"
            />
          </div>
          <button
            type="submit"
            disabled={isPending}
            className="btn btn-primary w-full"
          >
            {isPending ? "Verificando..." : "Verificar código"}
          </button>
          <button
            type="button"
            onClick={() => {
              setChallengeId(null);
              setMfaCode("");
              setError(null);
            }}
            className="btn btn-ghost w-full"
          >
            Volver al inicio de sesión
          </button>
        </>
      ) : (
        <>
          <div>
            <label htmlFor="username" className="field-label">
              Usuario
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              maxLength={100}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className={INPUT_CLASS}
              autoComplete="username"
            />
          </div>

          <div>
            <label htmlFor="password" className="field-label">
              Contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT_CLASS}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            disabled={isPending}
            className="btn btn-primary w-full"
          >
            {isPending ? "Ingresando..." : "Ingresar"}
          </button>
        </>
      )}
    </form>
  );
}
