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
    s.submitBid('P1', 900, 70)
    s.submitBid('P2', 300, 45)
    s.submitBid('P3', 700, 55)
  }
  s.closeCapStage()
  s.openTrade()
  // 0.2 is the shipped ceiling (abatement.maxFraction) — asking for more here would be
  // silently clamped, which would make this test pin a number nobody chose.
  s.setAbatement('P1', 0.2)
  s.setAbatement('P3', 0.1)
  s.placeOrder('P1', 'sell', 40, 60)
  s.placeOrder('P3', 'buy', 40, 60) // crosses → one trade at the resting price
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
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": null,
        "banked": {
          "P1": -34.7,
          "P2": -14,
          "P3": -8,
        },
        "freeAllocation": {
          "P1": 911,
          "P2": 174.8,
          "P3": 771.8,
        },
        "netPosition": {
          "P1": 34.7,
          "P2": 14,
          "P3": 8,
        },
        "optimalScore": {
          "P1": 3298.1,
          "P2": 1518.5,
          "P3": 11085.6,
        },
        "primaryPrice": 50,
        "realized": {
          "P1": 905.7,
          "P2": 188.8,
          "P3": 819.8,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 5008.9,
          "P2": 1400,
          "P3": 7846.9,
        },
        "settlement": {
          "P1": {
            "abatementCost": 3938.9,
            "penaltyCost": 3470,
            "purchaseCost": 0,
            "sellIncome": 2400,
            "shortage": 34.7,
            "yearCost": 5008.9,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 1400,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 14,
            "yearCost": 1400,
          },
          "P3": {
            "abatementCost": 4646.9,
            "penaltyCost": 800,
            "purchaseCost": 2400,
            "sellIncome": 0,
            "shortage": 8,
            "yearCost": 7846.9,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": null,
        "banked": {
          "P1": 5.9,
          "P2": -27.6,
          "P3": -7.7,
        },
        "freeAllocation": {
          "P1": 905.7,
          "P2": 175.3,
          "P3": 776.6,
        },
        "netPosition": {
          "P1": -5.9,
          "P2": 27.6,
          "P3": 7.7,
        },
        "optimalScore": {
          "P1": -2318.3,
          "P2": 2224.5,
          "P3": 13064.5,
        },
        "primaryPrice": 60,
        "realized": {
          "P1": 825.1,
          "P2": 188.9,
          "P3": 816.3,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 5778.9,
          "P2": 4160,
          "P3": 14911,
        },
        "settlement": {
          "P1": {
            "abatementCost": 3170,
            "penaltyCost": 0,
            "purchaseCost": 0,
            "sellIncome": 2400,
            "shortage": 0,
            "yearCost": 770,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 2760,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 27.6,
            "yearCost": 2760,
          },
          "P3": {
            "abatementCost": 3894.1,
            "penaltyCost": 770,
            "purchaseCost": 2400,
            "sellIncome": 0,
            "shortage": 7.7,
            "yearCost": 7064.1,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 1857.6,
          "totalRealized": 1914.3,
          "year": 11,
        },
        {
          "cap": 1857.6,
          "totalRealized": 1830.3,
          "year": 12,
        },
      ]
    `)
  })
})

describe('golden — benchmarking', () => {
  it('year 11 and 12 settle to fixed numbers', () => {
    const s = seeded('benchmarking')
    playYear(s, true)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": null,
        "banked": {
          "P1": -345.7,
          "P2": -8.8,
          "P3": -299.8,
        },
        "freeAllocation": {
          "P1": 600,
          "P2": 180,
          "P3": 480,
        },
        "netPosition": {
          "P1": 345.7,
          "P2": 8.8,
          "P3": 299.8,
        },
        "optimalScore": {
          "P1": 21958.1,
          "P2": 1206.5,
          "P3": 28593.6,
        },
        "primaryPrice": 50,
        "realized": {
          "P1": 905.7,
          "P2": 188.8,
          "P3": 819.8,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 36108.9,
          "P2": 880,
          "P3": 37026.9,
        },
        "settlement": {
          "P1": {
            "abatementCost": 3938.9,
            "penaltyCost": 34570,
            "purchaseCost": 0,
            "sellIncome": 2400,
            "shortage": 345.7,
            "yearCost": 36108.9,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 880,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 8.8,
            "yearCost": 880,
          },
          "P3": {
            "abatementCost": 4646.9,
            "penaltyCost": 29980,
            "purchaseCost": 2400,
            "sellIncome": 0,
            "shortage": 299.8,
            "yearCost": 37026.9,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": null,
        "banked": {
          "P1": -628.8,
          "P2": -23.1,
          "P3": -610.5,
        },
        "freeAllocation": {
          "P1": 582,
          "P2": 174.6,
          "P3": 465.6,
        },
        "netPosition": {
          "P1": 628.8,
          "P2": 23.1,
          "P3": 610.5,
        },
        "optimalScore": {
          "P1": 54423.7,
          "P2": 1642.5,
          "P3": 66740.5,
        },
        "primaryPrice": 60,
        "realized": {
          "P1": 825.1,
          "P2": 188.9,
          "P3": 816.3,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 99758.9,
          "P2": 3190,
          "P3": 104371,
        },
        "settlement": {
          "P1": {
            "abatementCost": 3170,
            "penaltyCost": 62880,
            "purchaseCost": 0,
            "sellIncome": 2400,
            "shortage": 628.8,
            "yearCost": 63650,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 2310,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 23.1,
            "yearCost": 2310,
          },
          "P3": {
            "abatementCost": 3894.1,
            "penaltyCost": 61050,
            "purchaseCost": 2400,
            "sellIncome": 0,
            "shortage": 610.5,
            "yearCost": 67344.1,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 1260,
          "totalRealized": 1914.3,
          "year": 11,
        },
        {
          "cap": 1222.2,
          "totalRealized": 1830.3,
          "year": 12,
        },
      ]
    `)
  })
})

describe('golden — auctioning', () => {
  it('year 11 and 12 settle to fixed numbers', () => {
    const s = seeded('auctioning')
    playYear(s, true)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": 45,
        "banked": {
          "P1": -45.7,
          "P2": 111.2,
          "P3": -79.8,
        },
        "freeAllocation": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "netPosition": {
          "P1": 45.7,
          "P2": -111.2,
          "P3": 79.8,
        },
        "optimalScore": {
          "P1": 3958.1,
          "P2": -5993.5,
          "P3": 15393.6,
        },
        "primaryPrice": 45,
        "realized": {
          "P1": 905.7,
          "P2": 188.8,
          "P3": 819.8,
        },
        "regulatorGranted": {
          "P1": 900,
          "P2": 300,
          "P3": 700,
        },
        "regulatorPool": 2322,
        "score": {
          "P1": 46608.9,
          "P2": 13500,
          "P3": 46526.9,
        },
        "settlement": {
          "P1": {
            "abatementCost": 3938.9,
            "penaltyCost": 4570,
            "purchaseCost": 40500,
            "sellIncome": 2400,
            "shortage": 45.7,
            "yearCost": 46608.9,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 0,
            "purchaseCost": 13500,
            "sellIncome": 0,
            "shortage": 0,
            "yearCost": 13500,
          },
          "P3": {
            "abatementCost": 4646.9,
            "penaltyCost": 7980,
            "purchaseCost": 33900,
            "sellIncome": 0,
            "shortage": 79.8,
            "yearCost": 46526.9,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": 45,
        "banked": {
          "P1": -10.8,
          "P2": 222.3,
          "P3": -156.1,
        },
        "freeAllocation": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "netPosition": {
          "P1": 10.8,
          "P2": -222.3,
          "P3": 156.1,
        },
        "optimalScore": {
          "P1": -656.3,
          "P2": -20281.5,
          "P3": 26276.5,
        },
        "primaryPrice": 45,
        "realized": {
          "P1": 825.1,
          "P2": 188.9,
          "P3": 816.3,
        },
        "regulatorGranted": {
          "P1": 900,
          "P2": 300,
          "P3": 700,
        },
        "regulatorPool": 2252.3,
        "score": {
          "P1": 88958.9,
          "P2": 27000,
          "P3": 99931,
        },
        "settlement": {
          "P1": {
            "abatementCost": 3170,
            "penaltyCost": 1080,
            "purchaseCost": 40500,
            "sellIncome": 2400,
            "shortage": 10.8,
            "yearCost": 42350,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 0,
            "purchaseCost": 13500,
            "sellIncome": 0,
            "shortage": 0,
            "yearCost": 13500,
          },
          "P3": {
            "abatementCost": 3894.1,
            "penaltyCost": 15610,
            "purchaseCost": 33900,
            "sellIncome": 0,
            "shortage": 156.1,
            "yearCost": 53404.1,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 2322,
          "totalRealized": 1914.3,
          "year": 11,
        },
        {
          "cap": 2252.3,
          "totalRealized": 1830.3,
          "year": 12,
        },
      ]
    `)
  })
})

describe('golden — generated histories', () => {
  it('the seeded emission histories are exactly these', () => {
    const s = seeded('grandfathering')
    expect(s.state.players.map((p) => ({ id: p.id, emissions: p.emissions }))).toMatchInlineSnapshot(`
      [
        {
          "emissions": {
            "1": 1040.9,
            "10": 1125.4,
            "2": 1005,
            "3": 1048.4,
            "4": 1096.2,
            "5": 1031.1,
            "6": 1061.6,
            "7": 1080.8,
            "8": 1077.3,
            "9": 1080.5,
          },
          "id": "P1",
        },
        {
          "emissions": {
            "1": 198,
            "10": 218.3,
            "2": 181.1,
            "3": 204.9,
            "4": 202,
            "5": 193.3,
            "6": 204.3,
            "7": 208.6,
            "8": 214.4,
            "9": 218.4,
          },
          "id": "P2",
        },
        {
          "emissions": {
            "1": 826.5,
            "10": 978.3,
            "2": 860.6,
            "3": 864,
            "4": 854.7,
            "5": 906.8,
            "6": 911.6,
            "7": 914.3,
            "8": 914.6,
            "9": 989.2,
          },
          "id": "P3",
        },
      ]
    `)
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
    }).toMatchInlineSnapshot(`
      {
        "circulatingCap": 1200,
        "freeAllocation": {
          "P1": 600,
          "P2": 0,
          "P3": 0,
          "P4": 600,
        },
        "primaryPrice": 50,
        "seed": {
          "mm": 216,
          "spec": 20,
        },
      }
    `)
  })
})
