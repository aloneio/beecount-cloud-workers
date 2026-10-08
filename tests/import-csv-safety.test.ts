import { describe, expect, it } from 'vitest'
import { parseCsvText } from '../src/services/import_data/parser'
import { csvField, sanitizeCsvFilename } from '../src/lib/csv'

describe('CSV import/export safety', () => {
  it('preserves commas, quotes and embedded newlines inside quoted CSV cells', () => {
    const data = parseCsvText('type,amount,note\nexpense,12.5,"line 1, quoted ""value""\nline 2"\n')
    expect(data.rows).toHaveLength(1)
    expect(data.rows[0].cells.note).toBe('line 1, quoted "value"\nline 2')
  })

  it('neutralizes spreadsheet formula-looking user cells', () => {
    expect(csvField('=HYPERLINK("https://example.test")')).toBe("\"'=HYPERLINK(\"\"https://example.test\"\")\"")
    expect(csvField('+1+1')).toBe("'+1+1")
    expect(csvField('-2+3')).toBe("'-2+3")
    expect(csvField('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)")
    expect(csvField('ordinary text')).toBe('ordinary text')
    expect(sanitizeCsvFilename('bad\r\nname:ledger')).toBe('bad__name_ledger')
  })
})
