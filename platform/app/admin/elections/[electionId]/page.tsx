import { ElectionManager } from "@/components/admin/ElectionManager";
import { AdminGuard } from "@/components/auth/AuthGuard";
import { PageShell } from "@/components/layout/PageShell";

export const metadata = {
  title: "Gestionar elección",
};

export default async function ManageElectionPage({
  params,
}: {
  params: Promise<{ electionId: string }>;
}) {
  const { electionId } = await params;

  return (
    <PageShell>
      <AdminGuard>
        <ElectionManager electionId={Number(electionId)} />
      </AdminGuard>
    </PageShell>
  );
}
