import type { Metadata } from "next";
import { Lato, PT_Serif } from "next/font/google";
import "./globals.css";

const ptSerif = PT_Serif({
  variable: "--font-pt-serif",
  subsets: ["latin"],
  weight: ["400", "700"],
});

const lato = Lato({
  variable: "--font-lato",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Votación",
  description: "Sistema de votación",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" className={`${ptSerif.variable} ${lato.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">{children}</body>
    </html>
  );
}