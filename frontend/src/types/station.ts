/** Station 测点：由方位角与斜距自动推算水平距与垂距 */
export interface Station {
  id: string
  segmentId: string
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
  /** 测量日期 */
  date: string
  /** 是否闭合点 */
  isClosurePoint: boolean
  note: string
  /** 版本号：首次录入为 1，每一次生效的复测 +1 */
  version: number
  /** 是否当前生效版本；闭合差、草图折线、图幅锚点只按当前版本计算 */
  isCurrent: boolean
  /** 版本链根记录 id（首版记录的 id，同一测点的所有版本共享） */
  rootId: string
  /** 复测原因（复测生成的新版本必填，首版为空串） */
  resurveyReason: string
}

/** 版本链根 id：早期数据缺省时回退为自身 id */
export function stationRootId(station: Station): string {
  return station.rootId || station.id
}

/** 是否当前生效版本（早期数据缺省视为当前版本） */
export function isCurrentVersion(station: Station): boolean {
  return station.isCurrent !== false
}

/** 只保留各测点的当前生效版本 */
export function currentStations(stations: Station[]): Station[] {
  return stations.filter(isCurrentVersion)
}

/** 同一测点的完整版本链，按版本号升序（含已封存的历史版本） */
export function stationVersions(stations: Station[], rootId: string): Station[] {
  return stations
    .filter((station) => stationRootId(station) === rootId)
    .sort((a, b) => (a.version ?? 1) - (b.version ?? 1))
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
