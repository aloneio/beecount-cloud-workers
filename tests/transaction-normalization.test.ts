import { describe, it, expect } from 'vitest';
import { normalizeTransactionAccounts } from '../src/lib/transaction-normalization';

describe('normalizeTransactionAccounts（对齐原版 transaction_normalization）', () => {
  it('expense/income 清空 from/to 转账列，保留单账户列', () => {
    const cols = normalizeTransactionAccounts('expense', {
      account_sync_id: 'acc-1',
      account_name: '现金',
      from_account_sync_id: 'from-1',
      from_account_name: 'A 账户',
      to_account_sync_id: 'to-1',
      to_account_name: 'B 账户',
    });
    expect(cols.account_sync_id).toBe('acc-1');
    expect(cols.account_name).toBe('现金');
    expect(cols.from_account_sync_id).toBeNull();
    expect(cols.from_account_name).toBeNull();
    expect(cols.to_account_sync_id).toBeNull();
    expect(cols.to_account_name).toBeNull();
  });

  it('transfer 清空单账户列，保留 from/to', () => {
    const cols = normalizeTransactionAccounts('transfer', {
      account_sync_id: 'acc-1',
      account_name: '现金',
      from_account_sync_id: 'from-1',
      from_account_name: 'A 账户',
      to_account_sync_id: 'to-1',
      to_account_name: 'B 账户',
    });
    expect(cols.account_sync_id).toBeNull();
    expect(cols.account_name).toBeNull();
    expect(cols.from_account_sync_id).toBe('from-1');
    expect(cols.from_account_name).toBe('A 账户');
    expect(cols.to_account_sync_id).toBe('to-1');
    expect(cols.to_account_name).toBe('B 账户');
  });

  it('缺省类型按 expense 处理（清空 from/to）', () => {
    const cols = normalizeTransactionAccounts(null, {
      from_account_sync_id: 'from-1',
      to_account_sync_id: 'to-1',
    });
    expect(cols.from_account_sync_id).toBeNull();
    expect(cols.to_account_sync_id).toBeNull();
  });

  it('大小写不敏感：TRANSFER 同样清空单账户列', () => {
    const cols = normalizeTransactionAccounts('TRANSFER', {
      account_sync_id: 'acc-1',
      from_account_sync_id: 'from-1',
    });
    expect(cols.account_sync_id).toBeNull();
    expect(cols.from_account_sync_id).toBe('from-1');
  });
});