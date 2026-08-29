import { describe, expect, it } from 'vitest'
import { DEFAULT_GAME_CONFIG } from '../../config'
import type { ReserveConfig } from '../../config/schema'
import { plannedRecurring, plannedRelease, reserveBase, reservePot } from '../reserve'

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
