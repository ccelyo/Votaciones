// Laboratorio 6 – Opción 2 (k6), paso e.4: recorrido de carga con stages.
//   k6 run performance_test_stages.js
import http from 'k6/http';
import { sleep, check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8088';

export const options = {
  stages: [
    { duration: '30s', target: 1 },    // 1 usuario
    { duration: '30s', target: 50 },   // 50 usuarios
    { duration: '30s', target: 200 },  // 200 usuarios
    { duration: '30s', target: 500 },  // 500 usuarios
    { duration: '30s', target: 2000 }, // 2000 usuarios
    { duration: '30s', target: 0 },    // descenso (ramp-down)
  ],
};

export default function () {
  const res = http.get(`${BASE_URL}/api/elections/open`);
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
