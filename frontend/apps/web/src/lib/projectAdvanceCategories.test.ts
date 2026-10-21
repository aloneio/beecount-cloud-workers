import { describe, expect, it } from 'vitest'
import type { CategoryPayload } from '@beecount/api-client'
import {
  PROJECT_ADVANCE_PRESET,
  ProjectAdvanceCategoryConflict,
  ensureProjectAdvanceCategories,
  missingProjectAdvanceCategoryCount,
  type ProjectAdvanceCategory,
} from './projectAdvanceCategories'

function item(
  id: string, name: string, kind = 'expense', level = 1,
  parent?: ProjectAdvanceCategory,
): ProjectAdvanceCategory {
  return {
    id, name, kind, level,
    parent_name: parent?.name ?? null,
    parent_sync_id: parent?.id ?? null,
    tx_count: 0,
  }
}

function createHarness(initial: ProjectAdvanceCategory[] = [], failAt = 0) {
  const stored = [...initial]
  const writes: CategoryPayload[] = []
  let attempts = 0
  return {
    stored,
    writes,
    load: async () => stored.map((c) => ({ ...c })),
    create: async (payload: CategoryPayload) => {
      attempts += 1
      if (attempts === failAt) throw new Error('Simulated transport failure')
      writes.push(payload)
      const id = String(stored.length + 1)
      stored.push({
        id, name: payload.name, kind: payload.kind, level: payload.level ?? 1,
        parent_name: payload.parent_name, parent_sync_id: payload.parent_sync_id,
        tx_count: 0,
      })
      return { entity_id: id }
    },
  }
}

describe('project advance categories', () => {
  it('defines 2 parents and 10 children using material symbols', () => {
    expect(PROJECT_ADVANCE_PRESET).toHaveLength(2)
    expect(PROJECT_ADVANCE_PRESET.map((g) => g.children.length)).toEqual([7, 3])
    expect(PROJECT_ADVANCE_PRESET.map((g) => g.kind)).toEqual(['expense', 'income'])
    expect(missingProjectAdvanceCategoryCount([])).toBe(12)
  })

  it('creates parents first, attaches children by stable parent id and is idempotent', async () => {
    const harness = createHarness()
    expect(await ensureProjectAdvanceCategories(harness.load, harness.create)).toBe(12)
    expect(harness.writes).toHaveLength(12)
    for (const group of PROJECT_ADVANCE_PRESET) {
      const parent = harness.stored.find((r) => r.name === group.name)
      expect(parent?.level).toBe(1)
      for (const child of group.children) {
        const category = harness.stored.find((r) => r.name === child.name)
        expect(category?.parent_sync_id).toBe(parent?.id)
        expect(harness.writes.find((w) => w.name === child.name)?.icon_type).toBe('material')
      }
    }
    expect(missingProjectAdvanceCategoryCount(harness.stored)).toBe(0)
    expect(await ensureProjectAdvanceCategories(harness.load, harness.create)).toBe(0)
    expect(harness.writes).toHaveLength(12)
  })

  it('reuses existing parent and child without overwriting existing category icons', async () => {
    const expense = item('original', '项目垫付')
    const preexisting = item('original-child', '设备器材', 'expense', 2, expense)
    const harness = createHarness([expense, preexisting])
    expect(await ensureProjectAdvanceCategories(harness.load, harness.create)).toBe(10)
    expect(harness.writes.find((w) => w.name === '设备器材')).toBeUndefined()
    expect(harness.stored.filter((c) => c.name === '项目垫付')).toHaveLength(1)
    expect(harness.stored.find((c) => c.name === '电子元器件')?.parent_sync_id).toBe('original')
  })

  it('rejects a reused name attached to a different parent before any write', async () => {
    const other = item('other', '其他')
    const existing = item('taken', '电子元器件', 'expense', 2, other)
    const harness = createHarness([other, existing])
    await expect(ensureProjectAdvanceCategories(harness.load, harness.create))
      .rejects.toBeInstanceOf(ProjectAdvanceCategoryConflict)
    expect(harness.writes).toHaveLength(0)
  })

  it('rejects occupied standalone parent before adding child categories', async () => {
    const existing = item('used', '项目垫付')
    existing.tx_count = 5
    const harness = createHarness([existing])
    await expect(ensureProjectAdvanceCategories(harness.load, harness.create))
      .rejects.toBeInstanceOf(ProjectAdvanceCategoryConflict)
    expect(harness.writes).toHaveLength(0)
  })

  it('resumes after partial failure without duplicating already created rows', async () => {
    const harness = createHarness([], 4)
    await expect(ensureProjectAdvanceCategories(harness.load, harness.create))
      .rejects.toThrow('Simulated transport failure')
    expect(harness.stored).toHaveLength(3)
    expect(await ensureProjectAdvanceCategories(harness.load, harness.create)).toBe(9)
    expect(harness.stored).toHaveLength(12)
    expect(missingProjectAdvanceCategoryCount(harness.stored)).toBe(0)
  })

  it('does not confuse the same name across different kinds', async () => {
    const income = item('other-kind', '项目垫付', 'income')
    const harness = createHarness([income])
    expect(await ensureProjectAdvanceCategories(harness.load, harness.create)).toBe(12)
    expect(harness.stored.filter((c) => c.name === '项目垫付')).toHaveLength(2)
  })
})
