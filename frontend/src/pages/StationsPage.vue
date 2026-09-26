<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Station } from '@/types'
import { currentStations, isCurrentVersion, stationRootId, stationVersions } from '@/types'
import BearingInput from '@/components/common/BearingInput.vue'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { caveStore } from '@/stores/caveStore'
import { computeHorizontal, computeVertical, formatDms, isValidBearing, isValidDip } from '@/utils/survey'
import { nextCode, uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const selectedSegmentId = ref<string>('')
const editingId = ref<string | null>(null)
/** 复测目标（闭合洞段已锁定的当前版本测点 id）；与 editingId 互斥 */
const resurveyTargetId = ref<string | null>(null)
const lastSaved = ref<string>('')

const form = reactive({
  code: 'P1',
  bearing: 90,
  dip: 0,
  slopeDistance: 10,
  instrumentNo: 'SOKKIA-2',
  surveyor: '',
  date: new Date().toISOString().slice(0, 10),
  isClosurePoint: false,
  note: '',
  /** 复测原因（仅闭合洞段复测时必填） */
  resurveyReason: ''
})

const cavesWithSegments = computed(() => caveState.caves)
const segmentOptions = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)
const currentSegment = computed(() => segmentState.segments.find((segment) => segment.id === selectedSegmentId.value))
/** 闭合洞段：原始读数锁定，修改只能走复测生成新版本 */
const segmentClosed = computed(() => currentSegment.value?.closed ?? false)
const resurveyTarget = computed(
  () => stationState.stations.find((station) => station.id === resurveyTargetId.value) ?? null
)

/** 列表与所有派生计算只取当前生效版本，历史版本通过展开行查看 */
const segmentStations = computed(() =>
  currentStations(stationState.stations)
    .filter((station) => station.segmentId === selectedSegmentId.value)
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
)

/** 已保存测点 + 当前待录入测点一起参与闭合差计算，实时反映累计闭合差 */
const pendingStation = computed<Station>(() => ({
  id: 'pending',
  segmentId: selectedSegmentId.value,
  code: form.code,
  bearing: form.bearing,
  dip: form.dip,
  slopeDistance: form.slopeDistance,
  horizontalDistance: previewHorizontal.value,
  verticalDistance: previewVertical.value,
  instrumentNo: form.instrumentNo,
  surveyor: form.surveyor,
  date: form.date,
  isClosurePoint: form.isClosurePoint,
  note: form.note,
  version: 1,
  isCurrent: true,
  rootId: 'pending',
  resurveyReason: ''
}))

const closureInput = computed<Station[]>(() => [...segmentStations.value, pendingStation.value])
const { result: closureResult, over: closureOver } = useClosureCheck(closureInput)

const previewHorizontal = computed(() => computeHorizontal(form.dip, form.slopeDistance))
const previewVertical = computed(() => computeVertical(form.dip, form.slopeDistance))

/** 异常读数：方位角或倾角超范围、斜距非正、水平距大于斜距 */
function isAbnormal(station: Station): boolean {
  if (!isValidBearing(station.bearing)) return true
  if (!isValidDip(station.dip)) return true
  if (!(station.slopeDistance > 0)) return true
  return station.horizontalDistance > Math.abs(station.slopeDistance) + 0.001
}

function rowClassName(param: { row: Station }): string {
  return isAbnormal(param.row) ? 'abnormal-row' : ''
}

function refreshDefaultCode(): void {
  form.code = nextCode('P', segmentStations.value.map((station) => station.code))
}

// IndexedDB 数据是异步水合的，洞穴/洞段到达后自动选中第一条，避免空选
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

watch(
  () => [selectedCaveId.value, segmentOptions.value.length] as const,
  () => {
    const list = segmentOptions.value
    if (!list.some((segment) => segment.id === selectedSegmentId.value)) {
      selectedSegmentId.value = list.length > 0 ? list[0].id : ''
    }
  },
  { immediate: true }
)

watch(
  () => selectedSegmentId.value,
  () => {
    editingId.value = null
    resurveyTargetId.value = null
    form.resurveyReason = ''
    refreshDefaultCode()
  },
  { immediate: true }
)

/** 新读数是否仍异常（桩号空、方位角/倾角越界、斜距非正、推算水平距大于斜距） */
function abnormalReasons(station: Pick<Station, 'code' | 'bearing' | 'dip' | 'slopeDistance' | 'horizontalDistance'>): string[] {
  const reasons: string[] = []
  if (!station.code.trim()) reasons.push('测点桩号为空')
  if (!isValidBearing(station.bearing)) reasons.push('方位角超出 0°–360°')
  if (!isValidDip(station.dip)) reasons.push('倾角超出 -90°–90°')
  if (!(station.slopeDistance > 0)) reasons.push('斜距必须大于 0')
  if (Number.isFinite(station.horizontalDistance) && station.horizontalDistance > Math.abs(station.slopeDistance) + 0.001) {
    reasons.push('推算水平距大于斜距')
  }
  return reasons
}

async function submit(continueNext: boolean): Promise<void> {
  if (!selectedSegmentId.value) {
    ElMessage.warning('请先选择洞段')
    return
  }
  // 闭合洞段：走复测流程，原读数封存、新版本生效；校验不过则旧值原样保留
  if (resurveyTargetId.value) {
    await submitResurvey()
    return
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写测点桩号')
    return
  }
  if (!(form.slopeDistance > 0)) {
    ElMessage.warning('斜距必须大于 0')
    return
  }
  if (!isValidBearing(form.bearing)) {
    ElMessage.warning('前视方位角必须在 0°–360° 之间')
    return
  }
  if (!isValidDip(form.dip)) {
    ElMessage.warning('倾角必须在 -90°–90° 之间')
    return
  }
  const existing = stationState.stations.find((station) => station.id === editingId.value)
  const station: Station = {
    id: existing?.id ?? uid('st'),
    segmentId: selectedSegmentId.value,
    code: form.code.trim(),
    bearing: form.bearing,
    dip: form.dip,
    slopeDistance: form.slopeDistance,
    horizontalDistance: previewHorizontal.value,
    verticalDistance: previewVertical.value,
    instrumentNo: form.instrumentNo.trim(),
    surveyor: form.surveyor.trim(),
    date: form.date,
    isClosurePoint: form.isClosurePoint,
    note: form.note.trim(),
    version: existing?.version ?? 1,
    isCurrent: existing?.isCurrent ?? true,
    rootId: existing?.rootId ?? '',
    resurveyReason: existing?.resurveyReason ?? ''
  }
  // 非闭合洞段沿用直接更新（旧洞段首版 rootId 落库时补齐为自身 id）
  if (!station.rootId) station.rootId = station.id
  await stationStore.getState().save(station)
  lastSaved.value = `${station.code} · 水平距 ${station.horizontalDistance} m / 垂距 ${station.verticalDistance} m`
  ElMessage.success(existing ? `测点 ${station.code} 已更新` : `测点 ${station.code} 已录入`)
  editingId.value = null
  form.isClosurePoint = false
  form.note = ''
  if (continueNext) {
    await stationStore.getState().hydrate()
    form.code = nextCode('P', segmentStations.value.map((item) => item.code))
  }
}

/** 闭合洞段复测：原因+日期必填、读数不得异常，全部通过后新版本才会生效 */
async function submitResurvey(): Promise<void> {
  const previous = resurveyTarget.value
  if (!previous) {
    resurveyTargetId.value = null
    return
  }
  const invalidate = (reason: string): void => {
    ElMessage.error(`本次复测未生效，原读数保持不变：${reason}`)
  }
  if (!form.resurveyReason.trim()) {
    invalidate('复测原因未填写')
    return
  }
  if (!form.date) {
    invalidate('测量日期未填写')
    return
  }
  const draft = {
    code: form.code,
    bearing: form.bearing,
    dip: form.dip,
    slopeDistance: form.slopeDistance,
    horizontalDistance: previewHorizontal.value
  }
  const reasons = abnormalReasons(draft)
  if (reasons.length > 0) {
    invalidate(`新读数仍异常（${reasons.join('、')}）`)
    return
  }
  const nextVersion = (previous.version ?? 1) + 1
  const next: Station = {
    id: uid('st'),
    segmentId: previous.segmentId,
    code: form.code.trim(),
    bearing: form.bearing,
    dip: form.dip,
    slopeDistance: form.slopeDistance,
    horizontalDistance: previewHorizontal.value,
    verticalDistance: previewVertical.value,
    instrumentNo: form.instrumentNo.trim(),
    surveyor: form.surveyor.trim(),
    date: form.date,
    isClosurePoint: form.isClosurePoint,
    note: form.note.trim(),
    version: nextVersion,
    isCurrent: true,
    rootId: stationRootId(previous),
    resurveyReason: form.resurveyReason.trim()
  }
  await stationStore.getState().resurvey(previous.id, next)
  lastSaved.value = `${next.code} 第 ${nextVersion} 版已生效 · 复测原因 ${next.resurveyReason}`
  ElMessage.success(`复测已生效：${next.code} 更新为第 ${nextVersion} 版，原读数已保留为历史版本`)
  cancelEdit()
}

function editStation(station: Station): void {
  resurveyTargetId.value = null
  form.resurveyReason = ''
  editingId.value = station.id
  form.code = station.code
  form.bearing = station.bearing
  form.dip = station.dip
  form.slopeDistance = station.slopeDistance
  form.instrumentNo = station.instrumentNo
  form.surveyor = station.surveyor
  form.date = station.date
  form.isClosurePoint = station.isClosurePoint
  form.note = station.note
}

/** 闭合洞段复测入口：读数预填当前版本，复测日期默认今天，原因留空待填 */
function startResurvey(station: Station): void {
  editingId.value = null
  resurveyTargetId.value = station.id
  form.resurveyReason = ''
  form.code = station.code
  form.bearing = station.bearing
  form.dip = station.dip
  form.slopeDistance = station.slopeDistance
  form.instrumentNo = station.instrumentNo
  form.surveyor = station.surveyor
  form.date = new Date().toISOString().slice(0, 10)
  form.isClosurePoint = station.isClosurePoint
  form.note = station.note
}

function cancelEdit(): void {
  editingId.value = null
  resurveyTargetId.value = null
  form.resurveyReason = ''
  form.isClosurePoint = false
  form.note = ''
  refreshDefaultCode()
}

/** 展开行：同一测点的完整版本链（首版 + 历次复测） */
function versionsOf(station: Station): Station[] {
  return stationVersions(stationState.stations, stationRootId(station))
}

function versionCount(station: Station): number {
  return versionsOf(station).length
}

async function removeStation(station: Station): Promise<void> {
  const chain = versionsOf(station)
  const chainHint = chain.length > 1 ? `（含 ${chain.length} 个版本，将一并删除）` : ''
  await ElMessageBox.confirm(`确认删除测点「${station.code}」${chainHint}？`, '删除确认', { type: 'warning' })
  await stationStore.getState().remove(station.id)
  ElMessage.success('测点已删除')
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">测点与读数录入</h2>
        <p class="page-sub">
          录入前视方位角、倾角与斜距，系统自动推算水平距与垂距，并实时累计该洞段的导线闭合差；异常读数整行高亮。
        </p>
      </div>
      <el-tag v-if="lastSaved" type="success" effect="plain">最近保存：{{ lastSaved }}</el-tag>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 200px">
        <el-option v-for="cave in cavesWithSegments" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-select v-model="selectedSegmentId" placeholder="选择洞段" style="width: 220px">
        <el-option
          v-for="segment in segmentOptions"
          :key="segment.id"
          :label="`${segment.code}（${segment.startStake} → ${segment.endStake}）`"
          :value="segment.id"
        />
      </el-select>
      <SegmentTag v-if="currentSegment" :type="currentSegment.type" :closed="currentSegment.closed" size="small" />
      <el-button :disabled="!selectedSegmentId" @click="refreshDefaultCode">重算下一桩号</el-button>
    </div>

    <el-alert
      v-if="segmentClosed"
      class="alert"
      type="warning"
      :closable="false"
      title="该洞段已闭合，原始读数已锁定"
      description="修改读数需通过「复测」：填写复测原因与测量日期后生成新版本，闭合差、草图折线与图幅锚点均按当前版本重算，历史版本在列表行内展开即可查看。"
    />
    <el-alert
      v-if="resurveyTarget"
      class="alert"
      type="error"
      :closable="false"
      :title="`正在复测测点 ${resurveyTarget.code}（当前第 ${resurveyTarget.version ?? 1} 版）`"
      description="原读数已锁定不会被覆盖：保存后新读数成为当前版本，原版本转入历史可随时查看；若复测原因未填或新读数仍异常，本次复测不会生效。"
    />

    <el-card shadow="never" class="form-card">
      <el-form label-width="96px">
        <el-row :gutter="16">
          <el-col :span="6">
            <el-form-item label="测点桩号" required>
              <el-input v-model="form.code" placeholder="如 P12" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="前视方位角">
              <BearingInput v-model="form.bearing" kind="bearing" @invalid="(msg: string) => ElMessage.warning(msg)" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="倾角">
              <BearingInput v-model="form.dip" kind="dip" @invalid="(msg: string) => ElMessage.warning(msg)" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="斜距(m)" required>
              <el-input-number v-model="form.slopeDistance" :min="0" :step="0.1" :precision="3" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="6">
            <el-form-item label="仪器号">
              <el-input v-model="form.instrumentNo" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="测量人">
              <el-input v-model="form.surveyor" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="测量日期">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="闭合点">
              <el-switch v-model="form.isClosurePoint" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="resurveyTarget" label="复测原因" required>
          <el-input
            v-model="form.resurveyReason"
            type="textarea"
            :rows="2"
            placeholder="必填：为什么复测（读数异常、仪器干扰、与草图不符……），将随新版本一起存档"
          />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="岩壁、滴水、崩塌堆积等现场情况" />
        </el-form-item>
        <div class="preview">
          <el-tag effect="plain">自动推算：水平距 {{ previewHorizontal.toFixed(3) }} m</el-tag>
          <el-tag effect="plain">垂距 {{ previewVertical.toFixed(3) }} m</el-tag>
          <el-tag effect="plain">方位角 {{ formatDms(form.bearing) }}</el-tag>
          <el-tag effect="plain">倾角 {{ formatDms(form.dip) }}</el-tag>
        </div>
        <div class="actions">
          <el-button type="primary" @click="submit(false)">
            {{ resurveyTarget ? '保存复测（生成新版本）' : editingId ? '保存修改' : '保存测点' }}
          </el-button>
          <el-button v-if="!resurveyTarget" type="success" plain @click="submit(true)">保存并录入下一站</el-button>
          <el-button v-if="editingId || resurveyTarget" @click="cancelEdit">取消</el-button>
        </div>
      </el-form>
    </el-card>

    <ClosureBadge
      class="closure"
      :closure="closureResult.closure"
      :threshold="closureResult.threshold"
      :level="closureResult.level"
      :detail="closureResult.detail"
      :count="segmentStations.length"
    />
    <el-alert
      v-if="closureOver"
      class="alert"
      type="error"
      :closable="false"
      title="闭合差已超限"
      description="当前洞段累计闭合差超过阈值，建议复测异常测点或对读数做误差分配。"
    />

    <h3 class="section-title">本洞段读数（当前版本，共 {{ segmentStations.length }} 站）</h3>
    <el-table :data="segmentStations" border stripe :row-class-name="rowClassName">
      <el-table-column type="expand">
        <template #default="{ row }: { row: Station }">
          <div class="version-history">
            <div v-for="item in versionsOf(row)" :key="item.id" class="version-row">
              <el-tag :type="isCurrentVersion(item) ? 'success' : 'info'" size="small" effect="plain">
                {{ isCurrentVersion(item) ? '当前版本' : '历史版本' }}
              </el-tag>
              <span class="mono">第 {{ item.version ?? 1 }} 版</span>
              <span>方位 {{ item.bearing }}° · 倾角 {{ item.dip }}° · 斜距 {{ item.slopeDistance }} m</span>
              <span>测量日期 {{ item.date || '—' }}</span>
              <span v-if="item.resurveyReason" class="reason">复测原因：{{ item.resurveyReason }}</span>
              <span v-else class="muted">首次录入</span>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="code" label="桩号" width="90" />
      <el-table-column label="版本" width="120">
        <template #default="{ row }: { row: Station }">
          <el-tag size="small" effect="plain">v{{ row.version ?? 1 }}</el-tag>
          <el-tooltip v-if="versionCount(row) > 1" content="展开行首可查看历史版本" placement="top">
            <el-tag size="small" type="warning" effect="plain">+{{ versionCount(row) - 1 }} 历史</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="方位角" width="150">
        <template #default="{ row }: { row: Station }">{{ row.bearing }}° / {{ formatDms(row.bearing) }}</template>
      </el-table-column>
      <el-table-column label="倾角" width="140">
        <template #default="{ row }: { row: Station }">{{ row.dip }}°</template>
      </el-table-column>
      <el-table-column prop="slopeDistance" label="斜距(m)" width="100" />
      <el-table-column prop="horizontalDistance" label="水平距(m)" width="110" />
      <el-table-column prop="verticalDistance" label="垂距(m)" width="100" />
      <el-table-column prop="instrumentNo" label="仪器号" width="110" />
      <el-table-column prop="surveyor" label="测量人" width="90" />
      <el-table-column prop="date" label="日期" width="120" />
      <el-table-column label="闭合点" width="90">
        <template #default="{ row }: { row: Station }">
          <el-tag v-if="row.isClosurePoint" type="success" size="small" effect="plain">是</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="读数状态" width="110">
        <template #default="{ row }: { row: Station }">
          <el-tag v-if="isAbnormal(row)" type="danger" size="small" effect="dark">异常</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }: { row: Station }">
          <template v-if="segmentClosed">
            <el-button link type="warning" size="small" @click="startResurvey(row)">复测</el-button>
            <el-tooltip content="洞段已闭合，原始读数已锁定，不可直接编辑或删除" placement="top">
              <span class="locked-tag"><el-button link type="info" size="small" disabled>已锁定</el-button></span>
            </el-tooltip>
          </template>
          <template v-else>
            <el-button link type="primary" size="small" @click="editStation(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="removeStation(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.form-card {
  border-radius: 12px;
  margin-bottom: 16px;
}
.preview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 0 0 96px;
}
.actions {
  display: flex;
  gap: 10px;
  padding: 14px 0 0 96px;
}
.closure {
  margin-bottom: 12px;
}
.alert {
  margin-bottom: 12px;
}
:deep(.abnormal-row) {
  background: #fdf2f2 !important;
}
:deep(.abnormal-row td) {
  color: #b03030;
}
.version-history {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 12px;
}
.version-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: #4a5b6b;
}
.version-row .reason {
  color: #8a6d1f;
}
</style>
