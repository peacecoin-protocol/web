// Aggregation helpers for multi-seed (Monte Carlo) runs and parameter sweeps.
// DOM-free ES module: importable from both the browser (app.js) and node (test.mjs).

// Linear-interpolation percentile of an ASCENDING-sorted numeric array, q in [0,1].
export function percentileSorted(sorted, q) {
    const n = sorted.length;
    if (n === 0) return NaN;
    if (n === 1) return sorted[0];
    const pos = q * (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return percentileSorted(sorted, 0.5);
}

// runs: number[][] (one per-day series per run, possibly different lengths when a
// run aborted early). Returns per-day percentile series truncated to the shortest
// run, as { length, series: number[][] } aligned with qs.
export function bandSeries(runs, qs = [0.1, 0.5, 0.9]) {
    const length = Math.min(...runs.map((r) => r.length));
    const series = qs.map(() => new Array(length));
    const buf = new Array(runs.length);
    for (let d = 0; d < length; d++) {
        for (let r = 0; r < runs.length; r++) buf[r] = runs[r][d];
        buf.sort((a, b) => a - b);
        for (let k = 0; k < qs.length; k++) series[k][d] = percentileSorted(buf, qs[k]);
    }
    return { length, series };
}

// Evenly spaced sweep values from `from` to `to` inclusive; integers are kept
// integral (rounded then deduplicated) when isInteger is set.
export function sweepValues(from, to, steps, isInteger) {
    const n = Math.max(2, Math.floor(steps));
    const values = [];
    for (let i = 0; i < n; i++) {
        let v = from + (to - from) * (i / (n - 1));
        v = Number(v.toPrecision(12)); // strip float noise (0.08000000000000002 -> 0.08)
        if (isInteger) v = Math.round(v);
        if (values.length === 0 || values[values.length - 1] !== v) values.push(v);
    }
    return values;
}
