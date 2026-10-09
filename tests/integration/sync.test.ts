import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, createTestLedger, TEST_JWT_SECRET, TEST_DEVICE_ID } from '../helpers/test-env';
import { getTable } from '../helpers/mock-db';

let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;
let ledgerId: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'sync@example.com');
  token = await getAuthToken(env.app, 'sync@example.com');
  ledgerId = await createTestLedger(env.app, token, 'Sync Test Ledger');
});

function pushHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Device-ID': TEST_DEVICE_ID,
  };
}

describe('Sync - Ledgers', () => {
  it('should list user ledgers', async () => {
    const res = await env.app.request('/api/v1/sync/ledgers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].ledger_id).toBe(ledgerId);
    expect(body[0].role).toBe('owner');
  });
});

describe('Sync - Push', () => {
  it('should push a new transaction', async () => {
    const txSyncId = crypto.randomUUID();
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'transaction',
            entity_sync_id: txSyncId,
            action: 'upsert',
            payload: {
              tx_type: 'expense',
              amount: 25.50,
              happened_at: '2025-01-15T10:30:00.000Z',
              note: '午餐',
              category_name: '餐饮',
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
    expect(body.server_cursor).toBeGreaterThan(0);
  });

  it('should push multiple changes', async () => {
    const changes = [];
    for (let i = 0; i < 5; i++) {
      changes.push({
        ledger_id: ledgerId,
        entity_type: 'transaction',
        entity_sync_id: crypto.randomUUID(),
        action: 'upsert' as const,
        payload: {
          tx_type: 'expense',
          amount: 10 * (i + 1),
          happened_at: `2025-01-${15 + i}T10:00:00.000Z`,
          note: `交易${i + 1}`,
        },
        updated_at: new Date().toISOString(),
      });
    }

    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe(5);
    expect(body.rejected).toBe(0);
  });

  it('should push a category', async () => {
    const catSyncId = crypto.randomUUID();
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'category',
            entity_sync_id: catSyncId,
            action: 'upsert',
            payload: {
              name: '同步测试分类',
              kind: 'expense',
              level: 1,
              sort_order: 99,
              icon: '🎯',
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe(1);
    const stored = getTable(env.db, 'sync_changes').find((row: any) => row.entity_type === 'category' && row.entity_sync_id === catSyncId);
    expect(stored).toMatchObject({ scope: 'user', ledger_id: null });
  });

  it('should push an account', async () => {
    const acctSyncId = crypto.randomUUID();
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'account',
            entity_sync_id: acctSyncId,
            action: 'upsert',
            payload: {
              name: '同步测试账户',
              account_type: 'debit',
              currency: 'CNY',
              initial_balance: 1000,
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accepted).toBe(1);
    const stored = getTable(env.db, 'sync_changes').find((row: any) => row.entity_type === 'account' && row.entity_sync_id === acctSyncId);
    expect(stored).toMatchObject({ scope: 'user', ledger_id: null });
  });

  it('should reject resurrection after an account tombstone even with a newer timestamp', async () => {
    const acctSyncId = crypto.randomUUID();
    const base = Date.now();

    const upsertRes = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: ledgerId, entity_type: 'account', entity_sync_id: acctSyncId, action: 'upsert',
        payload: { name: 'stale account', type: 'alipay', currency: 'CNY', initialBalance: -1000 },
        updated_at: new Date(base).toISOString(),
      }] }),
    });
    expect(upsertRes.status).toBe(200);

    const deleteRes = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: ledgerId, entity_type: 'account', entity_sync_id: acctSyncId, action: 'delete', payload: {},
        updated_at: new Date(base + 1000).toISOString(),
      }] }),
    });
    expect(deleteRes.status).toBe(200);
    const deletedBody = await deleteRes.json() as any;
    expect(deletedBody.accepted).toBe(1);
    expect(getTable(env.db, 'user_account_projection').some((row: any) => row.sync_id === acctSyncId)).toBe(false);

    const resurrectRes = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: ledgerId, entity_type: 'account', entity_sync_id: acctSyncId, action: 'upsert',
        payload: { name: 'stale account', type: 'alipay', currency: 'CNY', initialBalance: -1000 },
        updated_at: new Date(base + 2000).toISOString(),
      }] }),
    });
    expect(resurrectRes.status).toBe(200);
    const resurrectBody = await resurrectRes.json() as any;
    expect(resurrectBody.accepted).toBe(0);
    expect(resurrectBody.rejected).toBe(1);
    expect(getTable(env.db, 'user_account_projection').some((row: any) => row.sync_id === acctSyncId)).toBe(false);
    const history = getTable(env.db, 'sync_changes').filter((row: any) => row.entity_type === 'account' && row.entity_sync_id === acctSyncId);
    expect(history.at(-1)?.action).toBe('delete');
  });


  it('should reject empty category names instead of overwriting valid metadata', async () => {
    const catSyncId = crypto.randomUUID();
    const base = Date.now();
    const good = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: '__user_global__', entity_type: 'category', entity_sync_id: catSyncId, action: 'upsert',
        payload: { name: '餐饮', kind: 'expense', level: 1, sortOrder: 1 },
        updated_at: new Date(base).toISOString(),
      }] }),
    });
    expect(good.status).toBe(200);
    expect((await good.json() as any).accepted).toBe(1);

    const bad = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: '__user_global__', entity_type: 'category', entity_sync_id: catSyncId, action: 'upsert',
        payload: { name: '', kind: 'expense', level: 1, sortOrder: 0 },
        updated_at: new Date(base + 1000).toISOString(),
      }] }),
    });
    expect(bad.status).toBe(200);
    const body = await bad.json() as any;
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
    expect(body.conflict_samples?.[0]?.reason).toBe('invalid_category_name_rejected');

    const projection = getTable(env.db, 'user_category_projection').find((row: any) => row.sync_id === catSyncId);
    expect(projection?.name).toBe('餐饮');
    expect(projection?.level).toBe(1);
    const history = getTable(env.db, 'sync_changes').filter((row: any) => row.entity_type === 'category' && row.entity_sync_id === catSyncId);
    expect(history).toHaveLength(1);
  });

  it('should reject level-2 categories without a parent', async () => {
    const catSyncId = crypto.randomUUID();
    const base = Date.now();
    const parentId = crypto.randomUUID();

    const parentRes = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: '__user_global__', entity_type: 'category', entity_sync_id: parentId, action: 'upsert',
        payload: { name: '餐饮', kind: 'expense', level: 1, sortOrder: 0 },
        updated_at: new Date(base).toISOString(),
      }] }),
    });
    expect(parentRes.status).toBe(200);

    const good = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: '__user_global__', entity_type: 'category', entity_sync_id: catSyncId, action: 'upsert',
        payload: { name: '早餐', kind: 'expense', level: 2, sortOrder: 0, parentName: '餐饮', parentSyncId: parentId },
        updated_at: new Date(base + 1000).toISOString(),
      }] }),
    });
    expect(good.status).toBe(200);
    expect((await good.json() as any).accepted).toBe(1);

    const orphan = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: '__user_global__', entity_type: 'category', entity_sync_id: catSyncId, action: 'upsert',
        payload: { name: '早餐', kind: 'expense', level: 2, sortOrder: 0 },
        updated_at: new Date(base + 2000).toISOString(),
      }] }),
    });
    expect(orphan.status).toBe(200);
    const body = await orphan.json() as any;
    expect(body.accepted).toBe(0);
    expect(body.rejected).toBe(1);
    expect(body.conflict_samples?.[0]?.reason).toBe('invalid_category_parent_rejected');

    const projection = getTable(env.db, 'user_category_projection').find((row: any) => row.sync_id === catSyncId);
    expect(projection?.parent_sync_id).toBe(parentId);
    expect(projection?.level).toBe(2);
  });

  it('should canonicalize parentName from a valid parentSyncId', async () => {
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const base = Date.now();

    const parentRes = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: '__user_global__', entity_type: 'category', entity_sync_id: parentId, action: 'upsert',
        payload: { name: '投资收益', kind: 'income', level: 1, sortOrder: 0 },
        updated_at: new Date(base).toISOString(),
      }] }),
    });
    expect(parentRes.status).toBe(200);

    const childRes = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: '__user_global__', entity_type: 'category', entity_sync_id: childId, action: 'upsert',
        payload: { name: '股票收益', kind: 'income', level: 2, sortOrder: 0, parentSyncId: parentId },
        updated_at: new Date(base + 1000).toISOString(),
      }] }),
    });
    expect(childRes.status).toBe(200);
    expect((await childRes.json() as any).accepted).toBe(1);

    const projection = getTable(env.db, 'user_category_projection').find((row: any) => row.sync_id === childId);
    expect(projection?.parent_sync_id).toBe(parentId);
    expect(projection?.parent_name).toBe('投资收益');

    const stored = getTable(env.db, 'sync_changes').find((row: any) => row.entity_type === 'category' && row.entity_sync_id === childId);
    const payload = JSON.parse(String(stored?.payload_json ?? '{}'));
    expect(payload.parentSyncId).toBe(parentId);
    expect(payload.parentName).toBe('投资收益');
  });


});

describe('Sync - Pull', () => {
  it('should pull changes after push', async () => {
    const txSyncId = crypto.randomUUID();
    await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [{
          ledger_id: ledgerId,
          entity_type: 'transaction',
          entity_sync_id: txSyncId,
          action: 'upsert',
          payload: { tx_type: 'expense', amount: 25.5, happened_at: '2025-01-15T10:30:00.000Z', note: '午餐' },
          updated_at: new Date().toISOString(),
        }],
      }),
    });

    // 不传 device_id（跳过设备校验；无 device 过滤时能拉到所有变更）
    const res = await env.app.request(`/api/v1/sync/pull`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.changes)).toBe(true);
    expect(body.changes.length).toBeGreaterThanOrEqual(1);
    const pushed = body.changes.find((c: any) => c.entity_sync_id === txSyncId);
    expect(pushed).toBeDefined();
    expect(pushed.entity_type).toBe('transaction');
    expect(pushed.action).toBe('upsert');
    expect(body.server_cursor).toBeDefined();
    expect(typeof body.has_more).toBe('boolean');
  });

  it('should include same-device history when rebuilding from since=0', async () => {
    const txSyncId = crypto.randomUUID();
    const pushRes = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [{
          ledger_id: ledgerId,
          entity_type: 'transaction',
          entity_sync_id: txSyncId,
          action: 'upsert',
          payload: { tx_type: 'expense', amount: 12.34, happened_at: '2025-01-15T10:30:00.000Z', note: 'same-device rebuild' },
          updated_at: new Date().toISOString(),
        }],
      }),
    });
    expect(pushRes.status).toBe(200);

    const pullRes = await env.app.request(`/api/v1/sync/pull?device_id=${TEST_DEVICE_ID}&since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pullRes.status).toBe(200);
    const body = await pullRes.json() as any;
    const replayed = body.changes.find((c: any) => c.entity_sync_id === txSyncId);
    expect(replayed).toBeDefined();
    expect(replayed.updated_by_device_id).toBeNull();
  });

  it('should keep same-device history replayable after the first page cursor advances', async () => {
    const txSyncId = crypto.randomUUID();
    await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: ledgerId, entity_type: 'transaction', entity_sync_id: txSyncId, action: 'upsert',
        payload: { type: 'expense', amount: 1, happenedAt: '2025-01-15T10:30:00.000Z' },
        updated_at: new Date().toISOString(),
      }] }),
    });
    const stored = getTable(env.db, 'sync_changes').find((row: any) => row.entity_sync_id === txSyncId);
    const storedChangeId = Number(stored?.change_id ?? 0);
    expect(storedChangeId).toBeGreaterThan(1);
    const pullRes = await env.app.request(`/api/v1/sync/pull?device_id=${TEST_DEVICE_ID}&since=${storedChangeId - 1}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pullRes.status).toBe(200);
    const body = await pullRes.json() as any;
    const replayed = body.changes.find((c: any) => c.entity_sync_id === txSyncId);
    expect(replayed).toBeDefined();
    expect(replayed.updated_by_device_id).toBeNull();
  });

  it('should compensate cross-currency transfer destination balances for the mobile account model', async () => {
    const fromId = crypto.randomUUID();
    const toId = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const now = Date.now();
    const accountsPush = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [
        { ledger_id: '__user_global__', entity_type: 'account', entity_sync_id: fromId, action: 'upsert', payload: { name: 'USD source', type: 'bank_card', currency: 'USD', initialBalance: 0 }, updated_at: new Date(now).toISOString() },
        { ledger_id: '__user_global__', entity_type: 'account', entity_sync_id: toId, action: 'upsert', payload: { name: 'CNY destination', type: 'alipay', currency: 'CNY', initialBalance: 0, sortOrder: 9 }, updated_at: new Date(now + 1).toISOString() },
      ] }),
    });
    expect(accountsPush.status).toBe(200);
    const txPush = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: ledgerId, entity_type: 'transaction', entity_sync_id: txId, action: 'upsert',
        payload: { type: 'transfer', amount: 30.37, transferToAmount: 200, fromAccountId: fromId, fromAccountName: 'USD source', toAccountId: toId, toAccountName: 'CNY destination', happenedAt: '2026-10-03T00:46:00.000Z' },
        updated_at: new Date(now + 2).toISOString(),
      }] }),
    });
    expect(txPush.status).toBe(200);

    const pullRes = await env.app.request(`/api/v1/sync/pull?device_id=${TEST_DEVICE_ID}&since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pullRes.status).toBe(200);
    const body = await pullRes.json() as any;
    const toAccount = body.changes.filter((c: any) => c.entity_type === 'account' && c.entity_sync_id === toId).at(-1);
    const transfer = body.changes.find((c: any) => c.entity_sync_id === txId);
    expect(toAccount).toBeDefined();
    expect(transfer).toBeDefined();
    expect(toAccount.payload.initialBalance).toBeCloseTo(169.63, 6);
    expect(toAccount.payload.sortOrder).toBe(9);
    expect(toAccount.payload.initialBalance + transfer.payload.amount).toBeCloseTo(200, 6);

    const canonicalBefore = getTable(env.db, 'user_account_projection').find((row: any) => row.sync_id === toId);
    expect(Number(canonicalBefore?.initial_balance)).toBeCloseTo(0, 6);

    const renamePush = await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: '__user_global__', entity_type: 'account', entity_sync_id: toId, action: 'upsert',
        payload: { name: 'CNY destination renamed', type: 'alipay', currency: 'CNY', initialBalance: 169.63 },
        updated_at: new Date(now + 3000).toISOString(),
      }] }),
    });
    expect(renamePush.status).toBe(200);
    const canonicalAfter = getTable(env.db, 'user_account_projection').find((row: any) => row.sync_id === toId);
    expect(Number(canonicalAfter?.initial_balance)).toBeCloseTo(0, 6);
    expect(canonicalAfter?.name).toBe('CNY destination renamed');
  });

  it('should send valuation-only accounts with their server current value as mobile initialBalance', async () => {
    const sourceId = crypto.randomUUID();
    const investmentId = crypto.randomUUID();
    const txId = crypto.randomUUID();
    const now = Date.now();
    await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [
        { ledger_id: '__user_global__', entity_type: 'account', entity_sync_id: sourceId, action: 'upsert', payload: { name: 'EUR source', type: 'bank_card', currency: 'EUR', initialBalance: 1210 }, updated_at: new Date(now).toISOString() },
        { ledger_id: '__user_global__', entity_type: 'account', entity_sync_id: investmentId, action: 'upsert', payload: { name: 'Broker', type: 'investment', currency: 'USD', initialBalance: 0 }, updated_at: new Date(now + 1).toISOString() },
      ] }),
    });
    await env.app.request('/api/v1/sync/push', {
      method: 'POST', headers: pushHeaders(),
      body: JSON.stringify({ device_id: TEST_DEVICE_ID, changes: [{
        ledger_id: ledgerId, entity_type: 'transaction', entity_sync_id: txId, action: 'upsert',
        payload: { type: 'transfer', amount: 1210, transferToAmount: 1350.31, fromAccountId: sourceId, fromAccountName: 'EUR source', toAccountId: investmentId, toAccountName: 'Broker', happenedAt: '2026-10-03T23:46:00.000Z' },
        updated_at: new Date(now + 2).toISOString(),
      }] }),
    });

    const pullRes = await env.app.request(`/api/v1/sync/pull?device_id=${TEST_DEVICE_ID}&since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pullRes.status).toBe(200);
    const body = await pullRes.json() as any;
    const investment = body.changes.filter((c: any) => c.entity_type === 'account' && c.entity_sync_id === investmentId).at(-1);
    expect(investment).toBeDefined();
    expect(investment.payload.initialBalance).toBeCloseTo(1350.31, 6);
    const canonical = getTable(env.db, 'user_account_projection').find((row: any) => row.sync_id === investmentId);
    expect(Number(canonical?.initial_balance)).toBeCloseTo(0, 6);
  });

  it('should return empty when no new changes', async () => {
    const res = await env.app.request(`/api/v1/sync/pull?device_id=${TEST_DEVICE_ID}&since=999999999`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.changes).toEqual([]);
  });

  it('should filter by ledger_id', async () => {
    const txSyncId = crypto.randomUUID();
    await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [{
          ledger_id: ledgerId,
          entity_type: 'transaction',
          entity_sync_id: txSyncId,
          action: 'upsert',
          payload: { tx_type: 'expense', amount: 10, happened_at: '2025-01-15T10:00:00.000Z' },
          updated_at: new Date().toISOString(),
        }],
      }),
    });

    // 不传 device_id，拉取指定账本的变化
    const res = await env.app.request(`/api/v1/sync/pull?ledger_id=${ledgerId}&since=0`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.changes)).toBe(true);
    const pushed = body.changes.find((c: any) => c.entity_sync_id === txSyncId);
    expect(pushed).toBeDefined();
    expect(pushed.ledger_id).toBe(ledgerId);
  });
});

describe('Sync - Full sync', () => {
  it('should return full sync snapshot', async () => {
    const txSyncId = crypto.randomUUID();
    await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'transaction',
            entity_sync_id: txSyncId,
            action: 'upsert',
            payload: {
              tx_type: 'income',
              amount: 5000,
              happened_at: '2025-01-15T10:00:00.000Z',
              note: '工资',
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });

    const res = await env.app.request(`/api/v1/sync/full?ledger_id=${ledgerId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ledger_id).toBe(ledgerId);
    expect(body.latest_cursor).toBeDefined();
    expect(body.snapshot).toBeDefined();
    expect(body.snapshot.entity_sync_id).toBe(ledgerId);
    // ledgerSyncId 在 payload.content（JSON 字符串）内
    const content = JSON.parse(body.snapshot.payload.content);
    expect(content.ledgerSyncId).toBe(ledgerId);
  });
});

describe('Sync - Push 交易账户字段规范化（对齐原版 transaction_normalization）', () => {
  it('expense 带转账字段 → 投影 from/to 被清空', async () => {
    const txSyncId = crypto.randomUUID();
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'transaction',
            entity_sync_id: txSyncId,
            action: 'upsert',
            payload: {
              tx_type: 'expense',
              amount: 10,
              happened_at: '2025-01-15T10:00:00.000Z',
              accountName: '现金',
              fromAccountId: 'from-1',
              fromAccountName: '旧转账A',
              toAccountId: 'to-1',
              toAccountName: '旧转账B',
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const rows = getTable(env.db, 'read_tx_projection') as any[];
    const row = rows.find((r) => r.sync_id === txSyncId);
    expect(row).toBeTruthy();
    expect(row.tx_type).toBe('expense');
    expect(row.account_name).toBe('现金');
    expect(row.from_account_sync_id).toBeNull();
    expect(row.from_account_name).toBeNull();
    expect(row.to_account_sync_id).toBeNull();
    expect(row.to_account_name).toBeNull();
  });

  it('transfer 带单账户字段 → 投影 account 被清空（只用 from/to）', async () => {
    const txSyncId = crypto.randomUUID();
    const res = await env.app.request('/api/v1/sync/push', {
      method: 'POST',
      headers: pushHeaders(),
      body: JSON.stringify({
        device_id: TEST_DEVICE_ID,
        changes: [
          {
            ledger_id: ledgerId,
            entity_type: 'transaction',
            entity_sync_id: txSyncId,
            action: 'upsert',
            payload: {
              tx_type: 'transfer',
              amount: 10,
              happened_at: '2025-01-15T10:00:00.000Z',
              accountId: 'acc-1',
              accountName: '现金',
              fromAccountId: 'from-1',
              toAccountId: 'to-1',
            },
            updated_at: new Date().toISOString(),
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const rows = getTable(env.db, 'read_tx_projection') as any[];
    const row = rows.find((r) => r.sync_id === txSyncId);
    expect(row).toBeTruthy();
    expect(row.tx_type).toBe('transfer');
    expect(row.account_sync_id).toBeNull();
    expect(row.account_name).toBeNull();
    expect(row.from_account_sync_id).toBe('from-1');
    expect(row.to_account_sync_id).toBe('to-1');
  });
});
