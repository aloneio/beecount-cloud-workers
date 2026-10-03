import { describe, expect, it } from 'vitest'
import type { WorkspaceAccount } from '@beecount/api-client'
import { mergeOverviewAccounts } from './overviewAccounts'

function account(overrides: Partial<WorkspaceAccount>): WorkspaceAccount {
  return {
    id: 'visa',
    name: 'Bitget Wallet_VISA_2916',
    account_type: 'bank_card',
    currency: 'USD',
    initial_balance: 1.69,
    balance: 4.44,
    tx_count: 7,
    income_total: 2.75,
    expense_total: 0,
    ...overrides,
  } as WorkspaceAccount
}

describe('mergeOverviewAccounts', () => {
  it('keeps the global balance while using current-ledger activity stats', () => {
    const merged = mergeOverviewAccounts(
      [account({ balance: 4.44, tx_count: 7 })],
      [account({ balance: 3.41, tx_count: 2, income_total: 1.72, expense_total: 0 })],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].balance).toBe(4.44)
    expect(merged[0].currency).toBe('USD')
    expect(merged[0].tx_count).toBe(2)
    expect(merged[0].income_total).toBe(1.72)
  })
})
