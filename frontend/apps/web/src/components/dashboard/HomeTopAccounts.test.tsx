import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceAccount } from '@beecount/api-client'
import { HomeTopAccounts } from './HomeTopAccounts'

vi.mock('@beecount/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@beecount/ui')>(),
  useLocale: () => ({ locale: 'zh-CN' }),
  useT: () => (key: string) => key === 'common.unit.10k' ? '万' : key,
}))

describe('HomeTopAccounts', () => {
  it('shows the account own currency and global balance', () => {
    const account = {
      id: 'visa',
      name: 'Bitget Wallet_VISA_2916',
      account_type: 'bank_card',
      currency: 'USD',
      initial_balance: 1.69,
      balance: 4.44,
      tx_count: 2,
      income_total: 2.75,
      expense_total: 0,
    } as WorkspaceAccount

    const html = renderToStaticMarkup(<HomeTopAccounts accounts={[account]} currency="CNY" />)
    expect(html).toContain('$4.44')
    expect(html).not.toContain('¥4.44')
    expect(html).toContain('2')
  })
})
