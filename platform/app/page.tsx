import { ElectionList } from "@/components/election/ElectionList";
import {
  Icon,
  RiLockLine,
  RiReceiptLine,
  RiShieldCheckLine,
} from "@/components/icons";
import { PageShell } from "@/components/layout/PageShell";

const GUARANTEES = [
  { icon: RiLockLine, label: "Voto cifrado en tu navegador" },
  { icon: RiShieldCheckLine, label: "Token anónimo con firma ciega" },
  { icon: RiReceiptLine, label: "Recibo para verificar tu papeleta" },
];

export default function HomePage() {
  return (
    <PageShell>
      <section className="band">
        <div className="mx-auto w-full max-w-6xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20">
          <p
            className="reveal text-xs font-bold uppercase tracking-[0.18em] text-white/70"
            style={{ "--i": 0 } as React.CSSProperties}
          >
            Plataforma de votación
          </p>
          <h1
            className="reveal font-display mt-4 max-w-2xl text-4xl font-extrabold leading-[1.05] sm:text-6xl"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            Tu voto es secreto.
            <br />
            <span className="text-royal-100">Y puedes comprobarlo.</span>
          </h1>
          <p
            className="reveal mt-5 max-w-xl text-base leading-relaxed text-white/80 sm:text-lg"
            style={{ "--i": 2 } as React.CSSProperties}
          >
            Elige, confirma y guarda tu recibo. Nadie, ni siquiera quien
            administra la elección, puede unir tu identidad con tu voto.
          </p>
          <ul
            className="reveal mt-8 flex flex-wrap gap-2.5"
            style={{ "--i": 3 } as React.CSSProperties}
          >
            {GUARANTEES.map((item) => (
              <li
                key={item.label}
                className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3.5 py-1.5 text-sm font-bold backdrop-blur-sm"
              >
                <Icon icon={item.icon} size={16} />
                {item.label}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <main className="relative z-10 mx-auto -mt-12 w-full max-w-6xl flex-1 px-4 pb-16 sm:px-6">
        <ElectionList />
      </main>
    </PageShell>
  );
}
