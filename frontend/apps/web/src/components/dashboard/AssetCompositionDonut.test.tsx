import { renderToStaticMarkup } from 'react-dom/server'
import type { ExchangeRateOverride, ExchangeRatesResponse, WorkspaceAccount } from '@beecount/api-client'
import { describe, expect, it, vi } from 'vitest'

import { AssetCompositionDonut } from './AssetCompositionDonut'

vi.mock('@beecount/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@beecount/ui')>(),
  useLocale: () => ({ locale: 'en' }),
  useT: () => (key: string, params?: Record<string, string>) =>
    key === 'home.assetComp.liability' ? 'Liabilities: {value}'
      : params ? `${key}: ${Object.values(params).join(', ')}` : key,
}))

// Server rendering has no container dimensions; assert the real totals/legend.
vi.mock('recharts', async (importOriginal) => ({
  ...await importOriginal<typeof import('recharts')>(),
  ResponsiveContainer: () => null,
}))

function account(currency: string, balance: number, accountType = 'bank_card'): WorkspaceAccount {
  return { currency, balance, account_type: accountType } as WorkspaceAccount
}

function autoRates(base: string, rates: Record<string, string>): ExchangeRatesResponse {
  return { base, rates, rate_date: '2026-10-02', source: 'test', fetched_at: '', stale: false }
}

function override(quote: string, rate: string): ExchangeRateOverride {
  return { base_currency: 'CNY', quote_currency: quote, rate } as ExchangeRateOverride
}

function render(accounts: WorkspaceAccount[], options: {
  currency?: string
  rates?: ExchangeRatesResponse | null
  rateOverrides?: ExchangeRateOverride[]
  loading?: boolean
} = {}) {
  return renderToStaticMarkup(<AssetCompositionDonut
    accounts={accounts}
    currency={options.currency ?? 'CNY'}
    rates={options.rates ?? null}
    rateOverrides={options.rateOverrides ?? []}
    loading={options.loading ?? false}
  />)
}

describe('Overview asset composition', () => {
  it('converts CNY, USD and SGD before combining a shared account type', () => {
    const html = render([account('CNY', 10000), account('USD', 1000), account('SGD', 500)], {
      rates: autoRates('CNY', { USD: String(1 / 7.2), SGD: String(1 / 5.3) }),
    })
    expect(html).toContain('19,850')
    expect(html).not.toContain('11,500')
    expect(html).toContain('CNY')
    expect(html).toContain('100.0%')
  })

  it('converts foreign-only accounts and uses manual rates before automatic rates', () => {
    const html = render([account('usd', 100)], {
      rates: autoRates('CNY', { USD: '0.2' }),
      rateOverrides: [override('USD', '7.2')],
    })
    expect(html).toContain('>720<')
    expect(html).not.toContain('>500<')
  })

  it('keeps same-currency balances and initial-balance fallback without rate requests', () => {
    const html = render([{ currency: 'CNY', initial_balance: 100 } as WorkspaceAccount])
    expect(html).toContain('>100<')
    expect(html).not.toContain('accounts.converted.missing')
  })

  it('excludes and names missing currencies instead of treating them as 1:1', () => {
    const html = render([account('CNY', 10000), account('USD', 1000), account('SGD', 500)], {
      rateOverrides: [override('USD', '7.2')],
    })
    expect(html).toContain('17,200')
    expect(html).toContain('accounts.converted.missing: SGD')
    expect(html).not.toContain('17,700')
  })

  it('reports missing rates even when all foreign balances are excluded', () => {
    const html = render([account('USD', 1000)])
    expect(html).toContain('accounts.converted.missing: USD')
    expect(html).not.toContain('1,000')
  })

  it('does not reuse an automatic rate response for a different base currency', () => {
    const html = render([account('CNY', 720)], {
      currency: 'USD',
      rates: autoRates('EUR', { CNY: '8' }),
    })
    expect(html).toContain('accounts.converted.missing: CNY')
    expect(html).not.toContain('>90<')
  })

  it('preserves signed liabilities, overdrafts and the displayed-slice denominator', () => {
    const html = render([
      account('CNY', 10000), account('USD', -100),
      account('SGD', 500, 'cash'), account('CNY', -500, 'investment'),
      account('USD', -100, 'credit_card'), account('CNY', 100, 'credit_card'),
    ], { rateOverrides: [override('USD', '7.2'), override('SGD', '5.3')] })
    expect(html).toContain('11,430') // 10000 - 720 + 2650 - 500
    expect(html).toContain('620') // debt: -720 + 100; abs only after summing
    expect(html).toContain('77.8%') // 9280 / (9280 + 2650)
    expect(html).toContain('22.2%')
    expect(html).not.toContain('accountType.credit_card')
    expect(html).not.toContain('accountType.investment')
  })

  it('shows loading instead of a raw mixed-currency total while rates are pending', () => {
    const html = render([account('CNY', 10000), account('USD', 1000)], { loading: true })
    expect(html).toContain('common.loading')
    expect(html).not.toContain('11,000')
  })
})
