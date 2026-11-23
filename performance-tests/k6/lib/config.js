// Configuración del escenario, toda por variables de entorno (-e NOMBRE=valor).
// Las credenciales NO tienen valor por defecto: se pasan al ejecutar.

function int(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} debe ser un entero >= 0 (recibido: ${raw})`);
  }
  return value;
}

function required(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

// MODE=level  -> nivel de carga medido (VUS = 1, 50, 200, 500, 2000).
// MODE=warmup -> calentamiento previo a la campaña; sus resultados se descartan.
const mode = __ENV.MODE || 'level';
if (mode !== 'level' && mode !== 'warmup') throw new Error('MODE debe ser level o warmup');

const defaults =
  mode === 'warmup'
    ? { vus: 50, rampS: 10, holdS: 50 }
    : { vus: 1, rampS: 30, holdS: 120 };

export const cfg = {
  mode,
  baseUrl: (__ENV.BASE_URL || '').replace(/\/+$/, ''),
  vus: int('VUS', defaults.vus),
  // Ramp-up y carga sostenida iguales para todos los niveles.
  rampS: int('RAMP_S', defaults.rampS),
  holdS: int('HOLD_S', defaults.holdS),
  timeout: __ENV.TIMEOUT || '30s',
  tokensPerUser: Math.max(1, int('TOKENS_PER_USER', 1)),
  summaryFile: __ENV.SUMMARY_FILE || `summary-${mode}.json`,
  // Usuarios sembrados en identity/seed_dev_users.sql.
  users: [
    ...Array.from({ length: 4 }, (_, i) => `admin${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `votante${i + 1}`),
  ],
  password: () => required('LAB_PASSWORD'),
  mfaCode: () => required('LAB_MFA_CODE'),
};

if (!cfg.baseUrl) throw new Error('Falta BASE_URL (p. ej. http://<IP_NODO_A>:8088)');
