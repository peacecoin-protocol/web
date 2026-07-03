// Dependency-free social-graph rendering: one static Fruchterman-Reingold layout
// on the final graph, then per-snapshot redraws. Explorer-inspired interactions:
// node radius follows the percentile rank of a selectable metric, hover reports
// the node for a tooltip, click highlights the 2-hop neighborhood (squared
// distance fade), double-click opens the agent detail dialog.

import { mulberry32 } from './engine.js';

// Validated categorical palette (dataviz reference, light surface), fixed slot
// order; identity is also carried by legend/name labels, never color alone.
export const PERSONA_COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
const CHURN_COLOR = '#c3c2b7';
const MAX_NODES = 500;
const LAYOUT_ITERATIONS = 80;
// alpha by BFS distance from the selected node (explorer's ((m-i)/m)^2 feel)
const DIST_ALPHA = [1, 1, 0.25, 0.08];

function lowerBound(arr, v) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (arr[m] < v) lo = m + 1;
        else hi = m;
    }
    return lo;
}

// hooks: { onHover(agentId|null, clientX, clientY), onOpen(agentId) }
export function createNetworkView(canvas, sim, seed = 7, hooks = {}) {
    const total = sim.agents.count;
    const persona = sim.agents.persona;
    const joinDay = sim.agents.joinDay;
    const adj = sim.graph.adj;

    // --- pick which nodes to show: hub personas + high degree first, then a sample ---
    let nodes;
    if (total <= MAX_NODES) {
        nodes = Array.from({ length: total }, (_, i) => i);
    } else {
        const hubPersona = (sim.params.personas ?? []).map((p) => (p.recvWeight ?? 1) > 1);
        const scored = Array.from({ length: total }, (_, i) => ({
            i,
            score: (hubPersona[persona[i]] ? 1e6 : 0) + adj[i].length,
        }));
        scored.sort((a, b) => b.score - a.score);
        const keepTop = Math.floor(MAX_NODES * 0.7);
        nodes = scored.slice(0, keepTop).map((s) => s.i);
        const rest = scored.slice(keepTop).map((s) => s.i);
        const rng = mulberry32(seed >>> 0);
        for (let need = MAX_NODES - nodes.length; need > 0 && rest.length > 0; need--) {
            const at = (rng() * rest.length) | 0;
            nodes.push(rest[at]);
            rest[at] = rest[rest.length - 1];
            rest.pop();
        }
    }

    const localOf = new Map(nodes.map((id, li) => [id, li]));
    const n = nodes.length;
    const edges = [];
    const localAdj = Array.from({ length: n }, () => []);
    for (let li = 0; li < n; li++) {
        for (const nb of adj[nodes[li]]) {
            const lj = localOf.get(nb);
            if (lj !== undefined && lj > li) {
                edges.push([li, lj]);
                localAdj[li].push(lj);
                localAdj[lj].push(li);
            }
        }
    }

    // --- Fruchterman-Reingold, deterministic start, cooled over fixed iterations ---
    const rng = mulberry32((seed ^ 0x5bf03635) >>> 0);
    const px = new Float64Array(n);
    const py = new Float64Array(n);
    for (let i = 0; i < n; i++) { px[i] = rng(); py[i] = rng(); }
    const k = Math.sqrt(1 / Math.max(1, n));
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let it = 0; it < LAYOUT_ITERATIONS; it++) {
        dx.fill(0); dy.fill(0);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let vx = px[i] - px[j];
                let vy = py[i] - py[j];
                let d2 = vx * vx + vy * vy;
                if (d2 < 1e-8) { vx = (rng() - 0.5) * 1e-3; vy = (rng() - 0.5) * 1e-3; d2 = vx * vx + vy * vy; }
                const rep = (k * k) / d2;
                dx[i] += vx * rep; dy[i] += vy * rep;
                dx[j] -= vx * rep; dy[j] -= vy * rep;
            }
        }
        for (const [a, b] of edges) {
            const vx = px[a] - px[b];
            const vy = py[a] - py[b];
            const d = Math.sqrt(vx * vx + vy * vy) || 1e-6;
            const att = (d * d) / k / d;
            dx[a] -= vx * att; dy[a] -= vy * att;
            dx[b] += vx * att; dy[b] += vy * att;
        }
        const temp = 0.1 * (1 - it / LAYOUT_ITERATIONS) + 0.005;
        for (let i = 0; i < n; i++) {
            const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1e-6;
            const step = Math.min(d, temp);
            px[i] += (dx[i] / d) * step;
            py[i] += (dy[i] / d) * step;
        }
    }
    // normalize to unit square
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        if (px[i] < minX) minX = px[i];
        if (px[i] > maxX) maxX = px[i];
        if (py[i] < minY) minY = py[i];
        if (py[i] > maxY) maxY = py[i];
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    for (let i = 0; i < n; i++) {
        px[i] = (px[i] - minX) / spanX;
        py[i] = (py[i] - minY) / spanY;
    }

    // --- interactive state ---
    let metric = 'balance';
    let selectedLocal = -1;
    let lastSnapshot = null;
    const nodeSX = new Float64Array(n);
    const nodeSY = new Float64Array(n);
    const nodeR = new Float64Array(n);
    const dist = new Int8Array(n);

    function metricValue(id, snapshot) {
        // cumulative metrics are lifetime totals (final-day values); only the
        // balance follows the day slider
        if (metric === 'balance') return snapshot.balance[id];
        return sim.agents[metric][id];
    }

    function computeDist(start) {
        dist.fill(3);
        dist[start] = 0;
        let frontier = [start];
        for (let depth = 1; depth <= 2; depth++) {
            const next = [];
            for (const li of frontier) {
                for (const nb of localAdj[li]) {
                    if (dist[nb] > depth) { dist[nb] = depth; next.push(nb); }
                }
            }
            frontier = next;
        }
    }

    function render(snapshot) {
        lastSnapshot = snapshot;
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const pad = 24;
        const sx = (v) => pad + v * (w - 2 * pad);
        const sy = (v) => pad + v * (h - 2 * pad);
        const day = snapshot.day;
        const visible = (id) => id < snapshot.count && joinDay[id] <= day;
        const alphaOf = (li) => (selectedLocal < 0 ? 1 : DIST_ALPHA[dist[li]]);

        // percentile-rank radius (robust against outliers, explorer style)
        const values = [];
        for (let li = 0; li < n; li++) {
            if (visible(nodes[li])) values.push(metricValue(nodes[li], snapshot));
        }
        values.sort((a, b) => a - b);
        const denom = Math.max(1, values.length - 1);

        for (let li = 0; li < n; li++) {
            nodeSX[li] = sx(px[li]);
            nodeSY[li] = sy(py[li]);
            nodeR[li] = visible(nodes[li])
                ? 3 + (lowerBound(values, metricValue(nodes[li], snapshot)) / denom) * 11
                : 0;
        }

        // edges, batched by alpha (at most a few distinct values)
        const paths = new Map();
        for (const [a, b] of edges) {
            if (nodeR[a] === 0 || nodeR[b] === 0) continue;
            const alpha = 0.08 * Math.min(alphaOf(a), alphaOf(b));
            let path = paths.get(alpha);
            if (!path) { path = new Path2D(); paths.set(alpha, path); }
            path.moveTo(nodeSX[a], nodeSY[a]);
            path.lineTo(nodeSX[b], nodeSY[b]);
        }
        ctx.lineWidth = 1;
        for (const [alpha, path] of paths) {
            ctx.strokeStyle = `rgba(11, 11, 11, ${alpha})`;
            ctx.stroke(path);
        }

        for (let li = 0; li < n; li++) {
            if (nodeR[li] === 0) continue;
            const id = nodes[li];
            ctx.globalAlpha = alphaOf(li);
            ctx.beginPath();
            ctx.arc(nodeSX[li], nodeSY[li], nodeR[li], 0, Math.PI * 2);
            ctx.fillStyle = snapshot.active[id] ? PERSONA_COLORS[persona[id]] : CHURN_COLOR;
            ctx.fill();
            // 2px surface ring so overlapping marks stay separable
            ctx.strokeStyle = '#fcfcfb';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            if (li === selectedLocal) {
                ctx.strokeStyle = '#0b0b0b';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;
    }

    function hitTest(e) {
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        let best = -1;
        let bestD = Infinity;
        for (let li = 0; li < n; li++) {
            if (nodeR[li] === 0) continue;
            const dxp = mx - nodeSX[li];
            const dyp = my - nodeSY[li];
            const d2 = dxp * dxp + dyp * dyp;
            const hit = Math.max(nodeR[li] + 3, 8);
            if (d2 <= hit * hit && d2 < bestD) { bestD = d2; best = li; }
        }
        return best;
    }

    canvas.addEventListener('mousemove', (e) => {
        const li = hitTest(e);
        canvas.style.cursor = li >= 0 ? 'pointer' : 'default';
        if (hooks.onHover) hooks.onHover(li >= 0 ? nodes[li] : null, e.clientX, e.clientY);
    });
    canvas.addEventListener('mouseleave', () => {
        if (hooks.onHover) hooks.onHover(null, 0, 0);
    });
    canvas.addEventListener('click', (e) => {
        const li = hitTest(e);
        if (li < 0 || li === selectedLocal) {
            selectedLocal = -1; // empty space or same node: clear the highlight
        } else {
            selectedLocal = li;
            computeDist(li);
        }
        if (lastSnapshot) render(lastSnapshot);
    });
    canvas.addEventListener('dblclick', (e) => {
        const li = hitTest(e);
        if (li >= 0 && hooks.onOpen) hooks.onOpen(nodes[li]);
    });

    return {
        render,
        setMetric(key) {
            metric = key;
            if (lastSnapshot) render(lastSnapshot);
        },
        shown: n,
        total,
    };
}
