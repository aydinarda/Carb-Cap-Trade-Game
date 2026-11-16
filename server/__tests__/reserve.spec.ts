import { describe, expect, it } from 'vitest'
import { RESERVE_ID } from '../../shared/constants'
import type { DeepPartial, GameConfig } from '../../shared/config'
import { DEFAULT_GAME_CONFIG } from '../../shared/config'
import { GameError, Session } from '../session'

/** The shipped ladder's rung prices — read, never hardcoded, so retuning cannot break these. */
const RUNG = DEFAULT_GAME_CONFIG.allocation.reserve.steps.map((s) => s.triggerPrice)
/** Comfortably inside the first rung's band, and comfortably below it. */
const AT_RUNG1 = RUNG[0] + 1
const BELOW_RUNG1 = RUNG[0] - 15

/**
 * Cost containment reserve, at the session level: the ladder wired to the order book.
 *
 * The ladder's own arithmetic is proven without a game in
 * `shared/engine/__tests__/reserve.spec.ts`; what is asserted here is the wiring — that it
 * reaches the book, that its fills are booked to nobody, and that it stays out of the way
 * when it should.
 */

const RESERVE_ON: DeepPartial<GameConfig> = { allocation: { reserve: { enabled: true } } }

/**
 * A deliberately SHORT class, on top of whatever else a test asks for.
 *
 * The shipped calibration opens every regime at roughly the class's full need — scarcity is
 * built by the yearly cap reduction, not handed out in year one — so at the defaults the
 * shortfall the reserve sizes itself from is zero and the ladder never arms. That is correct
 * behaviour, and it is pinned on its own below; but it leaves the wiring tests here with
 * nothing to exercise. Every test that needs a live ladder gets a tight opening supply.
 */
const SHORT: DeepPartial<GameConfig> = {
  allocation: {
    freeCreditRatio: 0.5,
    benchmark: { 'Power & Utilities': 500, 'Heavy Materials': 400,
                 'Manufacturing & Chemicals': 260, Transport: 150 },
    auctionCapRatio: 0.5,
  },
}

function merge(...parts: DeepPartial<GameConfig>[]): DeepPartial<GameConfig> {
  const out: DeepPartial<GameConfig> = {}
  for (const p of parts) {
    out.allocation = { ...out.allocation, ...p.allocation }
    if (p.allocation?.reserve) {
      out.allocation.reserve = { ...out.allocation?.reserve, ...p.allocation.reserve }
    }
  }
  return out
}

function opened(mode: 'grandfathering' | 'benchmarking' | 'auctioning', over = RESERVE_ON) {
  const s = new Session(mode, 4, merge(SHORT, over))
  s.addPlayer('Alice', 'Power & Utilities') // P1
  s.addPlayer('Bob', 'Heavy Materials') // P2
  s.addPlayer('Cara', 'Transport') // P3
  s.startYear()
  // Auctioning hands out nothing for free, so P1 would have nothing to sell with. Buy it
  // an inventory at the cap stage the way a real player would.
  if (mode === 'auctioning') s.submitBid('P1', 800, 40)
  s.closeCapStage()
  s.openTrade()
  return s
}

/**
 * Print trades at `price` until the reserve's trigger — the mean of the last
 * `triggerTrades` prints — actually reaches it.
 *
 * One print is deliberately not enough: a moving average is what stops a single outlier
 * unlocking a rung permanently, so a test that moves the ladder has to move the average.
 */
function printAt(s: Session, price: number, times = 6, qty = 2) {
  for (let i = 0; i < times; i++) {
    s.placeOrder('P1', 'sell', qty, price)
    s.placeOrder('P2', 'buy', qty, price)
  }
}

describe('reserve — the pot', () => {
  it('is a share of the opening shortfall under a free-allocation mode', () => {
    const s = opened('benchmarking')
    const rec = s.currentYearRecord()!
    expect(rec.reservePot).toBeGreaterThan(0)
    expect(rec.reserveReleased).toBe(0)
    expect(rec.reserveCommitted).toBe(0)
  })

  it('is ZERO when issuance already meets need, and its ladder stays inert all year', () => {
    // A ratio of 1.0 issues supply equal to need, so there is no shortfall to relieve. This
    // is the correct answer, not a wiring bug — pinned so it cannot rot into one.
    //
    // Pinned explicitly rather than inherited: the shipped ratio is now 0.95, which DOES
    // open a small shortfall, so relying on the default would silently stop testing this.
    const s = opened('auctioning', merge(RESERVE_ON, { allocation: { auctionCapRatio: 1 } }))
    const rec = s.currentYearRecord()!
    expect(rec.reservePot).toBe(0)

    printAt(s, RUNG[RUNG.length - 1] + 15) // far above every rung of the pot's ladder
    expect(rec.orders.some((o) => o.playerId === RESERVE_ID)).toBe(false)
    expect(rec.reserveReleased).toBe(0)
  })

  it("basis 'need' arms it even where the shortfall is zero", () => {
    const s = opened('auctioning', {
      allocation: { reserve: { enabled: true, basis: 'need' } },
    })
    expect(s.currentYearRecord()!.reservePot).toBeGreaterThan(0)
  })
})

describe('reserve — the ladder in the book', () => {
  it('offers nothing below the first rung', () => {
    const s = opened('benchmarking')
    printAt(s, BELOW_RUNG1)
    expect(s.currentYearRecord()!.orders.some((o) => o.playerId === RESERVE_ID)).toBe(false)
  })

  it('rests an ask once the price reaches a rung, and only once', () => {
    const s = opened('benchmarking')
    printAt(s, AT_RUNG1)
    const rec = s.currentYearRecord()!
    const own = () => rec.orders.filter((o) => o.playerId === RESERVE_ID)
    expect(own()).toHaveLength(1)
    expect(own()[0].price).toBe(RUNG[0])
    expect(own()[0].side).toBe('sell')
    const committed = rec.reserveCommitted
    expect(committed).toBeGreaterThan(0)

    // More prints at the same level must not re-post the rung.
    printAt(s, AT_RUNG1)
    expect(own()).toHaveLength(1)
    expect(rec.reserveCommitted).toBe(committed)
  })

  it('holds the price at its rung until that rung is exhausted', () => {
    // The rung is the cheapest ask in the book, so every buy above it prints AT it. The
    // reserve's own fills then drag the trigger average back down — which is why the next
    // rung cannot open while this one still has size. The ceiling enforces itself.
    const s = opened('benchmarking')
    const rec = s.currentYearRecord()!
    printAt(s, AT_RUNG1)
    printAt(s, RUNG[1] + 1) // buyers reaching for the next rung…
    expect(rec.trades.slice(-5).every((t) => t.price === RUNG[0])).toBe(true) // …still pay rung 1
    expect(rec.orders.filter((o) => o.playerId === RESERVE_ID).map((o) => o.price)).toEqual([RUNG[0]])
  })

  it('opens the next rung once the first is used up and the price really moves', () => {
    const s = opened('benchmarking')
    const rec = s.currentYearRecord()!
    const rungs = () =>
      rec.orders
        .filter((o) => o.playerId === RESERVE_ID)
        .map((o) => o.price)
        .sort((a, b) => a - b)
    printAt(s, AT_RUNG1)
    // Sweep the whole first rung, then let the market print above 62 on its own.
    s.placeOrder('P3', 'buy', 400, RUNG[1] + 1)
    expect(rec.orders.filter((o) => o.playerId === RESERVE_ID && o.remaining > 0)).toHaveLength(0)
    printAt(s, RUNG[1] + 1)
    expect(rungs()).toEqual([RUNG[0], RUNG[1]])
  })
})

describe('reserve — fills', () => {
  it('sells into a resting bid and books the proceeds to nobody', () => {
    const s = opened('benchmarking')
    const rec = s.currentYearRecord()!
    printAt(s, AT_RUNG1) // arms the €55 rung

    // P3 bids above the rung: the reserve's ask is already resting, so P3's buy crosses it.
    const before = rec.reserveReleased
    s.placeOrder('P3', 'buy', 5, RUNG[0] + 3)
    expect(rec.reserveReleased).toBeGreaterThan(before)
    expect(rec.reserveRevenue).toBeGreaterThan(0)

    s.closeTrade()
    // The reserve is not a player, so nothing it sold shows up as anyone's sell income.
    const settlement = rec.settlement!
    expect(Object.keys(settlement)).toEqual(['P1', 'P2', 'P3'])
    const classSellIncome = Object.values(settlement).reduce((t, x) => t + x.sellIncome, 0)
    const p1p2Sales = rec.trades
      .filter((t) => t.sellerId === 'P1' || t.sellerId === 'P2' || t.sellerId === 'P3')
      .reduce((t, x) => t + x.qty * x.price, 0)
    expect(classSellIncome).toBeCloseTo(p1p2Sales, 0)
  })

  it('never sells below its rung price, but takes price improvement above it', () => {
    const s = opened('benchmarking')
    const rec = s.currentYearRecord()!
    // A bid resting ABOVE the rung when the rung is posted: matchOrder executes at the
    // RESTING price, so the reserve gets the buyer's already-revealed higher willingness
    // to pay. The invariant is "never below the rung", not "always exactly at it".
    s.placeOrder('P3', 'buy', 4, RUNG[0] + 5)
    printAt(s, AT_RUNG1)
    const fills = rec.trades.filter((t) => t.sellerId === RESERVE_ID)
    expect(fills.length).toBeGreaterThan(0)
    for (const f of fills) expect(f.price).toBeGreaterThanOrEqual(RUNG[0])
    expect(fills.some((f) => f.price === RUNG[0] + 5)).toBe(true)
  })

  it('grows the circulating cap by exactly what it sold, and not by what it merely offered', () => {
    const s = opened('benchmarking')
    const rec = s.currentYearRecord()!
    const capBefore = s.circulatingCap()
    printAt(s, AT_RUNG1)
    // The rung rests AND partly fills, so both numbers move — together, by the same amount.
    expect(s.circulatingCap() - capBefore).toBeCloseTo(rec.reserveReleased, 5)
    expect(rec.reserveCommitted).toBeGreaterThan(rec.reserveReleased) // the rest is still on offer

    const capMid = s.circulatingCap()
    const soldMid = rec.reserveReleased
    s.placeOrder('P3', 'buy', 5, RUNG[0] + 3)
    expect(s.circulatingCap() - capMid).toBeCloseTo(rec.reserveReleased - soldMid, 5)
  })
})

describe('reserve — identity', () => {
  it('cannot be driven through placeOrder — releaseReserve is the only path', () => {
    const s = opened('benchmarking')
    // creditsHeld(RESERVE_ID) is 0, so the no-shorting gate rejects it. This is exactly why
    // the release path bypasses placeOrder.
    expect(() => s.placeOrder(RESERVE_ID, 'sell', 10, RUNG[0])).toThrow(GameError)
  })

  it('is not a player, so it never reaches the roster or settlement', () => {
    const s = opened('benchmarking')
    printAt(s, AT_RUNG1)
    s.placeOrder('P3', 'buy', 5, RUNG[0] + 3)
    expect(s.getPlayer(RESERVE_ID)).toBeUndefined()
    expect(s.state.players.map((p) => p.id)).toEqual(['P1', 'P2', 'P3'])
    s.closeTrade()
    expect(s.currentYearRecord()!.settlement![RESERVE_ID]).toBeUndefined()
  })

  it('a market maker may buy from it — blockedPair only vetoes maker-to-maker', () => {
    // Builds its own session rather than going through `opened`, so it has to ask for the
    // short class explicitly — at the shipped calibration there is no shortfall to arm on.
    const s = new Session('benchmarking', 4, merge(SHORT, RESERVE_ON))
    const mm = s.addBot('marketMaker')
    s.addPlayer('Alice', 'Power & Utilities') // P2
    s.addPlayer('Bob', 'Heavy Materials') // P3
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    for (let i = 0; i < 6; i++) {
      s.placeOrder('P2', 'sell', 2, AT_RUNG1)
      s.placeOrder('P3', 'buy', 2, AT_RUNG1)
    } // arms the first rung
    const rec = s.currentYearRecord()!
    expect(rec.orders.some((o) => o.playerId === RESERVE_ID)).toBe(true)

    s.placeOrder(mm.id, 'buy', 3, RUNG[0] + 3)
    expect(rec.trades.some((t) => t.sellerId === RESERVE_ID && t.buyerId === mm.id)).toBe(true)
  })
})

describe('reserve — the off switch', () => {
  it('posts nothing from the pot when disabled, however high the price goes below the open ladder', () => {
    const s = opened('benchmarking', { allocation: { reserve: { enabled: false } } })
    // Still SIZED — the pot is computed either way, so enabling it is a pure flip.
    expect(s.currentYearRecord()!.reservePot).toBeGreaterThan(0)
    printAt(s, RUNG[RUNG.length - 1] + 15)
    expect(s.currentYearRecord()!.orders.some((o) => o.playerId === RESERVE_ID)).toBe(false)
    expect(s.currentYearRecord()!.reserveReleased).toBe(0)
  })
})

/**
 * The open-ended ladder above the fine (`reserve.openLadder`): outside the pot, every round.
 *
 * `auctionCapRatio` 1 on purpose: issuance meets need, so the pot is ZERO — the state almost
 * every above-the-fine year is in. The ladder must work exactly there.
 */
describe('reserve — the open ladder above the fine', () => {
  const NO_POT = merge(RESERVE_ON, { allocation: { auctionCapRatio: 1 } })
  const LADDER = DEFAULT_GAME_CONFIG.allocation.reserve.openLadder
  const own = (s: Session) =>
    s.currentYearRecord()!.orders.filter((o) => o.playerId === RESERVE_ID).sort((a, b) => a.price - b.price)

  it('is offered in a year whose pot is zero, sized off that year\'s issuance', () => {
    const s = opened('auctioning', NO_POT)
    const rec = s.currentYearRecord()!
    expect(rec.reservePot).toBe(0)
    printAt(s, LADDER.fromPrice - 5)
    expect(own(s)).toHaveLength(0)

    printAt(s, LADDER.fromPrice + 1)
    expect(own(s).map((o) => o.price)).toEqual([LADDER.fromPrice])
    expect(own(s)[0].side).toBe('sell')
    expect(own(s)[0].qty).toBe(Math.round(rec.regulatorPool * LADDER.fraction * 10) / 10)
    expect(rec.reserveLadderRungs).toBe(1)
  })

  it('offers each rung once a round, and the next one only when the price gets there', () => {
    const s = opened('auctioning', NO_POT)
    const rec = s.currentYearRecord()!
    printAt(s, LADDER.fromPrice + 1)
    printAt(s, LADDER.fromPrice + 1) // more prints at the same level: nothing new
    expect(own(s)).toHaveLength(1)

    // Sweep the first rung and every ask left under the next one, then let the market print a
    // step higher on its own.
    s.placeOrder('P3', 'buy', 5000, LADDER.fromPrice + LADDER.step + 1)
    expect(own(s)[0].remaining).toBe(0)
    printAt(s, LADDER.fromPrice + LADDER.step + 1)
    expect(own(s).map((o) => o.price)).toEqual([LADDER.fromPrice, LADDER.fromPrice + LADDER.step])
    expect(rec.reserveLadderRungs).toBe(2)
    // The higher rung offers more: one `increment` of the issuance on top of the first.
    const share = (f: number) => Math.round(rec.regulatorPool * f * 10) / 10
    expect(own(s).map((o) => o.qty)).toEqual([share(LADDER.fraction), share(LADDER.fraction + LADDER.increment)])
    expect(LADDER.increment).toBeGreaterThan(0)
    expect(rec.reserveReleased).toBeGreaterThan(0)
  })

  it('starts again the next round', () => {
    const s = opened('auctioning', NO_POT)
    printAt(s, LADDER.fromPrice + 1)
    expect(s.currentYearRecord()!.reserveLadderRungs).toBe(1)
    s.closeTrade()
    s.advanceYear()
    s.submitBid('P1', 1500, 500) // above the auction's reserve price, enough to clear its debt
    s.closeCapStage()
    s.openTrade()
    expect(s.currentYearRecord()!.reserveLadderRungs).toBe(0)
    printAt(s, LADDER.fromPrice + 1)
    expect(own(s).map((o) => o.price)).toEqual([LADDER.fromPrice])
  })

  it('works next to the pot\'s own ladder, and neither counts the other', () => {
    const s = opened('benchmarking')
    const rec = s.currentYearRecord()!
    expect(rec.reservePot).toBeGreaterThan(0)
    printAt(s, AT_RUNG1)
    const committed = rec.reserveCommitted
    expect(rec.reserveLadderRungs).toBe(0)
    expect(committed).toBeGreaterThan(0)
  })

  it('is off at fraction 0', () => {
    const none = opened('auctioning', merge(NO_POT, { allocation: { reserve: { openLadder: { fraction: 0 } } } }))
    printAt(none, LADDER.fromPrice + 25)
    expect(own(none)).toHaveLength(0)
  })

  it("keeps running when the host switches the reserve off: the switch stops the pot only", () => {
    // 2026-11-16: with the ladder stopped too, the leaderboard exploit came back (14% of games
    // above 1,000 points with the 20 shipped agents).
    // The host's switch writes exactly this (`updateSettings({ reserveEnabled: false })`).
    const s = opened('benchmarking', { allocation: { reserve: { enabled: false } } })
    const rec = s.currentYearRecord()!
    expect(rec.reservePot).toBeGreaterThan(0) // there IS a pot, and it must stay silent
    printAt(s, LADDER.fromPrice + LADDER.step + 1)
    const prices = own(s).map((o) => o.price)
    expect(prices.every((p) => p >= LADDER.fromPrice)).toBe(true) // nothing from the pot's 65–85 rungs
    expect(prices).toContain(LADDER.fromPrice)
    expect(rec.reserveCommitted).toBe(0)
    expect(rec.reserveRecurringDone).toBe(false)
  })

  it('the host switch sets only the pot\'s flag', () => {
    const s = new Session('hybrid', 1)
    s.updateSettings({ reserveEnabled: false })
    expect(s.state.config.allocation.reserve.enabled).toBe(false)
    expect(s.state.config.allocation.reserve.openLadder.fraction).toBe(LADDER.fraction)
  })

  it('refuses a ladder that could not be posted', () => {
    const bad = (openLadder: Partial<typeof LADDER>) => () => new Session('auctioning', 1, { allocation: { reserve: { openLadder } } })
    expect(bad({ step: 0.5 })).toThrow(/openLadder.step/)
    expect(bad({ fromPrice: 0 })).toThrow(/openLadder.fromPrice/)
    expect(bad({ fraction: 1.5 })).toThrow(/openLadder.fraction/)
    expect(bad({ increment: -0.01 })).toThrow(/openLadder.increment/)
  })
})
