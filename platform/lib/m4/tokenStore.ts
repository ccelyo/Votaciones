// Guardado en memoria del token anónimo (M4).
// El token NUNCA se persiste: ni localStorage, ni cookies, ni URL.
// Vive solo en este módulo durante la sesión de votación y se borra al enviar.

let tokenEnMemoria: string | null = null;
let eleccionEnMemoria: string | null = null;

export function guardarTokenAnonimo(electionId: string, sobreToken: string): void {
  tokenEnMemoria = sobreToken;
  eleccionEnMemoria = electionId;
}

export function obtenerTokenAnonimo(electionId: string): string | null {
  if (eleccionEnMemoria !== electionId) return null;
  return tokenEnMemoria;
}

export function borrarTokenAnonimo(): void {
  tokenEnMemoria = null;
  eleccionEnMemoria = null;
}
