/**
 * 拓本 slice（Redux Toolkit）
 * 维护拓本与钤印集合及筛选条件；同一碑刻下自动生成版本序号。
 * 拓本 / 钤印的编辑、批量改状态、批量改印别、版本序号重排全部走修订号三方合并：
 * 登记岗保存时只并入自己动过的条目，不会把标注岗刚填的损泐 / 断代盖回旧值。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createId, db, removeRubbingCascade } from '@/utils/db';
import {
  INITIAL_REV,
  getActor,
  saveBatchWithRevision,
  saveWithRevision,
  toFieldPatch,
  type SaveOutcome,
} from '@/utils/concurrency';
import {
  nextRubbingState,
  type Rubbing,
  type RubbingDraft,
  type RubbingMethod,
  type RubbingState,
} from '@/types/rubbing';
import type { Seal, SealDraft, SealType } from '@/types/seal';
import type { RootState } from './store';

export interface RubbingFilters {
  keyword: string;
  methods: RubbingMethod[];
  states: RubbingState[];
  steleId: string | null;
}

export interface RubbingState2 {
  items: Rubbing[];
  seals: Seal[];
  loading: boolean;
  ready: boolean;
  error: string;
  currentRubbingId: string | null;
  filters: RubbingFilters;
}

const initialState: RubbingState2 = {
  items: [],
  seals: [],
  loading: false,
  ready: false,
  error: '',
  currentRubbingId: null,
  filters: { keyword: '', methods: [], states: [], steleId: null },
};

export const loadRubbings = createAsyncThunk('rubbing/load', async () => {
  const [rubbings, seals] = await Promise.all([db.rubbings.toArray(), db.seals.toArray()]);
  rubbings.sort((a, b) => (a.steleId === b.steleId ? a.versionNo - b.versionNo : a.steleId.localeCompare(b.steleId)));
  seals.sort((a, b) => a.rubbingId.localeCompare(b.rubbingId));
  return { rubbings, seals };
});

export const createRubbing = createAsyncThunk('rubbing/create', async (draft: RubbingDraft, { dispatch }) => {
  const now = Date.now();
  const row: Rubbing = { ...draft, id: createId('rub'), rev: INITIAL_REV, createdAt: now, updatedAt: now };
  await db.rubbings.put(row);
  await dispatch(renumberRubbings(row.steleId));
  await dispatch(loadRubbings());
  return row;
});

export const updateRubbing = createAsyncThunk(
  'rubbing/update',
  async (
    payload: { id: string; base: Rubbing; patch: Partial<RubbingDraft> },
  ): Promise<SaveOutcome> => {
    return saveWithRevision({
      tableName: 'rubbings',
      id: payload.id,
      base: payload.base as unknown as Record<string, unknown>,
      patch: toFieldPatch(payload.patch as unknown as Record<string, unknown>),
      actor: getActor(),
      recordLabel: `第 ${payload.base.versionNo} 版拓本`,
    });
  },
);

export const advanceRubbingState = createAsyncThunk(
  'rubbing/advance',
  async (id: string, { getState }): Promise<SaveOutcome | null> => {
    const state = getState() as RootState;
    const row = state.rubbing.items.find((item) => item.id === id);
    if (!row) return null;
    const next = nextRubbingState(row.state);
    if (next === row.state) return null;
    return saveWithRevision({
      tableName: 'rubbings',
      id,
      base: row as unknown as Record<string, unknown>,
      patch: { state: next },
      actor: getActor(),
      recordLabel: `第 ${row.versionNo} 版拓本`,
    });
  },
);

export const batchUpdateRubbings = createAsyncThunk(
  'rubbing/batch',
  async (
    payload: { ids: string[]; patch: Partial<Pick<Rubbing, 'state'>> },
    { getState },
  ) => {
    const state = getState() as RootState;
    const byId = new Map(state.rubbing.items.map((item) => [item.id, item]));
    const items = payload.ids
      .map((id) => byId.get(id))
      .filter((item): item is Rubbing => Boolean(item))
      .map((item) => ({
        id: item.id,
        base: item as unknown as Record<string, unknown>,
        patch: toFieldPatch(payload.patch as unknown as Record<string, unknown>),
        recordLabel: `第 ${item.versionNo} 版拓本`,
      }));
    return saveBatchWithRevision('rubbings', items, getActor());
  },
);

export const removeRubbing = createAsyncThunk('rubbing/remove', async (id: string, { dispatch, getState }) => {
  const state = getState() as RootState;
  const row = state.rubbing.items.find((item) => item.id === id);
  await removeRubbingCascade(id);
  if (row) await dispatch(renumberRubbings(row.steleId));
  await dispatch(loadRubbings());
});

/** 重排某碑刻下拓本的版本序号：只有序号真的变了的拓本才推进修订号 */
export const renumberRubbings = createAsyncThunk('rubbing/renumber', async (steleId: string, { getState }) => {
  const state = getState() as RootState;
  const rows = state.rubbing.items
    .filter((item) => item.steleId === steleId)
    .sort((a, b) => (a.versionNo === b.versionNo ? a.createdAt - b.createdAt : a.versionNo - b.versionNo));
  const items = rows
    .map((row, index) => ({ row, target: index + 1 }))
    .filter(({ row, target }) => row.versionNo !== target)
    .map(({ row, target }) => ({
      id: row.id,
      base: row as unknown as Record<string, unknown>,
      patch: { versionNo: target },
      recordLabel: `第 ${row.versionNo} 版拓本`,
    }));
  if (items.length > 0) {
    return saveBatchWithRevision('rubbings', items, getActor());
  }
  return null;
});

/* ------------------------------ 钤印 ------------------------------ */

export const createSeal = createAsyncThunk('seal/create', async (draft: SealDraft, { dispatch }) => {
  const now = Date.now();
  const row: Seal = { ...draft, id: createId('seal'), rev: INITIAL_REV, createdAt: now, updatedAt: now };
  await db.seals.put(row);
  await dispatch(loadRubbings());
});

export const updateSeal = createAsyncThunk(
  'seal/update',
  async (
    payload: { id: string; base: Seal; patch: Partial<SealDraft> },
  ): Promise<SaveOutcome> => {
    return saveWithRevision({
      tableName: 'seals',
      id: payload.id,
      base: payload.base as unknown as Record<string, unknown>,
      patch: toFieldPatch(payload.patch as unknown as Record<string, unknown>),
      actor: getActor(),
      recordLabel: `钤印「${payload.base.sealText || '未填印文'}」`,
    });
  },
);

export const batchUpdateSeals = createAsyncThunk(
  'seal/batch',
  async (payload: { ids: string[]; sealType: SealType }, { getState }) => {
    const state = getState() as RootState;
    const byId = new Map(state.rubbing.seals.map((item) => [item.id, item]));
    const items = payload.ids
      .map((id) => byId.get(id))
      .filter((item): item is Seal => Boolean(item))
      .map((item) => ({
        id: item.id,
        base: item as unknown as Record<string, unknown>,
        patch: { sealType: payload.sealType },
        recordLabel: `钤印「${item.sealText || '未填印文'}」`,
      }));
    return saveBatchWithRevision('seals', items, getActor());
  },
);

export const removeSeal = createAsyncThunk('seal/remove', async (id: string, { dispatch }) => {
  await db.seals.delete(id);
  await dispatch(loadRubbings());
});

const rubbingSlice = createSlice({
  name: 'rubbing',
  initialState,
  reducers: {
    setCurrentRubbing(state, action: PayloadAction<string | null>) {
      state.currentRubbingId = action.payload;
    },
    setRubbingKeyword(state, action: PayloadAction<string>) {
      state.filters.keyword = action.payload;
    },
    setRubbingMethods(state, action: PayloadAction<RubbingMethod[]>) {
      state.filters.methods = action.payload;
    },
    setRubbingStates(state, action: PayloadAction<RubbingState[]>) {
      state.filters.states = action.payload;
    },
    setRubbingSteleFilter(state, action: PayloadAction<string | null>) {
      state.filters.steleId = action.payload;
    },
    resetRubbingFilters(state) {
      state.filters = { keyword: '', methods: [], states: [], steleId: null };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loadRubbings.pending, (state) => {
        state.loading = true;
      })
      .addCase(loadRubbings.fulfilled, (state, action) => {
        state.items = action.payload.rubbings;
        state.seals = action.payload.seals;
        state.loading = false;
        state.ready = true;
        state.error = '';
        const exists =
          state.currentRubbingId !== null && action.payload.rubbings.some((row) => row.id === state.currentRubbingId);
        if (!exists) state.currentRubbingId = action.payload.rubbings[0]?.id ?? null;
      })
      .addCase(loadRubbings.rejected, (state, action) => {
        state.loading = false;
        state.ready = true;
        state.error = action.error.message ?? '拓本读取失败';
      });
  },
});

export const {
  setCurrentRubbing,
  setRubbingKeyword,
  setRubbingMethods,
  setRubbingStates,
  setRubbingSteleFilter,
  resetRubbingFilters,
} = rubbingSlice.actions;

export const selectRubbingState = (state: RootState): RubbingState2 => state.rubbing;
export const selectRubbings = (state: RootState): Rubbing[] => state.rubbing.items;
export const selectSeals = (state: RootState): Seal[] => state.rubbing.seals;
export const selectCurrentRubbingId = (state: RootState): string | null => state.rubbing.currentRubbingId;

/** 派生选择器：关键字 + 拓法 + 状态 + 碑刻过滤 */
export function selectFilteredRubbings(state: RootState): Rubbing[] {
  const { items, filters } = state.rubbing;
  const keyword = filters.keyword.trim();
  return items.filter((rubbing) => {
    if (filters.steleId !== null && rubbing.steleId !== filters.steleId) return false;
    if (keyword.length > 0) {
      const haystack = `${rubbing.collectionNo}${rubbing.paperType}${rubbing.dateGuess}${rubbing.sizeCm}`;
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.methods.length > 0 && !filters.methods.includes(rubbing.method)) return false;
    if (filters.states.length > 0 && !filters.states.includes(rubbing.state)) return false;
    return true;
  });
}

export default rubbingSlice.reducer;
