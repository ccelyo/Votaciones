"use client";

import { useState } from "react";
import { prepararToken } from "@/lib/m4/blind";
import { CifradorSimulado } from "@/lib/m4/encryptor";
import { clavesReciboDemo, parametrosDemo, reciboDemo } from "@/lib/m4/mocks";
import { serializarSobre } from "@/lib/m4/token";
import { guardarTokenAnonimo, obtenerTokenAnonimo } from "@/lib/m4/tokenStore";

function firmaSimulada256(): Uint8Array {
  // P1: firma simulada de 256 B. M6 la reemplaza por la firma ciega real.
  const firma = new Uint8Array(256);
  crypto.getRandomValues(firma);
  return firma;
}

export default function FormularioVoto({ electionId }: { electionId: string }) {
  const esDemo = electionId === "eleccion-demo";
  const opciones = esDemo
    ? parametrosDemo().opciones
    : ["Opción 1", "Opción 2"];
  const [opcion, setOpcion] = useState<string>("");
  const [fase, setFase] = useState<
    "elige" | "lista" | "enviando" | "hecho" | "error"
  >("elige");
  const [mensaje, setMensaje] = useState<string>("");
  const [recibo, setRecibo] = useState<string>("");
  const [esReintento, setEsReintento] = useState<boolean>(false);

  async function obtenerToken(): Promise<void> {
    try {
      setMensaje("Generando token anónimo…");
      // 1. El navegador genera nonce + prepared (no sale la identidad).
      const { prepared, nonce } = prepararToken(electionId);
      // 2. P1: se ciega y se envía a identidad (simulado aquí).
      // P2: cegar(prepared, claveDesdeDerSpki(claveM6)) + POST con sesión de M3.
      const sobre = serializarSobre({
        version: 1,
        kid: "demo-kid-1",
        electionId,
        nonce,
        preparedMessage: prepared,
        signature: firmaSimulada256(),
      });
      guardarTokenAnonimo(electionId, sobre);
      setFase("lista");
      setMensaje("Token anónimo listo. Ya puedes cifrar y enviar tu voto.");
    } catch {
      setFase("error");
      setMensaje("No se pudo generar el token anónimo. Intenta de nuevo.");
    }
  }

  async function votar(): Promise<void> {
    if (!opcion) {
      setMensaje("Elige una opción para continuar.");
      return;
    }
    setFase("enviando");
    setMensaje("Cifrando tu voto en este navegador…");
    try {
      if (!obtenerTokenAnonimo(electionId)) {
        setFase("lista");
        setMensaje("Primero obtén tu token anónimo con el botón de arriba.");
        return;
      }
      // Cifrado local: el voto en claro nunca sale del navegador.
      const cifrador = new CifradorSimulado();
      const { ciphertext, proof } = await cifrador.cifrar(opcion, electionId);
      void ciphertext;
      void proof;
      // P1: envío simulado con recibo Ed25519 real (ver mocks.ts).
      // P2: enviarPapeleta() con credentials:"omit" hacia el API de M7.
      const sobreRecibo = await reciboDemo(electionId, opcion);
      await clavesReciboDemo(electionId);
      const reintento = recibo === sobreRecibo;
      setRecibo(sobreRecibo);
      setEsReintento(reintento);
      setFase("hecho");
      setMensaje(
        reintento
          ? "Ya habías enviado este voto: se devolvió el mismo recibo (reintento idéntico)."
          : "Voto registrado. Guarda tu recibo para verificarlo después.",
      );
    } catch {
      setFase("error");
      setMensaje(
        "No se pudo enviar el voto. Revisa tu conexión e intenta de nuevo.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="card p-6">
        <h2 className="font-display text-lg font-bold text-navy-900">
          1. Elige tu opción
        </h2>
        <p className="mt-1 text-sm text-muted">
          Tu selección solo existe en este navegador hasta que se cifra.
        </p>
        <div className="mt-4 flex flex-col gap-2">
          {opciones.map((nombre) => (
            <label
              key={nombre}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 px-4 py-3 font-bold text-navy-900 transition-colors ${
                opcion === nombre
                  ? "border-royal-600 bg-royal-50"
                  : "border-line hover:border-royal-500/40"
              }`}
            >
              <input
                type="radio"
                name="opcion-voto"
                value={nombre}
                checked={opcion === nombre}
                onChange={() => setOpcion(nombre)}
                className="size-4 accent-royal-700"
              />
              <span>{nombre}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="card p-6">
        <h2 className="font-display text-lg font-bold text-navy-900">
          2. Obtén tu token anónimo
        </h2>
        <p className="mt-1 text-sm text-muted">
          Se genera con firma ciega: la identidad sabe que recibiste un token,
          pero no puede unirlo con tu papeleta.
        </p>
        <button
          type="button"
          onClick={obtenerToken}
          className="btn btn-secondary mt-4"
        >
          Obtener token anónimo
        </button>
      </section>

      <section className="card p-6">
        <h2 className="font-display text-lg font-bold text-navy-900">
          3. Cifra y envía
        </h2>
        <p className="mt-1 text-sm text-muted">
          El voto se cifra aquí y se envía sin sesión ni cookies, para no
          vincular tu identidad con la papeleta.
        </p>
        <button
          type="button"
          onClick={votar}
          disabled={fase === "enviando" || fase === "elige"}
          className="btn btn-primary mt-4"
        >
          {fase === "enviando" ? "Enviando…" : "Cifrar y enviar voto"}
        </button>
        {mensaje ? (
          <p role="status" className="alert alert-info mt-4">
            {mensaje}
          </p>
        ) : null}
      </section>

      {fase === "hecho" && recibo ? (
        <section className="alert alert-success p-6">
          <h2 className="font-display text-lg font-bold">Recibo firmado</h2>
          {esReintento ? (
            <p className="text-sm">
              Reintento idéntico: mismo recibo que antes.
            </p>
          ) : null}
          <code className="mt-3 block break-all rounded-xl bg-white/80 p-3 font-mono text-xs">
            {recibo}
          </code>
          <a
            className="mt-3 inline-block font-bold underline"
            href={`/elecciones/${encodeURIComponent(electionId)}/recibo?recibo=${encodeURIComponent(recibo)}`}
          >
            Ver y verificar el recibo
          </a>
        </section>
      ) : null}
    </div>
  );
}
