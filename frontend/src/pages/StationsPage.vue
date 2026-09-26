<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Station, StationStatus } from '@/types'
import { isCurrentStation, stationStatusLabel } from '@/types'
import BearingInput from '@/components/common/BearingInput.vue'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { useClosureCheck } from '@/hooks/useClosureCheck'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { caveStore } from '@/stores/caveStore'
import { computeHorizontal, computeVertical, formatDms, isAbnormalStation, isValidBearing, isValidDip } from '@/utils/survey'
import { nextCode, uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const selectedSegmentId = ref<string>('')
const editingId = ref<string | null>(null)
const lastSaved = ref<string>('')
/** 复测对象（已闭合洞段中被复核的当前版本测点），为空表示非复测模式 */
const remeasureTarget = ref<Station | null>(null)
/** 复测/补录原因（已闭合洞段保存时必填） */
const remeasureReason = ref('')
/** 版本记录弹窗 */
const historyVisible = ref(false)
const historyGroupId = ref<string>('')

const form = reactive({
  code: 'P1',
  bearing: 90,
  dip: 0,
  slopeDistance: 10,
  instrumentNo: 'SOKKIA-2',
  surveyor: '',
  date: new Date().toISOString().slice(0, 10),
  isClosurePoint: false,
  note: ''
})

const cavesWithSegments = computed(() => caveState.caves)
const segmentOptions = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)
const currentSegment = computed(() => segmentState.segments.find((segment) => segment.id === selectedSegmentId.value))
/** 已闭合洞段的原始读数已锁定，修改只能走复测流程 */
const segmentLocked = computed(() => currentSegment.value?.closed ?? false)

/** 读数表与闭合差只统计各测点的当前版本，历史/未生效版本不参与计算 */
const segmentStations = computed(() =>
  stationState.stations
    .filter((station) => station.segmentId === selectedSegmentId.value && isCurrentStation(station))
    .sort((a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0]))
)

/** 已保存测点 + 当前待录入测点一起参与闭合差计算，实时反映累计闭合差 */
const pendingStation = computed<Station>(() => ({
  id: 'pending',
  segmentId: selectedSegmentId.value,
  groupId: remeasureTarget.value?.groupId ?? 'pending',
  version: (remeasureTarget.value?.version ?? 0) + 1,
  status: 'current',
  remeasureReason: remeasureReason.value,
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
  note: form.note
}))

/** 编辑/复测时用表单读数替换被修改的那一站，避免新旧读数重复计入闭合差 */
const closureInput = computed<Station[]>(() => {
  const replacedId = remeasureTarget.value?.id ?? editingId.value
  const base = replacedId ? segmentStations.value.filter((station) => station.id !== replacedId) : segmentStations.value
  return [...base, pendingStation.value]
})
const { result: closureResult, over: closureOver } = useClosureCheck(closureInput)

const previewHorizontal = computed(() => computeHorizontal(form.dip, form.slopeDistance))
const previewVertical = computed(() => computeVertical(form.dip, form.slopeDistance))

function rowClassName(param: { row: Station }): string {
  return isAbnormalStation(param.row) ? 'abnormal-row' : ''
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
    remeasureTarget.value = null
    remeasureReason.value = ''
    refreshDefaultCode()
  },
  { immediate: true }
)

/** 由表单组装一条测点记录（版本字段由调用方补齐） */
function buildDraft(segmentId: string, code: string): Station {
  return {
    id: 'draft',
    segmentId,
    groupId: '',
    version: 1,
    status: 'current',
    remeasureReason: '',
    code,
    bearing: form.bearing,
    dip: form.dip,
    slopeDistance: form.slopeDistance,
    horizontalDistance: previewHorizontal.value,
    verticalDistance: previewVertical.value,
    instrumentNo: form.instrumentNo.trim(),
    surveyor: form.surveyor.trim(),
    date: form.date,
    isClosurePoint: form.isClosurePoint,
    note: form.note.trim()
  }
}

async function submit(continueNext: boolean): Promise<void> {
  if (!selectedSegmentId.value) {
    ElMessage.warning('请先选择洞段')
    return
  }

  // 复测模式：闭合洞段的既有测点，保留原记录，新读数生成下一版本
  if (remeasureTarget.value) {
    if (!remeasureReason.value.trim()) {
      ElMessage.error('复测原因未填写，本次复测未生效，原读数保持不变')
      return
    }
    if (!form.date) {
      ElMessage.warning('请选择复测测量日期')
      return
    }
    const target = remeasureTarget.value
    const draft = buildDraft(target.segmentId, target.code)
    const { outcome, version } = await stationStore.getState().remeasure(target, draft, remeasureReason.value)
    if (outcome === 'rejected') {
      ElMessage.error(`新读数仍异常，本次复测未生效：${target.code} 原读数保留为当前版本，异常读数已存档为第 ${version} 版备查`)
    } else {
      lastSaved.value = `${target.code} · 第 ${version} 版（复测生效）`
      ElMessage.success(`复测已生效：${target.code} 更新为第 ${version} 版，原读数已归档保留`)
    }
    cancelRemeasure()
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
  // 已闭合洞段补录新测点：必须留痕原因，且读数异常时拒绝保存
  if (segmentLocked.value && !remeasureReason.value.trim()) {
    ElMessage.error('洞段已闭合，补录新测点必须填写补录原因，本次保存未生效')
    return
  }
  if (segmentLocked.value && !form.date) {
    ElMessage.warning('请选择测量日期')
    return
  }

  const existing = editingId.value ? stationState.stations.find((station) => station.id === editingId.value) : undefined
  const id = existing?.id ?? uid('st')
  const station: Station = {
    ...buildDraft(selectedSegmentId.value, form.code.trim()),
    id,
    groupId: existing?.groupId ?? id,
    version: existing?.version ?? 1,
    status: existing?.status ?? 'current',
    remeasureReason: existing?.remeasureReason ?? remeasureReason.value.trim()
  }
  await stationStore.getState().save(station)
  lastSaved.value = `${station.code} · 水平距 ${station.horizontalDistance} m / 垂距 ${station.verticalDistance} m`
  ElMessage.success(existing ? `测点 ${station.code} 已更新` : `测点 ${station.code} 已录入`)
  editingId.value = null
  form.isClosurePoint = false
  form.note = ''
  remeasureReason.value = ''
  if (continueNext) {
    await stationStore.getState().hydrate()
    form.code = nextCode('P', segmentStations.value.map((item) => item.code))
  }
}

function editStation(station: Station): void {
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

/** 进入复测模式：载入当前版本读数，测量日期默认今天（复测日期），原记录保持锁定 */
function startRemeasure(station: Station): void {
  editingId.value = null
  remeasureTarget.value = station
  remeasureReason.value = ''
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

function cancelRemeasure(): void {
  remeasureTarget.value = null
  remeasureReason.value = ''
  refreshDefaultCode()
}

async function removeStation(station: Station): Promise<void> {
  const count = versionCount(station)
  const extra = count > 1 ? `，其 ${count} 个版本记录将一并删除` : ''
  await ElMessageBox.confirm(`确认删除测点「${station.code}」${extra}？`, '删除确认', { type: 'warning' })
  await stationStore.getState().remove(station.id)
  ElMessage.success('测点已删除')
}

/** 同一逻辑测点的版本总数 */
function versionCount(station: Station): number {
  const groupId = station.groupId || station.id
  return stationState.stations.filter((item) => (item.groupId || item.id) === groupId).length
}

/** 版本记录弹窗：同一版本组的全部版本，新→旧排列 */
const historyVersions = computed(() =>
  stationState.stations
    .filter((station) => (station.groupId || station.id) === historyGroupId.value)
    .sort((a, b) => b.version - a.version)
)

function openHistory(station: Station): void {
  historyGroupId.value = station.groupId || station.id
  historyVisible.value = true
}

function statusTagType(status: StationStatus): 'success' | 'info' | 'danger' {
  if (status === 'rejected') return 'danger'
  if (status === 'superseded') return 'info'
  return 'success'
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">测点与读数录入</h2>
        <p class="page-sub">
          录入前视方位角、倾角与斜距，系统自动推算水平距与垂距，并实时累计该洞段的导线闭合差；异常读数整行高亮。已闭合洞段的读数锁定，修改须经复测并留痕。
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
      <el-tag v-if="segmentLocked" type="warning" effect="dark" size="small">读数已锁定</el-tag>
      <el-button :disabled="!selectedSegmentId" @click="refreshDefaultCode">重算下一桩号</el-button>
    </div>

    <el-alert
      v-if="segmentLocked"
      class="alert"
      type="warning"
      :closable="false"
      title="该洞段已闭合，原始读数已锁定"
      description="修改读数请在下方表格点击「复测」：新读数需填写复测原因与测量日期，保存后成为当前版本，原记录自动归档可随时查看；若原因未填或新读数仍异常，本次复测不生效，原读数保持不变。"
    />

    <el-card shadow="never" class="form-card">
      <el-alert
        v-if="remeasureTarget"
        class="remeasure-tip"
        type="info"
        :closable="false"
        :title="`正在复测测点 ${remeasureTarget.code}（当前第 ${remeasureTarget.version} 版）`"
        description="保存后新读数成为当前版本，原读数归档保留；新读数仍异常时仅存档备查，不替换当前版本。"
      />
      <el-form label-width="96px">
        <el-row :gutter="16">
          <el-col :span="6">
            <el-form-item label="测点桩号" required>
              <el-input v-model="form.code" placeholder="如 P12" :disabled="!!remeasureTarget" />
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
            <el-form-item :label="remeasureTarget ? '复测日期' : '测量日期'" :required="segmentLocked">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="闭合点">
              <el-switch v-model="form.isClosurePoint" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="segmentLocked" :label="remeasureTarget ? '复测原因' : '补录原因'" required>
          <el-input
            v-model="remeasureReason"
            type="textarea"
            :rows="2"
            placeholder="如：闭合差超限复测 / 仪器检校后重测 / 现场漏测补录"
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
            {{ remeasureTarget ? '保存复测' : editingId ? '保存修改' : '保存测点' }}
          </el-button>
          <el-button v-if="!remeasureTarget" type="success" plain @click="submit(true)">保存并录入下一站</el-button>
          <el-button v-if="remeasureTarget" @click="cancelRemeasure">取消复测</el-button>
          <el-button v-else-if="editingId" @click="editingId = null">取消编辑</el-button>
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

    <h3 class="section-title">本洞段读数（{{ segmentStations.length }} 站，当前版本）</h3>
    <el-table :data="segmentStations" border stripe :row-class-name="rowClassName">
      <el-table-column prop="code" label="桩号" width="80" />
      <el-table-column label="版本" width="80">
        <template #default="{ row }: { row: Station }">
          <el-tag :type="row.version > 1 ? 'warning' : 'info'" size="small" :effect="row.version > 1 ? 'dark' : 'plain'">
            v{{ row.version }}
          </el-tag>
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
          <el-tag v-if="isAbnormalStation(row)" type="danger" size="small" effect="dark">异常</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="复测原因" width="140" show-overflow-tooltip>
        <template #default="{ row }: { row: Station }">
          <span v-if="row.remeasureReason">{{ row.remeasureReason }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }: { row: Station }">
          <el-button v-if="segmentLocked" link type="warning" size="small" @click="startRemeasure(row)">复测</el-button>
          <el-button v-else link type="primary" size="small" @click="editStation(row)">编辑</el-button>
          <el-button link type="primary" size="small" @click="openHistory(row)">
            版本<template v-if="versionCount(row) > 1">({{ versionCount(row) }})</template>
          </el-button>
          <el-button v-if="!segmentLocked" link type="danger" size="small" @click="removeStation(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="historyVisible" title="测点版本记录" width="920px">
      <el-table :data="historyVersions" border stripe>
        <el-table-column label="版本" width="70">
          <template #default="{ row }: { row: Station }">v{{ row.version }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }: { row: Station }">
            <el-tag :type="statusTagType(row.status)" size="small" :effect="row.status === 'current' ? 'dark' : 'plain'">
              {{ stationStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="code" label="桩号" width="80" />
        <el-table-column label="方位角" width="100">
          <template #default="{ row }: { row: Station }">{{ row.bearing }}°</template>
        </el-table-column>
        <el-table-column label="倾角" width="90">
          <template #default="{ row }: { row: Station }">{{ row.dip }}°</template>
        </el-table-column>
        <el-table-column prop="slopeDistance" label="斜距(m)" width="90" />
        <el-table-column prop="horizontalDistance" label="水平距(m)" width="100" />
        <el-table-column prop="verticalDistance" label="垂距(m)" width="90" />
        <el-table-column prop="date" label="测量日期" width="110" />
        <el-table-column prop="surveyor" label="测量人" width="90" />
        <el-table-column label="读数" width="80">
          <template #default="{ row }: { row: Station }">
            <el-tag v-if="isAbnormalStation(row)" type="danger" size="small" effect="dark">异常</el-tag>
            <span v-else class="muted">正常</span>
          </template>
        </el-table-column>
        <el-table-column label="复测原因" min-width="150" show-overflow-tooltip>
          <template #default="{ row }: { row: Station }">{{ row.remeasureReason || '—' }}</template>
        </el-table-column>
      </el-table>
      <template #footer>
        <span class="muted">仅「当前版本」参与闭合差、草图折线与图幅拼合计算；历史与未生效版本只读留存。</span>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.form-card {
  border-radius: 12px;
  margin-bottom: 16px;
}
.remeasure-tip {
  margin-bottom: 14px;
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
</style>
