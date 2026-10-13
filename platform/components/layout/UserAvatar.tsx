"use client";

import { Avatar, Style } from "@dicebear/core";
import shadows from "@dicebear/styles/shadows.json";
import { useMemo } from "react";

import type { User } from "@/lib/types/user";

// "Shadows" de DiceBear (CC0) en duotono de la marca. Se genera en el
// navegador: ningún dato del usuario sale hacia un servicio externo.
const style = new Style(shadows);

type UserAvatarProps = {
  user: User;
  size: number;
  className?: string;
};

export function UserAvatar({ user, size, className = "" }: UserAvatarProps) {
  const src = useMemo(
    () =>
      new Avatar(style, {
        // Semilla opaca y estable: el id, no el nombre ni el correo.
        seed: `espivota-user-${user.id}`,
        inkColor: "#0b3ea8",
        backgroundColor: "#dfe9fb",
      }).toDataUri(),
    [user.id],
  );

  return (
    // biome-ignore lint/performance/noImgElement: data URI SVG generado en el cliente
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
    />
  );
}
