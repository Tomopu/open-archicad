// 建築基準法・消防法の簡易リーガルチェック(戸建住宅想定の代表的な規定)
// ※ 設計の参考用の簡易チェックであり、法適合の保証や確認申請の代替にはならない。
import { Store, Room, Opening, Wall, Stair, Equipment, Entity, isWindow } from './model'
import { lerp, distToPoly, pointInPoly, polyContains, netPolyArea } from './geometry'

export interface LegalResult {
  level: 'ok' | 'warn' | 'error'
  title: string
  detail: string
  ref: string
  /** 図面上でハイライトする対象要素の id */
  ids?: string[]
  /** 対象要素がある階のインデックス(クリック時に階を切り替えるため) */
  levelIndex?: number
}

const HABITABLE: string[] = ['居室', '寝室', 'キッチン']

const roomsOf = (ents: Entity[]): Room[] => ents.filter((e): e is Room => e.type === 'room')
const stairsOf = (ents: Entity[]): Stair[] => ents.filter((e): e is Stair => e.type === 'stair')
const equipOf = (ents: Entity[]): Equipment[] => ents.filter((e): e is Equipment => e.type === 'equipment')

/** 部屋に面する窓(壁の中点が部屋境界の近くにある開口)を同じ階から集める */
function windowsOfRoom(ents: Entity[], room: Room): Opening[] {
  const walls = new Map<string, Wall>()
  for (const e of ents) if (e.type === 'wall') walls.set(e.id, e)
  const out: Opening[] = []
  for (const e of ents) {
    if (e.type !== 'opening' || !isWindow(e.kind)) continue
    const w = walls.get(e.wallId)
    if (!w) continue
    const c = lerp(w.a, w.b, e.t)
    if (distToPoly(c, room.poly) < w.thickness + 200) out.push(e)
  }
  return out
}

/** 入れ子の部屋(完全内包)を差し引いた正味床面積 m² */
const netM2 = (room: Room, rooms: Room[]): number =>
  netPolyArea(room.poly, rooms.filter(o => o !== room && polyContains(room.poly, o.poly)).map(o => o.poly)) / 1e6
const areaM2 = (rooms: Room[]): number =>
  rooms.filter(r => r.use !== '吹き抜け').reduce((s, r) => s + netM2(r, rooms), 0)

export function runLegalCheck(store: Store): LegalResult[] {
  const res: LegalResult[] = []
  const doc = store.doc
  const levels = doc.levels
  const multi = levels.length > 1
  const tag = (li: number, name: string): string => (multi ? `${levels[li].name} ${name}` : name)

  const groundM2 = areaM2(roomsOf(levels[0].entities))                       // 建築面積 ≈ 1階
  const totalM2 = levels.reduce((s, l) => s + areaM2(roomsOf(l.entities)), 0) // 延べ面積 = 全階合計

  // ---- 建蔽率・容積率(法53条・52条) ----
  if (doc.meta.siteArea > 0) {
    const bcr = (groundM2 / doc.meta.siteArea) * 100
    res.push({
      level: bcr <= doc.meta.bcrLimit ? 'ok' : 'error',
      title: `建蔽率 ${bcr.toFixed(1)}% / 指定 ${doc.meta.bcrLimit}%`,
      detail: `建築面積(1階の部屋面積合計で近似)${groundM2.toFixed(2)} m² ÷ 敷地面積 ${doc.meta.siteArea} m²`,
      ref: '建築基準法 第53条'
    })
    const far = (totalM2 / doc.meta.siteArea) * 100
    res.push({
      level: far <= doc.meta.farLimit ? 'ok' : 'error',
      title: `容積率 ${far.toFixed(1)}% / 指定 ${doc.meta.farLimit}%`,
      detail: `延べ面積(全 ${levels.length} 階の部屋面積合計で近似)${totalM2.toFixed(2)} m² ÷ 敷地面積 ${doc.meta.siteArea} m²`,
      ref: '建築基準法 第52条'
    })
  } else {
    res.push({
      level: 'warn', title: '敷地面積が未設定',
      detail: 'プロジェクト設定で敷地面積を入力すると建蔽率・容積率を確認できます。',
      ref: '建築基準法 第52・53条'
    })
  }

  let bedroomCount = 0
  for (let li = 0; li < levels.length; li++) {
    const ents = levels[li].entities
    const rooms = roomsOf(ents)
    const alarms = equipOf(ents).filter(e => e.kind === 'alarm')

    // ---- 居室の採光・換気(法28条) ----
    for (const room of rooms) {
      if (!HABITABLE.includes(room.use)) continue
      const floorM2 = netM2(room, rooms)
      const wins = windowsOfRoom(ents, room)
      const lightM2 = wins.reduce((s, o) => s + (o.width * Math.max(0, o.head - o.sill)) / 1e6, 0)
      const ventM2 = wins.filter(o => o.kind !== 'win_fix')
        .reduce((s, o) => s + (o.width * Math.max(0, o.head - o.sill)) / 1e6, 0)
      const needLight = floorM2 / 7, needVent = floorM2 / 20
      res.push({
        level: lightM2 >= needLight ? 'ok' : 'error',
        title: `${tag(li, room.name)}: 採光 ${lightM2.toFixed(2)} m² / 必要 ${needLight.toFixed(2)} m²`,
        detail: `床面積 ${floorM2.toFixed(2)} m² の 1/7 以上の有効採光面積が必要(窓面積で近似)。`,
        ref: '建築基準法 第28条第1項',
        ids: [room.id], levelIndex: li
      })
      res.push({
        level: ventM2 >= needVent ? 'ok' : 'error',
        title: `${tag(li, room.name)}: 換気 ${ventM2.toFixed(2)} m² / 必要 ${needVent.toFixed(2)} m²`,
        detail: `床面積の 1/20 以上の開放可能な開口が必要(FIX 窓は除外)。`,
        ref: '建築基準法 第28条第2項',
        ids: [room.id], levelIndex: li
      })
    }

    // ---- 階段の寸法(令23条: 住宅) ----
    for (const s of stairsOf(ents)) {
      const bad: string[] = []
      if (s.riser > 230) bad.push(`蹴上げ ${s.riser}mm > 230mm`)
      if (s.tread < 150) bad.push(`踏面 ${s.tread}mm < 150mm`)
      if (s.width < 750) bad.push(`階段幅 ${s.width}mm < 750mm`)
      res.push({
        level: bad.length ? 'error' : 'ok',
        title: `${tag(li, '階段')}: ${bad.length ? bad.join(' / ') : `蹴上げ${s.riser} 踏面${s.tread} 幅${s.width} — 適合`}`,
        detail: '住宅の階段は 蹴上げ≤230mm・踏面≥150mm・幅≥750mm。',
        ref: '建築基準法施行令 第23条',
        ids: [s.id], levelIndex: li
      })
      if (s.kind === 'spiral') {
        res.push({
          level: 'warn',
          title: `${tag(li, '螺旋階段')}: 踏面の測定位置に注意`,
          detail: '回り階段の踏面は狭い方の端から 300mm の位置で測る。中心付近は踏面不足になりやすい。',
          ref: '建築基準法施行令 第23条第2項',
          ids: [s.id], levelIndex: li
        })
      }
    }

    // ---- 廊下の幅(令119条 — 戸建住宅は適用外のため参考) ----
    for (const room of rooms) {
      if (room.use !== '廊下') continue
      const xs = room.poly.map(p => p.x), ys = room.poly.map(p => p.y)
      const minSide = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
      res.push({
        level: minSide >= 780 ? 'ok' : 'warn',
        title: `${tag(li, room.name)}: 有効幅 約${Math.round(minSide)}mm`,
        detail: '780mm 以上を推奨(車椅子対応は 850mm 以上)。共同住宅等では令119条の規定あり。',
        ref: '建築基準法施行令 第119条(参考)',
        ids: [room.id], levelIndex: li
      })
    }

    // ---- 住宅用火災警報器(消防法) ----
    for (const br of rooms.filter(r => r.use === '寝室')) {
      bedroomCount++
      const has = alarms.some(a => pointInPoly(a.pos, br.poly))
      res.push({
        level: has ? 'ok' : 'error',
        title: `${tag(li, br.name)}: 住宅用火災警報器 ${has ? '設置済み' : '未設置'}`,
        detail: '就寝に使用する居室には住宅用火災警報器(煙式)の設置が義務。',
        ref: '消防法 第9条の2・住宅用防災機器の設置基準',
        ids: [br.id], levelIndex: li
      })
    }

    // ---- 火気使用室の内装(参考) ----
    for (const k of rooms.filter(r => r.use === 'キッチン')) {
      res.push({
        level: 'warn',
        title: `${tag(li, k.name)}: 内装制限の確認`,
        detail: 'コンロ等の火気を使用する室は、階数・構造により壁天井を準不燃材料以上とする内装制限がかかる場合があります。',
        ref: '建築基準法 第35条の2・令128条の4',
        ids: [k.id], levelIndex: li
      })
    }
  }

  // ---- 階をまたぐチェック ----
  const anyStairs = levels.some(l => stairsOf(l.entities).length > 0)
  if (levels.length >= 2 && !anyStairs) {
    res.push({
      level: 'warn', title: '2階建て以上ですが階段がありません',
      detail: '上下階を結ぶ直通階段が必要です。', ref: '建築基準法施行令 第120条'
    })
  }
  if (levels.length >= 2 && bedroomCount > 0) {
    const ok = levels.some(l => {
      const stairRooms = roomsOf(l.entities).filter(r => r.use === '階段室')
      const alarms = equipOf(l.entities).filter(e => e.kind === 'alarm')
      return stairRooms.some(sr => alarms.some(a => pointInPoly(a.pos, sr.poly)))
    })
    res.push({
      level: ok ? 'ok' : 'warn',
      title: `階段室の火災警報器 ${ok ? '設置済み' : '未確認'}`,
      detail: '寝室のある階の階段(踊り場天井等)にも警報器の設置が必要。',
      ref: '消防法施行令 第5条の7'
    })
  }
  if (bedroomCount === 0 && levels.some(l => roomsOf(l.entities).length > 0)) {
    res.push({
      level: 'warn', title: '寝室が設定されていません',
      detail: '部屋の用途を「寝室」に設定すると火災警報器の設置チェックを行います。',
      ref: '消防法 第9条の2'
    })
  }

  // ---- 24時間換気(シックハウス対策) ----
  const vent = levels.some(l => equipOf(l.entities).some(e => e.kind === 'ventfan'))
  res.push({
    level: vent ? 'ok' : 'error',
    title: `24時間換気設備 ${vent ? 'あり' : 'なし'}`,
    detail: '居室を有する建築物には換気回数 0.5 回/h 以上の機械換気設備(24時間換気)が必要。設備ツールの「換気扇」を配置してください。',
    ref: '建築基準法施行令 第20条の8'
  })

  return res
}
