/**
 * 冲突解决弹窗
 * 两边同时编辑同一条记录且改了同一字段时，并排展示两版供用户逐字段挑选。
 * 全局挂载在 App 外壳，消费 conflictSlice 的 pending 状态。
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, App as AntdApp, Button, Modal, Radio, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import { dismissConflict, resolveConflict, selectPendingConflict } from '@/stores/conflictSlice';

const TARGET_LABEL: Record<string, string> = {
  stele: '碑刻',
  rubbing: '拓本',
  loss: '损泐字位',
  seal: '钤印',
  compare: '比对记录',
};

/** 字段名中文化（常见字段兜底） */
const FIELD_LABEL: Record<string, string> = {
  title: '碑名',
  era: '年代',
  location: '所在地',
  form: '形制',
  sizeCm: '尺寸',
  calligrapher: '书者',
  method: '拓法',
  paperType: '纸种',
  inkTone: '墨色',
  collectionNo: '收藏号',
  dateGuess: '年代判断',
  state: '状态',
  versionNo: '版本序号',
  lineNo: '行号',
  charNo: '字位',
  type: '损泐类型',
  severity: '严重程度',
  note: '释文备注',
  sealText: '印文',
  position: '位置',
  transcription: '释文',
  sealType: '印别',
  conclusion: '断代结论',
  diffCount: '差异字数',
  operator: '操作人',
  date: '比对日期',
};

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default function ConflictModal() {
  const { message } = AntdApp.useApp();
  const dispatch = useAppDispatch();
  const pending = useAppSelector(selectPendingConflict);
  const [choices, setChoices] = useState<Record<string, 'mine' | 'current'>>({});

  const isDeleted = pending?.fields.includes('__deleted__') ?? false;

  useEffect(() => {
    if (pending) {
      // 默认全部采用对方版本
      const defaults: Record<string, 'mine' | 'current'> = {};
      pending.fields.forEach((f) => {
        if (f !== '__deleted__') defaults[f] = 'current';
      });
      setChoices(defaults);
    }
  }, [pending]);

  const fields = useMemo(() => (pending?.fields.filter((f) => f !== '__deleted__') ?? []), [pending]);

  const allMine = (): void => {
    const next: Record<string, 'mine' | 'current'> = {};
    fields.forEach((f) => {
      next[f] = 'mine';
    });
    setChoices(next);
  };

  const allCurrent = (): void => {
    const next: Record<string, 'mine' | 'current'> = {};
    fields.forEach((f) => {
      next[f] = 'current';
    });
    setChoices(next);
  };

  const handleResolve = async (): Promise<void> => {
    if (!pending) return;
    await dispatch(resolveConflict({ conflict: pending, choices })).unwrap();
    message.success('已按挑选结果合并保存');
  };

  const handleDismiss = async (): Promise<void> => {
    if (!pending) return;
    await dispatch(dismissConflict(pending)).unwrap();
    message.info('已放弃本次冲突的本侧修改');
  };

  const columns: ColumnsType<string> = [
    {
      title: '字段',
      dataIndex: 'field',
      width: 120,
      render: (field: string) => <Typography.Text strong>{FIELD_LABEL[field] ?? field}</Typography.Text>,
    },
    {
      title: '打开时版本',
      key: 'base',
      width: 160,
      render: (_value, field) => (
        <Typography.Text type="secondary" delete>
          {displayValue(pending?.base[field])}
        </Typography.Text>
      ),
    },
    {
      title: '本侧修改',
      key: 'mine',
      width: 200,
      render: (_value, field) => (
        <Space size={6}>
          <Radio
            checked={choices[field] === 'mine'}
            onChange={() => setChoices((prev) => ({ ...prev, [field]: 'mine' }))}
          >
            <Tag color="blue">{displayValue(pending?.mine[field])}</Tag>
          </Radio>
        </Space>
      ),
    },
    {
      title: '对方先动版本',
      key: 'current',
      render: (_value, field) => (
        <Space size={6}>
          <Radio
            checked={choices[field] === 'current'}
            onChange={() => setChoices((prev) => ({ ...prev, [field]: 'current' }))}
          >
            <Tag color="gold">{displayValue(pending?.current[field])}</Tag>
          </Radio>
        </Space>
      ),
    },
  ];

  return (
    <Modal
      open={pending !== null}
      title={
        <Space>
          <Tag color="red">合并冲突</Tag>
          <span>
            {pending ? TARGET_LABEL[pending.target] ?? pending.target : ''} · {pending?.targetLabel}
          </span>
        </Space>
      }
      width={820}
      onCancel={handleDismiss}
      footer={
        isDeleted ? (
          <Space>
            <Button onClick={handleDismiss}>知道了</Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={allMine}>全部采用本侧</Button>
            <Button onClick={allCurrent}>全部采用对方</Button>
            <Button onClick={handleDismiss}>放弃本侧</Button>
            <Button type="primary" onClick={() => void handleResolve()}>
              按挑选结果保存
            </Button>
          </Space>
        )
      }
    >
      {isDeleted ? (
        <Alert
          type="warning"
          showIcon
          message="该记录已被对方删除"
          description="在你编辑期间，对方已将这条记录删除。本侧修改无法合并，已放弃本次保存。"
        />
      ) : (
        <>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="两边都改过同一处，已保留两版供挑选"
            description="登记岗与标注岗同时编辑了同一条记录且改了同一字段。请逐字段选择要保留的版本，合并后只重试本侧这一次保存。"
          />
          <Table<string>
            rowKey={(field) => field}
            size="small"
            pagination={false}
            columns={columns}
            dataSource={fields}
          />
        </>
      )}
    </Modal>
  );
}
