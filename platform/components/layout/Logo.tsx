import Image from "next/image";

type LogoProps = {
  size?: number;
  showWordmark?: boolean;
  tone?: "dark" | "light";
  className?: string;
};

/** Urna con papeleta marcada + nombre de la plataforma. */
export function Logo({
  size = 36,
  showWordmark = true,
  tone = "dark",
  className = "",
}: LogoProps) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-2.5 ${className}`}>
      <Image
        src="/logo.png"
        alt=""
        width={size}
        height={size}
        priority
        className="shrink-0"
      />
      {showWordmark ? (
        <span
          className={`font-display truncate text-lg font-bold ${
            tone === "light" ? "text-white" : "text-navy-900"
          }`}
        >
          Espivota
        </span>
      ) : null}
    </span>
  );
}
