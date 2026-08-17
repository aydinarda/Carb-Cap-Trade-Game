import { describe, expect, it } from 'vitest'
import { createRng, openSellRemaining, round1 } from '../../shared/engine'
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

  it('referencePrice falls back to penaltyRate/2 in the first year', () => {
    const s = new Session('auctioning', 1)
    s.addPlayer('A', 'Power & Utilities')
    s.startYear()
    expect(referencePrice(s)).toBe(s.state.config.penaltyRate / 2)
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
