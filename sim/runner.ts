import { stepBots } from '../server/bots/step'
import type { BotRuntime } from '../server/bots/types'
import { Session } from '../server/session'
import { RESERVE_ID } from '../shared/constants'
import { buildMarketView, createRng, round1, tradedNet } from '../shared/engine'
import type { BotType, CapMode, Industry } from './scenarios'
import type { DeepPartial, GameConfig } from '../shared/config'
import { actAuction, actTrade, allocateMix, type Behaviour, type YearContext } from './agents/behaviours'
import { finalMetrics, sampleBook, yearMetrics, type BookSample, type FinalMetrics, type YearMetrics } from './metrics'
import type { PlayerRow } from './db'

export interface Population {
  /** Number of simulated students. */
  humans: number
  /** Proportional mix of student behaviours. */
  behaviourMix: Partial<Record<Behaviour, number>>
  /** Proportional mix of sectors the students pick at join. */
  sectorMix: Partial<Record<Industry, number>>
  /** Liquidity/realism bots, by archetype. */
  bots: Partial<Record<BotType, number>>
}

export interface RunSpec {
  scenario: string
  capMode: CapMode
  seed: number
  years: number
  /** Simulated ticks per trade window — the analogue of the 2.5 s live bot interval. */
  ticksPerYear: number
  population: Population
  config?: DeepPartial<GameConfig>
}

export interface RunResult {
  spec: RunSpec
  years: { year: number; metrics: YearMetrics; players: PlayerRow[] }[]
  /**
   * What `endGame` did — measured, not assumed.
   *
   * The run used to stop after the last `closeTrade`, which meant the end-of-game carry
   * settlement was never exercised at all. That settlement is now ASYMMETRIC (a leftover
   * surplus is stranded and worth nothing; a leftover debt is still bought back at the final
   * price), so it is a real term in every player's score and in the incentive to hoard. A
   * simulator that never calls it is scoring a different game from the one that ships.
   */
  final: FinalMetrics
  trades: {
    year: number
    seq: number
    price: number
    qty: number
    buyerKind: string
    sellerKind: string
  }[]
}

/**
 * Runs one scenario headlessly, in-process.
 *
 * No sockets: the simulator drives `Session` exactly as the socket layer does, and calls
 * the real `stepBots`, so what it measures is the shipped engine and the shipped bots.
 * That makes a run deterministic in `seed` and fast enough to sweep hundreds of
 * parameter combinations.
 */
export function runScenario(spec: RunSpec): RunResult {
  const session = new Session(spec.capMode, spec.seed, spec.config)

  // Separate RNGs, mirroring the live split: the engine's own seeded RNG must not be
  // perturbed by how many times an agent happened to act.
  const botRng = createRng((spec.seed ^ 0xb07) >>> 0)
  const agentRng = createRng((spec.seed ^ 0xa9e) >>> 0)
  const botRuntime = new Map<string, BotRuntime>()
  const runtimeFor = (id: string) => {
    let rt = botRuntime.get(id)
    if (!rt) botRuntime.set(id, (rt = {}))
    return rt
  }

  // --- population ---
  const { humans, behaviourMix, sectorMix, bots } = spec.population
  const behaviours = allocateMix(behaviourMix, humans)
  const sectors = allocateMix(sectorMix, humans)
  const agents = behaviours.map((behaviour, i) => {
    const { player } = session.addPlayer(`S${i + 1}`, sectors[i])
    return { playerId: player.id, behaviour }
  })
  const behaviourOf = new Map(agents.map((a) => [a.playerId, a.behaviour]))
  for (const [botType, count] of Object.entries(bots)) {
    for (let i = 0; i < (count ?? 0); i++) session.addBot(botType as BotType)
  }

  const result: RunResult = { spec, years: [], trades: [], final: {} as FinalMetrics }

  for (let y = 0; y < spec.years; y++) {
    if (y === 0) session.startYear()
    else session.advanceYear()
    const record = session.currentYearRecord()!
    // The agents are told how long the game is, exactly as a class is told at the start.
    // Without it they cannot price the end: capacity bought in the last year never switches
    // on, and a surplus carried past the last year is stranded.
    const yearCtx: YearContext = { index: y, total: spec.years }

    // --- cap stage ---
    if (session.usesAuction) {
      for (const agent of agents) actAuction(session, agent, agentRng, yearCtx)
      stepBots(session, botRng, runtimeFor)
    }
    session.closeCapStage()
    session.openTrade()

    // --- trade window ---
    const samples: BookSample[] = []
    for (let tick = 0; tick < spec.ticksPerYear; tick++) {
      const ctx = {
        progress: spec.ticksPerYear <= 1 ? 1 : tick / (spec.ticksPerYear - 1),
        isLastTick: tick === spec.ticksPerYear - 1,
        year: yearCtx,
      }
      for (const agent of agents) actTrade(session, agent, agentRng, ctx)
      stepBots(session, botRng, runtimeFor)
      samples.push(sampleBook(buildMarketView(record.orders, record.trades)))
    }

    // Snapshot holdings before settlement clears the year.
    const heldBefore = new Map(session.state.players.map((p) => [p.id, session.creditsHeld(p.id)]))
    const optimalBefore = new Map(session.state.players.map((p) => [p.id, p.optimalScore]))
    session.closeTrade()

    const kindOf = (id: string) => {
      if (id === RESERVE_ID) return 'regulator'
      const p = session.getPlayer(id)
      if (!p) return 'unknown'
      return p.isBot ? `bot:${p.botType}` : `student:${behaviourOf.get(id) ?? '?'}`
    }
    for (const t of record.trades) {
      result.trades.push({
        year: record.year,
        seq: t.seq,
        price: t.price,
        qty: t.qty,
        buyerKind: kindOf(t.buyerId),
        sellerKind: kindOf(t.sellerId),
      })
    }

    const players: PlayerRow[] = session.state.players.map((p) => ({
      playerId: p.id,
      behaviour: behaviourOf.get(p.id) ?? null,
      industry: p.industry,
      isBot: !!p.isBot,
      botType: p.botType ?? null,
      freeAllocation: record.freeAllocation[p.id] ?? 0,
      regulatorGranted: record.regulatorGranted[p.id] ?? 0,
      held: heldBefore.get(p.id) ?? 0,
      realized: record.realized[p.id] ?? 0,
      abatement: record.abatement[p.id] ?? 0,
      abatementCommitted: p.abatementCommitted,
      abatementSpend: round1(record.abatementSpend[p.id] ?? 0),
      installed: p.id in record.abatementInstalled,
      tradedNet: round1(tradedNet(record.trades, p.id)),
      yearCost: record.settlement?.[p.id]?.yearCost ?? 0,
      optimalCost: round1(p.optimalScore - (optimalBefore.get(p.id) ?? 0)),
      // Cumulative, not per-year: this is what the leaderboard scores, and a per-year
      // slice of it would say nothing about where a player stands.
      investmentGapTotal: p.investmentGapTotal,
      baseline: p.emissions[session.state.config.emissions.baselineYear] ?? 0,
    }))

    result.years.push({
      year: record.year,
      metrics: yearMetrics(session, record, samples),
      players,
    })
  }

  // Scores before the carry is closed, so the endgame term can be reported on its own
  // rather than buried inside the total.
  const scoreBeforeEnd = new Map(session.state.players.map((p) => [p.id, p.score]))
  session.endGame()
  result.final = finalMetrics(session, behaviourOf, scoreBeforeEnd)

  return result
}
