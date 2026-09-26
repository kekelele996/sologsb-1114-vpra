/** 测点版本状态：current 当前生效 / superseded 历史版本 / rejected 复测未生效 */
export const STATION_STATUSES = ['current', 'superseded', 'rejected'] as const
export type StationStatus = (typeof STATION_STATUSES)[number]

export const STATION_STATUS_LABELS: Record<StationStatus, string> = {
  current: '当前版本',
  superseded: '历史版本',
  rejected: '复测未生效'
}

/** Station 测点：由方位角与斜距自动推算水平距与垂距；闭合洞段读数按版本留存 */
export interface Station {
  id: string
  segmentId: string
  /** 版本组：同一逻辑测点的所有版本共享同一个 groupId */
  groupId: string
  /** 版本号，自 1 起，复测一次递增一次（含未生效的复测） */
  version: number
  /** 版本状态，仅 current 参与闭合差/草图/拼合计算 */
  status: StationStatus
  /** 复测（补录）原因，原始记录为空 */
  remeasureReason: string
  /** 测点桩号，如 P12 */
  code: string
  /** 前视方位角（十进制度，0-360） */
  bearing: number
  /** 倾角（十进制度，-90 ~ 90） */
  dip: number
  /** 斜距（米） */
  slopeDistance: number
  /** 水平距（米，由斜距与倾角推算） */
  horizontalDistance: number
  /** 垂距（米，由斜距与倾角推算） */
  verticalDistance: number
  /** 仪器号 */
  instrumentNo: string
  /** 测量人 */
  surveyor: string
  /** 测量日期（复测版本即复测日期） */
  date: string
  /** 是否闭合点 */
  isClosurePoint: boolean
  note: string
}

/** 是否为当前生效版本（旧数据缺省视为当前版本） */
export function isCurrentStation(station: Pick<Station, 'status'>): boolean {
  return (station.status ?? 'current') === 'current'
}

/** 版本状态中文标签（旧数据缺省视为当前版本） */
export function stationStatusLabel(status: StationStatus | undefined): string {
  return STATION_STATUS_LABELS[status ?? 'current']
}

export interface ClosureResult {
  /** 闭合差（米） */
  closure: number
  /** 阈值（米） */
  threshold: number
  /** 是否超限 */
  over: boolean
  level: '优' | '良' | '超限'
  /** 参与计算的测点数 */
  count: number
  /** 累计水平位移（东向 / 北向） */
  east: number
  north: number
  /** 计算过程说明 */
  detail: string
}
