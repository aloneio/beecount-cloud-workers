import { describe, it, expect, beforeEach } from 'vitest';
import { createTestEnv, registerTestUser, getAuthToken, createTestLedger, getTable } from '../helpers/test-env';

// 镜像原版 #98 对 workspace_net_worth_history 的改动：
// adjustment 类型交易不再计入净值历史（平账已改走普通收支交易）。
// 说明：adjustment 行只会来自老数据（现写入口已不允许该类型），
// 因此 income/expense/adjustment 均直接写入投影表构造场景。
let env: Awaited<ReturnType<typeof createTestEnv>>;
let token: string;
let ledgerId: string;

beforeEach(async () => {
  env = await createTestEnv();
  await registerTestUser(env.app, 'networth@example.com');
  token = await getAuthToken(env.app, 'networth@example.com');
  ledgerId = await createTestLedger(env.app, token, 'Net Worth Ledger');
});

describe('Net worth history', () => {
  it('ignores legacy adjustment transactions', async () => {
    // 账户初始余额 1000（走 write 端点建真实账户投影）
    const acctRes = await env.app.request(`/api/v1/write/ledgers/${ledgerId}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: '现金',
        account_type: 'debit',
        currency: 'CNY',
        initial_balance: 1000,
      }),
    });
    expect(acctRes.status).toBe(200);
    const acctBody = await acctRes.json() as any;
    const accountSyncId = acctBody.entity_id;
    expect(accountSyncId).toBeDefined();

    const internalLedgerId = getTable(env.db, 'ledgers').find((l: any) => l.external_id === ledgerId)?.id;
    expect(internalLedgerId).toBeDefined();

    // 1 月：收入 +100、支出 -30；2 月：legacy adjustment +500
    const txRows = [
      { tx_type: 'income', amount: 100, happened_at: '2025-01-15T10:00:00.000Z', sync_id: 'tx-income-1' },
      { tx_type: 'expense', amount: 30, happened_at: '2025-01-20T10:00:00.000Z', sync_id: 'tx-expense-1' },
      { tx_type: 'adjustment', amount: 500, happened_at: '2025-02-01T00:00:00.000Z', sync_id: 'legacy-adjustment-1' },
    ];
    for (const row of txRows) {
      getTable(env.db, 'read_tx_projection').push({
        ledger_id: internalLedgerId,
        ...row,
        account_sync_id: accountSyncId,
        from_account_sync_id: null,
        to_account_sync_id: null,
      });
    }

    const res = await env.app.request(`/api/v1/net-worth-history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const byMonth = Object.fromEntries(body.series.map((s: any) => [s.bucket, s]));
    // 1 月：1000 + 100 - 30 = 1070
    expect(byMonth['2025-01'].net_worth).toBe(1070);
    // 2 月：adjustment +500 被忽略，净值仍为 1070
    expect(byMonth['2025-02'].net_worth).toBe(1070);
  });
});
