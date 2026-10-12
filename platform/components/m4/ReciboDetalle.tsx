"use client";

import { useState } from "react";
import { clavesReciboDemo } from "@/lib/m4/mocks";
import { hexDeBytes, interpretarRecibo, verificarRecibo } from "@/lib/m4/receipt";

export default function ReciboDetalle({ electionId, sobre }: { electionId: string; sobre: string }) {
  const [estado, setEstado] = useState<string>("Sin verificar");
  const [detalle, setDetalle] = useState<string>("");

  let vistaPrevia: { hash: string; firma: string } | null = null;
  try {
    const recibo = interpretarRecibo(sobre);
    vistaPrevia = { hash: hexDeBytes(recibo.ballotHash), firma: hexDeBytes(recibo.signature).slice(0, 64) + "…" };
  } catch {
    vistaPrevia = null;
  }

  async function verificar(): Promise<void> {
    try {
      setEstado("Verificando…");
      const { publica } = await clavesReciboDemo(electionId);
      const recibo = await verificarRecibo(publica, sobre);
      setEstado("Recibo válido");
      setDetalle(`Elección: ${recibo.electionId} · Hash: ${hexDeBytes(recibo.ballotHash)}`);
    } catch {
      setEstado("Recibo no válido");
      setDetalle("La firma no coincide o el formato es incorrecto.");
    }
  }

  async function copiar(): Promise<void> {
    try {
      await navigator.clipboard.writeText(sobre);
      setDetalle("Recibo copiado al portapapeles.");
    } catch {
      setDetalle("No se pudo copiar. Selecciónalo manualmente.");
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-black/10 p-5 dark:border-white/15">
      <h2 className="text-lg font-semibold">Tu recibo</h2>
      <p className="text-sm opacity-70">
        Guarda este recibo: te permite comprobar que tu papeleta quedó registrada, sin revelar tu voto.
      </p>
      <code className="block break-all rounded bg-black/[.06] p-3 font-mono text-xs dark:bg-white/[.08]">
        {sobre}
      </code>
      {vistaPrevia ? (
        <dl className="text-sm">
          <dt className="font-medium">Hash de papeleta</dt>
          <dd className="break-all font-mono text-xs">{vistaPrevia.hash}</dd>
          <dt className="mt-2 font-medium">Firma (vista previa)</dt>
          <dd className="break-all font-mono text-xs">{vistaPrevia.firma}</dd>
        </dl>
      ) : (
        <p className="text-sm text-red-600">El formato del recibo es incorrecto.</p>
      )}
      <p role="status" className="text-sm font-medium">
        Estado: {estado}
      </p>
      {detalle ? <p className="text-sm">{detalle}</p> : null}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={verificar}
          className="h-11 rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
        >
          Verificar recibo
        </button>
        <button
          type="button"
          onClick={copiar}
          className="h-11 rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a]"
        >
          Copiar
        </button>
      </div>
    </div>
  );
}
