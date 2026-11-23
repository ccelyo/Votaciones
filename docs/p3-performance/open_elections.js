// Prototipo 3 – desempeño de "Ver elecciones abiertas" sobre la versión final.
// Misma funcionalidad y el mismo modelo del Laboratorio 6 (carga con sleep de 1 s),
// pero la petición entra por el borde real:
//   k6 --HTTPS--> WAF (TLS + ModSecurity) --> Gateway (TLS) --> Identity --> PostgreSQL
//
//   k6 run -e BASE_URL=https://localhost:8088 -e VUS=50 -e DURATION=30s open_elections.js
import http from 'k6/http';
import { sleep, check } from 'k6';
import { Counter } from 'k6/metrics';

const status200 = new Counter('status_200');
const status403 = new Counter('status_403');
const status429 = new Counter('status_429');
const status5xx = new Counter('status_5xx');
const status0 = new Counter('status_0_network');
const statusOther = new Counter('status_other');

const BASE_URL = __ENV.BASE_URL || 'https://localhost:8088';

export const options = {
  insecureSkipTLSVerify: true,
  vus: Number(__ENV.VUS || 1),
  duration: __ENV.DURATION || '30s',
  userAgent: 'espivota-perf/p3',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  const res = http.get(`${BASE_URL}/api/elections/open`, {
    headers: { Accept: 'application/json' },
    timeout: '30s',
  });

  if (res.status === 200) status200.add(1);
  else if (res.status === 403) status403.add(1);
  else if (res.status === 429) status429.add(1);
  else if (res.status >= 500) status5xx.add(1);
  else if (res.status === 0) status0.add(1);
  else statusOther.add(1);

  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}

function count(data, name) {
  const metric = data.metrics[name];
  return metric && metric.values && metric.values.count ? metric.values.count : 0;
}

export function handleSummary(data) {
  const dur = data.metrics.http_req_duration.values;
  const reqs = data.metrics.http_reqs.values;
  const failed = data.metrics.http_req_failed.values;
  const iterations = data.metrics.iterations ? data.metrics.iterations.values.count : 0;
  const result = {
    scenario: 'p3-open-elections',
    vus: Number(__ENV.VUS || 1),
    duration_s: parseInt(String(__ENV.DURATION || '30s'), 10),
    base_url: BASE_URL,
    requests: reqs.count,
    iterations,
    throughput_rps: reqs.rate,
    error_rate: failed.rate,
    latency_ms: {
      avg: dur.avg,
      min: dur.min,
      p50: dur.med,
      p90: dur['p(90)'],
      p95: dur['p(95)'],
      p99: dur['p(99)'],
      max: dur.max,
    },
    status: {
      '200': count(data, 'status_200'),
      '403': count(data, 'status_403'),
      '429': count(data, 'status_429'),
      '5xx': count(data, 'status_5xx'),
      '0': count(data, 'status_0_network'),
      other: count(data, 'status_other'),
    },
  };

  const line =
    `VUs=${result.vus} ${result.throughput_rps.toFixed(2)} req/s ` +
    `avg=${result.latency_ms.avg.toFixed(1)} ms p95=${result.latency_ms.p95.toFixed(1)} ms ` +
    `errores=${(result.error_rate * 100).toFixed(2)} %\n`;

  const out = {};
  out.stdout = line;
  if (__ENV.SUMMARY_FILE) out[__ENV.SUMMARY_FILE] = JSON.stringify(result, null, 2);
  return out;
}
