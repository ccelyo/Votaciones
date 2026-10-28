export type ElectionEstatus = "draft" | "open" | "closed";

export interface Election {
  id: number;
  name: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
  options?: string[];
}

export interface ElectionCreatePayload {
  name: string;
  options: string[];
  encryption_public_key: string;
  opens_at: number;
  closes_at: number;
}

export interface CreatedElection {
  election_id: string;
  status: string;
}

export interface ElectionVote {
  election_id: number;
  user_id: number;
  option: string;
  created_at: string;
  receipt?: string;
}

export interface AdminElection {
  id: number;
  name: string;
  status: ElectionEstatus;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string | null;
}

export interface ElectionSummary {
  election_id: string;
  identity_status: string;
  ballot_status: string;
  total_ballots: number;
}

export interface VoterRollEntry {
  user_id: number;
  election_id: string;
  is_eligible: boolean;
  has_voted: boolean;
}

export interface Eligibility {
  election_id: string;
  is_eligible: boolean;
  has_voted: boolean;
  token_issued: boolean;
}
