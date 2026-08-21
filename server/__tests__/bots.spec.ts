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
import { botAvgCost, disperse, referencePrice, sellCapacity } from '../bots/helpers'
import { Session } from '../session'
import type { BotCtx } from '../bots/types'

const ARCHETYPES = { compliance, marketMaker, speculator, noise }

function ctxFor(s: Session, botId: string, seed = 42): BotCtx {
  const rec = s.currentYearRecord()
  return {
    session: s,
    bot: s.getPlayer(botId)!,
    rng: createRng(seed),
    rt: {},
    // stepBots builds this once per tick and shares it; rebuild it here so each call
    // sees the book as it stands right now.
    market: buildMarketView(rec?.orders ?? [], rec?.trades ?? []),
  }
}

describe('bot helpers', () => {
  it('disperse clamps into (0.1, penaltyRate]', () => {
    expect(disperse(10, 0, 20)).toBe(10)
    expect(disperse(100, 0, 20)).toBe(20) // above ceiling → clamped
    expect(disperse(-5, 0, 20)).toBe(0.1) // below floor → clamped
    expect(disperse(10, 0.5, 20)).toBe(15) // +50% bias
  })

  it('referencePrice falls back to penaltyRate/2 before the first auction clears', () => {
    const s = new Session('auctioning', 1)
    s.addPlayer('A', 'Power & Utilities')
    s.startYear() // cap stage — no auction price yet
    expect(referencePrice(s)).toBe(s.state.config.market.penaltyRate / 2)
  })

  it('referencePrice tracks THIS year\'s auction clearing once it has run', () => {
    const s = new Session('auctioning', 1)
    s.addPlayer('A', 'Power & Utilities')
    s.startYear()
    s.submitBid('P1', 100, 15)
    s.closeCapStage() // auction clears → clearing price is the fresh anchor
    const clearing = s.currentYearRecord()!.auctionPrice!
    expect(clearing).toBeGreaterThan(0)
    expect(referencePrice(s)).toBe(clearing)
  })

  it('sellCapacity = held − open asks; botAvgCost from auction spend', () => {
    const s = new Session('auctioning', 1)
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
    marketMaker.trade(ctxFor(s, mm.id))
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
    const flat = new Session('grandfathering', 1)
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
 * Corrections to bot behaviour, each off by default. These assert the GATED behaviour with
 * the flag explicitly on, so the fixes stay covered while the shipped game keeps the
 * behaviour it has. Every one of them was found by a price-calibration sweep — see
 * sim/sweeps/price-calibration.ts.
 */
describe('bots.fixes', () => {
  it('noiseAbatement: the noise bot records the cut it already priced into its order', () => {
    const off = new Session('benchmarking', 5)
    const offBot = off.addBot('noise', 'Power & Utilities')
    off.addPlayer('Human', 'Transport')
    off.startYear()
    off.closeCapStage()
    off.openTrade()
    for (let i = 0; i < 4; i++) noise.trade(ctxFor(off, offBot.id))
    // The defect: it sizes its order as `expected × (1 − r*) − held` but never abates.
    expect(off.currentYearRecord()!.abatement[offBot.id] ?? 0).toBe(0)

    const on = new Session('benchmarking', 5, { bots: { fixes: { noiseAbatement: true } } })
    const onBot = on.addBot('noise', 'Power & Utilities')
    on.addPlayer('Human', 'Transport')
    on.startYear()
    on.closeCapStage()
    on.openTrade()
    for (let i = 0; i < 4; i++) noise.trade(ctxFor(on, onBot.id))
    expect(on.currentYearRecord()!.abatement[onBot.id]).toBeGreaterThan(0)
  })

  it('complianceReservation: holding nothing means a full cut, not the penalty', () => {
    const make = (strict: boolean) => {
      const s = new Session(
        'auctioning',
        5,
        strict ? { bots: { fixes: { complianceReservation: true } } } : {},
      )
      const bot = s.addBot('compliance', 'Power & Utilities')
      s.addPlayer('Human', 'Transport')
      s.startYear()
      s.closeCapStage() // nobody bid, so the bot wins nothing and holds zero
      s.openTrade()
      expect(s.creditsHeld(bot.id)).toBe(0)
      compliance.trade(ctxFor(s, bot.id))
      return s
        .currentYearRecord()!
        .orders.find((o) => o.playerId === bot.id && o.side === 'buy')!
    }

    const P = new Session('auctioning', 5).state.config.market.penaltyRate
    // Loose boundary: rCover === 1 falls into the `>= 1` branch and returns P outright.
    expect(make(false).price).toBeCloseTo(P - 0.5, 5)
    // Strict: the cost of cutting 100% is a + b = 10 + 75 for Power & Utilities.
    expect(make(true).price).toBeCloseTo(85 - 0.5, 5)
  })

  it('marketMakerIncrementalBid: inventory stops compounding year over year', () => {
    const play = (fix: boolean) => {
      const s = new Session(
        'auctioning',
        5,
        fix ? { bots: { fixes: { marketMakerIncrementalBid: true } } } : {},
      )
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
      const s = new Session(
        'auctioning',
        5,
        share ? { bots: { fixes: { marketMakerShareByCount: true } } } : {},
      )
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

    marketMaker.trade(ctxFor(s, mm.id))
    const rec = s.currentYearRecord()!
    const own = rec.orders.filter((o) => o.playerId === mm.id && o.status === 'open')
    // The bug this guards: with target inventory keyed off the (zero) auction pool the
    // MM skews hard negative and never rests an ask.
    expect(own.some((o) => o.side === 'buy')).toBe(true)
    expect(own.some((o) => o.side === 'sell')).toBe(true)
  })

  it('the market maker never quotes above the penalty, even at the ceiling', () => {
    const s = new Session('benchmarking', 1)
    const mm = s.addBot('marketMaker')
    s.addPlayer('Human', 'Power & Utilities')
    s.addBot('compliance')
    s.startYear()
    s.closeCapStage()
    s.openTrade()

    // Drive the discovered price right up to the ceiling, which is where a tight
    // benchmark puts it — an unclamped ask used to escape past P from here.
    const P = s.state.config.market.penaltyRate
    s.placeOrder('P2', 'sell', 5, P)
    s.placeOrder('P3', 'buy', 5, P)

    for (let i = 0; i < 4; i++) marketMaker.trade(ctxFor(s, mm.id))
    const rec = s.currentYearRecord()!
    for (const o of rec.orders.filter((x) => x.playerId === mm.id)) {
      expect(o.price).toBeLessThanOrEqual(P)
    }
    for (const t of rec.trades) expect(t.price).toBeLessThanOrEqual(P)
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
    // Its willingness to pay exceeds the stale mid (penaltyRate / 2) precisely because
    // the penalty, not the market, is the binding alternative.
    expect(bid!.price).toBeGreaterThan(s.state.config.market.penaltyRate / 2)
    expect(bid!.price).toBeLessThanOrEqual(s.state.config.market.penaltyRate)
  })
})
