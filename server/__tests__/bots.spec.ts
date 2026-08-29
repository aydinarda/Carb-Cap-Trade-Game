import { describe, expect, it } from 'vitest'
import {
  buildMarketView,
  createRng,
  expectedEmission,
  openSellRemaining,
  round1,
} from '../../shared/engine'
import * as compliance from '../bots/compliance'
import * as marketMaker from '../bots/marketMaker'
import * as noise from '../bots/noise'
import * as speculator from '../bots/speculator'
import { botAvgCost, disperse, priceCeiling, referencePrice, sellCapacity } from '../bots/helpers'
import { Session } from '../session'
import type { BotCtx, BotRuntime } from '../bots/types'

const ARCHETYPES = { compliance, marketMaker, speculator, noise }

/**
 * `rt` is a parameter so a caller can keep ONE runtime across ticks, the way `BotManager`
 * does. A fresh `{}` per call — the previous behaviour — silently disabled everything the
 * runtime carries: the resting-quote ids, the once-a-year install lock, and the market
 * maker's opening quiet period, which counts ticks and so never advanced past its first.
 */
function ctxFor(s: Session, botId: string, seed = 42, rt: BotRuntime = {}): BotCtx {
  const rec = s.currentYearRecord()
  return {
    session: s,
    bot: s.getPlayer(botId)!,
    rng: createRng(seed),
    rt,
    // stepBots builds this once per tick and shares it; rebuild it here so each call
    // sees the book as it stands right now.
    market: buildMarketView(rec?.orders ?? [], rec?.trades ?? []),
  }
}

/** Ticks the maker past its quiet opening on one persistent runtime, then returns it. */
function warmMaker(s: Session, mmId: string, seed = 42): BotRuntime {
  const rt: BotRuntime = {}
  const quiet = s.state.config.bots.marketMaker.quietTicks
  for (let i = 0; i < quiet; i++) marketMaker.trade(ctxFor(s, mmId, seed, rt))
  return rt
}

describe('bot helpers', () => {
  it('disperse clamps into (0.1, penaltyRate]', () => {
    expect(disperse(10, 0, 20)).toBe(10)
    expect(disperse(100, 0, 20)).toBe(20) // above ceiling → clamped
    expect(disperse(-5, 0, 20)).toBe(0.1) // below floor → clamped
    expect(disperse(10, 0.5, 20)).toBe(15) // +50% bias
  })

  it('referencePrice falls back to the opening anchor before the first auction clears', () => {
    const s = new Session('auctioning', 1)
    s.addPlayer('A', 'Power & Utilities')
    s.startYear() // cap stage — no auction price yet
    // Derived, not restated: the anchor is a calibration knob and has already moved from
    // half the fine to a quarter of it. The RULE — fall back to the anchor — is the invariant.
    const { penaltyRate, openingReferenceFraction } = s.state.config.market
    expect(referencePrice(s)).toBe(penaltyRate * openingReferenceFraction)
  })

  it('referencePrice tracks THIS year\'s auction clearing once it has run', () => {
    // Reserve off: this is about where the reference comes from, not about a price floor.
    const s = new Session('auctioning', 1, { allocation: { auctionReserveFrac: 0 } })
    s.addPlayer('A', 'Power & Utilities')
    s.startYear()
    s.submitBid('P1', 100, 15)
    s.closeCapStage() // auction clears → clearing price is the fresh anchor
    const clearing = s.currentYearRecord()!.auctionPrice!
    expect(clearing).toBeGreaterThan(0)
    expect(referencePrice(s)).toBe(clearing)
  })

  it('sellCapacity = held − open asks; botAvgCost from auction spend', () => {
    const s = new Session('auctioning', 1, { allocation: { auctionReserveFrac: 0 } })
    s.addPlayer('A', 'Power & Utilities') // P1
    s.startYear()
    s.submitBid('P1', 100, 15)
    s.closeCapStage()
    const rec = s.currentYearRecord()!
    s.openTrade()

    // Only auction inventory → average cost is the clearing price.
    expect(botAvgCost(rec, 'P1')).toBeCloseTo(rec.auctionPrice!, 5)
    // Nobody acquired anything under this id → null.
    expect(botAvgCost(rec, 'P2')).toBe(null)

    const held = s.creditsHeld('P1')
    expect(sellCapacity(s, rec, 'P1')).toBe(held)
    s.placeOrder('P1', 'sell', 10, 18) // rests (no crossing bid)
    expect(sellCapacity(s, rec, 'P1')).toBe(round1(held - 10))
  })
})

describe('bot archetypes — single tick', () => {
  for (const [name, arch] of Object.entries(ARCHETYPES)) {
    it(`${name}: auction submits a bid and trade never shorts`, () => {
      const s = new Session('auctioning', 1)
      const bot = s.addBot(name as 'compliance') // one bot of this type
      s.addPlayer('Human', 'Transport') // a counterparty in the roster
      s.startYear()

      const ctx = ctxFor(s, bot.id)
      arch.auction(ctx)
      expect(s.currentYearRecord()!.auctionBid[bot.id]).toBeDefined()

      s.closeCapStage()
      s.openTrade()
      // Several ticks must never throw and never break the no-shorting invariant.
      for (let i = 0; i < 6; i++) arch.trade(ctx)
      const rec = s.currentYearRecord()!
      expect(openSellRemaining(rec.orders, bot.id)).toBeLessThanOrEqual(
        s.creditsHeld(bot.id) + 1e-9,
      )
    })
  }
})

describe('grandfathering bots', () => {
  it('sells trader bots an opening book so a market maker can quote both sides', () => {
    const s = new Session('grandfathering', 1)
    const mm = s.addBot('marketMaker')
    s.addPlayer('Human', 'Power & Utilities')
    s.addBot('compliance')
    s.startYear()
    const rec = s.currentYearRecord()!

    // The bug this pins: grandfathering used to price regulatorGranted at 0, which made
    // seedTraderBots bail, leaving the market maker with nothing to sell.
    expect(rec.primaryPrice).toBeGreaterThan(0)
    expect(rec.regulatorGranted[mm.id]).toBeGreaterThan(0)
    // A financial player has no history to grandfather, so it draws no free allocation.
    expect(rec.freeAllocation[mm.id]).toBe(0)

    s.closeCapStage()
    s.openTrade()
    marketMaker.trade(ctxFor(s, mm.id, 42, warmMaker(s, mm.id)))
    const own = rec.orders.filter((o) => o.playerId === mm.id && o.status === 'open')
    expect(own.some((o) => o.side === 'buy')).toBe(true)
    expect(own.some((o) => o.side === 'sell')).toBe(true)
  })

  it('does not let a trader bot dilute the real emitters\' allocation', () => {
    const withoutBot = new Session('grandfathering', 3)
    withoutBot.addPlayer('Alice', 'Power & Utilities')
    withoutBot.startYear()
    const soloAlice = withoutBot.currentYearRecord()!.freeAllocation.P1

    const withBot = new Session('grandfathering', 3)
    withBot.addPlayer('Alice', 'Power & Utilities')
    withBot.addBot('marketMaker')
    withBot.startYear()
    expect(withBot.currentYearRecord()!.freeAllocation.P1).toBe(soloAlice)
  })

  it('tightens with the LRF only when the scenario asks for it', () => {
    // The control arm has to opt OUT explicitly now: the shipped default applies the
    // reduction to grandfathering, so an unconfigured session is no longer the flat one.
    const flat = new Session('grandfathering', 1, {
      allocation: { applyLRFToGrandfathering: false, capReductionFactor: 0.9 },
    })
    flat.addPlayer('Alice', 'Power & Utilities')
    flat.startYear()
    const flatYear11 = flat.currentYearRecord()!.freeAllocation.P1

    const tightening = new Session('grandfathering', 1, {
      allocation: { applyLRFToGrandfathering: true, capReductionFactor: 0.9 },
    })
    tightening.addPlayer('Alice', 'Power & Utilities')
    tightening.startYear()
    // Year 11 is the exponent origin, so both start equal…
    expect(tightening.currentYearRecord()!.freeAllocation.P1).toBe(flatYear11)
    for (const s of [flat, tightening]) {
      s.closeCapStage()
      s.openTrade()
      s.closeTrade()
      s.advanceYear()
    }
    // …and only the opted-in session shrinks in year 12.
    expect(tightening.currentYearRecord()!.freeAllocation.P1).toBeLessThan(
      flat.currentYearRecord()!.freeAllocation.P1,
    )
  })
})

/**
 * Corrections to bot behaviour, each behind a `bots.fixes` flag. The two market-maker ones
 * now ship ON (they are what stopped the makers hoarding the entire auction pool); the rest
 * are still off. Every arm below sets the flag it is testing EXPLICITLY on both sides, so
 * these keep meaning what they say if a default moves again. All were found by a
 * price-calibration sweep — see sim/sweeps/price-calibration.ts.
 */
describe('bots.fixes', () => {
  it('noiseAbatement: whether the noise bot ever invests in abatement capacity', () => {
    // No longer a bug fix — sizing reads `plannedEmission`, which cannot disagree with the
    // engine, so the old "prices a cut it never makes" defect is structurally impossible.
    // What is left is the archetype question: is a careless trader also a firm that never
    // retrofits? Both answers are coherent, so the flag stays and this pins both arms.
    const run = (invests: boolean) => {
      const s = new Session('benchmarking', 5, {
        bots: { fixes: { noiseAbatement: invests } },
      })
      const bot = s.addBot('noise', 'Power & Utilities')
      s.addPlayer('Human', 'Transport')
      s.startYear()
      s.closeCapStage()
      s.openTrade()
      for (let i = 0; i < 4; i++) noise.trade(ctxFor(s, bot.id))
      return s.getPlayer(bot.id)!
    }

    expect(run(false).abatementCommitted).toBe(0)
    expect(run(true).abatementCommitted).toBeGreaterThan(0)
    // Either way it stays in force NEXT year, not this one — the install is capital.
    expect(run(true).abatementInForce).toBe(0)
  })

  it('a bot ticking all window installs once, not once per tick', () => {
    // The gate that makes the model survivable in a bot-driven market: compliance calls
    // setAbatement on EVERY tick, and every install step charges the retrofit fee again.
    // Thirty ticks must therefore cost exactly what one tick costs.
    const run = (ticks: number) => {
      const s = new Session('benchmarking', 5)
      const bot = s.addBot('compliance', 'Power & Utilities')
      s.addPlayer('Human', 'Transport')
      s.startYear()
      s.closeCapStage()
      s.openTrade()
      const ctx = ctxFor(s, bot.id)
      for (let i = 0; i < ticks; i++) {
        compliance.trade({ ...ctx, market: buildMarketView(
          s.currentYearRecord()!.orders,
          s.currentYearRecord()!.trades,
        ) })
      }
      return {
        spend: s.currentYearRecord()!.abatementSpend[bot.id] ?? 0,
        committed: s.getPlayer(bot.id)!.abatementCommitted,
      }
    }

    const once = run(1)
    const many = run(30)
    expect(once.committed).toBeGreaterThan(0) // the bot does invest, or this proves nothing
    expect(many.spend).toBe(once.spend)
    expect(many.committed).toBe(once.committed)
  })

  it('complianceReservation: what a firm will pay is the cut it is ALLOWED to make', () => {
    const make = (strict: boolean, lifetimeCap: number) => {
      // Both arms set the flag EXPLICITLY. It now ships on, so "pass nothing for the loose
      // arm" quietly made both arms strict and the comparison vacuous.
      const s = new Session('auctioning', 5, {
        abatement: { lifetimeCap },
        bots: { fixes: { complianceReservation: strict } },
      })
      const bot = s.addBot('compliance', 'Power & Utilities')
      s.addPlayer('Human', 'Transport')
      s.startYear()
      s.closeCapStage() // nobody bid, so the bot wins nothing and holds zero
      s.openTrade()
      expect(s.creditsHeld(bot.id)).toBe(0)
      compliance.trade(ctxFor(s, bot.id))
      const order = s
        .currentYearRecord()!
        .orders.find((o) => o.playerId === bot.id && o.side === 'buy')!
      return { price: order.price, ceiling: priceCeiling(s) }
    }

    // Holding nothing, the firm needs a 100% cut to cover itself. Whether that is a real
    // alternative depends on the LIFETIME CAP, and the reservation has to follow it:
    //
    //  - cap 1.0: a full cut is allowed, so the firm will pay up to what it costs —
    //    MAC(1) = a + b = 10 + 75 for Power & Utilities.
    const allowed = make(true, 1)
    expect(allowed.price).toBeCloseTo(85 - 0.5, 5)

    //  - cap 0.5 (what ships): a full cut is NOT allowed, so cutting cannot cover the
    //    shortfall at any price and the fine is the binding alternative. Quoting MAC(1) here
    //    would price a cut the engine refuses to let the firm make.
    const capped = make(true, 0.5)
    expect(capped.price).toBeCloseTo(capped.ceiling - 0.5, 5)

    // The loose boundary returns the ceiling at rCover === 1 regardless — that is the
    // defect the flag exists to compare against, and it is indistinguishable from the
    // capped case above precisely because both hit the ceiling.
    const loose = make(false, 1)
    expect(loose.price).toBeCloseTo(loose.ceiling - 0.5, 5)
  })

  it('marketMakerIncrementalBid: inventory stops compounding year over year', () => {
    const play = (fix: boolean) => {
      // Both arms are explicit: these two fixes ship ON, so `{}` would no longer be "off".
      const s = new Session('auctioning', 5, {
        bots: { fixes: { marketMakerIncrementalBid: fix, marketMakerShareByCount: false } },
      })
      const mm = s.addBot('marketMaker')
      s.addPlayer('A', 'Power & Utilities')
      s.addPlayer('B', 'Heavy Materials')
      const grants: number[] = []
      for (let y = 0; y < 3; y++) {
        if (y === 0) s.startYear()
        else s.advanceYear()
        marketMaker.auction(ctxFor(s, mm.id))
        s.closeCapStage()
        grants.push(s.currentYearRecord()!.regulatorGranted[mm.id] ?? 0)
        s.openTrade()
        s.closeTrade()
      }
      return grants
    }

    const loose = play(false)
    const fixed = play(true)
    // Unfixed, the target is re-bought in full every year regardless of what it already holds.
    expect(loose[2]).toBeGreaterThan(0)
    // Fixed, it only tops up the gap — so by year 3 it buys far less than it did unfixed.
    expect(fixed[2]).toBeLessThan(loose[2])
  })

  it('marketMakerShareByCount: N makers split the target instead of each taking all of it', () => {
    const grantFor = (share: boolean) => {
      const s = new Session('auctioning', 5, {
        bots: { fixes: { marketMakerShareByCount: share, marketMakerIncrementalBid: false } },
      })
      const mms = [s.addBot('marketMaker'), s.addBot('marketMaker'), s.addBot('marketMaker')]
      s.addPlayer('A', 'Power & Utilities')
      s.startYear()
      for (const mm of mms) marketMaker.auction(ctxFor(s, mm.id))
      const rec = s.currentYearRecord()!
      return rec.auctionBid[mms[0].id]?.qty ?? 0
    }
    expect(grantFor(true)).toBeCloseTo(grantFor(false) / 3, 1)
  })
})

describe('market makers do not trade with each other', () => {
  it('leaves a crossing maker-to-maker pair unfilled, and fills the same order for anyone else', () => {
    const s = new Session('benchmarking', 1)
    const a = s.addBot('marketMaker')
    const b = s.addBot('marketMaker')
    s.addPlayer('Human', 'Power & Utilities')
    s.startYear()
    s.closeCapStage()
    s.openTrade()

    // Maker A rests an ask that maker B's bid would cross outright.
    s.placeOrder(a.id, 'sell', 5, 40)
    s.placeOrder(b.id, 'buy', 5, 60)
    const rec = s.currentYearRecord()!
    expect(rec.trades).toHaveLength(0)
    // Both orders survive, open, untouched — the pair is vetoed, not consumed.
    expect(rec.orders.filter((o) => o.status === 'open')).toHaveLength(2)

    // The very same ask is available to an emitter.
    s.placeOrder('P3', 'buy', 5, 60)
    expect(rec.trades).toHaveLength(1)
    expect(rec.trades[0].sellerId).toBe(a.id)
    expect(rec.trades[0].price).toBe(40) // resting price, as always
  })

  it('does not block a maker from trading with a non-maker bot', () => {
    const s = new Session('benchmarking', 1)
    const mm = s.addBot('marketMaker')
    const compliance = s.addBot('compliance', 'Power & Utilities')
    s.addPlayer('Human', 'Transport')
    s.startYear()
    s.closeCapStage()
    s.openTrade()

    s.placeOrder(mm.id, 'sell', 5, 40)
    s.placeOrder(compliance.id, 'buy', 5, 60)
    expect(s.currentYearRecord()!.trades).toHaveLength(1)
  })
})

describe('the market maker sits out the opening of each year', () => {
  function opened() {
    const s = new Session('benchmarking', 1)
    const mm = s.addBot('marketMaker')
    s.addPlayer('A', 'Power & Utilities')
    s.addPlayer('B', 'Heavy Materials')
    s.startYear()
    s.closeCapStage()
    s.openTrade()
    return { s, mm }
  }

  it('places nothing for the first quietTicks, then quotes', () => {
    const { s, mm } = opened()
    const rt: BotRuntime = {}
    const quiet = s.state.config.bots.marketMaker.quietTicks
    const mine = () => s.currentYearRecord()!.orders.filter((o) => o.playerId === mm.id)

    for (let i = 0; i < quiet; i++) {
      marketMaker.trade(ctxFor(s, mm.id, 42, rt))
      expect(mine(), `tick ${i + 1} of the quiet period`).toHaveLength(0)
    }
    marketMaker.trade(ctxFor(s, mm.id, 42, rt))
    expect(mine().length).toBeGreaterThan(0)
  })

  it('goes quiet again when the next year opens', () => {
    const { s, mm } = opened()
    const rt: BotRuntime = {}
    const quiet = s.state.config.bots.marketMaker.quietTicks
    for (let i = 0; i <= quiet; i++) marketMaker.trade(ctxFor(s, mm.id, 42, rt))
    expect(s.currentYearRecord()!.orders.filter((o) => o.playerId === mm.id).length)
      .toBeGreaterThan(0)

    s.closeTrade()
    s.advanceYear()
    s.closeCapStage()
    s.openTrade()
    // A fresh year means a fresh silence — the counter is keyed on the year, not the bot.
    marketMaker.trade(ctxFor(s, mm.id, 42, rt))
    expect(s.currentYearRecord()!.orders.filter((o) => o.playerId === mm.id)).toHaveLength(0)
  })
})

describe('market maker quotes stay inside the band around the recent price', () => {
  it('buys at or below the recent price and sells at or above it', () => {
    const s = new Session('benchmarking', 1)
    const mm = s.addBot('marketMaker')
    s.addPlayer('A', 'Power & Utilities')
    s.addPlayer('B', 'Heavy Materials')
    s.startYear()
    s.closeCapStage()
    s.openTrade()

    // Print a few trades so the maker has a recent price to quote around.
    for (const px of [50, 52, 48, 51, 49]) {
      s.placeOrder('P2', 'sell', 2, px)
      s.placeOrder('P3', 'buy', 2, px)
    }
    const rec = s.currentYearRecord()!
    const ref = rec.trades.slice(-5).reduce((t, x) => t + x.price, 0) / 5
    const band = s.state.config.bots.marketMaker.bandFrac

    marketMaker.trade(ctxFor(s, mm.id, 42, warmMaker(s, mm.id)))
    const own = rec.orders.filter((o) => o.playerId === mm.id && o.status === 'open')
    const bid = own.find((o) => o.side === 'buy')!
    const ask = own.find((o) => o.side === 'sell')
    expect(bid.price).toBeGreaterThanOrEqual(ref * (1 - band) - 0.05)
    expect(bid.price).toBeLessThanOrEqual(ref + 0.05)
    if (ask) {
      expect(ask.price).toBeGreaterThanOrEqual(ref - 0.05)
      expect(ask.price).toBeLessThanOrEqual(ref * (1 + band) + 0.05)
    }
  })
})

describe('bot archetypes under benchmarking (no primary auction)', () => {
  for (const [name, arch] of Object.entries(ARCHETYPES)) {
    it(`${name}: trades on free allocation without shorting`, () => {
      const s = new Session('benchmarking', 1)
      const bot = s.addBot(name as 'compliance')
      s.addPlayer('Human', 'Transport')
      s.startYear()

      const ctx = ctxFor(s, bot.id)
      // There is nothing to bid into, so the cap stage is a no-op for every archetype.
      expect(arch.auction(ctx)).toBe(false)

      s.closeCapStage()
      s.openTrade()
      for (let i = 0; i < 6; i++) arch.trade(ctx)
      const rec = s.currentYearRecord()!
      expect(openSellRemaining(rec.orders, bot.id)).toBeLessThanOrEqual(
        s.creditsHeld(bot.id) + 1e-9,
      )
    })
  }

  it('the market maker quotes both sides off its seed inventory', () => {
    const s = new Session('benchmarking', 1)
    const mm = s.addBot('marketMaker')
    // Emitters give the class a free allocation, which is what sizes the MM's target.
    s.addPlayer('Human', 'Power & Utilities')
    s.addBot('compliance')
    s.startYear()
    s.closeCapStage()
    s.openTrade()

    marketMaker.trade(ctxFor(s, mm.id, 42, warmMaker(s, mm.id)))
    const rec = s.currentYearRecord()!
    const own = rec.orders.filter((o) => o.playerId === mm.id && o.status === 'open')
    // The bug this guards: with target inventory keyed off the (zero) auction pool the
    // MM skews hard negative and never rests an ask.
    expect(own.some((o) => o.side === 'buy')).toBe(true)
    expect(own.some((o) => o.side === 'sell')).toBe(true)
  })

  it('the market maker never quotes above the agents\' ceiling', () => {
    const s = new Session('benchmarking', 1)
    const mm = s.addBot('marketMaker')
    s.addPlayer('Human', 'Power & Utilities')
    s.addBot('compliance')
    s.startYear()
    s.closeCapStage()
    s.openTrade()

    // Drive the discovered price right up to the ceiling, which is where a tight
    // benchmark puts it — an unclamped ask used to escape past it from here.
    //
    // Asserted against `priceCeiling`, not the bare fine: the fine stopped being the bound
    // when `ceilingIncludesCarry` shipped ON. What must still hold is that the maker respects
    // whatever ceiling the agents share, which is the invariant this test was always about.
    const P = s.state.config.market.penaltyRate
    const ceiling = priceCeiling(s)
    s.placeOrder('P2', 'sell', 5, P)
    s.placeOrder('P3', 'buy', 5, P)

    const mmRt = warmMaker(s, mm.id)
    for (let i = 0; i < 4; i++) marketMaker.trade(ctxFor(s, mm.id, 42, mmRt))
    const rec = s.currentYearRecord()!
    for (const o of rec.orders.filter((x) => x.playerId === mm.id)) {
      expect(o.price).toBeLessThanOrEqual(ceiling)
    }
    for (const t of rec.trades) expect(t.price).toBeLessThanOrEqual(ceiling)
  })

  it('a short compliance firm bids up toward the penalty ceiling', () => {
    const s = new Session('benchmarking', 1)
    const bot = s.addBot('compliance', 'Heavy Materials') // dear MAC → cannot self-cover
    s.addPlayer('Human', 'Transport')
    s.startYear()
    s.closeCapStage()
    s.openTrade()

    const ctx = ctxFor(s, bot.id)
    const held = s.creditsHeld(bot.id)
    const expected = expectedEmission(s.getPlayer(bot.id)!, s.state.currentYear)
    expect(expected).toBeGreaterThan(held) // structurally short, as the benchmark intends

    compliance.trade(ctx)
    const bid = s
      .currentYearRecord()!
      .orders.find((o) => o.playerId === bot.id && o.side === 'buy' && o.status === 'open')
    expect(bid).toBeDefined()
    // Its willingness to pay exceeds the stale opening anchor precisely because the
    // penalty, not the market, is the binding alternative.
    const { penaltyRate, openingReferenceFraction } = s.state.config.market
    expect(bid!.price).toBeGreaterThan(penaltyRate * openingReferenceFraction)
    expect(bid!.price).toBeLessThanOrEqual(penaltyRate)
  })
})
