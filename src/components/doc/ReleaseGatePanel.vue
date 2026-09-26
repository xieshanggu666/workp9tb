<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReleaseStore } from '@/stores/release'
import { formatFull, formatDate } from '@/utils/format'
import {
  GATE, gateStatusLabel, gateStatusCls, gateTimelineLabel,
  impactTypeLabel, impactStatusLabel, IMPACT,
  CHECK_SEVERITY, canSignOffCheck, canRecheckGate, allChecksCleared
} from '@/utils/release'
import {
  DRIFT_POLICY, gateFlow, isFlowConfirmer, signoffProgress, driftKindLabel, docFlowScope
} from '@/utils/impactFlow'
import { diffVersionFields, fieldLabels } from '@/utils/version'
import FlowConfigEditor from './FlowConfigEditor.vue'

const props = defineProps({ doc: { type: Object, required: true } })

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const releaseStore = useReleaseStore()

const showForm = ref(false)
const showFlowEditor = ref(false)
const note = ref('')
const busy = ref(false)
const confirmNote = ref('')
const decideNote = ref('')
const rollbackNote = ref('')
const waiverNote = ref({})
const rechecking = ref(false)

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

// 本文档门禁单（在途优先置顶，其余按时间倒序）
const records = computed(() => releaseStore.gatesOfDoc(props.doc.id))
const openGate = computed(() => releaseStore.openGateOfDoc(props.doc.id))
const lastGate = computed(() => records.value[0] || null)

// 在途门禁的影响确认流配置（历史单按物化快照解读）
const flow = computed(() => (openGate.value ? gateFlow(openGate.value) : gateFlow({})))
const progress = computed(() => (openGate.value ? signoffProgress(openGate.value, flow.value) : null))
const flowResolved = computed(() => releaseStore.resolveFlowForDoc(props.doc.id))
const canEditFlow = computed(() =>
  !!auth.user && (auth.user.role === 'admin' || props.doc.ownerId === auth.user.id))

// 候选版本相对已发布版的字段差异
const gateChangedFields = computed(() => {
  const g = openGate.value || lastGate.value
  if (!g?.candidateSnapshot || !g.publishedSnapshot) return []
  return diffVersionFields(g.publishedSnapshot, g.candidateSnapshot)
})

// 发起门禁：编辑者/管理员，文档不在门禁中，且存在新于发布版的版本
const canSubmit = computed(() => {
  if (!auth.user) return false
  if (openGate.value) return false
  if (auth.user.role !== 'admin' && auth.user.role !== 'editor') return false
  if (props.doc.ownerId !== auth.user.id && !(props.doc.editors || []).includes(auth.user.id) && auth.user.role !== 'admin') return false
  const versions = props.doc.versions || []
  return versions.length > 1
})

// 当前用户是否为在途门禁的合格确认人（按 flow 配置；管理员兜底）
const isFlowEligible = computed(() => {
  if (!auth.user || !openGate.value) return false
  return isFlowConfirmer(flow.value, openGate.value, props.doc, auth.user.id, auth.user.role)
})
const isAdmin = computed(() => auth.user?.role === 'admin')
const hasSigned = computed(() =>
  !!openGate.value && (openGate.value.signoffs || []).some((s) => s.by === auth.user?.id))

function roleCtx() {
  return { userId: auth.user?.id, role: auth.user?.role, isOwner: props.doc.ownerId === auth.user?.id }
}
function canWaiver(check) {
  return !!auth.user && canSignOffCheck(check, roleCtx())
}
function canRecheck(g) {
  return !!auth.user && canRecheckGate(g, roleCtx())
}

// 漂移：门禁单上的待同步漂移快照（notify/block 策略）
const pendingDrift = computed(() => openGate.value?.drift || null)
const driftPolicyLabel = computed(() =>
  ({ auto: '自动同步', notify: '提示待同步', block: '阻断放行' }[flow.value.driftPolicy]))

async function submit() {
  if (busy.value) return
  busy.value = true
  try {
    const res = await releaseStore.submitGate({ docId: props.doc.id, note: note.value.trim() }, auth.user)
    if (res.status === 'ok' || res.status === 'blocked') {
      showForm.value = false
      note.value = ''
      if (res.status === 'blocked') {
        alert('门禁已建立，但准入检查存在阻断维度，请在下方按责任角色处置后重新评估或豁免。')
      }
    } else if (res.status === 'guest') {
      alert('请先登录后再提交发布门禁。')
    } else if (res.status === 'denied') {
      alert('你没有该文档的发布门禁提交权限：仅拥有者、协作成员或管理员可提交。')
    } else if (res.status === 'duplicate') {
      alert('该文档已有流转中的发布门禁，请先完成或撤回。')
    } else if (res.status === 'in-handover') {
      alert('文档正在责任交接中，请先完成或取消交接后再提交发布门禁。')
    } else if (res.status === 'in-review') {
      alert('文档正在评审中，请待评审完结后再提交发布门禁；门禁流转中新发起的评审会在放行前复检拦截。')
    } else if (res.status === 'no-change') {
      alert('当前版本与已发布版本内容一致，无需提交门禁；请先编辑保存新版本。')
    } else {
      alert('提交失败，请稍后重试。')
    }
  } finally {
    busy.value = false
  }
}

async function recheck(g) {
  if (rechecking.value) return
  rechecking.value = true
  try {
    const res = await releaseStore.recheckGate(g.id, auth.user)
    if (res.status === 'ok') {
      if (res.cleared) alert('全部准入维度已通过，进入影响确认环节。')
      else alert('仍有阻断维度未消除：\n' + (res.blocking || []).map((b) => '· ' + b.reason).join('\n'))
    } else if (res.status === 'denied' || res.status === 'guest') {
      alert('你没有重新评估资格：仅提交人、文档负责人、管理员（缺口阻断时编辑者也可）可触发。')
    } else alert('操作失败：门禁状态已变化')
  } finally {
    rechecking.value = false
  }
}

async function waiver(g, check) {
  const res = await releaseStore.signOffCheck(g.id, check.key, (waiverNote.value[g.id + '-' + check.key] || '').trim(), auth.user)
  if (res.status === 'ok') {
    waiverNote.value = { ...waiverNote.value, [g.id + '-' + check.key]: '' }
    if (res.cleared) alert('该维度已豁免，全部准入维度通过，进入影响确认环节。')
  } else if (res.status === 'denied' || res.status === 'guest') {
    alert('你没有该维度的豁免权限：' + (check.severity === CHECK_SEVERITY.HARD ? '该维度为硬阻断，必须在对应流程中消除' : '请由责任角色操作'))
  } else alert('操作失败：门禁状态已变化')
}

async function confirmItem(key) {
  const res = await releaseStore.confirmImpact(openGate.value.id, key, auth.user)
  if (res.status === 'denied') alert('你不是本门禁确认流配置的合格确认人，请由配置指定的确认人确认。')
}

// 多人确认流：合格确认人整体签署；达到法定人数后才提交管理员审批
async function signoff() {
  const g = openGate.value
  if (g.impacts.some((it) => it.status === IMPACT.PENDING)) {
    alert('仍有影响项未逐项确认（漂移新增项也需确认），请逐条确认后再签署。')
    return
  }
  const res = await releaseStore.signoffGate(g.id, confirmNote.value.trim(), auth.user)
  if (res.status === 'ok') {
    confirmNote.value = ''
    if (!res.met) alert('已签署（' + res.signed + '/' + res.required + '），等待其他确认人签署。')
  } else if (res.status === 'denied' || res.status === 'guest') {
    alert('你不是本门禁确认流配置的合格确认人。')
  } else if (res.status === 'unconfirmed') {
    alert('仍有影响项未确认（可能刚自动同步了漂移新增项），请逐项确认后再次签署。')
  } else if (res.status === 'drift') {
    alert('检测到版本漂移：\n' + (res.drift.items || []).map((d) => '· ' + driftKindLabel(d.kind)).join('\n') + '\n请先「同步影响项」再签署。')
  }
}

async function syncDrift() {
  const res = await releaseStore.syncGateDrift(openGate.value.id, auth.user)
  if (res.status === 'ok') {
    alert('影响项已同步：新增 ' + res.added + ' 项、失效 ' + res.removed + ' 项' + (res.revived ? '、恢复 ' + res.revived + ' 项' : '') + '。新增项请逐项确认后再签署。')
  } else if (res.status === 'denied') {
    alert('只有确认流确认人、提交人或管理员可以同步漂移影响项。')
  }
}

async function undoSignoff() {
  const res = await releaseStore.withdrawSignoff(openGate.value.id, auth.user)
  if (res.status !== 'ok') alert('撤回签署失败：门禁状态已变化（法定人数达成后请由管理员驳回）。')
}

async function withdraw(g) {
  if (!confirm('确定撤回本次发布门禁？候选版本将不发布，文档保持当前已发布版本。')) return
  const res = await releaseStore.withdrawGate(g.id, auth.user)
  if (res.status !== 'ok') alert('操作失败：门禁状态已变化')
}

async function decide(g, decision) {
  const res = await releaseStore.decideGate(g.id, decision, (decideNote.value[g.id] || '').trim(), auth.user)
  if (res.status === 'ok') { decideNote.value = { ...decideNote.value, [g.id]: '' } }
  else if (res.status === 'denied' || res.status === 'guest') alert('只有管理员可以审批放行或驳回。')
  else if (res.status === 'blocked') alert('放行前复检发现新的阻断维度，门禁已退回阻断态：\n' + (res.blocking || []).map((b) => '· ' + b.reason).join('\n'))
  else if (res.status === 'stale') alert('放行被阻止：候选 v' + g.version + ' 已不是最新版本（门禁期间产生了并发修改）。请撤回门禁后基于最新版本重新发起。')
  else if (res.status === 'drift') alert('放行被阻止：检测到未同步的版本漂移，门禁已退回影响确认，请由确认人同步漂移并重新签署后再放行。')
  else alert('操作失败：门禁状态已变化')
}

const ROLLBACK_BLOCK_HINT = {
  gated: '该文档存在在途发布门禁，请先撤回或完成门禁',
  'in-review': '该文档存在流转中的评审单，请先在评审通道结案',
  superseded: '已有更新版本发布，请先按顺序回退后续版本',
  drift: '文档发布状态已变化，请刷新后重试'
}

async function rollback(g) {
  if (!confirm('确定回退 v' + g.version + '？正文与问答引用将恢复到 v' + g.publishedVersion + '，共享链接内容同步还原。')) return
  const res = await releaseStore.rollbackGate(g.id, (rollbackNote.value[g.id] || '').trim(), auth.user)
  if (res.status === 'ok') { rollbackNote.value = { ...rollbackNote.value, [g.id]: '' } }
  else if (res.status === 'denied' || res.status === 'guest') alert('只有管理员可以回退已放行版本。')
  else if (ROLLBACK_BLOCK_HINT[res.status]) alert(ROLLBACK_BLOCK_HINT[res.status])
  else alert('操作失败：门禁状态已变化')
}

function impactIcon(type) {
  return { citation: '🤖', ticket: '📮', share: '🔗' }[type] || '•'
}

function checkIcon(key) {
  return { review: '📝', fresh: '🥬', gap: '📮', retire: '🗄️' }[key] || '•'
}
function checkActionHint(check) {
  if (check.key === 'review') return '请由管理员在评审中心审批通过/驳回，或由发起人撤回评审后重新评估'
  if (check.key === 'fresh') return '请编辑者完成保鲜修订送审、管理员复核通过；或由文档负责人/管理员豁免'
  if (check.key === 'gap') return '请认领并解决关联缺口工单；或由编辑者/管理员豁免'
  return '请先撤销退役/等待退役审批结案后重新评估'
}

onMounted(() => releaseStore.loadAll())
</script>

<template>
  <div class="gate-panel card">
    <div class="gp-head">
      <span class="gp-title">🚦 统一发布门禁 · 评审 / 保鲜 / 缺口 / 退役</span>
      <span class="gp-head-acts">
        <button v-if="canEditFlow && !showFlowEditor" class="btn sm ghost" @click="showFlowEditor = true">⚙️ 确认流配置</button>
        <button v-if="canSubmit && !showForm" class="btn sm primary" @click="showForm = true">提交版本发布门禁</button>
      </span>
    </div>
    <FlowConfigEditor
      v-if="showFlowEditor"
      :scope="docFlowScope(doc.id)"
      :doc-id="doc.id"
      @close="showFlowEditor = false"
      @saved="showFlowEditor = false"
    />
    <p class="gp-submit-hint" v-if="!records.length && !showForm">
      编辑保存新版本后提交门禁：系统统一检查评审结论、知识保鲜、未解决缺口与退役关系四个维度，阻断时按责任角色跨角色处置或豁免；随后由负责人确认影响、管理员审批放行，版本才会对外发布。
    </p>

    <!-- 提交表单 -->
    <div v-if="showForm" class="gp-form">
      <textarea v-model="note" rows="2" placeholder="本次版本变更说明（可选，将作为门禁留痕）"></textarea>
      <div class="gp-form-hint">
        提交后门禁先做四维度准入检查：流转中评审/已退役等硬阻断须先消除，保鲜到期/未解决缺口可由责任人豁免；阻断期间问答/搜索/共享链接仍只展示已发布旧版。
      </div>
      <div class="gp-form-acts">
        <button class="btn sm primary" :disabled="busy" @click="submit">{{ busy ? '提交中…' : '确认提交门禁' }}</button>
        <button class="btn sm ghost" @click="showForm = false">取消</button>
      </div>
    </div>

    <!-- 在途门禁 -->
    <div v-if="openGate" class="gate-open" :class="{ 'is-blocked': openGate.status === GATE.BLOCKED }">
      <div class="go-top">
        <div class="go-main">
          <span class="st" :class="gateStatusCls(openGate.status)">{{ gateStatusLabel(openGate.status) }}</span>
          <span class="go-ver">候选版本 v{{ openGate.version }} → 已发布 v{{ openGate.publishedVersion }}</span>
        </div>
        <span class="go-time">{{ formatDate(openGate.createdAt) }}</span>
      </div>
      <div class="go-meta">
        <span>{{ userName(openGate.submittedBy) }} 提交</span>
        <span v-if="progress && openGate.status !== GATE.BLOCKED" class="go-sign-chip" :class="{ done: progress.met }">
          ✍ 确认签署 {{ progress.signed }}/{{ progress.required }}
        </span>
        <span v-if="openGate.confirmedAt">达成确认：{{ userName(openGate.confirmedBy) }}</span>
        <span class="go-flow-chip">漂移：{{ driftPolicyLabel }}</span>
        <span v-if="openGate.note" class="go-note">“{{ openGate.note }}”</span>
      </div>
      <div v-if="progress && openGate.status !== GATE.BLOCKED && progress.signoffs.length" class="go-signoffs">
        <span v-for="s in progress.signoffs" :key="s.by" class="so-user">
          {{ userName(s.by) }}<em v-if="s.restoredFromGateId">♻</em>
        </span>
      </div>
      <div v-if="gateChangedFields.length" class="go-fields">
        变更字段：<b>{{ fieldLabels(gateChangedFields).join('、') }}</b>
      </div>

      <!-- 统一准入检查：四维度状态机 -->
      <div class="checks">
        <div class="ck-title">
          准入检查（{{ (openGate.checks || []).filter((c) => c.status === 'pass').length }}/{{ (openGate.checks || []).length }} 通过）
        </div>
        <div v-for="ck in openGate.checks || []" :key="ck.key" class="check" :class="ck.status === 'blocked' ? (ck.severity === CHECK_SEVERITY.HARD ? 'ck-hard' : 'ck-soft') : 'ck-pass'">
          <div class="ck-head">
            <span class="ck-ico">{{ checkIcon(ck.key) }}</span>
            <span class="ck-label">{{ ck.label }}</span>
            <span class="ck-sev" v-if="ck.status === 'blocked'">{{ ck.severity === CHECK_SEVERITY.HARD ? '须消除' : '可豁免' }}</span>
            <span class="ck-state">{{ ck.status === 'pass' ? (ck.waiver ? '已豁免' : '已通过') : '阻断中' }}</span>
          </div>
          <div v-if="ck.status === 'blocked'" class="ck-body">
            <div v-for="b in ck.blockers || []" :key="b.id" class="ck-reason">
              <b v-if="b.title">{{ b.title }}：</b>{{ b.reason }}
            </div>
            <div class="ck-hint">{{ checkActionHint(ck) }}</div>
            <div v-if="canWaiver(ck)" class="ck-act">
              <input :value="waiverNote[openGate.id + '-' + ck.key] || ''" placeholder="豁免说明（可选，将留痕）" @input="waiverNote[openGate.id + '-' + ck.key] = $event.target.value" />
              <button class="btn xs waiver" @click="waiver(openGate, ck)">责任豁免该维度</button>
            </div>
          </div>
          <div v-else-if="ck.waiver" class="ck-waiver">
            由{{ ck.waiver.role === 'owner' ? '文档负责人' : (ck.waiver.role === 'admin' ? '管理员' : '编辑者') }}
            {{ userName(ck.waiver.by) }} 豁免<template v-if="ck.waiver.note">：“{{ ck.waiver.note }}”</template>
          </div>
        </div>
      </div>

      <!-- 阻断态操作条 -->
      <div v-if="openGate.status === GATE.BLOCKED" class="go-blocked-acts">
        <button class="btn sm primary" :disabled="rechecking" @click="recheck(openGate)">{{ rechecking ? '重新评估中…' : '🔄 重新评估准入状态' }}</button>
        <button v-if="openGate.submittedBy === auth.user?.id || isAdmin" class="btn sm ghost" @click="withdraw(openGate)">撤回门禁</button>
        <span v-if="!canRecheck(openGate)" class="go-blocked-tip">当前角色不可重新评估，请联系提交人/文档负责人/管理员</span>
      </div>

      <!-- 影响项清单（阻断消除后才进入逐项确认） -->
      <template v-if="openGate.status !== GATE.BLOCKED">
        <!-- 版本漂移横幅 -->
        <div v-if="pendingDrift" class="go-drift">
          <div class="gd-head">⚠️ 检测到版本漂移（{{ driftPolicyLabel }}策略），同步后才可继续：</div>
          <div v-for="(d, i) in pendingDrift.items || []" :key="i" class="gd-item">
            · {{ driftKindLabel(d.kind) }}<template v-if="d.count != null">（{{ d.count }} 项）</template>
          </div>
          <button
            v-if="openGate.status === GATE.PENDING_CONFIRM && (isFlowEligible || openGate.submittedBy === auth.user?.id || isAdmin)"
            class="btn sm primary"
            @click="syncDrift"
          >🔄 同步影响项</button>
        </div>

        <div class="impacts">
          <div class="imp-title">受影响关联（{{ openGate.impacts.length }}）</div>
          <div v-if="!openGate.impacts.length" class="imp-empty">确认范围内未检索到问答引用、缺口工单或有效共享链接，可直接签署确认。</div>
          <div v-for="it in openGate.impacts" :key="it.key" class="impact" :class="'im-' + it.status">
            <span class="im-ico">{{ impactIcon(it.type) }}</span>
            <div class="im-body">
              <div class="im-title">{{ it.title }}</div>
              <div class="im-sub">
                <span class="im-type">{{ impactTypeLabel(it.type) }}</span>
                <span v-if="it.subtitle">{{ it.subtitle }}</span>
                <span v-if="it.driftAddedAt" class="im-drift">漂移新增</span>
                <span class="im-state">{{ impactStatusLabel(it.status) }}</span>
              </div>
            </div>
            <button
              v-if="openGate.status === GATE.PENDING_CONFIRM && isFlowEligible && it.status === IMPACT.PENDING"
              class="btn xs"
              @click="confirmItem(it.key)"
            >确认影响</button>
          </div>
        </div>
        <div v-if="openGate.impacts.some((it) => it.restoredFromGateId)" class="go-restore-hint">
          ♻️ 已自动恢复上轮门禁中确认过的 {{ openGate.impacts.filter((it) => it.restoredFromGateId).length }} 项影响结论。
        </div>

        <!-- 多人确认流：签署区（PENDING_CONFIRM） -->
        <div v-if="openGate.status === GATE.PENDING_CONFIRM && isFlowEligible" class="go-confirm">
          <div class="gc-sign-state">
            确认人签署：{{ progress.signed }}/{{ progress.required }}
            <span v-if="!progress.met" class="gc-wait">（还需 {{ progress.required - progress.signed }} 名确认人签署）</span>
            <span v-else class="gc-met">法定人数已达成</span>
          </div>
          <textarea v-model="confirmNote" rows="2" placeholder="影响确认意见（可选，将作为本人签署留痕）"></textarea>
          <div class="go-acts">
            <button class="btn sm ok-solid" @click="signoff">{{ hasSigned ? '更新我的签署' : '签署影响确认' }}</button>
            <button v-if="hasSigned" class="btn sm ghost" @click="undoSignoff">撤回我的签署</button>
            <button v-if="openGate.submittedBy === auth.user?.id || isAdmin" class="btn sm ghost" @click="withdraw(openGate)">撤回升版</button>
          </div>
        </div>
        <div v-else-if="openGate.status === GATE.PENDING_CONFIRM" class="go-wait">
          等待确认流指定的确认人签署（{{ progress.signed }}/{{ progress.required }}），可联系：
          {{ auth.users.filter(u => isFlowConfirmer(flow, openGate, doc, u.id, u.role)).map(u => u.name).slice(0, 6).join('、') || '管理员' }}
          <button v-if="openGate.submittedBy === auth.user?.id" class="btn xs ghost" @click="withdraw(openGate)">撤回</button>
        </div>

        <!-- 管理员审批 -->
        <div v-if="openGate.status === GATE.PENDING_APPROVAL && isAdmin" class="go-decide">
          <textarea :value="decideNote[openGate.id] || ''" rows="2" placeholder="审批意见（可选，将写入留痕；放行前系统会再次复检四维度与版本漂移）" @input="decideNote[openGate.id] = $event.target.value"></textarea>
          <div class="go-acts">
            <button class="btn sm danger-ghost" @click="decide(openGate, 'reject')">✕ 驳回（不发布）</button>
            <button class="btn sm ok-solid" @click="decide(openGate, 'approve')">✓ 审批放行并发布</button>
          </div>
        </div>
        <div v-else-if="openGate.status === GATE.PENDING_APPROVAL" class="go-wait">
          影响确认已达成法定人数（{{ progress.signed }}/{{ progress.required }}），等待管理员审批放行
          <button v-if="openGate.submittedBy === auth.user?.id || isAdmin" class="btn xs ghost" @click="withdraw(openGate)">撤回升版</button>
        </div>
      </template>
    </div>

    <!-- 最近一次门禁结论 -->
    <div v-if="lastGate && !openGate" class="gate-done" :class="'gd-' + lastGate.status">
      <div class="gd-top">
        <span class="st" :class="gateStatusCls(lastGate.status)">{{ gateStatusLabel(lastGate.status) }}</span>
        <span class="gd-ver">v{{ lastGate.version }}{{ lastGate.status === 'rolled_back' ? '（已回退至 v' + lastGate.publishedVersion + '）' : '' }}</span>
        <span class="gd-time">{{ formatFull(lastGate.decidedAt || lastGate.createdAt) }}</span>
      </div>
      <div class="gd-note" v-if="lastGate.decisionNote">审批意见：“{{ lastGate.decisionNote }}”</div>
      <div class="gd-note" v-else-if="lastGate.rollbackNote">回退说明：“{{ lastGate.rollbackNote }}”</div>
      <div class="gd-note" v-if="(lastGate.checks || []).some((c) => c.waiver)">
        本轮豁免：<template v-for="c in lastGate.checks.filter((x) => x.waiver)" :key="c.key">【{{ c.label }}】{{ userName(c.waiver.by) }} </template>
      </div>
      <div v-if="isAdmin && lastGate.status === GATE.RELEASED" class="gd-rollback">
        <input :value="rollbackNote[lastGate.id] || ''" placeholder="回退原因（可选）" @input="rollbackNote[lastGate.id] = $event.target.value" />
        <button class="btn sm danger-ghost" @click="rollback(lastGate)">↩ 回退该版本</button>
      </div>
    </div>

    <!-- 历史时间线 -->
    <details v-if="lastGate" class="gp-timeline">
      <summary>查看门禁留痕时间线（{{ lastGate.timeline?.length || 0 }}）</summary>
      <div v-for="(t, i) in lastGate.timeline || []" :key="i" class="tl">
        <span class="tl-act">{{ gateTimelineLabel(t.action) }}</span>
        <span class="tl-who">{{ userName(t.by) }}</span>
        <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
        <span class="tl-tm">{{ formatFull(t.at) }}</span>
      </div>
    </details>
  </div>
</template>

<style scoped>
.gate-panel { margin-top: 14px; padding: 16px 20px; }
.gp-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.gp-title { font-weight: 700; font-size: 14px; }
.gp-submit-hint { margin: 8px 0 0; font-size: 12.5px; color: var(--text-3); }
.gp-form { margin-top: 12px; }
.gp-form textarea, .go-confirm textarea, .go-decide textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
.gp-form textarea:focus, .go-confirm textarea:focus, .go-decide textarea:focus { border-color: var(--primary); }
.gp-form-hint { font-size: 12px; color: var(--warn); margin: 6px 0; }
.gp-form-acts, .go-acts { display: flex; gap: 8px; margin-top: 8px; }
.gate-open { margin-top: 12px; border: 1px solid #bfdbfe; background: #f8fbff; border-radius: 10px; padding: 14px 16px; }
.gate-open.is-blocked { border-color: #fca5a5; background: #fff8f8; }
.go-top { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.go-main { display: flex; gap: 10px; align-items: center; }
.go-ver { font-weight: 600; font-size: 13px; }
.go-time { color: var(--text-3); font-size: 12px; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
.st-blocked { background: #fee2e2; color: #b91c1c; }
.st-confirm { background: #e0e7ff; color: #4338ca; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-rollback { background: #ffedd5; color: #c2410c; }
.go-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; font-size: 12.5px; color: var(--text-2); }
.go-note { color: var(--text-3); }
.go-fields { margin-top: 8px; font-size: 12.5px; color: var(--text-2); }
.go-fields b { color: var(--primary); }

/* 准入检查维度 */
.checks { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--panel); }
.ck-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.check { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; background: var(--panel); }
.check.ck-pass { border-color: #86efac; background: #f0fdf4; }
.check.ck-soft { border-color: #fcd34d; background: #fffbeb; }
.check.ck-hard { border-color: #fca5a5; background: #fef2f2; }
.ck-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ck-ico { font-size: 14px; }
.ck-label { font-weight: 600; }
.ck-sev { font-size: 11px; border-radius: 999px; padding: 0 8px; background: #fee2e2; color: #b91c1c; }
.ck-soft .ck-sev { background: #fef3c7; color: #b45309; }
.ck-state { margin-left: auto; font-size: 12px; color: #15803d; }
.ck-hard .ck-state, .ck-soft .ck-state { color: #b91c1c; font-weight: 600; }
.ck-body { margin-top: 6px; font-size: 12.5px; color: var(--text-2); }
.ck-reason { padding: 2px 0; }
.ck-hint { color: var(--text-3); font-size: 12px; margin-top: 2px; }
.ck-act { display: flex; gap: 8px; margin-top: 6px; }
.ck-act input { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 12px; outline: none; }
.btn.xs.waiver { background: #f59e0b; border-color: #f59e0b; color: #fff; white-space: nowrap; }
.ck-waiver { margin-top: 4px; font-size: 12px; color: #b45309; }
.go-blocked-acts { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.go-blocked-tip { font-size: 12px; color: var(--text-3); }
.go-restore-hint { margin-top: 8px; font-size: 12.5px; color: #15803d; background: #f0fdf4; border-radius: 8px; padding: 6px 10px; }

/* 可配置影响确认流：签署进度 / 漂移横幅 */
.gp-head-acts { display: flex; gap: 8px; }
.go-sign-chip { font-size: 12px; padding: 1px 10px; border-radius: 999px; background: #e0e7ff; color: #4338ca; }
.go-sign-chip.done { background: #dcfce7; color: #15803d; }
.go-flow-chip { font-size: 12px; color: var(--text-3); }
.go-signoffs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.so-user { font-size: 11.5px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 999px; padding: 1px 10px; color: var(--text-2); }
.so-user em { font-style: normal; color: #15803d; margin-left: 2px; }
.go-drift { margin-top: 10px; border: 1px solid #fcd34d; background: #fffbeb; border-radius: 10px; padding: 10px 12px; }
.gd-head { font-size: 12.5px; font-weight: 600; color: #b45309; }
.gd-item { font-size: 12px; color: var(--text-2); margin-top: 2px; }
.go-drift .btn { margin-top: 8px; }
.gc-sign-state { font-size: 12.5px; color: var(--text-2); margin-bottom: 6px; }
.gc-wait { color: #b45309; }
.gc-met { color: #15803d; }
.im-drift { background: #fef3c7; color: #b45309; border-radius: 999px; padding: 0 8px; }
.impact.im-missing { opacity: 0.65; }
.im-missing .im-state { color: var(--text-3); }

.impacts { margin-top: 12px; }
.imp-title { font-weight: 600; font-size: 13px; margin-bottom: 8px; }
.imp-empty { font-size: 12.5px; color: var(--text-3); padding: 6px 0; }
.impact { display: flex; gap: 10px; align-items: flex-start; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; background: var(--panel); }
.impact.im-confirmed, .impact.im-released { border-color: #86efac; background: #f0fdf4; }
.impact.im-reverted { opacity: 0.7; }
.im-ico { font-size: 15px; line-height: 1.4; }
.im-body { flex: 1; min-width: 0; }
.im-title { font-size: 13px; font-weight: 500; word-break: break-word; }
.im-sub { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; font-size: 11.5px; color: var(--text-3); }
.im-type { background: var(--primary-weak); color: var(--primary); border-radius: 999px; padding: 0 8px; }
.im-state { margin-left: auto; color: #15803d; }
.im-pending .im-state { color: #b45309; }
.im-reverted .im-state { color: var(--text-3); }
.btn.xs { padding: 2px 10px; font-size: 12px; }
.go-confirm { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 10px; }
.go-decide { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 10px; }
.go-wait { margin-top: 10px; font-size: 12.5px; color: var(--text-2); display: flex; gap: 10px; align-items: center; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.danger-ghost { background: #fff; border-color: #f2555c; color: #b91c1c; }
.btn.danger-ghost:hover { background: #fef2f2; }
.gate-done { margin-top: 12px; border-radius: 10px; padding: 12px 14px; border: 1px solid var(--border); background: var(--panel-2); }
.gate-done.gd-released { border-color: #86efac; background: #f0fdf4; }
.gate-done.gd-rejected { border-color: #fecaca; background: #fef2f2; }
.gate-done.gd-rolled_back { border-color: #fdba74; background: #fff7ed; }
.gd-top { display: flex; gap: 10px; align-items: center; font-size: 13px; }
.gd-ver { font-weight: 600; }
.gd-time { margin-left: auto; color: var(--text-3); font-size: 12px; }
.gd-note { margin-top: 6px; font-size: 12.5px; color: var(--text-2); }
.gd-rollback { display: flex; gap: 8px; margin-top: 8px; }
.gd-rollback input { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; font-size: 12.5px; outline: none; }
.gp-timeline { margin-top: 10px; }
.gp-timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 96px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
</style>
