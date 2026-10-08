import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import authRouter from '../../src/routes/auth'
import { initializeDatabase } from '../../src/db/schema'
import { createRealDb } from '../helpers/realsql-db'

let sqlite: DatabaseSync
let db: D1Database
let app: Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string; REGISTRATION_ENABLED?: string } }>

beforeEach(async () => {
  const real = createRealDb()
  sqlite = real.sqlite
  db = real.db
  await initializeDatabase(db)
  app = new Hono()
  app.route('/api/v1/auth', authRouter)
})

afterEach(() => sqlite.close())

async function register(email: string, deviceId = 'device-new') {
  return app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.8' },
    body: JSON.stringify({
      email,
      password: 'password123',
      device_id: deviceId,
      device_name: 'Browser',
      platform: 'web',
    }),
  }, { DB: db, JWT_SECRET: 'test-secret-that-is-long-enough', REGISTRATION_ENABLED: 'true' })
}

describe('auth register on real SQLite', () => {
  it('creates exactly one user/profile/device/refresh token atomically', async () => {
    const res = await register('real-register@example.com')
    expect(res.status).toBe(200)
    const body = await res.json() as { user: { id: string }; device_id: string; access_token: string; refresh_token: string }

    expect(body.access_token).toBeTruthy()
    expect(body.refresh_token).toBeTruthy()
    expect(body.device_id).toBe('device-new')
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('real-register@example.com')).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM user_profiles WHERE user_id = ?').get(body.user.id)).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').get(body.user.id)).toEqual({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ?').get(body.user.id)).toEqual({ n: 1 })
  })

  it('mints a new device id when the requested id already belongs to another user', async () => {
    sqlite.prepare("INSERT INTO users (id,email,password_hash,is_admin,is_enabled) VALUES ('existing-user','existing@example.com','x',0,1)").run()
    sqlite.prepare("INSERT INTO devices (id,user_id,name,platform,last_seen_at) VALUES ('shared-device','existing-user','Old','web','2026-01-01T00:00:00Z')").run()

    const res = await register('collision@example.com', 'shared-device')
    expect(res.status).toBe(200)
    const body = await res.json() as { device_id: string; user: { id: string } }
    expect(body.device_id).not.toBe('shared-device')
    expect(sqlite.prepare('SELECT user_id FROM devices WHERE id = ?').get('shared-device')).toEqual({ user_id: 'existing-user' })
    expect(sqlite.prepare('SELECT user_id FROM devices WHERE id = ?').get(body.device_id)).toEqual({ user_id: body.user.id })
  })
})
