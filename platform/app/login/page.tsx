import Link from "next/link";
import { Suspense } from "react";

import { AuthLayout } from "@/components/auth/AuthLayout";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata = {
  title: "Iniciar sesión",
};

export default function LoginPage() {
  return (
    <AuthLayout
      title="Iniciar sesión"
      subtitle="Ingresa para ver tus elecciones y votar."
      footer={
        process.env.NEXT_PUBLIC_API_MODE === "mock" ? (
          <>
            ¿No tienes cuenta?{" "}
            <Link href="/register" className="link">
              Regístrate
            </Link>
          </>
        ) : undefined
      }
    >
      <Suspense fallback={<p className="text-sm text-subtle">Cargando...</p>}>
        <LoginForm />
      </Suspense>
    </AuthLayout>
  );
}
