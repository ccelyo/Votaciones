#!/usr/bin/env python3
"""Genera la tabla de resultados (results.md) y la curva de desempeño (curva_desempeno.svg)
a partir de los resúmenes JSON de k6 en results/.

    python3 build_report.py

Solo usa la biblioteca estándar.
"""
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
import sys

# Uso: python3 build_report.py [carpeta_resultados] [svg_salida] [subtítulo]
RES = HERE / (sys.argv[1] if len(sys.argv) > 1 else "results")
SVG_OUT = HERE / (sys.argv[2] if len(sys.argv) > 2 else "curva_desempeno.svg")
SUBTITLE = sys.argv[3] if len(sys.argv) > 3 else "Sin límites de recursos por contenedor"


def load(path):
    m = json.loads(path.read_text())["metrics"]
    d, f, r = m["http_req_duration"], m["http_req_failed"], m["http_reqs"]
    total = f["passes"] + f["fails"]
    return {
        "avg": d["avg"], "med": d["med"], "p95": d["p(95)"], "max": d["max"],
        "fail": 100.0 * f["value"], "reqs": r["count"], "rps": r["rate"],
        "failed": f["passes"], "total": total,
    }


def runs():
    """{vus: [run, ...]}.

    Prioriza las corridas con calentamiento (warm*/). Los niveles que no se
    repitieron en caliente (300–2000 VUs) se toman del barrido en frío
    (main/ y rep*/); nunca se mezclan ambos tipos en un mismo nivel.
    """
    def collect(dirs):
        out = {}
        for d in dirs:
            for p in d.glob("vus_*.json"):
                v = int(p.stem.split("_")[1])
                out.setdefault(v, []).append({"src": d.name, **load(p)})
        return out
    warm = collect(sorted(RES.glob("warm*")))
    cold = collect([d for d in [RES / "main", RES / "high"] if d.exists()] + sorted(RES.glob("rep*")))
    merged = {v: warm.get(v) or cold[v] for v in set(warm) | set(cold)}  # high/: niveles sin repetición
    return dict(sorted(merged.items()))


def table(data):
    rows = ["| VUs | Corrida | avg (ms) | mediana (ms) | p95 (ms) | Peticiones | Throughput (req/s) | http_req_failed |",
            "|---:|:---|---:|---:|---:|---:|---:|---:|"]
    for v, rs in data.items():
        for r in rs:
            rows.append(f"| {v} | {r['src']} | {r['avg']:.0f} | {r['med']:.0f} | {r['p95']:.0f} | "
                        f"{r['total']} | {r['rps']:.1f} | {r['fail']:.2f} % |")
    return "\n".join(rows)


def summary(data):
    rows = ["| VUs | Corridas | avg (ms, media) | Throughput (req/s, media) | Error % (media) | Corridas sin errores |",
            "|---:|---:|---:|---:|---:|---:|"]
    agg = {}
    for v, rs in data.items():
        n = len(rs)
        a = {"avg": sum(r["avg"] for r in rs) / n, "rps": sum(r["rps"] for r in rs) / n,
             "fail": sum(r["fail"] for r in rs) / n, "ok": sum(r["fail"] == 0 for r in rs), "n": n}
        agg[v] = a
        rows.append(f"| {v} | {n} | {a['avg']:.0f} | {a['rps']:.1f} | {a['fail']:.1f} % | {a['ok']}/{n} |")
    return "\n".join(rows), agg


def svg(agg, data, knee):
    W, H, L, R, T, B = 900, 560, 80, 80, 50, 70
    pw, ph = W - L - R, H - T - B
    xs = list(agg)
    xmin, xmax = math.log10(1), math.log10(max(xs))
    X = lambda v: L + (math.log10(v) - xmin) / (xmax - xmin) * pw
    ymin, ymax = 0, 5  # log10 ms: 1 ms .. 100 000 ms
    Y = lambda ms: T + ph - (math.log10(max(ms, 1)) - ymin) / (ymax - ymin) * ph
    E = lambda pct: T + ph - pct / 100 * ph
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
         'font-family="Helvetica, Arial, sans-serif" font-size="12">',
         f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
         f'<text x="{W/2}" y="26" text-anchor="middle" font-size="16" font-weight="bold">'
         'Curva de desempeño – GET /api/elections/open (Gateway → Identity → PostgreSQL)</text>',
         f'<text x="{W/2}" y="44" text-anchor="middle" font-size="12" fill="#4b5563">{SUBTITLE}</text>']
    # rejilla y ejes
    for e in range(ymin, ymax + 1):
        y = T + ph - (e - ymin) / (ymax - ymin) * ph
        s.append(f'<line x1="{L}" x2="{L+pw}" y1="{y}" y2="{y}" stroke="#e5e7eb"/>')
        s.append(f'<text x="{L-8}" y="{y+4}" text-anchor="end">{10**e:,} ms</text>')
    for pct in (0, 25, 50, 75, 100):
        s.append(f'<text x="{L+pw+8}" y="{E(pct)+4}" fill="#b91c1c">{pct} %</text>')
    for v in xs:
        s.append(f'<line x1="{X(v)}" x2="{X(v)}" y1="{T}" y2="{T+ph}" stroke="#f3f4f6"/>')
        dy = 18 if xs.index(v) % 2 == 0 else 32  # alterna la altura para que no se solapen
        s.append(f'<text x="{X(v)}" y="{T+ph+dy}" text-anchor="middle">{v}</text>')
    s.append(f'<rect x="{L}" y="{T}" width="{pw}" height="{ph}" fill="none" stroke="#9ca3af"/>')
    s.append(f'<text x="{L+pw/2}" y="{H-14}" text-anchor="middle">Usuarios virtuales concurrentes (VUs, escala log)</text>')
    s.append(f'<text transform="translate(20,{T+ph/2}) rotate(-90)" text-anchor="middle">'
             'http_req_duration avg (ms, escala log)</text>')
    s.append(f'<text transform="translate({W-18},{T+ph/2}) rotate(90)" text-anchor="middle" fill="#b91c1c">'
             'http_req_failed (%)</text>')
    # rodilla
    kx = X(knee)
    s.append(f'<line x1="{kx}" x2="{kx}" y1="{T}" y2="{T+ph}" stroke="#7c3aed" stroke-width="2" stroke-dasharray="6 4"/>')
    s.append(f'<text x="{kx+6}" y="{T+16}" fill="#7c3aed" font-weight="bold">Rodilla ≈ {knee} VUs</text>')
    # corridas individuales (puntos tenues)
    for v, rs in data.items():
        for r in rs:
            s.append(f'<circle cx="{X(v)}" cy="{Y(r["avg"])}" r="3" fill="#2563eb" fill-opacity="0.3"/>')
            s.append(f'<circle cx="{X(v)}" cy="{E(r["fail"])}" r="3" fill="#dc2626" fill-opacity="0.3"/>')
    # series medias
    lat = " ".join(f"{X(v)},{Y(a['avg'])}" for v, a in agg.items())
    err = " ".join(f"{X(v)},{E(a['fail'])}" for v, a in agg.items())
    s.append(f'<polyline points="{lat}" fill="none" stroke="#2563eb" stroke-width="2.5"/>')
    s.append(f'<polyline points="{err}" fill="none" stroke="#dc2626" stroke-width="2.5" stroke-dasharray="2 0"/>')
    for v, a in agg.items():
        s.append(f'<circle cx="{X(v)}" cy="{Y(a["avg"])}" r="4.5" fill="#2563eb"/>')
        s.append(f'<circle cx="{X(v)}" cy="{E(a["fail"])}" r="4.5" fill="#dc2626"/>')
    # leyenda
    lx, ly = L + 14, T + 14
    s.append(f'<rect x="{lx-6}" y="{ly-12}" width="300" height="48" fill="#fff" stroke="#d1d5db"/>')
    s.append(f'<line x1="{lx}" x2="{lx+24}" y1="{ly}" y2="{ly}" stroke="#2563eb" stroke-width="2.5"/>'
             f'<text x="{lx+30}" y="{ly+4}">Tiempo de respuesta promedio (media de corridas)</text>')
    s.append(f'<line x1="{lx}" x2="{lx+24}" y1="{ly+22}" y2="{ly+22}" stroke="#dc2626" stroke-width="2.5"/>'
             f'<text x="{lx+30}" y="{ly+26}">Tasa de error (media de corridas)</text>')
    s.append("</svg>")
    return "\n".join(s)


def main():
    data = runs()
    sum_md, agg = summary(data)
    # Rodilla: último nivel en el que TODAS las corridas tuvieron 0 % de error.
    clean = [v for v, a in agg.items() if a["ok"] == a["n"]]
    first_bad = min(v for v, a in agg.items() if a["ok"] < a["n"])
    knee = max(v for v in clean if v < first_bad)
    SVG_OUT.write_text(svg(agg, data, knee))
    (RES / "results.md").write_text(
        "# Resultados k6 (generado por build_report.py)\n\n"
        f"Rodilla calculada: **{knee} VUs** (último nivel con 0 % de error en todas las corridas; "
        f"primer nivel con errores: {first_bad} VUs).\n\n## Resumen por nivel\n\n{sum_md}\n\n"
        f"## Todas las corridas\n\n{table(data)}\n")
    print(sum_md)
    print(f"\nRodilla: {knee} VUs (primer nivel con errores: {first_bad})")


if __name__ == "__main__":
    main()
