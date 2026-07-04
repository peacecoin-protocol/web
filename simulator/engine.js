// Agent-based simulation engine for PCE community token increase (ARIGATO CREATION)
// and the decay factor.
//
// Contract-faithful ports:
//   - factorForDay:   core/src/PCECommunityToken.sol getCurrentFactor (BigInt WAD,
//                     binary exponentiation, floor rounding)
//   - arigatoCompute: core/src/lib/ArigatoCreation.sol compute (all divisions floored)
//
// Balances are tracked in whole-token units as exact float64 integers (never wei);
// the decay factor never touches raw balances (display = raw x factor), exactly
// like the contract.
//
// DOM-free ES module: importable from both the browser (app.js) and node (test.mjs).

import { createGraph } from './graph.js';

export const WAD = 10n ** 18n;
export const BP = 10000;

// Deterministic PRNG; one stream drives every random draw so a seed reproduces a run.
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Decay factor at the start of `day` (day 0 = token creation, factor 1).
// times = floor(day / intervalDays); factor = (afterDecreaseBp/10000)^times,
// computed with the contract's exponentiation-by-squaring so WAD floor rounding
// matches to the last digit.
export function factorForDay(day, intervalDays, afterDecreaseBp) {
    if (intervalDays <= 0) return WAD;
    let n = BigInt(Math.floor(day / intervalDays));
    let factor = WAD;
    let rate = (BigInt(afterDecreaseBp) * WAD) / BigInt(BP);
    while (n > 0n) {
        if (n % 2n === 1n) factor = (factor * rate) / WAD;
        rate = (rate * rate) / WAD;
        n /= 2n;
    }
    return factor;
}

// Faithful port of ArigatoCreation.compute (core/src/lib/ArigatoCreation.sol:35-94).
// The contract's per-sender counter uses a gas-saving sentinel of 1 that compute
// subtracts back out (actualMinted = counter - 1), so a plain 0-based counter is
// exactly equivalent. The global/guest counters are NOT corrected on-chain, which
// makes the on-chain effective caps 1 wei lower than the nominal formula; at this
// simulator's whole-token scale that difference is far below one unit, so 0-based
// counters are the closer model.
export function arigatoCompute(p) {
    const maxToday = Math.floor(p.midnightTotalSupply * p.maxIncreaseOfTotalSupplyBp / BP);
    if (maxToday === 0 || maxToday <= p.mintedTodayGlobal) return 0;
    const remainingToday = maxToday - p.mintedTodayGlobal;

    let remainingTodayForGuest = 0;
    if (p.isGuest) {
        const maxForGuest = Math.floor(maxToday / 10);
        if (maxForGuest === 0 || maxForGuest <= p.mintedTodayGuest) return 0;
        remainingTodayForGuest = maxForGuest - p.mintedTodayGuest;
    }

    if (p.rawBalance <= 0) return 0;
    const usageBp = Math.floor(p.rawAmount * BP / p.rawBalance);
    const absUsageBp = usageBp > p.maxUsageBp ? usageBp - p.maxUsageBp : p.maxUsageBp - usageBp;
    const changeMulBp = Math.floor(p.changeBp * absUsageBp / BP);
    if (changeMulBp >= p.maxIncreaseBp) return 0;

    const messageLength = p.messageCharacters > 0 ? p.messageCharacters : 1;
    const messageBp = messageLength > 10 ? BP : Math.floor(messageLength * BP / 10);
    const increaseBp = p.maxIncreaseBp - Math.floor(changeMulBp * messageBp / BP);
    let mintAmount = Math.floor(p.rawAmount * increaseBp / BP);
    if (mintAmount > remainingToday) mintAmount = remainingToday;

    const actualMinted = p.actualMintedSender;
    if (!p.isGuest) {
        const maxForSender = Math.floor(maxToday * p.midnightBalance / p.midnightTotalSupply);
        if (maxForSender === 0) return 0;
        const remainingSender = maxForSender > actualMinted ? maxForSender - actualMinted : 0;
        if (remainingSender === 0) return 0;
        if (mintAmount > remainingSender) mintAmount = remainingSender;
    } else {
        if (mintAmount > remainingTodayForGuest) mintAmount = remainingTodayForGuest;
        const maxGuestSender = Math.floor(maxToday / 100);
        if (maxGuestSender === 0) return 0;
        const remainingGuestSender = maxGuestSender > actualMinted ? maxGuestSender - actualMinted : 0;
        if (remainingGuestSender === 0) return 0;
        if (mintAmount > remainingGuestSender) mintAmount = remainingGuestSender;
    }
    return mintAmount;
}

function poisson(lambda, rng) {
    if (lambda <= 0) return 0;
    // Math.exp(-lambda) underflows to 0 around lambda ~ 745, breaking Knuth's
    // loop; fall back to the normal approximation for large lambda
    if (lambda > 700) return Math.max(0, Math.round(gauss(lambda, Math.sqrt(lambda), rng)));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
}

function gauss(mean, sd, rng) {
    const u = 1 - rng();
    const v = rng();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Cumulative joined-member curve J(t).
export function growthTarget(pop, t) {
    const n0 = pop.initialCount;
    switch (pop.growthModel) {
        case 'linear':
            return n0 + pop.growthPerDay * t;
        case 'exp':
            return n0 * Math.pow(1 + pop.growthRatePct / 100, t);
        case 'logistic': {
            const K = Math.max(pop.logisticK, n0);
            return K / (1 + ((K - n0) / n0) * Math.exp(-pop.logisticR * t));
        }
        default:
            return n0;
    }
}

// Rough expected transfer count, for the UI's "this will be slow" warning.
export function estimateTxCount(params) {
    const lambdaBar = params.personas.reduce((s, p) => s + p.share * p.lambda, 0) /
        Math.max(1, params.personas.reduce((s, p) => s + p.share, 0));
    let total = 0;
    for (let t = 0; t < params.population.days; t += 30) {
        const span = Math.min(30, params.population.days - t);
        total += span * growthTarget(params.population, t) * lambdaBar;
    }
    return Math.round(total);
}

const MAX_AGENTS = 200000;
const FIRST_TX_NEVER = -1;  // initial cohort: never treated as a guest
const FIRST_TX_UNSET = -2;  // joined but no transfer has touched the account yet

// Exactness requires every floor(a*b/c) intermediate product to stay below 2^53.
// The binding products are rawAmount*BP (usageBp) and maxToday*midnightBalance
// (per-sender cap, ~ supply^2 * capBp / BP), so the safe raw-supply ceiling
// depends on the configured daily cap.
function rawSupplyLimit(maxIncreaseOfTotalSupplyBp) {
    const usageBound = Math.floor(2 ** 53 / BP);
    if (maxIncreaseOfTotalSupplyBp <= 0) return usageBound;
    return Math.min(usageBound, Math.floor(Math.sqrt((2 ** 53) * BP / maxIncreaseOfTotalSupplyBp)));
}

export function createSim(params) {
    const { token, personas, graph: gopts, run } = params;
    const behavior = params.behavior ?? {};
    // welcome transfer: fraction of the community mean a newcomer receives,
    // capped at a fraction of the welcoming sender's balance
    const welcomeFrac = Math.min(1, Math.max(0, (params.population.welcomeAvgPct ?? 10) / 100));
    const welcomeCap = Math.min(1, Math.max(0, (params.population.welcomeCapPct ?? 50) / 100));
    const pop = { ...params.population, initialCount: Math.max(1, Math.round(params.population.initialCount)) };
    const days = pop.days;
    const rng = mulberry32(run.seed);

    const maxAgents = Math.min(
        MAX_AGENTS,
        Math.max(pop.initialCount, Math.ceil(growthTarget(pop, days - 1)) + 8)
    );

    const balance = new Float64Array(maxAgents);        // raw, whole tokens
    const midnightBalance = new Float64Array(maxAgents);
    const mintedTodaySender = new Float64Array(maxAgents);
    let receivedToday = new Float64Array(maxAgents);     // raw received, for recirculation
    let receivedYesterday = new Float64Array(maxAgents);
    // per-agent lifetime stats (raw/face-value units; rankings, tooltips, dialogs)
    const statTxCount = new Uint32Array(maxAgents);
    const statRxCount = new Uint32Array(maxAgents);
    const statTxAmount = new Float64Array(maxAgents);
    const statRxAmount = new Float64Array(maxAgents);
    const statMinted = new Float64Array(maxAgents);
    const persona = new Uint8Array(maxAgents);
    const active = new Uint8Array(maxAgents);
    const joinDay = new Int32Array(maxAgents);
    const firstTxDay = new Int32Array(maxAgents); // FIRST_TX_NEVER / FIRST_TX_UNSET / day of first transfer

    const recvWeights = personas.map((p) => p.recvWeight ?? 1);
    const g = createGraph(gopts.model, gopts, persona, rng, recvWeights);

    // --- initial cohort: exact persona shares (largest remainder), shuffled ---
    const n0 = pop.initialCount;
    const totalShare = personas.reduce((s, p) => s + p.share, 0) || 1;
    const counts = personas.map((p) => Math.floor(n0 * p.share / totalShare));
    {
        let assigned = counts.reduce((s, c) => s + c, 0);
        const fracs = personas
            .map((p, idx) => ({ idx, frac: n0 * p.share / totalShare - counts[idx] }))
            .sort((a, b) => b.frac - a.frac);
        for (let r = 0; assigned < n0; r++, assigned++) counts[fracs[r % fracs.length].idx]++;
    }
    const labels = [];
    counts.forEach((c, idx) => { for (let j = 0; j < c; j++) labels.push(idx); });
    for (let a = labels.length - 1; a > 0; a--) {
        const b = (rng() * (a + 1)) | 0;
        [labels[a], labels[b]] = [labels[b], labels[a]];
    }
    for (let i = 0; i < n0; i++) {
        persona[i] = labels[i];
        active[i] = 1;
        joinDay[i] = 0;
        firstTxDay[i] = FIRST_TX_NEVER;
    }

    // --- initial balances by persona weight, with an optional log-normal
    // spread inside each persona (balanceSigma = 0 keeps everyone equal);
    // remainder to agent 0 so the sum is exact ---
    const initW = new Float64Array(n0);
    let sumW = 0;
    for (let i = 0; i < n0; i++) {
        const p = personas[persona[i]];
        const sigma = p.balanceSigma ?? 0;
        initW[i] = p.balanceWeight * (sigma > 0 ? Math.exp(gauss(0, sigma, rng)) : 1);
        sumW += initW[i];
    }
    let distributed = 0;
    for (let i = 0; i < n0; i++) {
        balance[i] = Math.floor(token.initialSupply * initW[i] / sumW);
        distributed += balance[i];
    }
    balance[0] += token.initialSupply - distributed;

    for (let i = 0; i < n0; i++) g.addNode(i);

    // --- mutable sim state ---
    let agentCount = n0;
    let activeCount = n0;
    const personaActiveCount = new Array(personas.length).fill(0);
    for (let i = 0; i < n0; i++) personaActiveCount[persona[i]]++;
    // explorer-style daily activity: an account is "active" on a day when it
    // sent or received at least one transfer that day
    const sentTodayFlag = new Uint8Array(maxAgents);
    const recvTodayFlag = new Uint8Array(maxAgents);
    let dailySenders = 0;
    let dailyReceivers = 0;
    let dailyActive = 0;
    let totalRaw = token.initialSupply;
    let day = 0;
    let prevFactor = 1;
    let cumulativeMinted = 0;
    let cumulativeMintedDisplay = 0;
    let decayLostDisplay = 0;
    const supplyLimit = rawSupplyLimit(token.maxIncreaseOfTotalSupplyBp);
    let aborted = totalRaw > supplyLimit;

    let midnightSupply = totalRaw;
    let mintedGlobal = 0;
    let mintedGuest = 0;
    let mintedThisDay = 0;
    let volumeThisDay = 0;
    let cumulativeVolume = 0;
    let cumulativeVolumeDisplay = 0;
    let txThisDay = 0;
    let cumulativeTxCount = 0;
    let cumulativeMsgChars = 0;

    // --- PCE link (PCEToken.sol) ---
    // PCE itself decays 0.2% per week (Wednesday boundaries on-chain; here a
    // plain 7-day schedule): pceFactor(d) = 0.998^floor(d/7), same WAD math.
    // createToken: initial community supply = depositedPCE x dilutionFactor,
    // so the initial reserve is initialSupply / dilutionFactor.
    // swapToLocalToken: display = pce x dilution x cFactor/pceFactor, minted as
    // raw = display / cFactor = pce x dilution / pceFactor; the PCE is locked
    // into the reserve (not burned).
    const pceCfg = params.pce ?? {};
    const dilution = Math.min(1000, Math.max(0.1, pceCfg.dilutionFactor ?? 1));
    const swapInPerDay = Math.max(0, pceCfg.swapInPerDay ?? 0);
    const swapInMeanPce = Math.max(0, pceCfg.swapInMeanPce ?? 0);
    // meta-transaction relayer fee (PIP-13): EVERY transfer is a meta-tx. The
    // sender is charged the fee in community tokens (burned) and the relayer
    // is paid the PCE-denominated fee out of the community's reserve
    // (_collectFeeAsPCE + swapFeeFromLocalToken). With an empty reserve no
    // relayer will carry the tx, so transfers halt.
    const metaTxFeePce = Math.max(0, pceCfg.metaTxFeePce ?? 0);
    let depositedPce = token.initialSupply / dilution;
    let swapInPceTotal = 0;
    let swapInCountTotal = 0;
    let swapInRawTotal = 0;
    let feePceTotal = 0;
    let feeBurnedRawTotal = 0;
    let feeStarvedDay = -1;          // first day a tx failed for lack of reserve
    let rawFeeToday = 0;             // community tokens burned per tx (raw)
    let feePceToday = 0;
    let feeBurnedToday = 0;

    const churnDaily = pop.churnAnnualPct > 0
        ? 1 - Math.pow(1 - Math.min(pop.churnAnnualPct, 99.9) / 100, 1 / 365)
        : 0;
    // share of the balance a leaver spends (one farewell transfer) before
    // going dormant; 0 = abandon the full balance (pre-feature behaviour)
    const exitSpendFrac = Math.min(1, Math.max(0, (pop.exitSpendPct ?? 0) / 100));

    // --- decay-response behaviour (decay elasticity) ---
    // "Rather spend it than lose it": activity scales with how fast holdings decay.
    // Baseline boost uses the annualized decay fraction; on the eve of a decay
    // application there is an extra spike proportional to the per-application loss
    // (Woergl-style pre-decay spending). decayResponse = 0 disables both.
    const perApplicationDecay = token.decreaseIntervalDays > 0
        ? 1 - token.afterDecreaseBp / BP
        : 0;
    const annualDecay = token.decreaseIntervalDays > 0
        ? 1 - Math.pow(token.afterDecreaseBp / BP, 365 / token.decreaseIntervalDays)
        : 0;
    const boostCap = Math.max(1, behavior.decayBoostCap ?? 5);   // frequency boost ceiling
    const eveGain = Math.max(0, behavior.eveSpikeGain ?? 10);    // eve spike = response x loss x gain
    const lambdaBoost = personas.map((p) =>
        Math.min(boostCap, 1 + (p.decayResponse ?? 0) * annualDecay));
    const eveSpike = personas.map((p) =>
        1 + (p.decayResponse ?? 0) * perApplicationDecay * eveGain);

    let txBuf = new Int32Array(1024);
    const sortBuf = () => balance.slice(0, agentCount);

    const stride = Math.max(1, Math.floor(days / 120));
    const snapshots = [];
    const res = {
        day: [], factor: [], totalRaw: [], totalDisplay: [],
        mintedToday: [], midnightSupply: [], gini: [], top10: [],
        activeCount: [], agentCount: [],
        volumeToday: [], txCount: [],
        personaCounts: personas.map(() => []), // enrolled members per persona
        dailyActive: [], dailySenders: [], dailyReceivers: [],
        decayToday: [],
        pceFactor: [], pceValue: [], depositedPce: [],
        swapInPce: [], swapInCount: [], swapInMinted: [],
        feePce: [], feeBurned: [],
    };

    function msgLenFor(pIdx) {
        const p = personas[pIdx];
        return p.msgMin + ((rng() * (p.msgMax - p.msgMin + 1)) | 0);
    }

    function samplePersona() {
        let r = rng() * totalShare;
        for (let idx = 0; idx < personas.length; idx++) {
            r -= personas[idx].share;
            if (r <= 0) return idx;
        }
        return personas.length - 1;
    }

    function performTx(sender, recipient, rawAmount, msgChars, d) {
        if (rawAmount <= 0) return false;
        if (metaTxFeePce > 0 && depositedPce < metaTxFeePce) {
            // reserve exhausted: no relayer accepts any meta-tx
            if (feeStarvedDay < 0) feeStarvedDay = d;
            return false;
        }
        const rawBalance = balance[sender];
        if (rawBalance < rawAmount + rawFeeToday) return false;
        // A sender with balance > 0 always has firstTxDay set (balance only arrives
        // via a receive, which stamps it below; the initial cohort is FIRST_TX_NEVER),
        // but treat UNSET as guest anyway — the contract stamps firstTransactionTime
        // before computing the mint, so a hypothetical first-ever send is a guest.
        const isGuest = firstTxDay[sender] !== FIRST_TX_NEVER
            && (firstTxDay[sender] === FIRST_TX_UNSET || firstTxDay[sender] === d);
        const mint = arigatoCompute({
            midnightTotalSupply: midnightSupply,
            maxIncreaseOfTotalSupplyBp: token.maxIncreaseOfTotalSupplyBp,
            maxIncreaseBp: token.maxIncreaseBp,
            maxUsageBp: token.maxUsageBp,
            changeBp: token.changeBp,
            mintedTodayGlobal: mintedGlobal,
            mintedTodayGuest: mintedGuest,
            rawAmount,
            rawBalance,
            messageCharacters: msgChars,
            isGuest,
            midnightBalance: midnightBalance[sender],
            actualMintedSender: mintedTodaySender[sender],
        });
        balance[sender] -= rawAmount;
        balance[recipient] += rawAmount;
        receivedToday[recipient] += rawAmount;
        volumeThisDay += rawAmount;
        txThisDay++;
        statTxCount[sender]++;
        statRxCount[recipient]++;
        cumulativeMsgChars += msgChars;
        if (!sentTodayFlag[sender]) {
            sentTodayFlag[sender] = 1;
            dailySenders++;
            if (!recvTodayFlag[sender]) dailyActive++;
        }
        if (!recvTodayFlag[recipient]) {
            recvTodayFlag[recipient] = 1;
            dailyReceivers++;
            if (!sentTodayFlag[recipient]) dailyActive++;
        }
        statTxAmount[sender] += rawAmount;
        statRxAmount[recipient] += rawAmount;
        // the contract stamps firstTransactionTime on the first transfer that
        // touches an account (PCECommunityToken._beforeTokenTransferAtAddress)
        if (firstTxDay[recipient] === FIRST_TX_UNSET) firstTxDay[recipient] = d;
        if (firstTxDay[sender] === FIRST_TX_UNSET) firstTxDay[sender] = d;
        // meta-tx fee: burn from the sender, pay the relayer from the reserve
        if (metaTxFeePce > 0) {
            balance[sender] -= rawFeeToday;
            totalRaw -= rawFeeToday;
            depositedPce -= metaTxFeePce;
            feePceToday += metaTxFeePce;
            feeBurnedToday += rawFeeToday;
        }
        if (mint > 0) {
            balance[sender] += mint;
            totalRaw += mint;
            mintedGlobal += mint;
            mintedThisDay += mint;
            mintedTodaySender[sender] += mint;
            statMinted[sender] += mint;
            if (isGuest) mintedGuest += mint;
        }
        return true;
    }

    function addAgent(d) {
        const i = agentCount++;
        // mean balance of the community the newcomer is joining (dormant balances
        // included in the numerator by design; see README metrics notes)
        const avg = totalRaw / Math.max(1, activeCount);
        persona[i] = samplePersona();
        active[i] = 1;
        activeCount++;
        personaActiveCount[persona[i]]++;
        joinDay[i] = d;
        // set by the first transfer that actually touches the account, so a failed
        // welcome transfer does not consume the guest day (contract equivalence)
        firstTxDay[i] = FIRST_TX_UNSET;
        balance[i] = 0;
        midnightBalance[i] = 0;
        mintedTodaySender[i] = 0;
        receivedToday[i] = 0;
        receivedYesterday[i] = 0;
        statTxCount[i] = 0;
        statRxCount[i] = 0;
        statTxAmount[i] = 0;
        statRxAmount[i] = 0;
        statMinted[i] = 0;
        g.addNode(i);
        let s = -1;
        let best = 0;
        for (const j of g.adj[i]) {
            if (active[j] && balance[j] > best) { best = balance[j]; s = j; }
        }
        if (s >= 0) {
            const amount = Math.min(
                Math.floor(avg * welcomeFrac),
                Math.floor(balance[s] * welcomeCap)
            );
            performTx(s, i, amount, msgLenFor(persona[s]), d);
        }
    }

    function stepDay() {
        const d = day;
        const fWad = factorForDay(d, token.decreaseIntervalDays, token.afterDecreaseBp);
        const f = Number(fWad) / 1e18;
        // PCE decays 0.2% per week (PCEToken.sol, Wednesday boundaries -> a
        // plain 7-day schedule here), exact WAD math shared with the community
        const pceF = Number(factorForDay(d, 7, 9980)) / 1e18;
        // today's meta-tx fee: display = feePce x dilution x f/pceF, burned as
        // raw = display / f = feePce x dilution / pceF (floored like mulDiv)
        rawFeeToday = metaTxFeePce > 0 ? Math.floor(metaTxFeePce * dilution / pceF) : 0;
        feePceToday = 0;
        feeBurnedToday = 0;
        const decayThisDay = totalRaw * (prevFactor - f);
        decayLostDisplay += decayThisDay;

        // midnight snapshot + daily counter reset (contract does this lazily on the
        // first tx of the day; doing it eagerly at day start is equivalent)
        midnightBalance.set(balance.subarray(0, agentCount));
        midnightSupply = totalRaw;
        mintedTodaySender.fill(0, 0, agentCount);
        mintedGlobal = 0;
        mintedGuest = 0;
        mintedThisDay = 0;
        volumeThisDay = 0;
        txThisDay = 0;
        // yesterday's receipts drive today's recirculation spending
        [receivedYesterday, receivedToday] = [receivedToday, receivedYesterday];
        receivedToday.fill(0, 0, agentCount);
        sentTodayFlag.fill(0, 0, agentCount);
        recvTodayFlag.fill(0, 0, agentCount);
        dailySenders = 0;
        dailyReceivers = 0;
        dailyActive = 0;

        // churn: leavers keep their balance (dormant wallets decay away in display value)
        if (d > 0 && churnDaily > 0) {
            for (let i = 0; i < agentCount; i++) {
                if (active[i] && rng() < churnDaily) {
                    // farewell spend: as a rule, use the balance up before leaving
                    if (exitSpendFrac > 0 && balance[i] >= 1) {
                        const amount = Math.min(
                            Math.floor(balance[i] * exitSpendFrac),
                            balance[i] - rawFeeToday
                        );
                        if (amount >= 1) {
                            const r = g.pickPartner(i, active, true, agentCount);
                            if (r >= 0) performTx(i, r, amount, msgLenFor(persona[i]), d);
                        }
                    }
                    active[i] = 0;
                    activeCount--;
                    personaActiveCount[persona[i]]--;
                }
            }
        }

        // population growth
        const target = Math.min(Math.round(growthTarget(pop, d)), maxAgents);
        while (agentCount < target) addAgent(d);

        // PCE -> community swap-ins: members deposit PCE and receive freshly
        // minted community tokens (swapToLocalToken); Poisson event count with
        // a +/-50% jittered PCE amount per event
        let swapInPceToday = 0;
        let swapInCountToday = 0;
        let swapInRawToday = 0;
        if (swapInPerDay > 0 && swapInMeanPce > 0 && !aborted) {
            const events = poisson(swapInPerDay, rng);
            for (let k = 0; k < events; k++) {
                const pceAmount = swapInMeanPce * (0.5 + rng());
                const raw = Math.floor(pceAmount * dilution / pceF);
                if (raw < 1) continue;
                if (totalRaw + raw > supplyLimit) { aborted = true; break; }
                // any active member may swap in; uniform pick with a scan fallback
                let recipient = -1;
                const startAt = (rng() * agentCount) | 0;
                for (let o = 0; o < agentCount; o++) {
                    const j = (startAt + o) % agentCount;
                    if (active[j]) { recipient = j; break; }
                }
                if (recipient < 0) break;
                balance[recipient] += raw;
                totalRaw += raw;
                // on-chain the mint passes _beforeTokenTransferAtAddress and
                // stamps firstTransactionTime, which drives guest detection
                if (firstTxDay[recipient] === FIRST_TX_UNSET) firstTxDay[recipient] = d;
                depositedPce += pceAmount;
                swapInPceToday += pceAmount;
                swapInCountToday++;
                swapInRawToday += raw;
            }
            swapInPceTotal += swapInPceToday;
            swapInCountTotal += swapInCountToday;
            swapInRawTotal += swapInRawToday;
        }

        // generate the day's transfers, then shuffle so the daily mint caps are not
        // consumed in a biased order. Entry >= 0: regular send by agent i.
        // Entry < 0 (encoded -(i+1)): recirculation spend by agent i.
        const isDecayEve = token.decreaseIntervalDays > 0
            && (d + 1) % token.decreaseIntervalDays === 0;
        let txCount = 0;
        const pushTx = (code) => {
            if (txCount === txBuf.length) {
                const grown = new Int32Array(txBuf.length * 2);
                grown.set(txBuf);
                txBuf = grown;
            }
            txBuf[txCount++] = code;
        };
        for (let i = 0; i < agentCount; i++) {
            if (!active[i]) continue;
            const pi = persona[i];
            let lambda = personas[pi].lambda * lambdaBoost[pi];
            if (isDecayEve) lambda *= eveSpike[pi];
            const n = poisson(lambda, rng);
            for (let t = 0; t < n; t++) pushTx(i);
            if ((personas[pi].recircBp ?? 0) > 0 && receivedYesterday[i] > 0) pushTx(-(i + 1));
        }
        for (let a = txCount - 1; a > 0; a--) {
            const b = (rng() * (a + 1)) | 0;
            const tmp = txBuf[a];
            txBuf[a] = txBuf[b];
            txBuf[b] = tmp;
        }
        for (let t = 0; t < txCount; t++) {
            const code = txBuf[t];
            if (code < 0) {
                // recirculation: spend a share of yesterday's receipts back into the
                // neighborhood (suppliers/staff), unweighted by merchant hub status
                const i = -code - 1;
                if (!active[i]) continue;
                const p = personas[persona[i]];
                const amount = Math.min(
                    balance[i],
                    Math.floor(receivedYesterday[i] * (p.recircBp ?? 0) / BP)
                );
                if (amount < 1) continue;
                const r = g.pickPartner(i, active, false, agentCount);
                if (r < 0) continue;
                performTx(i, r, amount, msgLenFor(persona[i]), d);
                continue;
            }
            const i = code;
            const bal = balance[i];
            if (bal < 1) continue;
            const p = personas[persona[i]];
            let bpAmount = Math.round(gauss(p.amountMeanBp, p.amountSdBp, rng));
            if (bpAmount < 1) bpAmount = 1;
            else if (bpAmount > 9000) bpAmount = 9000;
            const amount = Math.floor(bal * bpAmount / BP);
            if (amount < 1) continue;
            const r = g.pickPartner(i, active, true, agentCount);
            if (r < 0) continue;
            performTx(i, r, amount, msgLenFor(persona[i]), d);
        }

        // record
        res.day.push(d);
        res.factor.push(f);
        res.totalRaw.push(totalRaw);
        res.totalDisplay.push(totalRaw * f);
        res.mintedToday.push(mintedThisDay);
        res.midnightSupply.push(midnightSupply);
        res.activeCount.push(activeCount);
        res.agentCount.push(agentCount);
        res.personaCounts.forEach((arr, pi) => arr.push(personaActiveCount[pi]));
        res.dailyActive.push(dailyActive);
        res.dailySenders.push(dailySenders);
        res.dailyReceivers.push(dailyReceivers);
        res.decayToday.push(decayThisDay);
        res.pceFactor.push(pceF);
        // PCE-redemption value of the whole supply (swapFromLocalToken math):
        // display x (1/dilution) x pceF/cF = totalRaw x pceF / dilution
        res.pceValue.push(totalRaw * pceF / dilution);
        res.depositedPce.push(depositedPce);
        res.swapInPce.push(swapInPceToday);
        res.swapInCount.push(swapInCountToday);
        res.swapInMinted.push(swapInRawToday * f);
        res.feePce.push(feePceToday);
        res.feeBurned.push(feeBurnedToday * f);
        feePceTotal += feePceToday;
        feeBurnedRawTotal += feeBurnedToday;
        res.volumeToday.push(volumeThisDay);
        res.txCount.push(txThisDay);
        cumulativeMinted += mintedThisDay;
        cumulativeMintedDisplay += mintedThisDay * f;
        cumulativeVolume += volumeThisDay;
        cumulativeVolumeDisplay += volumeThisDay * f;
        cumulativeTxCount += txThisDay;

        const sorted = sortBuf();
        sorted.sort();
        let weighted = 0;
        let sum = 0;
        for (let i = 0; i < agentCount; i++) {
            weighted += (2 * (i + 1) - agentCount - 1) * sorted[i];
            sum += sorted[i];
        }
        res.gini.push(agentCount > 1 && sum > 0 ? weighted / (agentCount * sum) : 0);
        const topN = Math.max(1, Math.ceil(agentCount * 0.1));
        let topSum = 0;
        for (let i = agentCount - topN; i < agentCount; i++) topSum += sorted[i];
        res.top10.push(sum > 0 ? topSum / sum : 0);

        if (d % stride === 0 || d === days - 1) {
            snapshots.push({
                day: d,
                factor: f,
                count: agentCount,
                balance: balance.slice(0, agentCount),
                active: active.slice(0, agentCount),
            });
        }

        prevFactor = f;
        day++;
        if (totalRaw > supplyLimit) aborted = true;
    }

    return {
        params,
        days,
        get day() { return day; },
        get aborted() { return aborted; },
        finished() { return day >= days || aborted; },
        runDays(n) {
            for (let c = 0; c < n && day < days && !aborted; c++) stepDay();
            return day;
        },
        results: res,
        snapshots,
        graph: g,
        agents: {
            balance, persona, active, joinDay, firstTxDay,
            txCount: statTxCount, rxCount: statRxCount,
            txAmount: statTxAmount, rxAmount: statRxAmount, minted: statMinted,
            get count() { return agentCount; },
        },
        totals() {
            return {
                minted: cumulativeMinted,
                mintedDisplay: cumulativeMintedDisplay,
                decayLostDisplay,
                volume: cumulativeVolume,
                volumeDisplay: cumulativeVolumeDisplay,
                txCount: cumulativeTxCount,
                msgChars: cumulativeMsgChars,
                swapInPce: swapInPceTotal,
                swapInCount: swapInCountTotal,
                swapInRaw: swapInRawTotal,
                depositedPce,
                dilution,
                feePce: feePceTotal,
                feeBurnedRaw: feeBurnedRawTotal,
                feeStarvedDay,
            };
        },
    };
}

// Convenience for tests: run a sim to completion.
export function runAll(params) {
    const sim = createSim(params);
    while (!sim.finished()) sim.runDays(365);
    return sim;
}
