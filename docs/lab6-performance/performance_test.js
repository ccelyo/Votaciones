// Laboratorio 6 – Opción 2 (k6). Funcionalidad: "Ver elecciones abiertas".
// Flujo: Front-end web -> API Gateway (/api/elections/open) -> Identity -> PostgreSQL.
//
//   k6 run performance_test.js                                # 1 VU, 30 s (paso e.1)
//   k6 run -e VUS=50 performance_test.js                       # 50 VUs   (paso e.3)
//   k6 run -e BASE_URL=http://<IP_DEL_NODO>:8088 performance_test.js  # desde otro nodo
import http from 'k6/http';
import { sleep, check } from 'k6';
import { Counter } from 'k6/metrics';

// Conteo de códigos de estado (no forma parte del script base; sirve para
// distinguir errores del sistema (5xx) de errores de red del generador (status 0)).
const status200 = new Counter('status_200');
const status5xx = new Counter('status_5xx');
const status0 = new Counter('status_0_network');
const statusOther = new Counter('status_other');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8088';

export const options = {
  vus: Number(__ENV.VUS || 1),          // número de usuarios virtuales concurrentes
  duration: __ENV.DURATION || '30s',    // duración de la prueba
};

export default function () {
  const res = http.get(`${BASE_URL}/api/elections/open`);

  if (res.status === 200) status200.add(1);
  else if (res.status >= 500) status5xx.add(1, { code: String(res.status) });
  else if (res.status === 0) status0.add(1);
  else statusOther.add(1, { code: String(res.status) });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
