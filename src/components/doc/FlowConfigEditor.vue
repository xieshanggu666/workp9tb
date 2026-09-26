<script setup>
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useReleaseStore } from '@/stores/release'
import {
  IMPACT_TYPE, DRIFT_POLICY, CONFIRMER,
  normalizeFlowConfig, flowConfigSummary
} from '@/utils/impactFlow'

// 可配置影响确认流编辑器：全局默认（管理员）/ 文档级覆盖（负责人或管理员）。
// 配置随门禁提交物化快照，历史门禁按当轮配置解读；本编辑器只影响后续发起的门禁。
const props = defineProps({
  scope: { type: String, required: true }, // 'global' | 'doc:<id>'
  docId: { type: String, default: '' }
})
const emit = defineEmits(['close', 'saved'])

const auth = useAuthStore()
const releaseStore = useReleaseStore()

const busy = ref(false)
const error = ref('')

// 当前生效配置（含继承来源）与自定义记录
const resolved = computed(() => releaseStore.resolveFlowForDoc(props.docId || null))
const customPolicy = computed(() => releaseStore.flowPolicyOf(props.scope))
const sourceLabel = computed(() => ({
  default: '内置默认（未配置）',
  global: '全局配置',
  doc: '本文档自定义'
}[resolved.value.source]))

const SCOPE_TYPES = [
  { key: IMPACT_TYPE.CITATION, label: '问答引用' },
  { key: IMPACT_TYPE.TICKET, label: '缺口工单' },
  { key: IMPACT_TYPE.SHARE, label: '共享链接' }
]
const CONFIRMER_ROLES = [
  { key: CONFIRMER.OWNER, label: '文档负责人' },
  { key: CONFIRMER.EDITOR, label: '编辑者（团队）' },
  { key: CONFIRMER.SUBMITTER, label: '门禁提交人' }
]
const DRIFT_OPTIONS = [
  { key: DRIFT_POLICY.AUTO, label: '自动同步：签署时自动合并新增/失效关联' },
  { key: DRIFT_POLICY.NOTIFY, label: '提示待同步：须手动同步影响项后才可签署' },
  { key: DRIFT_POLICY.BLOCK, label: '阻断放行：放行前漂移未同步则退回影响确认' }
]

// 编辑草稿（以当前生效配置为底）
const draft = ref(normalizeFlowConfig({}))
function resetDraft() {
  draft.value = normalizeFlowConfig(JSON.parse(JSON.stringify(resolved.value.config)))
}

function toggle(list, key) {
  const i = list.indexOf(key)
  if (i >= 0) list.splice(i, 1)
  else list.push(key)
}
function toggleScope(key) { toggle(draft.value.scope, key) }
function toggleConfirmer(key) { toggle(draft.value.confirmers, key) }
function toggleMember(id) { toggle(draft.value.memberIds, id) }

const memberOptions = computed(() => auth.users.filter((u) => u.role !== 'viewer'))

const summary = computed(() => flowConfigSummary(normalizeFlowConfig(draft.value)))

async function save() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await releaseStore.saveFlowPolicy({ scope: props.scope, config: draft.value }, auth.user)
    if (res.status === 'ok') { emit('saved'); emit('close') }
    else if (res.status === 'empty-confirmers') error.value = '请至少选择一类确认人（角色或指定成员）。'
    else if (res.status === 'denied') error.value = '没有配置权限：全局配置仅管理员，文档级配置需负责人或管理员。'
    else error.value = '保存失败，请稍后重试。'
  } finally {
    busy.value = false
  }
}

async function clearCustom() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await releaseStore.clearFlowPolicy({ scope: props.scope }, auth.user)
    if (res.status === 'ok') { resetDraft(); emit('saved') }
    else if (res.status === 'no-policy') error.value = '当前没有自定义配置可清除。'
    else error.value = '清除失败或没有权限。'
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await Promise.all([releaseStore.loadAll(), auth.loadUsers()])
  resetDraft()
})
</script>

<template>
  <div class="flow-editor">
    <div class="fe-head">
      <span class="fe-title">⚙️ 影响确认流配置{{ scope === 'global' ? '（全局默认）' : '（本文档覆盖）' }}</span>
      <span class="fe-source">当前生效：{{ sourceLabel }}</span>
    </div>

    <div class="fe-row">
      <div class="fe-label">确认范围</div>
      <label v-for="t in SCOPE_TYPES" :key="t.key" class="fe-check">
        <input type="checkbox" :checked="draft.scope.includes(t.key)" @change="toggleScope(t.key)" />
        {{ t.label }}
      </label>
      <div class="fe-hint">不在范围内的关联仍随发布/回退联动，只是不要求逐项确认。</div>
    </div>

    <div class="fe-row">
      <div class="fe-label">确认人（可多选）</div>
      <label v-for="c in CONFIRMER_ROLES" :key="c.key" class="fe-check">
        <input type="checkbox" :checked="draft.confirmers.includes(c.key)" @change="toggleConfirmer(c.key)" />
        {{ c.label }}
      </label>
      <div class="fe-hint">管理员始终可确认（平台兜底角色）。</div>
    </div>

    <div class="fe-row">
      <div class="fe-label">指定成员</div>
      <div class="fe-members">
        <label v-for="u in memberOptions" :key="u.id" class="fe-check">
          <input type="checkbox" :checked="draft.memberIds.includes(u.id)" @change="toggleMember(u.id)" />
          {{ u.name }}
        </label>
        <span v-if="!memberOptions.length" class="fe-hint">暂无可指定的成员</span>
      </div>
    </div>

    <div class="fe-row fe-inline">
      <div class="fe-label">法定人数</div>
      <input v-model.number="draft.quorum" class="fe-num" type="number" min="1" max="20" />
      <span class="fe-hint">需 {{ draft.quorum }} 名不同确认人签署后才提交管理员审批（多人确认）。</span>
    </div>

    <div class="fe-row">
      <div class="fe-label">版本漂移策略</div>
      <select v-model="draft.driftPolicy" class="fe-select">
        <option v-for="o in DRIFT_OPTIONS" :key="o.key" :value="o.key">{{ o.label }}</option>
      </select>
      <div class="fe-hint">门禁流转期间检测到候选版本落后、关联新增/失效时的处理方式。</div>
    </div>

    <div class="fe-row fe-inline">
      <div class="fe-label">上轮结论恢复</div>
      <label class="fe-check">
        <input v-model="draft.autoRestore" type="checkbox" />
        驳回/撤回/回退后重新发起时，自动恢复上轮影响确认与签署
      </label>
    </div>

    <div class="fe-summary">配置摘要：{{ summary }}</div>
    <div v-if="error" class="fe-error">{{ error }}</div>

    <div class="fe-acts">
      <button class="btn sm primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存配置' }}</button>
      <button v-if="customPolicy" class="btn sm ghost" :disabled="busy" @click="clearCustom">清除自定义（回落继承）</button>
      <button class="btn sm ghost" @click="emit('close')">取消</button>
    </div>
    <div v-if="customPolicy?.history?.length" class="fe-history">
      最近变更：{{ customPolicy.history[customPolicy.history.length - 1].note }}
    </div>
  </div>
</template>

<style scoped>
.flow-editor { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; background: var(--panel-2); }
.fe-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.fe-title { font-weight: 700; font-size: 13px; }
.fe-source { font-size: 12px; color: var(--text-3); }
.fe-row { margin-top: 10px; }
.fe-label { font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 4px; }
.fe-check { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; margin-right: 14px; cursor: pointer; }
.fe-members { display: flex; flex-wrap: wrap; gap: 4px 0; }
.fe-hint { font-size: 11.5px; color: var(--text-3); margin-top: 3px; }
.fe-inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.fe-inline .fe-label { margin-bottom: 0; }
.fe-num { width: 64px; border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 13px; outline: none; }
.fe-select { width: 100%; border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12.5px; background: var(--panel); outline: none; }
.fe-summary { margin-top: 12px; font-size: 12px; color: var(--primary); background: var(--primary-weak); border-radius: 8px; padding: 6px 10px; }
.fe-error { margin-top: 8px; font-size: 12.5px; color: #b91c1c; }
.fe-acts { display: flex; gap: 8px; margin-top: 12px; }
.fe-history { margin-top: 8px; font-size: 11.5px; color: var(--text-3); }
</style>
