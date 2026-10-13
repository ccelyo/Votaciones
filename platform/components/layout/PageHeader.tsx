import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

type Crumb = { href?: string; label: string };

type PageHeaderProps = {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
};

/** Encabezado de página sobre "papel de seguridad", con sello de agua. */
export function PageHeader({
  title,
  eyebrow,
  description,
  breadcrumbs = [],
  actions,
}: PageHeaderProps) {
  return (
    <section className="security-paper relative overflow-hidden border-b border-line">
      <Image
        src="/logo.png"
        alt=""
        width={260}
        height={260}
        className="pointer-events-none absolute -right-10 -top-12 hidden opacity-[0.05] select-none md:block"
      />
      <div className="relative mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {breadcrumbs.length > 0 ? (
          <nav aria-label="Ruta de navegación" className="mb-5 text-sm">
            <ol className="flex flex-wrap items-center gap-1.5 text-muted">
              {breadcrumbs.map((crumb, index) => (
                <li key={crumb.label} className="flex items-center gap-1.5">
                  {index > 0 ? (
                    <span aria-hidden className="text-subtle">
                      /
                    </span>
                  ) : null}
                  {crumb.href ? (
                    <Link
                      href={crumb.href}
                      className="underline-offset-2 hover:text-royal-700 hover:underline"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span
                      aria-current="page"
                      className="font-semibold text-ink"
                    >
                      {crumb.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="reveal max-w-3xl">
            {eyebrow ? (
              <p className="mb-3 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.14em] text-muted">
                <span className="h-px w-8 bg-royal-700" aria-hidden />
                {eyebrow}
              </p>
            ) : null}
            <h1 className="text-3xl font-bold leading-tight tracking-tight text-ink sm:text-4xl">
              {title}
            </h1>
            {description ? (
              <p className="mt-3 text-base leading-relaxed text-muted">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex gap-3">{actions}</div> : null}
        </div>
      </div>
    </section>
  );
}
