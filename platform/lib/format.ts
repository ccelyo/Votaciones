const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

/** "Cierra en 3 días", "Cierra en 5 horas"… o null si la fecha no es válida. */
export function formatClosesIn(value: string, now = Date.now()): string | null {
  const diff = new Date(value).getTime() - now;
  if (Number.isNaN(diff)) return null;
  if (diff <= 0) return "Cerrada";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `Cierra en ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Cierra en ${hours} ${hours === 1 ? "hora" : "horas"}`;
  const days = Math.round(hours / 24);
  return `Cierra en ${days} días`;
}
