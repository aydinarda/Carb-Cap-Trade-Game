import { INDUSTRY_NAMES } from '../shared/constants'
import { expectedEmission, windowSum } from '../shared/engine'
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
  }))
}

function leaderboard(session: Session): LeaderboardRow[] {
  const { baselineYear } = session.state.config
  const normalized = (p: Session['state']['players'][number]) => {
    const baseline = p.emissions[baselineYear] ?? 0
    return baseline > 0 ? round1((p.score - p.optimalScore) / baseline) : p.score - p.optimalScore
  }
  return [...session.state.players]
    .sort((a, b) => normalized(a) - normalized(b))
    .map((p) => ({
      id: p.id,
      name: p.name,
      industry: p.industry,
      score: p.score,
      normalizedScore: normalized(p),
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
  // Under auctioning the cap-stage input is bids, not regulator requests.
  const capDemand = record
    ? auctioning
      ? round1(Object.values(record.auctionBid).reduce((a, b) => a + b.qty, 0))
      : sum(record.regulatorRequest)
    : null
  const capSubmitted = record
    ? Object.keys(auctioning ? record.auctionBid : record.regulatorRequest).length
    : 0

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
    regulatorPool: record?.regulatorPool ?? null,
    regulatorRequestTotal: record
      ? round1(Object.values(record.regulatorRequest).reduce((a, b) => a + b, 0))
      : null,
    regulatorRequestCap: round1(
      ((record?.regulatorPool ?? 0) / Math.max(1, state.players.length)) * 2,
    ),
    regulatorPrice: state.config.regulatorPrice,
    sellPrice: state.config.sellPrice,
    abatementCoeff: state.config.abatement[player.industry],
    auctionSupply: state.capMode === 'auctioning' ? (record?.regulatorPool ?? 0) : 0,
    auctionPrice: record?.auctionPrice ?? null,
    classAggregate: state.phase === 'lobby' ? null : classAggregate(session),
    leaderboard: settled ? leaderboard(session) : null,
    you: {
      id: player.id,
      name: player.name,
      industry: player.industry,
      emissions: player.emissions,
      score: player.score,
      freeAllocation: record?.freeAllocation[player.id] ?? null,
      regulatorRequest: record?.regulatorRequest[player.id] ?? null,
      regulatorGranted:
        record && Object.keys(record.regulatorGranted).length > 0
          ? (record.regulatorGranted[player.id] ?? 0)
          : null,
      auctionBid: record?.auctionBid[player.id] ?? null,
      auctionAward:
        record && record.auctionPrice !== null
          ? (record.regulatorGranted[player.id] ?? 0)
          : null,
      secondaryBought: record?.secondaryBought[player.id] ?? null,
      secondarySold: record?.secondarySold[player.id] ?? null,
      abatement: record?.abatement[player.id] ?? null,
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
      const bought = round1(y.secondaryBought[p.id] ?? 0)
      const sold = round1(y.secondarySold[p.id] ?? 0)
      return {
        year: y.year,
        expected: round1(expectedEmission(p, y.year)),
        realized: y.realized[p.id] ?? null,
        free,
        regulatorGranted: granted,
        secondaryBought: bought,
        secondarySold: sold,
        abatement: round1(y.abatement[p.id] ?? 0),
        creditsHeld: round1(free + granted + bought - sold),
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
    playerHistory: buildPlayerHistory(session),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      industry: p.industry,
      connected: p.connected,
      score: p.score,
      baselineEmission: p.emissions[state.config.baselineYear] ?? 0,
      windowSum: round1(windowSum(p, state.currentYear, state.config.historyWindow)),
      freeAllocation: record?.freeAllocation[p.id] ?? null,
      regulatorRequest: record?.regulatorRequest[p.id] ?? null,
      regulatorGranted:
        record && Object.keys(record.regulatorGranted).length > 0
          ? (record.regulatorGranted[p.id] ?? 0)
          : null,
      secondaryBought: record?.secondaryBought[p.id] ?? null,
      secondarySold: record?.secondarySold[p.id] ?? null,
      abatement: record?.abatement[p.id] ?? null,
      creditsHeld: record ? session.creditsHeld(p.id) : null,
      expectedEmission: round1(expectedEmission(p, state.currentYear)),
      realized: record?.realized[p.id] ?? null,
      netPosition: record?.netPosition[p.id] ?? null,
      settlement: record?.settlement?.[p.id] ?? null,
    })),
  }
}
