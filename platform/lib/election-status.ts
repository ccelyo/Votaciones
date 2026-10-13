import type { ElectionEstatus } from "@/lib/types/election";

export const STATUS_LABEL: Record<ElectionEstatus, string> = {
  draft: "Borrador",
  open: "Abierta",
  closed: "Cerrada",
};

export const STATUS_CLASS: Record<ElectionEstatus, string> = {
  draft: "bg-canvas text-muted",
  open: "bg-success-soft text-success",
  closed: "bg-navy-900 text-white",
};
