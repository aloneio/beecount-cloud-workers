import { describe, expect, it } from 'vitest'
import { isRateLimitedDistributed } from '../src/lib/rate-limit'

describe('distributed rate limit client', () => {
  it('uses the Durable Object result when the binding is available', async () => {
    let requestedName = ''
    let requestBody: unknown = null
    const namespace = {
      idFromName(name: string) {
        requestedName = name
        return { name }
      },
      get() {
        return {
          async fetch(_url: string, init: RequestInit) {
            requestBody = JSON.parse(String(init.body))
            return Response.json({ limited: true, remaining: 0 })
          },
        }
      },
    } as unknown as DurableObjectNamespace

    const limited = await isRateLimitedDistributed(namespace, 'login', '203.0.113.9', 60, 5)
    expect(limited).toBe(true)
    expect(requestedName).toBe('rate-limit:login:203.0.113.9')
    expect(requestBody).toEqual({ windowSeconds: 60, maxRequests: 5 })
  })

  it('falls back safely when the Durable Object request fails', async () => {
    const namespace = {
      idFromName() { return {} },
      get() { return { fetch: async () => { throw new Error('DO unavailable') } } },
    } as unknown as DurableObjectNamespace

    // Vitest disables the process-local limiter, so the fallback is deterministic
    // here. The important contract is that a DO failure does not throw to callers.
    await expect(isRateLimitedDistributed(namespace, 'login', '203.0.113.10', 60, 5)).resolves.toBe(false)
  })
})
