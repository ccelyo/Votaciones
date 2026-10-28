import { AdminGuard } from "@/components/auth/AuthGuard";
import { CreateElectionForm } from "@/components/election/CreateElectionForm";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";

export const metadata = {
  title: "Crear elección",
};

export default function NewElectionPage() {
  return (
    <PageShell>
      <AdminGuard>
        <PageHeader
          eyebrow="Nueva elección"
          title="Crear elección"
          description="Define el nombre, las opciones, la clave pública y el periodo. Después podrás inscribir a los votantes en el padrón."
          breadcrumbs={[
            { href: "/admin", label: "Administración" },
            { label: "Crear elección" },
          ]}
        />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
          <section
            aria-label="Formulario para crear una elección"
            className="card p-6 sm:p-8"
          >
            <CreateElectionForm />
          </section>
        </main>
      </AdminGuard>
    </PageShell>
  );
}
