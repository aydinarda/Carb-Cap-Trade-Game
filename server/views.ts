import type { GameConfig } from '../shared/config'
import { INDUSTRY_NAMES, type Industry } from '../shared/constants'
import {
  benchmarkFor,
  buildMarketView,
  expectedEmission,
  isPureTrader,
  tradedNet,
  tradedNetAll,
  windowSum,
} from '../shared/engine'
import type {
  ClassAggregate,
  HostConfigView,
  HostSnapshot,
  IndustryBreakdownRow,
  LeaderboardRow,
  PlayerHistoryYear,
  PlayerSnapshot,
  PublicPlayerInfo,
} from '../shared/types'
import type { Session } from './session'

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Sector averages derived from the config actually in force — the midpoint of each
 * generation range. Derived rather than imported so a scenario that widens a sector's
 * range still gets a truthful "% below average" hint.
 */
function sectorAverages(config: GameConfig): Record<Industry, number> {
  return Object.fromEntries(
    INDUSTRY_NAMES.map((i) => {
      const { low, high } = config.emissions.industries[i]
      return [i, (low + high) / 2]
    }),
  ) as Record<Industry, number>
}

/** The slice of the config the host panel renders. See HostConfigView for why it is narrow. */
function hostConfigView(config: GameConfig): HostConfigView {
  return {
    penaltyRate: config.market.penaltyRate,
    auctionCapRatio: config.allocation.auctionCapRatio,
    capReductionFactor: config.allocation.capReductionFactor,
    benchmark: { ...config.allocation.benchmark },
    sectorAverage: sectorAverages(config),
    abatement: { ...config.abatement.sectors },
    abatementLifetimeCap: config.abatement.lifetimeCap,
    abatementFixedCost: config.abatement.fixedCostPerTonneBaseline,
    reserveEnabled: config.allocation.reserve.enabled,
    reserveSteps: config.allocation.reserve.steps.map((s) => ({ ...s })),
  }
}

function publicRoster(session: Session): PublicPlayerInfo[] {
  return session.state.players.map((p) => ({
    id: p.id,
    name: p.name,
    industry: p.industry,
    connected: p.connected,
    isBot: p.isBot,
    botType: p.botType,
  }))
}

function leaderboard(session: Session): LeaderboardRow[] {
  const { baselineYear } = session.state.config.emissions
  const skill = (p: Session['state']['players'][number]) => {
    const baseline = p.emissions[baselineYear] ?? 0
    return baseline > 0 ? round1((p.score - p.optimalScore) / baseline) : round1(p.score - p.optimalScore)
  }
  // Emitters ranked by skill; pure-trader bots ranked by raw P&L and pushed to the end.
  const metric = (p: Session['state']['players'][number]) =>
    isPureTrader(p) ? round1(p.score) : skill(p)
  return [...session.state.players]
    .sort((a, b) => {
      const ta = isPureTrader(a)
      const tb = isPureTrader(b)
      if (ta !== tb) return ta ? 1 : -1
      return metric(a) - metric(b)
    })
    .map((p) => ({
      id: p.id,
      name: p.name,
      industry: p.industry,
      score: p.score,
      normalizedScore: metric(p),
      isBot: p.isBot,
      botType: p.botType,
    }))
}

function classAggregate(session: Session): ClassAggregate {
  const { state } = session
  const record = session.currentYearRecord()
  const players = state.players

  const totalBaseline = round1(
    players.reduce((s, p) => s + (p.emissions[state.config.emissions.baselineYear] ?? 0), 0),
  )

  const sum = (values: Record<string, number>) =>
    round1(Object.values(values).reduce((a, b) => a + b, 0))

  const hasRealized = record !== null && Object.keys(record.realized).length > 0

  const industryBreakdown: IndustryBreakdownRow[] = INDUSTRY_NAMES.map((industry) => {
    const members = players.filter((p) => p.industry === industry)
    return {
      industry,
      players: members.length,
      allocated: round1(
        members.reduce((s, p) => s + (record?.freeAllocation[p.id] ?? 0), 0),
      ),
      realized: hasRealized
        ? round1(members.reduce((s, p) => s + (record!.realized[p.id] ?? 0), 0))
        : null,
    }
  })

  const yearHistory = Object.values(state.years)
    .filter((y) => Object.keys(y.realized).length > 0)
    .sort((a, b) => a.year - b.year)
    .map((y) => ({
      year: y.year,
      totalRealized: sum(y.realized),
      // The cap actually in force that year: everything issued, free or sold. Taken
      // per-year rather than from state.freeCreditLimit, which is computed once and
      // so would draw a flat line under a tightening benchmark or auction supply.
      cap: round1(sum(y.freeAllocation) + y.regulatorPool + y.reserveReleased),
    }))

  const settlement = record?.settlement
  // Only a mechanism with a primary auction has a cap-stage input (sealed bids);
  // the free-allocation modes just issue credits.
  const auctioning = session.usesAuction
  const capDemand =
    record && auctioning
      ? round1(Object.values(record.auctionBid).reduce((a, b) => a + b.qty, 0))
      : null
  const capSubmitted = record && auctioning ? Object.keys(record.auctionBid).length : 0

  return {
    totalBaselineEmissions: totalBaseline,
    totalFreeAllocation: record ? sum(record.freeAllocation) : null,
    totalRegulatorRequests: capDemand,
    submittedCount: capSubmitted,
    // What the class must actually cover this year — capacity that came online this year
    // has already taken its cut. `expectedEmission` would over-state it for everyone who
    // invested last year, which is exactly the number scarcity is judged by.
    totalExpected: record
      ? round1(players.reduce((s, p) => s + session.plannedFor(p, state.currentYear), 0))
      : null,
    totalRealized: hasRealized ? sum(record!.realized) : null,
    totalCostThisYear: settlement
      ? round1(Object.values(settlement).reduce((s, x) => s + x.yearCost, 0))
      : null,
    industryBreakdown,
    yearHistory,
    reservePot: record?.reservePot ?? 0,
    reserveReleased: record?.reserveReleased ?? 0,
  }
}

export function playerSnapshot(session: Session, playerId: string): PlayerSnapshot {
  const { state } = session
  const player = session.getPlayer(playerId)
  if (!player) throw new Error(`Unknown player ${playerId}`)
  const record = session.currentYearRecord()

  // Realized emissions and aggregates only become visible from the reveal phase on
  const revealed =
    state.phase === 'reveal' ||
    state.phase === 'trade' ||
    state.phase === 'yearSummary' ||
    state.phase === 'ended'
  const settled = state.phase === 'yearSummary' || state.phase === 'ended'

  return {
    role: 'player',
    roomCode: state.roomCode,
    capMode: state.capMode,
    phase: state.phase,
    currentYear: state.currentYear,
    playerCount: state.players.length,
    roster: publicRoster(session),
    abatement: state.config.abatement.sectors[player.industry],
    abatementLifetimeCap: session.abatementLifetimeCap,
    auctionSupply: session.usesAuction ? (record?.regulatorPool ?? 0) : 0,
    auctionPrice: record?.auctionPrice ?? null,
    // Benchmarking: what this player's sector benchmark is worth this year, and the
    // sector average it is set below — the two numbers the cap-stage panel explains.
    sectorBenchmark:
      state.capMode === 'benchmarking'
        ? benchmarkFor(player, state.currentYear, state.config)
        : null,
    sectorAverage:
      state.capMode === 'benchmarking' ? sectorAverages(state.config)[player.industry] : null,
    prevMarketPrice: session.previousMarketPrice(),
    market:
      record && (state.phase === 'trade' || settled)
        ? buildMarketView(record.orders, record.trades)
        : null,
    classAggregate: state.phase === 'lobby' ? null : classAggregate(session),
    leaderboard: settled ? leaderboard(session) : null,
    you: {
      id: player.id,
      name: player.name,
      industry: player.industry,
      emissions: player.emissions,
      score: player.score,
      freeAllocation: record?.freeAllocation[player.id] ?? null,
      auctionBid: record?.auctionBid[player.id] ?? null,
      auctionAward:
        record && record.auctionPrice !== null
          ? (record.regulatorGranted[player.id] ?? 0)
          : null,
      myTrades: record
        ? [...record.trades.filter((t) => t.buyerId === player.id || t.sellerId === player.id)].reverse()
        : [],
      abatementInForce: record?.abatement[player.id] ?? null,
      abatementCommitted: player.abatementCommitted,
      unabatedExpected: session.unabatedEmission(player.id),
      abatementFixedCost: session.abatementFixedCost(player.id),
      banked: record ? round1(record.carriedIn[player.id] ?? 0) : null,
      creditsHeld: record && revealed ? session.creditsHeld(player.id) : null,
      plannedEmission: session.plannedEmission(player.id),
      expectedEmission: record ? expectedEmission(player, state.currentYear) : null,
      realized: settled ? (record?.realized[player.id] ?? null) : null,
      netPosition: record?.netPosition[player.id] ?? null,
      settlement: record?.settlement?.[player.id] ?? null,
    },
  }
}

/**
 * Completed years, keyed by session then year. A year strictly before `currentYear` is
 * frozen — nothing in Session writes back into a past YearRecord, and `expectedEmission`
 * only ever looks *backwards*, so a later year's realization cannot change an earlier row.
 *
 * A WeakMap so the memo dies with the session; no sweep hook to keep in sync.
 */
const historyMemo = new WeakMap<Session, Map<number, Record<string, PlayerHistoryYear>>>()

/** Every player's row for one year, in a single pass over that year's tape. */
function historyRowsForYear(
  session: Session,
  y: Session['state']['years'][number],
): Record<string, PlayerHistoryYear> {
  // One pass for the whole class rather than one pass per player: this is what made the
  // host snapshot quadratic in class size.
  const traded = tradedNetAll(y.trades)
  const rows: Record<string, PlayerHistoryYear> = {}
  for (const p of session.state.players) {
    const free = round1(y.freeAllocation[p.id] ?? 0)
    const granted = round1(y.regulatorGranted[p.id] ?? 0)
    const carriedIn = round1(y.carriedIn[p.id] ?? 0)
    const net = traded[p.id] ?? 0
    rows[p.id] = {
      year: y.year,
      expected: round1(expectedEmission(p, y.year)),
      realized: y.realized[p.id] ?? null,
      free,
      regulatorGranted: granted,
      traded: net,
      abatement: round1(y.abatement[p.id] ?? 0),
      banked: carriedIn,
      creditsHeld: round1(free + granted + carriedIn + net),
      netPosition: y.netPosition[p.id] ?? null,
      settlement: y.settlement?.[p.id] ?? null,
    }
  }
  return rows
}

export function buildPlayerHistory(session: Session): Record<string, PlayerHistoryYear[]> {
  const { state } = session
  let memo = historyMemo.get(session)
  if (!memo) {
    memo = new Map()
    historyMemo.set(session, memo)
  }

  // Hoisted: this used to be re-sorted on every call.
  const years = Object.values(state.years).sort((a, b) => a.year - b.year)
  const byYear = years.map((y) => {
    const frozen = y.year < state.currentYear
    const hit = frozen ? memo.get(y.year) : undefined
    // A cached year predating a roster change would be missing that player; recompute
    // rather than silently dropping a row.
    if (hit && state.players.every((p) => hit[p.id] !== undefined)) return hit
    const rows = historyRowsForYear(session, y)
    if (frozen) memo.set(y.year, rows)
    return rows
  })

  const history: Record<string, PlayerHistoryYear[]> = {}
  for (const p of state.players) {
    history[p.id] = byYear.map((rows) => rows[p.id])
  }
  return history
}

export function hostSnapshot(session: Session): HostSnapshot {
  const { state } = session
  const record = session.currentYearRecord()

  return {
    role: 'host',
    roomCode: state.roomCode,
    capMode: state.capMode,
    phase: state.phase,
    currentYear: state.currentYear,
    regulatorPool: record?.regulatorPool ?? null,
    config: hostConfigView(state.config),
    classAggregate: classAggregate(session),
    leaderboard: leaderboard(session),
    auctionPrice: record?.auctionPrice ?? null,
    prevMarketPrice: session.previousMarketPrice(),
    market: record ? buildMarketView(record.orders, record.trades) : null,
    playerHistory: buildPlayerHistory(session),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      industry: p.industry,
      connected: p.connected,
      isBot: p.isBot,
      botType: p.botType,
      score: p.score,
      baselineEmission: p.emissions[state.config.emissions.baselineYear] ?? 0,
      windowSum: round1(windowSum(p, state.currentYear, state.config.emissions.historyWindow)),
      freeAllocation: record?.freeAllocation[p.id] ?? null,
      regulatorGranted:
        record && Object.keys(record.regulatorGranted).length > 0
          ? (record.regulatorGranted[p.id] ?? 0)
          : null,
      traded: record ? tradedNet(record.trades, p.id) : null,
      abatement: record?.abatement[p.id] ?? null,
      banked: record ? round1(record.carriedIn[p.id] ?? 0) : null,
      creditsHeld: record ? session.creditsHeld(p.id) : null,
      expectedEmission: session.plannedFor(p, state.currentYear),
      realized: record?.realized[p.id] ?? null,
      netPosition: record?.netPosition[p.id] ?? null,
      settlement: record?.settlement?.[p.id] ?? null,
    })),
  }
}
