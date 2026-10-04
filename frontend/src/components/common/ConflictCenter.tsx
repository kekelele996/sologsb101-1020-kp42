/**
 * ConflictCenter 待裁决冲突中心
 * 顶栏铃铛打开；两边同改同字段时两版并排，编目员逐字段挑定后才落库。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Badge, Button, Drawer, Empty, Radio, Space, Tag, Typography } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { liveQuery } from 'dexie';
import { db } from '@/utils/db';
import { CONFLICT_TABLE_LABEL } from '@/types/conflict';
import type { Conflict } from '@/types/conflict';
import {
  applyConflictResolution,
  discardConflict,
  fieldLabel,
  formatFieldValue,
  getActor,
} from '@/utils/concurrency';
import { OPEN_CONFLICTS_EVENT } from '@/utils/saveFeedback';

type Choice = 'mine' | 'theirs';

export default function ConflictCenter() {
  const { message } = AntdApp.useApp();
  const [open, setOpen] = useState(false);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  useEffect(() => {
    const subscription = liveQuery(() =>
      db.conflicts.where('status').equals('open').reverse().sortBy('updatedAt'),
    ).subscribe({
      next: (rows) => setConflicts(rows),
      error: () => setConflicts([]),
    });
    const onOpen = (): void => setOpen(true);
    window.addEventListener(OPEN_CONFLICTS_EVENT, onOpen);
    return () => {
      subscription.unsubscribe();
      window.removeEventListener(OPEN_CONFLICTS_EVENT, onOpen);
    };
  }, []);

  const openCount = conflicts.length;

  const choiceKey = useCallback((conflictId: string, field: string): string => `${conflictId}::${field}`, []);

  const initialChoices = useMemo(() => {
    const next: Record<string, Choice> = {};
    conflicts.forEach((conflict) => {
      conflict.fields.forEach((field) => {
        const key = choiceKey(conflict.id, field.field);
        next[key] = (field.resolvedValue as Choice | null) ?? 'mine';
      });
    });
    return next;
  }, [conflicts, choiceKey]);

  useEffect(() => {
    // 新增冲突默认「留本侧」，已有选择不动
    setChoices((prev) => {
      const next = { ...prev };
      Object.keys(initialChoices).forEach((key) => {
        if (!(key in next)) next[key] = initialChoices[key];
      });
      return next;
    });
  }, [initialChoices]);

  const setChoice = (conflictId: string, field: string, value: Choice): void => {
    setChoices((prev) => ({ ...prev, [choiceKey(conflictId, field)]: value }));
  };

  const resolve = async (conflict: Conflict): Promise<void> => {
    const picked: Record<string, Choice> = {};
    conflict.fields.forEach((field) => {
      picked[field.field] = choices[choiceKey(conflict.id, field.field)] ?? 'mine';
    });
    setBusyId(conflict.id);
    try {
      const outcome = await applyConflictResolution(conflict, picked, getActor());
      if (outcome.status === 'conflict') {
        message.warning('裁决保存时该行又有新改动，新版本两版已再次留待裁决');
      } else {
        message.success('已按所选版本落库');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '裁决失败');
    } finally {
      setBusyId(null);
    }
  };

  const discard = async (conflict: Conflict): Promise<void> => {
    await discardConflict(conflict.id);
    message.info('已放弃该冲突单，维持库内现值');
  };

  return (
    <>
      <Badge count={openCount} size="small" offset={[-4, 4]}>
        <Button
          size="small"
          icon={<WarningOutlined />}
          danger={openCount > 0}
          onClick={() => setOpen(true)}
          title="待裁决冲突：两边同改同一字段"
        >
          冲突
        </Button>
      </Badge>
      <Drawer
        open={open}
        title={`待裁决冲突（${openCount}）`}
        width={620}
        onClose={() => setOpen(false)}
        destroyOnClose={false}
      >
        {openCount === 0 ? (
          <Empty description="暂无两边同改的冲突；他人先保存时，本侧改动会自动字段级并入。" />
        ) : (
          <Space direction="vertical" size={14} style={{ width: '100%' }}>
            {conflicts.map((conflict) => (
              <div key={conflict.id} className="gb-conflict-card" style={{ border: '1px solid #f0d8c8', borderRadius: 8, padding: 12 }}>
                <Space size={6} wrap style={{ marginBottom: 8 }}>
                  <Tag color="red">{CONFLICT_TABLE_LABEL[conflict.table]}</Tag>
                  <Typography.Text strong>{conflict.recordLabel || conflict.recordId}</Typography.Text>
                  <Tag>打开版本 r{conflict.baseRev}</Tag>
                  <Tag color="gold">库内 r{conflict.currentRev}</Tag>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  本侧：{conflict.actor}
                </Typography.Text>
                <Space direction="vertical" size={10} style={{ width: '100%', marginTop: 8 }}>
                  {conflict.fields.map((field) => (
                    <div
                      key={field.field}
                      style={{ background: '#fffaf4', border: '1px solid #f3e4d6', borderRadius: 6, padding: 10 }}
                    >
                      <Typography.Text strong>{fieldLabel(conflict.table, field.field)}</Typography.Text>
                      <Radio.Group
                        size="small"
                        style={{ display: 'flex', marginTop: 6 }}
                        value={choices[choiceKey(conflict.id, field.field)] ?? 'mine'}
                        onChange={(event) => setChoice(conflict.id, field.field, event.target.value as Choice)}
                      >
                        <Radio value="mine" style={{ alignItems: 'flex-start' }}>
                          <Space direction="vertical" size={0}>
                            <Typography.Text strong>留本侧（{conflict.actor}）</Typography.Text>
                            <Typography.Text>
                              {formatFieldValue(conflict.table, field.field, field.mineValue)}
                            </Typography.Text>
                          </Space>
                        </Radio>
                        <Radio value="theirs" style={{ alignItems: 'flex-start' }}>
                          <Space direction="vertical" size={0}>
                            <Typography.Text strong>取他人先存版</Typography.Text>
                            <Typography.Text>
                              {formatFieldValue(conflict.table, field.field, field.theirsValue)}
                            </Typography.Text>
                          </Space>
                        </Radio>
                      </Radio.Group>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        打开时原值：{formatFieldValue(conflict.table, field.field, field.baseValue)}
                      </Typography.Text>
                    </div>
                  ))}
                </Space>
                <Space style={{ marginTop: 10 }}>
                  <Button type="primary" size="small" loading={busyId === conflict.id} onClick={() => void resolve(conflict)}>
                    按所选落库
                  </Button>
                  <Button size="small" onClick={() => void discard(conflict)}>
                    两版都不要（维持现值）
                  </Button>
                </Space>
              </div>
            ))}
          </Space>
        )}
      </Drawer>
    </>
  );
}
