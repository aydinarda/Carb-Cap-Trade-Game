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

function opened(mode: 'grandfathering' | 'benchmarking' | 'auctioning', over = RESERVE_ON) {
  const s = new Session(mode, 4, over)
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

  it('is ZERO under auctioning at the shipped ratio, and stays inert all year', () => {
    // auctionCapRatio 1.0 issues supply equal to need, so there is no shortfall to relieve.
    // This is the correct answer, not a wiring bug — pinned so it cannot rot into one.
    const s = opened('auctioning')
    const rec = s.currentYearRecord()!
    expect(rec.reservePot).toBe(0)

    printAt(s, RUNG[RUNG.length - 1] + 15) // far above every rung
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
    const s = new Session('benchmarking', 4, RESERVE_ON)
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
  it('posts nothing at all when disabled, however high the price goes', () => {
    const s = opened('benchmarking', { allocation: { reserve: { enabled: false } } })
    // Still SIZED — the pot is computed either way, so enabling it is a pure flip.
    expect(s.currentYearRecord()!.reservePot).toBeGreaterThan(0)
    printAt(s, RUNG[RUNG.length - 1] + 15)
    expect(s.currentYearRecord()!.orders.some((o) => o.playerId === RESERVE_ID)).toBe(false)
    expect(s.currentYearRecord()!.reserveReleased).toBe(0)
  })
})
