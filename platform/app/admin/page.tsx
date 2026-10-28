import Link from "next/link";

import { AdminElections } from "@/components/admin/AdminElections";
import { AdminGuard } from "@/components/auth/AuthGuard";
import { Icon, RiAddLine } from "@/components/icons";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { loadAllElections, requireAdmin } from "@/lib/server/gateway";

export const metadata = {
  title: "Administración",
};

export default async function AdminPage() {
  const verified = await requireAdmin("/admin");
  const elections = verified ? await loadAllElections() : undefined;

  return (
    <PageShell>
      <AdminGuard verifiedOnServer={verified}>
        <PageHeader
          eyebrow="Administración"
          title="Panel de administración"
          description="Crea elecciones, gestiona el padrón electoral y consulta la participación."
          actions={
            <Link href="/admin/elections/new" className="btn btn-primary">
              <Icon icon={RiAddLine} size={18} />
              Crear elección
            </Link>
          }
        />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
          <AdminElections initialElections={elections} />
        </main>
      </AdminGuard>
    </PageShell>
  );
}
