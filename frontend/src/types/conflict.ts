/**
 * 待裁决冲突（Conflict）
 * 两个标签页同改同一记录的同一字段且取值不同，保存时不强行二选一，
 * 而是把两版都落库，由编目员在冲突中心逐字段挑定。
 */

/** 冲突所在的业务表 */
export type ConflictTable = 'steles' | 'rubbings' | 'losses' | 'seals' | 'compares';

export const CONFLICT_TABLE_LABEL: Record<ConflictTable, string> = {
  steles: '碑刻',
  rubbings: '拓本',
  losses: '损泐字位',
  seals: '钤印',
  compares: '比对记录',
};

/** 单个字段的两版取值（JSON 可序列化） */
export interface FieldConflict {
  /** 字段名（业务字段，不含 rev / updatedAt） */
  field: string;
  /** 本侧打开时的旧值（三方合并的 base） */
  baseValue: unknown;
  /** 本侧刚填的值 */
  mineValue: unknown;
  /** 别人先保存入库的值 */
  theirsValue: unknown;
  /** 已裁决选定的值；未裁决为 null */
  resolvedValue: unknown | null;
}

export interface Conflict {
  /** 主键 */
  id: string;
  /** 业务表名 */
  table: ConflictTable;
  /** 发生冲突的业务记录 id */
  recordId: string;
  /** 便于人读的记录标题（如「礼器碑 · 第 2 版」） */
  recordLabel: string;
  /** 本侧保存时报出的打开版本 */
  baseRev: number;
  /** 合并后库里的最新修订号 */
  currentRev: number;
  /** 本侧操作人（标签页角色） */
  actor: string;
  /** 先保存一侧记录在案的操作人（查得到时填） */
  otherActor: string;
  /** 逐字段两版 */
  fields: FieldConflict[];
  status: 'open' | 'resolved';
  createdAt: number;
  updatedAt: number;
}

export type ConflictDraft = Omit<Conflict, 'id' | 'createdAt' | 'updatedAt'>;
