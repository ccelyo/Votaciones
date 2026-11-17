// Obtiene un JWT por cada usuario sembrado (login + MFA) y valida el entorno.
// Se ejecuta en setup(), antes de la ventana de medición. Todas sus peticiones
// llevan el tag phase:setup para excluirlas de los resultados.
//
// Importante: auth_me.js usa discardResponseBodies:true para la fase de carga.
// Esa opción también vacía el body de las peticiones de setup(), por eso aquí
// cada petición pide responseType:'text', que la anula solo para ella.

import http from 'k6/http';
import { cfg } from './config.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SNIPPET = 300;

function header(res, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(res.headers || {})) {
    if (key.toLowerCase() === wanted) return res.headers[key];
  }
  return undefined;
}

/** Descripción de una respuesta para los mensajes de error (nunca incluye el payload enviado). */
function describe(method, res) {
  const body = typeof res.body === 'string' ? res.body.slice(0, SNIPPET) : String(res.body);
  return (
    `${method} ${res.url || '(sin URL)'} -> HTTP ${res.status}` +
    (res.error ? `, error de conexión: ${res.error} (código ${res.error_code})` : '') +
    `, content-type: ${header(res, 'Content-Type') || '(ninguno)'}` +
    `, respuesta: ${body === '' || body === 'null' ? '(vacía)' : body}`
  );
}

function fail(step, method, res, hint) {
  throw new Error(`[setup] ${step} falló. ${describe(method, res)}${hint ? `. ${hint}` : ''}`);
}

function hintFor(res) {
  if (res.status === 0) return 'No hubo respuesta: revisa BASE_URL, que el Nodo A esté levantado, el firewall y Tailscale';
  if (res.status === 429) return 'El límite de tasa del Gateway sigue activo: despliega con performance-tests/deploy/docker-compose.perf.yml';
  if (res.status === 401) return 'Credenciales o código MFA incorrectos (LAB_PASSWORD / LAB_MFA_CODE) o usuario no sembrado';
  if (res.status === 404) return 'Ruta inexistente: ¿BASE_URL apunta al Gateway (puerto 8088) y no a otro servicio?';
  if (res.status === 422) return 'Identity rechazó el cuerpo de la petición';
  if (res.status >= 500) return 'Error del servidor: revisa los logs de gateway e identity en el Nodo A';
  return '';
}

function jsonField(step, method, res, field) {
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    fail(step, method, res, 'La respuesta no es JSON');
  }
  if (!parsed || typeof parsed[field] !== 'string' || parsed[field] === '') {
    fail(step, method, res, `La respuesta no contiene "${field}"`);
  }
  return parsed[field];
}

function post(path, body) {
  return http.post(`${cfg.baseUrl}${path}`, JSON.stringify(body), {
    headers: JSON_HEADERS,
    tags: { phase: 'setup' },
    timeout: '30s',
    responseType: 'text',
  });
}

function login(username) {
  const first = post('/api/auth/login', { username, password: cfg.password() });
  if (first.status !== 200) fail(`login de ${username}`, 'POST', first, hintFor(first));
  const challengeId = jsonField(`login de ${username}`, 'POST', first, 'challenge_id');

  const second = post('/api/auth/login/mfa', { challenge_id: challengeId, code: cfg.mfaCode() });
  if (second.status !== 200) fail(`MFA de ${username}`, 'POST', second, hintFor(second));
  return jsonField(`MFA de ${username}`, 'POST', second, 'access_token');
}

/** Devuelve la lista de tokens (usuarios × TOKENS_PER_USER) ya verificados. */
export function mintTokens() {
  const tokens = [];
  for (const username of cfg.users) {
    for (let i = 0; i < cfg.tokensPerUser; i++) tokens.push(login(username));
  }
  console.log(`[setup] ${tokens.length} tokens obtenidos (login + MFA) de ${cfg.users.length} usuarios`);

  // Pre-vuelo: cada token debe dar 200 en el endpoint probado y el limitador
  // de tasa del Gateway debe estar desactivado (RateLimit-Limit: 0).
  for (const token of tokens) {
    const res = http.get(`${cfg.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      tags: { phase: 'setup' },
      timeout: '30s',
      responseType: 'text',
    });
    if (res.status !== 200) fail('pre-vuelo GET /api/auth/me', 'GET', res, hintFor(res));
    if (header(res, 'RateLimit-Limit') !== '0') {
      fail(
        'pre-vuelo GET /api/auth/me',
        'GET',
        res,
        `RateLimit-Limit=${header(res, 'RateLimit-Limit')} (se esperaba 0): el límite de tasa sigue activo. ` +
          'Despliega con performance-tests/deploy/docker-compose.perf.yml',
      );
    }
  }
  console.log('[setup] pre-vuelo OK: /api/auth/me = 200 con todos los tokens y límite de tasa desactivado');
  return tokens;
}
