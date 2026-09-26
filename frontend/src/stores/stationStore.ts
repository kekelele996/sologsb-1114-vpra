import { createStore } from 'zustand/vanilla'
import type { Station } from '@/types'
import { stationRootId } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'

export interface StationState {
  stations: Station[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (station: Station) => Promise<void>
  /** 复测生效：原当前版本封存为历史，新版本成为当前版本（同一事务，旧值不会丢失） */
  resurvey: (previousId: string, next: Station) => Promise<void>
  /** 删除测点：同一版本链的所有版本一并删除 */
  remove: (id: string) => Promise<void>
}

export const stationStore = createStore<StationState>((set, get) => ({
  stations: [],
  loaded: false,
  hydrate: async () => {
    const stations = await syncAll<Station>(db.stations)
    stations.sort((a, b) => {
      const byCode = a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true })
      return byCode !== 0 ? byCode : (a.version ?? 1) - (b.version ?? 1)
    })
    set({ stations, loaded: true })
  },
  save: async (station) => {
    await syncPut<Station>(db.stations, station)
    await get().hydrate()
  },
  resurvey: async (previousId, next) => {
    const previous = get().stations.find((item) => item.id === previousId)
    if (!previous) return
    await db.transaction('rw', db.stations, async () => {
      await db.stations.put({ ...previous, isCurrent: false })
      await db.stations.put(next)
    })
    await get().hydrate()
  },
  remove: async (id) => {
    const target = get().stations.find((item) => item.id === id)
    const chain = target
      ? get().stations.filter((item) => stationRootId(item) === stationRootId(target))
      : []
    const ids = chain.length > 0 ? chain.map((item) => item.id) : [id]
    await db.stations.bulkDelete(ids)
    await get().hydrate()
  }
}))
