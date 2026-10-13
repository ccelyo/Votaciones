import type { ReactNode } from "react";
import { Header } from "@/components/layout/Header";

/** Encabezado + contenido + pie comunes a las páginas con sesión. */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-lg focus:bg-royal-700 focus:px-4 focus:py-2 focus:text-sm focus:font-bold focus:text-white"
      >
        Saltar al contenido principal
      </a>
      <Header />
      <div id="main-content" className="flex flex-1 flex-col">
        {children}
      </div>
      <footer className="border-t border-line bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-6 text-xs text-subtle sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>Espivota · voto secreto y verificable</span>
          <span>Tu identidad y tu papeleta viajan por separado.</span>
        </div>
      </footer>
    </div>
  );
}
