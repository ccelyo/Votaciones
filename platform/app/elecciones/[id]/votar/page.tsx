import Link from "next/link";
import { PageShell } from "@/components/layout/PageShell";
import FormularioVoto from "@/components/m4/FormularioVoto";

export default async function VotarPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const electionId = decodeURIComponent(id);

  return (
    <PageShell>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
        <nav className="flex gap-2 text-sm text-muted">
          <Link href="/" className="font-bold text-royal-700 hover:underline">
            Inicio
          </Link>
          <span> · Votación</span>
        </nav>
        <header>
          <h1 className="font-display text-3xl font-bold text-navy-900">
            Votar en la elección {electionId}
          </h1>
          <p className="mt-2 text-muted">
            El voto se cifra en tu navegador. El servidor solo recibe la
            papeleta cifrada y un token anónimo: nunca tu identidad junto con tu
            voto.
          </p>
        </header>
        <FormularioVoto electionId={electionId} />
        <footer className="text-xs text-subtle">
          Prototipo 1: cifrado simulado compatible con Go; la auditoría Benaloh
          queda fuera de este prototipo por decisión del equipo.
        </footer>
      </main>
    </PageShell>
  );
}
