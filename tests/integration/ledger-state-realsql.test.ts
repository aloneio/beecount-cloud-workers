import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import writeRouter from '../../src/routes/write'
import workspaceRouter from '../../src/routes/workspace'
import { initializeDatabase } from '../../src/db/schema'
import { createRealDb } from '../helpers/realsql-db'

let sqlite: DatabaseSync
let db: D1Database
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>

beforeEach(async () => {
  const real = createRealDb()
  sqlite = real.sqlite
  db = real.db
  await initializeDatabase(db)
  sqlite.prepare("INSERT INTO users (id,email,password_hash,is_admin,is_enabled) VALUES ('owner','owner@example.com','x',0,1)").run()
  sqlite.prepare("INSERT INTO users (id,email,password_hash,is_admin,is_enabled) VALUES ('member','member@example.com','x',0,1)").run()
  sqlite.prepare("INSERT INTO ledgers (id,user_id,external_id,name,currency,month_start_day) VALUES ('ledger-internal','owner','ledger-ext','Original','USD',15)").run()
  sqlite.prepare("INSERT INTO ledger_members (ledger_id,user_id,role) VALUES ('ledger-internal','owner','owner')").run()
  sqlite.prepare("INSERT INTO ledger_members (ledger_id,user_id,role) VALUES ('ledger-internal','member','editor')").run()

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>()
  app.use('*', async (c, next) => { c.set('userId', 'owner'); await next() })
  app.route('/api/v1/write', writeRouter)
  app.route('/api/v1/read/workspace', workspaceRouter)
})

afterEach(() => sqlite.close())

describe('ledger state transitions on real SQLite', () => {
  it('PATCH metadata preserves omitted fields and emits the real change id', async () => {
    const res = await app.request('/api/v1/write/ledgers/ledger-ext/meta', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ledger_name: 'Renamed' }),
    }, { DB: db })
    expect(res.status).toBe(200)
    const body = await res.json() as { new_change_id: number }
    expect(body.new_change_id).toBeGreaterThan(0)
    expect(sqlite.prepare("SELECT name,currency,month_start_day FROM ledgers WHERE id='ledger-internal'").get())
      .toEqual({ name: 'Renamed', currency: 'USD', month_start_day: 15 })
    const change = sqlite.prepare('SELECT payload_json FROM sync_changes WHERE change_id=?').get(body.new_change_id) as { payload_json: string }
    expect(JSON.parse(change.payload_json)).toMatchObject({ ledgerName: 'Renamed', currency: 'USD', monthStartDay: 15 })
  })

  it('ownership transfer keeps both membership rows coherent', async () => {
    const res = await app.request('/api/v1/read/workspace/ledgers/ledger-ext/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_user_id: 'member' }),
    }, { DB: db })
    expect(res.status).toBe(200)
    expect(sqlite.prepare("SELECT user_id FROM ledgers WHERE id='ledger-internal'").get()).toEqual({ user_id: 'member' })
    expect(sqlite.prepare("SELECT role FROM ledger_members WHERE ledger_id='ledger-internal' AND user_id='member'").get()).toEqual({ role: 'owner' })
    expect(sqlite.prepare("SELECT role FROM ledger_members WHERE ledger_id='ledger-internal' AND user_id='owner'").get()).toEqual({ role: 'editor' })
    expect(sqlite.prepare("SELECT COUNT(*) n FROM ledger_members WHERE ledger_id='ledger-internal'").get()).toEqual({ n: 2 })
  })

  it('rolls back ownership transfer if any membership update fails', async () => {
    sqlite.exec("CREATE TRIGGER fail_new_owner BEFORE UPDATE OF role ON ledger_members WHEN NEW.user_id='member' AND NEW.role='owner' BEGIN SELECT RAISE(ABORT, 'role failed'); END")
    const res = await app.request('/api/v1/read/workspace/ledgers/ledger-ext/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_user_id: 'member' }),
    }, { DB: db })
    expect(res.status).toBe(500)
    expect(sqlite.prepare("SELECT user_id FROM ledgers WHERE id='ledger-internal'").get()).toEqual({ user_id: 'owner' })
    expect(sqlite.prepare("SELECT role FROM ledger_members WHERE ledger_id='ledger-internal' AND user_id='member'").get()).toEqual({ role: 'editor' })
    expect(sqlite.prepare("SELECT role FROM ledger_members WHERE ledger_id='ledger-internal' AND user_id='owner'").get()).toEqual({ role: 'owner' })
  })
})
