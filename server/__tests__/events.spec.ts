import { describe, expect, it } from 'vitest'
import {
  abatementLean,
  averageBorrowShare,
  createRng,
  round1,
  ruleVote,
  ruleYesProbability,
  tally,
  voteDraw,
} from '../../shared/engine'
import { resolveConfig } from '../../shared/config'
import type { Referendum } from '../../shared/types'
import { stepBots } from '../bots/step'
import { CHAT_MAX_CHARS, GameError, Session } from '../session'
import { hostSnapshot, playerSnapshot } from '../views'

// The events and the referendum designed with the user on 2026-11-01: nuclear plants closing,
// the hybrid free allocation cut, and the borrowing referendum with its chat and vote.

/** Play the open round out and move to the next one. */
const nextRound = (s: Session) => {
  s.closeCapStage()
  s.openTrade()
  s.closeTrade()
  s.advanceYear()
}

/** Play the open round to its year summary. */
const toSummary = (s: Session) => {
  s.closeCapStage()
  s.openTrade()
  s.closeTrade()
}

const expectError = (fn: () => unknown, code: string) => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(GameError)
    expect((error as GameError).code).toBe(code)
    return
  }
  throw new Error(`expected GameError ${code}`)
}

describe('nuclear closure', () => {
  const start = (override?: ConstructorParameters<typeof Session>[2]) => {
    const s = new Session('benchmarking', 5, override)
    s.addPlayer('Power', 'Power & Utilities')
    s.addPlayer('Truck', 'Transport')
    s.startYear()
    return s
  }

  it('lands a round after it is announced: +7% for Power & Utilities, +5% for everyone else', () => {
    const s = start()
    const closure = s.announceNuclear()
    expect(closure).toMatchObject({ announcedIn: 11, fromYear: 12, magnitude: 0.05 })
    expect(s.sectorFactorFor(11, 'Power & Utilities')).toBe(1)
    expect(s.sectorFactorFor(12, 'Power & Utilities')).toBeCloseTo(1.07, 10)
    expect(s.sectorFactorFor(12, 'Transport')).toBeCloseTo(1.05, 10)
    // A step, not a rate: taken once and then carried.
    expect(s.sectorFactorFor(13, 'Power & Utilities')).toBe(1)
    expect(s.sectorFactorFor(20, 'Transport')).toBe(1)
  })

  it('holds the class above trend for good — never compounding, never stepping back', () => {
    const plain = start()
    const closed = start()
    closed.announceNuclear()
    const power: number[] = []
    const truck: number[] = []
    for (let round = 0; round < 4; round++) {
      power.push(closed.plannedEmission('P1') / plain.plannedEmission('P1'))
      truck.push(closed.plannedEmission('P2') / plain.plannedEmission('P2'))
      nextRound(plain)
      nextRound(closed)
    }
    expect(power[0]).toBeCloseTo(1, 3)
    for (const r of power.slice(1)) expect(r).toBeCloseTo(1.07, 2)
    expect(truck[0]).toBeCloseTo(1, 3)
    for (const r of truck.slice(1)) expect(r).toBeCloseTo(1.05, 2)
  })

  it('draws the closure round around exactly what the class was shown', () => {
    const plain = start({ emissions: { nuclear: { leadRounds: 0 } } })
    const closed = start({ emissions: { nuclear: { leadRounds: 0 } } })
    // No lead: it lands in the round on screen.
    expect(closed.announceNuclear().fromYear).toBe(11)
    expect(closed.plannedEmission('P1')).toBeCloseTo(plain.plannedEmission('P1') * 1.07, 1)
    toSummary(plain)
    toSummary(closed)
    expect(closed.state.years[11].realized.P1 / plain.state.years[11].realized.P1).toBeCloseTo(1.07, 3)
    expect(closed.state.years[11].realized.P2 / plain.state.years[11].realized.P2).toBeCloseTo(1.05, 3)
  })

  it('happens once, and can be withdrawn only before it lands', () => {
    const s = start()
    s.announceNuclear()
    expectError(() => s.announceNuclear(), 'ALREADY_ANNOUNCED')
    s.cancelNuclear()
    expect(s.state.nuclearClosure).toBeNull()
    s.announceNuclear() // lands in 12
    nextRound(s)
    toSummary(s)
    expectError(() => s.cancelNuclear(), 'PERMANENT')
  })
})

describe('free allocation cut (hybrid)', () => {
  const start = (mode: 'hybrid' | 'benchmarking' = 'hybrid') => {
    const s = new Session(mode, 3)
    s.addPlayer('Power', 'Power & Utilities')
    s.addPlayer('Steel', 'Heavy Materials')
    s.startYear()
    return s
  }
  const free = (s: Session, year: number) => Object.values(s.state.years[year].freeAllocation).reduce((a, b) => a + b, 0)

  it('is off outside the hybrid mode', () => {
    expectError(() => start('benchmarking').announceFreeCut(), 'WRONG_MODE')
  })

  it('halves the free shares from the next allocation and sells the cut at the auction', () => {
    const plain = start()
    const cut = start()
    expect(cut.announceFreeCut()).toMatchObject({ announcedIn: 11, fromYear: 12, factor: 0.5 })
    // This round's allocation was already issued.
    expect(free(cut, 11)).toBeCloseTo(free(plain, 11), 6)
    nextRound(plain)
    nextRound(cut)
    expect(free(plain, 12)).toBeGreaterThan(0)
    expect(free(cut, 12)).toBeCloseTo(free(plain, 12) * 0.5, 0)
    // The cap does not move: what is no longer given away is on offer at the auction instead.
    const issued = (s: Session) => free(s, 12) + s.state.years[12].regulatorPool
    expect(issued(cut)).toBeCloseTo(issued(plain), 0)
    expect(cut.state.years[12].regulatorPool).toBeGreaterThan(plain.state.years[12].regulatorPool)
  })

  it('can be withdrawn only before the first allocation it reaches is issued', () => {
    const s = start()
    s.announceFreeCut()
    expectError(() => s.announceFreeCut(), 'ALREADY_ANNOUNCED')
    s.cancelFreeCut()
    s.announceFreeCut()
    nextRound(s)
    expectError(() => s.cancelFreeCut(), 'PERMANENT')
  })
})

describe('borrowing referendum', () => {
  const NOW = 1_000_000
  const start = (beforeStart?: (s: Session) => void) => {
    const s = new Session('auctioning', 7)
    s.addPlayer('Alice', 'Power & Utilities')
    s.addPlayer('Bob', 'Transport')
    s.addPlayer('Cem', 'Heavy Materials')
    beforeStart?.(s)
    s.startYear()
    return s
  }
  const inSummary = () => {
    const s = start()
    toSummary(s)
    return s
  }

  it('opens only in a year summary, and only where borrowing is on', () => {
    expectError(() => start().openReferendum({}, NOW), 'WRONG_PHASE')
    const off = new Session('auctioning', 7, { market: { borrowing: { enabled: false, limitFrac: 1 } } })
    off.addPlayer('Alice', 'Power & Utilities')
    off.startYear()
    toSummary(off)
    expectError(() => off.openReferendum({}, NOW), 'WRONG_MODE')
  })

  it('talks for a minute, votes for fifteen seconds, and keeps the year from moving on meanwhile', () => {
    const s = inSummary()
    const r = s.openReferendum({}, NOW)
    expect(r).toMatchObject({ stage: 'chat', chatSeconds: 60, voteSeconds: 15, stageEndsAt: NOW + 60_000, appliesFrom: 12 })
    expect(r.proposal).toEqual({ kind: 'borrowLimit', frac: 0.07 })
    expectError(() => s.advanceYear(), 'REFERENDUM_OPEN')
    expectError(() => s.endGame(), 'REFERENDUM_OPEN')
    expectError(() => s.openReferendum({}, NOW), 'REFERENDUM_OPEN')
    expectError(() => s.castVote('P1', 'yes'), 'VOTE_CLOSED')

    expect(s.referendumTick(NOW + 59_999)).toBe(false)
    expect(s.referendumTick(NOW + 60_000)).toBe(true)
    expect(s.state.referendum!.stage).toBe('vote')
    expect(s.state.referendum!.stageEndsAt).toBe(NOW + 75_000)
    expectError(() => s.postChat('P1', 'too late', NOW + 61_000), 'CHAT_CLOSED')

    expect(s.referendumTick(NOW + 75_000)).toBe(true)
    expect(s.state.referendum!.stage).toBe('closed')
    s.advanceYear()
  })

  it('keeps the chat short, unhurried and signed', () => {
    const s = inSummary()
    s.openReferendum({}, NOW)
    s.postChat('P1', '  Seven percent is too tight for us.  ', NOW)
    s.postChat('host', 'Vote opens in a minute.', NOW + 100)
    expectError(() => s.postChat('P1', 'again', NOW + 500), 'TOO_FAST')
    expectError(() => s.postChat('P2', 'x'.repeat(CHAT_MAX_CHARS + 1), NOW + 600), 'BAD_CHAT')
    expectError(() => s.postChat('P2', '   ', NOW + 700), 'BAD_CHAT')
    s.postChat('P1', 'fine', NOW + 2_500)
    expect(s.state.referendum!.chat.map((m) => [m.name, m.text])).toEqual([
      ['Alice', 'Seven percent is too tight for us.'],
      ['Regulator', 'Vote opens in a minute.'],
      ['Alice', 'fine'],
    ])
  })

  it('passes on a majority of the votes cast and caps borrowing from the next round', () => {
    const s = inSummary()
    s.openReferendum({ chatSeconds: 0 }, NOW)
    expect(s.state.referendum!.stage).toBe('vote')
    s.castVote('P1', 'yes')
    s.castVote('P2', 'no')
    s.castVote('P2', 'yes') // a company may change its mind until the vote closes
    s.referendumTick(NOW + 15_000)
    expect(s.state.referendum!.result).toEqual({ approved: true, yes: 2, no: 0, eligible: 3 })
    expect(s.state.borrowLimitRule).toEqual({ frac: 0.07, fromYear: 12 })

    s.advanceYear()
    const rooms = s.borrowRooms()
    for (const p of s.state.players) {
      expect(rooms[p.id]).toBeCloseTo(round1(0.07 * s.plannedEmission(p.id)), 6)
    }
    // Year 12's shortfall is borrowed when year 13 opens — no more than the voted cap × year 12's
    // planned emission — and the rest is fined then, on year 13's bill.
    toSummary(s)
    const record = s.state.years[12]
    s.advanceYear()
    for (const p of s.state.players) {
      const short = record.settlement![p.id].shortage
      expect(record.borrowed![p.id]).toBeLessThanOrEqual(rooms[p.id] + 0.05)
      expect(record.borrowed![p.id] + record.borrowFined![p.id]).toBeCloseTo(short, 1)
      expect(s.currentYearRecord()!.carriedPenalty![p.id]).toBeCloseTo(round1(record.borrowFined![p.id] * s.state.config.market.penaltyRate), -1)
    }
  })

  it('fails on a tie and leaves borrowing as it was', () => {
    const s = inSummary()
    const before = (() => {
      const t = inSummary()
      t.advanceYear()
      return t.borrowRooms()
    })()
    s.openReferendum({ chatSeconds: 0 }, NOW)
    s.castVote('P1', 'yes')
    s.castVote('P2', 'no')
    s.referendumTick(NOW + 15_000)
    expect(s.state.referendum!.result).toEqual({ approved: false, yes: 1, no: 1, eligible: 3 })
    expect(s.state.borrowLimitRule).toBeNull()
    s.advanceYear()
    expect(s.borrowRooms()).toEqual(before)
  })

  it('gives pure-trader bots no vote, and the bots vote by the shared rule', () => {
    let firm!: ReturnType<Session['addBot']>
    let trader!: ReturnType<Session['addBot']>
    const s = start((lobby) => {
      firm = lobby.addBot('compliance')
      trader = lobby.addBot('speculator')
    })
    toSummary(s)
    s.openReferendum({ chatSeconds: 0 }, NOW)
    expectError(() => s.castVote(trader.id, 'yes'), 'NO_VOTE')
    expect(stepBots(s, createRng(1), () => ({}))).toBe(true)
    const votes = s.state.referendum!.votes
    const rule = { frac: 0.07, weights: { borrowing: 0.7, abatement: 0.3 }, abatementPivot: 0.5 }
    const draw = voteDraw(s.state.seed, s.state.referendum!.id, firm.id)
    expect(votes[firm.id]).toBe(ruleVote(s.state, firm.id, rule, draw))
    expect(votes[trader.id]).toBeUndefined()
    // People are not voted for.
    expect(votes.P1).toBeUndefined()
  })

  it('shows a player its own vote and the result, and only the host the live count', () => {
    const s = inSummary()
    s.openReferendum({ chatSeconds: 0 }, NOW)
    s.castVote('P1', 'no')
    const mine = playerSnapshot(s, 'P1').referendum!
    expect(mine).toMatchObject({ stage: 'vote', myVote: 'no', canVote: true, result: null })
    expect(mine.live).toBeUndefined()
    expect(hostSnapshot(s).referendum!.live).toEqual({ yes: 0, no: 1, eligible: 3 })
  })
})

describe('the voting rule', () => {
  const s = (() => {
    const session = new Session('auctioning', 7)
    session.addPlayer('Alice', 'Power & Utilities')
    session.addPlayer('Bob', 'Transport')
    return session
  })()
  const year = (n: number, borrowed: Record<string, number>, realized: Record<string, number>) =>
    ({ year: n, borrowed, realized }) as unknown as Session['state']['years'][number]

  it('averages borrowing over emission across the settled years borrowing was on in', () => {
    s.state.years = {
      11: year(11, { P1: 10, P2: 0 }, { P1: 100, P2: 50 }),
      12: year(12, { P1: 2, P2: 1 }, { P1: 100, P2: 50 }),
      13: { ...year(13, {}, { P1: 100, P2: 50 }), borrowed: undefined },
    }
    expect(averageBorrowShare(s.state, 'P1')).toBeCloseTo(0.06, 10)
    expect(averageBorrowShare(s.state, 'P2')).toBeCloseTo(0.01, 10)
    expect(averageBorrowShare(s.state, 'P9')).toBeNull()
  })

  // The user's weights (2026-11-10): 0.7 the borrowing history, 0.3 the installed abatement.
  const rule = (frac: number, weights = { borrowing: 0.7, abatement: 0.3 }, abatementPivot = 0.5) =>
    ({ frac, weights, abatementPivot })
  const installed = (id: string, a: number) => {
    s.state.players.find((p) => p.id === id)!.abatementCommitted = a
  }

  it('leans on installed abatement: 0 at none, even at the pivot, 1 at full, linear between', () => {
    expect([0, 0.25, 0.5, 0.75, 1].map((a) => abatementLean(a, 0.5))).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(abatementLean(0.4, 0.4)).toBe(0.5)
    expect(abatementLean(0.2, 0.4)).toBeCloseTo(0.25, 10)
    expect(abatementLean(0.7, 0.4)).toBeCloseTo(0.75, 10)
    expect(abatementLean(-1, 0.5)).toBe(0)
    expect(abatementLean(2, 0.5)).toBe(1)
  })

  it('weighs the borrowing history 0.7 and the abatement lean 0.3', () => {
    installed('P1', 0)
    // P1 borrowed 6% on average: under a 7% cap the borrowing part says yes, under 5% no.
    expect(ruleYesProbability(s.state, 'P1', rule(0.07))).toBeCloseTo(0.7, 10)
    expect(ruleYesProbability(s.state, 'P1', rule(0.05))).toBeCloseTo(0, 10)
    installed('P1', 0.5)
    expect(ruleYesProbability(s.state, 'P1', rule(0.07))).toBeCloseTo(0.85, 10)
    expect(ruleYesProbability(s.state, 'P1', rule(0.05))).toBeCloseTo(0.15, 10)
    installed('P1', 1)
    expect(ruleYesProbability(s.state, 'P1', rule(0.07))).toBeCloseTo(1, 10)
    expect(ruleYesProbability(s.state, 'P1', rule(0.05))).toBeCloseTo(0.3, 10)
    // No history: the borrowing part says yes.
    expect(ruleYesProbability(s.state, 'P9', rule(0.07))).toBeCloseTo(0.7, 10)
    installed('P1', 0)
  })

  it('normalises the weights, so only their ratio matters', () => {
    installed('P1', 0.5)
    expect(ruleYesProbability(s.state, 'P1', rule(0.05, { borrowing: 7, abatement: 3 }))).toBeCloseTo(0.15, 10)
    expect(ruleYesProbability(s.state, 'P1', rule(0.05, { borrowing: 1, abatement: 0 }))).toBe(0)
    expect(ruleYesProbability(s.state, 'P1', rule(0.05, { borrowing: 0, abatement: 1 }))).toBeCloseTo(0.5, 10)
    installed('P1', 0)
  })

  it('votes yes when the draw falls under the chance', () => {
    installed('P1', 0)
    expect(ruleVote(s.state, 'P1', rule(0.07), 0.69)).toBe('yes')
    expect(ruleVote(s.state, 'P1', rule(0.07), 0.71)).toBe('no')
    expect(ruleVote(s.state, 'P1', rule(0.05), 0)).toBe('no') // a chance of 0 never says yes
    installed('P1', 1)
    expect(ruleVote(s.state, 'P1', rule(0.07), 0.999999)).toBe('yes') // a chance of 1 always does
    installed('P1', 0)
  })

  it('draws each vote from the seed, the referendum and the company alone', () => {
    const d = voteDraw(7, 1, 'P3')
    expect(d).toBe(voteDraw(7, 1, 'P3'))
    expect(d).toBeGreaterThanOrEqual(0)
    expect(d).toBeLessThan(1)
    expect(new Set([voteDraw(7, 1, 'P4'), voteDraw(7, 2, 'P3'), voteDraw(8, 1, 'P3'), d]).size).toBe(4)
    // Uniform enough that a 0.7 chance comes out near 70% over many companies.
    const n = 4000
    let yes = 0
    for (let i = 0; i < n; i++) if (voteDraw(11, 3, `P${i}`) < 0.7) yes++
    expect(Math.abs(yes / n - 0.7)).toBeLessThan(0.03)
  })

  it('reads the weights and the pivot from the config, and refuses bad ones', () => {
    expect(resolveConfig().market.referendum).toMatchObject({
      ruleWeights: { borrowing: 0.7, abatement: 0.3 },
      abatementPivot: 0.5,
    })
    const bad = (referendum: object) => () => resolveConfig({ market: { referendum } })
    expect(bad({ ruleWeights: { borrowing: -1 } })).toThrow(/ruleWeights/)
    expect(bad({ ruleWeights: { borrowing: 0, abatement: 0 } })).toThrow(/ruleWeights/)
    expect(bad({ abatementPivot: 1 })).toThrow(/abatementPivot/)
    expect(bad({ abatementPivot: 0 })).toThrow(/abatementPivot/)
    expect(resolveConfig({ market: { referendum: { ruleWeights: { borrowing: 1, abatement: 0 } } } }).market.referendum.ruleWeights)
      .toEqual({ borrowing: 1, abatement: 0 })
  })

  it('holding a referendum moves no other number in a seeded game', () => {
    const play = (vote: boolean) => {
      const g = new Session('hybrid', 21)
      g.addPlayer('Alice', 'Power & Utilities')
      for (let i = 0; i < 6; i++) g.addBot('compliance')
      g.startYear()
      toSummary(g)
      if (vote) {
        g.openReferendum({ chatSeconds: 0 }, 1_000_000)
        stepBots(g, createRng(1), () => ({}))
        expect(Object.keys(g.state.referendum!.votes)).toHaveLength(6)
      }
      // The session's own stream is private; reaching in is the point of this check.
      return (g as unknown as { rng: { next(): number } }).rng.next()
    }
    expect(play(true)).toBe(play(false))
  })

  it('counts a simple majority of the votes cast; a tie fails', () => {
    const r = { votes: { a: 'yes', b: 'no', c: 'yes' } } as unknown as Referendum
    expect(tally(r, ['a', 'b', 'c', 'd'])).toEqual({ approved: true, yes: 2, no: 1, eligible: 4 })
    expect(tally({ votes: { a: 'yes', b: 'no' } } as unknown as Referendum, ['a', 'b'])).toMatchObject({ approved: false })
  })
})
