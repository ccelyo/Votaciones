import { ElectionList } from "@/components/election/ElectionList";
import {
  RiCheckDoubleLine,
  RiReceiptLine,
  RiShieldCheckLine,
} from "@/components/icons";
import { PageHeader } from "@/components/layout/PageHeader";
import { PageShell } from "@/components/layout/PageShell";
import { IconTile } from "@/components/ui/IconTile";

const STEPS = [
  {
    icon: RiShieldCheckLine,
    title: "Inicia sesión",
    text: "Con tu usuario, contraseña y código de verificación.",
  },
  {
    icon: RiCheckDoubleLine,
    title: "Elige y confirma",
    text: "Revisa tu selección antes de enviarla. El voto no se puede cambiar.",
  },
  {
    icon: RiReceiptLine,
    title: "Guarda tu comprobante",
    text: "Prueba que tu papeleta quedó registrada, sin revelar tu voto.",
  },
];

export default function HomePage() {
  return (
    <PageShell>
      <PageHeader
        eyebrow="Plataforma oficial de votación"
        title="Elecciones"
        description="Consulta las elecciones abiertas y emite tu voto de forma secreta y verificable."
      />
      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-8 px-4 py-8 sm:px-6 sm:py-10 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <ElectionList />
        <aside aria-labelledby="how-to-vote">
          <h2
            id="how-to-vote"
            className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.14em] text-muted"
          >
            <span className="h-px w-8 bg-royal-700" aria-hidden />
            ¿Cómo votar?
          </h2>
          <ol className="mt-4 divide-y divide-line border-y border-line">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="reveal flex items-start gap-4 py-4"
                style={{ "--i": index + 1 } as React.CSSProperties}
              >
                <IconTile icon={step.icon} />
                <div className="text-sm">
                  <p className="font-semibold text-ink">
                    <span className="mr-1.5 text-subtle">{index + 1}.</span>
                    {step.title}
                  </p>
                  <p className="mt-0.5 leading-relaxed text-muted">
                    {step.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </aside>
      </main>
    </PageShell>
  );
}
