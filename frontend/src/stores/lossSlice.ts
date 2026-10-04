/**
 * 损泐与比对 slice（Redux Toolkit）
 * 维护字位损泐集合、比对记录与比对 A/B 选择及筛选条件。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createId, db } from '@/utils/db';
import { saveWithRevision } from '@/utils/merge';
import type { Loss, LossDraft, LossSeverity, LossType } from '@/types/loss';
import type { Compare, CompareDraft } from '@/types/compare';
import { sortLosses } from '@/utils/collate';
import type { RootState } from './store';

export interface LossFilters {
  keyword: string;
  types: LossType[];
  severities: LossSeverity[];
}

export interface LossState {
  items: Loss[];
  compares: Compare[];
  loading: boolean;
  ready: boolean;
  error: string;
  filters: LossFilters;
  /** 比对台选择的两个拓本 */
  compareAId: string | null;
  compareBId: string | null;
}

const initialState: LossState = {
  items: [],
  compares: [],
  loading: false,
  ready: false,
  error: '',
  filters: { keyword: '', types: [], severities: [] },
  compareAId: null,
  compareBId: null,
};

export const loadLosses = createAsyncThunk('loss/load', async () => {
  const [losses, compares] = await Promise.all([db.losses.toArray(), db.compares.toArray()]);
  compares.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { losses: sortLosses(losses), compares };
});

export const createLoss = createAsyncThunk('loss/create', async (draft: LossDraft, { dispatch }) => {
  const now = Date.now();
  const row: Loss = { ...draft, id: createId('loss'), createdAt: now, updatedAt: now, rev: 1 };
  await db.losses.put(row);
  await dispatch(loadLosses());
  return row;
});

/** 更新损泐字位：带修订号的乐观并发保存，返回保存结果或冲突草稿 */
export const updateLoss = createAsyncThunk(
  'loss/update',
  async (payload: { id: string; patch: Partial<Loss>; base: Loss }, { dispatch }) => {
    const result = await saveWithRevision(
      db.losses,
      payload.base,
      payload.patch,
      'loss',
      `L${String(payload.base.lineNo).padStart(2, '0')}C${String(payload.base.charNo).padStart(2, '0')}`,
    );
    if (result.status === 'saved') await dispatch(loadLosses());
    return result;
  },
);

export const removeLoss = createAsyncThunk('loss/remove', async (id: string, { dispatch }) => {
  await db.losses.delete(id);
  await dispatch(loadLosses());
});

export const batchUpdateLosses = createAsyncThunk(
  'loss/batch',
  async (payload: { ids: string[]; patch: Partial<Loss> }, { dispatch, getState }) => {
    const state = getState() as RootState;
    const now = Date.now();
    const rows = state.loss.items
      .filter((item) => payload.ids.includes(item.id))
      .map((item) => ({ ...item, ...payload.patch, rev: item.rev + 1, updatedAt: now }));
    if (rows.length > 0) await db.losses.bulkPut(rows);
    await dispatch(loadLosses());
  },
);

export const saveCompare = createAsyncThunk('compare/save', async (draft: CompareDraft, { dispatch }) => {
  const now = Date.now();
  const row: Compare = { ...draft, id: createId('cmp'), createdAt: now, updatedAt: now, rev: 1 };
  await db.compares.put(row);
  await dispatch(loadLosses());
  return row;
});

/** 更新比对记录：带修订号的乐观并发保存 */
export const updateCompare = createAsyncThunk(
  'compare/update',
  async (payload: { id: string; patch: Partial<Compare>; base: Compare }, { dispatch }) => {
    const result = await saveWithRevision(
      db.compares,
      payload.base,
      payload.patch,
      'compare',
      payload.base.date,
    );
    if (result.status === 'saved') await dispatch(loadLosses());
    return result;
  },
);

export const removeCompare = createAsyncThunk('compare/remove', async (id: string, { dispatch }) => {
  await db.compares.delete(id);
  await dispatch(loadLosses());
});

const lossSlice = createSlice({
  name: 'loss',
  initialState,
  reducers: {
    setLossKeyword(state, action: PayloadAction<string>) {
      state.filters.keyword = action.payload;
    },
    setLossTypes(state, action: PayloadAction<LossType[]>) {
      state.filters.types = action.payload;
    },
    setLossSeverities(state, action: PayloadAction<LossSeverity[]>) {
      state.filters.severities = action.payload;
    },
    resetLossFilters(state) {
      state.filters = { keyword: '', types: [], severities: [] };
    },
    setCompareA(state, action: PayloadAction<string | null>) {
      state.compareAId = action.payload;
    },
    setCompareB(state, action: PayloadAction<string | null>) {
      state.compareBId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadLosses.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadLosses.fulfilled, (state, action) => {
        state.items = action.payload.losses;
        state.compares = action.payload.compares;
        state.loading = false;
        state.ready = true;
        state.error = '';
      })
      .addCase(loadLosses.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '损泐字位读取失败';
      });
  },
});

export const {
  setLossKeyword,
  setLossTypes,
  setLossSeverities,
  resetLossFilters,
  setCompareA,
  setCompareB,
} = lossSlice.actions;

export const selectLossState = (state: RootState): LossState => state.loss;
export const selectLosses = (state: RootState): Loss[] => state.loss.items;
export const selectCompares = (state: RootState): Compare[] => state.loss.compares;

/** 派生选择器：关键字 + 类型 + 程度筛选（全库维度） */
export function selectFilteredLosses(state: RootState): Loss[] {
  const { items, filters } = state.loss;
  const keyword = filters.keyword.trim();
  return items.filter((loss) => {
    if (keyword.length > 0) {
      const haystack = `${loss.lineNo}${loss.charNo}${loss.note}`;
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.types.length > 0 && !filters.types.includes(loss.type)) return false;
    if (filters.severities.length > 0 && !filters.severities.includes(loss.severity)) return false;
    return true;
  });
}

/** 某拓本在某碑刻下的损泐条数统计 */
export function selectLossCountByRubbing(state: RootState): Record<string, number> {
  const result: Record<string, number> = {};
  state.loss.items.forEach((loss) => {
    result[loss.rubbingId] = (result[loss.rubbingId] ?? 0) + 1;
  });
  return result;
}

export default lossSlice.reducer;
