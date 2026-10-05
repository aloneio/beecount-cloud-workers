import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import batchWriteRouter from '../../src/routes/batch_write';
import { createRealDb, WRITE_PATH_TABLES } from '../helpers/realsql-db';

// 真实 SQLite 全链路验证 batchWriteRouter（App 批量写路径）的交易账户字段规范化。
let sqlite: DatabaseSync;
let db: D1Database;
let app: Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>;

beforeEach(() => {
  const real = createRealDb();
  sqlite = real.sqlite;
  db = real.db;
  sqlite.exec(WRITE_PATH_TABLES);
  sqlite.prepare("INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'b@x.com', 'x')").run();
  sqlite.prepare("INSERT INTO ledgers (id, user_id, external_id, name, currency) VALUES ('ledger-1', 'user-1', 'ledger-1', 'B', 'CNY')").run();
  sqlite.prepare("INSERT INTO devices (id, user_id, name, platform, created_at) VALUES ('dev-1', 'user-1', 't', 't', '2025-01-01T00:00:00Z')").run();
  sqlite.prepare("INSERT INTO user_account_projection (sync_id, user_id, name, account_type, currency) VALUES ('acc-cash', 'user-1', '现金', 'cash', 'CNY')").run();
  sqlite.prepare("INSERT INTO user_category_projection (sync_id, user_id, name, kind, level) VALUES ('cat-food', 'user-1', '餐饮', 'expense', 1)").run();

  app = new Hono<{ Bindings: { DB: D1Database }; Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api/v1/write', batchWriteRouter);
});

afterEach(() => sqlite.close());

async function batchCreate(transactions: Record<string, unknown>[]) {
  const res = await app.request('/api/v1/write/transactions/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-ID': 'dev-1' },
    body: JSON.stringify({ ledger_id: 'ledger-1', device_id: 'dev-1', transactions }),
  }, { DB: db });
  const json = await res.json() as { created_sync_ids?: string[]; error?: string };
  expect(res.status).toBe(200);
  expect(json.created_sync_ids).toBeDefined();
  return json.created_sync_ids as string[];
}

function projection(syncId: string) {
  return sqlite.prepare(
    'SELECT tx_type, account_sync_id, account_name, from_account_sync_id, from_account_name, to_account_sync_id, to_account_name FROM read_tx_projection WHERE sync_id = ?'
  ).get(syncId) as Record<string, unknown>;
}

describe('batchWriteRouter 交易账户字段规范化（真实 SQLite）', () => {
  it('批量含 expense 带转账字段 + transfer 带单账户 → 各自真实清空', async () => {
    const [expenseId, transferId] = await batchCreate([
      {
        tx_type: 'expense', amount: 10, happened_at: '2025-01-15T10:00:00Z',
        account_name: '现金',
        from_account_id: 'from-1', from_account_name: '旧A',
        to_account_id: 'to-1', to_account_name: '旧B',
      },
      {
        tx_type: 'transfer', amount: 100, happened_at: '2025-01-15T10:00:00Z',
        account_id: 'acc-cash', account_name: '现金',
        from_account_id: 'from-1', to_account_id: 'to-1',
      },
    ]);

    const expense = projection(expenseId);
    expect(expense.tx_type).toBe('expense');
    expect(expense.account_name).toBe('现金');
    expect(expense.from_account_sync_id).toBeNull();
    expect(expense.from_account_name).toBeNull();
    expect(expense.to_account_sync_id).toBeNull();
    expect(expense.to_account_name).toBeNull();

    const transfer = projection(transferId);
    expect(transfer.tx_type).toBe('transfer');
    expect(transfer.account_sync_id).toBeNull();
    expect(transfer.account_name).toBeNull();
    expect(transfer.from_account_sync_id).toBe('from-1');
    expect(transfer.to_account_sync_id).toBe('to-1');
  });

  it('同步 payload（sync_changes）与投影同口径规范化', async () => {
    const [syncId] = await batchCreate([{
      tx_type: 'expense', amount: 5, happened_at: '2025-01-15T10:00:00Z',
      from_account_id: 'from-1', to_account_id: 'to-1',
    }]);
    const change = sqlite.prepare("SELECT payload_json FROM sync_changes WHERE entity_sync_id = ?").get(syncId) as { payload_json: string };
    const payload = JSON.parse(change.payload_json) as Record<string, unknown>;
    // payload 内 from/to 也必须被清（对齐原版 normalize 后写事件）
    expect(payload.fromAccountId).toBeNull();
    expect(payload.toAccountId).toBeNull();
  });
});