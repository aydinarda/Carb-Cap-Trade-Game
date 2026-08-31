# Carbon Cap & Trade — Classroom Game

A real-time multiplayer cap-and-trade carbon game for the classroom. Students run
companies in an industry **they pick at join** (the ten-year emission history is
generated for that industry); the instructor allocates emission allowances under a
cap mechanism — **switchable between years** — and steps the class through game
years: cap stage (allocation, or an auction where the mode has one) → emission
reveal → student market → penalty settlement.

The game design comes from `../../Renjie/game_design/setup copy.ipynb` (read-only
reference — never edit that folder). Currently implemented:

| Mechanic | Status |
|---|---|
| **Grandfathering** | ✅ fully playable — free credits ∝ past ten-year emissions, cap = 80% of class baseline |
| **Benchmarking** | ✅ fully playable — a flat sector benchmark set 40% below the sector average, tightening yearly by the LRF; no primary sale, so the gap is closed by cutting emissions or on the market |
| **Auctioning** | ✅ fully playable — no free credits; a single-round sealed-bid uniform-price auction sells a supply that shrinks each year by the LRF |
| **Hybrid** | ✅ fully playable — chosen sectors receive a share of their benchmark free, and the *residual* cap is auctioned. Free allocation is **deducted** from the auction pool, never added on top, so `Σfree + pool` is the cap however the shares are set. Ships at Power & Utilities 0.45 / Heavy Materials 0.21 / others 0 — about a quarter of the cap free, which `hybrid-share-sweep` puts clear of both walls (VWAP 68.8, against 74.6 auctioning and 23.4 benchmarking) |
| **Student market** | ✅ order book: limit buy/sell orders, price-time priority, partial fills, no shorting — prices come entirely from students |
| **Abatement** | ✅ each company chooses a cut fraction against its sector MAC curve (`a + b·f`); optimal play is where marginal cost meets the carbon price |
| **Penalty settlement** | ✅ uncovered tonnes are charged `penaltyRate` each — the effective ceiling on the market price |
| **Banking / make-good** | ✅ EU-ETS carry: a surplus year banks allowances, an uncovered year carries a make-good debt on top of the penalty; leftovers are monetized at the final price |
| **Market bots** | ✅ four archetypes (compliance, market maker, speculator, noise) in any mode with a market; they anchor to the previous year's price with the penalty as the ceiling. **About five is the sweet spot** — two market makers already keep the book two-sided, and past that extra bots cost CPU without tightening the market |
| **Mode switching** | ✅ instructor can change the cap mechanism in the lobby and between years |

A company's raw score is its cumulative cost — abatement spend + credit purchases − sale
income + penalties. The **leaderboard** turns that into **points out of 100, highest wins**,
measuring two decisions against what each was worth at the prices actually on screen:

- **trading gap** — cost above the cheapest way that year's emissions could have been
  covered, given what the company was endowed with (free allocation + carry). Where there
  was an auction, "cheapest" is the lower of the clearing price and the market.
- **investment gap** — value forgone on the retrofit decision, against the same payback rule
  the bots follow, at the price that was known when the decision was taken.

Both are divided by the company's baseline emission, so the table is size-neutral, then
combined and mapped through `100 × exp(−gap / pointsScale)`. Measured over 2 000 simulated
students the behaviour archetypes separate cleanly — `rational` 63 points, `hedger` 48,
`opportunist` 32, `passive` 1 — so it measures skill rather than which industry they drew.
Pure-trader bots get no points (no baseline, nothing to abate) and are ranked after the
emitters on raw P&L. `scoring.investmentWeight` and `scoring.pointsScale` are the two knobs.

## Run locally

```bash
pnpm install
pnpm dev        # client on :5173 (proxied), server on :3001
```

Open `http://localhost:5173/host` as the instructor (host key: `letmein` unless
`HOST_KEY` is set) and `http://localhost:5173/` on student devices.

Production build:

```bash
pnpm build      # → dist/client + dist/server
pnpm start      # single server on :3001 serving both
```

## Instructor run-book (one class session)

1. Open `/host`, pick the cap mechanism, enter the host key, **Create session**.
   Adjust settings in the lobby if needed (penalty rate, auction supply ratio, cap
   reduction factor, per-sector benchmarks). Optionally add market bots.
2. Project the lobby: students join at the site root with the 4-letter room code,
   pick an industry, and get a generated 10-year emission history.
3. **Start Year 11** — the roster locks, free credits are allocated.
4. Cap stage: under auctioning students submit a sealed bid (quantity + max price);
   under grandfathering and benchmarking there is nothing to submit — the panel
   shows the allocation and the gap it leaves. Under **hybrid** it is both at once:
   the panel shows what the sector was issued free and asks for a bid on the residual,
   which is zero-defaulted for a sector whose share is 0.
   Set the per-sector free shares in the lobby ("Free allocation share") — the class
   baseline box shows the resulting `cap = free + auctioned` split and warns if the
   shares leave nothing to auction.
5. **Close cap stage** — the auction clears (auctioning), then expected emissions
   are shown. Realized emissions are drawn at year end, not here.
6. **Open the market** — students post limit buy/sell orders; the book matches them
   live. The host screen shows the order book, trades feed, and price stats.
7. **Close market & settle** — emissions are realized, uncovered tonnes are charged
   the penalty rate and carried as a make-good debt, surpluses are banked, and the
   leaderboard updates.
8. **Start Year 12** — optionally switch the cap mechanism first (year-summary
   panel); the ten-year window moves and allocation recomputes. Repeat.
9. **End game** anytime for the final leaderboard.

Refreshing a device resumes the same identity automatically (token in localStorage).

## Tests

```bash
pnpm ref             # the sector table and every formula, printed from the config in
                     # force — never a transcription. `pnpm ref -- sectors` or
                     # `-- formulas` for one section; `-- --price 90 --year 16` to
                     # see the curves and the tightened benchmark at another point.

pnpm test            # engine + config + sim unit tests. Grandfathering math is
                     # verified against the designer's own xlsx output, and
                     # server/__tests__/golden.spec.ts pins the engine's literal
                     # output so a refactor cannot move it unnoticed.
pnpm typecheck       # client, server and sim

# Wire-protocol smoke tests — each needs `pnpm dev` running.
node scripts/bots-smoke.mjs    # auctioning + bots
node scripts/bench-smoke.mjs   # benchmarking: allocation, tightening, seeded traders
node scripts/gf-smoke.mjs      # grandfathering: bots quote both sides
node scripts/hybrid-smoke.mjs  # hybrid: the free/auctioned split, and that it holds as
                               # the cap tightens. Set GAME_URL to point at another port.
```

## Deploy to Render

Two shapes are supported. **The live classroom deploy is the split one** — frontend and
backend are separate Render services that deploy independently, so a change to the wire
contract has to survive one side being a version ahead of the other.

**Split (what is deployed):**

- Backend — Web Service. Build `corepack enable && pnpm install && pnpm build:server`,
  start `pnpm start`. Env: `HOST_KEY` (instructor secret — set this!), `CLIENT_ORIGIN`
  (the frontend URL), optional `SEED`, optional `BROADCAST_FLUSH_MS`.
- Frontend — Static Site. Build `corepack enable && pnpm install && pnpm build`, publish
  `dist/client`. Env: `VITE_SERVER_URL` (the backend URL).

**Single service** (simpler, everything on one origin): build
`corepack enable && pnpm install && pnpm build`, start `pnpm start`. `dist/client` is
present so the server serves the SPA too, and neither `CLIENT_ORIGIN` nor
`VITE_SERVER_URL` is needed.

`BROADCAST_FLUSH_MS` (default 100) is the coalescing window for state pushes — see
Architecture. Lower it for a snappier order book, raise it if the instance is CPU-bound.

⚠️ **Free-tier warning**: the instance spins down after ~15 min idle. Game state
lives in memory, so a spin-down wipes the session, and the first request after idle
takes ~50 s. Open `/host` a few minutes before class starts; for a real session,
consider the paid starter instance for game day.

## Architecture

```
shared/config/    GameConfig — every tunable number in one nested object, plus the
                  deep-merge that turns a partial override into a full config
shared/           types, constants (the sector tables), event contract, game engine
  engine/         playerGeneration, emissions, order book, settlement; the four
                  allocation regimes behind one CapMechanism interface; and the
                  abatement MAC curves behind one AbatementModel interface
server/bots/      four bot archetypes; stepBots() advances them one tick and is
                  shared by the live BotManager interval and the simulator
server/broadcaster.ts  owns when and to whom state is pushed (see below)
server/           Express + Socket.IO: Session state machine, role-scoped views
src/app/          React client: net/ (socket + context), screens/player, screens/host
sim/              headless scenario harness (see below)
```

Nothing in the engine reads a hardcoded number: `new Session(mode, seed, override)` takes
a deep-partial `GameConfig`, so a scenario can change the penalty rate, a sector's
abatement curve, emission volatility or the market maker's spread without touching code.
The host UI and the wire payload are unchanged — the host snapshot carries a narrow
derived `HostConfigView`, not the whole config.

## Simulation harness

`pnpm sim` runs scenarios headlessly and in-process — no sockets, so a five-year game
settles in milliseconds and a full sweep is seconds. It drives the real `Session` through
the same methods a socket would and calls the real `stepBots`, so what it measures is the
shipped engine, not a model of it.

```bash
pnpm sim -- --list                                  # the scenario catalog
pnpm sim -- --scenario depth-sweep --seeds 20       # one sweep, 20 seeds each
pnpm sim -- --scenario abatement-models --trades    # also record every trade
pnpm sim -- --scenario hybrid-share-sweep --seeds 30 # where hybrid separates from auctioning
pnpm sim                                            # everything, 5 seeds
```

Alongside the liquidity bots, each run populates the class with **simulated students** —
four behaviour archetypes (`passive`, `rational`, `hedger`, `opportunist`) crossed with a
sector mix, each with its own participation rate, cover target and price noise. The
behaviour mix moves the market far more than the bot mix does.

Everything lands in one SQLite file, `sim/out/sim.db` (via Node's built-in `node:sqlite`
— no dependency), appended across runs so sweeps stay comparable. Tables: `runs`, `years`,
`players`, `trades`; plus views `v_price_by_scenario`, `v_depth_by_scenario` and
`v_efficiency_by_behaviour` for the recurring questions.

### Dashboard

```bash
pnpm sim:viz          # -> http://localhost:3002   (--port / --db to override)
```

A local, build-free dashboard over that file: price discovery per cap regime, the depth
threshold, price by abatement curve, the stringency and penalty sweeps, and cost-above-optimum
per student archetype — plus a read-only SQL box for anything the panels don't cover. Every
chart has a table view, and `?theme=light` / `?theme=dark` pins the mode.

One metric is analysis-only and never surfaced in the game: `efficient_price`, the price
that would clear the class's aggregate shortage against its own MAC curves. It is the
yardstick for whether the market found the right answer — the in-game signal remains the
previous year's discovered price plus the penalty ceiling.

All game logic runs server-side; clients render role-scoped snapshots pushed after
every mutation. Players never see others' private numbers or unrevealed emissions.

### Broadcast discipline

At 100 players a snapshot fan-out is the most expensive thing the server does, and
`/healthz` shares that event loop — so a class big enough to saturate it fails Render's
health check. `server/broadcaster.ts` owns the two levers:

- **Coalescing.** Player actions and bot ticks `schedule()` a flush (trailing debounce,
  `BROADCAST_FLUSH_MS`, default 100 ms) instead of fanning out inline. Host actions —
  phase transitions, settings, roster edits — call `flushNow()`, because a delay between
  "Open the market" and the class seeing it is the one place lag is noticed.
- **Targeted sends.** A join or reconnect `sync()`s that one socket rather than pushing
  the full room; the host snapshot is built once per flush rather than once per host tab.

Measured on a 100-player, 6-year grandfathering session with no bots: 4 773 MB pushed →
271 MB, action-ack p95 513 ms → 4 ms, `/healthz` p95 519 ms → 18 ms. `buildPlayerHistory`
(host-only, and by far the heaviest view) is one pass per year with completed years
memoized — 0.87 ms → 0.04 ms per call at 100 players × 8 years.

### Open questions for the game designer

- `Year_10` receives the *oldest* generated value in the notebook but is also used
  as the baseline year — implemented verbatim, intent to confirm.
- Does the free-credit limit stay fixed after Year 11 (current behavior) or decline?
- No cash ledger: buy orders cost nothing, so the price signal is soft. If a cash
  balance is added later, the Order/Trade model already records every price.
- Benchmarking production quantities and the auction format are still unspecified.
