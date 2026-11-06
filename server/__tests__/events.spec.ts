import { describe, expect, it } from 'vitest'
import { createRng, round1, ruleVote, tally, averageBorrowShare } from '../../shared/engine'
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
    expect(votes[firm.id]).toBe(ruleVote(s.state, firm.id, 0.07))
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

  it('votes against a cap it has been borrowing above, and for it otherwise', () => {
    expect(ruleVote(s.state, 'P1', 0.07)).toBe('yes')
    expect(ruleVote(s.state, 'P1', 0.05)).toBe('no')
    expect(ruleVote(s.state, 'P9', 0.07)).toBe('yes') // no history
  })

  it('counts a simple majority of the votes cast; a tie fails', () => {
    const r = { votes: { a: 'yes', b: 'no', c: 'yes' } } as unknown as Referendum
    expect(tally(r, ['a', 'b', 'c', 'd'])).toEqual({ approved: true, yes: 2, no: 1, eligible: 4 })
    expect(tally({ votes: { a: 'yes', b: 'no' } } as unknown as Referendum, ['a', 'b'])).toMatchObject({ approved: false })
  })
})
