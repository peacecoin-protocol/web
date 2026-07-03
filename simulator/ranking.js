// Agent ranking table + detail dialog (explorer user-ranking / member-dialog
// patterns): index-sorted columns, pagination, and a row-click <dialog> with
// per-agent stats and a balance sparkline.
import { t } from './i18n.js';
import { identiconURL } from './identicon.js';
import { PERSONA_COLORS } from './network-view.js';

const PAGE_SIZE = 20;


const $ = (id) => document.getElementById(id);

// close on backdrop click / x button — wired once at module load
{
    const dialog = $('agentDialog');
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
    });
}

export function createRanking(sim, initialLang) {
    let lang = initialLang;
    const agents = sim.agents;
    const count = agents.count;
    const last = sim.results.day.length - 1;
    const finalFactor = sim.results.factor[last];
    const seed = sim.params.run.seed;
    const personaName = (idx) => sim.params.personas[idx]?.name ?? `#${idx}`;

    const columns = [
        { key: 'colRank' },
        { key: 'colMember' },
        { key: 'colPersona' },
        { key: 'colBalance', sort: (i) => agents.balance[i] },
        { key: 'colTxCount', sort: (i) => agents.txCount[i] },
        { key: 'colTxAmount', sort: (i) => agents.txAmount[i], help: 'rawAmountHelp' },
        { key: 'colRxCount', sort: (i) => agents.rxCount[i] },
        { key: 'colRxAmount', sort: (i) => agents.rxAmount[i], help: 'rawAmountHelp' },
        { key: 'colMinted', sort: (i) => agents.minted[i], help: 'rawAmountHelp' },
        { key: 'colJoinDay', sort: (i) => agents.joinDay[i] },
        { key: 'colStatus' },
    ];

    let sortKey = 'colBalance';
    let desc = true;
    let page = 0;
    const order = Array.from({ length: count }, (_, i) => i);

    const fmt = (v) => new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US', { maximumFractionDigits: 0 }).format(v);

    function sortNow() {
        const col = columns.find((c) => c.key === sortKey);
        const v = col.sort;
        order.sort((a, b) => (desc ? v(b) - v(a) : v(a) - v(b)) || a - b);
    }

    function renderHead(table) {
        const thead = table.createTHead();
        const tr = thead.insertRow();
        for (const col of columns) {
            const th = document.createElement('th');
            if (col.sort) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sort-btn' + (sortKey === col.key ? ' sorted' : '');
                btn.textContent = t(lang, col.key) + (sortKey === col.key ? (desc ? ' ▼' : ' ▲') : '');
                if (col.help) btn.title = t(lang, col.help);
                btn.addEventListener('click', () => {
                    if (sortKey === col.key) desc = !desc;
                    else { sortKey = col.key; desc = true; }
                    page = 0;
                    sortNow();
                    render();
                });
                th.appendChild(btn);
            } else {
                th.textContent = t(lang, col.key);
            }
            tr.appendChild(th);
        }
    }

    function cellValue(id, key) {
        switch (key) {
            case 'colBalance': return fmt(agents.balance[id] * finalFactor);
            case 'colTxCount': return fmt(agents.txCount[id]);
            case 'colTxAmount': return fmt(agents.txAmount[id]);
            case 'colRxCount': return fmt(agents.rxCount[id]);
            case 'colRxAmount': return fmt(agents.rxAmount[id]);
            case 'colMinted': return fmt(agents.minted[id]);
            case 'colJoinDay': return String(agents.joinDay[id]);
            default: return '';
        }
    }

    function renderBody(table) {
        const tbody = table.createTBody();
        const from = page * PAGE_SIZE;
        const to = Math.min(count, from + PAGE_SIZE);
        for (let pos = from; pos < to; pos++) {
            const id = order[pos];
            const tr = tbody.insertRow();
            tr.dataset.id = String(id);
            if (!agents.active[id]) tr.classList.add('row-churned');

            const rankCell = tr.insertCell();
            rankCell.className = 'rank-cell';
            rankCell.textContent = t(lang, 'rankFormat', { rank: pos + 1 });

            const memberCell = tr.insertCell();
            memberCell.className = 'member-cell';
            const img = document.createElement('img');
            img.className = 'identicon';
            img.width = 24;
            img.height = 24;
            img.src = identiconURL(id, seed, agents.persona[id], 24);
            img.title = `#${id}`;
            img.alt = `#${id}`;
            memberCell.appendChild(img);

            const personaCell = tr.insertCell();
            const dot = document.createElement('span');
            dot.className = 'persona-dot';
            dot.style.background = PERSONA_COLORS[agents.persona[id] % PERSONA_COLORS.length];
            personaCell.appendChild(dot);
            personaCell.appendChild(document.createTextNode(personaName(agents.persona[id])));

            for (const key of ['colBalance', 'colTxCount', 'colTxAmount', 'colRxCount', 'colRxAmount', 'colMinted', 'colJoinDay']) {
                const td = tr.insertCell();
                td.className = 'num-cell' + (sortKey === key ? ' sorted-col' : '');
                td.textContent = cellValue(id, key);
            }

            const statusCell = tr.insertCell();
            statusCell.className = agents.active[id] ? '' : 'status-churned';
            statusCell.textContent = agents.active[id] ? '\u2014' : t(lang, 'statusChurned');
        }
        tbody.addEventListener('click', (e) => {
            const row = e.target.closest('tr[data-id]');
            if (row) openDialog(parseInt(row.dataset.id, 10));
        });
    }

    function renderPager() {
        const pager = $('rankingPager');
        pager.innerHTML = '';
        const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
        const from = page * PAGE_SIZE + 1;
        const to = Math.min(count, (page + 1) * PAGE_SIZE);
        const mk = (label, target, disabled) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'pager-btn';
            b.textContent = label;
            b.disabled = disabled;
            b.addEventListener('click', () => { page = target; render(); });
            pager.appendChild(b);
        };
        mk('|«', 0, page === 0);
        mk('«', Math.max(0, page - 1), page === 0);
        const label = document.createElement('span');
        label.className = 'pager-label';
        label.textContent = t(lang, 'pagerPage', { page: page + 1, total: pages });
        pager.appendChild(label);
        mk('»', Math.min(pages - 1, page + 1), page >= pages - 1);
        mk('»|', pages - 1, page >= pages - 1);
        const range = document.createElement('span');
        range.className = 'pager-range';
        range.textContent = t(lang, 'rankingRange', { total: fmt(count), from: fmt(from), to: fmt(to) });
        pager.appendChild(range);
    }

    function render() {
        const table = $('rankingTable');
        table.innerHTML = '';
        renderHead(table);
        renderBody(table);
        renderPager();
    }

    function sparkline(canvas, id) {
        const pts = [];
        const days = [];
        for (const s of sim.snapshots) {
            if (id < s.count) {
                pts.push(s.balance[id] * s.factor);
                days.push(s.day);
            }
        }
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = canvas.clientWidth || 280;
        const h = canvas.clientHeight || 56;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        const ctx = canvas.getContext('2d');
        if (pts.length < 2) return;
        const max = Math.max(...pts, 1);
        const x = (i) => 2 + (i / (pts.length - 1)) * (w - 4);
        const y = (v) => h - 3 - (v / max) * (h - 8);

        // redrawn per hover: base area/line, plus a guide + day/value readout
        const draw = (hoverIdx = -1) => {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.beginPath();
            ctx.moveTo(x(0), y(pts[0]));
            for (let i = 1; i < pts.length; i++) ctx.lineTo(x(i), y(pts[i]));
            ctx.strokeStyle = '#4CAF50';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.lineTo(x(pts.length - 1), h - 1);
            ctx.lineTo(x(0), h - 1);
            ctx.closePath();
            ctx.fillStyle = 'rgba(76, 175, 80, 0.15)';
            ctx.fill();
            if (hoverIdx < 0) return;
            const hx = x(hoverIdx);
            const hy = y(pts[hoverIdx]);
            ctx.strokeStyle = '#898781';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(hx, 2);
            ctx.lineTo(hx, h - 1);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(hx, hy, 3, 0, Math.PI * 2);
            ctx.fillStyle = '#2e7d32';
            ctx.fill();
            const label = `${t(lang, 'dayLabel', { d: days[hoverIdx] })}: ${fmt(pts[hoverIdx])}`;
            ctx.font = '11px ui-monospace, Menlo, monospace';
            const tw = ctx.measureText(label).width;
            const tx = Math.min(Math.max(hx - tw / 2, 2), w - tw - 2);
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'white';
            ctx.strokeText(label, tx, 12);
            ctx.fillStyle = '#0b0b0b';
            ctx.fillText(label, tx, 12);
        };
        draw();
        canvas.style.cursor = 'crosshair';
        canvas.onmousemove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const rel = (e.clientX - rect.left - 2) / (w - 4);
            const idx = Math.min(pts.length - 1, Math.max(0, Math.round(rel * (pts.length - 1))));
            draw(idx);
        };
        canvas.onmouseleave = () => draw();
    }

    function kvRow(table, key, value) {
        const tr = table.insertRow();
        const th = document.createElement('th');
        th.textContent = t(lang, key);
        tr.appendChild(th);
        const td = tr.insertCell();
        td.textContent = value;
    }

    function openDialog(id) {
        const body = $('agentDialogBody');
        body.innerHTML = '';

        const head = document.createElement('div');
        head.className = 'dialog-head';
        const img = document.createElement('img');
        img.className = 'identicon identicon-lg';
        img.width = 40;
        img.height = 40;
        img.src = identiconURL(id, seed, agents.persona[id], 40);
        img.title = `#${id}`;
        img.alt = `#${id}`;
        head.appendChild(img);
        const title = document.createElement('div');
        const h = document.createElement('div');
        h.className = 'dialog-title';
        const rank = order.indexOf(id) + 1;
        h.textContent = t(lang, 'rankFormat', { rank });
        const badge = document.createElement('div');
        badge.className = 'dialog-badges';
        badge.textContent = agents.active[id]
            ? personaName(agents.persona[id])
            : `${personaName(agents.persona[id])} \u00b7 ${t(lang, 'statusChurned')}`;
        title.appendChild(h);
        title.appendChild(badge);
        head.appendChild(title);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'dialog-close';
        close.textContent = '×';
        close.addEventListener('click', () => $('agentDialog').close());
        head.appendChild(close);
        body.appendChild(head);

        const spark = document.createElement('canvas');
        spark.className = 'dialog-spark';
        body.appendChild(spark);
        const sparkLabel = document.createElement('div');
        sparkLabel.className = 'dialog-spark-label';
        sparkLabel.textContent = t(lang, 'dialogBalanceHistory');
        body.appendChild(sparkLabel);

        const table = document.createElement('table');
        table.className = 'kv-table';
        kvRow(table, 'colBalance', fmt(agents.balance[id] * finalFactor));
        kvRow(table, 'dialogRawBalance', fmt(agents.balance[id]));
        kvRow(table, 'colTxCount', fmt(agents.txCount[id]));
        kvRow(table, 'colTxAmount', fmt(agents.txAmount[id]));
        kvRow(table, 'colRxCount', fmt(agents.rxCount[id]));
        kvRow(table, 'colRxAmount', fmt(agents.rxAmount[id]));
        kvRow(table, 'colMinted', fmt(agents.minted[id]));
        kvRow(table, 'colJoinDay', String(agents.joinDay[id]));
        const ftd = agents.firstTxDay[id];
        kvRow(table, 'dialogFirstTxDay',
            ftd === -1 ? t(lang, 'dialogNeverGuest') : ftd === -2 ? t(lang, 'dialogNoTx') : String(ftd));
        body.appendChild(table);

        $('agentDialog').showModal();
        sparkline(spark, id);
    }

    sortNow();
    render();

    return {
        openDialog,
        setLang(next) {
            lang = next;
            render();
        },
    };
}
