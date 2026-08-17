import { describe, expect, it } from 'vitest'
import { Session } from '../session'
import { hostSnapshot } from '../views'

/**
 * CHARACTERIZATION TEST — pins the literal output of the engine as it is today.
 *
 * The rest of the suite deliberately asserts invariants computed from state rather than
 * seed-dependent numbers, which makes it robust but blind: it would not notice
 * `freeCreditRatio` silently becoming 0.75, an extra `rng` draw reordering every
 * generated history, or a rounding rule moving by 0.05. This file exists to notice.
 *
 * These numbers have no meaning of their own — they are simply what the engine produced
 * before the configuration refactor. If a change here is intentional, re-record with
 * `vitest -u` and say so in the commit; if it is not, something moved that should not have.
 */

const PLAYERS: [string, Parameters<Session['addPlayer']>[1]][] = [
  ['Alice', 'Power & Utilities'],
  ['Bob', 'Transport'],
  ['Cara', 'Heavy Materials'],
]

function seeded(mode: 'grandfathering' | 'benchmarking' | 'auctioning') {
  const s = new Session(mode, 1)
  for (const [name, industry] of PLAYERS) s.addPlayer(name, industry)
  return s
}

/** Drives one year with fixed, deterministic player actions (no bots, no RNG of our own). */
function playYear(s: Session, first: boolean) {
  if (first) s.startYear()
  else s.advanceYear()

  if (s.usesAuction) {
    s.submitBid('P1', 900, 14)
    s.submitBid('P2', 300, 9)
    s.submitBid('P3', 700, 11)
  }
  s.closeCapStage()
  s.openTrade()
  s.setAbatement('P1', 0.3)
  s.setAbatement('P3', 0.1)
  s.placeOrder('P1', 'sell', 40, 12)
  s.placeOrder('P3', 'buy', 40, 12) // crosses → one trade at the resting price
  s.closeTrade()
}

function capture(s: Session) {
  const rec = s.currentYearRecord()!
  return {
    freeAllocation: rec.freeAllocation,
    regulatorPool: rec.regulatorPool,
    primaryPrice: rec.primaryPrice,
    auctionPrice: rec.auctionPrice,
    regulatorGranted: rec.regulatorGranted,
    realized: rec.realized,
    settlement: rec.settlement,
    netPosition: rec.netPosition,
    banked: Object.fromEntries(s.state.players.map((p) => [p.id, p.bankedCredits])),
    score: Object.fromEntries(s.state.players.map((p) => [p.id, p.score])),
    optimalScore: Object.fromEntries(s.state.players.map((p) => [p.id, p.optimalScore])),
  }
}

describe('golden — grandfathering', () => {
  it('year 11 and 12 settle to fixed numbers', () => {
    const s = seeded('grandfathering')
    playYear(s, true)
    expect(capture(s)).toMatchInlineSnapshot()
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot()
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot()
  })
})

describe('golden — benchmarking', () => {
  it('year 11 and 12 settle to fixed numbers', () => {
    const s = seeded('benchmarking')
    playYear(s, true)
    expect(capture(s)).toMatchInlineSnapshot()
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot()
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot()
  })
})

describe('golden — auctioning', () => {
  it('year 11 and 12 settle to fixed numbers', () => {
    const s = seeded('auctioning')
    playYear(s, true)
    expect(capture(s)).toMatchInlineSnapshot()
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot()
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot()
  })
})

describe('golden — generated histories', () => {
  it('the seeded emission histories are exactly these', () => {
    const s = seeded('grandfathering')
    expect(s.state.players.map((p) => ({ id: p.id, emissions: p.emissions }))).toMatchInlineSnapshot()
  })

  it('the trader-bot seed and its price are exactly these', () => {
    const s = new Session('benchmarking', 7)
    s.addPlayer('Human', 'Power & Utilities')
    const mm = s.addBot('marketMaker')
    const spec = s.addBot('speculator')
    s.addBot('compliance')
    s.startYear()
    const rec = s.currentYearRecord()!
    expect({
      primaryPrice: rec.primaryPrice,
      seed: { mm: rec.regulatorGranted[mm.id], spec: rec.regulatorGranted[spec.id] },
      freeAllocation: rec.freeAllocation,
      circulatingCap: s.circulatingCap(),
    }).toMatchInlineSnapshot()
  })
})
