// 可配置影响确认流：发布门禁与评审、缺口、退役、问答引用联动的配置化扩展（均为纯函数，供
// release store 事务内调用与回归测试）。
//
// 在既有门禁「准入四维度（评审/保鲜/缺口/退役）→ 负责人逐项确认影响 → 管理员审批放行/回退」之上：
// 1) 确认流可配置（FlowConfig）：
//    - scope       纳入确认的影响类型（问答引用 / 缺口工单 / 共享链接）；不在范围内的关联仍随发布联动，
//                   只是不要求逐项确认；
//    - confirmers  整体确认（签署）的资格集合：文档负责人 / 管理员 / 编辑者 / 提交人 / 指定成员，
//                   管理员始终可签署（平台兜底角色）；
//    - memberIds   指定成员名单（与 confirmers 取并集）；
//    - quorum      法定人数：达成 K 名不同确认人签署后才提交管理员审批（多人确认），默认 1（原行为）；
//    - driftPolicy 门禁流转期间检测到版本漂移时的处理策略（自动同步 / 提示待同步 / 阻断放行）；
//    - autoRestore 驳回/撤回/回退后重新发起时，是否自动恢复上轮影响确认结论与签署。
// 2) 配置按「文档级覆盖 > 全局配置 > 内置默认」解析，并在门禁提交时物化快照（gate.flow）：
//    历史门禁始终按发起当时的配置解读，配置后续变更不回改历史单（历史留痕一致）。
// 3) 版本漂移检测（detectGateDrift）：
//    - 版本级漂移：候选版本已落后于文档最新版本（candidate-stale）/ 发布基线被并发改动（baseline-moved）；
//    - 影响级漂移：门禁期间新增的问答引用/已解决工单/生效共享链接（impacts-added），
//      或发起时纳入的实体已失效（引用删除、链接撤销/过期、工单退回未解决：impacts-removed），
//      以及失效实体重新恢复（impacts-revived）。
//    版本级漂移一律在放行前拦截（沿用 stale 判定）；影响级漂移按 driftPolicy 处理。
import { ROLE, isGuestUser } from './permission'

// 影响项类型（由 utils/release 再导出，避免调用方依赖本模块）
export const IMPACT_TYPE = {
  CITATION: 'citation', // 问答引用
  TICKET: 'ticket', // 缺口工单
  SHARE: 'share' // 共享链接
}

// 影响项状态：pending 待确认 / confirmed 已确认 / released 已随发布生效 /
// reverted 已随回退还原 / missing 实体已失效（漂移移除，保留留痕，不阻塞确认）
export const IMPACT = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  RELEASED: 'released',
  REVERTED: 'reverted',
  MISSING: 'missing'
}

// 版本漂移处理策略
export const DRIFT_POLICY = {
  AUTO: 'auto', // 自动同步：确认/同步时检测到影响级漂移即自动合并新增/失效影响项并留痕，确认进度按保留项继续
  NOTIFY: 'notify', // 提示待同步：漂移记录到门禁单，须确认人手动「同步影响项」后才可提交审批
  BLOCK: 'block' // 阻断放行：放行前再次检测，未同步的漂移把门禁退回影响确认，同步并重签后方可放行
}

// 确认人选择子（memberIds 指定名单在配置上独立维护）
export const CONFIRMER = {
  OWNER: 'owner', // 文档负责人（gate.ownerId / doc.ownerId）
  ADMIN: 'admin', // 管理员
  EDITOR: 'editor', // 编辑角色成员（团队级）
  SUBMITTER: 'submitter' // 本门禁提交人
}

// 内置默认确认流：三类影响均确认；文档负责人单人签署即提交审批；漂移自动同步；上轮结论自动恢复
export const DEFAULT_FLOW = Object.freeze({
  scope: [IMPACT_TYPE.CITATION, IMPACT_TYPE.TICKET, IMPACT_TYPE.SHARE],
  confirmers: [CONFIRMER.OWNER],
  memberIds: [],
  quorum: 1,
  driftPolicy: DRIFT_POLICY.AUTO,
  autoRestore: true
})

export const FLOW_SCOPE_KIND = { GLOBAL: 'global', DOC_PREFIX: 'doc:' }
export const globalFlowScope = () => FLOW_SCOPE_KIND.GLOBAL
export const docFlowScope = (docId) => FLOW_SCOPE_KIND.DOC_PREFIX + docId

// 配置摘要文案（写入配置 history 与留痕）
export function flowConfigSummary(f) {
  const scopeLabel = { citation: '问答引用', ticket: '缺口工单', share: '共享链接' }
  const confLabel = { owner: '负责人', admin: '管理员', editor: '编辑者', submitter: '提交人' }
  const confs = (f.confirmers || []).map((c) => confLabel[c] || c)
  if ((f.memberIds || []).length) confs.push('指定成员 ' + f.memberIds.length + ' 人')
  const driftLabel = { auto: '漂移自动同步', notify: '漂移提示待同步', block: '漂移阻断放行' }
  return '确认范围[' + f.scope.map((t) => scopeLabel[t] || t).join('/') + '] · '
    + '确认人[' + confs.join('/') + '] · 法定人数 ' + f.quorum + ' · '
    + driftLabel[f.driftPolicy] + ' · 上轮结论' + (f.autoRestore ? '自动恢复' : '不恢复')
}

// 归一化配置（容错：非法/缺失字段回落默认；调用方保存前再校验确认人非空）
export function normalizeFlowConfig(input = {}) {
  const validTypes = Object.values(IMPACT_TYPE)
  const validConfirmers = Object.values(CONFIRMER)
  const scope = (Array.isArray(input.scope) ? input.scope : DEFAULT_FLOW.scope)
    .filter((t) => validTypes.includes(t))
  const confirmers = (Array.isArray(input.confirmers) ? input.confirmers : DEFAULT_FLOW.confirmers)
    .filter((c) => validConfirmers.includes(c))
  const memberIds = Array.isArray(input.memberIds)
    ? [...new Set(input.memberIds.map((x) => String(x || '')).filter(Boolean))]
    : []
  let quorum = Number(input.quorum)
  if (!Number.isFinite(quorum)) quorum = DEFAULT_FLOW.quorum
  quorum = Math.max(1, Math.min(20, Math.floor(quorum)))
  const driftPolicy = Object.values(DRIFT_POLICY).includes(input.driftPolicy)
    ? input.driftPolicy
    : DEFAULT_FLOW.driftPolicy
  const autoRestore = input.autoRestore === undefined ? true : !!input.autoRestore
  return {
    scope: scope.length ? [...new Set(scope)] : [...DEFAULT_FLOW.scope],
    confirmers: [...new Set(confirmers)],
    memberIds,
    quorum,
    driftPolicy,
    autoRestore
  }
}

// 配置是否具备至少一类确认人（confirmers 选择子或指定成员名单）
export function hasFlowConfirmer(flow) {
  const f = flow || DEFAULT_FLOW
  return (f.confirmers || []).length > 0 || (f.memberIds || []).length > 0
}

// 作用域解析：文档级覆盖 > 全局配置 > 内置默认。
// policies: gateFlowPolicies 记录数组（{ scope, config, updatedAt, updatedBy }）。
// 返回 { config（已归一化）, source: 'default'|'global'|'doc', policyId }
export function resolveFlowConfig(doc, policies = []) {
  const list = policies || []
  const docScope = doc ? docFlowScope(doc.id) : null
  const docPolicy = docScope ? list.find((p) => p.scope === docScope) : null
  if (docPolicy) {
    return { config: normalizeFlowConfig(docPolicy.config), source: 'doc', policyId: docPolicy.id }
  }
  const globalPolicy = list.find((p) => p.scope === FLOW_SCOPE_KIND.GLOBAL)
  if (globalPolicy) {
    return { config: normalizeFlowConfig(globalPolicy.config), source: 'global', policyId: globalPolicy.id }
  }
  return { config: { ...DEFAULT_FLOW }, source: 'default', policyId: null }
}

// 历史门禁的配置快照（旧门禁无 flow → 按内置默认解读，保持升级前行为）
export function gateFlow(gate) {
  return normalizeFlowConfig(gate?.flow || {})
}

// ---- 确认资格与多人签署 ----

// 当前用户是否为本门禁的合格确认人；管理员始终可确认（平台兜底）。
// doc 可空（列表视角），此时负责人按 gate.ownerId 判定。
export function isFlowConfirmer(flow, gate, doc, userId, role) {
  if (!userId || isGuestUser(userId)) return false
  if (role === ROLE.ADMIN) return true
  const f = flow || gateFlow(gate)
  const ownerId = doc?.ownerId ?? gate?.ownerId
  for (const c of f.confirmers || []) {
    if (c === CONFIRMER.OWNER && ownerId === userId) return true
    if (c === CONFIRMER.ADMIN && role === ROLE.ADMIN) return true
    if (c === CONFIRMER.EDITOR && role === ROLE.EDITOR) return true
    if (c === CONFIRMER.SUBMITTER && gate?.submittedBy === userId) return true
  }
  if ((f.memberIds || []).includes(userId)) return true
  return false
}

export function flowQuorum(flow) {
  const f = flow || DEFAULT_FLOW
  const q = Number(f.quorum)
  return Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1
}

// 去重后的签署列表（同人只计最新一次；旧门禁无 signoffs 时以 confirmedBy 兼容展示）
export function gateSignoffs(gate) {
  const raw = Array.isArray(gate?.signoffs) && gate.signoffs.length
    ? gate.signoffs
    : (gate?.confirmedBy ? [{ by: gate.confirmedBy, at: gate.confirmedAt || gate?.confirmedAt, note: '' }] : [])
  const map = new Map()
  for (const s of raw) {
    if (s?.by) map.set(s.by, s)
  }
  return [...map.values()]
}

// 签署进度：{ signoffs, signed, required, met }
export function signoffProgress(gate, flow) {
  const f = flow || gateFlow(gate)
  const signoffs = gateSignoffs(gate)
  const required = flowQuorum(f)
  return { signoffs, signed: signoffs.length, required, met: signoffs.length >= required }
}

// 直接对签署数组判定法定人数（store 提交签署后使用）
export function quorumMet(signoffs, flow) {
  const f = flow || DEFAULT_FLOW
  const uniq = new Set((signoffs || []).map((s) => s?.by).filter(Boolean))
  return uniq.size >= flowQuorum(f)
}

// 追加签署：同一用户重复签署时刷新其签署时间/意见（不重复计数；漂移退回后可凭重签重新达成法定人数）
export function addSignoff(signoffs, entry) {
  const list = (signoffs || []).filter((s) => s.by !== entry.by)
  return [...list, entry]
}

export function removeSignoff(signoffs, userId) {
  return (signoffs || []).filter((s) => s.by !== userId)
}

// ---- 版本漂移检测 ----

export function driftKindLabel(kind) {
  return {
    'candidate-stale': '候选版本已落后于最新版本',
    'baseline-moved': '发布基线已被并发改动',
    'impacts-added': '门禁期间新增受影响关联',
    'impacts-removed': '纳入确认的关联已失效',
    'impacts-revived': '已失效关联重新恢复'
  }[kind] || kind
}

// 影响项键（与 release.impactKey 同构，本模块独立实现避免循环依赖）
function impactKeyOf(type, refId) {
  return type + ':' + refId
}

// 漂移检测（纯函数）。live:
// { latestVersion（文档当前版本总数）, publishedVersion（文档当前发布指向）,
//   collected（实时收集并按 flow.scope 过滤后的影响项数组，结构同 normalizeImpacts 产物） }
// 返回 { hasDrift, hasImpactDrift, items, added, removed, revived }
export function detectGateDrift(gate, live = {}) {
  const items = []
  if (!gate) return { hasDrift: false, hasImpactDrift: false, items: [], added: 0, removed: 0, revived: 0 }
  // ① 版本级漂移
  if (Number.isFinite(live.latestVersion) && live.latestVersion > gate.version) {
    items.push({ kind: 'candidate-stale', candidateVersion: gate.version, latestVersion: live.latestVersion })
  }
  if (live.publishedVersion != null && gate.publishedVersion != null
    && live.publishedVersion !== gate.publishedVersion) {
    items.push({ kind: 'baseline-moved', gatePublishedVersion: gate.publishedVersion, publishedVersion: live.publishedVersion })
  }
  // ② 影响级漂移（仅统计确认范围内的类型）
  const flow = gateFlow(gate)
  const collected = (live.collected || []).filter((it) => flow.scope.includes(it.type))
  const allItems = gate.impacts || []
  const allKeys = new Set(allItems.map((it) => it.key || impactKeyOf(it.type, it.refId)))
  const collectedKeys = new Set(collected.map((it) => it.key || impactKeyOf(it.type, it.refId)))
  // 新增：实时集合中存在、但门禁从未纳入的键（含失效项的键不算新增——它们归入 revived）
  const added = collected.filter((it) => !allKeys.has(it.key || impactKeyOf(it.type, it.refId)))
  // 失效：发起时纳入（pending/confirmed）、实时集合中已不存在
  const removed = allItems.filter((it) =>
    (it.status === IMPACT.PENDING || it.status === IMPACT.CONFIRMED)
    && !collectedKeys.has(it.key || impactKeyOf(it.type, it.refId)))
  // 恢复：曾标记失效、实时集合中重新出现
  const revived = allItems.filter((it) =>
    it.status === IMPACT.MISSING && collectedKeys.has(it.key || impactKeyOf(it.type, it.refId)))
  if (added.length) {
    items.push({ kind: 'impacts-added', count: added.length, refs: added.map((it) => it.key) })
  }
  if (removed.length) {
    items.push({ kind: 'impacts-removed', count: removed.length, refs: removed.map((it) => it.key) })
  }
  if (revived.length) {
    items.push({ kind: 'impacts-revived', count: revived.length, refs: revived.map((it) => it.key) })
  }
  return {
    hasDrift: items.length > 0,
    hasImpactDrift: added.length > 0 || removed.length > 0 || revived.length > 0,
    items,
    added: added.length,
    removed: removed.length,
    revived: revived.length
  }
}

// 漂移同步：把实时影响项合并进门禁影响清单（纯函数，不修改入参）。
// - 新增关联：追加为待确认（driftAddedAt）；
// - 失效关联：pending/confirmed → missing（保留确认人/时间留痕），不阻塞整体确认；
// - 失效后恢复：missing → pending（需重新确认）。
// 返回 { impacts, added, removed, revived }
export function mergeDriftImpacts(impacts, collected, now) {
  const list = impacts || []
  const collectedKeys = new Set((collected || []).map((it) => it.key || impactKeyOf(it.type, it.refId)))
  let removed = 0
  let revived = 0
  const next = list.map((it) => {
    const key = it.key || impactKeyOf(it.type, it.refId)
    const alive = collectedKeys.has(key)
    if (it.status === IMPACT.MISSING) {
      if (alive) { revived++; return { ...it, status: IMPACT.PENDING, missingAt: null, revivedAt: now } }
      return it
    }
    if (!alive && (it.status === IMPACT.PENDING || it.status === IMPACT.CONFIRMED)) {
      removed++
      return { ...it, status: IMPACT.MISSING, missingAt: now }
    }
    return it
  })
  const existKeys = new Set(list.map((it) => it.key || impactKeyOf(it.type, it.refId)))
  let added = 0
  for (const c of collected || []) {
    const key = c.key || impactKeyOf(c.type, c.refId)
    if (existKeys.has(key)) continue
    next.push({ ...c, status: IMPACT.PENDING, driftAddedAt: now })
    added++
  }
  return { impacts: next, added, removed, revived }
}

// 全部影响项是否已确认（无影响项视为就绪；missing 失效项不阻塞——实体已不在联动范围）
export function allFlowImpactsConfirmed(impacts) {
  return (impacts || []).every((it) =>
    it.status === IMPACT.CONFIRMED || it.status === IMPACT.RELEASED || it.status === IMPACT.MISSING)
}

// 影响项计数（含失效）
export function flowImpactCounts(impacts) {
  const c = { total: (impacts || []).length, citation: 0, ticket: 0, share: 0, confirmed: 0, missing: 0 }
  for (const it of impacts || []) {
    if (it.type === IMPACT_TYPE.CITATION) c.citation++
    if (it.type === IMPACT_TYPE.TICKET) c.ticket++
    if (it.type === IMPACT_TYPE.SHARE) c.share++
    if (it.status === IMPACT.CONFIRMED || it.status === IMPACT.RELEASED) c.confirmed++
    if (it.status === IMPACT.MISSING) c.missing++
  }
  return c
}

// ---- 重新发起门禁时的确认状态恢复 ----

// 上轮门禁中可恢复的整体签署（含旧门禁 confirmedBy 兼容）：
// 仅在 flow.autoRestore 开启时返回；每条标注 restoredFromGateId，签署人是否仍具备资格
// 由 UI/调用方按需判断（恢复只影响签署进度展示，法定人数仍以当轮配置为准）。
export function restorableSignoffs(prevGate, flow) {
  const f = flow || DEFAULT_FLOW
  if (!f.autoRestore || !prevGate) return []
  const list = gateSignoffs(prevGate)
  return list.map((s) => ({
    by: s.by,
    at: s.at,
    note: s.note || '',
    role: s.role || null,
    restoredFromGateId: prevGate.id,
    restoredAt: null
  }))
}
