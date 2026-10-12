export type ElectionEstatus = "draft" | "open" | "closed";

export interface Election {
    id: number;
    name: string;
    starts_at: string;
    ends_at: string;
    created_at: string;
};

export interface ElectionCreatePayload {
    name: string;
    starts_at: string;
    ends_at: string;
};