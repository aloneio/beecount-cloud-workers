import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import backupRouter, { createSyncChangesForUser } from '../../src/routes/backup'
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
  sqlite.prepare("INSERT INTO users (id,email,password_hash,is_admin,is_enabled) VALUES ('user-a','a@example.com','x',0,1)").run()
  sqlite.prepare("INSERT INTO users (id,email,password_hash,is_admin,is_enabled) VALUES ('user-b','b@example.com','x',0,1)").run()
  app = new Hono()
  app.use('*', async (c, next) => { c.set('userId', 'user-a'); await next() })
  app.route('/api/v1/backup', backupRouter)
})

afterEach(() => sqlite.close())

describe('backup sync repair on real SQLite', () => {
  it('recreates sync events for global and ledger-scoped projection tables', async () => {
    sqlite.prepare("INSERT INTO ledgers (id,user_id,external_id,name,currency) VALUES ('ledger-a','user-a','ledger-a-ext','A','CNY')").run()
    sqlite.prepare("INSERT INTO user_category_projection (sync_id,user_id,name,kind,level) VALUES ('cat-a','user-a','餐饮','expense',1)").run()
    sqlite.prepare("INSERT INTO user_tag_projection (sync_id,user_id,name) VALUES ('tag-a','user-a','标签')").run()
    sqlite.prepare("INSERT INTO user_account_projection (sync_id,user_id,name,currency) VALUES ('acc-a','user-a','现金','CNY')").run()
    sqlite.prepare("INSERT INTO user_exchange_rate_projection (user_id,sync_id,base_currency,quote_currency,rate,updated_at) VALUES ('user-a','rate-a','USD','CNY','7.0','2026-01-01T00:00:00Z')").run()
    sqlite.prepare("INSERT INTO read_budget_projection (ledger_id,sync_id,user_id,budget_type,amount,period,start_day) VALUES ('ledger-a','budget-a','user-a','category',100,'monthly',1)").run()
    sqlite.prepare("INSERT INTO read_tx_projection (ledger_id,sync_id,user_id,tx_type,amount,happened_at) VALUES ('ledger-a','tx-a','user-a','expense',10,'2026-01-01T00:00:00Z')").run()

    await createSyncChangesForUser(db, 'user-a')

    const types = (sqlite.prepare("SELECT entity_type,scope,ledger_id FROM sync_changes WHERE user_id='user-a' ORDER BY entity_type").all() as Array<{entity_type:string;scope:string;ledger_id:string|null}>)
    expect(types.map((r) => r.entity_type).sort()).toEqual([
      'account', 'budget', 'category', 'exchange_rate_override', 'tag', 'transaction',
    ])
    for (const row of types) {
      const ledgerScoped = row.entity_type === 'budget' || row.entity_type === 'transaction'
      expect(row.scope).toBe(ledgerScoped ? 'ledger' : 'user')
      expect(row.ledger_id).toBe(ledgerScoped ? 'ledger-a' : null)
    }
    expect(sqlite.prepare("SELECT source_change_id FROM user_category_projection WHERE user_id='user-a' AND sync_id='cat-a'").get())
      .not.toEqual({ source_change_id: 0 })
  })

  it('clear-data keeps user-global accounts while removing ledger data', async () => {
    sqlite.prepare("INSERT INTO ledgers (id,user_id,external_id,name,currency) VALUES ('ledger-a','user-a','ledger-a-ext','A','CNY')").run()
    sqlite.prepare("INSERT INTO user_account_projection (sync_id,user_id,name,currency,initial_balance) VALUES ('acc-a','user-a','现金','CNY',100)").run()
    sqlite.prepare("INSERT INTO read_tx_projection (ledger_id,sync_id,user_id,tx_type,amount,happened_at) VALUES ('ledger-a','tx-a','user-a','expense',10,'2026-01-01T00:00:00Z')").run()

    const res = await app.request('/api/v1/backup/clear-data', { method: 'DELETE' }, { DB: db })
    expect(res.status).toBe(200)
    const body = await res.json() as { preserved_accounts: number }
    expect(body.preserved_accounts).toBe(1)
    expect(sqlite.prepare("SELECT COUNT(*) n FROM user_account_projection WHERE user_id='user-a'").get()).toEqual({ n: 1 })
    expect(sqlite.prepare("SELECT COUNT(*) n FROM ledgers WHERE user_id='user-a'").get()).toEqual({ n: 0 })
    expect(sqlite.prepare("SELECT COUNT(*) n FROM read_tx_projection WHERE user_id='user-a'").get()).toEqual({ n: 0 })
  })

  it('fix-data never deletes or rewrites another tenant sync history', async () => {
    sqlite.prepare("INSERT INTO user_category_projection (sync_id,user_id,name,kind,level,source_change_id) VALUES ('cat-a','user-a','A','expense',1,1)").run()
    sqlite.prepare("INSERT INTO user_category_projection (sync_id,user_id,name,kind,level,source_change_id) VALUES ('cat-b','user-b','B','expense',1,2)").run()
    sqlite.prepare("INSERT INTO sync_changes (change_id,user_id,entity_type,entity_sync_id,action,payload_json,updated_at,scope) VALUES (1,'user-a','category','cat-a','upsert','{\"name\":\"A-old\"}','2026-01-01T00:00:00Z','user')").run()
    sqlite.prepare("INSERT INTO sync_changes (change_id,user_id,entity_type,entity_sync_id,action,payload_json,updated_at,scope) VALUES (2,'user-b','category','cat-b','upsert','{\"name\":\"B-original\"}','2026-01-01T00:00:00Z','user')").run()

    const res = await app.request('/api/v1/backup/fix-data', { method: 'POST' }, { DB: db })
    expect(res.status).toBe(200)

    expect(sqlite.prepare("SELECT payload_json FROM sync_changes WHERE change_id=2 AND user_id='user-b'").get())
      .toEqual({ payload_json: '{"name":"B-original"}' })
    expect(sqlite.prepare("SELECT source_change_id FROM user_category_projection WHERE user_id='user-b' AND sync_id='cat-b'").get())
      .toEqual({ source_change_id: 2 })
    const aChange = sqlite.prepare("SELECT change_id FROM sync_changes WHERE user_id='user-a' AND entity_type='category' AND entity_sync_id='cat-a'").get() as { change_id: number }
    expect(aChange.change_id).toBeGreaterThan(2)
    expect(sqlite.prepare("SELECT source_change_id FROM user_category_projection WHERE user_id='user-a' AND sync_id='cat-a'").get())
      .toEqual({ source_change_id: aChange.change_id })
  })
})
