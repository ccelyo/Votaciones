#!/usr/bin/env python3
"""Resume las corridas de k6 del Prototipo 3 y el consumo de recursos.

Lee results/rep*/vus_*.json y, si existe, el .stats.tsv del mismo nivel.
Escribe results/summary.csv, results/knee.json y results/resources.csv.
"""

import csv
import json
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
WATCH = ("waf", "gateway", "identity", "postgres", "platform")


def median(values):
    return statistics.median(values) if values else float("nan")


def load_runs():
    by_level = {}
    for path in sorted(RESULTS.glob("**/vus_*.json")):
        if path.name.endswith(".stats.json"):
            continue
        run = json.loads(path.read_text(encoding="utf-8"))
        by_level.setdefault(run["vus"], []).append((path, run))
    return by_level


def parse_stats(path: Path):
    """Promedio y pico de CPU (%) y memoria (MiB) por servicio."""
    if not path.exists():
        return {}
    samples = {name: {"cpu": [], "mem": []} for name in WATCH}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        container = parts[0]
        service = next((name for name in WATCH if name in container), None)
        if service is None or service == "postgres" and "census" in container:
            continue
        if service == "postgres" and "elections" in container:
            continue
        cpu = parts[1].strip().rstrip("%")
        mem = parts[2].split("/")[0].strip()
        try:
            cpu_v = float(cpu)
        except ValueError:
            continue
        mem_v = parse_mem(mem)
        samples[service]["cpu"].append(cpu_v)
        samples[service]["mem"].append(mem_v)
    out = {}
    for name, series in samples.items():
        if not series["cpu"]:
            continue
        out[name] = {
            "cpu_avg": round(sum(series["cpu"]) / len(series["cpu"]), 1),
            "cpu_max": round(max(series["cpu"]), 1),
            "mem_avg_mib": round(sum(series["mem"]) / len(series["mem"]), 1),
            "mem_max_mib": round(max(series["mem"]), 1),
        }
    return out


def parse_mem(text: str) -> float:
    text = text.replace(" ", "")
    number = ""
    unit = ""
    for ch in text:
        if ch.isdigit() or ch == ".":
            number += ch
        else:
            unit += ch
    value = float(number or 0)
    unit = unit.lower()
    if unit.startswith("gib") or unit.startswith("gb"):
        return value * 1024
    if unit.startswith("kib") or unit.startswith("kb"):
        return value / 1024
    return value


def summarize(by_level):
    rows = []
    resources = []
    for vus in sorted(by_level):
        runs = [run for _, run in by_level[vus]]
        paths = [path for path, _ in by_level[vus]]
        tp = [r["throughput_rps"] for r in runs]
        err = [100 * r["error_rate"] for r in runs]
        row = {
            "vus": vus,
            "reps": len(runs),
            "throughput_rps": round(median(tp), 2),
            "throughput_min": round(min(tp), 2),
            "throughput_max": round(max(tp), 2),
            "avg_ms": round(median([r["latency_ms"]["avg"] for r in runs]), 1),
            "p50_ms": round(median([r["latency_ms"]["p50"] for r in runs]), 1),
            "p95_ms": round(median([r["latency_ms"]["p95"] for r in runs]), 1),
            "p99_ms": round(median([r["latency_ms"]["p99"] for r in runs]), 1),
            "error_pct": round(median(err), 2),
            "error_max_pct": round(max(err), 2),
            "status_200": sum(r["status"]["200"] for r in runs),
            "status_403": sum(r["status"]["403"] for r in runs),
            "status_429": sum(r["status"]["429"] for r in runs),
            "status_5xx": sum(r["status"]["5xx"] for r in runs),
            "status_0": sum(r["status"]["0"] for r in runs),
            "clean_reps": sum(1 for r in runs if r["error_rate"] == 0),
        }
        rows.append(row)

        merged = {name: {"cpu_avg": [], "cpu_max": [], "mem_avg_mib": [], "mem_max_mib": []} for name in WATCH}
        for path in paths:
            stats = parse_stats(path.with_suffix(".stats.tsv"))
            for name, values in stats.items():
                for key, value in values.items():
                    merged[name][key].append(value)
        for name in WATCH:
            if not merged[name]["cpu_avg"]:
                continue
            resources.append({
                "vus": vus,
                "service": name,
                "cpu_avg": round(median(merged[name]["cpu_avg"]), 1),
                "cpu_max": round(max(merged[name]["cpu_max"]), 1),
                "mem_avg_mib": round(median(merged[name]["mem_avg_mib"]), 1),
                "mem_max_mib": round(max(merged[name]["mem_max_mib"]), 1),
            })
    return rows, resources


def find_knee(rows):
    """Último nivel estable: 0 % de error en todas las corridas y p95 < 500 ms.

    El nivel siguiente, si la latencia se duplica o aparecen errores, es el
    primer punto de saturación. La rodilla queda entre ambos.
    """
    stable = [r for r in rows if r["error_max_pct"] == 0 and r["p95_ms"] < 500]
    if not stable:
        return {"knee_last_stable_vus": None, "reason": "ningún nivel quedó estable"}
    last = stable[-1]
    later = [r for r in rows if r["vus"] > last["vus"]]
    first_bad = None
    for row in later:
        if row["error_max_pct"] > 1 or row["p95_ms"] >= 2 * last["p95_ms"]:
            first_bad = row
            break
    knee = {
        "knee_last_stable_vus": last["vus"],
        "knee_first_degraded_vus": first_bad["vus"] if first_bad else None,
        "last_stable": {
            "throughput_rps": last["throughput_rps"],
            "avg_ms": last["avg_ms"],
            "p95_ms": last["p95_ms"],
            "error_pct": last["error_pct"],
            "clean_reps": f"{last['clean_reps']}/{last['reps']}",
        },
        "intermittent": [
            {"vus": row["vus"], "clean_reps": f"{row['clean_reps']}/{row['reps']}", "error_max_pct": row["error_max_pct"]}
            for row in rows
            if 0 < row["clean_reps"] < row["reps"]
        ],
    }
    xs = [r["vus"] for r in rows]
    ys = [r["throughput_rps"] for r in rows]
    if len(xs) >= 3 and max(ys) != min(ys):
        xn = [(x - xs[0]) / (xs[-1] - xs[0]) for x in xs]
        yn = [(y - min(ys)) / (max(ys) - min(ys)) for y in ys]
        diffs = [y - x for x, y in zip(xn, yn)]
        idx = max(range(len(diffs)), key=diffs.__getitem__)
        knee["kneedle_vus"] = xs[idx]
    return knee


def write_csv(path: Path, rows):
    if not rows:
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main():
    rows, resources = summarize(load_runs())
    if not rows:
        raise SystemExit("No hay resultados en results/rep*/vus_*.json")
    knee = find_knee(rows)
    write_csv(RESULTS / "summary.csv", rows)
    write_csv(RESULTS / "resources.csv", resources)
    (RESULTS / "knee.json").write_text(json.dumps(knee, indent=2), encoding="utf-8")
    print(json.dumps({"knee": knee, "levels": rows}, indent=2))


if __name__ == "__main__":
    main()
