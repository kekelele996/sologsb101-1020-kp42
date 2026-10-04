/**
 * 修订号乐观锁与三方合并
 *
 * 场景：登记岗与标注岗各开一个标签页编辑同一块碑刻 / 同一件拓本。
 * - 每次保存必须「报出自己打开的版本」baseRev；
 * - 库内 rev 与 baseRev 一致：无人先动，直接写入并 rev+1；
 * - 不一致：别人先保存过，只把本侧动过的字段并入（base → mine 的差异）；
 * - 同一字段两边都改成不同值：不做二选一，两版都写进 conflicts 表，交人裁决；
 * - 合并 / 冲突判定在事务内完成，过程性失败整体回滚后仅用「本侧那次改动」重试，
 *   绝不重放整行旧值去盖别人的数据。
 */
import type { Table } from 'dexie';
import { db } from './db';
import { createId } from './db';
import type { Conflict, ConflictTable, FieldConflict } from '@/types/conflict';
import { STELE_FORM_LABEL } from '@/types/stele';
import { INK_TONE_LABEL, RUBBING_METHOD_LABEL, RUBBING_STATE_LABEL } from '@/types/rubbing';
import { LOSS_SEVERITY_LABEL, LOSS_TYPE_LABEL } from '@/types/loss';
import { SEAL_TYPE_LABEL } from '@/types/seal';
import { COMPARE_CONCLUSION_LABEL } from '@/types/compare';

/** 旧数据补齐修订号时的起始值 */
export const INITIAL_REV = 1;

/** 参与三方合并的业务字段（rev / id / 时间戳不参与字段合并） */
export const TRACKED_FIELDS: Record<ConflictTable, readonly string[]> = {
  steles: ['title', 'era', 'location', 'form', 'sizeCm', 'calligrapher'],
  rubbings: ['steleId', 'versionNo', 'method', 'paperType', 'inkTone', 'sizeCm', 'collectionNo', 'dateGuess', 'state'],
  losses: ['rubbingId', 'lineNo', 'charNo', 'type', 'severity', 'note'],
  seals: ['rubbingId', 'sealText', 'position', 'transcription', 'sealType'],
  compares: ['steleId', 'rubbingIdA', 'rubbingIdB', 'diffCount', 'conclusion', 'operator', 'date'],
};

export const FIELD_LABELS: Record<ConflictTable, Record<string, string>> = {
  steles: { title: '碑名', era: '年代', location: '所在地', form: '形制', sizeCm: '尺寸', calligrapher: '书者' },
  rubbings: {
    steleId: '所属碑刻',
    versionNo: '版本序号',
    method: '拓法',
    paperType: '纸种',
    inkTone: '墨色',
    sizeCm: '尺寸',
    collectionNo: '收藏号',
    dateGuess: '年代判断',
    state: '状态',
  },
  losses: { rubbingId: '所属拓本', lineNo: '行号', charNo: '字位', type: '损泐类型', severity: '严重程度', note: '释文备注' },
  seals: { rubbingId: '所属拓本', sealText: '印文', position: '位置', transcription: '释文', sealType: '印别' },
  compares: {
    steleId: '所属碑刻',
    rubbingIdA: '拓本 A',
    rubbingIdB: '拓本 B',
    diffCount: '差异字数',
    conclusion: '断代结论',
    operator: '操作人',
    date: '比对日期',
  },
};

interface AnyRow {
  id: string;
  rev: number;
  updatedAt: number;
  [key: string]: unknown;
}

export interface SaveOutcome {
  /** saved=无人先动直接保存；merged=检测到他人改动后字段级并入；conflict=存在两边同改字段 */
  status: 'saved' | 'merged' | 'conflict';
  recordId: string;
  /** 保存后库内最新修订号（整行未变时维持原 rev） */
  rev: number;
  /** 本次真正写入的字段 */
  changedFields: string[];
  /** 双方改成相同值、无需处理的字段 */
  convergedFields: string[];
  conflictId: string | null;
  /** 留给人裁决的字段名 */
  conflictFields: string[];
}

export class RevisionSaveError extends Error {
  code: 'not-found' | 'save-failed';
  constructor(code: 'not-found' | 'save-failed', message: string) {
    super(message);
    this.name = 'RevisionSaveError';
    this.code = code;
  }
}

export interface SaveRevisionParams {
  tableName: ConflictTable;
  id: string;
  /** 本侧打开编辑时的整行（含 rev），三方合并的 base */
  base: { rev?: number } & Record<string, unknown>;
  /** 本侧表单值；内部会与 base 求差，只有真正动过的字段参与合并 */
  patch: Record<string, unknown>;
  actor: string;
  recordLabel: string;
}

function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

/** 从 patch 中剔除主键 / 修订号 / 时间戳，只留业务字段 */
export function toFieldPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  Object.keys(patch).forEach((key) => {
    if (key !== 'id' && key !== 'rev' && key !== 'createdAt' && key !== 'updatedAt') {
      result[key] = patch[key];
    }
  });
  return result;
}

function businessTable(tableName: ConflictTable): Table<AnyRow, string> {
  switch (tableName) {
    case 'steles':
      return db.steles as unknown as Table<AnyRow, string>;
    case 'rubbings':
      return db.rubbings as unknown as Table<AnyRow, string>;
    case 'losses':
      return db.losses as unknown as Table<AnyRow, string>;
    case 'seals':
      return db.seals as unknown as Table<AnyRow, string>;
    case 'compares':
      return db.compares as unknown as Table<AnyRow, string>;
  }
}

/**
 * 单遍合并（不自行开事务，便于批量场景并入同一事务）。
 */
async function passSave(conflicts: Table<Conflict, string>, params: SaveRevisionParams): Promise<SaveOutcome> {
  const { tableName, id, base, patch, actor, recordLabel } = params;
  const table = businessTable(tableName);
  const tracked = TRACKED_FIELDS[tableName];

  const current = await table.get(id);
  if (!current) throw new RevisionSaveError('not-found', `记录不存在或已被删除：${tableName}/${id}`);

  const currentRev = typeof current.rev === 'number' && current.rev > 0 ? current.rev : INITIAL_REV;
  const baseRev = typeof base.rev === 'number' && base.rev > 0 ? base.rev : INITIAL_REV;

  // 本侧动过的字段：base → patch 的差量（旧数据没有 rev 时，base 缺字段按与库内一致处理）
  const mineChanged = Object.keys(patch).filter(
    (key) => tracked.includes(key) && !sameValue(base[key], patch[key]),
  );

  if (mineChanged.length === 0) {
    return {
      status: 'saved',
      recordId: id,
      rev: currentRev,
      changedFields: [],
      convergedFields: [],
      conflictId: null,
      conflictFields: [],
    };
  }

  // 无人先动：整行方向无分叉，直接写差量并推进修订号
  if (currentRev === baseRev) {
    const next: AnyRow = { ...current, rev: currentRev + 1, updatedAt: Date.now() };
    mineChanged.forEach((key) => {
      next[key] = patch[key];
    });
    await table.put(next);
    return {
      status: 'saved',
      recordId: id,
      rev: currentRev + 1,
      changedFields: mineChanged,
      convergedFields: [],
      conflictId: null,
      conflictFields: [],
    };
  }

  // 别人先动过：逐字段三方合并
  const autoFields: string[] = [];
  const convergedFields: string[] = [];
  const divergent: FieldConflict[] = [];
  mineChanged.forEach((key) => {
    const baseValue = base[key];
    const mineValue = patch[key];
    const theirsValue = current[key];
    if (sameValue(mineValue, theirsValue)) {
      convergedFields.push(key); // 两边改成同一个值
    } else if (sameValue(baseValue, theirsValue)) {
      autoFields.push(key); // 对方没动这个字段 → 并入本侧
    } else {
      divergent.push({ field: key, baseValue, mineValue, theirsValue, resolvedValue: null });
    }
  });

  const next: AnyRow = { ...current };
  if (autoFields.length > 0) {
    autoFields.forEach((key) => {
      next[key] = patch[key];
    });
    next.rev = currentRev + 1;
    next.updatedAt = Date.now();
    await table.put(next);
  } else {
    next.rev = currentRev;
  }

  let conflictId: string | null = null;
  if (divergent.length > 0) {
    const openRows = await conflicts
      .where('recordId')
      .equals(id)
      .filter((row) => row.status === 'open' && row.table === tableName)
      .toArray();
    const existing = openRows[0];
    const now = Date.now();
    if (existing) {
      // 同一记录已有未裁决冲突：新字段追加，已逐字段选定（resolvedValue）的保留选择
      const mergedFields = [...existing.fields];
      divergent.forEach((incoming) => {
        const found = mergedFields.find((item) => item.field === incoming.field);
        if (found) {
          found.baseValue = incoming.baseValue;
          found.mineValue = incoming.mineValue;
          found.theirsValue = incoming.theirsValue;
        } else {
          mergedFields.push(incoming);
        }
      });
      conflictId = existing.id;
      await conflicts.put({
        ...existing,
        fields: mergedFields,
        currentRev: next.rev,
        actor,
        updatedAt: now,
      });
    } else {
      conflictId = createId('cnf');
      await conflicts.put({
        id: conflictId,
        table: tableName,
        recordId: id,
        recordLabel,
        baseRev,
        currentRev: next.rev,
        actor,
        otherActor: '',
        fields: divergent,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  return {
    status: divergent.length > 0 ? 'conflict' : 'merged',
    recordId: id,
    rev: next.rev,
    changedFields: autoFields,
    convergedFields,
    conflictId,
    conflictFields: divergent.map((item) => item.field),
  };
}

/**
 * 带修订号的保存。
 * 事务保证「合并判定 + 行写入 + 冲突落库」原子完成；
 * 仅在 IndexedDB 过程性失败时重试，且重试只携带本侧那次差量，不重放整行。
 */
export async function saveWithRevision(
  params: SaveRevisionParams,
  options: { maxAttempts?: number } = {},
): Promise<SaveOutcome> {
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await db.transaction('rw', [businessTable(params.tableName), db.conflicts], async () =>
        passSave(db.conflicts, params),
      );
    } catch (error) {
      // 业务性失败（记录没了）不重试
      if (error instanceof RevisionSaveError && error.code === 'not-found') throw error;
      lastError = error;
      if (attempt === maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, 30 * attempt));
    }
  }
  throw new RevisionSaveError(
    'save-failed',
    `修订号保存重试 ${maxAttempts} 次仍失败：${lastError instanceof Error ? lastError.message : '未知错误'}`,
  );
}

/**
 * 批量带修订号保存（批量改状态 / 程度 / 印别 / 版本序号重排）。
 * 逐行各自三方合并，互不连坐；结果汇总返回。
 */
export async function saveBatchWithRevision(
  tableName: ConflictTable,
  items: Array<Pick<SaveRevisionParams, 'id' | 'base' | 'patch' | 'recordLabel'>>,
  actor: string,
): Promise<{ results: SaveOutcome[]; mergedCount: number; conflictCount: number; notFound: string[] }> {
  const results: SaveOutcome[] = [];
  const notFound: string[] = [];
  await db.transaction('rw', [businessTable(tableName), db.conflicts], async () => {
    for (const item of items) {
      try {
        results.push(await passSave(db.conflicts, { ...item, tableName, actor }));
      } catch (error) {
        if (error instanceof RevisionSaveError && error.code === 'not-found') {
          notFound.push(item.id);
        } else {
          throw error;
        }
      }
    }
  });
  return {
    results,
    mergedCount: results.filter((item) => item.status === 'merged').length,
    conflictCount: results.filter((item) => item.status === 'conflict').length,
    notFound,
  };
}

/**
 * 应用人工裁决：删除旧冲突单，再以冲突单记录的修订号为 base 保存挑定的值。
 * 若保存瞬间该行又被别人改动且仍分叉，会生成一张新的冲突单，不会强行覆盖。
 */
export async function applyConflictResolution(
  conflict: Conflict,
  choices: Record<string, 'mine' | 'theirs'>,
  actor: string,
): Promise<SaveOutcome> {
  const base: Record<string, unknown> = { rev: conflict.currentRev };
  const patch: Record<string, unknown> = {};
  conflict.fields.forEach((field) => {
    const choice = choices[field.field] ?? 'mine';
    base[field.field] = field.baseValue;
    patch[field.field] = choice === 'mine' ? field.mineValue : field.theirsValue;
  });
  return db.transaction('rw', [businessTable(conflict.table), db.conflicts], async () => {
    await db.conflicts.delete(conflict.id);
    return passSave(db.conflicts, {
      tableName: conflict.table,
      id: conflict.recordId,
      base,
      patch,
      actor,
      recordLabel: conflict.recordLabel,
    });
  });
}

/** 放弃一张冲突单（两版都不采纳，维持库内现值） */
export async function discardConflict(conflictId: string): Promise<void> {
  await db.conflicts.delete(conflictId);
}

/* ------------------------------ 操作人（标签页身份） ------------------------------ */

const ACTOR_KEY = 'gbrubbing:actor';

/** 当前标签页的身份：按所在页面区分登记岗 / 标注岗，sessionStorage 保证标签页间不同 */
export function getActor(): string {
  const role =
    window.location.pathname.startsWith('/losses') || window.location.pathname.startsWith('/compare')
      ? '标注岗'
      : '登记岗';
  let tag = '';
  try {
    tag = sessionStorage.getItem(ACTOR_KEY) ?? '';
    if (!tag) {
      tag = Math.random().toString(36).slice(2, 6);
      sessionStorage.setItem(ACTOR_KEY, tag);
    }
  } catch {
    tag = Math.random().toString(36).slice(2, 6);
  }
  return `${role}·${tag}`;
}

/* ------------------------------ 冲突单展示格式化 ------------------------------ */

export function fieldLabel(tableName: ConflictTable, field: string): string {
  return FIELD_LABELS[tableName][field] ?? field;
}

/** 冲突两版取值的展示文本（枚举走中文映射） */
export function formatFieldValue(tableName: ConflictTable, field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）';
  switch (`${tableName}.${field}`) {
    case 'steles.form':
      return STELE_FORM_LABEL[value as keyof typeof STELE_FORM_LABEL] ?? String(value);
    case 'rubbings.method':
      return RUBBING_METHOD_LABEL[value as keyof typeof RUBBING_METHOD_LABEL] ?? String(value);
    case 'rubbings.inkTone':
      return INK_TONE_LABEL[value as keyof typeof INK_TONE_LABEL] ?? String(value);
    case 'rubbings.state':
      return RUBBING_STATE_LABEL[value as keyof typeof RUBBING_STATE_LABEL] ?? String(value);
    case 'losses.type':
      return LOSS_TYPE_LABEL[value as keyof typeof LOSS_TYPE_LABEL] ?? String(value);
    case 'losses.severity':
      return LOSS_SEVERITY_LABEL[value as keyof typeof LOSS_SEVERITY_LABEL] ?? String(value);
    case 'seals.sealType':
      return SEAL_TYPE_LABEL[value as keyof typeof SEAL_TYPE_LABEL] ?? String(value);
    case 'compares.conclusion':
      return COMPARE_CONCLUSION_LABEL[value as keyof typeof COMPARE_CONCLUSION_LABEL] ?? String(value);
    default:
      return String(value);
  }
}
