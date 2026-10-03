import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Amount } from '@beecount/web-features'

vi.mock('@beecount/ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('@beecount/ui')>(),
  useLocale: () => ({ locale: 'zh-CN' }),
  useT: () => (key: string) => key === 'common.unit.10k' ? '万' : key,
}))


describe('Amount animated DOM', () => {
  it('contains only the final formatted amount, never odometer 0-9 internals', () => {
    const html = renderToStaticMarkup(
      <Amount value={-143.76} currency="CNY" showCurrency compact={false} animate />,
    )
    expect(html).toContain('-¥143.76')
    expect(html).not.toContain('0123456789')
    expect(html.match(/143\.76/g)).toHaveLength(1)
  })
})
