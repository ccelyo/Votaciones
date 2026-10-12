import Link from "next/link";
import FormularioVoto from "@/components/m4/FormularioVoto";

export default async function VotarPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const electionId = decodeURIComponent(id);

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-1 flex-col gap-6 bg-white px-6 py-10 dark:bg-black sm:px-10">
        <nav className="text-sm">
          <Link href="/" className="underline">
            Inicio
          </Link>
          <span> · Votación</span>
        </nav>
        <header>
          <h1 className="text-2xl font-semibold">Votar en la elección {electionId}</h1>
          <p className="mt-2 text-sm opacity-70">
            El voto se cifra en tu navegador. El servidor solo recibe la papeleta cifrada y un token
            anónimo: nunca tu identidad junto con tu voto.
          </p>
        </header>
        <FormularioVoto electionId={electionId} />
        <footer className="text-xs opacity-60">
          Prototipo 1: cifrado simulado compatible con Go; la auditoría Benaloh queda fuera de este
          prototipo por decisión del equipo.
        </footer>
      </main>
    </div>
  );
}
