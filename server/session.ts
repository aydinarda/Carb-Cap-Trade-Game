import { customAlphabet, nanoid } from 'nanoid'
import {
  BASELINE_YEAR,
  DEFAULT_ABATEMENT,
  DEFAULT_BENCHMARK,
  DEFAULT_PENALTY_RATE,
  DEFAULT_REGULATOR_PRICE,
  DEFAULT_SELL_PRICE,
  FIRST_GAME_YEAR,
  FREE_CREDIT_RATIO,
  HISTORY_WINDOW,
  INDUSTRY_NAMES,
  MAX_PLAYERS,
  type Industry,
} from '../shared/constants'
import {
  abatementCost,
  CAP_MECHANISMS,
  computeNetPositions,
  createRng,
  expectedEmission,
  generateHistoryForIndustry,
  grantRegulator,
  optimalYearCost,
  realizeYear,
  round1,
  settleYear,
  type Rng,
} from '../shared/engine'
import type { CapMode, GameState, Player, YearRecord } from '../shared/types'

const roomCodeAlphabet = customAlphabet('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 4)

export class GameError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'GameError'
  }
}

export class Session {
  readonly state: GameState
  readonly hostToken: string
  /** player token -> playerId */
  readonly playerTokens = new Map<string, string>()
  private readonly rng: Rng

  constructor(capMode: CapMode, seed?: number) {
    const actualSeed = seed ?? Math.floor(Math.random() * 2 ** 31)
    this.rng = createRng(actualSeed)
    this.hostToken = nanoid()
    this.state = {
      roomCode: roomCodeAlphabet(),
      seed: actualSeed,
      capMode,
      phase: 'lobby',
      currentYear: FIRST_GAME_YEAR,
      players: [],
      years: {},
      config: {
        freeCreditRatio: FREE_CREDIT_RATIO,
        historyWindow: HISTORY_WINDOW,
        baselineYear: BASELINE_YEAR,
        regulatorPrice: DEFAULT_REGULATOR_PRICE,
        sellPrice: DEFAULT_SELL_PRICE,
        penaltyRate: DEFAULT_PENALTY_RATE,
        benchmark: { ...DEFAULT_BENCHMARK },
        abatement: Object.fromEntries(
          INDUSTRY_NAMES.map((i) => [i, { ...DEFAULT_ABATEMENT[i] }]),
        ) as Record<Industry, { a: number; b: number }>,
      },
      freeCreditLimit: null,
    }
  }

  private get mechanism() {
    if (!this.state.capMode) throw new GameError('NO_MODE', 'No cap mode selected.')
    return CAP_MECHANISMS[this.state.capMode]
  }

  currentYearRecord(): YearRecord | null {
    return this.state.years[this.state.currentYear] ?? null
  }

  private requirePhase(...phases: GameState['phase'][]) {
    if (!phases.includes(this.state.phase)) {
      throw new GameError(
        'WRONG_PHASE',
        `Action not allowed in phase "${this.state.phase}".`,
      )
    }
  }

  private totalBaseline(): number {
    return this.state.players.reduce(
      (s, p) => s + (p.emissions[this.state.config.baselineYear] ?? 0),
      0,
    )
  }

  /** Credits a player holds: free + regulator (cap stage) + secondary buys − sells. */
  creditsHeld(playerId: string): number {
    const record = this.currentYearRecord()
    if (!record) return 0
    return round1(
      (record.freeAllocation[playerId] ?? 0) +
        (record.regulatorGranted[playerId] ?? 0) +
        (record.secondaryBought[playerId] ?? 0) -
        (record.secondarySold[playerId] ?? 0),
    )
  }

  /** Total credits a player bought for money this year (regulator + secondary). */
  purchased(playerId: string): number {
    const record = this.currentYearRecord()
    if (!record) return 0
    return round1(
      (record.regulatorGranted[playerId] ?? 0) + (record.secondaryBought[playerId] ?? 0),
    )
  }

  /** Credits a player could still sell: free + regulator + bought − already sold. */
  private sellableCapacity(playerId: string): number {
    const record = this.currentYearRecord()
    if (!record) return 0
    return round1(
      (record.freeAllocation[playerId] ?? 0) +
        (record.regulatorGranted[playerId] ?? 0) +
        (record.secondaryBought[playerId] ?? 0),
    )
  }

  // ---- lobby ----

  addPlayer(name: string, industry: Industry): { player: Player; token: string } {
    this.requirePhase('lobby')
    const trimmed = name.trim()
    if (!trimmed) throw new GameError('BAD_NAME', 'Please enter a name.')
    if (!INDUSTRY_NAMES.includes(industry)) {
      throw new GameError('BAD_INDUSTRY', 'Please pick an industry.')
    }
    if (this.state.players.length >= MAX_PLAYERS) {
      throw new GameError('FULL', 'This session is full.')
    }
    const profile = generateHistoryForIndustry(industry, this.rng)
    const player: Player = {
      id: `P${this.state.players.length + 1}`,
      name: trimmed.slice(0, 40),
      connected: true,
      score: 0,
      optimalScore: 0,
      ...profile,
    }
    this.state.players.push(player)
    const token = nanoid()
    this.playerTokens.set(token, player.id)
    return { player, token }
  }

  /** Allowed in the lobby AND between years — mode switches take effect next year. */
  setCapMode(mode: CapMode) {
    this.requirePhase('lobby', 'yearSummary')
    this.state.capMode = mode
  }

  updateSettings(settings: {
    regulatorPrice?: number
    sellPrice?: number
    penaltyRate?: number
    benchmark?: Partial<Record<Industry, number>>
    abatement?: Partial<Record<Industry, { a: number; b: number }>>
  }) {
    this.requirePhase('lobby', 'yearSummary')
    for (const key of ['regulatorPrice', 'sellPrice', 'penaltyRate'] as const) {
      const value = settings[key]
      if (value === undefined) continue
      if (!Number.isFinite(value) || value < 0) {
        throw new GameError('BAD_SETTING', `${key} must be a non-negative number.`)
      }
      this.state.config[key] = round1(value)
    }
    if (settings.benchmark) {
      for (const [industry, value] of Object.entries(settings.benchmark)) {
        if (value === undefined) continue
        if (!Number.isFinite(value) || value < 0) {
          throw new GameError('BAD_SETTING', `benchmark for ${industry} must be non-negative.`)
        }
        this.state.config.benchmark[industry as Industry] = round1(value)
      }
    }
    if (settings.abatement) {
      for (const [industry, coeff] of Object.entries(settings.abatement)) {
        if (!coeff) continue
        if (!Number.isFinite(coeff.a) || coeff.a < 0 || !Number.isFinite(coeff.b) || coeff.b < 0) {
          throw new GameError('BAD_SETTING', `abatement for ${industry} must be non-negative.`)
        }
        this.state.config.abatement[industry as Industry] = {
          a: round1(coeff.a),
          b: round1(coeff.b),
        }
      }
    }
  }

  kickPlayer(playerId: string) {
    this.requirePhase('lobby')
    const index = this.state.players.findIndex((p) => p.id === playerId)
    if (index === -1) throw new GameError('NO_PLAYER', 'Player not found.')
    this.state.players.splice(index, 1)
    for (const [token, id] of this.playerTokens) {
      if (id === playerId) this.playerTokens.delete(token)
    }
    // Re-number so ids always match join order P1..PN (lobby only, nothing allocated yet)
    this.state.players.forEach((p, i) => {
      const newId = `P${i + 1}`
      if (p.id !== newId) {
        for (const [token, id] of this.playerTokens) {
          if (id === p.id) this.playerTokens.set(token, newId)
        }
        p.id = newId
      }
    })
  }

  // ---- phase transitions (host-driven) ----

  startYear() {
    this.requirePhase('lobby')
    if (this.state.players.length === 0) {
      throw new GameError('NO_PLAYERS', 'No players have joined yet.')
    }
    const mechanism = this.mechanism
    if (!mechanism.implemented) {
      throw new GameError(
        'MECHANISM_PENDING',
        `The "${this.state.capMode}" mechanism is not implemented yet — allocation details are pending from the game designer. Switch to grandfathering to play now.`,
      )
    }
    this.state.freeCreditLimit = mechanism.computeFreeCreditLimit(
      this.state.players,
      this.state.config,
    )
    this.openYear(FIRST_GAME_YEAR)
  }

  private openYear(year: number) {
    const mechanism = this.mechanism
    if (!mechanism.implemented) {
      throw new GameError(
        'MECHANISM_PENDING',
        `The "${this.state.capMode}" mechanism is not implemented yet — allocation details are pending from the game designer. Switch back to grandfathering to continue.`,
      )
    }
    this.state.currentYear = year
    const freeAllocation = mechanism.allocate(
      this.state.players,
      year,
      this.state.freeCreditLimit!,
      this.state.config,
    )
    const totalFree = Object.values(freeAllocation).reduce((a, b) => a + b, 0)
    this.state.years[year] = {
      year,
      freeAllocation,
      regulatorRequest: {},
      regulatorGranted: {},
      // The regulator sells whatever slice of the baseline is not given out for
      // free, so the cap stays at 100% of the baseline: grandfathering → ~20%,
      // benchmarking → the remainder, auctioning → 100% (nothing is free).
      regulatorPool: round1(Math.max(0, this.totalBaseline() - totalFree)),
      realized: {},
      secondaryBought: {},
      secondarySold: {},
      abatement: {},
      settlement: null,
      netPosition: {},
    }
    this.state.phase = 'cap'
  }

  closeCapStage() {
    this.requirePhase('cap')
    const record = this.currentYearRecord()!
    // Stragglers default to requesting 0
    for (const player of this.state.players) {
      record.regulatorRequest[player.id] ??= 0
    }
    record.regulatorGranted = grantRegulator(record.regulatorRequest, record.regulatorPool)
    // Emissions are NOT realized here — players trade against their expected
    // (mean) emission; the actual realization happens at year end (closeTrade).
    this.state.phase = 'reveal'
  }

  openTrade() {
    this.requirePhase('reveal')
    this.state.phase = 'trade'
  }

  closeTrade() {
    this.requirePhase('trade', 'reveal')
    const record = this.currentYearRecord()!
    // Realization happens now, at year end: each company's actual emission is
    // drawn from its own distribution around the expected mean it planned against.
    record.realized = realizeYear(this.state.players, this.rng, record.year, record.abatement)
    for (const player of this.state.players) {
      player.emissions[record.year] = record.realized[player.id]
    }
    const held: Record<string, number> = {}
    const purchased: Record<string, number> = {}
    const sold: Record<string, number> = {}
    const abateCost: Record<string, number> = {}
    const optimal: Record<string, number> = {}
    const { regulatorPrice, sellPrice, penaltyRate } = this.state.config
    for (const player of this.state.players) {
      held[player.id] = this.creditsHeld(player.id)
      purchased[player.id] = this.purchased(player.id)
      sold[player.id] = round1(record.secondarySold[player.id] ?? 0)
      const expected = expectedEmission(player, record.year)
      const coeff = this.state.config.abatement[player.industry]
      abateCost[player.id] = abatementCost(expected, record.abatement[player.id] ?? 0, coeff)
      // Best achievable cost for this company (abate to r*, cover residual vs its free credits)
      const free = round1(
        (record.freeAllocation[player.id] ?? 0) + (record.regulatorGranted[player.id] ?? 0),
      )
      optimal[player.id] = optimalYearCost(expected, free, coeff, regulatorPrice, sellPrice)
    }
    const { settlement } = settleYear(record.realized, held, purchased, sold, abateCost, {
      regulatorPrice,
      sellPrice,
      penaltyRate,
    })
    record.settlement = settlement
    record.netPosition = computeNetPositions(record.realized, held)
    for (const player of this.state.players) {
      player.score = round1(player.score + (settlement[player.id]?.yearCost ?? 0))
      player.optimalScore = round1(player.optimalScore + (optimal[player.id] ?? 0))
    }
    this.state.phase = 'yearSummary'
  }

  advanceYear() {
    this.requirePhase('yearSummary')
    this.openYear(this.state.currentYear + 1)
  }

  endGame() {
    this.state.phase = 'ended'
  }

  // ---- player actions ----

  requestCredits(playerId: string, qty: number) {
    this.requirePhase('cap')
    if (!Number.isFinite(qty) || qty < 0) {
      throw new GameError('BAD_REQUEST', 'Requested credits must be a non-negative number.')
    }
    const record = this.currentYearRecord()!
    // No one may request more than twice their fair share of the regulator pool,
    // so a single company can't corner it and starve the others.
    const cap = round1((record.regulatorPool / this.state.players.length) * 2)
    if (round1(qty) > cap) {
      throw new GameError(
        'REQUEST_TOO_HIGH',
        `You can request at most ${cap} credits (twice your fair share of the pool).`,
      )
    }
    record.regulatorRequest[playerId] = round1(qty)
  }

  /**
   * Trade stage: buy `qty` credits from the regulator at the fixed price. Supply
   * is unlimited; this is a cumulative set (the client sends the desired total
   * for the year), so re-submitting replaces the running amount rather than
   * stacking, matching the cap-stage requestCredits pattern.
   */
  buyCredits(playerId: string, qty: number) {
    this.requirePhase('trade')
    if (!Number.isFinite(qty) || qty < 0) {
      throw new GameError('BAD_BUY', 'Credits to buy must be a non-negative number.')
    }
    const record = this.currentYearRecord()!
    const rounded = round1(qty)
    // Can't lower your buy below what you've already committed to sell (holdings ≥ 0).
    const alreadySold = round1(record.secondarySold[playerId] ?? 0)
    const base = round1(
      (record.freeAllocation[playerId] ?? 0) + (record.regulatorGranted[playerId] ?? 0),
    )
    if (base + rounded < alreadySold) {
      throw new GameError(
        'INSUFFICIENT_CREDITS',
        `You have listed ${alreadySold} credits to sell; buy at least ${round1(alreadySold - base)}.`,
      )
    }
    record.secondaryBought[playerId] = rounded
  }

  /**
   * Trade stage: sell `qty` held credits back at the sell price. Cumulative set,
   * like buyCredits. Capped by holdings (free + regulator + bought) so you can't
   * sell credits you don't have; the sell income is applied at settlement.
   */
  sellCredits(playerId: string, qty: number) {
    this.requirePhase('trade')
    if (!Number.isFinite(qty) || qty < 0) {
      throw new GameError('BAD_SELL', 'Credits to sell must be a non-negative number.')
    }
    const rounded = round1(qty)
    const capacity = this.sellableCapacity(playerId)
    if (rounded > capacity) {
      throw new GameError(
        'INSUFFICIENT_CREDITS',
        `You hold ${capacity} credits — you can sell at most that many.`,
      )
    }
    const record = this.currentYearRecord()!
    record.secondarySold[playerId] = rounded
  }

  /**
   * Trade stage: choose to abate a fraction (0..1) of expected emissions. Lowers
   * the realized mean at year end, at a per-sector convex cost. Cumulative set.
   */
  setAbatement(playerId: string, fraction: number) {
    this.requirePhase('trade')
    if (!Number.isFinite(fraction) || fraction < 0) {
      throw new GameError('BAD_ABATE', 'Abatement fraction must be a non-negative number.')
    }
    const record = this.currentYearRecord()!
    record.abatement[playerId] = round1(Math.min(1, fraction))
  }

  getPlayer(playerId: string): Player | undefined {
    return this.state.players.find((p) => p.id === playerId)
  }
}

export class SessionStore {
  private byCode = new Map<string, Session>()

  create(capMode: CapMode, seed?: number): Session {
    const session = new Session(capMode, seed)
    this.byCode.set(session.state.roomCode, session)
    return session
  }

  get(roomCode: string): Session | undefined {
    return this.byCode.get(roomCode.toUpperCase())
  }

  findByHostToken(token: string): Session | undefined {
    for (const session of this.byCode.values()) {
      if (session.hostToken === token) return session
    }
    return undefined
  }

  findByPlayerToken(token: string): { session: Session; playerId: string } | undefined {
    for (const session of this.byCode.values()) {
      const playerId = session.playerTokens.get(token)
      if (playerId) return { session, playerId }
    }
    return undefined
  }
}
