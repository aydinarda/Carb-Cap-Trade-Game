import { INDUSTRY_NAMES } from '../shared/constants'
import { buildMarketView, expectedEmission, tradedNet, windowSum } from '../shared/engine'
import type {
  ClassAggregate,
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

/** Pure-trader bots have ~0 emissions, so the skill-vs-optimum metric is meaningless. */
function isPureTrader(p: Session['state']['players'][number]): boolean {
  return !!p.isBot && (p.botType === 'marketMaker' || p.botType === 'speculator')
}

function leaderboard(session: Session): LeaderboardRow[] {
  const { baselineYear } = session.state.config
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
    players.reduce((s, p) => s + (p.emissions[state.config.baselineYear] ?? 0), 0),
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
      cap: round1(state.freeCreditLimit ?? 0),
    }))

  const settlement = record?.settlement
  const auctioning = state.capMode === 'auctioning'
  // Only auctioning has a cap-stage input (sealed bids); G/B just get free credits.
  const capDemand =
    record && auctioning
      ? round1(Object.values(record.auctionBid).reduce((a, b) => a + b.qty, 0))
      : null
  const capSubmitted = record && auctioning ? Object.keys(record.auctionBid).length : 0

  return {
    totalBaselineEmissions: totalBaseline,
    freeCreditLimit: state.freeCreditLimit !== null ? round1(state.freeCreditLimit) : null,
    totalFreeAllocation: record ? sum(record.freeAllocation) : null,
    totalRegulatorRequests: capDemand,
    totalRegulatorGranted: record ? sum(record.regulatorGranted) : null,
    submittedCount: capSubmitted,
    totalExpected: record
      ? round1(players.reduce((s, p) => s + expectedEmission(p, state.currentYear), 0))
      : null,
    totalRealized: hasRealized ? sum(record!.realized) : null,
    totalNetPosition:
      record && Object.keys(record.netPosition).length > 0 ? sum(record.netPosition) : null,
    totalCostThisYear: settlement
      ? round1(Object.values(settlement).reduce((s, x) => s + x.yearCost, 0))
      : null,
    industryBreakdown,
    yearHistory,
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
    freeCreditLimit: state.freeCreditLimit !== null ? round1(state.freeCreditLimit) : null,
    abatementCoeff: state.config.abatement[player.industry],
    auctionSupply: state.capMode === 'auctioning' ? (record?.regulatorPool ?? 0) : 0,
    auctionPrice: record?.auctionPrice ?? null,
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
      regulatorGranted:
        record && Object.keys(record.regulatorGranted).length > 0
          ? (record.regulatorGranted[player.id] ?? 0)
          : null,
      auctionBid: record?.auctionBid[player.id] ?? null,
      auctionAward:
        record && record.auctionPrice !== null
          ? (record.regulatorGranted[player.id] ?? 0)
          : null,
      myOrders: record
        ? [...record.orders.filter((o) => o.playerId === player.id)].reverse()
        : [],
      myTrades: record
        ? [...record.trades.filter((t) => t.buyerId === player.id || t.sellerId === player.id)].reverse()
        : [],
      abatement: record?.abatement[player.id] ?? null,
      banked: record ? round1(record.carriedIn[player.id] ?? 0) : null,
      creditsHeld: record && revealed ? session.creditsHeld(player.id) : null,
      expectedEmission: record ? expectedEmission(player, state.currentYear) : null,
      realized: settled ? (record?.realized[player.id] ?? null) : null,
      netPosition: record?.netPosition[player.id] ?? null,
      settlement: record?.settlement?.[player.id] ?? null,
    },
  }
}

function buildPlayerHistory(session: Session): Record<string, PlayerHistoryYear[]> {
  const { state } = session
  const years = Object.values(state.years).sort((a, b) => a.year - b.year)
  const history: Record<string, PlayerHistoryYear[]> = {}
  for (const p of state.players) {
    history[p.id] = years.map((y) => {
      const free = round1(y.freeAllocation[p.id] ?? 0)
      const granted = round1(y.regulatorGranted[p.id] ?? 0)
      const carriedIn = round1(y.carriedIn[p.id] ?? 0)
      const traded = tradedNet(y.trades, p.id)
      return {
        year: y.year,
        expected: round1(expectedEmission(p, y.year)),
        realized: y.realized[p.id] ?? null,
        free,
        regulatorGranted: granted,
        traded,
        abatement: round1(y.abatement[p.id] ?? 0),
        banked: carriedIn,
        creditsHeld: round1(free + granted + carriedIn + traded),
        netPosition: y.netPosition[p.id] ?? null,
        settlement: y.settlement?.[p.id] ?? null,
      }
    })
  }
  return history
}

export function hostSnapshot(session: Session): HostSnapshot {
  const { state } = session
  const record = session.currentYearRecord()

  return {
    role: 'host',
    roomCode: state.roomCode,
    seed: state.seed,
    capMode: state.capMode,
    phase: state.phase,
    currentYear: state.currentYear,
    freeCreditLimit: state.freeCreditLimit !== null ? round1(state.freeCreditLimit) : null,
    regulatorPool: record?.regulatorPool ?? null,
    config: state.config,
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
      baselineEmission: p.emissions[state.config.baselineYear] ?? 0,
      windowSum: round1(windowSum(p, state.currentYear, state.config.historyWindow)),
      freeAllocation: record?.freeAllocation[p.id] ?? null,
      regulatorGranted:
        record && Object.keys(record.regulatorGranted).length > 0
          ? (record.regulatorGranted[p.id] ?? 0)
          : null,
      traded: record ? tradedNet(record.trades, p.id) : null,
      abatement: record?.abatement[p.id] ?? null,
      banked: record ? round1(record.carriedIn[p.id] ?? 0) : null,
      creditsHeld: record ? session.creditsHeld(p.id) : null,
      expectedEmission: round1(expectedEmission(p, state.currentYear)),
      realized: record?.realized[p.id] ?? null,
      netPosition: record?.netPosition[p.id] ?? null,
      settlement: record?.settlement?.[p.id] ?? null,
    })),
  }
}
