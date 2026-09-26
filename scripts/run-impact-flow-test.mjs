// 可配置影响确认流端到端回归（fake-indexeddb + 真实 store）
// 覆盖：确认流配置（归一化/解析优先级/权限/history 留痕）→ 多人确认（多角色+指定成员、
// 法定人数、重复签署、签署撤回）→ 确认范围过滤 → 版本漂移检测（auto/notify/block 三策略、
// 新增引用/失效共享链接/恢复）→ 放行拦截与退回重签 → 回退后重新发起的签署恢复（autoRestore 开关）→
// 历史留痕一致（门禁时间线/版本标记/引用版本/发布指向）→ 默认行为回归（单人确认即审批）。
// 运行：npm run test:flow
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReleaseStore } from '@/stores/release'
import { useShareStore } from '@/stores/share'
import { uid, makeToken } from '@/utils/format'
import { GATE, RELEASE_STATE, IMPACT, isDocGated } from '@/utils/release'
import {
  DEFAULT_FLOW, DRIFT_POLICY, CONFIRMER, IMPACT_TYPE,
  normalizeFlowConfig, resolveFlowConfig, isFlowConfirmer,
  detectGateDrift, mergeDriftImpacts, quorumMet, addSignoff, restorableSignoffs
} from '@/utils/impactFlow'
import { docSnapshot } from '@/utils/version'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const auth = useAuthStore(pinia)
const release = useReleaseStore(pinia)
const share = useShareStore(pinia)

const owner = { id: 'u-owner', name: '文档负责人', role: 'editor', avatar: 'FZ' }
const editor = { id: 'u-editor', name: '其他编辑', role: 'editor', avatar: 'QT' }
const admin = { id: 'u-admin', name: '管理员', role: 'admin', avatar: 'GL' }
const viewer = { id: 'u-viewer', name: '只读', role: 'viewer', avatar: 'ZD' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const nowIso = () => new Date().toISOString()

await db.users.bulkAdd([owner, editor, admin, viewer].map((u) => ({ ...u, email: '', title: '' })))

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '确认流文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>旧正文 权限模型 版本发布</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: null }],
    ...extra
  }
  d.versions[0].snapshot = docSnapshot(d)
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}
const getDoc = (id) => db.docs.get(id)

async function saveVersion(docId, patch, by) {
  const d = await db.docs.get(docId)
  const now = nowIso()
  const versions = d.versions
  const next = {
    version: versions.length + 1,
    savedAt: now, savedBy: by.id, note: '编辑文档',
    snapshot: {
      title: patch.title ?? d.title,
      body: patch.body ?? d.body,
      categoryId: patch.categoryId ?? d.categoryId,
      tagIds: patch.tagIds ?? d.tagIds,
      visibility: patch.visibility ?? d.visibility
    }
  }
  await db.docs.update(docId, { ...patch, updatedAt: now, versions: [...versions, next] })
  await kb.reloadDocs()
  return next
}

async function mkCitation(docId, question, version) {
  const c = {
    id: uid('cit'), docId, question, keywords: [], snippet: '', docVersion: version,
    askedBy: viewer.id, score: 5, gateId: null, createdAt: nowIso(), ordinal: 0
  }
  await db.qaCitations.add(c)
  return c
}
async function mkShare(docId) {
  const s = {
    id: uid('share'), docId, token: makeToken(), permission: 'view',
    createdBy: owner.id, createdAt: nowIso(), expiresAt: null, revokedAt: null
  }
  await db.shares.add(s)
  return s
}

// 逐项确认全部 pending 影响
async function confirmItems(g, user) {
  for (const it of release.gateById(g.id).impacts) {
    if (it.status === IMPACT.PENDING) {
      const rr = await release.confirmImpact(g.id, it.key, user)
      if (rr.status !== 'ok') throw new Error('confirmImpact 失败: ' + rr.status)
    }
  }
}

// ---------- 0. 纯函数：配置归一化 / 解析 / 资格 / 法定人数 / 漂移检测 ----------
console.log('\n[0] 纯函数：确认流配置、资格、漂移检测')
const cfg = normalizeFlowConfig({ quorum: 0, driftPolicy: 'bad', scope: ['citation', 'bad'], memberIds: ['u1', 'u1'] })
assert(cfg.quorum === 1 && cfg.driftPolicy === DRIFT_POLICY.AUTO, '非法配置回落默认（quorum≥1、driftPolicy 合法）')
assert(cfg.scope.join() === 'citation' && cfg.memberIds.join() === 'u1', '确认范围过滤非法类型；指定成员去重')
assert(JSON.stringify(normalizeFlowConfig()) === JSON.stringify(DEFAULT_FLOW), '无输入归一化为内置默认')

const d0 = await mkDoc()
assert(resolveFlowConfig(d0, []).source === 'default', '无策略记录时解析为内置默认')
const globalPol = { id: 'p-g', scope: 'global', config: { confirmers: ['admin'], quorum: 2 } }
const docPol = { id: 'p-d', scope: 'doc:' + d0.id, config: { confirmers: ['owner', 'editor'], quorum: 3 } }
const resolvedG = resolveFlowConfig(d0, [globalPol])
assert(resolvedG.source === 'global' && resolvedG.config.quorum === 2, '仅有全局策略时继承全局')
const resolvedD = resolveFlowConfig(d0, [globalPol, docPol])
assert(resolvedD.source === 'doc' && resolvedD.config.quorum === 3, '文档级覆盖优先于全局策略')
const otherDoc = { id: 'other' }
assert(resolveFlowConfig(otherDoc, [globalPol, docPol]).source === 'global', '其他文档仍继承全局策略')

// 资格
const gMock = { ownerId: d0.id, submittedBy: editor.id }
assert(isFlowConfirmer(normalizeFlowConfig({ confirmers: ['owner'] }), gMock, d0, owner.id, 'editor') === true, '负责人选择子：owner 可确认')
assert(isFlowConfirmer(normalizeFlowConfig({ confirmers: ['owner'] }), gMock, d0, editor.id, 'editor') === false, '仅负责人选择子时，普通编辑不可确认')
assert(isFlowConfirmer(normalizeFlowConfig({ confirmers: ['editor'] }), gMock, d0, editor.id, 'editor') === true, '编辑者选择子：editor 角色可确认')
assert(isFlowConfirmer(normalizeFlowConfig({ confirmers: ['submitter'] }), gMock, d0, editor.id, 'editor') === true, '提交人选择子：提交人可确认')
assert(isFlowConfirmer(normalizeFlowConfig({ confirmers: [], memberIds: [viewer.id] }), gMock, d0, viewer.id, 'viewer') === true, '指定成员：只读成员被列入名单也可确认')
assert(isFlowConfirmer(normalizeFlowConfig({ confirmers: [] }), gMock, d0, admin.id, 'admin') === true, '管理员始终可确认（兜底）')
assert(quorumMet([{ by: 'a' }, { by: 'a' }, { by: 'b' }], normalizeFlowConfig({ quorum: 2 })) === true, '法定人数按不同人数计（同人不重复）')

// 漂移检测（纯函数）
{
  const gate = {
    version: 2, publishedVersion: 1,
    flow: normalizeFlowConfig({ scope: ['citation', 'share'] }),
    impacts: [
      { key: 'citation:c1', type: 'citation', refId: 'c1', status: 'confirmed' },
      { key: 'share:s1', type: 'share', refId: 's1', status: 'confirmed' },
      { key: 'citation:gone', type: 'citation', refId: 'gone', status: 'missing' }
    ]
  }
  const drift = detectGateDrift(gate, {
    latestVersion: 3,
    publishedVersion: 1,
    collected: [
      { key: 'citation:c1', type: 'citation', refId: 'c1' },
      { key: 'share:s1', type: 'share', refId: 's1' },
      { key: 'citation:gone', type: 'citation', refId: 'gone' }, // 失效恢复
      { key: 'citation:c2', type: 'citation', refId: 'c2' } // 新增
    ]
  })
  assert(drift.items.some((i) => i.kind === 'candidate-stale'), '漂移检测：候选版本落后（版本级）')
  assert(drift.added === 1 && drift.removed === 0 && drift.revived === 1, '漂移检测：新增 1、失效 0、恢复 1（missing 已排除）')
  // ticket 不在确认范围内 → 不产生漂移
  const driftScope = detectGateDrift(gate, { latestVersion: 2, collected: [...gate.impacts, { key: 'ticket:t1', type: 'ticket', refId: 't1' }] })
  assert(driftScope.added === 0, '确认范围外的类型漂移不计入（ticket 不在 scope）')
  const merged = mergeDriftImpacts(gate.impacts, [
    { key: 'citation:c1', type: 'citation', refId: 'c1' },
    { key: 'citation:gone', type: 'citation', refId: 'gone' },
    { key: 'citation:c2', type: 'citation', refId: 'c2' }
  ], nowIso())
  assert(merged.impacts.find((i) => i.key === 'share:s1').status === 'missing', '漂移合并：失效关联标记 missing（保留留痕）')
  assert(merged.impacts.find((i) => i.key === 'citation:c2').status === 'pending', '漂移合并：新增关联为待确认')
  assert(merged.impacts.find((i) => i.key === 'citation:gone').status === 'pending' && merged.revived === 1, '漂移合并：失效恢复项回到待确认')
}

// ---------- 1. 配置保存：权限、解析、history 留痕、清除回落 ----------
console.log('\n[1] 确认流配置保存 / 权限 / 留痕 / 清除')
let r = await release.saveFlowPolicy({ scope: 'global', config: { confirmers: ['owner'], quorum: 2 } }, editor)
assert(r.status === 'denied', '全局配置仅管理员可保存（编辑者拒绝）')
r = await release.saveFlowPolicy({ scope: 'global', config: { confirmers: [], memberIds: [] } }, admin)
assert(r.status === 'empty-confirmers', '无确认人的配置被拒绝（empty-confirmers）')
r = await release.saveFlowPolicy({ scope: 'global', config: { confirmers: ['owner'], quorum: 2 } }, admin)
assert(r.status === 'ok' && r.policy.history.length === 1, '管理员保存全局配置成功并留痕')
r = await release.saveFlowPolicy({ scope: 'global', config: { confirmers: ['owner'], quorum: 3 } }, admin)
assert(r.status === 'ok' && r.policy.history.length === 2, '全局配置再次保存追加变更历史')
const dCfg = await mkDoc()
r = await release.saveFlowPolicy({ scope: 'doc:' + dCfg.id, config: { confirmers: ['submitter'], quorum: 1, driftPolicy: DRIFT_POLICY.NOTIFY, autoRestore: false } }, editor)
assert(r.status === 'denied', '文档级配置非负责人/管理员不可保存')
r = await release.saveFlowPolicy({ scope: 'doc:' + dCfg.id, config: { confirmers: ['submitter'], quorum: 1, driftPolicy: DRIFT_POLICY.NOTIFY, autoRestore: false } }, owner)
assert(r.status === 'ok', '文档负责人可保存文档级覆盖')
assert(release.resolveFlowForDoc(dCfg.id).source === 'doc', '解析：文档级覆盖生效')
r = await release.clearFlowPolicy({ scope: 'doc:' + dCfg.id }, owner)
assert(r.status === 'ok' && release.resolveFlowForDoc(dCfg.id).source === 'global', '清除文档级覆盖后回落全局')

// ---------- 2. 多人确认：2 人法定人数（负责人 + 编辑者），签署/重复/撤回 ----------
console.log('\n[2] 多人确认：法定人数、重复签署、签署撤回')
const dMulti = await mkDoc({ editors: [owner.id, editor.id] })
await saveVersion(dMulti.id, { body: '<p>多人确认 新内容 权限模型</p>' }, owner)
await mkCitation(dMulti.id, '权限模型有哪些角色?', 1)
await release.saveFlowPolicy({
  scope: 'doc:' + dMulti.id,
  config: { confirmers: ['owner', 'editor'], quorum: 2, driftPolicy: DRIFT_POLICY.AUTO }
}, owner)
r = await release.submitGate({ docId: dMulti.id }, editor)
assert(r.status === 'ok' && r.gate.flow.quorum === 2 && r.gate.flowSource === 'doc', '门禁物化当轮确认流快照（quorum=2）')
const gMulti = r.gate
await confirmItems(gMulti, owner)
// 编辑者先签
r = await release.signoffGate(gMulti.id, '编辑者签署', editor)
assert(r.status === 'ok' && r.met === false && r.signed === 1 && r.gate.status === GATE.PENDING_CONFIRM, '第 1 名确认人签署：法定人数未达成，停留影响确认')
assert(release.pendingApprovalFor('admin').map((x) => x.id).includes(gMulti.id) === false, '未达成人数前不进入管理员待审批')
// 只读成员不可签署
r = await release.signoffGate(gMulti.id, '', viewer)
assert(r.status === 'denied', '非确认流确认人签署被拒绝')
// 编辑者重复签署：刷新但不重复计数
r = await release.signoffGate(gMulti.id, '更新意见', editor)
assert(r.status === 'ok' && r.signed === 1, '同一确认人重复签署不重复计数')
// 编辑者撤回签署
r = await release.withdrawSignoff(gMulti.id, editor)
assert(r.status === 'ok' && release.gateById(gMulti.id).signoffs.length === 0, '确认人可撤回本人签署')
r = await release.withdrawSignoff(gMulti.id, editor)
assert(r.status === 'not-signed', '未签署时撤回返回 not-signed')
// 编辑者再签 + 负责人签 → 达成
await release.signoffGate(gMulti.id, '', editor)
r = await release.signoffGate(gMulti.id, '负责人签署', owner)
assert(r.status === 'ok' && r.met === true && r.gate.status === GATE.PENDING_APPROVAL, '第 2 名确认人签署：法定人数达成，提交管理员审批')
assert(release.pendingApprovalFor('admin').some((x) => x.id === gMulti.id), '达成人数后进入管理员待审批')
assert(release.gateById(gMulti.id).timeline.some((t) => t.action === 'flow-quorum'), '法定人数达成写入门禁留痕')
r = await release.decideGate(gMulti.id, 'reject', '先驳回', admin)
assert(r.status === 'ok' && r.gate.status === GATE.REJECTED, '多人确认后管理员可驳回')

// 全局策略不影响历史门禁：历史单仍按物化快照（quorum=2）解读
const gMultiHist = release.gateById(gMulti.id)
assert(gMultiHist.flow.quorum === 2, '历史门禁保持发起时配置快照（配置后续变更不回改历史单）')

// 指定成员（只读角色）作为确认人
const dMember = await mkDoc()
await saveVersion(dMember.id, { body: '<p>指定成员确认 新内容</p>' }, owner)
await release.saveFlowPolicy({
  scope: 'doc:' + dMember.id,
  config: { confirmers: [], memberIds: [viewer.id], quorum: 1 }
}, owner)
r = await release.submitGate({ docId: dMember.id }, owner)
const gMember = r.gate
await confirmItems(gMember, viewer)
r = await release.signoffGate(gMember.id, '我确认', viewer)
assert(r.status === 'ok' && r.met === true && r.gate.status === GATE.PENDING_APPROVAL, '指定成员（只读角色）可作为确认人签署达成')
assert(release.pendingConfirmFor(viewer.id, 'viewer').length >= 0, '待我确认查询不报错')
r = await release.decideGate(gMember.id, 'reject', '', admin)
assert(r.status === 'ok', '管理员驳回成功（清理场景）')

// ---------- 3. 确认范围：仅问答引用时工单/链接不纳入确认 ----------
console.log('\n[3] 确认范围配置过滤影响项')
const dScope = await mkDoc()
await saveVersion(dScope.id, { body: '<p>范围配置 新内容</p>' }, owner)
await mkCitation(dScope.id, '范围内的问题?', 1)
await mkShare(dScope.id)
await release.saveFlowPolicy({
  scope: 'doc:' + dScope.id,
  config: { confirmers: ['owner'], quorum: 1, scope: [IMPACT_TYPE.CITATION] }
}, owner)
r = await release.submitGate({ docId: dScope.id }, owner)
assert(r.status === 'ok', '仅引用范围的门禁提交成功')
assert(r.gate.impacts.length === 1 && r.gate.impacts[0].type === 'citation', '影响项只含问答引用（共享链接不纳入确认）')
await release.withdrawGate(r.gate.id, owner)

// ---------- 4. 漂移 AUTO：确认时自动合并新增引用/失效链接 ----------
console.log('\n[4] 版本漂移 AUTO 策略：签署时自动同步')
const dAuto = await mkDoc()
await saveVersion(dAuto.id, { body: '<p>漂移自动 新内容 权限模型</p>' }, owner)
const citA = await mkCitation(dAuto.id, '老问题 权限模型?', 1)
const shareA = await mkShare(dAuto.id)
await release.saveFlowPolicy({
  scope: 'doc:' + dAuto.id,
  config: { confirmers: ['owner'], quorum: 1, driftPolicy: DRIFT_POLICY.AUTO }
}, owner)
r = await release.submitGate({ docId: dAuto.id }, owner)
const gAuto = r.gate
// 门禁期间：新增一条引用；撤销共享链接（失效）
await mkCitation(dAuto.id, '门禁期间新提出的问题?', 1)
await share.revokeShare(shareA.id, owner)
await confirmItems(gAuto, owner) // 只确认了原有 pending
// 第一次签署：自动同步漂移 → 新引用为待确认，返回 unconfirmed
r = await release.signoffGate(gAuto.id, '', owner)
assert(r.status === 'unconfirmed', 'AUTO：自动同步后新增引用待确认，首次签署返回 unconfirmed')
const gAutoAfterSync = release.gateById(gAuto.id)
assert(gAutoAfterSync.impacts.find((it) => it.refId === shareA.id)?.status === 'missing', 'AUTO：失效共享链接标记 missing')
assert(gAutoAfterSync.impacts.some((it) => it.driftAddedAt && it.type === 'citation'), 'AUTO：新增引用带漂移新增标记')
assert(gAutoAfterSync.timeline.some((t) => t.action === 'drift-detected') && gAutoAfterSync.timeline.some((t) => t.action === 'drift-sync'), 'AUTO：漂移检测与自动同步写入留痕')
// 确认新增项后再次签署 → 达成（missing 不阻塞）
await confirmItems({ id: gAuto.id }, owner)
r = await release.signoffGate(gAuto.id, '', owner)
assert(r.status === 'ok' && r.met === true, 'AUTO：新项确认后签署达成（失效项不阻塞）')
r = await release.decideGate(gAuto.id, 'approve', '', admin)
assert(r.status === 'ok' && r.gate.status === GATE.RELEASED, 'AUTO：同步后正常放行')
const docAutoRel = await getDoc(dAuto.id)
assert(docAutoRel.release.publishedVersion === 2, 'AUTO：发布指向 v2')
// 发布后撤销的链接本就失效；门禁期间新增的引用也随发布切到 v2
const lateCit = await db.qaCitations.where('docId').equals(dAuto.id).filter((c) => c.question === '门禁期间新提出的问题?').first()
assert(lateCit.docVersion === 2 && lateCit.gateId === gAuto.id, 'AUTO：门禁期间新增引用随发布联动切换 v2')

// ---------- 5. 漂移 NOTIFY：未同步不能签署，手动同步后继续 ----------
console.log('\n[5] 版本漂移 NOTIFY 策略：提示待同步')
const dNotify = await mkDoc()
await saveVersion(dNotify.id, { body: '<p>漂移提示 新内容 权限模型</p>' }, owner)
await mkCitation(dNotify.id, '通知策略老问题 权限模型?', 1)
await release.saveFlowPolicy({
  scope: 'doc:' + dNotify.id,
  config: { confirmers: ['owner'], quorum: 1, driftPolicy: DRIFT_POLICY.NOTIFY }
}, owner)
r = await release.submitGate({ docId: dNotify.id }, owner)
const gN = r.gate
await confirmItems(gN, owner)
await mkCitation(dNotify.id, '通知策略新问题?', 1)
r = await release.signoffGate(gN.id, '', owner)
assert(r.status === 'drift' && r.gate.drift?.hasDrift && r.gate.status === GATE.PENDING_CONFIRM, 'NOTIFY：检测到漂移返回 drift，门禁停留影响确认')
assert(release.gateById(gN.id).timeline.some((t) => t.action === 'drift-detected'), 'NOTIFY：漂移写入留痕')
// 提交人（非确认人角色时）不可同步？提交人就是 owner。改用 viewer 验证权限：
r = await release.syncGateDrift(gN.id, viewer)
assert(r.status === 'denied', 'NOTIFY：非确认人/非提交人不可手动同步')
r = await release.syncGateDrift(gN.id, owner)
assert(r.status === 'ok' && r.added === 1 && release.gateById(gN.id).drift === null, 'NOTIFY：确认人手动同步成功并清除漂移快照')
// 同步后新增项待确认
await confirmItems({ id: gN.id }, owner)
r = await release.signoffGate(gN.id, '', owner)
assert(r.status === 'ok' && r.met === true, 'NOTIFY：同步并确认后签署达成')
r = await release.decideGate(gN.id, 'reject', '', admin)
assert(r.status === 'ok', '驳回清理 NOTIFY 门禁')

// ---------- 6. 漂移 BLOCK：放行前退回影响确认，同步重签后放行 ----------
console.log('\n[6] 版本漂移 BLOCK 策略：放行前退回影响确认')
const dBlock = await mkDoc()
await saveVersion(dBlock.id, { body: '<p>漂移阻断 新内容 权限模型</p>' }, owner)
await mkCitation(dBlock.id, '阻断策略老问题 权限模型?', 1)
await release.saveFlowPolicy({
  scope: 'doc:' + dBlock.id,
  config: { confirmers: ['owner'], quorum: 1, driftPolicy: DRIFT_POLICY.BLOCK }
}, owner)
r = await release.submitGate({ docId: dBlock.id }, owner)
const gB = r.gate
await confirmItems(gB, owner)
// 待审批前无漂移（确认环节 BLOCK 与 NOTIFY 一致：先提示同步；这里不制造漂移，直接签署达成）
r = await release.signoffGate(gB.id, '', owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_APPROVAL, 'BLOCK：无漂移时签署直接达成')
// 待审批期间新增引用 → 放行被退回
await mkCitation(dBlock.id, '审批期间才提出的问题 权限模型?', 1)
r = await release.decideGate(gB.id, 'approve', '', admin)
assert(r.status === 'drift' && r.gate.status === GATE.PENDING_CONFIRM && r.gate.drift?.hasDrift, 'BLOCK：放行前检测到漂移，退回影响确认')
assert(release.gateById(gB.id).timeline.some((t) => t.action === 'drift-bounce'), 'BLOCK：退回原因写入留痕')
// 签署保留：同步后重新签署即可（quorum=1）
r = await release.syncGateDrift(gB.id, owner)
assert(r.status === 'ok' && r.added === 1, 'BLOCK：同步漂移影响项')
await confirmItems({ id: gB.id }, owner)
r = await release.signoffGate(gB.id, '同步后重签', owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_APPROVAL, 'BLOCK：同步后重新签署再次送审')
r = await release.decideGate(gB.id, 'approve', '', admin)
assert(r.status === 'ok' && r.gate.status === GATE.RELEASED, 'BLOCK：漂移消除后审批放行成功')
const newCit = await db.qaCitations.where('docId').equals(dBlock.id).filter((c) => c.question === '审批期间才提出的问题 权限模型?').first()
assert(newCit.docVersion === 2, 'BLOCK：审批期间新增引用随发布联动到 v2')

// ---------- 7. 回退恢复：autoRestore 开关（影响结论 + 多人签署恢复）----------
console.log('\n[7] 回退/驳回后重新发起：签署与确认结论恢复（autoRestore）')
// quorum=2 的文档：放行 → 回退 → 重新发起，两名确认人签署应恢复
const dRes = await mkDoc({ editors: [owner.id, editor.id] })
await saveVersion(dRes.id, { body: '<p>恢复场景 新内容 权限模型</p>' }, owner)
await mkCitation(dRes.id, '恢复场景问题 权限模型?', 1)
await release.saveFlowPolicy({
  scope: 'doc:' + dRes.id,
  config: { confirmers: ['owner', 'editor'], quorum: 2, driftPolicy: DRIFT_POLICY.AUTO, autoRestore: true }
}, owner)
r = await release.submitGate({ docId: dRes.id }, owner)
const gRes = r.gate
await confirmItems(gRes, owner)
await release.signoffGate(gRes.id, '', editor)
await release.signoffGate(gRes.id, '', owner)
await release.decideGate(gRes.id, 'approve', '', admin)
assert(release.gateById(gRes.id).status === GATE.RELEASED, '恢复场景：v2 放行')
r = await release.rollbackGate(gRes.id, '回退验证', admin)
assert(r.status === 'ok' && r.gate.status === GATE.ROLLED_BACK, '管理员回退 v2')
await saveVersion(dRes.id, { body: '<p>恢复场景 二次发布 权限模型</p>' }, owner)
r = await release.submitGate({ docId: dRes.id }, owner)
const gRes2 = r.gate
assert(r.gate.impacts.some((it) => it.restoredFromGateId === gRes.id), '回退后重发：影响确认结论自动恢复')
assert(gRes2.signoffs.length === 2 && gRes2.signoffs.every((s) => s.restoredFromGateId === gRes.id), '回退后重发：恢复 2 名确认人的上轮签署')
assert(gRes2.status === GATE.PENDING_CONFIRM, '恢复签署不自动提交审批（仍停留在影响确认，可直接重签达成）')
// 已有签署的确认人重签后立即达成（逐项影响已恢复为 confirmed）
r = await release.signoffGate(gRes2.id, '', editor)
assert(r.status === 'ok' && r.signed === 2 && r.met === true, '任一确认人重签即重新达成法定人数')
assert(release.gateById(gRes2.id).timeline.some((t) => t.action === 'impact-restore'), '状态恢复写入门禁留痕')
r = await release.decideGate(gRes2.id, 'reject', '', admin)
assert(r.status === 'ok', '驳回清理')

// autoRestore=false：不恢复影响与签署
await saveVersion(dRes.id, { body: '<p>恢复场景 三次发布 权限模型</p>' }, owner)
await release.saveFlowPolicy({
  scope: 'doc:' + dRes.id,
  config: { confirmers: ['owner', 'editor'], quorum: 2, driftPolicy: DRIFT_POLICY.AUTO, autoRestore: false }
}, owner)
r = await release.submitGate({ docId: dRes.id }, owner)
assert(r.gate.impacts.every((it) => it.status === IMPACT.PENDING), 'autoRestore 关闭：影响项不恢复（全部待确认）')
assert(r.gate.signoffs.length === 0, 'autoRestore 关闭：上轮签署不恢复')
await release.withdrawGate(r.gate.id, owner)

// 纯函数：上轮无签署旧门禁（confirmedBy 兼容）
const restored = restorableSignoffs({ confirmedBy: owner.id, confirmedAt: nowIso() }, normalizeFlowConfig({ autoRestore: true }))
assert(restored.length === 1 && restored[0].by === owner.id, '旧门禁（confirmedBy）签署兼容恢复')

// ---------- 8. 历史留痕一致：门禁时间线 / 版本标记 / 引用版本 / 发布指向 ----------
console.log('\n[8] 历史留痕一致性')
const dHis = await mkDoc()
await saveVersion(dHis.id, { body: '<p>留痕一致 新内容 权限模型</p>' }, owner)
const citHis = await mkCitation(dHis.id, '留痕一致问题 权限模型?', 1)
await release.saveFlowPolicy({
  scope: 'doc:' + dHis.id,
  config: { confirmers: ['owner'], quorum: 1, driftPolicy: DRIFT_POLICY.AUTO, autoRestore: true }
}, owner)
r = await release.submitGate({ docId: dHis.id }, owner)
const gHis = r.gate
await confirmItems(gHis, owner)
await release.signoffGate(gHis.id, '签署留痕', owner)
await release.decideGate(gHis.id, 'approve', '同意', admin)
const gHisRel = release.gateById(gHis.id)
const actions = gHisRel.timeline.map((t) => t.action)
assert(actions.includes('submit') && actions.includes('flow-signoff') && actions.includes('flow-quorum') && actions.includes('approve') && actions.includes('version-publish'), '已放行门禁时间线完整（提交→签署→人数达成→审批→发布）')
const docHis = await getDoc(dHis.id)
const vHis = docHis.versions.find((v) => v.version === 2)
assert(vHis.gate?.status === GATE.RELEASED && vHis.gate.gateId === gHis.id, '版本记录门禁标记与门禁状态一致（released）')
assert(docHis.release.publishedVersion === gHisRel.version && !isDocGated(docHis), '文档发布指向与门禁一致（v2、非门禁态）')
const citHisAfter = await db.qaCitations.get(citHis.id)
assert(citHisAfter.docVersion === docHis.release.publishedVersion, '问答引用版本与发布指向一致（v2）')
// 回退后各侧再次一致
await release.rollbackGate(gHis.id, '', admin)
const docHisRb = await getDoc(dHis.id)
const citHisRb = await db.qaCitations.get(citHis.id)
assert(docHisRb.release.publishedVersion === gHisRel.publishedVersion && citHisRb.docVersion === 1, '回退后文档发布指向与引用版本一致（v1）')
const vHisRb = docHisRb.versions.find((v) => v.version === 2)
assert(vHisRb.gate?.status === GATE.ROLLED_BACK, '回退后版本标记与门禁状态一致（rolled_back）')
assert(release.gateById(gHis.id).impacts.every((it) => it.status === 'reverted'), '回退后影响项全部标记已还原')
assert(release.gateById(gHis.id).timeline.some((t) => t.action === 'rollback') && release.gateById(gHis.id).timeline.some((t) => t.action === 'version-revert'), '回退动作与联动结果均留痕')

// ---------- 9. 默认行为回归：单人确认即审批 / 待办角标 / 文档删除清理配置 ----------
console.log('\n[9] 默认行为回归（无文档覆盖时沿用全局 quorum=2？先清全局再验单人默认）')
await release.clearFlowPolicy({ scope: 'global' }, admin)
assert(release.resolveFlowForDoc('nonexistent').source === 'default', '清除全局后回落内置默认')
const dDef = await mkDoc({ editors: [owner.id, editor.id] })
await saveVersion(dDef.id, { body: '<p>默认回归 新内容</p>' }, editor)
r = await release.submitGate({ docId: dDef.id }, editor)
assert(r.status === 'ok' && r.gate.flowSource === 'default' && r.gate.flow.quorum === 1, '无配置时门禁使用内置默认（单人确认）')
const gDef = r.gate
await confirmItems(gDef, owner)
assert(release.pendingConfirmFor(owner.id, 'editor').map((g) => g.id).includes(gDef.id), '默认流：负责人有待确认门禁')
assert(release.pendingConfirmFor(editor.id, 'editor').map((g) => g.id).includes(gDef.id) === false, '非确认人的编辑者看不到待确认（默认仅负责人）')
r = await release.confirmGate(gDef.id, '兼容入口', owner)
assert(r.status === 'ok' && r.met === true && r.gate.status === GATE.PENDING_APPROVAL, 'confirmGate 兼容入口等价签署，单人即提交审批')
await release.decideGate(gDef.id, 'reject', '', admin)

// 文档级配置随文档删除清理
const dDel = await mkDoc()
await saveVersion(dDel.id, { body: '<p>删除清理配置 新内容</p>' }, owner)
await release.saveFlowPolicy({ scope: 'doc:' + dDel.id, config: { confirmers: ['owner'], quorum: 1 } }, owner)
assert(release.flowPolicyOf('doc:' + dDel.id) !== null, '删除前存在文档级配置')
const delRes = await kb.deleteDoc(dDel.id, admin)
assert(delRes.status === 'ok', '管理员删除文档成功')
assert(release.flowPolicyOf('doc:' + dDel.id) === null, '文档级确认流配置随文档删除清理（全局配置不受影响）')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
