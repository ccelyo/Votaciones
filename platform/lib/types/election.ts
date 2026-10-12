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
}
