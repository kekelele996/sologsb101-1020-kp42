/**
 * 三向合并与带修订号的保存
 * - threeWayMerge：base（打开时版本）、current（库中最新）、mine（本侧改动）
 *   本侧没动的字段保留 current；只有本侧动过的字段采用 mine；两边都动过且不同 → 标记冲突
 * - saveWithRevision：带修订号的乐观并发保存，修订号一致直接存，不一致走三向合并
 * - resolveConflict：按用户挑选的字段合并两版后保存
 */
import type { Table } from 'dexie';
import type { Conflict, ConflictDraft, ConflictTarget } from '@/types/conflict';

/** 字段级冲突：两边都改过同一字段且值不同 */
export interface FieldConflict<T> {
  field: keyof T;
  baseValue: unknown;
  mineValue: unknown;
  currentValue: unknown;
}

export interface MergeResult<T> {
  merged: T;
  conflicts: FieldConflict<T>[];
}

export type SaveResult<T> =
  | { status: 'saved'; record: T }
  | { status: 'conflict'; conflict: ConflictDraft };

/** 不参与合并的系统字段 */
const SYSTEM_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'rev']);

/** 深度相等：基本类型直接比较，对象 / 数组走 JSON 序列化 */
function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * 三向合并。
 * 规则：
 * - 本侧没动的字段（mine 与 base 相同）→ 保留 current
 * - 只有本侧动过的字段（mine 与 base 不同，current 与 base 相同）→ 采用 mine
 * - 两边都动过且不同 → 标记冲突，默认保留 current 等用户挑选
 */
export function threeWayMerge<T extends Record<string, unknown>>(
  base: T,
  current: T,
  mine: Partial<T>,
): MergeResult<T> {
  const merged: Record<string, unknown> = { ...current };
  const conflicts: FieldConflict<T>[] = [];

  const keys = new Set<string>([...Object.keys(base), ...Object.keys(current), ...Object.keys(mine)]);

  for (const key of keys) {
    if (SYSTEM_FIELDS.has(key)) continue;

    const baseVal = base[key];
    const currentVal = current[key];
    const mineVal = mine[key];

    const mineChanged = key in mine && !isEqual(mineVal, baseVal);
    const currentChanged = !isEqual(currentVal, baseVal);

    if (mineChanged && currentChanged && !isEqual(mineVal, currentVal)) {
      conflicts.push({ field: key, baseValue: baseVal, mineValue: mineVal, currentValue: currentVal });
    } else if (mineChanged) {
      merged[key] = mineVal;
    }
  }

  return { merged: merged as T, conflicts };
}

/**
 * 带修订号的乐观并发保存。
 * - 修订号一致：直接保存，修订号 +1
 * - 修订号不一致：三向合并；无冲突则保存合并结果，有冲突则返回冲突草稿
 * - 记录已被删除：返回冲突草稿（deleted 标记）
 */
export async function saveWithRevision<T extends { id: string; rev: number }>(
  table: Table<T, string>,
  base: T,
  patch: Partial<T>,
  target: ConflictTarget,
  targetLabel: string,
): Promise<SaveResult<T>> {
  const current = await table.get(base.id);

  if (!current) {
    // 记录已被对方删除
    return {
      status: 'conflict',
      conflict: {
        target,
        targetId: base.id,
        targetLabel,
        base: base as Record<string, unknown>,
        mine: patch as Record<string, unknown>,
        current: {},
        fields: ['__deleted__'],
      },
    };
  }

  if (current.rev === base.rev) {
    // 修订号一致，无并发，直接保存
    const record = { ...current, ...patch, rev: current.rev + 1, updatedAt: Date.now() } as unknown as T;
    await table.put(record);
    return { status: 'saved', record };
  }

  // 修订号不一致，三向合并
  const { merged, conflicts } = threeWayMerge(base, current, patch);
  if (conflicts.length === 0) {
    const record = { ...merged, rev: current.rev + 1, updatedAt: Date.now() } as unknown as T;
    await table.put(record);
    return { status: 'saved', record };
  }

  // 有冲突，保留两版
  return {
    status: 'conflict',
    conflict: {
      target,
      targetId: base.id,
      targetLabel,
      base: base as Record<string, unknown>,
      mine: patch as Record<string, unknown>,
      current: current as Record<string, unknown>,
      fields: conflicts.map((c) => String(c.field)),
    },
  };
}

/**
 * 按用户挑选的字段合并两版后保存。
 * choices: field → 'mine' | 'current'
 */
export async function resolveConflict<T extends { id: string; rev: number }>(
  table: Table<T, string>,
  conflict: Conflict,
  choices: Record<string, 'mine' | 'current'>,
): Promise<T> {
  const current = await table.get(conflict.targetId);
  if (!current) throw new Error('记录已被删除，无法合并');

  const resolved: Record<string, unknown> = { ...current };
  for (const [field, choice] of Object.entries(choices)) {
    if (field === '__deleted__') continue;
    if (choice === 'mine' && field in conflict.mine) {
      resolved[field] = conflict.mine[field];
    } else if (choice === 'current' && field in conflict.current) {
      resolved[field] = conflict.current[field];
    }
  }

  const record = { ...resolved, rev: current.rev + 1, updatedAt: Date.now() } as unknown as T;
  await table.put(record);
  return record;
}

/** 为存量记录补齐修订号（升级迁移用） */
export function withRevision<T extends object>(row: T, rev = 1): T {
  const currentRev = (row as Record<string, unknown>).rev;
  if (typeof currentRev === 'number' && currentRev > 0) return row;
  return { ...row, rev } as T;
}
