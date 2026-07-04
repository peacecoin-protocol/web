# Community Token Simulator

An agent-based, browser-only simulator for PCE community token economics:
ARIGATO CREATION minting (increase) and the decay factor.
No wallet, no backend — pure client-side JavaScript.

## What it simulates

- **Decay** — a faithful port of `PCECommunityToken.getCurrentFactor`
  (peacecoin-protocol/core): compounding at UTC day boundaries every
  `decreaseIntervalDays`, factor multiplied by `afterDecreaseBp/10000`, computed
  with the contract's exponentiation-by-squaring in exact BigInt WAD (1e18) math.
- **Increase (ARIGATO CREATION)** — a faithful port of `ArigatoCreation.compute`:
  per-transfer mint to the sender with the usage-deviation penalty, message-length
  scaling, the daily cap (`midnightTotalSupply x maxIncreaseOfTotalSupplyBp / 10000`),
  per-sender allowances, and the separate guest quota for first-day addresses.
- **Population dynamics** — growth curves (none / linear / exponential / logistic)
  plus annual churn. Newcomers receive a welcome transfer from their richest
  neighbor (configurable share of the community mean, capped at a share of
  the sender's balance) and are guests on the day of their first actual
  transfer (normally the join day). Leavers spend the configurable exit-spend share of their
  balance in one farewell transfer (default 100% — "use it up before you
  leave"); the remainder decays away like a dormant wallet.
- **Personas** — a fully editable list (add/remove up to 8, named freely;
  defaults: Regular / Casual / Hoarder / Merchant). Each persona has a share,
  Poisson transfer frequency, transfer size distribution, message length
  range, initial balance weight with a per-persona log-normal spread
  (balance sigma; 0 = equal within the persona), decay response,
  recirculation share and a
  **receive weight** — personas with receive weight > 1 attract transfers and
  become network hubs (this replaced the old graph-level merchant weight).
- **Decay-response behaviour** — each persona has a `decay response` elasticity:
  transfer frequency scales with the annualized decay rate (cap configurable,
  default 5x), with an extra spending spike on the eve of each decay
  application (Woergl-style "spend it before it shrinks"; gain configurable,
  default 10). Set the persona value to 0 for decay-indifferent agents.
- **Recirculation** — each persona can re-spend a share of the previous day's
  receipts back into its neighborhood (one transfer per day, merchant hub
  weighting off — modelling suppliers/staff). Default: merchants 70%.
- **Multi-value sweeps** — sweepable parameters are +/- value lists: give any
  parameter two or more values and it becomes a sweep axis; multiple axes run
  as a cartesian product in parallel Web Workers (one run per combo, fixed
  seed 42). Tabs above the results switch the entire detail view (tiles,
  charts, ranking, network) between combos; with one axis the sweep summary
  also plots final-day metrics against the parameter. A cost-estimate card
  shows the run count, transfer count, wall time and memory before you
  commit, and runs are hard-capped at 1000.
- **Social graph** — scale-free (Barabasi-Albert, attachment fitness = persona
  receive weight), clustered (small-world) or sequential random, with a
  configurable per-member connection count and cluster size. Recipients are
  picked among graph neighbors, weighted by the recipient persona's receive
  weight.
- **PCE link** — a port of the PCE side of `PCEToken.sol`. PCE itself decays
  0.2% per week: the contract counts actual Wednesday boundaries with a
  998e18/1000e18 rate base, the simulator uses a plain 7-day schedule with the
  community factor's WAD routine — identical shape, wei-level rounding
  differences. The community token is created from a PCE deposit
  (`createToken`: initial reserve = initial supply / dilution factor), and
  members keep swapping PCE in at a configurable Poisson frequency and average
  amount: each swap-in locks PCE into the reserve and mints community tokens
  at the live rate (`dilution x communityFactor / pceFactor`, exactly
  `swapToLocalToken`). The dilution factor and both swap-in parameters are
  sweepable. Charts show the PCE-redemption value of the whole supply vs the
  locked reserve (their gap = unbacked ARIGATO supply) and the daily PCE
  inflow; PCE tiles report the current swap rate, redemption value, reserve
  and cumulative inflow. Community-to-PCE redemptions are not simulated
  (`swapableToPCERate` defaults to 0 on-chain).
- **Meta-transaction fees (PIP-13)** — every transfer is a meta-transaction:
  the sender is charged a configurable PCE-denominated fee, converted at the
  live swap rate and burned from their community-token balance (fees below
  one whole token round to zero on the community side; the reserve outflow is
  exact), while the relayer is paid the PCE out of the community reserve
  (`_collectFeeAsPCE` + `swapFeeFromLocalToken`). On-chain the fee floats
  with the chain's base fee; the simulator uses a constant per-tx fee
  (default = the live on-chain value). When the reserve cannot cover the fee,
  no relayer carries the tx and all transfers halt (a warning reports the
  starvation day). Fees therefore drain the reserve continuously — swap-ins
  must outrun them.

Every section header carries a small "?" button that expands an inline,
bilingual help panel explaining the parameters, formulas and how to read the
charts (works on touch devices — no hover tooltips).

## Results views (explorer-inspired)

The results layout borrows the information design of the PCE web explorer:

- **Overview tiles** — opening/closing supply, total minted, decay losses,
  velocity (transfer volume / closing supply), transfer counts and volume,
  active members, Gini and top-10% share, in a bordered tile grid.
- **Decay-schedule stats** — annualized rate, current factor and application
  count, shown as tiles inside the summary.
- **Time-series charts** — total supply, daily increase (ARIGATO mint), daily
  decay, transfers per day, transfer volume per day, active users
  (explorer-style: an account is active on a day when it sends or receives at
  least one transfer that day), population (total joined / churned +
  per-persona counts) and wealth distribution. The "active members"
  tile uses the explorer definition on the final day; churned wallets are
  dormant, not deleted — blockchains have no account cancellation.
- **Agent ranking** — all agents, sortable by balance / sent / received /
  minted / join day, with pagination, deterministic identicons and a row-click
  detail dialog (per-agent stats + a balance sparkline built from the
  snapshots). Sent/received/minted totals are
  face-value (pre-decay) units, so community-wide sent = received exactly.
- **Social graph** — node size follows the percentile rank of a selectable
  metric (balance / sent / received / minted); hover shows a stat tooltip,
  click highlights the 2-hop neighborhood, double-click opens the detail
  dialog. Day slider replays balance snapshots.

## Model notes / limitations

- UI inputs are natural percentages (e.g. decay rate 0.2% per application);
  they are converted to the contract's basis-point units internally
  (0.2% decay -> `afterDecreaseBp` 9980, mint cap 1% -> 100 bp, ...).
- Balances are simulated in whole-token units (not wei). The decay factor is
  computed with the contract's WAD routine from day 0 in one shot; on-chain the
  factor is re-materialized on every transfer, so long chains of floors can
  differ by tens of wei — irrelevant for trend analysis, as are the
  per-transfer whole-token floors. Whole-token math stays
  exact while every intermediate product fits in 2^53 — the engine derives the
  corresponding raw-supply ceiling from the daily mint cap (roughly 1e9 tokens
  at the default cap) and stops with a warning beyond it.
- The simulation day starts at UTC 0:00, so "apply decay when `day % interval == 0`"
  is equivalent to the contract's `floor(elapsedDays / interval)`.
- Daily mint counters are 0-based. The contract's per-sender sentinel of 1 is
  corrected inside `ArigatoCreation.compute` (equivalent except for a same-day
  first-tx account, where on-chain is 1 wei looser); the on-chain global/guest
  counters start at 1 wei uncorrected, making their effective caps 1 wei
  lower — far below one whole-token unit.
- The current `transfer()`/`transferFrom()` pass `messageCharacters = 1`; the
  persona message-length settings model message-carrying transfers
  (`ArigatoCreation.compute`'s variable-message scenario).
- The initial cohort is never treated as guests (on-chain, a first-ever transfer
  on day 0 could be); newcomers become guests on the day of their first actual
  transfer (a failed welcome transfer does not consume the guest day).
- Mean-balance (welcome sizing), Gini and top-10% metrics include dormant
  (churned) balances by design — dormant wallets still exist on-chain.
- Churn is uniform across personas (persona-specific churn is future work).
- Runs are deterministic for a given seed (single mulberry32 stream).
- Decay-response formula: frequency boost = 1 + response x annualized decay
  (capped), eve-of-decay spike = response x per-application loss x gain. The
  cap and gain are the "shared behavior" settings; per-persona strength is the
  `decay response` value.
- Recirculation is one aggregated transfer per agent per day (a share of
  yesterday's receipts), not itemized supplier payments.
- `splitToken` (PIP-16 rebase) and `increaseTokenValue` (exchange-rate changes
  from extra PCE deposits) are out of scope; `exchangeRate` stays at the
  creation-time dilution factor.

## Verification

`engine.js` and `graph.js` are DOM-free ES modules. The numeric core is checked
against test vectors from `core/test/PCE.t.sol` (e.g. the 84-day WAD factor
`976262247894715033`), conservation and daily-cap properties:

```bash
node simulator/test.mjs
```

## Local testing

```bash
python3 serve.py 8000   # from the repository root; sends no-cache headers
# (plain `python3 -m http.server` also works, but browsers may cache stale JS)
# open http://localhost:8000/simulator/
```

The only external dependency is Chart.js, loaded from a CDN at a pinned version.
