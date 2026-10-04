/**
 * 碑刻（Stele）数据模型
 * 一处碑刻的基本档案：碑名、年代、所在地、形制、尺寸与书者。
 */

/** 形制：碑 / 碣 / 摩崖 / 墓志 */
export type SteleForm = 'stele' | 'boulder' | 'cliff' | 'epitaph';

export interface Stele {
  /** 主键，播种数据使用固定字符串便于深链命中 */
  id: string;
  /** 碑名 */
  title: string;
  /** 年代 */
  era: string;
  /** 所在地 */
  location: string;
  /** 形制 */
  form: SteleForm;
  /** 尺寸（厘米，高×宽描述） */
  sizeCm: string;
  /** 书者 */
  calligrapher: string;
  /**
   * 修订号（乐观锁）：本侧打开时记下 base rev，保存时与库内 rev 比对；
   * 不一致说明别的标签页先动过，只并入本侧改动的字段。
   */
  rev: number;
  createdAt: number;
  updatedAt: number;
}

export type SteleDraft = Omit<Stele, 'id' | 'rev' | 'createdAt' | 'updatedAt'>;

export const STELE_FORM_LABEL: Record<SteleForm, string> = {
  stele: '碑',
  boulder: '碣',
  cliff: '摩崖',
  epitaph: '墓志',
};

export const STELE_FORM_COLOR: Record<SteleForm, string> = {
  stele: '#2f3a34',
  boulder: '#7a6a4f',
  cliff: '#3f5d6b',
  epitaph: '#7a4a3a',
};

export const STELE_FORM_OPTIONS: ReadonlyArray<{ value: SteleForm; label: string }> = [
  { value: 'stele', label: '碑' },
  { value: 'boulder', label: '碣' },
  { value: 'cliff', label: '摩崖' },
  { value: 'epitaph', label: '墓志' },
];

/** 碑刻维度的汇总统计，卡片回显使用 */
export interface SteleStat {
  steleId: string;
  /** 已收拓本数 */
  rubbingCount: number;
  /** 已编目拓本数 */
  catalogedCount: number;
  /** 版本差异条数（比对记录 diffCount 合计） */
  diffCount: number;
  /** 损泐字位条数 */
  lossCount: number;
  /** 钤印条数 */
  sealCount: number;
  /** 最近比对结论 */
  lastConclusion: string;
}

export function createEmptySteleDraft(): SteleDraft {
  return {
    title: '',
    era: '',
    location: '',
    form: 'stele',
    sizeCm: '',
    calligrapher: '',
  };
}
