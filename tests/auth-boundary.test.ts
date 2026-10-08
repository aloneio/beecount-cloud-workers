import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { authMiddleware } from '../src/middleware/auth'

function app() {
  const a = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string } }>()
  a.use('/api/v1/*', authMiddleware)
  a.get('/api/v1/mcp', (c) => c.text('mcp-self-auth'))
  a.get('/api/v1/mcp/tools', (c) => c.text('mcp-child-self-auth'))
  a.get('/api/v1/mcp-calls', (c) => c.text('protected-log'))
  a.get('/api/v1/authentic', (c) => c.text('protected-neighbor'))
  return a
}

const env = { DB: {} as D1Database, JWT_SECRET: 'secret' }

describe('auth middleware public-route boundaries', () => {
  it('exempts the MCP route itself and children', async () => {
    expect((await app().request('/api/v1/mcp', undefined, env)).status).toBe(200)
    expect((await app().request('/api/v1/mcp/tools', undefined, env)).status).toBe(200)
  })

  it('does not exempt prefix-collision sibling routes', async () => {
    expect((await app().request('/api/v1/mcp-calls', undefined, env)).status).toBe(401)
    expect((await app().request('/api/v1/authentic', undefined, env)).status).toBe(401)
  })
})
