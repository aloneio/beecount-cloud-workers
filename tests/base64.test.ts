import { describe, expect, it } from 'vitest'
import { bytesToBase64 } from '../src/lib/base64'

describe('bytesToBase64', () => {
  it('encodes multi-megabyte input without argument spreading', () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 7)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
    const encoded = bytesToBase64(bytes)
    expect(encoded.length).toBeGreaterThan(bytes.length)
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    expect(decoded.length).toBe(bytes.length)
    expect(decoded[0]).toBe(bytes[0])
    expect(decoded[1024 * 1024 + 3]).toBe(bytes[1024 * 1024 + 3])
    expect(decoded.at(-1)).toBe(bytes.at(-1))
  })
})
