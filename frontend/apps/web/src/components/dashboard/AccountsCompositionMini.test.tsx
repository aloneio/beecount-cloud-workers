import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AssetGroup } from '@beecount/web-features'
import { AssetsCompositionMini } from '@beecount/web-features'

vi.mock('@beecount/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@beecount/ui')>(),
  useLocale: () => ({ locale: 'zh-CN' }),
  useT: () => (key: string) => key === 'common.total' ? '合计' : key === 'common.unit.10k' ? '万' : key,
}))

function group(type: string, label: string, value: number): AssetGroup {
  return {
    type,
    label,
    color: '#000000',
    isLiability: false,
    rows: [],
    subtotals: [{ currency: 'CNY', value }],
  }
}

describe('Accounts asset composition', () => {
  it('uses signed asset total and does not turn negative asset balances into positive slices', () => {
    const html = renderToStaticMarkup(
      <AssetsCompositionMini
        groups={[
          group('bank_card', '银行卡', 100),
          group('alipay', '支付宝', -20),
          group('wechat', '微信', 20),
        ]}
        currency="CNY"
        showCurrency
      />,
    )

    // Signed assets: 100 - 20 + 20 = 100. The old abs() bug displayed 140.
    expect(html).toContain('¥100.00')
    expect(html).not.toContain('¥140.00')
    // Negative asset groups are offsets, not positive composition slices.
    expect(html).toContain('银行卡')
    expect(html).toContain('微信')
    expect(html).not.toContain('支付宝')
    // Percentages are based only on displayed positive slices: 100 / 120 and 20 / 120.
    expect(html).toContain('83.3%')
    expect(html).toContain('16.7%')
  })
})
