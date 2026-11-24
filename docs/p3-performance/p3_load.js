// Prototipo 3 – Análisis general de desempeño con k6.
// Mide el camino completo con todos los controles de seguridad activos:
//   cliente ─HTTPS─► WAF (TLS + OWASP CRS) ─mTLS─► Gateway (JWT, sesión, rol) ─mTLS─► Identity ─► PostgreSQL
//
//   ROUTE=open  GET /api/elections/open  (pública: WAF + Gateway + Identity + BD)
//   ROUTE=me    GET /api/auth/me         (autenticada: además JWT RS256 y sesión vigente en Identity)
//
//   k6 run -e ROUTE=open -e VUS=50 p3_load.js
//   k6 run -e ROUTE=me   -e VUS=50 p3_load.js
//
// Mismo modelo que el laboratorio 6: N VUs constantes, 1 s de espera entre peticiones.
// El certificado del WAF lo firma el certificado de autorización público local, que
// k6 no permite cargar como raíz: por eso se omite la verificación TLS en el cliente.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'https://localhost:8088').replace(/\/+$/, '');
const ROUTE = __ENV.ROUTE || 'open';
const PASSWORD = __ENV.LAB_PASSWORD || 'prueba123';
const MFA = __ENV.LAB_MFA_CODE || '123456';

const s2xx = new Counter('status_2xx');
const s4xx = new Counter('status_4xx');
const s5xx = new Counter('status_5xx');
const s0 = new Counter('status_0');

export const options = {
  vus: Number(__ENV.VUS || 1),
  duration: __ENV.DURATION || '30s',
  insecureSkipTLSVerify: true,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
  // Submétricas por ruta (excluyen los logins del setup); nunca fallan.
  thresholds: { [`http_req_duration{route:${ROUTE}}`]: ['max>=0'], [`http_req_failed{route:${ROUTE}}`]: ['rate>=0'], [`http_reqs{route:${ROUTE}}`]: ['count>=0'] },
};

function login(user) {
  const h = { headers: { 'Content-Type': 'application/json' }, tags: { phase: 'setup' } };
  const a = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ username: user, password: PASSWORD }), h);
  if (a.status !== 200) throw new Error(`login ${user}: HTTP ${a.status}`);
  const b = http.post(`${BASE_URL}/api/auth/login/mfa`, JSON.stringify({ challenge_id: a.json('challenge_id'), code: MFA }), h);
  if (b.status !== 200) throw new Error(`MFA ${user}: HTTP ${b.status}`);
  return b.json('access_token');
}

export function setup() {
  if (ROUTE !== 'me') return { tokens: [] };
  // TOKENS (separados por coma) evita repetir el login en cada corrida: el Gateway
  // limita el login a 20 peticiones/min por IP aunque el límite general esté desactivado.
  if (__ENV.TOKENS) return { tokens: __ENV.TOKENS.split(',') };
  return { tokens: Array.from({ length: 10 }, (_, i) => login(`votante${i + 1}`)) };
}

export default function (data) {
  const res =
    ROUTE === 'me'
      ? http.get(`${BASE_URL}/api/auth/me`, {
          headers: { Authorization: `Bearer ${data.tokens[__VU % data.tokens.length]}` },
          tags: { route: 'me' },
        })
      : http.get(`${BASE_URL}/api/elections/open`, { tags: { route: 'open' } });

  if (res.status === 0) s0.add(1);
  else if (res.status >= 500) s5xx.add(1);
  else if (res.status >= 400) s4xx.add(1);
  else s2xx.add(1);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(1);
}
