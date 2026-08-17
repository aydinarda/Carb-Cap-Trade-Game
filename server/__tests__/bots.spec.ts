import { describe, expect, it } from 'vitest'
import { createRng, expectedEmission, openSellRemaining, round1 } from '../../shared/engine'
import * as compliance from '../bots/compliance'
import * as marketMaker from '../bots/marketMaker'
import * as noise from '../bots/noise'
import * as speculator from '../bots/speculator'
import { botAvgCost, disperse, referencePrice, sellCapacity } from '../bots/helpers'
import { Session } from '../session'
import type { BotCtx } from '../bots/types'

const ARCHETYPES = { compliance, marketMaker, speculator, noise }

function ctxFor(s: Session, botId: string, seed = 42): BotCtx {
  return { session: s, bot: s.getPlayer(botId)!, rng: createRng(seed), rt: {} }
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
    expect(referencePrice(s)).toBe(s.state.config.penaltyRate / 2)
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
    const P = s.state.config.penaltyRate
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
    expect(bid!.price).toBeGreaterThan(s.state.config.penaltyRate / 2)
    expect(bid!.price).toBeLessThanOrEqual(s.state.config.penaltyRate)
  })
})
