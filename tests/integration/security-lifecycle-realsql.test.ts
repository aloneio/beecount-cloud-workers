import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import * as OTPAuth from 'otpauth'
import twoFactorRouter from '../../src/routes/two_factor'
import profileRouter from '../../src/routes/profile'
import devicesRouter from '../../src/routes/devices'
import { createAccessToken, hashPassword, verifyPassword } from '../../src/auth'
import { initializeDatabase } from '../../src/db/schema'
import { createRealDb } from '../helpers/realsql-db'

let sqlite: DatabaseSync
let db: D1Database
const secret = 'test-secret-that-is-long-enough'
const userId = 'security-user'

beforeEach(async () => {
  const real = createRealDb()
  sqlite = real.sqlite
  db = real.db
  await initializeDatabase(db)
  const passwordHash = await hashPassword('old-password')
  sqlite.prepare('INSERT INTO users (id,email,password_hash,is_admin,is_enabled) VALUES (?,?,?,?,1)')
    .run(userId, 'security@example.com', passwordHash, 0)
  sqlite.prepare("INSERT INTO user_profiles (user_id,display_name) VALUES (?, 'Security')").run(userId)
})

afterEach(() => sqlite.close())

function codeFor(secretBase32: string): string {
  return new OTPAuth.TOTP({ issuer: 'BeeCount', secret: OTPAuth.Secret.fromBase32(secretBase32) }).generate()
}

function twoFaApp() {
  const app = new Hono<{ Bindings: { DB: D1Database; JWT_SECRET: string }; Variables: { userId: string } }>()
  app.route('/2fa', twoFactorRouter)
  return app
}

async function authHeader() {
  return { Authorization: `Bearer ${await createAccessToken(userId, secret)}`, 'Content-Type': 'application/json' }
}

async function setupTwoFa(app = twoFaApp()) {
  const setup = await app.request('/2fa/setup', { method: 'POST', headers: await authHeader() }, { DB: db, JWT_SECRET: secret })
  expect(setup.status).toBe(200)
  return (await setup.json() as { secret: string }).secret
}

describe('security lifecycle on real SQLite', () => {
  it('rolls back 2FA enable if recovery-code insertion fails', async () => {
    const app = twoFaApp()
    const totpSecret = await setupTwoFa(app)
    sqlite.exec("CREATE TRIGGER fail_recovery_insert BEFORE INSERT ON recovery_codes BEGIN SELECT RAISE(ABORT, 'recovery failed'); END")

    const res = await app.request('/2fa/confirm', {
      method: 'POST', headers: await authHeader(), body: JSON.stringify({ code: codeFor(totpSecret) }),
    }, { DB: db, JWT_SECRET: secret })
    expect(res.status).toBe(500)
    expect(sqlite.prepare('SELECT totp_enabled FROM users WHERE id=?').get(userId)).toEqual({ totp_enabled: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) n FROM recovery_codes WHERE user_id=?').get(userId)).toEqual({ n: 0 })
  })

  it('rolls back recovery-code regeneration if replacement insertion fails', async () => {
    const app = twoFaApp()
    const totpSecret = await setupTwoFa(app)
    const confirm = await app.request('/2fa/confirm', {
      method: 'POST', headers: await authHeader(), body: JSON.stringify({ code: codeFor(totpSecret) }),
    }, { DB: db, JWT_SECRET: secret })
    expect(confirm.status).toBe(200)
    const before = sqlite.prepare('SELECT code_hash FROM recovery_codes WHERE user_id=? ORDER BY id').all(userId)
    expect(before.length).toBe(10)

    sqlite.exec("CREATE TRIGGER fail_recovery_replace BEFORE INSERT ON recovery_codes BEGIN SELECT RAISE(ABORT, 'replacement failed'); END")
    const regen = await app.request('/2fa/recovery-codes/regenerate', {
      method: 'POST', headers: await authHeader(), body: JSON.stringify({ code: codeFor(totpSecret) }),
    }, { DB: db, JWT_SECRET: secret })
    expect(regen.status).toBe(500)
    expect(sqlite.prepare('SELECT code_hash FROM recovery_codes WHERE user_id=? ORDER BY id').all(userId)).toEqual(before)
  })

  it('changes password and revokes all refresh tokens atomically', async () => {
    sqlite.prepare("INSERT INTO devices (id,user_id,name,platform,last_seen_at) VALUES ('d1',?,'Browser','web','2026-01-01T00:00:00Z')").run(userId)
    sqlite.prepare("INSERT INTO refresh_tokens (id,user_id,device_id,token_hash,expires_at) VALUES ('r1',?,'d1','hash1','2099-01-01T00:00:00Z')").run(userId)

    const app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>()
    app.use('*', async (c, next) => { c.set('userId', userId); await next() })
    app.route('/profile', profileRouter)
    const res = await app.request('/profile/me/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_password: 'old-password', new_password: 'new-password-123' }),
    }, { DB: db })
    expect(res.status).toBe(200)
    const row = sqlite.prepare('SELECT password_hash FROM users WHERE id=?').get(userId) as { password_hash: string }
    await expect(verifyPassword(row.password_hash, 'new-password-123')).resolves.toBe(true)
    expect((sqlite.prepare("SELECT revoked_at FROM refresh_tokens WHERE id='r1'").get() as { revoked_at: string | null }).revoked_at).toBeTruthy()
  })

  it('rolls back device revocation if refresh-token revocation fails', async () => {
    sqlite.prepare("INSERT INTO devices (id,user_id,name,platform,last_seen_at) VALUES ('d1',?,'Browser','web','2026-01-01T00:00:00Z')").run(userId)
    sqlite.prepare("INSERT INTO refresh_tokens (id,user_id,device_id,token_hash,expires_at) VALUES ('r1',?,'d1','hash1','2099-01-01T00:00:00Z')").run(userId)
    sqlite.exec("CREATE TRIGGER fail_refresh_revoke BEFORE UPDATE OF revoked_at ON refresh_tokens BEGIN SELECT RAISE(ABORT, 'revoke failed'); END")

    const app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>()
    app.use('*', async (c, next) => { c.set('userId', userId); await next() })
    app.route('/devices', devicesRouter)
    const res = await app.request('/devices/d1/revoke', { method: 'POST' }, { DB: db })
    expect(res.status).toBe(500)
    expect(sqlite.prepare("SELECT revoked_at FROM devices WHERE id='d1'").get()).toEqual({ revoked_at: null })
  })
})
