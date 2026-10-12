import { redirect } from "next/navigation";

import { RegisterPageContent } from "@/components/auth/RegisterPageContent";

export const metadata = {
  title: "Crear cuenta",
};

export default function RegisterPage() {
  if (process.env.NEXT_PUBLIC_API_MODE !== "mock") redirect("/login");
  return <RegisterPageContent />;
}
