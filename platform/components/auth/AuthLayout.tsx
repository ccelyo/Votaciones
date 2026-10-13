import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  Icon,
  RiLockLine,
  RiReceiptLine,
  RiShieldCheckLine,
} from "@/components/icons";
import { Logo } from "@/components/layout/Logo";

const GUARANTEES = [
  {
    icon: RiShieldCheckLine,
    title: "Identidad verificada",
    text: "Usuario, contraseña y código de verificación.",
  },
  {
    icon: RiLockLine,
    title: "Voto secreto",
    text: "Se cifra en tu dispositivo y viaja sin tus datos.",
  },
  {
    icon: RiReceiptLine,
    title: "Comprobante verificable",
    text: "Confirma que tu papeleta quedó registrada.",
  },
];

type AuthLayoutProps = {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: AuthLayoutProps) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <aside className="security-paper relative hidden overflow-hidden border-r border-line lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-16">
        {/* Sello de agua */}
        <Image
          src="/logo.png"
          alt=""
          width={420}
          height={420}
          className="pointer-events-none absolute -bottom-16 -right-16 opacity-[0.06] select-none"
        />

        <Link href="/" aria-label="Espivota — Inicio" className="w-fit rounded">
          <Logo size={40} />
        </Link>

        <div className="relative max-w-md">
          <p className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.14em] text-muted">
            <span className="h-px w-8 bg-royal-700" aria-hidden />
            Plataforma oficial de votación
          </p>
          <h2 className="mt-5 text-4xl font-bold leading-[1.1] tracking-tight text-ink xl:text-[2.75rem]">
            Vota de forma segura, secreta y verificable.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-muted">
            Tu identidad se comprueba en un servicio y tu voto se recibe en
            otro. Nadie puede relacionar quién eres con lo que votaste.
          </p>

          <ul className="mt-10 divide-y divide-line border-y border-line">
            {GUARANTEES.map((item, index) => (
              <li
                key={item.title}
                className="reveal flex items-start gap-4 py-4"
                style={{ "--i": index + 1 } as React.CSSProperties}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-line bg-white text-royal-700">
                  <Icon icon={item.icon} size={20} />
                </span>
                <div>
                  <p className="font-semibold text-ink">{item.title}</p>
                  <p className="text-sm text-muted">{item.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-subtle">
          © {new Date().getFullYear()} Espivota · Votación electrónica
        </p>
      </aside>

      <main className="flex flex-col bg-white px-6 py-8 sm:px-12">
        <Link
          href="/"
          aria-label="Espivota — Inicio"
          className="w-fit rounded lg:hidden"
        >
          <Logo />
        </Link>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="reveal w-full max-w-sm">
            <h1 className="text-3xl font-bold tracking-tight text-ink">
              {title}
            </h1>
            <p className="mt-2 text-muted">{subtitle}</p>
            <div className="mt-8">{children}</div>
            {footer ? (
              <div className="mt-8 border-t border-line pt-6 text-center text-sm text-muted">
                {footer}
              </div>
            ) : null}
            <p className="mt-10 flex items-center gap-2 text-xs text-subtle lg:hidden">
              <Icon icon={RiLockLine} size={14} />
              Conexión cifrada · Voto secreto
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
