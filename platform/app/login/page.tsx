import Link from "next/link";
import { Suspense } from "react";

import { LoginForm } from "@/components/auth/LoginForm";
import { Header } from "@/components/layout/Header";

export default function LoginPage() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Header variant="marketing" activePath="/login" />
      <main className="relative flex min-h-0 flex-1 items-center justify-center px-6 py-8">
        <div className="pointer-events-none absolute inset-0 auth-panel-grid opacity-40" />

        <div className="auth-reveal ds-card relative w-full max-w-md p-8 sm:p-10">
          <header className="text-center">
            <h1 className="ds-headline text-3xl text-foreground">
              Iniciar sesión
            </h1>
            <p className="mt-2 text-sm text-muted">Bienvenido</p>
          </header>

          <div className="mt-6">
            <Suspense
              fallback={<p className="text-sm text-subtle">Cargando...</p>}
            >
              <LoginForm />
            </Suspense>
          </div>

          {process.env.NEXT_PUBLIC_API_MODE === "mock" ? (
            <div className="mt-8 border-t border-dashed border-border pt-6 text-center text-sm text-muted">
              ¿No tienes cuenta?{" "}
              <Link href="/register" className="ds-link">
                Regístrate
              </Link>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
