import { AdminGuard } from "@/components/auth/AuthGuard";
import { CreateElectionForm } from "@/components/election/CreateElectionForm";
import { Header } from "@/components/layout/Header";

export default function NewElectionPage() {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <AdminGuard>
        <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
          <header className="mb-8">
            <p className="text-sm font-semibold uppercase tracking-wide text-emerald-800">
              Administración
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
              Crear elección
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              Configura el nombre, las opciones, la clave pública y el periodo
              de participación. Al crearla, se registra también en el servicio
              de urnas.
            </p>
          </header>
          <section
            aria-label="Formulario para crear una elección"
            className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8"
          >
            <CreateElectionForm />
          </section>
        </main>
      </AdminGuard>
    </div>
  );
}
