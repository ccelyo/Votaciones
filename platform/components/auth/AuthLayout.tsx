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

const STEPS = [
  {
    icon: RiShieldCheckLine,
    title: "Te identificas",
    text: "Con tu usuario y un código de verificación.",
  },
  {
    icon: RiLockLine,
    title: "Votas en secreto",
    text: "Tu voto se cifra antes de salir de tu dispositivo.",
  },
  {
    icon: RiReceiptLine,
    title: "Guardas tu recibo",
    text: "Una prueba de que tu papeleta quedó registrada.",
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
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside className="band hidden flex-col justify-between p-12 lg:flex">
        <Link href="/" className="w-fit rounded-lg">
          <span className="inline-flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-xl bg-white shadow-lg">
              <Image src="/logo.png" alt="" width={36} height={36} priority />
            </span>
            <span className="font-display text-xl font-bold">Espivota</span>
          </span>
        </Link>

        <div className="max-w-md">
          <h2 className="font-display text-5xl font-extrabold leading-[1.05]">
            Un voto,
            <br />
            una persona,
            <br />
            <span className="text-royal-100">cero rastros.</span>
          </h2>
          <ol className="mt-10 space-y-5">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="reveal flex gap-4"
                style={{ "--i": index + 1 } as React.CSSProperties}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/12 ring-1 ring-white/25">
                  <Icon icon={step.icon} size={20} />
                </span>
                <div>
                  <p className="font-bold">{step.title}</p>
                  <p className="text-sm text-white/75">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <p className="text-xs text-white/60">
          Tu identidad y tu papeleta se procesan en servicios separados.
        </p>
      </aside>

      <main className="flex flex-col bg-white px-6 py-8 sm:px-12">
        <Link href="/" className="w-fit rounded-lg lg:hidden">
          <Logo />
        </Link>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="reveal w-full max-w-sm">
            <h1 className="font-display text-3xl font-bold text-navy-900">
              {title}
            </h1>
            <p className="mt-2 text-muted">{subtitle}</p>
            <div className="mt-8">{children}</div>
            {footer ? (
              <div className="mt-8 border-t border-line pt-6 text-center text-sm text-muted">
                {footer}
              </div>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
