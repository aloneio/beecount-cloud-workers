export type TxAccountColumns = {
  account_sync_id?: string | null;
  account_name?: string | null;
  from_account_sync_id?: string | null;
  from_account_name?: string | null;
  to_account_sync_id?: string | null;
  to_account_name?: string | null;
};

/**
 * 等价原版 transaction_normalization.normalize_transaction_accounts：
 * 按交易类型清空无效账户列——transfer 只用 from/to，expense/income 只用一个账户。
 * 无效字段显式置 null（而非保留旧值），防止 partial merge 恢复旧转账关联。
 * 与原版相同，在新建与合并路径、投影刷新前统一应用。
 */
export function normalizeTransactionAccounts(
  txType: string | null | undefined,
  columns: TxAccountColumns,
): TxAccountColumns {
  if ((txType ?? 'expense').toLowerCase() === 'transfer') {
    columns.account_sync_id = null;
    columns.account_name = null;
  } else {
    columns.from_account_sync_id = null;
    columns.from_account_name = null;
    columns.to_account_sync_id = null;
    columns.to_account_name = null;
  }
  return columns;
}