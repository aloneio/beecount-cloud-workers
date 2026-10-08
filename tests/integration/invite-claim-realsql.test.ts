import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import workspaceRouter from '../../src/routes/workspace'
import { initializeDatabase } from '../../src/db/schema'
import { createRealDb } from '../helpers/realsql-db'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(async () => {
  const real = createRealDb()
  sqlite = real.sqlite
  db = real.db
  await initializeDatabase(db)
  for (const [id, email] of [['owner','owner@example.com'],['u2','u2@example.com'],['u3','u3@example.com'],['u4','u4@example.com'],['u5','u5@example.com'],['u6','u6@example.com']]) {
    sqlite.prepare('INSERT INTO users (id,email,password_hash,is_enabled) VALUES (?,?,?,1)').run(id, email, 'x')
  }
  sqlite.prepare("INSERT INTO ledgers (id,user_id,external_id,name,currency) VALUES ('ledger','owner','ledger-ext','Shared','CNY')").run()
  sqlite.prepare("INSERT INTO ledger_members (ledger_id,user_id,role) VALUES ('ledger','owner','owner')").run()
})

afterEach(() => sqlite.close())

function appFor(userId: string) {
  const app = new Hono<{ Bindings: { DB: D1Database; BEECOUNT_DO?: DurableObjectNamespace }; Variables: { userId: string } }>()
  app.use('*', async (c, next) => { c.set('userId', userId); await next() })
  app.route('/api/v1', workspaceRouter)
  return app
}

function addInvite(code: string) {
  sqlite.prepare("INSERT INTO ledger_invites (code,ledger_id,invited_by,target_role,expires_at) VALUES (?,'ledger','owner','editor','2099-01-01T00:00:00Z')").run(code)
}

async function join(userId: string, code: string) {
  return appFor(userId).request('/api/v1/ledgers/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.20' },
    body: JSON.stringify({ invite_code: code }),
  }, { DB: db } as any)
}

describe('invite claim transaction on real SQLite', () => {
  it('allows a single user to consume a single-use invite exactly once', async () => {
    addInvite('ABC234')
    expect((await join('u2','ABC234')).status).toBe(200)
    expect((await join('u3','ABC234')).status).toBe(410)
    expect(sqlite.prepare("SELECT user_id,role FROM ledger_members WHERE ledger_id='ledger' ORDER BY user_id").all())
      .toEqual([{ user_id:'owner', role:'owner' }, { user_id:'u2', role:'editor' }])
    expect(sqlite.prepare("SELECT used_by FROM ledger_invites WHERE code='ABC234'").get()).toEqual({ used_by:'u2' })
  })

  it('does not consume an invite when the member cap is already reached', async () => {
    for (const id of ['u2','u3','u4','u5']) sqlite.prepare("INSERT INTO ledger_members (ledger_id,user_id,role) VALUES ('ledger',?,'editor')").run(id)
    addInvite('CAP234')
    expect((await join('u6','CAP234')).status).toBe(400)
    expect(sqlite.prepare("SELECT used_at,used_by FROM ledger_invites WHERE code='CAP234'").get()).toEqual({ used_at:null, used_by:null })
    expect(sqlite.prepare("SELECT COUNT(*) n FROM ledger_members WHERE ledger_id='ledger'").get()).toEqual({ n:5 })
  })

  it('rolls back invite consumption if membership insertion fails', async () => {
    addInvite('ERR234')
    sqlite.exec("CREATE TRIGGER fail_member BEFORE INSERT ON ledger_members WHEN NEW.user_id='u2' BEGIN SELECT RAISE(ABORT, 'member insert failed'); END")
    expect((await join('u2','ERR234')).status).toBe(500)
    expect(sqlite.prepare("SELECT used_at,used_by FROM ledger_invites WHERE code='ERR234'").get()).toEqual({ used_at:null, used_by:null })
    expect(sqlite.prepare("SELECT COUNT(*) n FROM ledger_members WHERE ledger_id='ledger' AND user_id='u2'").get()).toEqual({ n:0 })
  })
})
