import Chart from "https://cdn.jsdelivr.net/npm/chart.js@4.4.9/auto/+esm";
import { createSim, estimateTxCount, growthTarget, BP } from './engine.js';
import { createNetworkView, PERSONA_COLORS } from './network-view.js';
import { applyI18n, detectLang, t } from './i18n.js';
import { bandSeries, median } from './stats.js';
import { createRanking } from './ranking.js';
import { identiconURL } from './identicon.js';

// Series colors (dataviz reference palette, validated against the white surface)
const COLOR_DISPLAY = '#2a78d6'; // display-value series (balance / supply)
const COLOR_RAW = '#898781';     // raw reference series, dashed
const COLOR_MINT = '#199e70';    // daily mint bars
const COLOR_DECAY = '#e34948';   // daily decay bars
const COLOR_GINI = '#4a3aa7';
const COLOR_TOP10 = '#eb6834';
const GRID = '#e1e0d9';
const TICK = '#898781';
const LEGEND_INK = '#52514e';

const TX_WARN_THRESHOLD = 20000000;

let lang = detectLang();
let sim = null;
let networkView = null;
let ranking = null;
let mc = null;        // multi-seed aggregate: { runs, labels, bands, summary, baseSeed }
let lastSweep = null; // { axes, seeds, metrics } for i18n re-render
let sweepRuns = null; // { axes, combos, seeds, baseParams, byCombo }
let activePoint = -1; // index into sweepRuns.combos shown in the detail view
let busy = false;
const charts = {};

const $ = (id) => document.getElementById(id);

// value of a radio group container (replaces <select>.value)
const radioVal = (id) => $(id).querySelector('input[type="radio"]:checked')?.value;

const PERSONA_MAX = PERSONA_COLORS.length; // color slots bound the persona count

// [label key, input class, {attrs}, unit key | null, help key]
const PERSONA_FIELDS = [
    ['shareHead', 'p-share', { min: '0', max: '100', step: '1' }, 'unitPct'],
    ['lambdaHead', 'p-lambda', { min: '0', max: '50', step: '0.1' }, 'unitTxDay'],
    ['amountMeanHead', 'p-amountMean', { min: '0.1', max: '90', step: '0.5' }, 'unitPct'],
    ['amountSdHead', 'p-amountSd', { min: '0', max: '90', step: '0.5' }, 'unitPct'],
    ['msgMinHead', 'p-msgMin', { min: '0', max: '10', step: '1' }, 'unitChars'],
    ['msgMaxHead', 'p-msgMax', { min: '0', max: '10', step: '1' }, 'unitChars'],
    ['weightHead', 'p-weight', { min: '0.01', max: '100', step: '0.1' }, 'unitTimes'],
    ['balanceSigmaHead', 'p-balanceSigma', { min: '0', max: '2', step: '0.1' }, null],
    ['decayResponseHead', 'p-decayResponse', { min: '0', max: '5', step: '0.1' }, null],
    ['recircHead', 'p-recirc', { min: '0', max: '100', step: '5' }, 'unitPct'],
    ['recvWeightHead', 'p-recvWeight', { min: '0', max: '50', step: '0.5' }, 'unitTimes'],
];

const DEFAULT_PERSONAS = [
    { nameKey: 'personaActive', values: [20, 1.5, 8, 4, 8, 10, 1.0, 0.5, 1.0, 0, 1] },
    { nameKey: 'personaCasual', values: [50, 0.2, 5, 3, 3, 6, 0.7, 0.5, 0.5, 0, 1] },
    { nameKey: 'personaHoarder', values: [15, 0.05, 2, 1, 0, 2, 2.0, 0.5, 0.2, 0, 1] },
    { nameKey: 'personaMerchant', values: [15, 0.5, 20, 8, 1, 3, 3.0, 0.5, 0.3, 70, 3] },
];

let personaUid = 0;

function personaRows() {
    return [...$('personaCards').children];
}

function refreshPersonaRows() {
    const cards = personaRows();
    cards.forEach((card, idx) => {
        card.querySelector('.persona-dot').style.background = PERSONA_COLORS[idx % PERSONA_COLORS.length];
        card.querySelector('.remove-btn').disabled = cards.length <= 1;
    });
    $('addPersona').disabled = cards.length >= PERSONA_MAX;
}

// one card per persona: [dot | name | -] header, a 2-column field grid (every
// field has its own "?"), and a card-local help panel the "?"s share
function addPersonaRow(name, values) {
    const uid = `pf-${personaUid++}`;
    const card = document.createElement('div');
    card.className = 'persona-card';

    const head = document.createElement('div');
    head.className = 'persona-card-head';
    const dot = document.createElement('span');
    dot.className = 'persona-dot';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'p-name';
    nameInput.value = name;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'remove-btn';
    rm.textContent = '\u2212';
    rm.addEventListener('click', () => {
        if (personaRows().length > 1) {
            card.remove();
            refreshPersonaRows();
            updateEstimates();
        }
    });
    head.appendChild(dot);
    head.appendChild(nameInput);
    head.appendChild(rm);
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'persona-fields';
    PERSONA_FIELDS.forEach(([labelKey, cls, attrs, unitKey], fi) => {
        const field = document.createElement('div');
        field.className = 'p-field';
        const label = document.createElement('label');
        const span = document.createElement('span');
        span.dataset.i18n = labelKey;
        span.textContent = t(lang, labelKey);
        label.appendChild(span);
        const help = document.createElement('button');
        help.type = 'button';
        help.className = 'help-btn';
        help.dataset.help = `help_${labelKey}`;
        help.dataset.helpTarget = uid;
        help.setAttribute('aria-label', 'Help');
        help.textContent = '?';
        label.appendChild(help);
        field.appendChild(label);
        const ug = document.createElement('div');
        ug.className = 'unit-group';
        const input = document.createElement('input');
        input.type = 'number';
        input.className = cls;
        for (const [a, v] of Object.entries(attrs)) input.setAttribute(a, v);
        input.value = String(values[fi]);
        ug.appendChild(input);
        if (unitKey) {
            const suffix = document.createElement('span');
            suffix.className = 'unit-suffix';
            suffix.dataset.i18n = unitKey;
            suffix.textContent = t(lang, unitKey);
            ug.appendChild(suffix);
        }
        field.appendChild(ug);
        grid.appendChild(field);
    });
    card.appendChild(grid);

    const panel = document.createElement('div');
    panel.className = 'help-panel';
    panel.dataset.helpPanel = uid;
    panel.hidden = true;
    card.appendChild(panel);

    $('personaCards').appendChild(card);
    refreshPersonaRows();
}

function initPersonaTable() {
    for (const def of DEFAULT_PERSONAS) addPersonaRow(t(lang, def.nameKey), def.values);
}

// Parse a numeric input, clamped to its own min/max attributes — typed-in
// values bypass the browser's spinner limits and can break engine invariants.
function numOf(el) {
    let v = parseFloat(el.value);
    if (!Number.isFinite(v)) return NaN;
    if (el.min !== '' && v < parseFloat(el.min)) v = parseFloat(el.min);
    if (el.max !== '' && v > parseFloat(el.max)) v = parseFloat(el.max);
    return v;
}

function num(id) {
    return numOf($(id));
}

// The run block was removed from the UI: always a single run with seed 42.
function parseSeeds() {
    return [42];
}

// The UI speaks percent; the engine keeps the contract's basis-point units.
const pctToBp = (pct) => Math.round(pct * 100);
// 0.2 (% decay per application) -> afterDecreaseBp 9980 (keep 99.8%)
const decayRateToAfterBp = (pct) => Math.round((100 - pct) * 100);

function readParams() {
    const errors = [];
    const personas = personaRows().map((tr) => {
        const v = (cls) => numOf(tr.querySelector(`.${cls}`));
        return {
            name: tr.querySelector('.p-name').value.trim() || '?',
            share: v('p-share'),
            lambda: v('p-lambda'),
            amountMeanBp: pctToBp(v('p-amountMean')),
            amountSdBp: pctToBp(v('p-amountSd')),
            msgMin: Math.round(v('p-msgMin')),
            msgMax: Math.round(v('p-msgMax')),
            balanceWeight: v('p-weight'),
            balanceSigma: v('p-balanceSigma'),
            decayResponse: v('p-decayResponse'),
            recircBp: pctToBp(v('p-recirc')),
            recvWeight: v('p-recvWeight'),
        };
    });
    const seeds = parseSeeds();
    if (!seeds) errors.push(t(lang, 'invalidInput'));
    // shares are relative weights: any positive sum is normalized to 100
    const shareSum = personas.reduce((s, p) => s + p.share, 0);
    if (shareSum > 0) {
        for (const p of personas) p.share = (p.share / shareSum) * 100;
    } else {
        errors.push(t(lang, 'invalidInput'));
    }
    for (const p of personas) {
        if (p.msgMax < p.msgMin) p.msgMax = p.msgMin;
    }

    const params = {
        token: {
            initialSupply: Math.round(num('initialSupply')),
            decreaseIntervalDays: Math.round(firstValue('decreaseIntervalDays')),
            afterDecreaseBp: decayRateToAfterBp(firstValue('decayRatePct')),
            maxIncreaseOfTotalSupplyBp: pctToBp(firstValue('maxIncreaseOfTotalSupplyPct')),
            maxIncreaseBp: pctToBp(firstValue('maxIncreasePct')),
            maxUsageBp: pctToBp(firstValue('maxUsagePct')),
            changeBp: pctToBp(firstValue('changePct')),
        },
        population: {
            initialCount: Math.round(firstValue('initialCount')),
            days: Math.round(num('days')),
            growthModel: radioVal('growthModel'),
            growthPerDay: num('growthPerDay'),
            growthRatePct: num('growthRatePct'),
            logisticK: Math.round(num('logisticK')),
            logisticR: num('logisticR'),
            churnAnnualPct: firstValue('churnAnnualPct'),
            exitSpendPct: num('exitSpendPct'),
            welcomeAvgPct: num('welcomeAvgPct'),
            welcomeCapPct: num('welcomeCapPct'),
        },
        pce: {
            dilutionFactor: firstValue('dilutionFactor'),
            swapInPerDay: firstValue('pceSwapInPerDay'),
            swapInMeanPce: firstValue('pceSwapInMeanPce'),
            metaTxFeePce: firstValue('metaTxFeePce'),
        },
        graph: {
            model: radioVal('graphModel'),
            m: Math.round(num('graphDegree')),
            k: Math.round(num('graphDegree')),
            kIn: Math.round(num('graphDegree')),
            pOut: 0.1,
            clusterTargetSize: Math.round(num('clusterSize')),
        },
        behavior: {
            decayBoostCap: num('decayBoostCap'),
            eveSpikeGain: num('eveSpikeGain'),
        },
        run: {
            seed: seeds ? seeds[0] : 0,
        },
        personas,
    };

    const flat = [
        ...Object.values(params.token), ...Object.values(params.population).filter((v) => typeof v === 'number'),
        ...Object.values(params.pce),
        params.graph.m, params.graph.clusterTargetSize,
        ...Object.values(params.behavior),
        params.run.seed,
        ...personas.flatMap((p) => [p.share, p.lambda, p.amountMeanBp, p.amountSdBp, p.msgMin, p.msgMax, p.balanceWeight, p.balanceSigma, p.decayResponse, p.recircBp, p.recvWeight]),
    ];
    if (flat.some((v) => !Number.isFinite(v))) errors.push(t(lang, 'invalidInput'));
    return { params, errors, seeds };
}

// ---------------------------------------------------------------- charts

function fmt(v) {
    return new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US', { maximumFractionDigits: 0 }).format(v);
}

// daysAxis: the x axis is elapsed days -> ticks and tooltip titles read "Day N"
// / "N 日目"; sweep charts pass false (their x axis is the swept parameter).
function baseOptions(showLegend, daysAxis = true) {
    const dayTick = {
        callback(value) {
            return t(lang, 'dayLabel', { d: this.getLabelForValue(value) });
        },
    };
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: {
                display: showLegend,
                labels: {
                    boxWidth: 12, boxHeight: 12, color: LEGEND_INK, usePointStyle: false,
                    filter: (item) => !item.text.startsWith('_'),
                },
            },
            tooltip: {
                filter: (item) => !item.dataset.label.startsWith('_'),
                callbacks: {
                    // big values as comma-separated integers, ratios with 3 decimals
                    label: (item) => {
                        const v = item.parsed.y;
                        const s = Math.abs(v) >= 10 ? fmt(v) : v.toFixed(3);
                        return `${item.dataset.label}: ${s}`;
                    },
                    ...(daysAxis ? {
                        title: (items) => (items.length ? t(lang, 'dayLabel', { d: items[0].label }) : ''),
                    } : {}),
                },
            },
        },
        scales: {
            x: {
                grid: { display: false },
                border: { color: '#c3c2b7' },
                ticks: { color: TICK, maxTicksLimit: 8, maxRotation: 0, ...(daysAxis ? dayTick : {}) },
                title: daysAxis
                    ? { display: false }
                    : { display: true, text: '', color: TICK, font: { size: 11 } },
            },
            y: {
                beginAtZero: true,
                grid: { color: GRID },
                border: { display: false },
                ticks: { color: TICK, maxTicksLimit: 6 },
            },
        },
    };
}

function line(label, data, color, dashed = false) {
    return {
        label,
        data,
        borderColor: color,
        backgroundColor: color,
        borderWidth: 2,
        borderDash: dashed ? [5, 4] : undefined,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0,
        fill: false,
    };
}

function makeChart(id, config) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id).getContext('2d'), config);
}

function hexToRgba(hex, alpha) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`;
}

// A 10th-90th percentile band as two hidden-line datasets (upper, then lower
// filling to the previous dataset). '_'-prefixed labels are excluded from the
// legend and tooltip by the baseOptions filters.
function bandDatasets(p10, p90, color) {
    const fillColor = hexToRgba(color, 0.15);
    const hidden = {
        borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, tension: 0,
        backgroundColor: fillColor,
    };
    return [
        { label: '_band-upper', data: p90, fill: false, ...hidden },
        { label: '_band-lower', data: p10, fill: '-1', ...hidden },
    ];
}

function renderCharts() {
    if (mc) {
        renderChartsMC();
        return;
    }
    const r = sim.results;
    const labels = r.day;

    makeChart('chartSupply', {
        type: 'line',
        data: {
            labels,
            datasets: [
                line(t(lang, 'seriesDisplaySupply'), r.totalDisplay, COLOR_DISPLAY),
                line(t(lang, 'seriesRawSupply'), r.totalRaw, COLOR_RAW, true),
            ],
        },
        options: baseOptions(true),
    });

    makeChart('chartMint', {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: t(lang, 'seriesMint'),
                data: r.mintedToday,
                backgroundColor: COLOR_MINT,
                borderWidth: 0,
                barPercentage: 1.0,
                categoryPercentage: 0.9,
            }],
        },
        options: baseOptions(false),
    });

    const distOptions = baseOptions(true);
    distOptions.scales.y.suggestedMax = 1;
    makeChart('chartDist', {
        type: 'line',
        data: {
            labels,
            datasets: [
                line(t(lang, 'seriesGini'), r.gini, COLOR_GINI),
                line(t(lang, 'seriesTop10'), r.top10, COLOR_TOP10),
            ],
        },
        options: distOptions,
    });
    renderRepresentativeCharts();
}

// single-series daily bar chart from the representative run
function dailyBarChart(id, labelKey, data, color) {
    makeChart(id, {
        type: 'bar',
        data: {
            labels: sim.results.day,
            datasets: [{
                label: t(lang, labelKey),
                data,
                backgroundColor: color,
                borderWidth: 0,
                barPercentage: 1.0,
                categoryPercentage: 0.9,
            }],
        },
        options: baseOptions(false),
    });
}

// Charts that always show the representative (first-seed) run, in both the
// single-seed and the multi-seed (MC) modes.
function renderRepresentativeCharts() {
    const r = sim.results;

    // decay only happens on application days: plot just those points so the
    // index-mode tooltip does not flicker across the empty days
    const decayDays = [];
    const decayVals = [];
    r.decayToday.forEach((v, i) => {
        if (v > 0) { decayDays.push(r.day[i]); decayVals.push(v); }
    });
    $('chartDecayDaily').closest('.chart-card').hidden = decayVals.length === 0;
    makeChart('chartDecayDaily', {
        type: 'bar',
        data: {
            labels: decayDays,
            datasets: [{
                label: t(lang, 'seriesDecay'),
                data: decayVals,
                backgroundColor: COLOR_DECAY,
                borderWidth: 0,
                barPercentage: 1.0,
                categoryPercentage: 0.9,
            }],
        },
        options: baseOptions(false),
    });
    dailyBarChart('chartTxCount', 'seriesTxCount', r.txCount, COLOR_GINI);
    dailyBarChart('chartVolume', 'seriesVolume',
        r.volumeToday.map((v, i) => v * r.factor[i]), COLOR_TOP10);

    // PCE link: redemption value of the whole supply vs the locked reserve
    makeChart('chartPceValue', {
        type: 'line',
        data: {
            labels: r.day,
            datasets: [
                line(t(lang, 'seriesPceValue'), r.pceValue, COLOR_DISPLAY),
                line(t(lang, 'seriesPceReserve'), r.depositedPce, COLOR_MINT),
            ],
        },
        options: baseOptions(true),
    });

    // backing: how much of the supply's PCE-redemption value the locked
    // reserve actually covers (>= 1 means fully backed)
    makeChart('chartReserveRatio', {
        type: 'line',
        data: {
            labels: r.day,
            datasets: [
                line(t(lang, 'seriesReserveRatio'),
                    r.depositedPce.map((v, i) => v / (r.pceValue[i] || 1)), COLOR_GINI),
            ],
        },
        options: baseOptions(false),
    });

    // cumulative PCE swap inflow; the card hides when swap-ins are disabled
    const hasSwapIn = r.swapInPce.some((v) => v > 0);
    $('chartSwapIn').closest('.chart-card').hidden = !hasSwapIn;
    if (hasSwapIn) {
        let swapSum = 0;
        makeChart('chartSwapIn', {
            type: 'line',
            data: {
                labels: r.day,
                datasets: [
                    line(t(lang, 'seriesSwapInPce'), r.swapInPce.map((v) => (swapSum += v)), COLOR_TOP10),
                ],
            },
            options: baseOptions(false),
        });
    }

    // relayer-fee outflow from the reserve (meta-tx fees): daily + cumulative
    const hasFees = r.feePce.some((v) => v > 0);
    $('chartFeeOut').closest('.chart-card').hidden = !hasFees;
    $('chartFeeCum').closest('.chart-card').hidden = !hasFees;
    if (hasFees) {
        dailyBarChart('chartFeeOut', 'seriesFeeOut', r.feePce, COLOR_DECAY);
        let feeSum = 0;
        makeChart('chartFeeCum', {
            type: 'line',
            data: {
                labels: r.day,
                datasets: [
                    line(t(lang, 'seriesFeeCum'), r.feePce.map((v) => (feeSum += v)), COLOR_DECAY),
                ],
            },
            options: baseOptions(false),
        });
    }

    // explorer-style daily activity: sent-or-received / senders / receivers
    makeChart('chartActiveUsers', {
        type: 'line',
        data: {
            labels: r.day,
            datasets: [
                line(t(lang, 'seriesDailyActive'), r.dailyActive, COLOR_DISPLAY),
                line(t(lang, 'seriesDailySenders'), r.dailySenders, '#eda100'),
                line(t(lang, 'seriesDailyReceivers'), r.dailyReceivers, '#1baf7a'),
            ],
        },
        options: baseOptions(true),
    });

    // membership structure: total joined / churned + per-persona (non-churned)
    const churned = r.agentCount.map((v, i) => v - r.activeCount[i]);
    makeChart('chartPopulation', {
        type: 'line',
        data: {
            labels: r.day,
            datasets: [
                line(t(lang, 'seriesTotalMembers'), r.agentCount, '#0b0b0b'),
                line(t(lang, 'statusChurned'), churned, '#c3c2b7'),
                ...(r.personaCounts ?? []).map((arr, i) =>
                    line(sim.params.personas[i]?.name ?? `#${i}`, arr, PERSONA_COLORS[i % PERSONA_COLORS.length])),
            ],
        },
        options: baseOptions(true),
    });
}

// Multi-seed variant: median line + 10-90 percentile band for the primary series;
// secondary series (raw, top10) stay as median-only lines to limit clutter.
function renderChartsMC() {
    const { labels, bands } = mc;

    makeChart('chartSupply', {
        type: 'line',
        data: {
            labels,
            datasets: [
                line(t(lang, 'seriesDisplaySupply'), bands.totalDisplay[1], COLOR_DISPLAY),
                ...bandDatasets(bands.totalDisplay[0], bands.totalDisplay[2], COLOR_DISPLAY),
                line(t(lang, 'seriesRawSupply'), bands.totalRaw[0], COLOR_RAW, true),
            ],
        },
        options: baseOptions(true),
    });

    // bars cannot carry a band, so the mint chart becomes a line in MC mode
    makeChart('chartMint', {
        type: 'line',
        data: {
            labels,
            datasets: [
                line(t(lang, 'seriesMint'), bands.mintedToday[1], COLOR_MINT),
                ...bandDatasets(bands.mintedToday[0], bands.mintedToday[2], COLOR_MINT),
            ],
        },
        options: baseOptions(false),
    });

    const distOptions = baseOptions(true);
    distOptions.scales.y.suggestedMax = 1;
    makeChart('chartDist', {
        type: 'line',
        data: {
            labels,
            datasets: [
                line(t(lang, 'seriesGini'), bands.gini[1], COLOR_GINI),
                ...bandDatasets(bands.gini[0], bands.gini[2], COLOR_GINI),
                line(t(lang, 'seriesTop10'), bands.top10[0], COLOR_TOP10),
            ],
        },
        options: distOptions,
    });
    renderRepresentativeCharts();
}

// ---------------------------------------------------------------- network view

function renderNetworkLegend() {
    const box = $('networkLegend');
    box.innerHTML = '';
    const items = sim.params.personas.map((p, i) => [p.name, PERSONA_COLORS[i % PERSONA_COLORS.length]]);
    items.push([t(lang, 'churned'), '#c3c2b7']);
    for (const [label, color] of items) {
        const el = document.createElement('span');
        el.className = 'legend-item';
        const sw = document.createElement('span');
        sw.className = 'legend-swatch';
        sw.style.background = color;
        el.appendChild(sw);
        el.appendChild(document.createTextNode(label));
        box.appendChild(el);
    }
}

function renderNetworkAt(idx) {
    const snap = sim.snapshots[idx];
    networkView.render(snap);
    $('sliderLabel').textContent = t(lang, 'dayLabel', { d: snap.day });
}

function setupRanking() {
    ranking = createRanking(sim, lang);
}

const TOOLTIP_ROWS = ['colTxCount', 'colTxAmount', 'colRxCount', 'colRxAmount', 'colMinted'];

function renderNetTooltip(id, clientX, clientY) {
    const tip = $('netTooltip');
    if (id === null) {
        tip.hidden = true;
        return;
    }
    const a = sim.agents;
    const snap = sim.snapshots[parseInt($('daySlider').value, 10)];
    const balance = id < snap.count ? snap.balance[id] * snap.factor : 0;

    tip.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'tip-head';
    const img = document.createElement('img');
    img.className = 'identicon';
    img.width = 20;
    img.height = 20;
    img.src = identiconURL(id, sim.params.run.seed, a.persona[id], 20);
    head.appendChild(img);
    const headText = document.createElement('span');
    headText.textContent = ` #${id}`;
    head.appendChild(headText);
    tip.appendChild(head);

    const rows = [['colBalance', balance], ...TOOLTIP_ROWS.map((key) => {
        const arr = { colTxCount: a.txCount, colTxAmount: a.txAmount, colRxCount: a.rxCount, colRxAmount: a.rxAmount, colMinted: a.minted }[key];
        return [key, arr[id]];
    })];
    for (const [key, value] of rows) {
        const row = document.createElement('div');
        row.className = 'tip-row';
        const label = document.createElement('span');
        label.textContent = t(lang, key);
        const num = document.createElement('span');
        num.className = 'tip-num';
        num.textContent = fmt(value);
        row.appendChild(label);
        row.appendChild(num);
        tip.appendChild(row);
    }
    const hint = document.createElement('div');
    hint.className = 'tip-hint';
    hint.textContent = t(lang, 'netDblClickHint');
    tip.appendChild(hint);

    // position inside the network card, flipping at the right/bottom edges
    const card = tip.parentElement;
    const rect = card.getBoundingClientRect();
    tip.hidden = false;
    let x = clientX - rect.left + 14;
    let y = clientY - rect.top + 14;
    if (x + tip.offsetWidth > rect.width - 8) x = clientX - rect.left - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > rect.height - 8) y = clientY - rect.top - tip.offsetHeight - 14;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
}

function setupNetwork() {
    if (networkView) networkView.destroy();
    networkView = createNetworkView($('networkCanvas'), sim, sim.params.run.seed, {
        onHover: renderNetTooltip,
        onOpen: (id) => ranking && ranking.openDialog(id),
    });
    networkView.setMetric($('netMetric').value);
    const slider = $('daySlider');
    slider.max = sim.snapshots.length - 1;
    slider.value = sim.snapshots.length - 1;
    renderNetworkLegend();
    const note = $('networkSampledNote');
    if (networkView.shown < networkView.total) {
        note.hidden = false;
        note.textContent = t(lang, 'networkSampled', { shown: networkView.shown, total: networkView.total });
    } else {
        note.hidden = true;
    }
    renderNetworkAt(sim.snapshots.length - 1);
}

// ---------------------------------------------------------------- summary

// Overview tiles, explorer report-overview style: emoji label + mono value with
// the fractional part rendered small. The order tells the balance-sheet story:
// end ~= start + minted - decayed.
function computeTiles() {
    let v;
    if (mc) {
        const s = mc.summary;
        v = {
            end: s.supply, minted: s.mintedDisplay, decay: s.decayLostDisplay,
            txCount: s.txCount, volume: s.volumeDisplay, msgChars: s.msgChars,
            agents: s.agentCount, gini: s.gini, top10: s.top10,
        };
    } else {
        const r = sim.results;
        const last = r.day.length - 1;
        const totals = sim.totals();
        v = {
            end: r.totalDisplay[last], minted: totals.mintedDisplay, decay: totals.decayLostDisplay,
            txCount: totals.txCount, volume: totals.volumeDisplay, msgChars: totals.msgChars,
            agents: r.agentCount[last], gini: r.gini[last], top10: r.top10[last],
        };
    }
    // explorer's "active users" over the report period = accounts with at
    // least one send or receive during the whole simulated period
    let periodActive = 0;
    for (let i = 0; i < sim.agents.count; i++) {
        if (sim.agents.txCount[i] + sim.agents.rxCount[i] > 0) periodActive++;
    }

    // same items, labels and order as the explorer's report overview
    const main = [
        { key: 'ovActiveUsers', emoji: '\u{1F4E9}\u{1F46B}', value: periodActive, frac: 0 },
        { key: 'ovStartBalance', emoji: '\u{1F48E}', value: sim.params.token.initialSupply, frac: 0 },
        { key: 'ovTxAmount', emoji: '\u{1F4B8}', value: v.volume, frac: 0 },
        { key: 'ovIncrease', emoji: '\u{1F53A}', value: v.minted, frac: 0 },
        { key: 'ovCharAvg', emoji: '\u{1F606}', value: v.msgChars / (v.txCount || 1), frac: 2 },
        { key: 'ovVelocity', emoji: '\u{1F504}', value: v.end > 0 ? v.volume / v.end : 0, frac: 2 },
        { key: 'ovEndBalance', emoji: '\u{1F48E}', value: v.end, frac: 0 },
        { key: 'ovTxCount', emoji: '\u{1F4E4}', value: v.txCount, frac: 0 },
        { key: 'ovDecrease', emoji: '\u{1F53B}', value: v.decay, frac: 0 },
        { key: 'ovCharCount', emoji: '\u{1F44D}', value: v.msgChars, frac: 0 },
    ];

    // simulator-specific derived metrics (not in the explorer overview)
    const extra = [
        { key: 'seriesTotalMembers', emoji: '\u{1F46B}', value: v.agents, frac: 0 },
        { key: 'statGini', emoji: '⚖️', value: v.gini, frac: 3 },
        { key: 'statTop10', emoji: '\u{1F3C6}', value: v.top10, frac: 3 },
    ];
    const tk = sim.params.token;
    if (tk.decreaseIntervalDays > 0 && tk.afterDecreaseBp < BP) {
        const r = sim.results;
        const last = r.day.length - 1;
        const interval = tk.decreaseIntervalDays;
        extra.push(
            { key: 'decayAnnualized', emoji: '\u{1F4C9}',
              value: (1 - Math.pow(tk.afterDecreaseBp / BP, 365 / interval)) * 100, frac: 2, sub: '%' },
            { key: 'decayCurrentFactor', emoji: '\u{1F9EE}', value: r.factor[last], frac: 6 },
            { key: 'decayApplications', emoji: '\u{1F501}', value: Math.floor(r.day[last] / interval), frac: 0 },
        );
    }
    // PCE link metrics (PCEToken.sol semantics)
    const rp = sim.results;
    const lastIdx = rp.day.length - 1;
    const totalsAll = sim.totals();
    const pce = [
        { key: 'pceRateTile', emoji: '\u{1F4B1}',
          value: (totalsAll.dilution ?? 1) * (rp.factor[lastIdx] / (rp.pceFactor[lastIdx] || 1)), frac: 4 },
        { key: 'pceValueTile', emoji: '\u{1FA99}', value: rp.pceValue[lastIdx], frac: 0, sub: 'PCE' },
        { key: 'pceReserveTile', emoji: '\u{1F3E6}', value: rp.depositedPce[lastIdx], frac: 0, sub: 'PCE' },
        { key: 'swapInPceTotalTile', emoji: '\u{1F4E5}', value: totalsAll.swapInPce ?? 0, frac: 0, sub: 'PCE' },
        { key: 'swapInCountTile', emoji: '\u{1F522}', value: totalsAll.swapInCount ?? 0, frac: 0 },
        { key: 'feePceTotalTile', emoji: '\u{26FD}', value: totalsAll.feePce ?? 0, frac: 0, sub: 'PCE' },
    ];
    return { main, extra, pce };
}

function appendStatValue(dd, value, frac) {
    const s = new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US', {
        maximumFractionDigits: frac,
        minimumFractionDigits: frac,
    }).format(value);
    const dot = s.lastIndexOf('.');
    const intPart = document.createElement('span');
    intPart.className = 'stat-int';
    intPart.textContent = dot < 0 ? s : s.slice(0, dot);
    dd.appendChild(intPart);
    if (dot >= 0) {
        const fracPart = document.createElement('span');
        fracPart.className = 'stat-frac';
        fracPart.textContent = s.slice(dot);
        dd.appendChild(fracPart);
    }
}

// header of the detail (tab) panel: which sweep point is shown, and which
// seeds produced it — the block boundary that anchors the seed note
function renderDetailHead() {
    const title = $('detailTitle');
    const note = $('mcNote');
    if (!sweepRuns) {
        title.textContent = '';
        note.hidden = true;
        return;
    }
    const { axes, combos } = sweepRuns;
    const tuple = combos[activePoint];
    const pairs = tuple.map((v, ai) =>
        `${t(lang, axes[ai].key)} = ${v.toFixed(sweepDecimals(axes[ai].values))}`).join(' \u30fb ');
    title.textContent = t(lang, 'detailPrefix') + (pairs || t(lang, 'detailSingle'));
    note.hidden = false;
    note.textContent = mc
        ? t(lang, 'mcNote', { n: mc.runs, seed: mc.baseSeed })
        : t(lang, 'singleSeedNote', { seed: sim.params.run.seed });
}

function renderTiles(cardId, tiles, panelId) {
    const card = $(cardId);
    card.innerHTML = '';
    for (const def of tiles) {
        const item = document.createElement('div');
        item.className = 'overview-item';
        const dt = document.createElement('dt');
        dt.appendChild(document.createTextNode(`${def.emoji} `));
        const labelSpan = document.createElement('span');
        labelSpan.dataset.i18n = def.key;
        labelSpan.textContent = t(lang, def.key);
        dt.appendChild(labelSpan);
        const help = document.createElement('button');
        help.type = 'button';
        help.className = 'help-btn';
        help.dataset.help = `help_${def.key}`;
        help.dataset.helpTarget = panelId;
        help.setAttribute('aria-label', 'Help');
        help.textContent = '?';
        dt.appendChild(help);
        const dd = document.createElement('dd');
        appendStatValue(dd, def.value, def.frac);
        if (def.sub) {
            const sub = document.createElement('span');
            sub.className = 'stat-sub';
            sub.textContent = ` ${def.sub}`;
            dd.appendChild(sub);
        }
        item.appendChild(dt);
        item.appendChild(dd);
        card.appendChild(item);
    }
}

function renderSummary() {
    const { main, extra, pce } = computeTiles();
    renderTiles('overviewCard', main, 'overviewItem');
    renderTiles('simMetricsCard', extra, 'simMetricsItem');
    renderTiles('pceMetricsCard', pce, 'pceMetricsItem');
    renderDetailHead();
}

function renderResults() {
    $('results').hidden = false;
    $('resultsHeading').hidden = false;
    renderSummary();
    renderCharts();
    setupRanking();
    setupNetwork();
    buildToc();
}

// ---------------------------------------------------------------- run loop

// Run jobs [{params, full}] on a pool of module workers; resolves to payloads
// in job order. onProgress receives overall completion in [0, 1].
function runJobs(jobs, onProgress) {
    return new Promise((resolve, reject) => {
        const results = new Array(jobs.length);
        const progressDays = new Array(jobs.length).fill(0);
        const totalDays = jobs.reduce((s, j) => s + j.params.population.days, 0);
        const poolSize = Math.min(
            jobs.length,
            Math.max(1, (navigator.hardwareConcurrency || 4) - 1),
            8
        );
        const workers = [];
        let next = 0;
        let doneCount = 0;
        let failed = false;
        const fail = (err) => {
            if (failed) return;
            failed = true;
            workers.forEach((x) => x.terminate());
            reject(err);
        };
        const startJob = (w) => {
            if (next >= jobs.length) return;
            const jobId = next++;
            w.postMessage({ jobId, params: jobs[jobId].params, full: jobs[jobId].full });
        };
        for (let k = 0; k < poolSize; k++) {
            let w;
            try {
                w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
            } catch (err) {
                fail(err);
                return;
            }
            w.onmessage = (e) => {
                const msg = e.data;
                if (msg.type === 'progress') {
                    progressDays[msg.jobId] = msg.day;
                } else if (msg.type === 'done') {
                    progressDays[msg.jobId] = jobs[msg.jobId].params.population.days;
                    results[msg.jobId] = msg.payload;
                    doneCount++;
                    if (doneCount === jobs.length) {
                        workers.forEach((x) => x.terminate());
                        onProgress(1);
                        resolve(results);
                        return;
                    }
                    startJob(w);
                }
                onProgress(progressDays.reduce((a, b) => a + b, 0) / totalDays);
            };
            w.onerror = (err) => fail(err.message ? new Error(err.message) : err);
            workers.push(w);
            startJob(w);
        }
    });
}

function setBusy(state) {
    busy = state;
    $('runBtn').disabled = state;
    $('progressWrap').hidden = !state;
    if (state) $('progressBar').style.width = '0%';
}

function setProgress(frac) {
    $('progressBar').style.width = `${Math.round(100 * frac)}%`;
}

function prepareRun() {
    const errorBox = $('errorBox');
    $('warnBox').hidden = true;
    errorBox.hidden = true;
    const { params, errors, seeds } = readParams();
    if (errors.length > 0) {
        errorBox.textContent = errors.join(' ');
        errorBox.hidden = false;
        return null;
    }
    return { params, seeds };
}

function showTxWarning(params, runCount) {
    const estimated = estimateTxCount(params) * runCount;
    if (estimated > TX_WARN_THRESHOLD) {
        const warnBox = $('warnBox');
        warnBox.textContent = t(lang, 'txWarning', { n: fmt(estimated) });
        warnBox.hidden = false;
    }
}

function finishRun(warnings) {
    const warnBox = $('warnBox');
    setBusy(false);
    $('runBtn').textContent = t(lang, 'run');
    warnBox.textContent = warnings.join(' ');
    warnBox.hidden = warnings.length === 0; // also clears a pre-run txWarning
}

function collectWarnings(simLike) {
    const warnings = [];
    if (simLike.aborted) warnings.push(t(lang, 'abortedWarning'));
    const starved = simLike.totals().feeStarvedDay;
    if (starved >= 0) warnings.push(t(lang, 'feeStarvedWarning', { d: starved }));
    return warnings;
}

// One button, sweep-first: every run executes the sweep grid (the currently
// configured value is inserted as one of the points), and the detailed results
// view switches between sweep points. With 2+ seeds per point the detail view
// shows median + percentile bands for the selected point.
const MAX_RUNS = 1000;

function fmtCompactNum(v) {
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
    return String(Math.round(v));
}

function fmtBytes(b) {
    return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
}

function fmtDuration(s) {
    return s >= 60 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`;
}

// Always-on cost readout: runs, transfers, wall time and memory, so cartesian
// sweeps can't silently explode. Red when over the hard run cap.
function updateEstimates() {
    const bar = $('estimateBar');
    const seeds = parseSeeds();
    const { params } = readParams();
    let cfg = null;
    try { cfg = readSweepConfig(); } catch { /* mid-edit */ }
    if (!seeds || !cfg || !Number.isFinite(params.population.days)) {
        bar.innerHTML = '';
        return;
    }
    const runs = cfg.combos.length * seeds.length;
    let tx = 0;
    try { tx = estimateTxCount(params) * runs; } catch { /* invalid params */ }
    const days = params.population.days;
    const agents = Math.min(200000,
        Math.max(params.population.initialCount || 0, Math.ceil(growthTarget(params.population, days - 1)) || 0));
    // series arrays per run + full payload (snapshots/graph/agents) per combo
    const memBytes = runs * days * 110 + cfg.combos.length * (Math.min(days, 121) * agents * 9 + agents * 120);
    const workers = Math.min(Math.max(1, (navigator.hardwareConcurrency || 4) - 1), 8, runs);
    const sec = Math.max(0.3, tx / 5e6 / workers);
    bar.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'est-title';
    title.textContent = t(lang, 'estTitle');
    bar.appendChild(title);
    const rows = [
        ['estRuns', `${fmt(runs)} (${fmt(cfg.combos.length)} \u00d7 ${seeds.length})`],
        ['estTx', fmtCompactNum(tx)],
        ['estTime', fmtDuration(sec)],
        ['estMem', fmtBytes(memBytes)],
    ];
    for (const [key, value] of rows) {
        const row = document.createElement('div');
        row.className = 'est-row';
        const label = document.createElement('span');
        label.className = 'est-label';
        label.textContent = t(lang, key);
        const val = document.createElement('span');
        val.className = 'est-value';
        val.textContent = value;
        row.appendChild(label);
        row.appendChild(val);
        bar.appendChild(row);
    }
    bar.classList.toggle('estimate-over', runs > MAX_RUNS);
}

async function run() {
    if (busy) return;
    const prep = prepareRun();
    if (!prep) return;
    const { params, seeds } = prep;
    const cfg = readSweepConfig();
    const runsTotal = cfg.combos.length * seeds.length;
    if (runsTotal > MAX_RUNS) {
        const errorBox = $('errorBox');
        errorBox.textContent = t(lang, 'tooManyRuns', { runs: fmt(runsTotal), max: fmt(MAX_RUNS) });
        errorBox.hidden = false;
        return;
    }
    showTxWarning(params, runsTotal);

    setBusy(true);
    $('runBtn').textContent = t(lang, 'running');
    $('results').hidden = true;
    $('resultsHeading').hidden = true;
    $('sweepResults').hidden = true;
    $('sweepSwitch').hidden = true;
    if (networkView) networkView.destroy();
    networkView = null;
    mc = null;

    const jobs = [];
    for (const tuple of cfg.combos) {
        for (let s = 0; s < seeds.length; s++) {
            // the first seed carries the full payload for the detail view
            jobs.push({ params: pointParams(params, cfg.axes, tuple, seeds[s]), full: s === 0 });
        }
    }
    try {
        const payloads = await runJobs(jobs, setProgress);
        sweepRuns = {
            axes: cfg.axes,
            combos: cfg.combos,
            seeds,
            baseParams: params,
            byCombo: cfg.combos.map((_, ci) => payloads.slice(ci * seeds.length, (ci + 1) * seeds.length)),
        };
        const metrics = cfg.combos.map((tuple, ci) => {
            const slice = sweepRuns.byCombo[ci];
            const finalOf = (k) => median(slice.map((p) => p.results[k].at(-1) ?? 0));
            return {
                tuple,
                supply: finalOf('totalDisplay'),
                minted: median(slice.map((p) => p.totals.mintedDisplay)),
                gini: finalOf('gini'),
                top10: finalOf('top10'),
                active: finalOf('dailyActive'),
            };
        });
        lastSweep = { axes: cfg.axes, seeds: seeds.length, metrics };
        renderSweep();
        selectSweepPoint(Math.floor((cfg.combos.length - 1) / 2));
        finishRun(collectWarnings(sim));
        // jump to the results (the sticky sweep tabs land at the top with them)
        $('resultsHeading').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
        sweepRuns = null;
        lastSweep = null;
        activePoint = -1;
        finishRun([]);
        const errorBox = $('errorBox');
        errorBox.textContent = String(err);
        errorBox.hidden = false;
    }
}

function pointParams(base, axes, tuple, seed) {
    const p = structuredClone(base);
    for (let ai = 0; ai < axes.length; ai++) {
        p[axes[ai].spec.group][axes[ai].spec.engineKey] = axes[ai].spec.toEngine(tuple[ai]);
    }
    // same seed set per combo (common random numbers) for comparable points
    p.run.seed = seed;
    return p;
}

function selectSweepPoint(ci) {
    activePoint = ci;
    const { axes, combos, baseParams, byCombo, seeds } = sweepRuns;
    adoptRuns(byCombo[ci], pointParams(baseParams, axes, combos[ci], seeds[0]));
    renderSweepSwitch();
    document.querySelectorAll('#sweepTable tr[data-combo]').forEach((row) => {
        row.classList.toggle('active-combo', parseInt(row.dataset.combo, 10) === ci);
    });
    if (!busy) {
        const warnings = collectWarnings(sim);
        const warnBox = $('warnBox');
        warnBox.textContent = warnings.join(' ');
        warnBox.hidden = warnings.length === 0;
    }
    if (sim.results.day.length > 0) {
        renderResults();
    } else {
        // e.g. immediate abort on day 0 for this point: keep the switcher (and
        // the results heading above it) so the user can move to a healthy
        // point, but hide the stale detail view
        $('results').hidden = true;
        if (networkView) networkView.destroy();
        networkView = null;
        buildToc();
    }
}

// value chips above the results: which sweep point the detail view shows
function renderSweepSwitch() {
    const box = $('sweepSwitch');
    if (!sweepRuns) {
        box.hidden = true;
        return;
    }
    const { axes, combos } = sweepRuns;
    if (combos.length <= 1) {
        box.hidden = true;
        return;
    }
    box.hidden = false;
    box.innerHTML = '';
    const decimals = axes.map((a) => sweepDecimals(a.values));
    const label = document.createElement('span');
    label.className = 'switch-label';
    label.textContent = axes.map((a) => t(lang, a.key)).join(' \u00d7 ');
    box.appendChild(label);
    combos.forEach((tuple, ci) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'switch-btn' + (ci === activePoint ? ' active' : '');
        btn.textContent = tuple.map((v, ai) => v.toFixed(decimals[ai])).join(' \u00b7 ');
        btn.addEventListener('click', () => {
            if (ci !== activePoint) selectSweepPoint(ci);
        });
        box.appendChild(btn);
    });
}

const BAND_QS = [0.1, 0.5, 0.9];

// Make one sweep point's payloads the active detail view (sim + mc globals).
function adoptRuns(payloads, params) {
    const band = (key) => bandSeries(payloads.map((p) => p.results[key]), BAND_QS).series;
    const medianOnly = (key) => bandSeries(payloads.map((p) => p.results[key]), [0.5]).series;
    const { length } = bandSeries(payloads.map((p) => p.results.day), [0.5]);
    const last = length - 1;
    const finalOf = (key) => median(payloads.map((p) => p.results[key][last]));

    const base = payloads[0];
    // plain-object stand-in for the sim: the network view, summary and language
    // handlers only touch these fields
    sim = {
        params,
        results: base.results,
        snapshots: base.snapshots,
        agents: base.agents,
        graph: { adj: base.adj },
        aborted: payloads.some((p) => p.aborted),
        totals: () => base.totals,
        finished: () => true,
    };
    if (payloads.length < 2) {
        mc = null;
        return;
    }
    mc = {
        runs: payloads.length,
        baseSeed: params.run.seed,
        labels: base.results.day.slice(0, length),
        bands: {
            totalDisplay: band('totalDisplay'),
            totalRaw: medianOnly('totalRaw'),
            mintedToday: band('mintedToday'),
            gini: band('gini'),
            top10: medianOnly('top10'),
        },
        summary: {
            supply: finalOf('totalDisplay'),
            mintedDisplay: median(payloads.map((p) => p.totals.mintedDisplay)),
            decayLostDisplay: median(payloads.map((p) => p.totals.decayLostDisplay)),
            volumeDisplay: median(payloads.map((p) => p.totals.volumeDisplay)),
            txCount: median(payloads.map((p) => p.totals.txCount)),
            msgChars: median(payloads.map((p) => p.totals.msgChars)),
            agentCount: finalOf('agentCount'),
            gini: finalOf('gini'),
            top10: finalOf('top10'),
        },
    };

}

// ---------------------------------------------------------------- parameter sweep

// Sweep values are in UI units (percent where applicable); toEngine converts to
// the engine's contract units. range(current) derives the prefilled From/To from
// the value currently configured in the form (sweep param keys double as the
// form input ids), so the sweep brackets the user's own setting — typically
// 0 to 2x the current value; the fallback covers a zero/disabled setting.
const SWEEP_PARAMS = {
    decayRatePct: { group: 'token', engineKey: 'afterDecreaseBp', integer: false, toEngine: decayRateToAfterBp, range: (cur) => [0, cur > 0 ? cur * 2 : 1] },
    decreaseIntervalDays: { group: 'token', engineKey: 'decreaseIntervalDays', integer: true, toEngine: (v) => v, range: (cur) => [1, cur > 0 ? cur * 2 : 30] },
    maxIncreaseOfTotalSupplyPct: { group: 'token', engineKey: 'maxIncreaseOfTotalSupplyBp', integer: false, toEngine: pctToBp, range: (cur) => [0, cur > 0 ? cur * 2 : 5] },
    maxIncreasePct: { group: 'token', engineKey: 'maxIncreaseBp', integer: false, toEngine: pctToBp, range: (cur) => [0, cur > 0 ? cur * 2 : 10] },
    maxUsagePct: { group: 'token', engineKey: 'maxUsageBp', integer: false, toEngine: pctToBp, range: (cur) => [Math.max(0.5, cur / 2), cur > 0 ? cur * 2 : 30] },
    changePct: { group: 'token', engineKey: 'changeBp', integer: false, toEngine: pctToBp, range: (cur) => [0, cur > 0 ? Math.min(100, cur * 2) : 100] },
    churnAnnualPct: { group: 'population', engineKey: 'churnAnnualPct', integer: false, toEngine: (v) => v, range: (cur) => [0, cur > 0 ? Math.min(99, cur * 2) : 50] },
    initialCount: { group: 'population', engineKey: 'initialCount', integer: true, toEngine: (v) => v, range: (cur) => [Math.max(4, Math.round(cur / 2)), cur * 2] },
    dilutionFactor: { group: 'pce', engineKey: 'dilutionFactor', integer: false, toEngine: (v) => v, range: (cur) => [Math.max(0.1, cur / 2), Math.min(1000, cur * 2)] },
    pceSwapInPerDay: { group: 'pce', engineKey: 'swapInPerDay', integer: false, toEngine: (v) => v, range: (cur) => [0, cur > 0 ? cur * 2 : 5] },
    pceSwapInMeanPce: { group: 'pce', engineKey: 'swapInMeanPce', integer: false, toEngine: (v) => v, range: (cur) => [0, cur > 0 ? cur * 2 : 1000] },
    metaTxFeePce: { group: 'pce', engineKey: 'metaTxFeePce', integer: false, toEngine: (v) => v, range: (cur) => [0, cur > 0 ? cur * 2 : 5] },
};


// Every sweepable parameter's input is a +/- value list: one row = one value.
// Any field with 2+ distinct values automatically becomes a sweep axis and the
// run executes the cartesian product of all axes.
const VALUE_FIELDS = Object.keys(SWEEP_PARAMS);

function fieldValues(key) {
    const proto = $(key);
    const lo = proto.getAttribute('min') !== null ? parseFloat(proto.getAttribute('min')) : -Infinity;
    const hi = proto.getAttribute('max') !== null ? parseFloat(proto.getAttribute('max')) : Infinity;
    const out = [];
    const integer = SWEEP_PARAMS[key]?.integer;
    for (const el of $(`${key}-list`).querySelectorAll('.value-input')) {
        let v = parseFloat(el.value);
        if (!Number.isFinite(v)) continue;
        v = Math.min(hi, Math.max(lo, v));
        if (integer) v = Math.round(v);
        out.push(v);
    }
    return out;
}

function firstValue(key) {
    const vals = fieldValues(key);
    return vals.length > 0 ? vals[0] : NaN;
}

function refreshValueRows(key) {
    const rows = $(`${key}-list`).children;
    for (const row of rows) row.querySelector('.remove-btn').disabled = rows.length <= 1;
}

function addNextValue(key) {
    const proto = $(key);
    const spec = SWEEP_PARAMS[key];
    const vals = fieldValues(key);
    const last = vals.at(-1) ?? 1;
    let next = last > 0 ? last * 2 : 1; // a doubled value is a useful default axis point
    if (spec.integer) next = Math.round(next);
    const hi = proto.getAttribute('max') !== null ? parseFloat(proto.getAttribute('max')) : Infinity;
    next = Math.min(hi, Number(next.toFixed(4)));
    addValueRow(key, next);
    updateEstimates();
}

function addValueRow(key, value) {
    const proto = $(key);
    const list = $(`${key}-list`);
    const row = document.createElement('div');
    row.className = 'list-row';
    const ug = document.createElement('div');
    ug.className = 'unit-group';
    const el = document.createElement('input');
    el.type = 'number';
    el.className = 'value-input';
    for (const attr of ['min', 'max', 'step']) {
        const v = proto.getAttribute(attr);
        if (v !== null) el.setAttribute(attr, v);
    }
    el.value = String(value);
    ug.appendChild(el);
    const suffix = proto.parentElement.querySelector('.unit-suffix');
    if (suffix) ug.appendChild(suffix.cloneNode(true));
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'remove-btn';
    rm.textContent = '\u2212';
    rm.addEventListener('click', () => {
        if (list.children.length > 1) {
            row.remove();
            refreshValueRows(key);
            updateEstimates();
        }
    });
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'add-btn';
    plus.textContent = '\uff0b';
    plus.addEventListener('click', () => addNextValue(key));
    row.appendChild(ug);
    row.appendChild(rm);
    row.appendChild(plus);
    list.appendChild(row);
    refreshValueRows(key);
}

function initValueField(key) {
    const proto = $(key);
    const group = proto.closest('.unit-group');
    const list = document.createElement('div');
    list.className = 'row-list value-list';
    list.id = `${key}-list`;
    group.after(list);
    group.hidden = true; // the original input stays as the attribute/unit template
    addValueRow(key, parseFloat(proto.value));
}

function readSweepConfig() {
    const axes = [];
    for (const key of VALUE_FIELDS) {
        const unique = [];
        for (const v of fieldValues(key)) {
            if (!unique.some((u) => Math.abs(u - v) < 1e-9)) unique.push(v);
        }
        if (unique.length >= 2) axes.push({ key, spec: SWEEP_PARAMS[key], values: unique });
    }
    // cartesian product of the axis values -> one tuple per combo
    let combos = [[]];
    for (const axis of axes) {
        const next = [];
        for (const tuple of combos) {
            for (const v of axis.values) next.push([...tuple, v]);
        }
        combos = next;
    }
    return { axes, combos };
}

// Sweep values print with a UNIFORM number of decimals across the whole set
// (0.2 -> "0.20" when 0.08 is present), capped at 4.
function sweepDecimals(values) {
    let d = 0;
    for (const v of values) {
        const s = String(Number(v.toFixed(4)));
        const dot = s.indexOf('.');
        if (dot >= 0) d = Math.max(d, s.length - dot - 1);
    }
    return d;
}

function sweepLine(label, data, color) {
    return { ...line(label, data, color), pointRadius: 3, pointHoverRadius: 5 };
}

// distinct series colors for the axis-2 grouping (validated categorical order)
const SWEEP_SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7', '#e34948', '#eda100', '#e87ba4', '#008300'];

function renderSweep() {
    if (!lastSweep) return;
    const { axes, metrics } = lastSweep;
    if (axes.length === 0) {
        $('sweepResults').hidden = true;
        return;
    }
    $('sweepResults').hidden = false;
    const single = axes.length === 1;
    $('sweepChartGrid').hidden = axes.length > 2;
    const decimals = axes.map((a) => sweepDecimals(a.values));
    const heads = [...document.querySelectorAll('#sweepChartGrid .chart-card h3')]
        .map((h) => h.querySelector('span') || h);

    if (single) {
        heads[0].textContent = t(lang, 'chartSweepTokens');
        heads[1].textContent = t(lang, 'chartSweepRatios');
        const labels = metrics.map((m) => m.tuple[0].toFixed(decimals[0]));
        const tokenOptions = baseOptions(true, false);
        tokenOptions.scales.x.title.text = t(lang, axes[0].key);
        makeChart('chartSweepTokens', {
            type: 'line',
            data: {
                labels,
                datasets: [
                    sweepLine(t(lang, 'finalSupply'), metrics.map((m) => m.supply), COLOR_DISPLAY),
                    sweepLine(t(lang, 'cumulativeMint'), metrics.map((m) => m.minted), COLOR_MINT),
                ],
            },
            options: tokenOptions,
        });
        const ratioOptions = baseOptions(true, false);
        ratioOptions.scales.x.title.text = t(lang, axes[0].key);
        ratioOptions.scales.y.suggestedMax = 1;
        makeChart('chartSweepRatios', {
            type: 'line',
            data: {
                labels,
                datasets: [
                    sweepLine(t(lang, 'finalGini'), metrics.map((m) => m.gini), COLOR_GINI),
                    sweepLine(t(lang, 'seriesTop10'), metrics.map((m) => m.top10), COLOR_TOP10),
                ],
            },
            options: ratioOptions,
        });
    } else if (axes.length === 2) {
        // x = axis 1, one line per axis-2 value (combo order is axis-1 major)
        const [a1, a2] = axes;
        const n2 = a2.values.length;
        heads[0].textContent = t(lang, 'finalSupply');
        heads[1].textContent = t(lang, 'finalGini');
        const labels = a1.values.map((v) => v.toFixed(decimals[0]));
        const seriesFor = (metric) => a2.values.map((v2, i2) => {
            const line2 = sweepLine(
                `${t(lang, a2.key)} = ${v2.toFixed(decimals[1])}`,
                a1.values.map((_, i1) => metrics[i1 * n2 + i2][metric]),
                SWEEP_SERIES_COLORS[i2 % SWEEP_SERIES_COLORS.length]
            );
            if (i2 >= SWEEP_SERIES_COLORS.length) line2.borderDash = [5, 4];
            return line2;
        });
        const supplyOptions = baseOptions(true, false);
        supplyOptions.scales.x.title.text = t(lang, a1.key);
        makeChart('chartSweepTokens', {
            type: 'line',
            data: { labels, datasets: seriesFor('supply') },
            options: supplyOptions,
        });
        const giniOptions = baseOptions(true, false);
        giniOptions.scales.x.title.text = t(lang, a1.key);
        giniOptions.scales.y.suggestedMax = 1;
        makeChart('chartSweepRatios', {
            type: 'line',
            data: { labels, datasets: seriesFor('gini') },
            options: giniOptions,
        });
    }

    const table = $('sweepTable');
    table.innerHTML = '';
    const thead = table.createTHead();
    const hr = thead.insertRow();
    for (const axis of axes) {
        const th = document.createElement('th');
        th.textContent = t(lang, axis.key);
        hr.appendChild(th);
    }
    for (const k of ['finalSupply', 'cumulativeMint', 'finalGini', 'seriesTop10', 'finalActive']) {
        const th = document.createElement('th');
        th.textContent = t(lang, k);
        hr.appendChild(th);
    }
    const tbody = table.createTBody();
    metrics.forEach((m, ci) => {
        const row = tbody.insertRow();
        row.dataset.combo = String(ci);
        row.className = 'sweep-row' + (ci === activePoint ? ' active-combo' : '');
        m.tuple.forEach((v, ai) => {
            row.insertCell().textContent = v.toFixed(decimals[ai]);
        });
        for (const v of [fmt(m.supply), fmt(m.minted), m.gini.toFixed(3), m.top10.toFixed(3), fmt(m.active)]) {
            row.insertCell().textContent = String(v);
        }
    });
    tbody.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-combo]');
        if (row) selectSweepPoint(parseInt(row.dataset.combo, 10));
    });
    $('sweepNote').textContent = t(lang, 'sweepNote', { seeds: lastSweep.seeds });
}

// ---------------------------------------------------------------- wiring

function setLang(next) {
    lang = next;
    applyI18n(lang);
    $('langEn').classList.toggle('active', lang === 'en');
    $('langJa').classList.toggle('active', lang === 'ja');
    const warnBox = $('warnBox');
    if (sim && sim.finished() && !warnBox.hidden) {
        const warnings = collectWarnings(sim);
        warnBox.textContent = warnings.join(' ');
        warnBox.hidden = warnings.length === 0;
    }
    if ($('agentDialog').open) $('agentDialog').close();
    if (sim && !$('results').hidden) {
        renderSummary();
        renderCharts();
        if (ranking) ranking.setLang(lang);
        renderNetworkLegend();
        renderNetworkAt(parseInt($('daySlider').value, 10));
        const note = $('networkSampledNote');
        if (!note.hidden) {
            note.textContent = t(lang, 'networkSampled', { shown: networkView.shown, total: networkView.total });
        }
    }
    if (lastSweep) renderSweep();
    if (sweepRuns) renderSweepSwitch();
    buildToc();
    refreshOpenHelpPanels();
    updateEstimates();
}

// --- table of contents: fixed sidebar on wide screens, FF14-patch-note style.
// Settings sections always listed; result sections appear once a run exists.
const TOC_SECTIONS = [
    { group: 'tocSettings', items: [
        ['sec-token', 'tokenSettings'], ['sec-pce', 'pceSettings'],
        ['sec-population', 'population'], ['sec-personas', 'personas'],
    ] },
    { group: 'tocResults', resultsOnly: true, items: [
        ['sec-overview', 'summary'],
        ['sec-charts', 'tocCharts'], ['rankingCard', 'rankingTitle'],
        ['networkCard', 'chartNetwork'], ['sweepResults', 'sweepResultsTitle'],
    ] },
];

let tocObserver = null;

function buildToc() {
    const toc = $('toc');
    toc.innerHTML = '';
    const hasResults = !!sweepRuns && !$('results').hidden;
    for (const grp of TOC_SECTIONS) {
        if (grp.resultsOnly && !hasResults) continue;
        const head = document.createElement('div');
        head.className = 'toc-group';
        head.textContent = t(lang, grp.group);
        toc.appendChild(head);
        for (const [id, key] of grp.items) {
            const target = document.getElementById(id);
            if (!target || (grp.resultsOnly && target.hidden)) continue; // e.g. decay card with decay off
            const a = document.createElement('a');
            a.href = `#${id}`;
            a.dataset.target = id;
            a.className = 'toc-link';
            a.textContent = t(lang, key);
            a.addEventListener('click', (e) => {
                e.preventDefault();
                if (target.tagName === 'DETAILS') target.open = true;
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
            toc.appendChild(a);
        }
    }
    toc.hidden = false;
    setupTocSpy();
}

function setupTocSpy() {
    if (tocObserver) tocObserver.disconnect();
    tocObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            document.querySelectorAll('.toc-link').forEach((a) => {
                a.classList.toggle('active', a.dataset.target === entry.target.id);
            });
        }
    }, { rootMargin: '-10% 0px -75% 0px' });
    document.querySelectorAll('.toc-link').forEach((a) => {
        const el = document.getElementById(a.dataset.target);
        if (el) tocObserver.observe(el);
    });
}

// --- inline help: '?' buttons toggle a [data-help-panel]. A button usually owns
// its panel (data-help == panel key); table-column buttons share one panel via
// data-help-target, so clicking another column swaps the text in place. On
// hover-capable devices the same content also shows as a floating tooltip. ---

// the label the button sits next to names the topic; the overview button has
// no label sibling, so it falls back to the "Summary" key
function helpTitleKeyFor(btn) {
    const span = btn.previousElementSibling;
    return (span && span.dataset && span.dataset.i18n) ? span.dataset.i18n : 'summary';
}

function fillHelpContent(el, key, titleKey) {
    el.dataset.current = key;
    el.dataset.titleKey = titleKey;
    el.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'help-title';
    title.textContent = t(lang, titleKey).replace(/\n/g, ' ');
    const body = document.createElement('div');
    body.className = 'help-body';
    body.textContent = t(lang, key);
    el.append(title, body);
}

function refreshOpenHelpPanels() {
    document.querySelectorAll('.help-panel:not([hidden])').forEach((panel) => {
        fillHelpContent(panel, panel.dataset.current || panel.dataset.helpPanel,
            panel.dataset.titleKey || 'summary');
    });
}

let helpPop = null; // floating hover tooltip (desktop only)

function hideHelpPop() {
    if (helpPop) helpPop.hidden = true;
}

function showHelpPop(btn) {
    if (!helpPop) {
        helpPop = document.createElement('div');
        helpPop.className = 'help-pop';
        helpPop.hidden = true;
        document.body.appendChild(helpPop);
    }
    fillHelpContent(helpPop, btn.dataset.help, helpTitleKeyFor(btn));
    helpPop.hidden = false;
    const r = btn.getBoundingClientRect();
    let x = r.left + window.scrollX - 8;
    const maxX = window.scrollX + document.documentElement.clientWidth - helpPop.offsetWidth - 12;
    if (x > maxX) x = Math.max(window.scrollX + 8, maxX);
    helpPop.style.left = `${x}px`;
    helpPop.style.top = `${r.bottom + window.scrollY + 8}px`;
}

function wireHelp() {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.help-btn');
        if (!btn) return;
        // a click inside <summary> must not toggle the <details>
        e.preventDefault();
        e.stopPropagation();
        hideHelpPop();
        const key = btn.dataset.help;
        const panel = document.querySelector(
            `[data-help-panel="${btn.dataset.helpTarget || key}"]`
        );
        if (!panel.hidden && panel.dataset.current === key) {
            panel.hidden = true;
            return;
        }
        panel.hidden = false;
        fillHelpContent(panel, key, helpTitleKeyFor(btn));
        const details = btn.closest('details');
        if (details) details.open = true;
    });
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        document.addEventListener('mouseover', (e) => {
            const btn = e.target.closest('.help-btn');
            if (btn) showHelpPop(btn);
        });
        document.addEventListener('mouseout', (e) => {
            if (e.target.closest('.help-btn')) hideHelpPop();
        });
    }
}

// ------------------------------------------- settings export / import (JSON)

const SETTINGS_FORMAT = 'pce-community-token-simulator-settings';
// plain single-value inputs; multi-value fields live in VALUE_FIELDS
const SCALAR_IDS = ['initialSupply', 'days', 'growthPerDay', 'growthRatePct', 'logisticK', 'logisticR', 'exitSpendPct',
    'welcomeAvgPct', 'welcomeCapPct', 'graphDegree', 'clusterSize', 'decayBoostCap', 'eveSpikeGain'];

function collectSettings() {
    const values = {};
    for (const key of VALUE_FIELDS) values[key] = fieldValues(key);
    const scalars = {};
    for (const id of SCALAR_IDS) scalars[id] = parseFloat($(id).value);
    return {
        format: SETTINGS_FORMAT,
        version: 1,
        scalars,
        values,
        growthModel: radioVal('growthModel'),
        graphModel: radioVal('graphModel'),
        personas: personaRows().map((card) => ({
            name: card.querySelector('.p-name').value,
            values: PERSONA_FIELDS.map(([, cls]) => parseFloat(card.querySelector(`.${cls}`).value)),
        })),
    };
}

function exportSettings() {
    const blob = new Blob([JSON.stringify(collectSettings(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pce-simulator-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

function setRadio(id, value) {
    const el = $(id).querySelector(`input[type="radio"][value="${CSS.escape(String(value))}"]`);
    if (el) el.checked = true;
}

// Applies whatever validates; unknown keys are ignored, broken sections keep
// their current UI values instead of half-applying.
function applySettings(data) {
    if (!data || data.format !== SETTINGS_FORMAT) throw new Error('unrecognized settings file');
    const finite = (v) => typeof v === 'number' && Number.isFinite(v);
    for (const id of SCALAR_IDS) {
        if (finite(data.scalars?.[id])) $(id).value = String(data.scalars[id]);
    }
    for (const key of VALUE_FIELDS) {
        const vals = (Array.isArray(data.values?.[key]) ? data.values[key] : []).filter(finite);
        if (vals.length === 0) continue;
        $(`${key}-list`).replaceChildren();
        for (const v of vals) addValueRow(key, v);
    }
    if (typeof data.growthModel === 'string') setRadio('growthModel', data.growthModel);
    if (typeof data.graphModel === 'string') setRadio('graphModel', data.graphModel);
    if (Array.isArray(data.personas)) {
        const sigmaAt = PERSONA_FIELDS.findIndex(([k]) => k === 'balanceSigmaHead');
        const rows = data.personas.slice(0, PERSONA_MAX)
            .map((p) => {
                // exports from before the balance-sigma field: pad with 0
                if (Array.isArray(p?.values) && p.values.length === PERSONA_FIELDS.length - 1) {
                    const values = p.values.slice();
                    values.splice(sigmaAt, 0, 0);
                    return { ...p, values };
                }
                return p;
            })
            .filter((p) => Array.isArray(p?.values) && p.values.length === PERSONA_FIELDS.length && p.values.every(finite));
        if (rows.length > 0) {
            $('personaCards').replaceChildren();
            for (const p of rows) addPersonaRow(String(p.name ?? '?'), p.values);
        }
    }
    updateGrowthParams();
    updateEstimates();
}

function updateGrowthParams() {
    const model = radioVal('growthModel');
    document.querySelectorAll('.growth-param').forEach((el) => {
        el.hidden = el.dataset.model !== model;
    });
}

$('langEn').addEventListener('click', () => setLang('en'));
$('langJa').addEventListener('click', () => setLang('ja'));
$('growthModel').addEventListener('change', updateGrowthParams);
$('exportBtn').addEventListener('click', exportSettings);
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    try {
        applySettings(JSON.parse(await file.text()));
    } catch {
        alert(t(lang, 'importError'));
    }
});
$('runBtn').addEventListener('click', run);
$('addPersona').addEventListener('click', () => {
    if (personaRows().length < PERSONA_MAX) {
        addPersonaRow(`${t(lang, 'personaDefaultName')} ${personaRows().length + 1}`, [0, 0.5, 5, 2, 1, 3, 1.0, 0.5, 0.5, 0, 1]);
        updateEstimates();
    }
});
document.querySelector('.container').addEventListener('input', updateEstimates);
$('netMetric').addEventListener('change', () => {
    if (networkView) networkView.setMetric($('netMetric').value);
});
$('daySlider').addEventListener('input', (e) => renderNetworkAt(parseInt(e.target.value, 10)));
window.addEventListener('resize', () => {
    if (networkView && !$('results').hidden) renderNetworkAt(parseInt($('daySlider').value, 10));
});

// settings sections are permanently expanded — swallow any summary toggle
document.querySelectorAll('.param-group summary').forEach((s) => {
    s.addEventListener('click', (e) => e.preventDefault());
});
wireHelp();
updateGrowthParams();
initPersonaTable();
VALUE_FIELDS.forEach(initValueField);
buildToc();
setLang(lang);
updateEstimates();
