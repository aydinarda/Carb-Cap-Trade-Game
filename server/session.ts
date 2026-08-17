import { customAlphabet, nanoid } from 'nanoid'
import {
  BASELINE_YEAR,
  DEFAULT_ABATEMENT,
  DEFAULT_AUCTION_CAP_RATIO,
  DEFAULT_BENCHMARK,
  DEFAULT_CAP_REDUCTION_FACTOR,
  DEFAULT_PENALTY_RATE,
  FIRST_GAME_YEAR,
  FREE_CREDIT_RATIO,
  HISTORY_WINDOW,
  INDUSTRY_NAMES,
  MAX_PLAYERS,
  type Industry,
} from '../shared/constants'
import {
  abatementCost,
  buildMarketView,
  cancelOrder,
  CAP_MECHANISMS,
  clearAuction,
  computeNetPositions,
  createRng,
  expectedEmission,
  generateHistoryForIndustry,
  matchOrder,
  openSellRemaining,
  optimalYearCost,
  realizeYear,
  round1,
  settleYear,
  tradedCash,
  tradedNet,
  type Rng,
} from '../shared/engine'
import type {
  BotType,
  CapMode,
  GameState,
  Order,
  OrderSide,
  Player,
  PlayerProfile,
  YearRecord,
} from '../shared/types'

const BOT_LABELS: Record<BotType, string> = {
  compliance: 'Firm-Bot',
  marketMaker: 'MM-Bot',
  speculator: 'Spec-Bot',
  noise: 'Noise-Bot',
}

/** Near-zero emission history for pure-trader bots (financial players). */
function flatTinyHistory(industry: Industry): PlayerProfile {
  const emissions: Record<number, number> = {}
  for (let y = 1; y <= HISTORY_WINDOW; y++) emissions[y] = 0.1
  return { industry, emissions }
}

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
        penaltyRate: DEFAULT_PENALTY_RATE,
        benchmark: { ...DEFAULT_BENCHMARK },
        abatement: Object.fromEntries(
          INDUSTRY_NAMES.map((i) => [i, { ...DEFAULT_ABATEMENT[i] }]),
        ) as Record<Industry, { a: number; b: number }>,
        auctionCapRatio: DEFAULT_AUCTION_CAP_RATIO,
        capReductionFactor: DEFAULT_CAP_REDUCTION_FACTOR,
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

  /**
   * Credits a player holds: free + cap-stage (auction) + carry banked from prior
   * years (or minus a make-good debt) + net traded in the market.
   */
  creditsHeld(playerId: string): number {
    const record = this.currentYearRecord()
    if (!record) return 0
    return round1(
      (record.freeAllocation[playerId] ?? 0) +
        (record.regulatorGranted[playerId] ?? 0) +
        (record.carriedIn[playerId] ?? 0) +
        tradedNet(record.trades, playerId),
    )
  }

  /**
   * Most recent SETTLED year's discovered market price (VWAP → last → auction),
   * or null before any year has traded. Used as the reference the bots anchor to
   * and shown to players as the previous round's price signal.
   */
  previousMarketPrice(): number | null {
    const completed = Object.values(this.state.years)
      .filter((y) => y.year !== this.state.currentYear && Object.keys(y.realized).length > 0)
      .sort((a, b) => b.year - a.year)
    for (const y of completed) {
      const mv = buildMarketView(y.orders, y.trades)
      if (mv.vwap !== null) return mv.vwap
      if (mv.lastPrice !== null) return mv.lastPrice
      if (y.auctionPrice) return y.auctionPrice
    }
    return null
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
      bankedCredits: 0,
      ...profile,
    }
    this.state.players.push(player)
    const token = nanoid()
    this.playerTokens.set(token, player.id)
    return { player, token }
  }

  /** Lobby only: add a backend bot (no socket/token). Emitter archetypes get a real
   * history; pure-trader archetypes get a near-zero one (financial players). */
  addBot(botType: BotType, industry?: Industry): Player {
    this.requirePhase('lobby')
    if (this.state.players.length >= MAX_PLAYERS) {
      throw new GameError('FULL', 'This session is full.')
    }
    const ind = industry ?? INDUSTRY_NAMES[Math.floor(this.rng.uniform(0, INDUSTRY_NAMES.length))]
    const isEmitter = botType === 'compliance' || botType === 'noise'
    const profile = isEmitter ? generateHistoryForIndustry(ind, this.rng) : flatTinyHistory(ind)
    const n = this.state.players.filter((p) => p.botType === botType).length + 1
    const player: Player = {
      id: `P${this.state.players.length + 1}`,
      name: `${BOT_LABELS[botType]} ${n}`,
      connected: true,
      score: 0,
      optimalScore: 0,
      bankedCredits: 0,
      isBot: true,
      botType,
      ...profile,
    }
    this.state.players.push(player)
    return player
  }

  /** Lobby only: remove a bot by id (reuses kickPlayer's splice + P# renumber). */
  removeBot(playerId: string) {
    this.requirePhase('lobby')
    const bot = this.state.players.find((p) => p.id === playerId)
    if (!bot || !bot.isBot) throw new GameError('NO_BOT', 'Bot not found.')
    this.kickPlayer(playerId)
  }

  /** Allowed in the lobby AND between years — mode switches take effect next year. */
  setCapMode(mode: CapMode) {
    this.requirePhase('lobby', 'yearSummary')
    this.state.capMode = mode
  }

  updateSettings(settings: {
    penaltyRate?: number
    auctionCapRatio?: number
    capReductionFactor?: number
    benchmark?: Partial<Record<Industry, number>>
    abatement?: Partial<Record<Industry, { a: number; b: number }>>
  }) {
    this.requirePhase('lobby', 'yearSummary')
    for (const key of ['penaltyRate', 'auctionCapRatio'] as const) {
      const value = settings[key]
      if (value === undefined) continue
      if (!Number.isFinite(value) || value < 0) {
        throw new GameError('BAD_SETTING', `${key} must be a non-negative number.`)
      }
      this.state.config[key] = round1(value)
    }
    // Reduction factor needs finer precision than 1 dp (0.97 must not round to 1.0).
    if (settings.capReductionFactor !== undefined) {
      const v = settings.capReductionFactor
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        throw new GameError('BAD_SETTING', 'capReductionFactor must be in (0, 1].')
      }
      this.state.config.capReductionFactor = Math.round(v * 1000) / 1000
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
    // Only auctioning issues priced allowances (the auction cap). G/B just hand out
    // free credits; the rest of the cap simply isn't created, so the total in
    // circulation is fixed and the secondary market only redistributes it.
    // Auction supply shrinks each year by the reduction factor (EU-ETS LRF): a
    // deliberately tightening cap that makes allowances scarcer over time.
    const reduction = Math.pow(this.state.config.capReductionFactor, year - FIRST_GAME_YEAR)
    const pool =
      this.state.capMode === 'auctioning'
        ? round1(this.state.config.auctionCapRatio * this.totalBaseline() * reduction)
        : 0
    // Carry each company's banked surplus / make-good debt into this year's holdings.
    const carriedIn = Object.fromEntries(
      this.state.players.map((p) => [p.id, round1(p.bankedCredits)]),
    )
    this.state.years[year] = {
      year,
      freeAllocation,
      regulatorGranted: {},
      regulatorPool: pool,
      carriedIn,
      realized: {},
      orders: [],
      trades: [],
      abatement: {},
      auctionBid: {},
      auctionPrice: null,
      settlement: null,
      netPosition: {},
    }
    this.state.phase = 'cap'
  }

  closeCapStage() {
    this.requirePhase('cap')
    const record = this.currentYearRecord()!
    if (this.state.capMode === 'auctioning') {
      // Sealed-bid uniform-price auction: highest bidders win the fixed supply,
      // everyone pays the single clearing price.
      const { clearingPrice, awarded } = clearAuction(record.auctionBid, record.regulatorPool)
      record.regulatorGranted = awarded
      record.auctionPrice = clearingPrice
    }
    // Grandfathering/benchmarking: free allocation is all that's issued (already
    // applied in openYear) — nothing else happens at the cap close.
    // Emissions are NOT realized here — players trade against their expected mean;
    // the actual realization happens at year end (closeTrade).
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
    const purchaseCost: Record<string, number> = {}
    const sellIncome: Record<string, number> = {}
    const abateCost: Record<string, number> = {}
    const optimal: Record<string, number> = {}
    const { penaltyRate } = this.state.config
    // Auction credits cost the clearing price; G/B free credits cost 0.
    const capPrice = this.state.capMode === 'auctioning' ? (record.auctionPrice ?? 0) : 0
    // The market's volume-weighted average price is the reference for the optimum
    // benchmark. With no trades, fall back to the auction price or the penalty rate.
    const refPrice = buildMarketView(record.orders, record.trades).vwap ?? (record.auctionPrice || penaltyRate)
    for (const player of this.state.players) {
      held[player.id] = this.creditsHeld(player.id)
      const { buyCash, sellCash } = tradedCash(record.trades, player.id)
      const capCost = round1((record.regulatorGranted[player.id] ?? 0) * capPrice)
      purchaseCost[player.id] = round1(capCost + buyCash)
      sellIncome[player.id] = sellCash
      const expected = expectedEmission(player, record.year)
      const coeff = this.state.config.abatement[player.industry]
      abateCost[player.id] = abatementCost(expected, record.abatement[player.id] ?? 0, coeff)
      const free = round1(
        (record.freeAllocation[player.id] ?? 0) + (record.regulatorGranted[player.id] ?? 0),
      )
      optimal[player.id] = optimalYearCost(expected, free, coeff, refPrice)
    }
    const { settlement } = settleYear(record.realized, held, purchaseCost, sellIncome, abateCost, {
      penaltyRate,
    })
    record.settlement = settlement
    record.netPosition = computeNetPositions(record.realized, held)
    for (const player of this.state.players) {
      player.score = round1(player.score + (settlement[player.id]?.yearCost ?? 0))
      player.optimalScore = round1(player.optimalScore + (optimal[player.id] ?? 0))
      // EU-ETS carry: the year's net position rolls forward — surplus is banked,
      // an uncovered shortfall becomes a make-good debt (on top of the penalty just
      // charged). It adjusts next year's holdings via carriedIn.
      player.bankedCredits = round1((held[player.id] ?? 0) - (record.realized[player.id] ?? 0))
    }
    this.state.phase = 'yearSummary'
  }

  advanceYear() {
    this.requirePhase('yearSummary')
    this.openYear(this.state.currentYear + 1)
  }

  endGame() {
    // Settle leftover EU-ETS carry at the final market price: banked allowances are
    // cashed out (income → lower cost), a remaining make-good debt must be bought
    // back (cost → higher cost). After this the carry is closed.
    const finalPrice = this.finalReferencePrice()
    for (const player of this.state.players) {
      if (player.bankedCredits !== 0) {
        player.score = round1(player.score - player.bankedCredits * finalPrice)
        player.bankedCredits = 0
      }
    }
    this.state.phase = 'ended'
  }

  /** Most recent completed year's market VWAP; falls back to auction price / penalty. */
  private finalReferencePrice(): number {
    const completed = Object.values(this.state.years)
      .filter((y) => Object.keys(y.realized).length > 0)
      .sort((a, b) => b.year - a.year)
    for (const y of completed) {
      const vwap = buildMarketView(y.orders, y.trades).vwap
      if (vwap !== null) return vwap
      if (y.auctionPrice) return y.auctionPrice
    }
    return this.state.config.penaltyRate
  }

  // ---- player actions ----

  /**
   * Cap stage under auctioning: submit a sealed bid (quantity + max price per
   * credit). Resolved by a uniform-price auction when the cap stage closes.
   */
  submitBid(playerId: string, qty: number, price: number) {
    this.requirePhase('cap')
    if (this.state.capMode !== 'auctioning') {
      throw new GameError('WRONG_MODE', 'Bidding is only for the auctioning mode.')
    }
    if (!Number.isFinite(qty) || qty < 0) {
      throw new GameError('BAD_BID', 'Bid quantity must be a non-negative number.')
    }
    if (!Number.isFinite(price) || price < 0) {
      throw new GameError('BAD_BID', 'Bid price must be a non-negative number.')
    }
    const record = this.currentYearRecord()!
    record.auctionBid[playerId] = { qty: round1(qty), price: round1(price) }
  }

  /**
   * Trade stage: place a limit order in the order book. Matches immediately
   * against crossing orders (continuous double auction); the rest rests in the
   * book. No shorting — a sell order can't exceed credits held minus open asks.
   */
  placeOrder(playerId: string, side: OrderSide, qty: number, price: number) {
    this.requirePhase('trade')
    if (side !== 'buy' && side !== 'sell') throw new GameError('BAD_ORDER', 'Invalid side.')
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new GameError('BAD_ORDER', 'Quantity must be a positive number.')
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new GameError('BAD_ORDER', 'Price must be a positive number.')
    }
    const record = this.currentYearRecord()!
    const roundedQty = round1(qty)
    if (side === 'sell') {
      const capacity = round1(this.creditsHeld(playerId) - openSellRemaining(record.orders, playerId))
      if (roundedQty > capacity) {
        throw new GameError(
          'INSUFFICIENT_CREDITS',
          `You can offer at most ${capacity} credits (held minus your open asks) — no shorting.`,
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

  /** All live sessions — used by the bot driver to tick each room. */
  activeSessions(): Session[] {
    return [...this.byCode.values()]
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
