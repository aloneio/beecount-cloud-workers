import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createRealDb } from '../helpers/realsql-db'
import { initializeDatabase } from '../../src/db/schema'
import { buildExistingSets } from '../../src/services/import_data/stats'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(async () => {
  const real = createRealDb()
  sqlite = real.sqlite
  db = real.db
  await initializeDatabase(db)
  sqlite.prepare("INSERT INTO users (id,email,password_hash,is_enabled) VALUES ('a','a@example.com','x',1)").run()
  sqlite.prepare("INSERT INTO users (id,email,password_hash,is_enabled) VALUES ('b','b@example.com','x',1)").run()
  sqlite.prepare("INSERT INTO ledgers (id,user_id,external_id,name,currency) VALUES ('la','a','secret-ledger','A','CNY')").run()
  sqlite.prepare("INSERT INTO ledger_members (ledger_id,user_id,role) VALUES ('la','a','owner')").run()
  sqlite.prepare("INSERT INTO user_account_projection (sync_id,user_id,name,currency) VALUES ('acc-a','a','Secret Account','CNY')").run()
  sqlite.prepare("INSERT INTO user_category_projection (sync_id,user_id,name,kind,level) VALUES ('cat-a','a','Secret Category','expense',1)").run()
  sqlite.prepare("INSERT INTO user_tag_projection (sync_id,user_id,name) VALUES ('tag-a','a','Secret Tag')").run()
  sqlite.prepare("INSERT INTO read_tx_projection (ledger_id,sync_id,user_id,tx_type,amount,happened_at) VALUES ('la','tx-a','a','expense',88,'2026-01-01T00:00:00Z')").run()
})

afterEach(() => sqlite.close())

describe('import existing-set tenant scope', () => {
  it('returns no data for an unrelated user guessing another ledger id', async () => {
    const sets = await buildExistingSets(db, 'secret-ledger', 'b')
    expect(sets.txKeys.size).toBe(0)
    expect(sets.accountNames.size).toBe(0)
    expect(sets.categoryNames.size).toBe(0)
    expect(sets.tagNames.size).toBe(0)
  })

  it('allows an explicit shared member to inspect the target ledger sets', async () => {
    sqlite.prepare("INSERT INTO ledger_members (ledger_id,user_id,role) VALUES ('la','b','editor')").run()
    const sets = await buildExistingSets(db, 'secret-ledger', 'b')
    expect(sets.txKeys.has('88|2026-01-01')).toBe(true)
    expect(sets.accountNames.has('Secret Account')).toBe(true)
  })
})
