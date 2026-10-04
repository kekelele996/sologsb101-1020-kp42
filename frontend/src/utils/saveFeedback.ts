/**
 * 修订号保存结果的页面侧反馈
 * 合并成功照常提示；出现两边同改字段时引导去冲突中心挑版本。
 */
import type { MessageInstance } from 'antd/es/message/interface';
import { fieldLabel, type SaveOutcome } from '@/utils/concurrency';
import type { ConflictTable } from '@/types/conflict';

/** 打开全局冲突中心抽屉的自定义事件（ConflictCenter 监听） */
export const OPEN_CONFLICTS_EVENT = 'gbrubbing:open-conflicts';

export function openConflictCenter(): void {
  window.dispatchEvent(new CustomEvent(OPEN_CONFLICTS_EVENT));
}

/**
 * 按保存结果给出消息提示。
 * successText 为无并发时的正常文案；merged / conflict 时附带并入与待裁决字段。
 */
export function reportSaveOutcome(
  message: MessageInstance,
  outcome: SaveOutcome,
  tableName: ConflictTable,
  successText: string,
): void {
  const fieldNames = (fields: string[]): string => fields.map((field) => fieldLabel(tableName, field)).join('、');
  if (outcome.status === 'conflict') {
    const mergedTip = outcome.changedFields.length > 0 ? `，已并入本侧：${fieldNames(outcome.changedFields)}` : '';
    message.warning({
      content: `「${fieldNames(outcome.conflictFields)}」两边都改过，两版已保留待裁决${mergedTip}`,
      duration: 5,
    });
    openConflictCenter();
    return;
  }
  if (outcome.status === 'merged') {
    if (outcome.changedFields.length === 0 && outcome.convergedFields.length > 0) {
      message.success({
        content: `他人也改了同一处且取值一致（${fieldNames(outcome.convergedFields)}），无需重复保存`,
        duration: 4,
      });
      return;
    }
    message.success({
      content: `已并入本侧改动（${fieldNames(outcome.changedFields) || '无差异字段'}），未覆盖他人刚保存的内容`,
      duration: 4,
    });
    return;
  }
  message.success(successText);
}
