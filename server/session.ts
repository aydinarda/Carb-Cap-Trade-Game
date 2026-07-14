import { customAlphabet, nanoid } from 'nanoid'
import {
  BASELINE_YEAR,
  DEFAULT_HIGH_PENALTY_RATE,
  DEFAULT_LOW_PENALTY_RATE,
  DEFAULT_REGULATOR_PRICE,
  FIRST_GAME_YEAR,
  FREE_CREDIT_RATIO,
  HISTORY_WINDOW,
  INDUSTRY_NAMES,
  MAX_PLAYERS,
  type Industry,
} from '../shared/constants'
import {
  CAP_MECHANISMS,
  cancelOrder,
  computeNetPositions,
  createRng,
  generateHistoryForIndustry,
  grantRegulator,
  matchOrder,
  openSellRemaining,
  realizeYear,
  round1,
  settleYear,
  tradedNet,
  type Rng,
} from '../shared/engine'
import type {
  CapMode,
  GameState,
  Order,
  OrderSide,
  Player,
  YearRecord,
} from '../shared/types'

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
  private orderSeq = 0

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
        lowPenaltyRate: DEFAULT_LOW_PENALTY_RATE,
        highPenaltyRate: DEFAULT_HIGH_PENALTY_RATE,
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

  /** Credits a player holds this year: free + regulator + bought − sold. */
  creditsHeld(playerId: string): number {
    const record = this.currentYearRecord()
    if (!record) return 0
    return round1(
      (record.freeAllocation[playerId] ?? 0) +
        (record.regulatorGranted[playerId] ?? 0) +
        tradedNet(record.trades, playerId),
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
      penaltyPoints: 0,
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
    lowPenaltyRate?: number
    highPenaltyRate?: number
  }) {
    this.requirePhase('lobby', 'yearSummary')
    for (const key of ['regulatorPrice', 'lowPenaltyRate', 'highPenaltyRate'] as const) {
      const value = settings[key]
      if (value === undefined) continue
      if (!Number.isFinite(value) || value < 0) {
        throw new GameError('BAD_SETTING', `${key} must be a non-negative number.`)
      }
      this.state.config[key] = round1(value)
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
    this.state.years[year] = {
      year,
      freeAllocation: mechanism.allocate(
        this.state.players,
        year,
        this.state.freeCreditLimit!,
        this.state.config,
      ),
      regulatorRequest: {},
      regulatorGranted: {},
      // The regulator sells the slice of the baseline NOT given out for free,
      // so the total cap (free + regulator) stays at 100% of the baseline.
      regulatorPool: round1(this.totalBaseline() * (1 - this.state.config.freeCreditRatio)),
      realized: {},
      orders: [],
      trades: [],
      settlement: null,
      leftoverDistributed: 0,
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
    // Emission uncertainty is revealed only after the cap stage closes
    record.realized = realizeYear(this.state.players, this.rng)
    for (const player of this.state.players) {
      player.emissions[record.year] = record.realized[player.id]
    }
    this.state.phase = 'reveal'
  }

  openTrade() {
    this.requirePhase('reveal')
    this.state.phase = 'trade'
  }

  closeTrade() {
    this.requirePhase('trade', 'reveal')
    const record = this.currentYearRecord()!
    const held: Record<string, number> = {}
    for (const player of this.state.players) {
      held[player.id] = this.creditsHeld(player.id)
    }
    // Credits still resting in open sell orders at close form the leftover pool
    const leftoverPool = round1(
      this.state.players.reduce((s, p) => s + openSellRemaining(record.orders, p.id), 0),
    )
    const { settlement, leftoverDistributed } = settleYear(
      record.realized,
      held,
      leftoverPool,
      this.state.config,
    )
    record.settlement = settlement
    record.leftoverDistributed = leftoverDistributed
    record.netPosition = computeNetPositions(record.realized, held)
    for (const player of this.state.players) {
      player.penaltyPoints = round1(
        player.penaltyPoints + (settlement[player.id]?.penalty ?? 0),
      )
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
    record.regulatorRequest[playerId] = round1(qty)
  }

  placeOrder(playerId: string, side: OrderSide, qty: number, price: number) {
    this.requirePhase('trade')
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new GameError('BAD_ORDER', 'Quantity must be a positive number.')
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new GameError('BAD_ORDER', 'Price must be a positive number.')
    }
    const record = this.currentYearRecord()!
    const roundedQty = round1(qty)
    if (side === 'sell') {
      const capacity = round1(
        this.creditsHeld(playerId) - openSellRemaining(record.orders, playerId),
      )
      if (roundedQty > capacity) {
        throw new GameError(
          'INSUFFICIENT_CREDITS',
          `You can offer at most ${capacity} credits (held minus already-listed offers).`,
        )
      }
    }
    this.orderSeq += 1
    const order: Order = {
      id: nanoid(8),
      playerId,
      side,
      qty: roundedQty,
      remaining: roundedQty,
      price: round1(price),
      status: 'open',
      seq: this.orderSeq,
    }
    const { trades } = matchOrder(record.orders, order, () => nanoid(8))
    record.trades.push(...trades)
  }

  cancelOrder(playerId: string, orderId: string) {
    this.requirePhase('trade')
    const record = this.currentYearRecord()!
    if (!cancelOrder(record.orders, playerId, orderId)) {
      throw new GameError('NO_ORDER', 'Order not found or already closed.')
    }
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
