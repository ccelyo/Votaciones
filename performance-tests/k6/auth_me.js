// Prueba de rendimiento de GET /api/auth/me a través del API Gateway.
//
// Modelo de carga CERRADA y SIN think time: N VUs concurrentes, cada uno lanza
// la siguiente petición en cuanto recibe la respuesta de la anterior (no hay
// sleep). La concurrencia es constante e igual a N; el throughput es lo que el
// sistema logre sostener.
//
// Un nivel = un proceso k6: ramp-up de RAMP_S segundos (0 -> N) y carga
// sostenida de HOLD_S segundos (N). Cada petición se etiqueta con la fase
// (ramp | sustain) y solo `sustain` se reporta.
//
// Uso (ver ../README.md):
//   k6 run -e BASE_URL=http://<IP_A>:8088 -e VUS=200 -e LAB_PASSWORD=... -e LAB_MFA_CODE=... auth_me.js

import http from 'k6/http';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';

import { cfg } from './lib/config.js';
import { mintTokens } from './lib/auth.js';

const status2xx = new Counter('status_2xx');
const status429 = new Counter('status_429');
const status4xx = new Counter('status_4xx'); // 4xx distintos de 429
const status5xx = new Counter('status_5xx');
const status0 = new Counter('status_0'); // timeout o error de red

// Los submetrics solo aparecen en el resumen si hay un threshold que los
// referencie. Estos nunca fallan: aquí no se aborta la prueba en sobrecarga.
const SUSTAIN = '{phase:sustain}';
const observe = (metric, expr) => ({ [`${metric}${SUSTAIN}`]: [expr] });

export const options = {
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: `${cfg.rampS}s`, target: cfg.vus },
        { duration: `${cfg.holdS}s`, target: cfg.vus },
      ],
      gracefulRampDown: '0s',
      gracefulStop: '35s', // deja terminar peticiones en vuelo (timeout 30 s)
    },
  },
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  setupTimeout: '300s',
  thresholds: {
    ...observe('http_req_duration', 'max>=0'),
    ...observe('http_reqs', 'count>=0'),
    ...observe('status_2xx', 'count>=0'),
    ...observe('status_429', 'count>=0'),
    ...observe('status_4xx', 'count>=0'),
    ...observe('status_5xx', 'count>=0'),
    ...observe('status_0', 'count>=0'),
  },
};

export function setup() {
  return { tokens: mintTokens() };
}

export default function (data) {
  const elapsedMs = Date.now() - exec.scenario.startTime;
  const phase = elapsedMs < cfg.rampS * 1000 ? 'ramp' : 'sustain';

  // Identidad del VU: reparto circular entre los tokens (14 usuarios × TOKENS_PER_USER).
  const token = data.tokens[(exec.vu.idInTest - 1) % data.tokens.length];

  const res = http.get(`${cfg.baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { phase },
    timeout: cfg.timeout,
  });

  const tags = { phase };
  if (res.status === 0) status0.add(1, tags);
  else if (res.status >= 500) status5xx.add(1, tags);
  else if (res.status === 429) status429.add(1, tags);
  else if (res.status >= 400) status4xx.add(1, tags);
  else if (res.status >= 200 && res.status < 300) status2xx.add(1, tags);
  // Sin sleep: carga cerrada.
}

function values(data, name) {
  const metric = data.metrics[`${name}${SUSTAIN}`];
  return metric ? metric.values : {};
}

export function handleSummary(data) {
  const dur = values(data, 'http_req_duration');
  const count = (name) => values(data, name).count || 0;
  const total = values(data, 'http_reqs').count || 0;
  const ok = count('status_2xx');

  // Sin peticiones en la fase sostenida (setup() falló o la prueba se abortó): no
  // se escribe resumen, para que un resultado vacío no pase por una corrida válida.
  if (total === 0) {
    return {
      stdout: `[${cfg.mode}] VUs=${cfg.vus}: sin peticiones en la fase sostenida; no se escribió ${cfg.summaryFile}\n`,
    };
  }

  const result = {
    mode: cfg.mode,
    vus: cfg.vus,
    ramp_s: cfg.rampS,
    hold_s: cfg.holdS,
    tokens: cfg.users.length * cfg.tokensPerUser,
    base_url_host: cfg.baseUrl.replace(/^https?:\/\//, '').split(/[:/]/)[0],
    started_at: new Date(Date.now() - (cfg.rampS + cfg.holdS) * 1000).toISOString(),
    sustain: {
      requests: total,
      throughput_rps: total / cfg.holdS,
      ok_rps: ok / cfg.holdS,
      error_rate: total ? (total - ok) / total : 0,
      status: {
        '2xx': ok,
        '429': count('status_429'),
        '4xx': count('status_4xx'),
        '5xx': count('status_5xx'),
        '0': count('status_0'),
      },
      latency_ms: {
        avg: dur.avg,
        min: dur.min,
        p50: dur.med,
        p90: dur['p(90)'],
        p95: dur['p(95)'],
        p99: dur['p(99)'],
        max: dur.max,
      },
    },
  };

  const line =
    `[${cfg.mode}] VUs=${cfg.vus} sustain: ${result.sustain.throughput_rps.toFixed(1)} req/s, ` +
    `p95=${(dur['p(95)'] || 0).toFixed(1)} ms, errores=${(result.sustain.error_rate * 100).toFixed(2)} %\n`;

  return {
    [cfg.summaryFile]: JSON.stringify(result, null, 2),
    stdout: line,
  };
}
