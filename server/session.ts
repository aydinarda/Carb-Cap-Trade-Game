import { customAlphabet, nanoid } from 'nanoid'
import { resolveConfig, type DeepPartial, type GameConfig } from '../shared/config'
import { INDUSTRY_NAMES, RESERVE_ID, type Industry } from '../shared/constants'
import {
  buildMarketView,
  cancelOrder,
  CAP_MECHANISMS,
  clearAuction,
  computeNetPositions,
  createRng,
  expectedEmission,
  generateHistoryForIndustry,
  incrementalFraction,
  installCost,
  isPureTrader,
  matchOrder,
  meanOfLast,
  openSellRemaining,
  optimalYearCost,
  plannedRelease,
  reserveBase,
  reservePot,
  realizeYear,
  round1,
  settleYear,
  tradedCash,
  tradedNet,
  unabatedFrom,
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
function flatTinyHistory(industry: Industry, config: GameConfig): PlayerProfile {
  const emissions: Record<number, number> = {}
  const { historyYears, traderHistoryLevel } = config.emissions
  for (let y = 1; y <= historyYears; y++) emissions[y] = traderHistoryLevel
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
  /**
   * Wall-clock of the last thing that happened in this room. Drives store eviction —
   * without it, finished classrooms were ticked 24×/min for the life of the process and
   * never freed.
   */
  lastActivity = Date.now()
  /** Set when the game ends, so the grace window is measured from the end, not from idle. */
  endedAt: number | null = null
  /** player token -> playerId */
  readonly playerTokens = new Map<string, string>()
  private readonly rng: Rng
  private orderSeq = 0

  /**
   * `override` is a deep-partial patch onto the shipped defaults — the entire interface a
   * simulation scenario needs to vary anything from the penalty rate to a sector's
   * abatement curve to the market maker's spread.
   */
  constructor(capMode: CapMode, seed?: number, override?: DeepPartial<GameConfig>) {
    const config = resolveConfig(override)
    const actualSeed = seed ?? Math.floor(Math.random() * 2 ** 31)
    this.rng = createRng(actualSeed)
    this.hostToken = nanoid()
    this.state = {
      roomCode: roomCodeAlphabet(),
      seed: actualSeed,
      capMode,
      phase: 'lobby',
      currentYear: config.emissions.firstGameYear,
      players: [],
      years: {},
      config,
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

  /** Capacity guard shared by humans and bots. `maxPlayers: 0` means no limit. */
  private requireRoom() {
    const { maxPlayers } = this.state.config.session
    if (maxPlayers > 0 && this.state.players.length >= maxPlayers) {
      throw new GameError('FULL', 'This session is full.')
    }
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
      (s, p) => s + (p.emissions[this.state.config.emissions.baselineYear] ?? 0),
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

  /**
   * The year's opening reference price: the last discovered market price, falling
   * back to half the penalty as a neutral first-year default. This is the price
   * signal the bots anchor to and the price the trader-bot seed is sold at.
   */
  openingReference(): number {
    const { penaltyRate, openingReferenceFraction } = this.state.config.market
    return this.previousMarketPrice() ?? penaltyRate * openingReferenceFraction
  }

  /**
   * Total allowances in circulation this year: the primary supply plus everything
   * handed out for free. Under auctioning free allocation is 0, so this is just the
   * auction pool; under the free-allocation modes it is the class's allocation.
   */
  circulatingCap(): number {
    const record = this.currentYearRecord()
    if (!record) return 0
    const free = Object.values(record.freeAllocation).reduce((a, b) => a + b, 0)
    // Reserve credits only count once SOLD — an unfilled rung is an offer, not supply.
    return round1(record.regulatorPool + free + record.reserveReleased)
  }

  /** Whether this session's mechanism runs a sealed-bid auction at the cap stage. */
  get usesAuction(): boolean {
    return this.state.capMode !== null && this.mechanism.usesAuction
  }

  // ---- lobby ----

  addPlayer(name: string, industry: Industry): { player: Player; token: string } {
    this.requirePhase('lobby')
    const trimmed = name.trim()
    if (!trimmed) throw new GameError('BAD_NAME', 'Please enter a name.')
    if (!INDUSTRY_NAMES.includes(industry)) {
      throw new GameError('BAD_INDUSTRY', 'Please pick an industry.')
    }
    this.requireRoom()
    const profile = generateHistoryForIndustry(industry, this.rng, this.state.config.emissions)
    const player: Player = {
      id: `P${this.state.players.length + 1}`,
      name: trimmed.slice(0, this.state.config.session.maxNameLength),
      connected: true,
      score: 0,
      optimalScore: 0,
      bankedCredits: 0,
      abatementInForce: 0,
      abatementCommitted: 0,
      abatementEmbedded: 0,
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
    this.requireRoom()
    const ind = industry ?? INDUSTRY_NAMES[Math.floor(this.rng.uniform(0, INDUSTRY_NAMES.length))]
    const isEmitter = botType === 'compliance' || botType === 'noise'
    const profile = isEmitter
      ? generateHistoryForIndustry(ind, this.rng, this.state.config.emissions)
      : flatTinyHistory(ind, this.state.config)
    const n = this.state.players.filter((p) => p.botType === botType).length + 1
    const player: Player = {
      id: `P${this.state.players.length + 1}`,
      name: `${BOT_LABELS[botType]} ${n}`,
      connected: true,
      score: 0,
      optimalScore: 0,
      bankedCredits: 0,
      abatementInForce: 0,
      abatementCommitted: 0,
      abatementEmbedded: 0,
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
    openingReferenceFraction?: number
    freeCreditRatio?: number
    auctionCapRatio?: number
    capReductionFactor?: number
    applyLRFToGrandfathering?: boolean
    benchmark?: Partial<Record<Industry, number>>
    abatement?: Partial<Record<Industry, { a: number; b: number }>>
    reserveEnabled?: boolean
    abatementLifetimeCap?: number
    abatementFixedCost?: number
    marketMakerInvFrac?: number
  }) {
    this.requirePhase('lobby', 'yearSummary')
    // Reject anything this method does not implement.
    //
    // Every branch below is `if (settings.x !== undefined)`, so a key that is not one of
    // them was simply dropped — and the call still acked `ok: true`. A caller tuning a knob
    // the deployed build does not have yet got a success and no effect, which is
    // indistinguishable from the knob not mattering. That cost a full calibration round.
    const KNOWN = new Set([
      'penaltyRate', 'openingReferenceFraction', 'freeCreditRatio', 'auctionCapRatio',
      'capReductionFactor', 'applyLRFToGrandfathering', 'benchmark', 'abatement',
      'reserveEnabled', 'abatementLifetimeCap', 'abatementFixedCost', 'marketMakerInvFrac',
    ])
    const unknown = Object.keys(settings).filter((k) => !KNOWN.has(k))
    if (unknown.length) {
      throw new GameError(
        'BAD_SETTING',
        `Unknown setting${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
          `This build accepts: ${[...KNOWN].join(', ')}.`,
      )
    }
    if (settings.abatementLifetimeCap !== undefined) {
      const cap = settings.abatementLifetimeCap
      if (!Number.isFinite(cap) || cap < 0 || cap > 1) {
        throw new GameError('BAD_SETTING', 'abatementLifetimeCap must be between 0 and 1.')
      }
      // Binds FUTURE installs only. Lowering it below what somebody has already built does
      // not un-install their capacity or refund them — the money is spent and the kit is
      // in the ground, which is the whole point of calling it permanent.
      this.state.config.abatement.lifetimeCap = Math.round(cap * 100) / 100
    }
    if (settings.abatementFixedCost !== undefined) {
      if (!Number.isFinite(settings.abatementFixedCost) || settings.abatementFixedCost < 0) {
        throw new GameError('BAD_SETTING', 'abatementFixedCost must be a non-negative number.')
      }
      this.state.config.abatement.fixedCostPerTonneBaseline = settings.abatementFixedCost
    }
    if (settings.penaltyRate !== undefined) {
      if (!Number.isFinite(settings.penaltyRate) || settings.penaltyRate < 0) {
        throw new GameError('BAD_SETTING', 'penaltyRate must be a non-negative number.')
      }
      this.state.config.market.penaltyRate = round1(settings.penaltyRate)
    }
    if (settings.openingReferenceFraction !== undefined) {
      const v = settings.openingReferenceFraction
      // Capped at 1: an opening anchor above the fine would seed every bot with a reference
      // no rational agent would ever pay, and year one would open above its own ceiling.
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        throw new GameError('BAD_SETTING', 'openingReferenceFraction must be in (0, 1].')
      }
      this.state.config.market.openingReferenceFraction = Math.round(v * 1000) / 1000
    }
    if (settings.freeCreditRatio !== undefined) {
      const v = settings.freeCreditRatio
      if (!Number.isFinite(v) || v < 0) {
        throw new GameError('BAD_SETTING', 'freeCreditRatio must be a non-negative number.')
      }
      this.state.config.allocation.freeCreditRatio = Math.round(v * 1000) / 1000
      // The class-wide limit is derived once at startYear, so a change made between years
      // would otherwise be stored and never applied. Recompute it here when the game is
      // already under way; it takes effect at the next year open, exactly like the
      // benchmark table and the reduction factor.
      if (this.state.freeCreditLimit !== null) {
        this.state.freeCreditLimit = this.mechanism.computeFreeCreditLimit(
          this.state.players,
          this.state.config,
        )
      }
    }
    if (settings.applyLRFToGrandfathering !== undefined) {
      this.state.config.allocation.applyLRFToGrandfathering = !!settings.applyLRFToGrandfathering
    }
    if (settings.marketMakerInvFrac !== undefined) {
      const v = settings.marketMakerInvFrac
      // Bounded well under 1: the target is a share of everything in circulation, and a
      // maker chasing most of the pool is the hoarding failure the incremental-bid fix
      // exists to prevent, not a liquidity setting.
      if (!Number.isFinite(v) || v < 0 || v > 0.9) {
        throw new GameError('BAD_SETTING', 'marketMakerInvFrac must be between 0 and 0.9.')
      }
      this.state.config.bots.marketMaker.invFrac = Math.round(v * 1000) / 1000
    }
    if (settings.reserveEnabled !== undefined) {
      // The pot is sized at year open regardless, so this is a pure on/off — a teacher can
      // play the same year with and without the ceiling and compare.
      this.state.config.allocation.reserve.enabled = !!settings.reserveEnabled
    }
    if (settings.auctionCapRatio !== undefined) {
      if (!Number.isFinite(settings.auctionCapRatio) || settings.auctionCapRatio < 0) {
        throw new GameError('BAD_SETTING', 'auctionCapRatio must be a non-negative number.')
      }
      this.state.config.allocation.auctionCapRatio = round1(settings.auctionCapRatio)
    }
    // Reduction factor needs finer precision than 1 dp (0.97 must not round to 1.0).
    if (settings.capReductionFactor !== undefined) {
      const v = settings.capReductionFactor
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        throw new GameError('BAD_SETTING', 'capReductionFactor must be in (0, 1].')
      }
      this.state.config.allocation.capReductionFactor = Math.round(v * 1000) / 1000
    }
    if (settings.benchmark) {
      for (const [industry, value] of Object.entries(settings.benchmark)) {
        if (value === undefined) continue
        if (!Number.isFinite(value) || value < 0) {
          throw new GameError('BAD_SETTING', `benchmark for ${industry} must be non-negative.`)
        }
        this.state.config.allocation.benchmark[industry as Industry] = round1(value)
      }
    }
    if (settings.abatement) {
      for (const [industry, coeff] of Object.entries(settings.abatement)) {
        if (!coeff) continue
        if (!Number.isFinite(coeff.a) || coeff.a < 0 || !Number.isFinite(coeff.b) || coeff.b < 0) {
          throw new GameError('BAD_SETTING', `abatement for ${industry} must be non-negative.`)
        }
        // The host panel only edits the linear MAC. A scenario may have swapped the
        // sector onto another curve, whose params these numbers would not describe.
        const current = this.state.config.abatement.sectors[industry as Industry]
        if (current.model !== 'linear') {
          throw new GameError(
            'BAD_SETTING',
            `abatement for ${industry} uses the "${current.model}" model, which the host panel cannot edit.`,
          )
        }
        this.state.config.abatement.sectors[industry as Industry] = {
          model: 'linear',
          params: { a: round1(coeff.a), b: round1(coeff.b) },
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
    this.openYear(this.state.config.emissions.firstGameYear)
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
    // The one-year lag, in two lines. Capacity paid for during the year just gone comes
    // online now; what was in force is now what the last realized emission already has
    // baked into it. `openYear` is the ONLY place `abatementInForce` moves, so nothing a
    // player does during a year can shorten the wait.
    for (const player of this.state.players) {
      player.abatementEmbedded = player.abatementInForce
      player.abatementInForce = player.abatementCommitted
    }
    const freeAllocation = mechanism.allocate(
      this.state.players,
      year,
      this.state.freeCreditLimit!,
      this.state.config,
    )
    // The primary supply, if this mechanism sells one at all. Only auctioning does
    // today; the free-allocation modes issue nothing beyond the allocation above, so
    // the total in circulation is fixed and the market only redistributes it.
    const pool = mechanism.poolFor(
      this.state.players,
      year,
      this.state.config,
      this.totalBaseline(),
    )
    // Carry each company's banked surplus / make-good debt into this year's holdings.
    const carriedIn = Object.fromEntries(
      this.state.players.map((p) => [p.id, round1(p.bankedCredits)]),
    )
    const record: YearRecord = {
      year,
      freeAllocation,
      regulatorGranted: {},
      regulatorPool: pool,
      carriedIn,
      realized: {},
      orders: [],
      trades: [],
      // Not empty, and not reset: capacity is permanent, so the year opens with whatever
      // has come online. `abatementInstalled`/`abatementSpend` record only what is newly
      // bought during this year.
      abatement: Object.fromEntries(
        this.state.players.map((p) => [p.id, p.abatementInForce]),
      ),
      abatementInstalled: {},
      abatementSpend: {},
      auctionBid: {},
      auctionPrice: null,
      primaryPrice: null,
      settlement: null,
      netPosition: {},
      // Cost containment reserve: sized once, from the shortfall this year opens with.
      // `issuance` matches circulatingCap()'s definition (free + pool) so the two agree.
      reservePot: reservePot(
        this.state.config.allocation.reserve,
        reserveBase(
          this.state.config.allocation.reserve,
          // `plannedEmission`, not `expectedEmission`: capacity that came online this
          // morning has already cut the need the reserve is sizing itself against.
          round1(
            this.state.players.reduce((s, p) => s + this.plannedFor(p, year), 0),
          ),
          round1(Object.values(freeAllocation).reduce((a, b) => a + b, 0) + pool),
        ),
      ),
      reserveReleased: 0,
      reserveCommitted: 0,
      reserveRevenue: 0,
    }
    record.primaryPrice = mechanism.primaryPrice(record, this.state.config, this.openingReference())
    this.seedTraderBots(record, mechanism.usesAuction)
    this.state.years[year] = record
    this.state.phase = 'cap'
  }

  /**
   * Pure-trader bots get no free allocation, so under a mode with no primary auction
   * they would have nothing to quote asks against (shorting is not allowed) and the
   * book would be one-sided. Sell them an opening inventory at the reference price —
   * the same way they fund their book at the auction — so their P&L stays comparable
   * to a student's. Only in the first game year; after that they carry inventory
   * through `bankedCredits` like everyone else.
   */
  private seedTraderBots(record: YearRecord, usesAuction: boolean) {
    // Under auctioning the seed cannot be handed out here: `closeCapStage` REPLACES
    // `regulatorGranted` with the auction result, so anything written now is discarded a
    // moment later. `seedTradersAfterAuction` does it on the other side of the clearing.
    if (usesAuction || record.year !== this.state.config.emissions.firstGameYear) return
    if (!(record.primaryPrice && record.primaryPrice > 0)) return
    const classFree = Object.values(record.freeAllocation).reduce((a, b) => a + b, 0)
    for (const player of this.state.players) {
      if (!isPureTrader(player)) continue
      const { marketMakerFrac, speculatorFlat } = this.state.config.bots.seed
      const seed = player.botType === 'marketMaker' ? marketMakerFrac * classFree : speculatorFlat
      if (seed > 0) record.regulatorGranted[player.id] = round1(seed)
    }
  }

  /**
   * The same opening book, for auctioning — added AFTER the auction has cleared so it
   * survives, and ON TOP of whatever the trader won there.
   *
   * Sized off the auction pool because the free allocation is zero in this mode, and priced
   * at the clearing price by the settlement that follows, so the trader buys its book rather
   * than being given one.
   */
  private seedTradersAfterAuction(record: YearRecord) {
    const { marketMakerFrac, speculatorFlat, underAuction } = this.state.config.bots.seed
    if (!underAuction || record.year !== this.state.config.emissions.firstGameYear) return
    for (const player of this.state.players) {
      if (!isPureTrader(player)) continue
      const seed =
        player.botType === 'marketMaker' ? marketMakerFrac * record.regulatorPool : speculatorFlat
      if (seed > 0) {
        record.regulatorGranted[player.id] = round1(
          (record.regulatorGranted[player.id] ?? 0) + seed,
        )
      }
    }
  }

  closeCapStage() {
    this.requirePhase('cap')
    const record = this.currentYearRecord()!
    if (this.mechanism.usesAuction) {
      // Sealed-bid uniform-price auction: highest bidders win the fixed supply,
      // everyone pays the single clearing price.
      const { clearingPrice, awarded } = clearAuction(record.auctionBid, record.regulatorPool)
      record.regulatorGranted = awarded
      record.auctionPrice = clearingPrice
      record.primaryPrice = clearingPrice
      this.seedTradersAfterAuction(record)
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
    // `realizeYear` draws around `expected × (1 − r)` where `expected` is last year's
    // realized, so it must be handed the INCREMENT, never the standing level — otherwise a
    // company holding 50% capacity would be cut 50% again every year and emit 3% of its
    // baseline by year five. See `incrementalFraction`.
    record.realized = realizeYear(
      this.state.players,
      this.rng,
      record.year,
      Object.fromEntries(
        this.state.players.map((p) => [
          p.id,
          incrementalFraction(p.abatementInForce, p.abatementEmbedded),
        ]),
      ),
      this.state.config.emissions.volatility,
    )
    for (const player of this.state.players) {
      player.emissions[record.year] = record.realized[player.id]
    }
    const held: Record<string, number> = {}
    const purchaseCost: Record<string, number> = {}
    const sellIncome: Record<string, number> = {}
    const abateCost: Record<string, number> = {}
    const optimal: Record<string, number> = {}
    const { penaltyRate } = this.state.config.market
    // Whatever went into regulatorGranted was sold at this price: the auction
    // clearing price, or the reference price for the trader-bot seed. 0 for free credits.
    const capPrice = record.primaryPrice ?? 0
    // The market's volume-weighted average price is the reference for the optimum
    // benchmark. With no trades, fall back to the auction price, then to the last
    // discovered price (the free-allocation modes have no auction), then the penalty.
    const refPrice =
      buildMarketView(record.orders, record.trades).vwap ??
      (record.auctionPrice || this.previousMarketPrice() || penaltyRate)
    for (const player of this.state.players) {
      held[player.id] = this.creditsHeld(player.id)
      const { buyCash, sellCash } = tradedCash(record.trades, player.id)
      const capCost = round1((record.regulatorGranted[player.id] ?? 0) * capPrice)
      purchaseCost[player.id] = round1(capCost + buyCash)
      sellIncome[player.id] = sellCash
      // What the company was charged for capacity bought DURING this year — computed at
      // install (a per-step fee cannot be reconstructed from the levels afterwards) and
      // banked in the record until here, the only place `player.score` moves.
      const abateSpend = round1(record.abatementSpend[player.id] ?? 0)
      abateCost[player.id] = abateSpend
      // Everything the company starts the year holding — the carry included, so the
      // benchmark faces the same debt or surplus the player actually faces. Matches
      // what `creditsHeld` counts, which is what the real cost is measured against.
      const credits = round1(
        (record.freeAllocation[player.id] ?? 0) +
          (record.regulatorGranted[player.id] ?? 0) +
          (record.carriedIn[player.id] ?? 0),
      )
      // This year's emissions are already fixed — capacity was bought a year ago — so the
      // benchmark scores the cover decision alone, and the sunk spend passes through both
      // sides identically. See `optimalYearCost`: the leaderboard measures trading skill.
      optimal[player.id] = optimalYearCost(
        this.plannedFor(player, record.year), credits, abateSpend, refPrice, penaltyRate,
      )
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

  /** Marks the room as alive right now. Called from every socket entry point. */
  touch() {
    this.lastActivity = Date.now()
  }

  endGame() {
    // The carry closes ASYMMETRICALLY, and deliberately so.
    //
    // A leftover SURPLUS is stranded: unsold allowances are simply worth nothing when the
    // scheme ends. They used to be cashed out at the final market price, which made
    // hoarding riskless — you could corner the market, never sell, and still be paid out
    // in full at the end. Worse, `finalReferencePrice` falls back to the PENALTY when no
    // year ever traded, so a dead market monetized inventory at the highest price in the
    // game. Stranding it is what makes an unsold position a real position: if you want the
    // value, you have to find a buyer while the market is open.
    //
    // A leftover DEBT still settles. An obligation does not expire just because the game
    // stopped: the company was fined each year it was short AND still owes the tonnes.
    // Letting the debt evaporate here would make defaulting in the final years free, which
    // is the opposite of the lesson — and would hand the win to whoever defaulted last.
    const finalPrice = this.finalReferencePrice()
    for (const player of this.state.players) {
      if (player.bankedCredits < 0) {
        player.score = round1(player.score - player.bankedCredits * finalPrice)
      }
      // Kept, not zeroed: the final screen should show what was left stranded or owed.
    }
    this.state.phase = 'ended'
    this.endedAt = Date.now()
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
    return this.state.config.market.penaltyRate
  }

  // ---- player actions ----

  /**
   * Cap stage under a mechanism with a primary auction: submit a sealed bid
   * (quantity + max price per credit). Resolved by a uniform-price auction when the
   * cap stage closes.
   */
  submitBid(playerId: string, qty: number, price: number) {
    this.requirePhase('cap')
    if (!this.mechanism.usesAuction) {
      throw new GameError('WRONG_MODE', 'This mode has no cap-stage auction to bid into.')
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
    // Deliberately NO price ceiling here, and `penaltyRate` is NOT one either.
    //
    // Paying the fine does not discharge the obligation: an uncovered tonne is penalised
    // AND carried into next year as a make-good debt (see shared/engine/settlement.ts and
    // the carry into `bankedCredits` below). Defaulting therefore costs the fine *plus*
    // buying the same tonne later, so a rational firm's willingness to pay sits ABOVE
    // `penaltyRate`, not at it. Clamping orders to the penalty would forbid a trade that
    // is genuinely worth making. Where the ceiling actually falls is for the market to
    // discover — and for the simulator to measure.
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
    this.submitOrder(playerId, side, roundedQty, price)
    // After matching, so the reserve reacts to the price that was just discovered rather
    // than to a stale one. Not inside submitOrder: releaseReserve calls that, and this
    // would recurse.
    this.maybeReleaseReserve()
  }

  /**
   * Build an order, match it, and book any reserve fills. The mechanical half of
   * `placeOrder`, split out so the reserve can reach it without the no-shorting gate —
   * `creditsHeld(RESERVE_ID)` is 0 and turns negative after the first fill, so the gate
   * would reject every reserve ask forever.
   */
  private submitOrder(playerId: string, side: OrderSide, qty: number, price: number) {
    const record = this.currentYearRecord()!
    this.orderSeq += 1
    const order: Order = {
      id: nanoid(8),
      playerId,
      side,
      qty,
      remaining: qty,
      price: round1(price),
      status: 'open',
      seq: this.orderSeq,
    }
    const { trades } = matchOrder(record.orders, order, () => nanoid(8), this.blockedPair)
    record.trades.push(...trades)

    // Only the fills just produced — O(fills), never a rescan of the tape, which reaches
    // thousands within a year. Catches both directions: the reserve's own marketable ask,
    // and a player's buy crossing a rung that was already resting.
    for (const t of trades) {
      if (t.sellerId !== RESERVE_ID) continue
      record.reserveReleased = round1(record.reserveReleased + t.qty)
      record.reserveRevenue = round1(record.reserveRevenue + t.qty * t.price)
    }
  }

  /**
   * Offer whatever rungs of the cost containment reserve the current price has unlocked.
   *
   * The trigger is the mean of this year's last few prints — not `bestBid` (one small bid
   * would unlock a rung) and not `lastPrice` (one outlier would, permanently, since the
   * ladder only ratchets one way).
   */
  private maybeReleaseReserve() {
    const cfg = this.state.config.allocation.reserve
    if (!cfg.enabled) return
    const record = this.currentYearRecord()
    if (!record || record.reservePot <= 0) return
    // Nothing has printed this year, so there is no discovered price and no ceiling to
    // defend. Deliberately NOT falling back to last year's price: that would flood the
    // ladder before anyone had traded, and destroy the causal story — the price rose, and
    // THEN the regulator stepped in.
    const price = meanOfLast(record.trades, cfg.triggerTrades)
    if (price === null) return

    const base = round1(record.reservePot / cfg.steps[cfg.steps.length - 1].cumulativeFraction)
    for (const rung of plannedRelease(cfg, base, price, record.reserveCommitted)) {
      record.reserveCommitted = round1(record.reserveCommitted + rung.qty)
      this.submitOrder(RESERVE_ID, 'sell', rung.qty, rung.price)
    }
  }

  /**
   * Two market makers may not trade with each other.
   *
   * Makers quote a narrow band around the same reference price, so with more than one of
   * them they cross constantly — and those prints are not liquidity, they are inventory
   * shuffling between makers at prices that then become the reference every maker quotes
   * from. The class sees volume and a moving price while none of it served an emitter.
   */
  private readonly blockedPair = (a: string, b: string): boolean => {
    const isMaker = (id: string) => this.getPlayer(id)?.botType === 'marketMaker'
    return isMaker(a) && isMaker(b)
  }

  cancelOrder(playerId: string, orderId: string) {
    this.requirePhase('trade')
    const record = this.currentYearRecord()!
    if (!cancelOrder(record.orders, playerId, orderId)) {
      throw new GameError('NO_ORDER', 'Order not found or already closed.')
    }
  }

  /**
   * Trade stage: buy permanent abatement capacity, raising installed capacity to
   * `fraction` of the company's un-abated emissions.
   *
   * Three things a caller must understand:
   *
   *  - **It costs money now and cuts nothing now.** The charge lands this year; the
   *    capacity comes online at the next `openYear`. Investing in the final year is simply
   *    wasted, which is why the client carries an unconditional warning.
   *  - **It only ever goes up.** A request below what is already committed is rejected
   *    rather than clamped: clamping would look like a successful un-install, charge
   *    nothing, and leave the client showing a level the company had already paid for.
   *  - **Every step pays the fee again.** Going 0 → 20% → 50% costs one more retrofit fee
   *    than going straight to 50%.
   *
   * Idempotent when the level is unchanged, and that is not a nicety: the compliance bot
   * calls this on every tick, so without the short-circuit a single bot would pay a dozen
   * fees a year.
   */
  setAbatement(playerId: string, fraction: number) {
    this.requirePhase('trade')
    if (!Number.isFinite(fraction) || fraction < 0) {
      throw new GameError('BAD_ABATE', 'Abatement fraction must be a non-negative number.')
    }
    const player = this.getPlayer(playerId)
    if (!player) throw new GameError('NO_PLAYER', 'Player not found.')
    const record = this.currentYearRecord()!
    // Two decimals, not one. `round1` here meant the stored fraction snapped to 10% steps,
    // which was survivable when the range was 0-100% but leaves only three usable choices
    // once the ceiling is 20% — and it silently contradicted the client's 1% slider.
    const target = Math.round(Math.min(this.abatementLifetimeCap, fraction) * 100) / 100
    const from = player.abatementCommitted
    if (target === from) return
    if (target < from) {
      throw new GameError(
        'ABATE_DOWN',
        `You have already installed ${Math.round(from * 100)}% of abatement capacity. Retrofits are permanent — you can add more, but not take it back.`,
      )
    }
    const cfg = this.state.config.abatement
    const spend = installCost(
      this.unabatedFor(player, record.year),
      from,
      target,
      cfg.sectors[player.industry],
      cfg.fixedCostPerTonneBaseline * this.baselineFor(player),
    )
    player.abatementCommitted = target
    record.abatementInstalled[playerId] = target
    record.abatementSpend[playerId] = round1((record.abatementSpend[playerId] ?? 0) + spend)
  }

  /** The most of its un-abated emissions any company here may ever cut, across the game. */
  get abatementLifetimeCap(): number {
    return Math.max(0, Math.min(1, this.state.config.abatement.lifetimeCap))
  }

  /** The baseline-year emission the retrofit fee is scaled by. Fixed for the whole game. */
  baselineFor(player: Player): number {
    return player.emissions[this.state.config.emissions.baselineYear] ?? 0
  }

  /**
   * The mean this year's emissions are actually drawn around — last year's realized, with
   * whatever capacity came online this morning applied to it.
   *
   * Differs from `expectedEmission` in exactly one case: the year a new install switches
   * on. That is the year every "how many credits do I need?" calculation would otherwise
   * be wrong, in the same direction, for everyone who invested.
   */
  plannedEmission(playerId: string): number {
    const player = this.getPlayer(playerId)
    if (!player) return 0
    return this.plannedFor(player, this.state.currentYear ?? this.state.config.emissions.firstGameYear)
  }

  plannedFor(player: Player, year: number): number {
    const expected = expectedEmission(player, year)
    return round1(expected * (1 - incrementalFraction(player.abatementInForce, player.abatementEmbedded)))
  }

  /**
   * Emissions stripped of the cuts already in them — the base every fraction in this model
   * is a fraction of, and the base an install is sized and priced against.
   */
  unabatedEmission(playerId: string): number {
    const player = this.getPlayer(playerId)
    if (!player) return 0
    return this.unabatedFor(player, this.state.currentYear ?? this.state.config.emissions.firstGameYear)
  }

  unabatedFor(player: Player, year: number): number {
    return round1(unabatedFrom(this.plannedFor(player, year), player.abatementInForce))
  }

  /** The retrofit fee this company pays per install step. */
  abatementFixedCost(playerId: string): number {
    const player = this.getPlayer(playerId)
    if (!player) return 0
    return round1(this.state.config.abatement.fixedCostPerTonneBaseline * this.baselineFor(player))
  }

  getPlayer(playerId: string): Player | undefined {
    return this.state.players.find((p) => p.id === playerId)
  }
}

export class SessionStore {
  private byCode = new Map<string, Session>()

  create(capMode: CapMode, seed?: number, override?: DeepPartial<GameConfig>): Session {
    const session = new Session(capMode, seed, override)
    this.byCode.set(session.state.roomCode, session)
    return session
  }

  get(roomCode: string): Session | undefined {
    return this.byCode.get(roomCode.toUpperCase())
  }

  /**
   * Rooms worth ticking. Finished games and rooms with no bots are skipped — the driver
   * used to walk every session ever created, forever.
   */
  activeSessions(): Session[] {
    const out: Session[] = []
    for (const session of this.byCode.values()) {
      if (session.state.phase === 'ended') continue
      if (!session.state.players.some((p) => p.isBot)) continue
      out.push(session)
    }
    return out
  }

  /**
   * Drops finished and abandoned rooms, returning the codes removed so the caller can
   * discard whatever it keyed by them. Nothing ever removed a session before this, so a
   * long-lived server leaked one full Session — every year's orders and trades — per class.
   */
  sweep(now = Date.now()): string[] {
    const dropped: string[] = []
    for (const [code, session] of this.byCode) {
      const { endedGraceMs, idleTtlMs } = session.state.config.session
      const finished = session.endedAt !== null && now - session.endedAt > endedGraceMs
      const abandoned =
        !session.state.players.some((p) => p.connected && !p.isBot) &&
        now - session.lastActivity > idleTtlMs
      if (finished || abandoned) {
        this.byCode.delete(code)
        dropped.push(code)
      }
    }
    return dropped
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
