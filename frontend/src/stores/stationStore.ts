import { createStore } from 'zustand/vanilla'
import type { Station } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { isAbnormalStation } from '@/utils/survey'
import { uid } from '@/utils/id'

export interface RemeasureOutcome {
  /** effective = 新读数生效成为当前版本；rejected = 新读数异常，仅存档未生效 */
  outcome: 'effective' | 'rejected'
  /** 本次复测生成的版本号 */
  version: number
}

export interface StationState {
  stations: Station[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (station: Station) => Promise<void>
  /**
   * 闭合洞段复测：保留原记录，新读数生成下一版本。
   * 新读数正常 → 原当前版本归档为历史版本，新读数成为当前版本；
   * 新读数仍异常 → 异常读数仅存档为「复测未生效」，原当前版本不动。
   */
  remeasure: (original: Station, draft: Station, reason: string) => Promise<RemeasureOutcome>
  /** 删除测点：同一版本组的全部版本一并删除 */
  remove: (id: string) => Promise<void>
}

/** 版本组标识（旧数据缺省回退为自身 id） */
function groupOf(station: Station): string {
  return station.groupId || station.id
}

export const stationStore = createStore<StationState>((set, get) => ({
  stations: [],
  loaded: false,
  hydrate: async () => {
    const stations = await syncAll<Station>(db.stations)
    stations.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    set({ stations, loaded: true })
  },
  save: async (station) => {
    await syncPut<Station>(db.stations, station)
    await get().hydrate()
  },
  remeasure: async (original, draft, reason) => {
    const groupId = groupOf(original)
    const nextVersion =
      get()
        .stations.filter((item) => groupOf(item) === groupId)
        .reduce((max, item) => Math.max(max, item.version || 1), 0) + 1
    const abnormal = isAbnormalStation(draft)
    const record: Station = {
      ...draft,
      id: uid('st'),
      segmentId: original.segmentId,
      code: original.code,
      groupId,
      version: nextVersion,
      status: abnormal ? 'rejected' : 'current',
      remeasureReason: reason.trim()
    }
    if (abnormal) {
      // 复测未生效：仅存档异常读数备查，原当前版本保持不变
      await syncPut<Station>(db.stations, record)
    } else {
      // 复测生效：原当前版本归档为历史版本，新读数成为当前版本（同事务写入）
      const superseded: Station = { ...original, groupId, status: 'superseded' }
      await db.transaction('rw', db.stations, async () => {
        await db.stations.put(superseded)
        await db.stations.put(record)
      })
    }
    await get().hydrate()
    return { outcome: abnormal ? 'rejected' : 'effective', version: nextVersion }
  },
  remove: async (id) => {
    const target = get().stations.find((item) => item.id === id)
    const groupId = target ? groupOf(target) : id
    const ids = get()
      .stations.filter((item) => groupOf(item) === groupId)
      .map((item) => item.id)
    if (ids.length > 0) {
      await db.stations.bulkDelete(ids)
    } else {
      await syncDelete(db.stations, id)
    }
    await get().hydrate()
  }
}))
