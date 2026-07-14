import { describe, expect, it } from 'vitest'
import { grantRegulator } from '../regulator'

describe('grantRegulator', () => {
  it('grants everything when the pool covers total requests', () => {
    const granted = grantRegulator({ P1: 50, P2: 30 }, 100)
    expect(granted).toEqual({ P1: 50, P2: 30 })
  })

  it('pro-rates when requests exceed the pool', () => {
    const granted = grantRegulator({ P1: 150, P2: 50 }, 100)
    expect(granted.P1).toBe(75)
    expect(granted.P2).toBe(25)
  })

  it('handles zero requests without dividing by zero', () => {
    expect(grantRegulator({ P1: 0, P2: 0 }, 100)).toEqual({ P1: 0, P2: 0 })
  })

  it('rounds grants to one decimal place', () => {
    const granted = grantRegulator({ P1: 100, P2: 100, P3: 100 }, 100)
    for (const v of Object.values(granted)) {
      expect(v).toBeCloseTo(33.3, 5)
    }
  })
})
