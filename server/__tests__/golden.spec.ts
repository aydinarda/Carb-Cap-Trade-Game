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
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": null,
        "banked": {
          "P1": 78.5,
          "P2": -14,
          "P3": -8,
        },
        "freeAllocation": {
          "P1": 911,
          "P2": 174.8,
          "P3": 771.8,
        },
        "netPosition": {
          "P1": -78.5,
          "P2": 14,
          "P3": 8,
        },
        "optimalScore": {
          "P1": -1178.5,
          "P2": 254.5,
          "P3": 2217.1,
        },
        "primaryPrice": 10,
        "realized": {
          "P1": 792.5,
          "P2": 188.8,
          "P3": 819.8,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 954.9,
          "P2": 280,
          "P3": 1569.4,
        },
        "settlement": {
          "P1": {
            "abatementCost": 1434.9,
            "penaltyCost": 0,
            "purchaseCost": 0,
            "sellIncome": 480,
            "shortage": 0,
            "yearCost": 954.9,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 280,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 14,
            "yearCost": 280,
          },
          "P3": {
            "abatementCost": 929.4,
            "penaltyCost": 160,
            "purchaseCost": 480,
            "sellIncome": 0,
            "shortage": 8,
            "yearCost": 1569.4,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": null,
        "banked": {
          "P1": 307.5,
          "P2": -26.7,
          "P3": -3.6,
        },
        "freeAllocation": {
          "P1": 900.7,
          "P2": 176.2,
          "P3": 780.7,
        },
        "netPosition": {
          "P1": -307.5,
          "P2": 26.7,
          "P3": 3.6,
        },
        "optimalScore": {
          "P1": -5118.6,
          "P2": 174.4,
          "P3": 2467.7,
        },
        "primaryPrice": 12,
        "realized": {
          "P1": 631.7,
          "P2": 188.9,
          "P3": 816.3,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 1485.3,
          "P2": 814,
          "P3": 2900.2,
        },
        "settlement": {
          "P1": {
            "abatementCost": 1010.4,
            "penaltyCost": 0,
            "purchaseCost": 0,
            "sellIncome": 480,
            "shortage": 0,
            "yearCost": 530.4,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 534,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 26.7,
            "yearCost": 534,
          },
          "P3": {
            "abatementCost": 778.8,
            "penaltyCost": 72,
            "purchaseCost": 480,
            "sellIncome": 0,
            "shortage": 3.6,
            "yearCost": 1330.8,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 1857.6,
          "totalRealized": 1801.1,
          "year": 11,
        },
        {
          "cap": 1857.6,
          "totalRealized": 1636.9,
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
          "P1": -232.5,
          "P2": -8.8,
          "P3": -299.8,
        },
        "freeAllocation": {
          "P1": 600,
          "P2": 180,
          "P3": 480,
        },
        "netPosition": {
          "P1": 232.5,
          "P2": 8.8,
          "P3": 299.8,
        },
        "optimalScore": {
          "P1": 2553.5,
          "P2": 192.1,
          "P3": 5718.7,
        },
        "primaryPrice": 10,
        "realized": {
          "P1": 792.5,
          "P2": 188.8,
          "P3": 819.8,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 5604.9,
          "P2": 176,
          "P3": 7405.4,
        },
        "settlement": {
          "P1": {
            "abatementCost": 1434.9,
            "penaltyCost": 4650,
            "purchaseCost": 0,
            "sellIncome": 480,
            "shortage": 232.5,
            "yearCost": 5604.9,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 176,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 8.8,
            "yearCost": 176,
          },
          "P3": {
            "abatementCost": 929.4,
            "penaltyCost": 5996,
            "purchaseCost": 480,
            "sellIncome": 0,
            "shortage": 299.8,
            "yearCost": 7405.4,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": null,
        "banked": {
          "P1": -322.2,
          "P2": -23.1,
          "P3": -610.5,
        },
        "freeAllocation": {
          "P1": 582,
          "P2": 174.6,
          "P3": 465.6,
        },
        "netPosition": {
          "P1": 322.2,
          "P2": 23.1,
          "P3": 610.5,
        },
        "optimalScore": {
          "P1": 2437.8,
          "P2": 131.2,
          "P3": 9750.5,
        },
        "primaryPrice": 12,
        "realized": {
          "P1": 631.7,
          "P2": 188.9,
          "P3": 816.3,
        },
        "regulatorGranted": {},
        "regulatorPool": 0,
        "score": {
          "P1": 12579.3,
          "P2": 638,
          "P3": 20874.2,
        },
        "settlement": {
          "P1": {
            "abatementCost": 1010.4,
            "penaltyCost": 6444,
            "purchaseCost": 0,
            "sellIncome": 480,
            "shortage": 322.2,
            "yearCost": 6974.4,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 462,
            "purchaseCost": 0,
            "sellIncome": 0,
            "shortage": 23.1,
            "yearCost": 462,
          },
          "P3": {
            "abatementCost": 778.8,
            "penaltyCost": 12210,
            "purchaseCost": 480,
            "sellIncome": 0,
            "shortage": 610.5,
            "yearCost": 13468.8,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 1260,
          "totalRealized": 1801.1,
          "year": 11,
        },
        {
          "cap": 1222.2,
          "totalRealized": 1636.9,
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
        "auctionPrice": 9,
        "banked": {
          "P1": 67.5,
          "P2": 111.2,
          "P3": -79.8,
        },
        "freeAllocation": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "netPosition": {
          "P1": -67.5,
          "P2": -111.2,
          "P3": 79.8,
        },
        "optimalScore": {
          "P1": -1046.5,
          "P2": -1247.9,
          "P3": 3078.7,
        },
        "primaryPrice": 9,
        "realized": {
          "P1": 792.5,
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
          "P1": 9054.9,
          "P2": 2700,
          "P3": 9305.4,
        },
        "settlement": {
          "P1": {
            "abatementCost": 1434.9,
            "penaltyCost": 0,
            "purchaseCost": 8100,
            "sellIncome": 480,
            "shortage": 0,
            "yearCost": 9054.9,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 0,
            "purchaseCost": 2700,
            "sellIncome": 0,
            "shortage": 0,
            "yearCost": 2700,
          },
          "P3": {
            "abatementCost": 929.4,
            "penaltyCost": 1596,
            "purchaseCost": 6780,
            "sellIncome": 0,
            "shortage": 79.8,
            "yearCost": 9305.4,
          },
        },
      }
    `)
    playYear(s, false)
    expect(capture(s)).toMatchInlineSnapshot(`
      {
        "auctionPrice": 9,
        "banked": {
          "P1": 295.8,
          "P2": 222.3,
          "P3": -156.1,
        },
        "freeAllocation": {
          "P1": 0,
          "P2": 0,
          "P3": 0,
        },
        "netPosition": {
          "P1": -295.8,
          "P2": -222.3,
          "P3": 156.1,
        },
        "optimalScore": {
          "P1": -4978.2,
          "P2": -2813.6,
          "P3": 4297.7,
        },
        "primaryPrice": 9,
        "realized": {
          "P1": 631.7,
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
          "P1": 17685.3,
          "P2": 5400,
          "P3": 19986.2,
        },
        "settlement": {
          "P1": {
            "abatementCost": 1010.4,
            "penaltyCost": 0,
            "purchaseCost": 8100,
            "sellIncome": 480,
            "shortage": 0,
            "yearCost": 8630.4,
          },
          "P2": {
            "abatementCost": 0,
            "penaltyCost": 0,
            "purchaseCost": 2700,
            "sellIncome": 0,
            "shortage": 0,
            "yearCost": 2700,
          },
          "P3": {
            "abatementCost": 778.8,
            "penaltyCost": 3122,
            "purchaseCost": 6780,
            "sellIncome": 0,
            "shortage": 156.1,
            "yearCost": 10680.8,
          },
        },
      }
    `)
    expect(hostSnapshot(s).classAggregate.yearHistory).toMatchInlineSnapshot(`
      [
        {
          "cap": 2322,
          "totalRealized": 1801.1,
          "year": 11,
        },
        {
          "cap": 2252.3,
          "totalRealized": 1636.9,
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
        "primaryPrice": 10,
        "seed": {
          "mm": 216,
          "spec": 20,
        },
      }
    `)
  })
})
