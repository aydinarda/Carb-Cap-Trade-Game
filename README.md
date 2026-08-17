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
| **Market bots** | ✅ four archetypes (compliance, market maker, speculator, noise) in any mode with a market; they anchor to the previous year's price with the penalty as the ceiling |
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
   Adjust settings in the lobby if needed (regulator price, low/high penalty rates).
2. Project the lobby: students join at the site root with the 4-letter room code,
   pick an industry, and get a generated 10-year emission history.
3. **Start Year 11** — the roster locks, free credits are allocated.
4. Cap stage: students request extra credits from the regulator pool (20% of the
   baseline; oversubscription is cut pro-rata; stragglers default to 0).
5. **Close cap stage** — realized emissions are drawn and revealed.
6. **Open the market** — students post limit buy/sell orders; the book matches them
   live. The host screen shows the order book, trades feed, and price stats.
7. **Close market & settle penalties** — shorts covered by leftover unsold offers
   pay the low rate, the rest the high rate; the leaderboard updates.
8. **Start Year 12** — optionally switch the cap mechanism first (year-summary
   panel); the ten-year window moves and allocation recomputes. Repeat.
9. **End game** anytime for the final leaderboard.

Refreshing a device resumes the same identity automatically (token in localStorage).

## Tests

```bash
pnpm test            # engine unit tests (grandfathering math is verified against
                     # the designer's own xlsx output, transcribed as a fixture)
pnpm typecheck
node scripts/bots-smoke.mjs   # auctioning + bots wire-protocol smoke (needs the server running)
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
shared/           types, constants, event contract, pure game engine (unit-tested)
  engine/         playerGeneration, emissions, abatement, order book, settlement,
                  and the three allocation regimes (grandfathering, benchmarking,
                  auctioning) behind one CapMechanism interface — everything
                  mode-specific lives there, so a combined regime is a new file
server/bots/      four bot archetypes driven by one interval (BotManager)
server/           Express + Socket.IO: Session state machine, role-scoped views
src/app/          React client: net/ (socket + context), screens/player, screens/host
```

All game logic runs server-side; clients render role-scoped snapshots pushed after
every mutation. Players never see others' private numbers or unrevealed emissions.

### Open questions for the game designer

- `Year_10` receives the *oldest* generated value in the notebook but is also used
  as the baseline year — implemented verbatim, intent to confirm.
- Does the free-credit limit stay fixed after Year 11 (current behavior) or decline?
- No cash ledger: buy orders cost nothing, so the price signal is soft. If a cash
  balance is added later, the Order/Trade model already records every price.
- Benchmarking production quantities and the auction format are still unspecified.
