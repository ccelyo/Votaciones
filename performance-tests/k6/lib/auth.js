// Obtiene un JWT por cada usuario sembrado (login + MFA) y valida el entorno.
// Se ejecuta en setup(), antes de la ventana de medición. Todas sus peticiones
// llevan el tag phase:setup para excluirlas de los resultados.

import http from 'k6/http';
import { cfg } from './config.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function header(res, name) {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(res.headers)) {
    if (key.toLowerCase() === wanted) return res.headers[key];
  }
  return undefined;
}

function post(path, body) {
  return http.post(`${cfg.baseUrl}${path}`, JSON.stringify(body), {
    headers: JSON_HEADERS,
    tags: { phase: 'setup' },
    timeout: '30s',
  });
}

function login(username) {
  const first = post('/api/auth/login', { username, password: cfg.password() });
  if (first.status !== 200) {
    throw new Error(`login de ${username} falló: HTTP ${first.status} (¿límite de tasa activo? ¿seed cargado?)`);
  }
  const second = post('/api/auth/login/mfa', {
    challenge_id: first.json('challenge_id'),
    code: cfg.mfaCode(),
  });
  if (second.status !== 200) {
    throw new Error(`MFA de ${username} falló: HTTP ${second.status}`);
  }
  return second.json('access_token');
}

/** Devuelve la lista de tokens (usuarios × TOKENS_PER_USER) ya verificados. */
export function mintTokens() {
  const tokens = [];
  for (const username of cfg.users) {
    for (let i = 0; i < cfg.tokensPerUser; i++) tokens.push(login(username));
  }

  // Pre-vuelo: cada token debe dar 200 en el endpoint probado y el limitador
  // de tasa del Gateway debe estar desactivado (RateLimit-Limit: 0).
  for (const token of tokens) {
    const res = http.get(`${cfg.baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      tags: { phase: 'setup' },
      timeout: '30s',
    });
    if (res.status !== 200) {
      throw new Error(`pre-vuelo: GET /api/auth/me devolvió HTTP ${res.status}`);
    }
    if (header(res, 'RateLimit-Limit') !== '0') {
      throw new Error(
        'pre-vuelo: el límite de tasa del Gateway sigue activo (RateLimit-Limit != 0). ' +
          'Despliega con performance-tests/deploy/docker-compose.perf.yml',
      );
    }
  }
  return tokens;
}
