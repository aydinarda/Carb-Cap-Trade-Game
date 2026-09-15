// COPY of rl/observe.ts. The RL training kit lives in the local, git-ignored rl/ folder; keep the two
// identical. Every model file carries the feature list it was trained on, and server/rl/models.ts
// refuses to run a model whose list differs from what this copy builds.

import {
  ANNOUNCEMENT_FACTS,
  ANNOUNCEMENT_KEYS,
  ANNOUNCEMENT_STATES,
  announcements,
  type AnnouncementKey,
} from '../../shared/announcements'
import { INDUSTRY_NAMES, RESERVE_ID, type Industry } from '../../shared/constants'
import { installCost, marginalCost } from '../../shared/engine'
import type { Order, PlayerSnapshot, PublicPlayerInfo } from '../../shared/types'
import { MEMORY_YEARS, type Memory } from './memory'

/**
 * The agent's observation — what a student in this seat can see on screen or remember, as a
 * fixed-length vector. Three rules, each pinned by `__tests__/rl.check.ts`:
 *
 *  1. Built from the `PlayerSnapshot` and the agent's own `Memory`, never from the session.
 *     This file imports nothing from `server/`.
 *  2. Never shows more than the screen does: eight book levels a side because `OrderBook`
 *     renders eight, no counterparty ids because the book is anonymised, and no event number
 *     the announcement text does not state.
 *  3. Says nothing about how long the game or the round will last. Elapsed years, yes;
 *     anything remaining, no.
 *
 * Normalisers: P = penalty rate, B = the company's baseline emission, C = the class's.
 */

export type RlMode = 'benchmarking' | 'auctioning' | 'hybrid'
/** Every mode the agent can be trained in — each one its own model. */
export const RL_MODES: RlMode[] = ['benchmarking', 'auctioning', 'hybrid']
export type StepKind = 'bid' | 'trade' | 'abate'

export interface Feature {
  name: string
  group: string
  /** Where on the snapshot (or in memory) the number comes from — for the table view. */
  source: string
  /** Omitted when the feature exists in every mode. */
  modes?: RlMode[]
}

export interface Cell {
  value: number
  /** The un-normalised number, or null when the screen shows nothing there. */
  raw: number | null
}

export interface ObservationRow {
  feature: Feature
  raw: number | null
  value: number
}

export interface Observation {
  vector: number[]
  rows: ObservationRow[]
}

/** The trade screen's `OrderBook` renders this many levels a side (its `rows` default). */
export const BOOK_ROWS = 8
export const TAPE_ROWS = 10
const HISTORY_YEARS = 5
/**
 * No feature may leave ±VALUE_LIMIT. The trainer's running normaliser squares every observation,
 * and a float32 square overflows past ~1.8e19: at 991K training steps one 23-round game scored
 * 3.3e33 points, which as points/100 poisoned the normaliser for good and stopped the run. Every
 * feature is designed to sit in single digits, so this only ever catches a scaling mistake.
 */
const VALUE_LIMIT = 1e6

// Hybrid is both regimes at once — a free benchmark allocation AND an auction for the rest of the
// cap — so every feature that belongs to either one belongs to it too.
const AUCTION: RlMode[] = ['auctioning', 'hybrid']
const BENCH: RlMode[] = ['benchmarking', 'hybrid']

const SLUG: Record<Industry, string> = {
  'Power & Utilities': 'power',
  'Heavy Materials': 'heavy',
  'Manufacturing & Chemicals': 'manufacturing',
  Transport: 'transport',
}

const BOT_COUNTS = [
  ['n_bot_compliance', 'compliance'],
  ['n_bot_mm', 'marketMaker'],
  ['n_bot_spec', 'speculator'],
  ['n_bot_noise', 'noise'],
] as const

/** `_round` facts are absolute round numbers in the message; the feature is rounds from now. */
export function eventFeatureName(key: AnnouncementKey, fact: string): string {
  return `ev_${key}_${fact.endsWith('_round') ? `${fact}_in` : fact}`
}

function buildFeatures(): Feature[] {
  const out: Feature[] = []
  const add = (group: string, name: string, source: string, modes?: RlMode[]) =>
    out.push({ group, name, source, modes })

  add('step', 'step_bid', 'env: sealed-bid decision', AUCTION)
  add('step', 'step_trade', 'env: buy/sell decision')
  add('step', 'step_abate', 'env: once-a-year abatement decision')

  for (const i of INDUSTRY_NAMES) add('context', `industry_${SLUG[i]}`, 'you.industry')
  add('context', 'years_elapsed', 'currentYear − first round seen')

  add('users', 'n_companies', 'playerCount')
  add('users', 'n_humans', 'roster[].isBot')
  for (const [name] of BOT_COUNTS) add('users', name, 'roster[].botType')
  add('users', 'connected_share', 'roster[].connected')
  for (const i of INDUSTRY_NAMES) {
    add('users', `sector_players_${SLUG[i]}`, 'classAggregate.industryBreakdown[].players')
  }
  add('users', 'auction_submitted_share', 'classAggregate.submittedCount', AUCTION)

  add('position', 'planned', 'you.plannedEmission')
  add('position', 'expected_prev', 'you.expectedEmission')
  add('position', 'unabated', 'you.unabatedExpected')
  add('position', 'banked', 'you.banked')
  add('position', 'credits_held', 'you.creditsHeld')
  add('position', 'has_held', 'you.creditsHeld shown')
  add('position', 'free_alloc', 'you.freeAllocation', BENCH)
  add('position', 'gap', 'planned − (held ?? free + banked + award)')
  add('position', 'bid_qty', 'you.auctionBid.qty', AUCTION)
  add('position', 'bid_price', 'you.auctionBid.price', AUCTION)
  add('position', 'auction_award', 'you.auctionAward', AUCTION)
  for (let k = 1; k <= HISTORY_YEARS; k++) {
    add('position', `emis_hist_${k}`, `you.emissions, ${k} year${k === 1 ? '' : 's'} back`)
  }
  add('position', 'score', 'you.score (cumulative cost)')

  add('abatement', 'in_force', 'you.abatementInForce')
  add('abatement', 'committed', 'you.abatementCommitted')
  add('abatement', 'round_ceiling', 'abatementRoundCeiling')
  add('abatement', 'lifetime_cap', 'abatementLifetimeCap')
  add('abatement', 'mac_committed', 'marginalCost(committed, abatement)')
  add('abatement', 'mac_ceiling', 'marginalCost(round_ceiling, abatement)')
  add('abatement', 'step_cost_to_ceiling', 'installCost(…) × abatementCostFactor')
  add('abatement', 'fixed_cost', 'you.abatementFixedCost')
  add('abatement', 'cost_factor', 'abatementCostFactor')

  add('price', 'penalty', 'penaltyRate')
  add('price', 'prev_price', 'prevMarketPrice')
  add('price', 'has_prev_price', 'prevMarketPrice shown')
  add('price', 'price_change_vs_prev', '(market price − prevMarketPrice) / prevMarketPrice')
  add('price', 'auction_price', 'auctionPrice', AUCTION)
  add('price', 'has_auction_price', 'auctionPrice shown', AUCTION)
  add('price', 'auction_supply', 'auctionSupply', AUCTION)
  add('price', 'sector_benchmark', 'sectorBenchmark', BENCH)
  add('price', 'sector_average', 'sectorAverage', BENCH)
  add('price', 'last_price', 'market.lastPrice')
  add('price', 'has_last_price', 'market.lastPrice shown')
  add('price', 'vwap', 'market.vwap')
  add('price', 'has_vwap', 'market.vwap shown')
  add('price', 'volume', 'market.volume')

  for (const side of ['bid', 'ask'] as const) {
    for (let k = 1; k <= BOOK_ROWS; k++) {
      const src = `market.${side}s[${k - 1}]`
      add('book', `${side}_px_${k}`, `${src}.price`)
      add('book', `${side}_qty_${k}`, `${src}.remaining`)
      add('book', `${side}_you_${k}`, `${src} is YOU`)
      add('book', `${side}_reg_${k}`, `${src} is REGULATOR`)
    }
  }
  add('book', 'spread', 'bestAsk − bestBid')
  add('book', 'mid', '(bestAsk + bestBid) / 2')
  add('book', 'two_sided', 'both sides quoted')
  add('book', 'more_levels', 'levels beyond the 8 shown')
  add('book', 'my_open_buy', 'Σ own resting bids')
  add('book', 'my_open_sell', 'Σ own resting asks')
  add('book', 'my_bid_rank', 'row of own best bid among the 8 shown')
  add('book', 'my_ask_rank', 'row of own best ask among the 8 shown')

  for (let k = 1; k <= TAPE_ROWS; k++) {
    const src = `market.trades[${k - 1}]`
    add('tape', `tape_px_${k}`, `${src}.price`)
    add('tape', `tape_qty_${k}`, `${src}.qty`)
    add('tape', `tape_you_${k}`, `${src}: +1 you bought, −1 you sold`)
  }
  add('tape', 'my_bought', 'you.myTrades bought')
  add('tape', 'my_sold', 'you.myTrades sold')
  add('tape', 'my_avg_buy', 'you.myTrades average buy price')
  add('tape', 'my_avg_sell', 'you.myTrades average sell price')

  add('class', 'class_requests', 'classAggregate.totalRegulatorRequests', AUCTION)
  add('class', 'class_expected', 'classAggregate.totalExpected')
  add('class', 'reserve_pot', 'classAggregate.reservePot')
  add('class', 'reserve_released', 'classAggregate.reserveReleased')
  add('class', 'class_free', 'classAggregate.totalFreeAllocation', BENCH)
  for (const i of INDUSTRY_NAMES) {
    add('class', `sector_alloc_${SLUG[i]}`, 'classAggregate.industryBreakdown[].allocated', BENCH)
  }
  add('class', 'class_last_realized_vs_cap', 'yearHistory, last year: realized / cap')
  add('class', 'cap_trend', 'yearHistory: last cap / first cap')

  for (const key of ANNOUNCEMENT_KEYS) {
    for (const state of ANNOUNCEMENT_STATES) {
      add('events', `ev_${key}_${state}`, `announcements(): ${key} is ${state}`)
    }
  }
  for (const key of ANNOUNCEMENT_KEYS) {
    for (const fact of ANNOUNCEMENT_FACTS[key]) {
      add('events', eventFeatureName(key, fact), `announcements(): ${key} facts.${fact}`)
    }
  }

  for (let k = 1; k <= MEMORY_YEARS; k++) {
    add('memory', `vwap_y${k}`, `year-summary market.vwap, ${k} year${k === 1 ? '' : 's'} ago`)
    add('memory', `has_vwap_y${k}`, `vwap_y${k} remembered`)
  }
  for (let k = 2; k <= MEMORY_YEARS; k++) add('memory', `vwap_y1_over_y${k}`, `vwap_y1 / vwap_y${k}`)
  add('memory', 'last_price_over_vwap_y1', 'market.lastPrice / vwap_y1')
  add('memory', 'auction_price_y1', 'year-summary auctionPrice, last year', AUCTION)
  add('memory', 'last_shortage', 'year-summary you.settlement.shortage')
  add('memory', 'last_realized', 'year-summary you.realized')
  add('memory', 'last_net_position', 'year-summary you.netPosition')
  add('memory', 'last_abate_cost', 'year-summary you.settlement.abatementCost')
  add('memory', 'last_purchase_cost', 'year-summary you.settlement.purchaseCost')
  add('memory', 'last_sell_income', 'year-summary you.settlement.sellIncome')
  add('memory', 'last_penalty_cost', 'year-summary you.settlement.penaltyCost')
  add('memory', 'last_year_cost', 'year-summary you.settlement.yearCost')
  add('memory', 'last_points', 'year-summary leaderboard: own points, log scale')
  add('memory', 'last_rank', 'year-summary leaderboard: own rank, 1 = first')
  add('memory', 'last_trading_gap', 'year-summary leaderboard: own tradingGap')
  add('memory', 'last_investment_gap', 'year-summary leaderboard: own investmentGap')
  add('memory', 'class_median_points', 'year-summary leaderboard: median points, log scale')
  add('memory', 'last_class_realized', 'year-summary classAggregate.totalRealized')
  add('memory', 'year_open_price', 'first market price seen this round')
  add('memory', 'price_change_last_decision', 'market.lastPrice − price at the previous decision')
  add('memory', 'ev_rates_seen_rounds', 'rounds the rate-cut headline has been on screen')

  return out
}

export const FEATURES: Feature[] = buildFeatures()

const BY_MODE: Record<RlMode, Feature[]> = {
  benchmarking: FEATURES.filter((f) => !f.modes || f.modes.includes('benchmarking')),
  auctioning: FEATURES.filter((f) => !f.modes || f.modes.includes('auctioning')),
  hybrid: FEATURES.filter((f) => !f.modes || f.modes.includes('hybrid')),
}

/** The features one mode's model sees, in vector order. */
export function featuresFor(mode: RlMode): Feature[] {
  return BY_MODE[mode]
}

/** Credits in hand as the screen presents them — before the reveal, the parts that are shown. */
export function heldCredits(snap: PlayerSnapshot): number {
  const you = snap.you
  return you.creditsHeld ?? (you.freeAllocation ?? 0) + (you.banked ?? 0) + (you.auctionAward ?? 0)
}

const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
const div = (x: number | null | undefined, d: number): number =>
  x === null || x === undefined || !(d > 0) ? 0 : x / d

/**
 * Points on a log scale, where 100 points reads as 1.
 *
 * Points are `100·exp(−gap/150)`: exponential and unbounded above, so a long game with a very
 * negative trading gap scores astronomically (3.3e33 was observed). log1p keeps the ordering and
 * the resolution around ordinary scores — 0 → 0, 100 → 1, 1,000 → 1.5, 3.3e33 → 16.7.
 */
const pointsFeature = (points: number | null | undefined): number =>
  points === null || points === undefined || !Number.isFinite(points)
    ? 0
    : Math.log1p(Math.max(0, points)) / Math.log1p(100)

/** Every feature for this snapshot, keyed by name. `observe` picks one mode's subset in order. */
export function computeFeatures(snap: PlayerSnapshot, mem: Memory, step: StepKind): Map<string, Cell> {
  const cells = new Map<string, Cell>()
  const put = (name: string, value: number, raw: number | null | undefined) => {
    cells.set(name, {
      value: Number.isFinite(value) ? Math.max(-VALUE_LIMIT, Math.min(VALUE_LIMIT, value)) : 0,
      raw: raw === null || raw === undefined || !Number.isFinite(raw) ? null : raw,
    })
  }
  const bit = (name: string, on: boolean) => put(name, on ? 1 : 0, on ? 1 : 0)

  const you = snap.you
  const year = snap.currentYear
  const market = snap.market
  const agg = snap.classAggregate
  const P = snap.penaltyRate > 0 ? snap.penaltyRate : 100
  const B = mem.baseline !== null && mem.baseline > 0 ? mem.baseline : Math.max(1, you.plannedEmission)
  const C = agg && agg.totalBaselineEmissions > 0 ? agg.totalBaselineEmissions : B * Math.max(1, snap.playerCount)
  const n = Math.max(1, snap.playerCount)

  // --- step --------------------------------------------------------------------------
  bit('step_bid', step === 'bid')
  bit('step_trade', step === 'trade')
  bit('step_abate', step === 'abate')

  // --- context -----------------------------------------------------------------------
  for (const i of INDUSTRY_NAMES) bit(`industry_${SLUG[i]}`, you.industry === i)
  const elapsed = mem.firstYear === null ? 0 : year - mem.firstYear
  put('years_elapsed', elapsed / 20, elapsed)

  // --- users -------------------------------------------------------------------------
  const count = (pred: (p: PublicPlayerInfo) => boolean) => snap.roster.filter(pred).length
  put('n_companies', snap.playerCount / 100, snap.playerCount)
  const humans = count((p) => !p.isBot)
  put('n_humans', humans / 100, humans)
  for (const [name, type] of BOT_COUNTS) {
    const c = count((p) => p.botType === type)
    put(name, c / 100, c)
  }
  const connected = count((p) => p.connected)
  put('connected_share', div(connected, snap.roster.length), connected)
  for (const i of INDUSTRY_NAMES) {
    const players = agg?.industryBreakdown.find((r) => r.industry === i)?.players ?? null
    put(`sector_players_${SLUG[i]}`, div(players, n), players)
  }
  put('auction_submitted_share', div(agg?.submittedCount, n), agg?.submittedCount)

  // --- position ----------------------------------------------------------------------
  const held = heldCredits(snap)
  const gap = you.plannedEmission - held
  put('planned', you.plannedEmission / B, you.plannedEmission)
  put('expected_prev', div(you.expectedEmission, B), you.expectedEmission)
  put('unabated', you.unabatedExpected / B, you.unabatedExpected)
  put('banked', div(you.banked, B), you.banked)
  put('credits_held', div(you.creditsHeld, B), you.creditsHeld)
  bit('has_held', you.creditsHeld !== null)
  put('free_alloc', div(you.freeAllocation, B), you.freeAllocation)
  put('gap', gap / B, gap)
  put('bid_qty', div(you.auctionBid?.qty, B), you.auctionBid?.qty)
  put('bid_price', div(you.auctionBid?.price, P), you.auctionBid?.price)
  put('auction_award', div(you.auctionAward, B), you.auctionAward)
  const history = Object.keys(you.emissions)
    .map(Number)
    .filter((y) => y < year)
    .sort((a, b) => b - a)
  for (let k = 1; k <= HISTORY_YEARS; k++) {
    const y = history[k - 1]
    const v = y === undefined ? null : you.emissions[y]
    put(`emis_hist_${k}`, div(v, B), v)
  }
  put('score', you.score / (B * P), you.score)

  // --- abatement ---------------------------------------------------------------------
  const committed = you.abatementCommitted
  const ceiling = snap.abatementRoundCeiling
  put('in_force', you.abatementInForce ?? 0, you.abatementInForce)
  put('committed', committed, committed)
  put('round_ceiling', ceiling, ceiling)
  put('lifetime_cap', snap.abatementLifetimeCap, snap.abatementLifetimeCap)
  const macCommitted = marginalCost(committed, snap.abatement)
  put('mac_committed', macCommitted / P, macCommitted)
  const macCeiling = marginalCost(ceiling, snap.abatement)
  put('mac_ceiling', macCeiling / P, macCeiling)
  // The slider's own preview for going all the way to this round's ceiling — the same
  // shared function and the same composed discount the trade screen multiplies by.
  const stepCost =
    installCost(you.unabatedExpected, committed, ceiling, snap.abatement, you.abatementFixedCost) *
    snap.abatementCostFactor
  put('step_cost_to_ceiling', stepCost / (B * P), stepCost)
  put('fixed_cost', you.abatementFixedCost / (B * P), you.abatementFixedCost)
  put('cost_factor', snap.abatementCostFactor, snap.abatementCostFactor)

  // --- price -------------------------------------------------------------------------
  put('penalty', P / 100, snap.penaltyRate)
  put('prev_price', div(snap.prevMarketPrice, P), snap.prevMarketPrice)
  bit('has_prev_price', snap.prevMarketPrice !== null)
  const marketPrice = market?.lastPrice ?? market?.vwap ?? null
  const change =
    marketPrice !== null && snap.prevMarketPrice !== null && snap.prevMarketPrice > 0
      ? clip((marketPrice - snap.prevMarketPrice) / snap.prevMarketPrice, -5, 5)
      : null
  put('price_change_vs_prev', change ?? 0, change)
  put('auction_price', div(snap.auctionPrice, P), snap.auctionPrice)
  bit('has_auction_price', snap.auctionPrice !== null)
  put('auction_supply', div(snap.auctionSupply, C), snap.auctionSupply)
  put('sector_benchmark', div(snap.sectorBenchmark, B), snap.sectorBenchmark)
  put('sector_average', div(snap.sectorAverage, B), snap.sectorAverage)
  put('last_price', div(market?.lastPrice, P), market?.lastPrice)
  bit('has_last_price', market?.lastPrice != null)
  put('vwap', div(market?.vwap, P), market?.vwap)
  bit('has_vwap', market?.vwap != null)
  put('volume', div(market?.volume, C), market?.volume)

  // --- book: the eight rows a side the screen shows, anonymised as it anonymises them ---
  const bids: Order[] = market?.bids ?? []
  const asks: Order[] = market?.asks ?? []
  for (const [side, orders] of [
    ['bid', bids],
    ['ask', asks],
  ] as const) {
    for (let k = 1; k <= BOOK_ROWS; k++) {
      const o: Order | undefined = orders[k - 1]
      put(`${side}_px_${k}`, div(o?.price, P), o?.price)
      put(`${side}_qty_${k}`, div(o?.remaining, C), o?.remaining)
      bit(`${side}_you_${k}`, o !== undefined && o.playerId === you.id)
      bit(`${side}_reg_${k}`, o !== undefined && o.playerId === RESERVE_ID)
    }
  }
  const bestBid = market?.bestBid ?? null
  const bestAsk = market?.bestAsk ?? null
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null
  const mid = bestBid !== null && bestAsk !== null ? (bestAsk + bestBid) / 2 : null
  put('spread', div(spread, P), spread)
  put('mid', div(mid, P), mid)
  bit('two_sided', spread !== null)
  const more = Math.max(0, Math.max(bids.length, asks.length) - BOOK_ROWS)
  put('more_levels', more / 25, more)
  // Own orders across the whole book, as the ticket's "offerable" figure counts them.
  const own = (orders: Order[]) => orders.filter((o) => o.playerId === you.id)
  const openBuy = own(bids).reduce((s, o) => s + o.remaining, 0)
  const openSell = own(asks).reduce((s, o) => s + o.remaining, 0)
  put('my_open_buy', openBuy / B, openBuy)
  put('my_open_sell', openSell / B, openSell)
  const rowOf = (orders: Order[]) => orders.slice(0, BOOK_ROWS).findIndex((o) => o.playerId === you.id) + 1
  const bidRow = rowOf(bids)
  const askRow = rowOf(asks)
  put('my_bid_rank', bidRow / BOOK_ROWS, bidRow || null)
  put('my_ask_rank', askRow / BOOK_ROWS, askRow || null)

  // --- tape --------------------------------------------------------------------------
  const tape = market?.trades ?? []
  for (let k = 1; k <= TAPE_ROWS; k++) {
    const t = tape[k - 1]
    put(`tape_px_${k}`, div(t?.price, P), t?.price)
    put(`tape_qty_${k}`, div(t?.qty, C), t?.qty)
    const mine = !t ? 0 : t.buyerId === you.id ? 1 : t.sellerId === you.id ? -1 : 0
    put(`tape_you_${k}`, mine, mine)
  }
  let bought = 0
  let sold = 0
  let buyCash = 0
  let sellCash = 0
  for (const t of you.myTrades) {
    if (t.buyerId === you.id) {
      bought += t.qty
      buyCash += t.qty * t.price
    }
    if (t.sellerId === you.id) {
      sold += t.qty
      sellCash += t.qty * t.price
    }
  }
  put('my_bought', bought / B, bought)
  put('my_sold', sold / B, sold)
  const avgBuy = bought > 0 ? buyCash / bought : null
  const avgSell = sold > 0 ? sellCash / sold : null
  put('my_avg_buy', div(avgBuy, P), avgBuy)
  put('my_avg_sell', div(avgSell, P), avgSell)

  // --- class -------------------------------------------------------------------------
  put('class_requests', div(agg?.totalRegulatorRequests, C), agg?.totalRegulatorRequests)
  put('class_expected', div(agg?.totalExpected, C), agg?.totalExpected)
  put('reserve_pot', div(agg?.reservePot, C), agg?.reservePot)
  put('reserve_released', div(agg?.reserveReleased, C), agg?.reserveReleased)
  put('class_free', div(agg?.totalFreeAllocation, C), agg?.totalFreeAllocation)
  for (const i of INDUSTRY_NAMES) {
    const allocated = agg?.industryBreakdown.find((r) => r.industry === i)?.allocated ?? null
    put(`sector_alloc_${SLUG[i]}`, div(allocated, C), allocated)
  }
  const yearHistory = agg?.yearHistory ?? []
  const lastYear = yearHistory.length ? yearHistory[yearHistory.length - 1] : null
  const realizedVsCap = lastYear && lastYear.cap > 0 ? lastYear.totalRealized / lastYear.cap : null
  put('class_last_realized_vs_cap', realizedVsCap ?? 0, realizedVsCap)
  const capTrend =
    lastYear && yearHistory.length >= 2 && yearHistory[0].cap > 0 ? lastYear.cap / yearHistory[0].cap : null
  put('cap_trend', capTrend ?? 1, capTrend)

  // --- events: exactly what the announcement text states --------------------------------
  const items = announcements(snap)
  for (const key of ANNOUNCEMENT_KEYS) {
    const item = items.find((a) => a.key === key)
    for (const state of ANNOUNCEMENT_STATES) bit(`ev_${key}_${state}`, item?.state === state)
    for (const fact of ANNOUNCEMENT_FACTS[key]) {
      const name = eventFeatureName(key, fact)
      const v: number | undefined = item?.facts[fact]
      if (v === undefined) put(name, 0, null)
      else if (fact.endsWith('_pct')) put(name, v / 100, v)
      else if (fact.endsWith('_round')) put(name, (v - year) / 20, v)
      else put(name, v / 20, v)
    }
  }

  // --- memory ------------------------------------------------------------------------
  const ys = mem.years
  for (let k = 1; k <= MEMORY_YEARS; k++) {
    const v = ys[k - 1]?.vwap ?? null
    put(`vwap_y${k}`, div(v, P), v)
    bit(`has_vwap_y${k}`, v !== null)
  }
  const ratio = (a: number | null, b: number | null) =>
    a !== null && b !== null && b > 0 ? clip(a / b, 0, 5) : null
  const vwap1 = ys[0]?.vwap ?? null
  for (let k = 2; k <= MEMORY_YEARS; k++) {
    const r = ratio(vwap1, ys[k - 1]?.vwap ?? null)
    put(`vwap_y1_over_y${k}`, r ?? 1, r)
  }
  const lastOverVwap = ratio(market?.lastPrice ?? null, vwap1)
  put('last_price_over_vwap_y1', lastOverVwap ?? 1, lastOverVwap)
  const last = ys[0]
  put('auction_price_y1', div(last?.auctionPrice, P), last?.auctionPrice)
  const st = last?.settlement ?? null
  put('last_shortage', div(st?.shortage, B), st?.shortage)
  put('last_realized', div(last?.realized, B), last?.realized)
  put('last_net_position', div(last?.netPosition, B), last?.netPosition)
  put('last_abate_cost', div(st?.abatementCost, B * P), st?.abatementCost)
  put('last_purchase_cost', div(st?.purchaseCost, B * P), st?.purchaseCost)
  put('last_sell_income', div(st?.sellIncome, B * P), st?.sellIncome)
  put('last_penalty_cost', div(st?.penaltyCost, B * P), st?.penaltyCost)
  put('last_year_cost', div(st?.yearCost, B * P), st?.yearCost)
  put('last_points', pointsFeature(last?.points), last?.points)
  const lastRank =
    last && last.rank !== null && last.n !== null
      ? last.n > 1
        ? 1 - (last.rank - 1) / (last.n - 1)
        : 1
      : null
  put('last_rank', lastRank ?? 0, last?.rank)
  put('last_trading_gap', div(last?.tradingGap, P), last?.tradingGap)
  put('last_investment_gap', div(last?.investmentGap, P), last?.investmentGap)
  put('class_median_points', pointsFeature(last?.classMedianPoints), last?.classMedianPoints)
  put('last_class_realized', div(last?.classRealized, C), last?.classRealized)
  put('year_open_price', div(mem.yearOpenPrice, P), mem.yearOpenPrice)
  const lastPrice = market?.lastPrice ?? null
  const priceMove = lastPrice !== null && mem.prevDecisionPrice !== null ? lastPrice - mem.prevDecisionPrice : null
  put('price_change_last_decision', div(priceMove, P), priceMove)
  put('ev_rates_seen_rounds', mem.ratesSeenRounds / 20, mem.ratesSeenRounds)

  return cells
}

/** One mode's observation vector, in `featuresFor(mode)` order, with the raw values alongside. */
export function observe(snap: PlayerSnapshot, mem: Memory, mode: RlMode, step: StepKind): Observation {
  const cells = computeFeatures(snap, mem, step)
  const rows = featuresFor(mode).map((feature) => {
    const cell = cells.get(feature.name)
    if (!cell) throw new Error(`rl/observe: feature "${feature.name}" is listed but never computed`)
    return { feature, raw: cell.raw, value: cell.value }
  })
  return { vector: rows.map((r) => r.value), rows }
}
