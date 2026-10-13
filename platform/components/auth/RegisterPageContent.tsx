import { AuthLayout } from "@/components/auth/AuthLayout";

import { RegisterForm } from "./RegisterForm";

export function RegisterPageContent() {
  return (
    <AuthLayout
      title="Crear cuenta"
      subtitle="Completa tus datos para registrarte."
    >
      <RegisterForm />
    </AuthLayout>
  );
}
