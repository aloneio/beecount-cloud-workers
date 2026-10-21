import type { CategoryPayload } from '@beecount/api-client'

export type ProjectAdvanceCategory = {
  id: string
  name: string
  kind: string
  level: number | null
  parent_name?: string | null
  parent_sync_id?: string | null
  tx_count?: number | null
}

type PresetKind = 'expense' | 'income'
type PresetGroup = {
  name: string
  kind: PresetKind
  icon: string
  children: ReadonlyArray<{ name: string; icon: string }>
}

/** Optional, per-user preset. These are Material Symbols stored names, not emoji or Lucide icons. */
export const PROJECT_ADVANCE_PRESET: ReadonlyArray<PresetGroup> = [
  {
    name: '项目垫付',
    kind: 'expense',
    icon: 'business_center',
    children: [
      { name: '设备器材', icon: 'devices' },
      { name: '电子元器件', icon: 'computer' },
      { name: '材料采购', icon: 'inventory_2' },
      { name: '加工制作', icon: 'handyman' },
      { name: '软件与云服务', icon: 'cloud' },
      { name: '物流运输', icon: 'local_shipping' },
      { name: '其他垫付', icon: 'category' },
    ],
  },
  {
    name: '垫付收回',
    kind: 'income',
    icon: 'receipt_long',
    children: [
      { name: '项目报销', icon: 'receipt_long' },
      { name: '费用分摊', icon: 'group' },
      { name: '垫款退回', icon: 'account_balance_wallet' },
    ],
  },
]

export class ProjectAdvanceCategoryConflict extends Error {
  constructor(readonly categoryName: string) {
    super('Existing category hierarchy conflicts with project-advance preset')
    this.name = 'ProjectAdvanceCategoryConflict'
  }
}

function findCategory(rows: readonly ProjectAdvanceCategory[], kind: PresetKind, name: string) {
  const matches = rows.filter((row) =>
    row.kind === kind && row.name.trim().toLowerCase() === name.trim().toLowerCase(),
  )
  if (matches.length > 1) throw new ProjectAdvanceCategoryConflict(name)
  return matches[0]
}

function assertCompatible(rows: readonly ProjectAdvanceCategory[]) {
  for (const group of PROJECT_ADVANCE_PRESET) {
    const parent = findCategory(rows, group.kind, group.name)
    if (parent && parent.level !== 1) {
      throw new ProjectAdvanceCategoryConflict(group.name)
    }
    const existingChildren = group.children
      .map((child) => findCategory(rows, group.kind, child.name))
    for (let i = 0; i < group.children.length; i++) {
      const child = existingChildren[i]
      if (!child) continue
      const linked = parent && child.level === 2 && (
        child.parent_sync_id
          ? child.parent_sync_id === parent.id
          : child.parent_name === parent.name
      )
      if (!linked) throw new ProjectAdvanceCategoryConflict(group.children[i].name)
    }
    // Do not add new children to a used, ungrouped parent. Its direct transactions
    // need manual reconciliation first (same limitation as the mobile client).
    if (parent && (parent.tx_count ?? 0) > 0 &&
      existingChildren.some((child) => !child)) {
      throw new ProjectAdvanceCategoryConflict(group.name)
    }
  }
}

export function missingProjectAdvanceCategoryCount(rows: readonly ProjectAdvanceCategory[]): number {
  assertCompatible(rows)
  return PROJECT_ADVANCE_PRESET.reduce((total, group) => {
    return total + (findCategory(rows, group.kind, group.name) ? 0 : 1) +
      group.children.filter((child) => !findCategory(rows, group.kind, child.name)).length
  }, 0)
}

/**
 * Uses the normal authorized category write endpoint so every change enters
 * sync_changes and is visible to mobile clients. No mass D1 migration.
 * Existing categories are not renamed/moved; rerunning fills only missing rows.
 */
export async function ensureProjectAdvanceCategories(
  load: () => Promise<ProjectAdvanceCategory[]>,
  create: (category: CategoryPayload) => Promise<{ entity_id: string | null }>,
): Promise<number> {
  const rows = await load()
  assertCompatible(rows) // fail before the first mutation if the hierarchy is ambiguous
  let created = 0

  for (const [groupIndex, group] of PROJECT_ADVANCE_PRESET.entries()) {
    let parent = findCategory(rows, group.kind, group.name)
    if (!parent) {
      const result = await create({
        name: group.name, kind: group.kind, level: 1, sort_order: 90 + groupIndex,
        icon: group.icon, icon_type: 'material',
      })
      if (!result.entity_id) throw new Error('Category create returned no entity ID')
      parent = { id: result.entity_id, name: group.name, kind: group.kind, level: 1 }
      rows.push(parent)
      created++
    }
    for (const [childIndex, child] of group.children.entries()) {
      if (findCategory(rows, group.kind, child.name)) continue
      const result = await create({
        name: child.name, kind: group.kind, level: 2,
        sort_order: (90 + groupIndex) * 100 + childIndex + 1,
        icon: child.icon, icon_type: 'material',
        parent_name: parent.name, parent_sync_id: parent.id,
      })
      if (!result.entity_id) throw new Error('Category create returned no entity ID')
      rows.push({
        id: result.entity_id, name: child.name, kind: group.kind, level: 2,
        parent_name: parent.name, parent_sync_id: parent.id,
      })
      created++
    }
  }
  return created
}
