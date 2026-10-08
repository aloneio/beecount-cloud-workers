import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import setupRouter from '../../src/routes/setup'
import { initializeDatabase } from '../../src/db/schema'
import { createRealDb } from '../helpers/realsql-db'
import { parseTransactionDatetime } from '../../src/routes/mcp'

let sqlite: DatabaseSync
let db: D1Database
let app: Hono<{ Bindings: { DB: D1Database } }>

beforeEach(async () => {
  const real = createRealDb()
  sqlite = real.sqlite
  db = real.db
  await initializeDatabase(db)
  app = new Hono()
  app.route('/api/v1/setup', setupRouter)
})

afterEach(() => sqlite.close())

async function setup(email = 'admin@example.com') {
  return app.request('/api/v1/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      admin_mode: 'manual',
      admin_email: email,
      admin_password: 'strong-password',
      timezone_offset: -480,
    }),
  }, { DB: db })
}

describe('setup on real SQLite', () => {
  it('commits setup settings, admin and profile together', async () => {
    const res = await setup()
    expect(res.status).toBe(200)
    expect(sqlite.prepare("SELECT setup_completed, timezone_offset FROM system_settings WHERE id='default'").get()).toEqual({ setup_completed: 1, timezone_offset: -480 })
    const admin = sqlite.prepare("SELECT id,email,is_admin FROM users WHERE email='admin@example.com'").get() as { id: string; email: string; is_admin: number }
    expect(admin.is_admin).toBe(1)
    expect(sqlite.prepare('SELECT COUNT(*) n FROM user_profiles WHERE user_id=?').get(admin.id)).toEqual({ n: 1 })
    await expect(parseTransactionDatetime(db, {}, '2026-10-03T12:00')).resolves.toBe('2026-10-03T04:00:00.000Z')

    const second = await setup('other@example.com')
    expect(second.status).toBe(403)
    expect(sqlite.prepare('SELECT COUNT(*) n FROM users WHERE is_admin=1').get()).toEqual({ n: 1 })
  })

  it('rolls back the whole setup if profile creation fails', async () => {
    sqlite.exec("CREATE TRIGGER fail_setup_profile BEFORE INSERT ON user_profiles BEGIN SELECT RAISE(ABORT, 'profile failed'); END")
    const res = await setup('rollback@example.com')
    expect(res.status).toBe(500)
    expect(sqlite.prepare("SELECT COUNT(*) n FROM users WHERE email='rollback@example.com'").get()).toEqual({ n: 0 })
    expect(sqlite.prepare("SELECT COUNT(*) n FROM system_settings WHERE id='default' AND setup_completed=1").get()).toEqual({ n: 0 })
  })
})
