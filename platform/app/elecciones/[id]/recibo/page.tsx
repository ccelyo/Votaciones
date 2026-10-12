import Link from "next/link";
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
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-1 flex-col gap-6 bg-white px-6 py-10 dark:bg-black sm:px-10">
        <nav className="text-sm">
          <Link href="/" className="underline">
            Inicio
          </Link>
          <span> · </span>
          <Link href={`/elecciones/${encodeURIComponent(electionId)}/votar`} className="underline">
            Volver a votar
          </Link>
        </nav>
        <header>
          <h1 className="text-2xl font-semibold">Recibo de la elección {electionId}</h1>
          <p className="mt-2 text-sm opacity-70">
            Verifica que tu papeleta quedó registrada. Si el recibo es válido, consérvalo.
          </p>
        </header>
        {!recibo ? (
          <p className="rounded-xl border border-black/10 p-5 text-sm dark:border-white/15">
            Falta el recibo. Vuelve a la votación, envía tu voto y usa el enlace «Ver y verificar el
            recibo».
          </p>
        ) : (
          <ReciboDetalle electionId={electionId} sobre={recibo} />
        )}
      </main>
    </div>
  );
}
