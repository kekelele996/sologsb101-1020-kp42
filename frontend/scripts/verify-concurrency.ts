/* eslint-disable no-console */
/**
 * 并发保存行为验证（临时脚本，不进入构建）
 * 场景对照需求：
 * 1. 无人先动 → saved，rev+1
 * 2. 别人改了别的字段 → merged，只并入本侧动过的字段，他人字段保留
 * 3. 两边改同一字段成不同值 → conflict，两版都留进 conflicts，业务行保留对方值
 * 4. 两边改同一字段成相同值 → converged，无冲突
 * 5. 裁决后落库 → rev 推进，冲突单删除
 * 6. v2 旧数据（无 rev）升级 → rev=1
 */
import 'fake-indexeddb/auto';
import { db, DB_SCHEMA_VERSION } from '../src/utils/db';
import { saveWithRevision, applyConflictResolution, INITIAL_REV } from '../src/utils/concurrency';
import type { Rubbing } from '../src/types/rubbing';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      expected=${JSON.stringify(expected)}\n      actual  =${JSON.stringify(actual)}`}`);
  if (!ok) failures += 1;
}

async function scenarioMerge(): Promise<void> {
  await db.open();
  const now = Date.now();
  const row: Rubbing = {
    id: 'rub_test',
    steleId: 'stele_01',
    versionNo: 1,
    method: 'rub',
    paperType: '宣纸',
    inkTone: 'thick',
    sizeCm: '210×88',
    collectionNo: 'TB-X',
    dateGuess: '明拓',
    state: 'toCatalog',
    rev: INITIAL_REV,
    createdAt: now,
    updatedAt: now,
  };
  await db.rubbings.put(row);

  // 两边都打开 r1：登记岗改纸种，标注岗不改这里（模拟对方改了墨色）
  const registryBase = { ...row };
  const annotationBase = { ...row };

  // 标注岗先保存：墨色 thick→light（rev 1→2）
  const other = await saveWithRevision(
    {
      tableName: 'rubbings',
      id: row.id,
      base: annotationBase as unknown as Record<string, unknown>,
      patch: { inkTone: 'light' },
      actor: '标注岗·aaaa',
      recordLabel: '第 1 版拓本',
    },
  );
  check('先到一侧直接保存', [other.status, other.rev], ['saved', 2]);

  // 登记岗保存两个改动：纸种（对方没动）+ 收藏号（对方也没动）
  const r2 = await saveWithRevision({
    tableName: 'rubbings',
    id: row.id,
    base: registryBase as unknown as Record<string, unknown>,
    patch: { paperType: '棉连纸', collectionNo: 'TB-Y' },
    actor: '登记岗·bbbb',
    recordLabel: '第 1 版拓本',
  });
  check('后到一侧字段级并入', [r2.status, r2.rev, r2.changedFields.sort()], [
    'merged',
    3,
    ['collectionNo', 'paperType'],
  ]);
  const afterMerge = await db.rubbings.get(row.id);
  check('并入后对方的墨色保留 / 本侧两字段写入', [
    afterMerge?.inkTone,
    afterMerge?.paperType,
    afterMerge?.collectionNo,
    afterMerge?.rev,
  ], ['light', '棉连纸', 'TB-Y', 3]);

  // 第三轮：两边都改「年代判断」为不同值（base 明拓 → 清拓 / 民国拓）
  const baseA = await db.rubbings.get(row.id);
  const sideA = await saveWithRevision({
    tableName: 'rubbings',
    id: row.id,
    base: baseA as unknown as Record<string, unknown>,
    patch: { dateGuess: '清拓' },
    actor: '登记岗·bbbb',
    recordLabel: '第 1 版拓本',
  });
  check('分歧前先到保存 rev=4', [sideA.status, sideA.rev], ['saved', 4]);

  const sideB = await saveWithRevision({
    tableName: 'rubbings',
    id: row.id,
    base: { ...baseA } as unknown as Record<string, unknown>,
    patch: { dateGuess: '民国拓', paperType: '皮纸' }, // paperType 对方没动（对方上轮只动 dateGuess）
    actor: '标注岗·aaaa',
    recordLabel: '第 1 版拓本',
  });
  check('同字段两边异值→冲突；另一字段自动并入', [sideB.status, sideB.conflictFields, sideB.changedFields], [
    'conflict',
    ['dateGuess'],
    ['paperType'],
  ]);
  const conflicts = await db.conflicts.where('recordId').equals(row.id).toArray();
  check('冲突单留存两版', [
    conflicts.length,
    conflicts[0]?.fields[0]?.mineValue,
    conflicts[0]?.fields[0]?.theirsValue,
    conflicts[0]?.fields[0]?.baseValue,
  ], [1, '民国拓', '清拓', '明拓']);
  const afterConflict = await db.rubbings.get(row.id);
  check('冲突字段保留对方值，不被盖回', [afterConflict?.dateGuess, afterConflict?.paperType, afterConflict?.rev], [
    '清拓',
    '皮纸',
    5,
  ]);

  // 裁决：选本侧（民国拓）
  const resolved = await applyConflictResolution(conflicts[0], { dateGuess: 'mine' }, '登记岗·bbbb');
  check('裁决落库', [resolved.status, resolved.rev, resolved.changedFields], ['saved', 6, ['dateGuess']]);
  const finalRow = await db.rubbings.get(row.id);
  check('裁决后库内为本侧选择值', finalRow?.dateGuess, '民国拓');
  check('裁决后冲突单已删除', await db.conflicts.where('recordId').equals(row.id).count(), 0);
}

async function scenarioConverge(): Promise<void> {
  const now = Date.now();
  const row: Rubbing = {
    id: 'rub_conv',
    steleId: 'stele_01',
    versionNo: 2,
    method: 'pat',
    paperType: '宣纸',
    inkTone: 'thick',
    sizeCm: '',
    collectionNo: '',
    dateGuess: '',
    state: 'toCatalog',
    rev: 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.rubbings.put(row);
  await saveWithRevision({
    tableName: 'rubbings',
    id: row.id,
    base: { ...row } as unknown as Record<string, unknown>,
    patch: { state: 'cataloged' },
    actor: '登记岗·bbbb',
    recordLabel: '第 2 版拓本',
  });
  const outcome = await saveWithRevision({
    tableName: 'rubbings',
    id: row.id,
    base: { ...row } as unknown as Record<string, unknown>,
    patch: { state: 'cataloged' }, // 改成相同值
    actor: '标注岗·aaaa',
    recordLabel: '第 2 版拓本',
  });
  check('两边改成相同值 → 合并且无冲突', [outcome.status, outcome.convergedFields, outcome.conflictId], [
    'merged',
    ['state'],
    null,
  ]);
  const finalRow = await db.rubbings.get(row.id);
  check('收敛时无字段并入，rev 停在前人保存值', [finalRow?.state, finalRow?.rev], ['cataloged', 2]);
}

async function scenarioOldDataUpgrade(): Promise<void> {
  await db.close();
  // 删除并以 v2 结构新建库，写入无 rev 的旧记录后再打开（触发 v2→v3 升级）
  await new Promise<void>((resolve, reject) => {
    const del = indexedDB.deleteDatabase('gbrubbing');
    del.onsuccess = () => resolve();
    del.onerror = () => reject(del.error);
  });
  const { default: Dexie } = await import('dexie');
  const oldDb = new Dexie('gbrubbing');
  oldDb.version(2).stores({
    steles: 'id, title, era, form, location, updatedAt',
    rubbings: 'id, steleId, versionNo, method, inkTone, state, updatedAt',
    losses: 'id, rubbingId, lineNo, charNo, [rubbingId+lineNo+charNo], type, severity, updatedAt',
    seals: 'id, rubbingId, sealType, position, updatedAt',
    compares: 'id, steleId, rubbingIdA, rubbingIdB, conclusion, date, updatedAt',
  });
  await oldDb.open();
  await (oldDb as unknown as { rubbings: { put: (r: unknown) => Promise<void> } }).rubbings.put({
    id: 'rub_old',
    steleId: 'stele_01',
    versionNo: 9,
    method: 'rub',
    paperType: '旧纸',
    inkTone: 'thick',
    sizeCm: '',
    collectionNo: '',
    dateGuess: '',
    state: 'toCatalog',
    createdAt: 1,
    updatedAt: 1,
  });
  await oldDb.close();

  await db.open();
  check('打开后结构版本为 v3', DB_SCHEMA_VERSION, 3);
  const old = await db.rubbings.get('rub_old');
  check('旧记录无 rev → 升级补齐为 1', old?.rev, 1);
}

async function main(): Promise<void> {
  console.log('--- 场景：三方合并 / 冲突 / 裁决 ---');
  await scenarioMerge();
  console.log('--- 场景：两边改成相同值 ---');
  await scenarioConverge();
  console.log('--- 场景：v2 旧数据升级补修订号 ---');
  await scenarioOldDataUpgrade();
  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
