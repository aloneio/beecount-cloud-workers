import type { WorkspaceAccount } from '@beecount/api-client'

/**
 * Overview 同时需要两种账户口径：
 * - globalAccounts: user-global 的真实当前余额（与资产页一致）；
 * - ledgerAccounts: 当前账本内的活动统计（tx_count / income_total / expense_total）。
 *
 * 账户实体本身是 user-global，不能把 ledger-filtered balance 当作真实账户余额。
 * 因此以全局账户为基底，仅覆盖当前账本的活动统计字段。
 */
export function mergeOverviewAccounts(
  globalAccounts: WorkspaceAccount[],
  ledgerAccounts: WorkspaceAccount[],
): WorkspaceAccount[] {
  const activityById = new Map(ledgerAccounts.map((account) => [account.id, account]))
  return globalAccounts.map((account) => {
    const activity = activityById.get(account.id)
    return {
      ...account,
      tx_count: activity?.tx_count ?? 0,
      income_total: activity?.income_total ?? 0,
      expense_total: activity?.expense_total ?? 0,
    }
  })
}
