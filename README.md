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
| **Student market** | ✅ order book: limit buy/sell orders, price-time priority, partial fills, no shorting — prices come entirely from students |
| **Abatement** | ✅ each company chooses a cut fraction against its sector MAC curve (`a + b·f`); optimal play is where marginal cost meets the carbon price |
| **Penalty settlement** | ✅ uncovered tonnes are charged `penaltyRate` each — the effective ceiling on the market price |
| **Banking / make-good** | ✅ EU-ETS carry: a surplus year banks allowances, an uncovered year carries a make-good debt on top of the penalty; leftovers are monetized at the final price |
| **Market bots** | ✅ four archetypes (compliance, market maker, speculator, noise) in any mode with a market; they anchor to the previous year's price with the penalty as the ceiling. **About five is the sweet spot** — two market makers already keep the book two-sided, and past that extra bots cost CPU without tightening the market |
| **Mode switching** | ✅ instructor can change the cap mechanism in the lobby and between years |

Scores are cumulative costs — abatement spend + credit purchases − sale income +
penalties — and the leaderboard ranks emitters by distance from their own optimum,
so it measures skill rather than which industry they drew.

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
   shows the allocation and the gap it leaves.
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
pnpm test            # engine + config + sim unit tests. Grandfathering math is
                     # verified against the designer's own xlsx output, and
                     # server/__tests__/golden.spec.ts pins the engine's literal
                     # output so a refactor cannot move it unnoticed.
pnpm typecheck       # client, server and sim

# Wire-protocol smoke tests — each needs `pnpm dev` running.
node scripts/bots-smoke.mjs    # auctioning + bots
node scripts/bench-smoke.mjs   # benchmarking: allocation, tightening, seeded traders
node scripts/gf-smoke.mjs      # grandfathering: bots quote both sides
```

## Deploy to Render

Single **Web Service**:

- Build command: `corepack enable && pnpm install && pnpm build`
- Start command: `pnpm start`
- Env vars: `HOST_KEY` (instructor secret — set this!), optional `SEED` for a
  reproducible session.

⚠️ **Free-tier warning**: the instance spins down after ~15 min idle. Game state
lives in memory, so a spin-down wipes the session, and the first request after idle
takes ~50 s. Open `/host` a few minutes before class starts; for a real session,
consider the paid starter instance for game day.

## Architecture

```
shared/config/    GameConfig — every tunable number in one nested object, plus the
                  deep-merge that turns a partial override into a full config
shared/           types, constants (the sector tables), event contract, game engine
  engine/         playerGeneration, emissions, order book, settlement; the three
                  allocation regimes behind one CapMechanism interface; and the
                  abatement MAC curves behind one AbatementModel interface
server/bots/      four bot archetypes; stepBots() advances them one tick and is
                  shared by the live BotManager interval and the simulator
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

### Open questions for the game designer

- `Year_10` receives the *oldest* generated value in the notebook but is also used
  as the baseline year — implemented verbatim, intent to confirm.
- Does the free-credit limit stay fixed after Year 11 (current behavior) or decline?
- No cash ledger: buy orders cost nothing, so the price signal is soft. If a cash
  balance is added later, the Order/Trade model already records every price.
- Benchmarking production quantities and the auction format are still unspecified.
