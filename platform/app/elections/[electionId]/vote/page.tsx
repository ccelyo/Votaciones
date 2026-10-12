import { ElectionVoteForm } from "@/components/election/ElectionVoteForm";
import { Header } from "@/components/layout/Header";

type ElectionVotePageProps = {
  params: Promise<{ electionId: string }>;
};

export default async function ElectionVotePage({
  params,
}: ElectionVotePageProps) {
  const { electionId } = await params;

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <ElectionVoteForm electionId={electionId} />
    </div>
  );
}
