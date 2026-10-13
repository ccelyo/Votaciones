"use client";

import { useState } from "react";
import { clavesReciboDemo } from "@/lib/m4/mocks";
import {
  hexDeBytes,
  interpretarRecibo,
  verificarRecibo,
} from "@/lib/m4/receipt";

export default function ReciboDetalle({
  electionId,
  sobre,
}: {
  electionId: string;
  sobre: string;
}) {
  const [estado, setEstado] = useState<string>("Sin verificar");
  const [detalle, setDetalle] = useState<string>("");

  let vistaPrevia: { hash: string; firma: string } | null = null;
  try {
    const recibo = interpretarRecibo(sobre);
    vistaPrevia = {
      hash: hexDeBytes(recibo.ballotHash),
      firma: hexDeBytes(recibo.signature).slice(0, 64) + "…",
    };
  } catch {
    vistaPrevia = null;
  }

  async function verificar(): Promise<void> {
    try {
      setEstado("Verificando…");
      const { publica } = await clavesReciboDemo(electionId);
      const recibo = await verificarRecibo(publica, sobre);
      setEstado("Recibo válido");
      setDetalle(
        `Elección: ${recibo.electionId} · Hash: ${hexDeBytes(recibo.ballotHash)}`,
      );
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
    <div className="card flex flex-col gap-4 p-6">
      <h2 className="font-display text-lg font-bold text-navy-900">
        Tu recibo
      </h2>
      <p className="text-sm text-muted">
        Guarda este recibo: te permite comprobar que tu papeleta quedó
        registrada, sin revelar tu voto.
      </p>
      <code className="block break-all rounded-xl bg-canvas p-3 font-mono text-xs ring-1 ring-line">
        {sobre}
      </code>
      {vistaPrevia ? (
        <dl className="text-sm">
          <dt className="font-bold text-navy-900">Hash de papeleta</dt>
          <dd className="break-all font-mono text-xs">{vistaPrevia.hash}</dd>
          <dt className="mt-3 font-bold text-navy-900">Firma (vista previa)</dt>
          <dd className="break-all font-mono text-xs">{vistaPrevia.firma}</dd>
        </dl>
      ) : (
        <p className="alert alert-error">
          El formato del recibo es incorrecto.
        </p>
      )}
      <p role="status" className="text-sm font-medium">
        Estado: {estado}
      </p>
      {detalle ? <p className="text-sm">{detalle}</p> : null}
      <div className="flex gap-3">
        <button type="button" onClick={verificar} className="btn btn-primary">
          Verificar recibo
        </button>
        <button type="button" onClick={copiar} className="btn btn-secondary">
          Copiar
        </button>
      </div>
    </div>
  );
}
