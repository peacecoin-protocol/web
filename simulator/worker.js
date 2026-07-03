// Module worker: runs one full simulation off the main thread and streams
// progress. Used for multi-seed (Monte Carlo) runs and parameter sweeps.
import { createSim } from './engine.js';

self.onmessage = (e) => {
    const { jobId, params, full } = e.data;
    const sim = createSim(params);
    while (!sim.finished()) {
        sim.runDays(100);
        self.postMessage({ jobId, type: 'progress', day: sim.day });
    }
    const payload = {
        results: sim.results,
        totals: sim.totals(),
        aborted: sim.aborted,
        day: sim.day,
    };
    if (full) {
        // everything the network view and summary need, as plain clonable data
        const count = sim.agents.count;
        payload.snapshots = sim.snapshots;
        payload.adj = sim.graph.adj;
        payload.agents = {
            persona: sim.agents.persona.slice(0, count),
            joinDay: sim.agents.joinDay.slice(0, count),
            firstTxDay: sim.agents.firstTxDay.slice(0, count),
            balance: sim.agents.balance.slice(0, count),
            active: sim.agents.active.slice(0, count),
            txCount: sim.agents.txCount.slice(0, count),
            rxCount: sim.agents.rxCount.slice(0, count),
            txAmount: sim.agents.txAmount.slice(0, count),
            rxAmount: sim.agents.rxAmount.slice(0, count),
            minted: sim.agents.minted.slice(0, count),
            count,
        };
    }
    self.postMessage({ jobId, type: 'done', payload });
};
