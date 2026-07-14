import { INDUSTRY_NAMES } from '../shared/constants'
import { buildMarketView, windowSum } from '../shared/engine'
import type {
  ClassAggregate,
  HostSnapshot,
  IndustryBreakdownRow,
  LeaderboardRow,
  MarketView,
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
  }))
}

function leaderboard(session: Session): LeaderboardRow[] {
  return [...session.state.players]
    .sort((a, b) => a.penaltyPoints - b.penaltyPoints)
    .map((p) => ({
      id: p.id,
      name: p.name,
      industry: p.industry,
      penaltyPoints: p.penaltyPoints,
    }))
}

function marketView(session: Session): MarketView | null {
  const record = session.currentYearRecord()
  if (!record) return null
  return buildMarketView(record.orders, record.trades)
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

  return {
    totalBaselineEmissions: totalBaseline,
    freeCreditLimit: state.freeCreditLimit !== null ? round1(state.freeCreditLimit) : null,
    totalFreeAllocation: record ? sum(record.freeAllocation) : null,
    totalRegulatorRequests: record ? sum(record.regulatorRequest) : null,
    totalRegulatorGranted: record ? sum(record.regulatorGranted) : null,
    submittedCount: record ? Object.keys(record.regulatorRequest).length : 0,
    totalRealized: hasRealized ? sum(record!.realized) : null,
    totalNetPosition:
      record && Object.keys(record.netPosition).length > 0 ? sum(record.netPosition) : null,
    totalPenaltyThisYear: settlement
      ? round1(Object.values(settlement).reduce((s, x) => s + x.penalty, 0))
      : null,
    leftoverDistributed: settlement ? record!.leftoverDistributed : null,
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
    regulatorPool: record?.regulatorPool ?? null,
    regulatorRequestTotal: record
      ? round1(Object.values(record.regulatorRequest).reduce((a, b) => a + b, 0))
      : null,
    regulatorPrice: state.config.regulatorPrice,
    classAggregate: state.phase === 'lobby' ? null : classAggregate(session),
    market: state.phase === 'trade' || settled ? marketView(session) : null,
    leaderboard: settled ? leaderboard(session) : null,
    you: {
      id: player.id,
      name: player.name,
      industry: player.industry,
      emissions: player.emissions,
      penaltyPoints: player.penaltyPoints,
      freeAllocation: record?.freeAllocation[player.id] ?? null,
      regulatorRequest: record?.regulatorRequest[player.id] ?? null,
      regulatorGranted:
        record && Object.keys(record.regulatorGranted).length > 0
          ? (record.regulatorGranted[player.id] ?? 0)
          : null,
      creditsHeld: record && revealed ? session.creditsHeld(player.id) : null,
      realized: revealed ? (record?.realized[player.id] ?? null) : null,
      netPosition: record?.netPosition[player.id] ?? null,
      settlement: record?.settlement?.[player.id] ?? null,
      myOrders: record
        ? [...record.orders.filter((o) => o.playerId === player.id)].reverse()
        : [],
      myTrades: record
        ? [...record.trades.filter(
            (t) => t.buyerId === player.id || t.sellerId === player.id,
          )].reverse()
        : [],
    },
  }
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
    market: marketView(session),
    leaderboard: leaderboard(session),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      industry: p.industry,
      connected: p.connected,
      penaltyPoints: p.penaltyPoints,
      baselineEmission: p.emissions[state.config.baselineYear] ?? 0,
      windowSum: round1(windowSum(p, state.currentYear, state.config.historyWindow)),
      freeAllocation: record?.freeAllocation[p.id] ?? null,
      regulatorRequest: record?.regulatorRequest[p.id] ?? null,
      regulatorGranted:
        record && Object.keys(record.regulatorGranted).length > 0
          ? (record.regulatorGranted[p.id] ?? 0)
          : null,
      creditsHeld: record ? session.creditsHeld(p.id) : null,
      realized: record?.realized[p.id] ?? null,
      netPosition: record?.netPosition[p.id] ?? null,
      settlement: record?.settlement?.[p.id] ?? null,
    })),
  }
}
