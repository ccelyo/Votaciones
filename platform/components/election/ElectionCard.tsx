import Link from "next/link";

import {
  Icon,
  RiArrowRightLine,
  RiCalendarEventLine,
  RiTimeLine,
} from "@/components/icons";
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
    <article
      className="reveal group relative flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-white p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-royal-500/50 hover:shadow-[var(--shadow-lift)]"
      style={{ "--i": index } as React.CSSProperties}
    >
      <span
        className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-royal-700 via-royal-500 to-royal-700"
        aria-hidden
      />
      <div className="flex items-center justify-between gap-2">
        <span className="badge bg-success-soft text-success">
          <span className="live-dot" aria-hidden />
          Abierta
        </span>
        {closesIn ? (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-muted">
            <Icon icon={RiTimeLine} size={14} />
            {closesIn}
          </span>
        ) : null}
      </div>

      <h3 className="font-display mt-4 flex-1 text-xl font-bold leading-snug text-navy-900">
        {election.name}
      </h3>

      <p className="mt-4 flex items-center gap-2 text-sm text-muted">
        <Icon icon={RiCalendarEventLine} size={16} className="text-subtle" />
        Hasta el {formatDate(election.ends_at)}
      </p>

      <Link
        href={
          isAuthenticated
            ? votePath
            : `/login?next=${encodeURIComponent(votePath)}`
        }
        className="btn btn-primary mt-5 w-full"
      >
        {isAuthenticated ? "Votar" : "Inicia sesión para votar"}
        <Icon
          icon={RiArrowRightLine}
          size={18}
          className="transition-transform group-hover:translate-x-0.5"
        />
      </Link>
    </article>
  );
}
