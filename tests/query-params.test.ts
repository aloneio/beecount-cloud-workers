import { describe, expect, it } from 'vitest'
import { boundedInt, finiteNumber } from '../src/lib/query-params'

describe('query parameter bounds', () => {
  it('prevents negative LIMIT/OFFSET style values from escaping bounds', () => {
    expect(boundedInt('-1', 50, 1, 200)).toBe(1)
    expect(boundedInt('999999', 50, 1, 200)).toBe(200)
    expect(boundedInt('abc', 50, 1, 200)).toBe(50)
    expect(boundedInt('-10', 0, 0, 1_000_000)).toBe(0)
  })

  it('accepts only finite numeric filters', () => {
    expect(finiteNumber('12.5')).toBe(12.5)
    expect(finiteNumber('Infinity')).toBeNull()
    expect(finiteNumber('NaN')).toBeNull()
    expect(finiteNumber('')).toBeNull()
  })
})
