import { Header } from "@/components/layout/Header";

import { RegisterForm } from "./RegisterForm";

export function RegisterPageContent() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header variant="marketing" activePath="/register" />
      <main className="relative flex flex-1 items-center justify-center px-6 py-8">
        <div className="pointer-events-none absolute inset-0 auth-panel-grid opacity-40" />

        <section className="auth-reveal ds-card relative w-full max-w-md p-8 sm:p-10">
          <header className="text-center">
            <h1 className="ds-headline text-3xl text-foreground">
              Crear cuenta
            </h1>
            <p className="mt-2 text-sm text-muted">
              Completa tus datos para registrarte.
            </p>
          </header>

          <div className="mt-6">
            <RegisterForm />
          </div>
        </section>
      </main>
    </div>
  );
}
