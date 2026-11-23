# k6 load tests: one hybrid class

Two sets, the same game with 50 or 100 students:

```bash
BASE_URL=https://carb-cap-trade-api.onrender.com k6 run scripts/k6/class-50.js
BASE_URL=https://carb-cap-trade-api.onrender.com k6 run scripts/k6/class-100.js
```

Or from GitHub: Actions → "Load test (k6, hybrid class)" → Run workflow. Written against k6
v2.0.0. Do not run it against a backend a real class is
using: they share the instance.

`scripts/load-full-session.mjs` (Node, all four modes) is a separate test and stays.

## What one run does

- **setup:** wakes the backend (`/healthz`, up to 2 min for a sleeping free instance), creates a
  hybrid room, adds the bots and every hybrid RL model the server lists (one company each), and
  logs the room code so you can join in a browser and watch.
- **host** (1 VU): waits until the whole class has joined, then plays `YEARS` rounds:
  `startYear` → cap stage `CAP_WINDOW` s → `closeCapStage`, `openTrade` → market `ROUND_WINDOW` s →
  `closeTrade` → year summary `REVIEW_GAP` s → `advanceYear`; then `endGame`. Logs each year's VWAP
  and auction price, and the leaderboard's top points at the end. It also plays the events in
  `EVENTS`, as an instructor would from the host panel: energy crisis, rate cut, subsidy, tech
  unlock, nuclear closure, free allocation cut, and a borrowing referendum (chat, then vote; the
  next year waits for its result). Students say a line in the chat now and then and all vote.
- **students** (50 or 100 VUs): join during the lobby (spread over `JOIN_SPREAD` s), then each
  round: sometimes switch borrowing, bid at the auction (a 3-step sweep or one bid), and act every
  `TRADE_MIN`–`TRADE_MAX` s in the market: cover what they need, otherwise small buys and sells
  off the fair value for the whole window; cancel orders and abate now and then. A tonne is worth
  min(penalty, MAC at the cost-minimising cut), quoted with symmetric noise, as in
  `scripts/load-full-session.mjs`.
- **health** (1 request / 2 s): `GET /healthz` for the whole run. It shares the event loop with
  the game, so it is what Render's health check sees.

A socket that drops (closed by the server, Render's proxy or the network, not by the test)
reconnects as the browser does: after 1 s, then 2, 4 and every 5 s, with the player's token (the
host's for the host), so the student keeps playing. Before 2026-11-17 a dropped student stopped
for good, which a browser never does. Each drop is logged with what came before and after it:

```
student 17: connection dropped in trade, year 6 · close 1006 "unexpected EOF" · open 512.3 s · last message from the server 0.4 s before · acks pending: player:placeOrder#31 (0.2 s) · reconnecting
student 17:   before: -9.8…-0.4 ←snapshot 22 KB ×12 · -3.1 →player:placeOrder#30 · -3.0 ←ack#30 92 ms · -0.2 →player:placeOrder#31 · …
student 17: back after 1.3 s (attempt 1)
student 17:   after: +0.0 ←connected · +0.0 ←snapshot 23 KB · +0.1 →player:placeOrder#1 · …   (10 s after it is back)
```

The server logs the same drop from its side in Render's log (`server/connLog.ts`): `[conn] drop`
with Engine.IO's reason, last ping out, last pong and last packet in, last flush and unsent
packets, then `[conn]   before:`, and `[conn] back … after X s` with `[conn]   after:`.

At the defaults one run takes about 19 minutes (plus `START_DELAY` beyond the class's join window).

## Watching and joining

The log opens with a block for the room: its code, how to **play** (open the game's site, enter
the code during the lobby; `START_DELAY` keeps the lobby open), and how to **watch as host**: a
one-line `localStorage.setItem(…)` to paste in the browser console on the game's site, then
`/host`. Use another browser or a private window for the host view: one browser holds one
identity. The test drives the clock, so do not press the host buttons.

During the game the host VU logs each phase: the lobby countdown and who joined, the auction's
clearing price, a market line every `MARKET_LOG_EVERY` s (last price, VWAP, volume, best bid/ask,
reserve sold), each year's settlement with the top 3, and the final top 5 with your rank.

The block prints the room's host token. Actions logs of a public repository are public, so anyone
reading them could take over that test room (only that one).

## Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `BASE_URL` | `http://localhost:3001` | backend |
| `HOST_KEY` | `admin123` | instructor key (the workflow uses the `HOST_KEY` secret when set) |
| `YEARS` | 12 | rounds |
| `CAP_WINDOW` | 20 | s, cap stage |
| `ROUND_WINDOW` | 45 | s, market (the agents decide at 2, 4, …, 10, 13, …, 25, 30, …, 50 s: 13 decisions in 45 s, all 15 need 50 s) |
| `REVIEW_GAP` | 10 | s, year summary |
| `TRADE_MIN`, `TRADE_MAX` | 3, 8 | s between a student's market actions |
| `JOIN_SPREAD` | 20 | s over which students arrive |
| `JOIN_TIMEOUT` | 120 | s the host waits for the class before starting anyway |
| `START_DELAY` | 0 (workflow: 180) | s before year 1, at least: time for you to join the lobby |
| `FRONTEND_URL` | none | the game's site, only for the join hint in the log |
| `MARKET_LOG_EVERY` | 15 | s between market lines in the log |
| `EVENTS` | `2:energyCrisis:3,4:rateCut,5:subsidy:3,6:tech,7:nuclear,8:freeCut,9:referendum` | host events by year (`year:kind[:arg]`, or `none`); announced at the start of that year's cap stage, the referendum in its year summary |
| `REFERENDUM_CHAT`, `REFERENDUM_VOTE` | 20, 15 | s of the referendum's chat and vote |
| `BOTS` | `compliance:28,marketMaker:4,speculator:2,noise:6` | 40 bots, every type |
| `AGENTS` | `all` | `all`, `none`, or model ids |
| `ACK_TIMEOUT_MS` | 10000 | an emit with no ack after this counts as failed |

## Pass / fail (thresholds)

| Metric | Threshold |
|---|---|
| `ack_rtt{scenario:students}` (action → ack) | p95 < 500 ms, p99 < 1.5 s |
| `ack_rtt{scenario:host}` | p95 < 1 s |
| `http_req_duration{name:healthz}` | p95 < 1 s, 99% answered 200 |
| `ack_failed` (neither accepted nor an expected refusal; timeouts included, acks lost to a drop not) | < 1% |
| `join_ok` | > 99% |
| `ws_connect_failures` (first connection) | 0 |
| `ws_drops` (connected sockets closed by the server, the proxy or the network) | fewer than students |
| `ws_downtime` (drop → connected again) | p95 < 10 s |
| `game_completed` (every host transition accepted, game ended) | 100% |
| `student_saw_end` (after reconnecting, if it dropped) | > 99% |
| `event_ok` (every scheduled event accepted; the referendum closed with a result) | 100% |

Also reported: `snapshot_size` and `snapshots` (what the server pushes: the main cost at 100
students), `data_received`, `actions_accepted`, `actions_expected_rejects`,
`actions_lost_to_drops`, `ws_reconnect_failures`, `leaderboard_max_points`. Expected refusals
(racing the clock, offering credits already offered, …) are counted, not failed.

Reading a drop, both sides together: k6 `1006` "unexpected EOF" with a recent last message, and
the server's `transport close` with a recent last packet in, is a connection cut in between
(Render's proxy or the network). A long silence before it (k6's last message, or the server's
last packet in, 20 s or more ago; acks pending) with the server's `ping timeout` is a stall: the
server fell behind, or the path stopped carrying data. Many students in the same second point at
the server or the proxy, a few spread over the game at the network.

## How it talks to the server

k6 has WebSockets but no Socket.IO, so `lib/socketio.js` speaks Engine.IO v4 / Socket.IO v4 by
hand over the websocket transport: open → `40{auth}`, ping/pong, `42<id>[event, data]` emits and
their `43<id>[response]` acks, `session:snapshot` pushes. `resilient()` there is the reconnecting
socket. A new server event or a change to the handshake has to be mirrored there.
