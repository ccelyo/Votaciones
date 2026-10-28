import { ElectionManager } from "@/components/admin/ElectionManager";
import { AdminGuard } from "@/components/auth/AuthGuard";
import { PageShell } from "@/components/layout/PageShell";
import { requireAdmin } from "@/lib/server/gateway";

export const metadata = {
  title: "Gestionar elección",
};

export default async function ManageElectionPage({
  params,
}: {
  params: Promise<{ electionId: string }>;
}) {
  const { electionId } = await params;
  const verified = await requireAdmin(`/admin/elections/${electionId}`);

  return (
    <PageShell>
      <AdminGuard verifiedOnServer={verified}>
        <ElectionManager electionId={Number(electionId)} />
      </AdminGuard>
    </PageShell>
  );
}
