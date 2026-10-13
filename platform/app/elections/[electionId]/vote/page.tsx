import { ElectionVoteForm } from "@/components/election/ElectionVoteForm";
import { PageShell } from "@/components/layout/PageShell";

type ElectionVotePageProps = {
  params: Promise<{ electionId: string }>;
};

export const metadata = {
  title: "Votar",
};

export default async function ElectionVotePage({
  params,
}: ElectionVotePageProps) {
  const { electionId } = await params;

  return (
    <PageShell>
      <ElectionVoteForm electionId={electionId} />
    </PageShell>
  );
}
