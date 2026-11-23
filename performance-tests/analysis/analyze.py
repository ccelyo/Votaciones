#!/usr/bin/env python3
"""Resume las corridas de k6, propone el knee y genera las figuras.

Lee results/summary/runs/*.json (uno por nivel y repetición), agrupa por número
de VUs (mediana si hay repeticiones) y escribe:
  results/summary/summary.csv   tabla por nivel
  results/summary/knee.json     criterio aplicado y nivel propuesto
  results/figures/curve.png     throughput, p95 y error vs VUs (si hay matplotlib)

Uso: python performance-tests/analysis/analyze.py [--campaign ID] [--gain 0.10]
"""

import argparse
import csv
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "results" / "summary" / "runs"
SUMMARY = ROOT / "results" / "summary"
FIGURES = ROOT / "results" / "figures"


def load_runs(campaign: str | None) -> dict[int, list[dict]]:
    by_level: dict[int, list[dict]] = {}
    for path in sorted(RUNS.glob("*.json")):
        if campaign and not path.name.startswith(campaign):
            continue
        run = json.loads(path.read_text(encoding="utf-8"))
        if run.get("mode") != "level":
            continue
        by_level.setdefault(run["vus"], []).append(run)
    return by_level


def median(values: list[float]) -> float:
    return statistics.median(values)


def summarize(by_level: dict[int, list[dict]]) -> list[dict]:
    rows = []
    for vus in sorted(by_level):
        runs = by_level[vus]
        tp = [r["sustain"]["throughput_rps"] for r in runs]
        row = {
            "vus": vus,
            "reps": len(runs),
            "throughput_rps": median(tp),
            "throughput_min": min(tp),
            "throughput_max": max(tp),
            "p50_ms": median([r["sustain"]["latency_ms"]["p50"] for r in runs]),
            "p95_ms": median([r["sustain"]["latency_ms"]["p95"] for r in runs]),
            "p99_ms": median([r["sustain"]["latency_ms"]["p99"] for r in runs]),
            "max_ms": median([r["sustain"]["latency_ms"]["max"] for r in runs]),
            "error_pct": 100 * median([r["sustain"]["error_rate"] for r in runs]),
            "status_429": sum(r["sustain"]["status"]["429"] for r in runs),
            "status_5xx": sum(r["sustain"]["status"]["5xx"] for r in runs),
            "status_0": sum(r["sustain"]["status"]["0"] for r in runs),
        }
        # Ley de Little (carga cerrada sin think time): latencia media ~ VUs / throughput.
        row["little_ms"] = 1000 * vus / row["throughput_rps"] if row["throughput_rps"] else float("nan")
        rows.append(row)
    return rows


def kneedle(xs: list[float], ys: list[float]) -> int | None:
    """Índice del punto de mayor curvatura de una curva creciente y cóncava
    (Satopaa et al., 2011): máximo de y_norm - x_norm."""
    if len(xs) < 3 or max(ys) == min(ys):
        return None
    xn = [(x - xs[0]) / (xs[-1] - xs[0]) for x in xs]
    yn = [(y - min(ys)) / (max(ys) - min(ys)) for y in ys]
    diffs = [y - x for x, y in zip(xn, yn)]
    best = max(range(len(diffs)), key=diffs.__getitem__)
    return best if diffs[best] > 0 else None


def find_knee(rows: list[dict], gain_threshold: float) -> dict:
    """Criterio: el throughput deja de crecer cuando el aumento entre niveles
    consecutivos es menor que `gain_threshold` (meseta). Se reportan:
      last_efficient_vus  último nivel en que todavía crecía,
      first_saturated_vus primer nivel en la meseta (candidato a repetir 3 veces),
    y se corrobora con p95 (>=2x el del último nivel eficiente) y error (>1 %)."""
    info: dict = {"gain_threshold": gain_threshold, "levels": len(rows)}
    first_sat = None
    for prev, cur in zip(rows, rows[1:]):
        gain = cur["throughput_rps"] / prev["throughput_rps"] - 1 if prev["throughput_rps"] else 0
        cur["gain_vs_prev"] = gain
        if first_sat is None and gain < gain_threshold:
            first_sat = (prev, cur)
    rows[0]["gain_vs_prev"] = None

    peak = max(rows, key=lambda r: r["throughput_rps"])
    info["peak_throughput_rps"] = peak["throughput_rps"]
    info["peak_vus"] = peak["vus"]

    if first_sat is None:
        info["conclusion"] = "No se observó meseta: el throughput sigue creciendo en el último nivel. Hay que probar más VUs."
        info["first_saturated_vus"] = None
        info["last_efficient_vus"] = rows[-1]["vus"]
    else:
        prev, cur = first_sat
        info["last_efficient_vus"] = prev["vus"]
        info["first_saturated_vus"] = cur["vus"]
        info["corroboration"] = {
            "p95_ratio_vs_last_efficient": cur["p95_ms"] / prev["p95_ms"] if prev["p95_ms"] else None,
            "p95_at_least_2x": bool(prev["p95_ms"] and cur["p95_ms"] >= 2 * prev["p95_ms"]),
            "error_pct_at_first_saturated": cur["error_pct"],
            "error_above_1pct": cur["error_pct"] > 1,
        }
        info["conclusion"] = (
            f"El throughput deja de crecer entre {prev['vus']} y {cur['vus']} VUs. "
            f"El knee está en ese intervalo; repetir {cur['vus']} VUs al menos 3 veces y, si hace falta, "
            f"refinar con niveles intermedios (p. ej. {int((prev['vus'] * cur['vus']) ** 0.5)})."
        )

    idx = kneedle([r["vus"] for r in rows], [r["throughput_rps"] for r in rows])
    info["kneedle_vus"] = rows[idx]["vus"] if idx is not None else None
    return info


def write_csv(rows: list[dict]) -> Path:
    SUMMARY.mkdir(parents=True, exist_ok=True)
    path = SUMMARY / "summary.csv"
    fields = [
        "vus", "reps", "throughput_rps", "throughput_min", "throughput_max", "gain_vs_prev",
        "p50_ms", "p95_ms", "p99_ms", "max_ms", "little_ms",
        "error_pct", "status_429", "status_5xx", "status_0",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: ("" if row.get(k) is None else row.get(k)) for k in fields})
    return path


def plot(rows: list[dict], knee: dict) -> Path | None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib no está instalado: se omiten las figuras (pip install -r requirements.txt)")
        return None

    xs = [r["vus"] for r in rows]
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.2))
    series = [
        ("throughput_rps", "Throughput (req/s)"),
        ("p95_ms", "Latencia p95 (ms)"),
        ("error_pct", "Errores (%)"),
    ]
    for ax, (key, label) in zip(axes, series):
        ax.plot(xs, [r[key] for r in rows], marker="o")
        ax.set_xscale("log")
        ax.set_xticks(xs)
        ax.set_xticklabels([str(x) for x in xs])
        ax.set_xlabel("VUs concurrentes")
        ax.set_ylabel(label)
        ax.grid(True, alpha=0.3)
        for x in (knee.get("last_efficient_vus"), knee.get("first_saturated_vus")):
            if x is not None:
                ax.axvline(x, color="tab:red", linestyle=":", alpha=0.6)
    if knee.get("first_saturated_vus") is not None:
        axes[0].annotate("knee (intervalo)", (knee["first_saturated_vus"], knee["peak_throughput_rps"]),
                         textcoords="offset points", xytext=(8, -14), color="tab:red")
    fig.suptitle("GET /api/auth/me vía API Gateway: curva de rendimiento (carga cerrada, sin think time)")
    fig.tight_layout()
    FIGURES.mkdir(parents=True, exist_ok=True)
    path = FIGURES / "curve.png"
    fig.savefig(path, dpi=150)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--campaign", help="prefijo de campaña a analizar (por defecto, todas las corridas)")
    parser.add_argument("--gain", type=float, default=0.10, help="ganancia mínima de throughput entre niveles (0.10 = 10 %%)")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")  # consolas de Windows (cp1252)

    by_level = load_runs(args.campaign)
    if not by_level:
        raise SystemExit(f"No hay corridas en {RUNS}. Ejecuta antes run-campaign.sh.")

    rows = summarize(by_level)
    knee = find_knee(rows, args.gain)
    csv_path = write_csv(rows)
    (SUMMARY / "knee.json").write_text(json.dumps(knee, indent=2, ensure_ascii=False), encoding="utf-8")
    fig_path = plot(rows, knee)

    print(f"{'VUs':>5} {'reps':>4} {'req/s':>9} {'gain':>7} {'p50ms':>8} {'p95ms':>8} {'p99ms':>8} {'err%':>7}")
    for r in rows:
        gain = "" if r.get("gain_vs_prev") is None else f"{100 * r['gain_vs_prev']:+.1f}%"
        print(f"{r['vus']:>5} {r['reps']:>4} {r['throughput_rps']:>9.1f} {gain:>7} "
              f"{r['p50_ms']:>8.1f} {r['p95_ms']:>8.1f} {r['p99_ms']:>8.1f} {r['error_pct']:>7.2f}")
    print()
    print(knee["conclusion"])
    print(f"Kneedle (verificación cruzada): {knee['kneedle_vus']} VUs")
    print(f"\nEscrito: {csv_path}, {SUMMARY / 'knee.json'}" + (f", {fig_path}" if fig_path else ""))


if __name__ == "__main__":
    main()
