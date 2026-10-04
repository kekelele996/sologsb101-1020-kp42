/**
 * 冲突 slice（Redux Toolkit）
 * 全局管理待处理的合并冲突：保存时检测到冲突 → 入队 → 全局弹窗让用户挑选 → 合并保存。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db } from '@/utils/db';
import { resolveConflict as resolveConflictRecord } from '@/utils/merge';
import type { Conflict, ConflictDraft, ConflictTarget } from '@/types/conflict';
import { loadSteles } from './steleSlice';
import { loadRubbings } from './rubbingSlice';
import { loadLosses } from './lossSlice';
import type { RootState } from './store';

export interface ConflictState {
  /** 当前待处理的冲突（全局弹窗消费） */
  pending: Conflict | null;
}

const initialState: ConflictState = {
  pending: null,
};

/** 冲突目标 → 对应 Dexie 表的映射 */
function tableOf(target: ConflictTarget) {
  switch (target) {
    case 'stele':
      return db.steles;
    case 'rubbing':
      return db.rubbings;
    case 'loss':
      return db.losses;
    case 'seal':
      return db.seals;
    case 'compare':
      return db.compares;
  }
}

/** 保存时检测到冲突：写入 conflicts 表并入队等待用户挑选 */
export const queueConflict = createAsyncThunk(
  'conflict/queue',
  async (draft: ConflictDraft, { dispatch }) => {
    const now = Date.now();
    const row: Conflict = {
      ...draft,
      id: `cf_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: now,
      resolved: false,
    };
    await db.conflicts.put(row);
    dispatch(setPending(row));
    return row;
  },
);

/** 按用户挑选的字段合并两版后保存（只重试本侧这一次保存） */
export const resolveConflict = createAsyncThunk(
  'conflict/resolve',
  async (payload: { conflict: Conflict; choices: Record<string, 'mine' | 'current'> }, { dispatch }) => {
    const { conflict, choices } = payload;
    if (conflict.fields.includes('__deleted__')) {
      // 记录已被对方删除，无法合并，直接标记冲突已处理
      await db.conflicts.update(conflict.id, { resolved: true });
      dispatch(setPending(null));
      return { ok: false as const, reason: 'deleted' as const };
    }
    const table = tableOf(conflict.target) as unknown as Parameters<typeof resolveConflictRecord>[0];
    await resolveConflictRecord(table, conflict, choices);
    await db.conflicts.update(conflict.id, { resolved: true });
    dispatch(setPending(null));
    // 合并保存后刷新对应数据，让页面看到最新版本
    switch (conflict.target) {
      case 'stele':
        await dispatch(loadSteles());
        break;
      case 'rubbing':
      case 'seal':
        await dispatch(loadRubbings());
        break;
      case 'loss':
      case 'compare':
        await dispatch(loadLosses());
        break;
    }
    return { ok: true as const };
  },
);

/** 放弃本次冲突的本侧修改 */
export const dismissConflict = createAsyncThunk(
  'conflict/dismiss',
  async (conflict: Conflict, { dispatch }) => {
    await db.conflicts.update(conflict.id, { resolved: true });
    dispatch(setPending(null));
  },
);

const conflictSlice = createSlice({
  name: 'conflict',
  initialState,
  reducers: {
    setPending(state, action: PayloadAction<Conflict | null>) {
      state.pending = action.payload;
    },
  },
});

export const { setPending } = conflictSlice.actions;

export const selectConflictState = (state: RootState): ConflictState => state.conflict;
export const selectPendingConflict = (state: RootState): Conflict | null => state.conflict.pending;

export default conflictSlice.reducer;
