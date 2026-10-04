/**
 * 合并冲突（Conflict）数据模型
 * 两边同时编辑同一条记录且改了同一字段时，保留两版快照供人工挑选。
 */

/** 冲突记录的目标表 */
export type ConflictTarget = 'stele' | 'rubbing' | 'loss' | 'seal' | 'compare';

export interface Conflict {
  id: string;
  /** 冲突的记录类型 */
  target: ConflictTarget;
  /** 冲突的记录 id */
  targetId: string;
  /** 记录标题（用于展示） */
  targetLabel: string;
  /** 打开时的基础版本快照 */
  base: Record<string, unknown>;
  /** 本侧提交的改动 */
  mine: Record<string, unknown>;
  /** 对方先动后的当前版本 */
  current: Record<string, unknown>;
  /** 冲突字段名列表 */
  fields: string[];
  createdAt: number;
  /** 是否已处理 */
  resolved: boolean;
}

export type ConflictDraft = Omit<Conflict, 'id' | 'createdAt' | 'resolved'>;
