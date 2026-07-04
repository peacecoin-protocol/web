// Numeric verification for the simulator engine, cross-checked against
// core test vectors (core/test/PCE.t.sol). Run with: node simulator/test.mjs
import { factorForDay, arigatoCompute, runAll, BP } from './engine.js';
import { percentileSorted, median, bandSeries, sweepValues } from './stats.js';
import { patternBits } from './identicon.js';

let failures = 0;
function check(name, actual, expected) {
    const ok = typeof expected === 'bigint' ? actual === expected : Object.is(actual, expected);
    if (!ok) {
        failures++;
        console.error(`FAIL ${name}: expected ${expected}, got ${actual}`);
    } else {
        console.log(`ok   ${name}`);
    }
}
function checkTrue(name, cond, detail = '') {
    if (!cond) {
        failures++;
        console.error(`FAIL ${name} ${detail}`);
    } else {
        console.log(`ok   ${name}`);
    }
}

// --- decay factor: contract test vectors ---------------------------------
// PCE.t.sol testCommunityTokenDepreciatesOverTime (interval=1, 9800bp)
check('factor day0 (interval=1, 9800bp)', factorForDay(0, 1, 9800), 10n ** 18n);
check('factor day1 = 0.98', factorForDay(1, 1, 9800), 980000000000000000n);
check('factor day2 = 0.9604', factorForDay(2, 1, 9800), 960400000000000000n);
// PCE.t.sol testCommunityTokenDecayUsesWadPrecisionForMultiplePeriods
// interval=7, 9980bp, day 84 = 12 applications of 0.998 in WAD floor precision
check('factor day84 (interval=7, 9980bp)', factorForDay(84, 7, 9980), 976262247894715033n);
check('factor day83 = 11 applications', factorForDay(83, 7, 9980), factorForDay(77, 7, 9980));
check('factor disabled by interval=0', factorForDay(100, 0, 9800), 10n ** 18n);
check('factor disabled by bp=10000', factorForDay(100, 1, 10000), 10n ** 18n);

// --- arigatoCompute: single-transfer vectors ------------------------------
const base = {
    midnightTotalSupply: 1000000,
    maxIncreaseOfTotalSupplyBp: 1000, // maxToday = 100000
    maxIncreaseBp: 500,
    maxUsageBp: 1000,
    changeBp: 100,
    mintedTodayGlobal: 0,
    mintedTodayGuest: 0,
    rawAmount: 1000,
    rawBalance: 10000, // usageBp = 1000 = maxUsageBp -> no penalty
    messageCharacters: 10,
    isGuest: false,
    midnightBalance: 10000,
    actualMintedSender: 0,
};
check('arigato base: mint = 1000*500/10000 = 50', arigatoCompute(base), 50);
check('arigato maxToday=0 -> 0',
    arigatoCompute({ ...base, maxIncreaseOfTotalSupplyBp: 0 }), 0);
check('arigato changeMulBp >= maxIncreaseBp -> 0',
    // usage 2000 vs maxUsage 1000, changeBp 10000 -> changeMulBp 1000 >= 500
    arigatoCompute({ ...base, rawAmount: 2000, changeBp: 10000 }), 0);
// message length scales the usage-deviation penalty (ArigatoCreation.sol:71)
const dev = { ...base, rawBalance: 50000, midnightBalance: 50000, rawAmount: 10000 }; // usage 2000
check('arigato msg=10: increaseBp 490 -> 490', arigatoCompute(dev), 490);
check('arigato msg=1: increaseBp 499 -> 499',
    arigatoCompute({ ...dev, messageCharacters: 1 }), 499);
check('arigato msg=0 treated as 1',
    arigatoCompute({ ...dev, messageCharacters: 0 }), 499);
check('arigato daily cap clamp',
    arigatoCompute({ ...base, mintedTodayGlobal: 99990 }), 10);
check('arigato per-sender cap: maxForSender=1000, already 990 -> 10',
    arigatoCompute({ ...base, actualMintedSender: 990 }), 10);
check('arigato per-sender exhausted -> 0',
    arigatoCompute({ ...base, actualMintedSender: 1000 }), 0);
// guest two-stage clamp: pool = maxToday/10 = 10000, per-guest = maxToday/100 = 1000
const guest = {
    ...base, isGuest: true, rawAmount: 100000, rawBalance: 1000000, midnightBalance: 0,
};
check('arigato guest per-sender clamp 5000 -> 1000', arigatoCompute(guest), 1000);
check('arigato guest pool nearly exhausted -> 5',
    arigatoCompute({ ...guest, mintedTodayGuest: 9995 }), 5);
check('arigato guest pool exhausted -> 0',
    arigatoCompute({ ...guest, mintedTodayGuest: 10000 }), 0);

// --- full simulation properties -------------------------------------------
function defaultParams(overrides = {}) {
    return {
        token: {
            initialSupply: 1000000,
            decreaseIntervalDays: 7,
            afterDecreaseBp: 9980,
            maxIncreaseOfTotalSupplyBp: 100,
            maxIncreaseBp: 500,
            maxUsageBp: 1000,
            changeBp: 5000,
            ...overrides.token,
        },
        population: {
            initialCount: 200,
            days: 365,
            growthModel: 'linear',
            growthPerDay: 1,
            growthRatePct: 1,
            logisticK: 2000,
            logisticR: 0.03,
            churnAnnualPct: 10,
            ...overrides.population,
        },
        personas: overrides.personas ?? [
            { name: 'active', share: 20, lambda: 1.5, amountMeanBp: 800, amountSdBp: 400, msgMin: 8, msgMax: 10, balanceWeight: 1.0, decayResponse: 0, recircBp: 0, recvWeight: 1 },
            { name: 'casual', share: 50, lambda: 0.2, amountMeanBp: 500, amountSdBp: 300, msgMin: 3, msgMax: 6, balanceWeight: 0.7, decayResponse: 0, recircBp: 0, recvWeight: 1 },
            { name: 'hoarder', share: 15, lambda: 0.05, amountMeanBp: 200, amountSdBp: 100, msgMin: 0, msgMax: 2, balanceWeight: 2.0, decayResponse: 0, recircBp: 0, recvWeight: 1 },
            { name: 'merchant', share: 15, lambda: 0.5, amountMeanBp: 2000, amountSdBp: 800, msgMin: 1, msgMax: 3, balanceWeight: 3.0, decayResponse: 0, recircBp: 0, recvWeight: 3 },
        ],
        graph: {
            model: 'ba', m: 3, kIn: 4, pOut: 0.1, k: 4, clusterTargetSize: 50,
            ...overrides.graph,
        },
        pce: { dilutionFactor: 1, swapInPerDay: 0, swapInMeanPce: 0, metaTxFeePce: 0, ...overrides.pce },
        run: { seed: 42, ...overrides.run },
    };
}

// defensive: a zero/fractional initial count must not lose the supply
{
    const sim = runAll(defaultParams({
        token: { maxIncreaseOfTotalSupplyBp: 0 },
        population: { days: 30, initialCount: 0, growthModel: 'linear', growthPerDay: 2, churnAnnualPct: 0 },
    }));
    let sum = 0;
    for (let i = 0; i < sim.agents.count; i++) sum += sim.agents.balance[i];
    check('initialCount guard: balances still sum to supply', sum, sim.results.totalRaw.at(-1));
}

// balance sigma: log-normal spread keeps the initial supply exactly intact
{
    const personas = [
        { name: 'a', share: 50, lambda: 0.2, amountMeanBp: 500, amountSdBp: 300, msgMin: 1, msgMax: 3, balanceWeight: 1.0, balanceSigma: 0.8, decayResponse: 0, recircBp: 0, recvWeight: 1 },
        { name: 'b', share: 50, lambda: 0.2, amountMeanBp: 500, amountSdBp: 300, msgMin: 1, msgMax: 3, balanceWeight: 2.0, balanceSigma: 0, decayResponse: 0, recircBp: 0, recvWeight: 1 },
    ];
    const sim = runAll(defaultParams({
        token: { maxIncreaseOfTotalSupplyBp: 0 },
        population: { days: 2, growthModel: 'none', churnAnnualPct: 0 },
        personas,
        pce: { metaTxFeePce: 0 },
    }));
    let sum = 0;
    const byPersona = [new Set(), new Set()];
    for (let i = 0; i < sim.agents.count; i++) {
        sum += sim.agents.balance[i];
        byPersona[sim.agents.persona[i]].add(sim.agents.balance[i]);
    }
    // day-2 run moves some balances, so check the recorded day-0 supply only
    check('balance sigma: supply conserved', sim.results.totalRaw[0], 1000000);
    checkTrue('balance sigma: sigma>0 spreads balances', byPersona[0].size > 5,
        `distinct=${byPersona[0].size}`);
}

// conservation: with minting disabled, raw supply never changes
{
    const sim = runAll(defaultParams({
        token: { maxIncreaseOfTotalSupplyBp: 0 },
        population: { days: 100 },
    }));
    const raw = sim.results.totalRaw;
    checkTrue('conservation: raw supply constant when mint disabled',
        raw.every((v) => v === 1000000),
        `min=${Math.min(...raw)} max=${Math.max(...raw)}`);
    checkTrue('conservation: zero mint recorded',
        sim.results.mintedToday.every((v) => v === 0));
    let sum = 0;
    for (let i = 0; i < sim.agents.count; i++) sum += sim.agents.balance[i];
    check('conservation: balances sum to total raw supply', sum, 1000000);
}

// PCE link: swap-in accounting and the PCE-value identity
{
    const sim = runAll(defaultParams({
        token: { maxIncreaseOfTotalSupplyBp: 0 }, // isolate swap-ins from ARIGATO
        population: { days: 100, growthModel: 'none', churnAnnualPct: 0 },
        pce: { dilutionFactor: 2, swapInPerDay: 5, swapInMeanPce: 100 },
    }));
    const r = sim.results;
    const tt = sim.totals();
    const last = r.day.length - 1;
    checkTrue('swap-in: events occurred', tt.swapInCount > 100, `count=${tt.swapInCount}`);
    check('swap-in: raw supply = initial + swapped-in raw',
        r.totalRaw[last], 1000000 + tt.swapInRaw);
    checkTrue('swap-in: reserve = initial deposit + inflow',
        Math.abs(r.depositedPce[last] - (1000000 / 2 + tt.swapInPce)) < 1e-6,
        `reserve=${r.depositedPce[last]}`);
    checkTrue('pce factor matches the WAD schedule at day 84',
        Math.abs(r.pceFactor[84] - Number(factorForDay(84, 7, 9980)) / 1e18) < 1e-15);
    const ok = [10, 50, last].every((d) =>
        Math.abs(r.pceValue[d] - r.totalRaw[d] * r.pceFactor[d] / 2) < 1e-6);
    checkTrue('pce value identity: totalRaw x pceFactor / dilution', ok);
}

// meta-tx fees: every transfer burns the fee and drains the reserve
{
    const sim = runAll(defaultParams({
        token: { maxIncreaseOfTotalSupplyBp: 0 }, // no ARIGATO: isolate fees
        population: { days: 100, growthModel: 'none', churnAnnualPct: 0 },
        pce: { metaTxFeePce: 1 },
    }));
    const r = sim.results;
    const tt = sim.totals();
    const last = r.day.length - 1;
    checkTrue('fees: paid on every transfer', Math.abs(tt.feePce - tt.txCount * 1) < 1e-6,
        `feePce=${tt.feePce} txCount=${tt.txCount}`);
    check('fees: raw supply = initial - burned fees',
        r.totalRaw[last], 1000000 - tt.feeBurnedRaw);
    checkTrue('fees: reserve = initial - fee outflow',
        Math.abs(r.depositedPce[last] - (1000000 - tt.feePce)) < 1e-6,
        `reserve=${r.depositedPce[last]}`);
    let sum = 0;
    for (let i = 0; i < sim.agents.count; i++) sum += sim.agents.balance[i];
    check('fees: balances still sum to raw supply', sum, r.totalRaw[last]);
}

// meta-tx fees: an exhausted reserve halts all transfers
{
    // reserve (initialSupply/dilution = 1000 PCE) cannot cover even one fee:
    // relayers refuse from day 0 and the whole economy halts
    const sim = runAll(defaultParams({
        population: { days: 60, growthModel: 'none', churnAnnualPct: 0 },
        pce: { dilutionFactor: 1000, metaTxFeePce: 5000 },
    }));
    const tt = sim.totals();
    checkTrue('fees: starvation day recorded', tt.feeStarvedDay >= 0, `day=${tt.feeStarvedDay}`);
    const r = sim.results;
    checkTrue('fees: transfers halt after starvation',
        r.txCount.every((v, i) => i < tt.feeStarvedDay || v === 0),
        `max=${Math.max(...r.txCount)}`);
    checkTrue('fees: reserve never negative', r.depositedPce.every((v) => v >= -1e-9));
}

// PCE link disabled: no swap arrays move
{
    const sim = runAll(defaultParams({ population: { days: 60 } }));
    const tt = sim.totals();
    checkTrue('swap-in disabled by default params', tt.swapInPce === 0 && tt.swapInCount === 0);
}

// exit spend: leavers use their balance up before going dormant
{
    const run = (exitSpendPct) => runAll(defaultParams({
        population: { days: 300, churnAnnualPct: 50, exitSpendPct },
    }));
    const dormantBalance = (sim) => {
        let sum = 0;
        for (let i = 0; i < sim.agents.count; i++) {
            if (!sim.agents.active[i]) sum += sim.agents.balance[i];
        }
        return sum;
    };
    const keep = dormantBalance(run(0));
    const spend = dormantBalance(run(100));
    checkTrue('exit spend 100% drains leavers vs 0%', spend < keep * 0.1,
        `spend=${Math.round(spend)} keep=${Math.round(keep)}`);
}

// population series: per-persona active counts always sum to activeCount
{
    const sim = runAll(defaultParams({ population: { days: 200 } }));
    const r = sim.results;
    checkTrue('personaCounts sum equals activeCount each day',
        r.day.every((_, di) => r.personaCounts.reduce((s, arr) => s + arr[di], 0) === r.activeCount[di]));
    checkTrue('personaCounts never negative',
        r.personaCounts.every((arr) => arr.every((v) => v >= 0)));
}

// daily cap: mintedToday never exceeds floor(midnightSupply * bp / 10000)
{
    const sim = runAll(defaultParams({
        token: { maxIncreaseOfTotalSupplyBp: 50, changeBp: 100 },
        population: { days: 365, growthModel: 'logistic' },
    }));
    let capOk = true;
    for (let i = 0; i < sim.results.day.length; i++) {
        const cap = Math.floor(sim.results.midnightSupply[i] * 50 / BP);
        if (sim.results.mintedToday[i] > cap) capOk = false;
    }
    checkTrue('daily cap never exceeded', capOk);
    checkTrue('minting actually happened', sim.totals().minted > 0);
}

// daily cap binds: everyone sends hard enough to exhaust their per-sender allowance.
// The sum of per-sender allowances floor(cap*balance/supply) is strictly below the
// global cap (flooring), so "minted == cap" never happens; near-cap is the strongest
// observable signal that the clamps bind.
{
    const hot = { share: 25, lambda: 5, amountMeanBp: 2000, amountSdBp: 0, msgMin: 10, msgMax: 10, balanceWeight: 1, decayResponse: 0, recircBp: 0, recvWeight: 1 };
    const sim = runAll(defaultParams({
        personas: [
            { name: 'active', ...hot }, { name: 'casual', ...hot },
            { name: 'hoarder', ...hot }, { name: 'merchant', ...hot },
        ],
        token: { maxIncreaseOfTotalSupplyBp: 100, maxIncreaseBp: 1000, changeBp: 0 },
        population: { days: 30, growthModel: 'none', churnAnnualPct: 0 },
    }));
    let capOk = true;
    let nearCap = 0;
    for (let i = 0; i < sim.results.day.length; i++) {
        const cap = Math.floor(sim.results.midnightSupply[i] * 100 / BP);
        if (sim.results.mintedToday[i] > cap) capOk = false;
        if (cap > 0 && sim.results.mintedToday[i] >= cap * 0.95) nearCap++;
    }
    checkTrue('hot scenario: daily cap never exceeded', capOk);
    checkTrue('hot scenario: daily mint reaches >=95% of cap', nearCap > 20,
        `nearCap days=${nearCap}/30`);
}

// reproducibility: same seed -> identical series, different seed -> different
{
    const a = runAll(defaultParams({ population: { days: 120 } }));
    const b = runAll(defaultParams({ population: { days: 120 } }));
    const c = runAll(defaultParams({ population: { days: 120 }, run: { seed: 43 } }));
    checkTrue('same seed reproduces run',
        a.results.totalRaw.every((v, i) => v === b.results.totalRaw[i]) &&
        a.results.gini.every((v, i) => v === b.results.gini[i]));
    checkTrue('different seed differs',
        a.results.totalRaw.some((v, i) => v !== c.results.totalRaw[i]));
}

// decay-only sanity: display supply follows the factor exactly when nothing moves
{
    const personasIdle = [
        { name: 'active', share: 100, lambda: 0, amountMeanBp: 800, amountSdBp: 0, msgMin: 1, msgMax: 1, balanceWeight: 1 },
        { name: 'casual', share: 0, lambda: 0, amountMeanBp: 500, amountSdBp: 0, msgMin: 1, msgMax: 1, balanceWeight: 1 },
        { name: 'hoarder', share: 0, lambda: 0, amountMeanBp: 200, amountSdBp: 0, msgMin: 1, msgMax: 1, balanceWeight: 1 },
        { name: 'merchant', share: 0, lambda: 0, amountMeanBp: 2000, amountSdBp: 0, msgMin: 1, msgMax: 1, balanceWeight: 1 },
    ];
    const sim = runAll(defaultParams({
        personas: personasIdle,
        token: { decreaseIntervalDays: 1, afterDecreaseBp: 9800 },
        population: { days: 3, growthModel: 'none', churnAnnualPct: 0 },
    }));
    check('idle day1 display = 98%', sim.results.totalDisplay[1], 1000000 * 0.98);
    check('idle day2 display = 96.04%', sim.results.totalDisplay[2], 1000000 * 0.9604);
}

// graph sanity
{
    const sim = runAll(defaultParams({ population: { days: 30, growthModel: 'none' } }));
    const deg = [];
    let merchantDeg = 0;
    let merchantN = 0;
    let otherDeg = 0;
    let otherN = 0;
    for (let i = 0; i < sim.agents.count; i++) {
        const d = sim.graph.degree(i);
        deg.push(d);
        if (sim.agents.persona[i] === 3) { merchantDeg += d; merchantN++; }
        else { otherDeg += d; otherN++; }
    }
    const avg = deg.reduce((s, v) => s + v, 0) / deg.length;
    const max = Math.max(...deg);
    checkTrue('BA: max degree >> average', max > avg * 3, `avg=${avg.toFixed(1)} max=${max}`);
    checkTrue('BA: merchants are hubs',
        merchantDeg / merchantN > otherDeg / otherN,
        `merchant=${(merchantDeg / merchantN).toFixed(1)} other=${(otherDeg / otherN).toFixed(1)}`);
}

// cluster / random graph models run and stay connected enough to trade
for (const model of ['cluster', 'random']) {
    const sim = runAll(defaultParams({
        graph: { model },
        population: { days: 60, growthModel: 'linear', growthPerDay: 2 },
    }));
    let isolated = 0;
    for (let i = 0; i < sim.agents.count; i++) {
        if (sim.graph.degree(i) === 0) isolated++;
    }
    checkTrue(`${model}: almost no isolated nodes`, isolated <= 1, `isolated=${isolated}`);
    checkTrue(`${model}: minting happened`, sim.totals().minted > 0);
    checkTrue(`${model}: raw balances non-negative`,
        sim.agents.balance.subarray(0, sim.agents.count).every((v) => v >= 0));
}

// growth + guests: population grows and newcomers can transact on join day
{
    const sim = runAll(defaultParams({
        population: { days: 200, growthModel: 'logistic', logisticK: 800, logisticR: 0.05 },
    }));
    const counts = sim.results.agentCount;
    checkTrue('population grows toward K',
        counts[counts.length - 1] > counts[0] * 2,
        `start=${counts[0]} end=${counts[counts.length - 1]}`);
    checkTrue('raw balances stay non-negative',
        sim.agents.balance.subarray(0, sim.agents.count).every((v) => v >= 0));
}

// decay-response behaviour: responsive personas transact more under decay
{
    const base = defaultParams({
        population: { days: 120, growthModel: 'none', churnAnnualPct: 0 },
        token: { decreaseIntervalDays: 1, afterDecreaseBp: 9900 }, // strong decay
    });
    const responsive = structuredClone(base);
    responsive.personas = responsive.personas.map((p) => ({ ...p, decayResponse: 1.5 }));
    const a = runAll(base);
    const b = runAll(responsive);
    checkTrue('decayResponse increases transfer volume',
        b.totals().volume > a.totals().volume * 1.5,
        `base=${a.totals().volume} responsive=${b.totals().volume}`);
    const noDecay = structuredClone(responsive);
    noDecay.token.decreaseIntervalDays = 0;
    const baseNoDecay = structuredClone(base);
    baseNoDecay.token.decreaseIntervalDays = 0;
    check('decayResponse inert without decay',
        runAll(noDecay).totals().volume, runAll(baseNoDecay).totals().volume);
}

// recirculation: merchants spending receipts raises velocity and lowers concentration
{
    const base = defaultParams({ population: { days: 200, growthModel: 'none' } });
    const recirc = structuredClone(base);
    recirc.personas[3].recircBp = 7000;
    const a = runAll(base);
    const b = runAll(recirc);
    // note: total volume is NOT monotone in recirc — receipts move to low-lambda
    // personas — so assert on the mechanism itself: merchant balance share drops
    const merchantShare = (sim) => {
        let m = 0;
        let all = 0;
        for (let i = 0; i < sim.agents.count; i++) {
            all += sim.agents.balance[i];
            if (sim.agents.persona[i] === 3) m += sim.agents.balance[i];
        }
        return m / all;
    };
    // note: the top-10% share is NOT asserted — recirculation sends to random
    // neighbors who may already be wealthy, so that metric is seed-noisy; the
    // mechanism check is the merchants' own share dropping.
    checkTrue('recirculation lowers merchant balance share',
        merchantShare(b) < merchantShare(a) * 0.9,
        `base=${merchantShare(a).toFixed(3)} recirc=${merchantShare(b).toFixed(3)}`);
    const conserved = runAll(defaultParams({
        token: { maxIncreaseOfTotalSupplyBp: 0 },
        population: { days: 100 },
        personas: base.personas.map((p) => ({ ...p, recircBp: 5000 })),
    }));
    checkTrue('recirculation preserves raw supply when mint disabled',
        conserved.results.totalRaw.every((v) => v === 1000000));
}

// per-agent stats conservation (all raw/face-value integer sums -> exact equality)
{
    const sim = runAll(defaultParams({
        population: { days: 200, growthModel: 'logistic', logisticK: 500, logisticR: 0.05 },
    }));
    const a = sim.agents;
    const n = a.count;
    const sumOf = (arr) => {
        let s = 0;
        for (let i = 0; i < n; i++) s += arr[i];
        return s;
    };
    check('stats: sum(txAmount) == totals.volume', sumOf(a.txAmount), sim.totals().volume);
    check('stats: sum(rxAmount) == totals.volume', sumOf(a.rxAmount), sim.totals().volume);
    check('stats: sum(minted) == totals.minted', sumOf(a.minted), sim.totals().minted);
    check('stats: sum(agent txCount) == totals.txCount', sumOf(a.txCount), sim.totals().txCount);
    check('stats: sum(agent rxCount) == totals.txCount', sumOf(a.rxCount), sim.totals().txCount);
    check('stats: daily txCount sums to total',
        sim.results.txCount.reduce((s, v) => s + v, 0), sim.totals().txCount);
    checkTrue('stats: volumeDisplay <= volume (factor <= 1)',
        sim.totals().volumeDisplay <= sim.totals().volume);
}

// per-agent stats: mint disabled -> minted all zero; idle -> everything zero
{
    const noMint = runAll(defaultParams({
        token: { maxIncreaseOfTotalSupplyBp: 0 },
        population: { days: 60 },
    }));
    checkTrue('stats: minted all zero when mint disabled',
        noMint.agents.minted.subarray(0, noMint.agents.count).every((v) => v === 0));
    const idle = runAll(defaultParams({
        personas: defaultParams().personas.map((p) => ({ ...p, lambda: 0 })),
        population: { days: 30, growthModel: 'none', churnAnnualPct: 0 },
    }));
    checkTrue('stats: idle scenario has zero transfers',
        idle.totals().txCount === 0 &&
        idle.agents.txAmount.subarray(0, idle.agents.count).every((v) => v === 0));
}

// identicon pattern determinism (canvas rendering is browser-only; bits are not)
{
    const a1 = patternBits(42, 7);
    const a2 = patternBits(42, 7);
    const b = patternBits(42, 8);
    const c = patternBits(43, 7);
    checkTrue('identicon: same seed+id -> same bits',
        a1.bits === a2.bits && a1.satJitter === a2.satJitter && a1.lightJitter === a2.lightJitter);
    checkTrue('identicon: different id or seed -> different bits',
        a1.bits !== b.bits || a1.bits !== c.bits);
}

// stats helpers
check('percentile: median of 1..5', percentileSorted([1, 2, 3, 4, 5], 0.5), 3);
check('percentile: interpolated p25', percentileSorted([0, 10], 0.25), 2.5);
check('median (unsorted, even n)', median([4, 1, 3, 2]), 2.5);
{
    const { length, series } = bandSeries([[1, 2, 3], [3, 4, 5], [2, 3, 4, 99]], [0, 0.5, 1]);
    check('bandSeries truncates to shortest run', length, 3);
    checkTrue('bandSeries min/median/max',
        series[0][0] === 1 && series[1][0] === 2 && series[2][0] === 3);
}
checkTrue('sweepValues endpoints and count',
    JSON.stringify(sweepValues(0, 10, 5, false)) === JSON.stringify([0, 2.5, 5, 7.5, 10]));
checkTrue('sweepValues integer dedupe',
    JSON.stringify(sweepValues(1, 3, 5, true)) === JSON.stringify([1, 2, 3]));

if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nall checks passed');
