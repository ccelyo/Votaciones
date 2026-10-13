import Link from "next/link";
import { PageShell } from "@/components/layout/PageShell";
import ReciboDetalle from "@/components/m4/ReciboDetalle";

export default async function ReciboPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ recibo?: string }>;
}) {
  const { id } = await params;
  const electionId = decodeURIComponent(id);
  const { recibo } = await searchParams;

  return (
    <PageShell>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
        <nav className="flex gap-2 text-sm text-muted">
          <Link href="/" className="font-bold text-royal-700 hover:underline">
            Inicio
          </Link>
          <span> · </span>
          <Link
            href={`/elecciones/${encodeURIComponent(electionId)}/votar`}
            className="font-bold text-royal-700 hover:underline"
          >
            Volver a votar
          </Link>
        </nav>
        <header>
          <h1 className="font-display text-3xl font-bold text-navy-900">
            Recibo de la elección {electionId}
          </h1>
          <p className="mt-2 text-muted">
            Verifica que tu papeleta quedó registrada. Si el recibo es válido,
            consérvalo.
          </p>
        </header>
        {!recibo ? (
          <p className="alert alert-info">
            Falta el recibo. Vuelve a la votación, envía tu voto y usa el enlace
            «Ver y verificar el recibo».
          </p>
        ) : (
          <ReciboDetalle electionId={electionId} sobre={recibo} />
        )}
      </main>
    </PageShell>
  );
}
