type LogoProps = {
  showWordmark?: boolean;
  compactOnMobile?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
};

const sizeMap = {
  sm: 32,
  md: 36,
  lg: 44,
} as const;

/** Papeleta con check entrando a una urna. */
export function LogoIcon({
  size = 36,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`block shrink-0 flex-none ${className ?? ""}`}
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="10" className="logo-mark" />

      {/* Papeleta */}
      <rect x="13" y="7" width="14" height="15" rx="2" className="logo-bar" />
      {/* Check recortado sobre la papeleta */}
      <polygon
        points="16.8,15.4 18.3,14 20.2,15.9 23.7,11.8 25.2,13.2 20.2,19"
        className="logo-mark"
      />

      {/* Urna con ranura */}
      <rect x="9" y="24" width="22" height="8" rx="2.5" className="logo-bar" />
      <rect x="13" y="27" width="14" height="2" rx="1" className="logo-mark" />
    </svg>
  );
}

export function Logo({
  showWordmark = true,
  compactOnMobile = false,
  size = "md",
  className = "",
}: LogoProps) {
  const iconSize = sizeMap[size];

  return (
    <span className={`inline-flex min-w-0 items-center gap-3 ${className}`}>
      <LogoIcon size={iconSize} />
      {showWordmark ? (
        <span
          className={`truncate font-semibold tracking-tight text-foreground ${
            size === "lg" ? "text-lg" : "text-base"
          } ${compactOnMobile ? "hidden sm:inline" : ""}`}
        >
          Votaciones
        </span>
      ) : null}
    </span>
  );
}
