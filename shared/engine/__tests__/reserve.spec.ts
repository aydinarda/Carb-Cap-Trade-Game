import { describe, expect, it } from 'vitest'
import { DEFAULT_GAME_CONFIG } from '../../config'
import type { ReserveConfig } from '../../config/schema'
import {
  OPEN_LADDER_MAX_RUNGS,
  plannedOpenLadder,
  plannedRecurring,
  plannedRelease,
  reserveBase,
  reservePot,
} from '../reserve'

/** The shipped ladder, forced on. Thresholds are read from it, never assumed. */
const CFG: ReserveConfig = {
  ...DEFAULT_GAME_CONFIG.allocation.reserve,
  enabled: true,
}
const BASE = 1000 // so a fraction reads directly as a quantity
// Derived from the configured ladder, never hardcoded: these assertions are about the
// mechanism, and must survive the thresholds being retuned.
const RUNG = CFG.steps.map((st) => st.triggerPrice)
const CUM = CFG.steps.map((st) => st.cumulativeFraction)
const qtyOf = (i: number) => round1(BASE * (CUM[i] - (i === 0 ? 0 : CUM[i - 1])))
const round1 = (x: number) => Math.round(x * 10) / 10

const total = (rows: { qty: number }[]) => rows.reduce((s, r) => s + r.qty, 0)

describe('reserveBase', () => {
  it('shortfall is need minus issuance, floored at zero', () => {
    expect(reserveBase(CFG, 2000, 1200)).toBe(800)
    // Auctioning at auctionCapRatio 1.0: supply equals need, so there is nothing to relieve.
    expect(reserveBase(CFG, 2000, 2000)).toBe(0)
    expect(reserveBase(CFG, 2000, 2600)).toBe(0) // a glut is not a negative shortfall
  })

  it("basis 'need' is armed exactly where 'shortfall' is not", () => {
    const needCfg: ReserveConfig = { ...CFG, basis: 'need' }
    expect(reserveBase(CFG, 2000, 2000)).toBe(0)
    expect(reserveBase(needCfg, 2000, 2000)).toBe(2000)
  })
})

describe('reservePot', () => {
  it('is the top rung, so there is no second size knob to contradict the ladder', () => {
    expect(reservePot(CFG, BASE)).toBe(round1(BASE * CUM[CUM.length - 1]))
  })
})

describe('plannedRelease', () => {
  it('is inert below the first rung', () => {
    expect(plannedRelease(CFG, BASE, RUNG[0] - 0.1, 0)).toEqual([])
  })

  it('opens one rung at a time, each priced at its own trigger', () => {
    let committed = 0
    CFG.steps.forEach((_, i) => {
      expect(plannedRelease(CFG, BASE, RUNG[i], committed)).toEqual([
        { price: RUNG[i], qty: qtyOf(i) },
      ])
      committed = round1(committed + qtyOf(i))
    })
  })

  it('posts the whole ladder as separate rungs when the price jumps past them', () => {
    // The point of a ladder: separate rungs, NOT one lump at the top.
    const rows = plannedRelease(CFG, BASE, RUNG[RUNG.length - 1] + 5, 0)
    expect(rows).toEqual(CFG.steps.map((_, i) => ({ price: RUNG[i], qty: qtyOf(i) })))
    expect(total(rows)).toBe(reservePot(CFG, BASE))
  })

  it('respects the cumulative ceiling — the pot is never exceeded', () => {
    const pot = reservePot(CFG, BASE)
    expect(total(plannedRelease(CFG, BASE, 999, 0))).toBeCloseTo(pot, 5)
    expect(plannedRelease(CFG, BASE, 999, pot)).toEqual([])
  })

  it('is idempotent, which is what gives hysteresis', () => {
    const above = RUNG[0] + 1
    const below = RUNG[0] - 1
    const first = plannedRelease(CFG, BASE, above, 0)
    expect(first).toEqual([{ price: RUNG[0], qty: qtyOf(0) }])
    // Same price, same commitment → nothing more. And a dip below the rung and back up
    // releases nothing the second time.
    expect(plannedRelease(CFG, BASE, above, qtyOf(0))).toEqual([])
    expect(plannedRelease(CFG, BASE, below, qtyOf(0))).toEqual([])
    expect(plannedRelease(CFG, BASE, above, qtyOf(0))).toEqual([])
  })

  it('does nothing with an empty pot, at any price', () => {
    for (const price of [RUNG[0] - 10, RUNG[0], RUNG[1], RUNG[RUNG.length - 1] + 20]) {
      expect(plannedRelease(CFG, 0, price, 0)).toEqual([])
    }
  })

  it('does nothing when disabled', () => {
    expect(plannedRelease({ ...CFG, enabled: false }, BASE, 999, 0)).toEqual([])
  })

  it('tops up correctly when a rung was only partly committed', () => {
    // Part of the first rung already committed → only the remainder is still owed.
    const part = round1(qtyOf(0) / 4)
    expect(plannedRelease(CFG, BASE, RUNG[0], part)).toEqual([
      { price: RUNG[0], qty: round1(qtyOf(0) - part) },
    ])
  })
})

describe('the repeating top-up', () => {
  const cfg = (over: Partial<ReserveConfig> = {}): ReserveConfig => ({
    enabled: true,
    basis: 'shortfall',
    triggerTrades: 5,
    steps: [
      { triggerPrice: 65, cumulativeFraction: 0.1 },
      { triggerPrice: 70, cumulativeFraction: 0.2 },
    ],
    recurring: { fromPrice: 78, offers: [{ price: 78, fraction: 0.05 }, { price: 85, fraction: 0.05 }] },
    openLadder: { fromPrice: 110, step: 10, fraction: 0.01, increment: 0.01 },
    ...over,
  })

  it('offers nothing below its trigger', () => {
    expect(plannedRecurring(cfg(), 1000, 77.9)).toEqual([])
  })

  it('offers every listed slice once the price is past it', () => {
    expect(plannedRecurring(cfg(), 1000, 78)).toEqual([
      { price: 78, qty: 50 },
      { price: 85, qty: 50 },
    ])
  })

  it('does NOT share the ladder accumulator — a spent ladder still tops up', () => {
    // The ladder is one-way and finite; the top-up is the relief that keeps arriving. If the
    // two shared a running total the exhausted ladder would swallow it.
    const spent = plannedRelease(cfg(), 1000, 90, 200) // ladder fully released
    expect(spent).toEqual([])
    expect(plannedRecurring(cfg(), 1000, 90)).toHaveLength(2)
  })

  it('is inert when disabled or given no offers', () => {
    expect(plannedRecurring(cfg({ enabled: false }), 1000, 90)).toEqual([])
    expect(plannedRecurring(cfg({ recurring: { fromPrice: 78, offers: [] } }), 1000, 90)).toEqual([])
  })

  it('is inert when there is no pot to draw on', () => {
    expect(plannedRecurring(cfg(), 0, 90)).toEqual([])
  })
})

describe('the open-ended ladder above the fine', () => {
  const cfg = (over: Partial<ReserveConfig['openLadder']> = {}, enabled = true): ReserveConfig => ({
    ...CFG,
    enabled,
    // Flat unless a test asks for growth, so a rung's size reads straight off `fraction`.
    openLadder: { fromPrice: 110, step: 10, fraction: 0.01, increment: 0, ...over },
  })
  const ISSUANCE = 20000 // 1% of it is 200

  it('offers nothing below its first rung', () => {
    expect(plannedOpenLadder(cfg(), ISSUANCE, 109.9, 0)).toEqual([])
  })

  it('offers a share of the ISSUANCE at the rung the price reached', () => {
    expect(plannedOpenLadder(cfg(), ISSUANCE, 110, 0)).toEqual([{ price: 110, qty: 200 }])
    expect(plannedOpenLadder(cfg({ fraction: 0.025 }), ISSUANCE, 119.9, 0)).toEqual([{ price: 110, qty: 500 }])
  })

  it('posts every rung a jump passed, each at its own price', () => {
    expect(plannedOpenLadder(cfg(), ISSUANCE, 135, 0)).toEqual([
      { price: 110, qty: 200 },
      { price: 120, qty: 200 },
      { price: 130, qty: 200 },
    ])
  })

  it('offers MORE the higher the price: each rung adds `increment` to the share', () => {
    const grow = cfg({ increment: 0.01 })
    expect(plannedOpenLadder(grow, ISSUANCE, 135, 0)).toEqual([
      { price: 110, qty: 200 }, // 1%
      { price: 120, qty: 400 }, // 2%
      { price: 130, qty: 600 }, // 3%
    ])
    // A rung keeps its own size whenever it is posted.
    expect(plannedOpenLadder(grow, ISSUANCE, 135, 2)).toEqual([{ price: 130, qty: 600 }])
    expect(plannedOpenLadder(cfg({ fraction: 0.02, increment: 0.005 }), ISSUANCE, 125, 0).map((r) => r.qty)).toEqual([400, 500])
    // Never more than everything issued, however far up it goes.
    const far = plannedOpenLadder(cfg({ increment: 0.5 }), ISSUANCE, 160, 0).map((r) => r.qty)
    expect(far).toEqual([200, 10200, 20000, 20000, 20000, 20000])
  })

  it('the shipped ladder grows', () => {
    const shipped = plannedOpenLadder(CFG, ISSUANCE, CFG.openLadder.fromPrice + 2 * CFG.openLadder.step, 0)
    expect(shipped).toHaveLength(3)
    expect(shipped[1].qty).toBeGreaterThan(shipped[0].qty)
    expect(shipped[2].qty).toBeGreaterThan(shipped[1].qty)
  })

  it('offers a rung once a round: the ones already posted are skipped', () => {
    expect(plannedOpenLadder(cfg(), ISSUANCE, 135, 2)).toEqual([{ price: 130, qty: 200 }])
    expect(plannedOpenLadder(cfg(), ISSUANCE, 135, 3)).toEqual([])
    // The price falling back and returning does not re-post a rung.
    expect(plannedOpenLadder(cfg(), ISSUANCE, 112, 3)).toEqual([])
  })

  it('has no top: the rungs go on every step', () => {
    const rungs = plannedOpenLadder(cfg(), ISSUANCE, 460, 0)
    expect(rungs).toHaveLength(36) // 110, 120, …, 460
    expect(rungs[rungs.length - 1].price).toBe(460)
    expect(plannedOpenLadder(cfg({ step: 25 }), ISSUANCE, 190, 0).map((r) => r.price)).toEqual([110, 135, 160, 185])
  })

  it('is bounded against an absurd print', () => {
    expect(plannedOpenLadder(cfg(), ISSUANCE, 1e9, 0)).toHaveLength(OPEN_LADDER_MAX_RUNGS)
    expect(plannedOpenLadder(cfg(), ISSUANCE, 1e9, OPEN_LADDER_MAX_RUNGS)).toEqual([])
  })

  it('is inert when disabled, at fraction 0, or with nothing issued', () => {
    expect(plannedOpenLadder(cfg({}, false), ISSUANCE, 150, 0)).toEqual([])
    expect(plannedOpenLadder(cfg({ fraction: 0 }), ISSUANCE, 150, 0)).toEqual([])
    expect(plannedOpenLadder(cfg(), 0, 150, 0)).toEqual([])
  })
})
