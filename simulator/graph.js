// Social graph models for the community token simulator.
// DOM-free ES module: importable from both the browser (app.js) and node (test.mjs).

// model: 'ba' (scale-free, Barabasi-Albert) | 'cluster' (small-world communities) | 'random'
// persona: Uint8Array shared with the engine (read-only here)
// recvWeights: per-persona receive weight; >1 personas act as hubs (both for
// preferential attachment and for recipient selection)
export function createGraph(model, opts, persona, rng, recvWeights = []) {
    const adj = []; // adj[i] = array of neighbor ids (undirected)
    // Each edge pushes both ends; a uniform pick from this list is degree-proportional.
    const endpoints = [];
    const clusters = [];
    const clusterOf = [];

    const m0 = 4;
    const m = opts.m ?? 3;
    const kIn = opts.kIn ?? 4;
    const pOut = opts.pOut ?? 0.1;
    const k = opts.k ?? 4;
    const clusterTargetSize = opts.clusterTargetSize ?? 50;

    const maxFitness = Math.max(1, ...recvWeights);

    function fitness(i) {
        return Math.max(1, recvWeights[persona[i]] ?? 1);
    }

    function link(a, b) {
        if (a === b || adj[a].includes(b)) return;
        adj[a].push(b);
        adj[b].push(a);
        endpoints.push(a, b);
    }

    // degree*fitness-proportional pick via rejection sampling on the endpoints list
    function pickPreferential(self, chosen) {
        for (let t = 0; t < 64; t++) {
            const j = endpoints.length > 0
                ? endpoints[(rng() * endpoints.length) | 0]
                : (rng() * self) | 0;
            if (j === self || chosen.has(j)) continue;
            if (rng() * maxFitness <= fitness(j)) return j;
        }
        for (let t = 0; t < 64; t++) { // fallback: uniform
            const j = (rng() * self) | 0;
            if (j !== self && !chosen.has(j)) return j;
        }
        return -1;
    }

    function addNode(i) {
        adj[i] = [];
        if (model === 'ba') {
            if (i < m0) {
                for (let j = 0; j < i; j++) link(i, j);
                return;
            }
            const chosen = new Set();
            for (let e = 0; e < m; e++) {
                const j = pickPreferential(i, chosen);
                if (j < 0) break;
                chosen.add(j);
                link(i, j);
            }
        } else if (model === 'cluster') {
            // join the smallest cluster; open a new one once even the smallest hits 2x target
            let c = -1;
            let min = Infinity;
            for (let ci = 0; ci < clusters.length; ci++) {
                if (clusters[ci].length < min) { min = clusters[ci].length; c = ci; }
            }
            if (c < 0 || min >= clusterTargetSize * 2) {
                c = clusters.length;
                clusters.push([]);
            }
            clusterOf[i] = c;
            const members = clusters[c];
            const chosen = new Set();
            for (let e = 0; e < kIn && members.length > 0; e++) {
                for (let t = 0; t < 32; t++) {
                    const j = members[(rng() * members.length) | 0];
                    if (j !== i && !chosen.has(j)) { chosen.add(j); link(i, j); break; }
                }
            }
            members.push(i);
            if (i > 0 && rng() < pOut) { // occasional cross-cluster tie (small-world)
                const j = (rng() * i) | 0;
                if (clusterOf[j] !== c) link(i, j);
            }
        } else { // 'random'
            const chosen = new Set();
            for (let e = 0; e < k && i > 0; e++) {
                for (let t = 0; t < 32; t++) {
                    const j = (rng() * i) | 0;
                    if (!chosen.has(j)) { chosen.add(j); link(i, j); break; }
                }
            }
        }
    }

    // Weighted pick among active neighbors (weights = per-persona receive weight,
    // or uniform when weighted=false); falls back to any active agent when the
    // whole neighborhood is inactive.
    function pickPartner(i, active, weighted, count) {
        const nbrs = adj[i];
        const w = (j) => (weighted ? Math.max(0, recvWeights[persona[j]] ?? 1) : 1);
        let total = 0;
        for (const j of nbrs) {
            if (active[j]) total += w(j);
        }
        if (total > 0) {
            let r = rng() * total;
            for (const j of nbrs) {
                if (!active[j]) continue;
                r -= w(j);
                if (r <= 0) return j;
            }
        }
        // fallback: any active agent, scanning from a random start so the pick
        // stays uniform-ish but never misses a live agent (high-churn endgames)
        const start = (rng() * count) | 0;
        for (let o = 0; o < count; o++) {
            const j = (start + o) % count;
            if (j !== i && active[j]) return j;
        }
        return -1;
    }

    return { adj, addNode, pickPartner, degree: (i) => adj[i].length };
}
