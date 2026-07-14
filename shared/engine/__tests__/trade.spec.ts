import { describe, expect, it } from 'vitest'
import { computeNetPositions } from '../trade'

describe('computeNetPositions', () => {
  it('is realized − credits held, per player', () => {
    const net = computeNetPositions(
      { P1: 309.4, P2: 1112.3 },
      { P1: 236.8, P2: 1036.6 },
    )
    expect(net.P1).toBeCloseTo(309.4 - 236.8, 6)
    expect(net.P2).toBeCloseTo(1112.3 - 1036.6, 6)
  })

  it('treats missing holdings as zero', () => {
    const net = computeNetPositions({ P1: 100 }, {})
    expect(net.P1).toBeCloseTo(100, 6)
  })
})
