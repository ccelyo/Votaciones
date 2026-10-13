import { AdminGuard } from "@/components/auth/AuthGuard";
import { CreateElectionForm } from "@/components/election/CreateElectionForm";
import { PageShell } from "@/components/layout/PageShell";

export const metadata = {
  title: "Crear elección",
};

export default function NewElectionPage() {
  return (
    <PageShell>
      <AdminGuard>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
          <header className="reveal mb-8">
            <p className="eyebrow">Administración</p>
            <h1 className="font-display mt-1 text-3xl font-bold text-navy-900 sm:text-4xl">
              Crear elección
            </h1>
            <p className="mt-3 max-w-2xl text-muted">
              Define el nombre, las opciones, la clave pública y el periodo. Al
              crearla, también se registra en el servicio de urnas.
            </p>
          </header>
          <section
            aria-label="Formulario para crear una elección"
            className="reveal card p-6 sm:p-8"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            <CreateElectionForm />
          </section>
        </main>
      </AdminGuard>
    </PageShell>
  );
}
