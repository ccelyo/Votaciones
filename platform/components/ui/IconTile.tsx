import { Icon, type RemixiconComponentType } from "@/components/icons";

/** Ícono en recuadro blanco con borde fino (lenguaje visual de Espivota). */
export function IconTile({
  icon,
  size = "md",
}: {
  icon: RemixiconComponentType;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-md border border-line bg-white text-royal-700 ${
        size === "sm" ? "size-8" : "size-10"
      }`}
    >
      <Icon icon={icon} size={size === "sm" ? 16 : 20} />
    </span>
  );
}
