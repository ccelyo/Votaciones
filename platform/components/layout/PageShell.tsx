import type { ReactNode } from "react";
import { Header } from "@/components/layout/Header";
import { getSessionUser, SERVER_DATA_ENABLED } from "@/lib/server/gateway";

/** Encabezado + contenido + pie comunes a todas las páginas. */
export async function PageShell({ children }: { children: ReactNode }) {
  // El Servidor SSR resuelve la sesión: la página llega renderizada con el usuario.
  const user = SERVER_DATA_ENABLED ? await getSessionUser() : undefined;

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded focus:bg-royal-700 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Saltar al contenido principal
      </a>
      <Header initialUser={user} />
      <div id="main-content" className="flex flex-1 flex-col">
        {children}
      </div>
      <footer className="mt-auto border-t border-line bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-4 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>
            © {new Date().getFullYear()} Espivota · Votación electrónica
          </span>
          <span>Voto cifrado y secreto · Un voto por persona inscrita</span>
        </div>
      </footer>
    </div>
  );
}
