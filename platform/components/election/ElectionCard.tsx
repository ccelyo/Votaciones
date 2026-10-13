import Link from "next/link";

import {
  Icon,
  RiArrowRightSLine,
  RiFileList3Line,
  RiTimeLine,
} from "@/components/icons";
import { IconTile } from "@/components/ui/IconTile";
import { formatClosesIn, formatDate } from "@/lib/format";
import type { Election } from "@/lib/types/election";

type ElectionCardProps = {
  election: Election;
  index: number;
  isAuthenticated: boolean;
};

export function ElectionCard({
  election,
  index,
  isAuthenticated,
}: ElectionCardProps) {
  const votePath = `/elections/${election.id}/vote`;
  const closesIn = formatClosesIn(election.ends_at);

  return (
    <li
      className="reveal group flex flex-col gap-4 px-5 py-5 transition-colors hover:bg-canvas/60 sm:flex-row sm:items-center sm:gap-5"
      style={{ "--i": index } as React.CSSProperties}
    >
      <IconTile icon={RiFileList3Line} />
      <div className="min-w-0 flex-1">
        <h3 className="text-lg font-bold leading-snug text-ink">
          {election.name}
        </h3>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span className="inline-flex items-center gap-1.5 font-semibold text-success">
            <span className="size-1.5 rounded-full bg-success" aria-hidden />
            Abierta
          </span>
          <span aria-hidden className="text-line">
            |
          </span>
          <span className="inline-flex items-center gap-1">
            <Icon icon={RiTimeLine} size={14} />
            {closesIn ?? "—"}
          </span>
          <span aria-hidden className="text-line">
            |
          </span>
          <span>Cierre: {formatDate(election.ends_at)}</span>
        </p>
      </div>
      <Link
        href={
          isAuthenticated
            ? votePath
            : `/login?next=${encodeURIComponent(votePath)}`
        }
        className="btn btn-primary shrink-0"
      >
        {isAuthenticated ? "Ir a votar" : "Iniciar sesión para votar"}
        <Icon
          icon={RiArrowRightSLine}
          size={20}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </Link>
    </li>
  );
}
