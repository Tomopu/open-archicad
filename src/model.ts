// ドキュメントモデル(単位: mm)
import type { Pt } from './geometry'

let seq = 0
export const uid = (): string => `e${Date.now().toString(36)}${(seq++).toString(36)}`

// ---- 建具種別(JIS A 0150 平面表示記号に対応) ----
export type DoorKind =
  | 'door_single'    // 片開き戸
  | 'door_double'    // 両開き戸
  | 'door_sliding'   // 引違い戸
  | 'door_pocket'    // 片引き戸
  | 'door_folding'   // 折りたたみ戸
export type WindowKind =
  | 'win_sliding'    // 引違い窓
  | 'win_fix'        // はめ殺し窓 (FIX)
  | 'win_single'     // 片開き窓
export type OpeningKind = DoorKind | WindowKind
export const isWindow = (k: OpeningKind): boolean => k.startsWith('win_')

export type StairKind = 'straight' | 'l' | 'u' | 'spiral'
export type FurnKind =
  | 'bed_s' | 'bed_d' | 'table' | 'chair' | 'sofa' | 'kitchen' | 'toilet'
  | 'bathtub' | 'washbasin' | 'fridge' | 'washer' | 'desk' | 'closet' | 'box'
export type EquipKind =
  | 'boiler'       // ボイラー・給湯器
  | 'ventfan'      // 換気扇 (24h換気)
  | 'alarm'        // 住宅用火災警報器
  | 'ac_indoor'    // エアコン室内機
  | 'ac_outdoor'   // エアコン室外機
  | 'panel'        // 分電盤
  | 'heater'       // 電気温水器・蓄熱暖房
export type PlantKind = 'tree' | 'shrub' | 'person'
export type RoomUse = '居室' | '寝室' | 'キッチン' | '浴室' | '洗面所' | 'トイレ' | '廊下' | '玄関' | '収納' | '階段室' | '吹き抜け' | 'その他'

// ---- マテリアル(仕上げ)プリセット。テクスチャは実行時に Canvas で生成(外部画像なし=軽量) ----
export type TexKind = 'wood' | 'brick' | 'tile' | 'tatami' | 'grass' | 'stone' | 'concrete'
export interface MaterialDef { id: string; label: string; color: string; tex?: TexKind; opacity?: number }
export const MATERIALS: MaterialDef[] = [
  { id: 'white', label: '白仕上げ', color: '#f5f5f4' },
  { id: 'concrete', label: 'コンクリート', color: '#c9c9c7', tex: 'concrete' },
  { id: 'wood_light', label: '木(明)', color: '#d9b98c', tex: 'wood' },
  { id: 'wood_dark', label: '木(濃)', color: '#8a5f3b', tex: 'wood' },
  { id: 'brick', label: 'レンガ', color: '#b0603f', tex: 'brick' },
  { id: 'tile', label: 'タイル', color: '#d8dee2', tex: 'tile' },
  { id: 'tatami', label: '畳', color: '#b9c48a', tex: 'tatami' },
  { id: 'stone', label: '石', color: '#9aa0a3', tex: 'stone' },
  { id: 'grass', label: '芝生', color: '#7aa85a', tex: 'grass' },
  { id: 'glass', label: 'ガラス', color: '#9cc3e8', opacity: 0.45 }
]

export interface Wall {
  id: string; type: 'wall'; a: Pt; b: Pt; thickness: number; height: number; structural: boolean
  material?: string; color?: string; group?: string; hidden?: boolean
  /** 基準線(通り芯)の壁中心線からのオフセット(法線方向 mm)。未設定=中心 */
  refOff?: number
}
export interface Opening {
  id: string; type: 'opening'; wallId: string; t: number; width: number
  kind: OpeningKind; flip: boolean; swap: boolean; group?: string; hidden?: boolean
  sill: number   // 床からの高さ(窓台)
  head: number   // 開口上端高さ
}
/** 壁への取り付け(磁石吸着時に記録)。壁の厚みが変わっても面にピッタリ追従する */
export interface WallAttach { wallId: string; side: 1 | -1 }
export interface Stair {
  id: string; type: 'stair'; pos: Pt; rot: number; kind: StairKind
  width: number; treads: number; tread: number; riser: number; material?: string; color?: string; group?: string; hidden?: boolean; attach?: WallAttach
}
export interface Furniture { id: string; type: 'furniture'; pos: Pt; rot: number; kind: FurnKind; w: number; d: number; h: number; material?: string; color?: string; group?: string; hidden?: boolean; elev?: number; tiltX?: number; tiltZ?: number; attach?: WallAttach }
export interface Equipment { id: string; type: 'equipment'; pos: Pt; rot: number; kind: EquipKind; w?: number; d?: number; group?: string; hidden?: boolean; attach?: WallAttach }
export interface Column { id: string; type: 'column'; pos: Pt; rot: number; w: number; d: number; h: number; shape: 'rect' | 'round'; material?: string; color?: string; group?: string; hidden?: boolean; attach?: WallAttach }
/** 寸法線の端点が従属しているスナップ点(壁の t 位置・部屋の頂点など)。対象が変形するとリアルタイム追従 */
export interface DimAnchor { entId: string; t?: number; vi?: number; kind: 'wall' | 'roomV' | 'roomC' | 'center' }
export interface DimensionE {
  id: string; type: 'dimension'; a: Pt; b: Pt; offset: number; group?: string; hidden?: boolean
  anchorA?: DimAnchor; anchorB?: DimAnchor
}
export interface LabelE { id: string; type: 'label'; pos: Pt; text: string; size: number; group?: string; hidden?: boolean }
export interface Room { id: string; type: 'room'; poly: Pt[]; name: string; use: RoomUse; showArea: boolean; material?: string; color?: string; group?: string; hidden?: boolean }
export interface Planting { id: string; type: 'planting'; pos: Pt; kind: PlantKind; height: number; group?: string; hidden?: boolean }
/** 鉛筆ツールの線1本。色は辺ごとに設定可能 */
export interface SketchEdge { a: Pt; b: Pt; color?: string }
/** 鉛筆ツールで描いたスケッチ(SketchUp 流)。閉路は自動的に面になる。
 *  faces のキーは面の図心(faceKey)。h=押し出し高さ mm / dead=面を削除(貫通穴) */
export interface SketchE {
  id: string; type: 'sketch'; edges: SketchEdge[]
  faces?: Record<string, { h?: number; dead?: boolean }>
  group?: string; hidden?: boolean
}
/** 部品スタジオ(CSG モデリング)で作成したオリジナル部品 */
export interface CustomE {
  id: string; type: 'custom'; pos: Pt; rot: number
  w: number; d: number; h: number       // 現在の寸法(w0 等との比率でスケール)
  w0: number; d0: number; h0: number    // ジオメトリの元寸法
  label: string
  symbol: 'rect' | 'round'              // 2D 図面での表示記号
  color?: string; group?: string; elev?: number
  hidden?: boolean
  /** 三角形メッシュの頂点(mm、原点=底面中央) */
  positions: number[]
  /** 部品スタジオでの再編集用レシピ(プリミティブ構成) */
  recipe?: unknown
  /** 3D での傾き(度)。2D 記号には反映しない */
  tiltX?: number
  tiltZ?: number
  attach?: WallAttach
}

/** dispName = オブジェクト一覧での表示名(ダブルクリックでリネーム) */
export type Entity = (Wall | Opening | Stair | Furniture | Equipment | Column | DimensionE | LabelE | Room | Planting | CustomE | SketchE) & { dispName?: string }

export interface ProjectMeta {
  title: string
  siteArea: number        // 敷地面積 m²
  bcrLimit: number        // 指定建蔽率 %
  farLimit: number        // 指定容積率 %
  floors: number
  /** グループの表示名(オブジェクト一覧でリネーム可能) */
  groupNames?: Record<string, string>
}

/** 階(フロア)。図面は階ごとに独立して持つ。height=階高 mm(未設定は壁高から自動) */
export interface Level { id: string; name: string; entities: Entity[]; height?: number }

export interface Doc {
  version: number
  meta: ProjectMeta
  levels: Level[]
  /** 編集中の階の要素(levels[active].entities への参照。直接代入しない) */
  entities: Entity[]
}

export function newDoc(): Doc {
  const l1: Level = { id: uid(), name: '1F', entities: [] }
  return {
    version: 2,
    meta: { title: '無題のプロジェクト', siteArea: 0, bcrLimit: 60, farLimit: 200, floors: 1 },
    levels: [l1],
    entities: l1.entities
  }
}

// ---- 既定値ファクトリ ----
export const FURN_DEFAULTS: Record<FurnKind, { w: number; d: number; h: number; label: string }> = {
  bed_s:     { w: 1000, d: 2000, h: 450, label: 'シングルベッド' },
  bed_d:     { w: 1400, d: 2000, h: 450, label: 'ダブルベッド' },
  table:     { w: 1500, d: 800,  h: 720, label: 'テーブル' },
  chair:     { w: 450,  d: 450,  h: 800, label: '椅子' },
  sofa:      { w: 1800, d: 850,  h: 800, label: 'ソファ' },
  kitchen:   { w: 2550, d: 650,  h: 850, label: 'キッチン' },
  toilet:    { w: 450,  d: 750,  h: 400, label: '便器' },
  bathtub:   { w: 1600, d: 750,  h: 550, label: '浴槽' },
  washbasin: { w: 750,  d: 550,  h: 800, label: '洗面台' },
  fridge:    { w: 650,  d: 650,  h: 1800, label: '冷蔵庫' },
  washer:    { w: 640,  d: 640,  h: 1000, label: '洗濯機' },
  desk:      { w: 1200, d: 600,  h: 720, label: 'デスク' },
  closet:    { w: 1600, d: 600,  h: 2300, label: '収納' },
  box:       { w: 1000, d: 1000, h: 1000, label: 'ボックス(汎用)' }
}
export const EQUIP_LABEL: Record<EquipKind, string> = {
  boiler: '給湯器・ボイラー', ventfan: '換気扇(24h換気)', alarm: '住宅用火災警報器',
  ac_indoor: 'エアコン(室内)', ac_outdoor: 'エアコン(室外)', panel: '分電盤', heater: '電気温水器'
}
/** 設備記号の基準サイズ(リサイズはこの比率でスケール) */
export const EQUIP_SIZE: Record<EquipKind, { w: number; d: number }> = {
  boiler: { w: 600, d: 300 }, ventfan: { w: 300, d: 300 }, alarm: { w: 260, d: 260 },
  ac_indoor: { w: 800, d: 250 }, ac_outdoor: { w: 800, d: 320 }, panel: { w: 500, d: 160 },
  heater: { w: 600, d: 300 }
}
export const equipSize = (e: Equipment): { w: number; d: number } => ({
  w: e.w ?? EQUIP_SIZE[e.kind].w,
  d: e.d ?? EQUIP_SIZE[e.kind].d
})
export const OPENING_LABEL: Record<OpeningKind, string> = {
  door_single: '片開き戸', door_double: '両開き戸', door_sliding: '引違い戸',
  door_pocket: '片引き戸', door_folding: '折りたたみ戸',
  win_sliding: '引違い窓', win_fix: 'はめ殺し窓(FIX)', win_single: '片開き窓'
}
export const STAIR_LABEL: Record<StairKind, string> = {
  straight: '直進階段', l: 'かね折れ階段(L)', u: '折返し階段(U)', spiral: '螺旋階段'
}
export const PLANT_LABEL: Record<PlantKind, string> = { tree: '樹木', shrub: '低木', person: '人物' }

// ---- ドキュメント操作 + Undo ----
export class Store {
  doc: Doc = newDoc()
  active = 0   // 編集中の階
  private undoStack: string[] = []
  private redoStack: string[] = []
  private listeners = new Set<() => void>()

  onChange(fn: () => void): void { this.listeners.add(fn) }
  emit(): void { this.listeners.forEach(f => f()) }

  /** doc.entities は levels への参照なので、スナップショットは levels 側だけを持つ */
  private snap(): string {
    return JSON.stringify({ meta: this.doc.meta, levels: this.doc.levels, active: this.active })
  }
  private restore(s: string): void {
    const d = JSON.parse(s) as { meta: ProjectMeta; levels: Level[]; active: number }
    this.doc.meta = d.meta
    this.doc.levels = d.levels
    this.active = Math.min(d.active ?? 0, d.levels.length - 1)
    this.doc.entities = this.doc.levels[this.active].entities
  }

  /** 変更前に呼ぶ(スナップショット保存) */
  commit(): void {
    this.undoStack.push(this.snap())
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack.length = 0
  }
  undo(): void {
    const s = this.undoStack.pop()
    if (!s) return
    this.redoStack.push(this.snap())
    this.restore(s); this.emit()
  }
  redo(): void {
    const s = this.redoStack.pop()
    if (!s) return
    this.undoStack.push(this.snap())
    this.restore(s); this.emit()
  }

  // ---- 階(フロア)管理 ----
  setLevel(i: number): void {
    if (i < 0 || i >= this.doc.levels.length) return
    this.active = i
    this.doc.entities = this.doc.levels[i].entities
    this.emit()
  }
  addLevel(): void {
    this.commit()
    const n = this.doc.levels.length + 1
    this.doc.levels.push({ id: uid(), name: `${n}F`, entities: [] })
    this.doc.meta.floors = this.doc.levels.length
    this.setLevel(this.doc.levels.length - 1)
  }
  removeLevel(i: number): void {
    if (this.doc.levels.length <= 1) return
    this.commit()
    this.doc.levels.splice(i, 1)
    this.doc.meta.floors = this.doc.levels.length
    this.setLevel(Math.min(this.active, this.doc.levels.length - 1))
  }
  renameLevel(i: number, name: string): void {
    this.doc.levels[i].name = name
    this.emit()
  }
  /** 下階の要素(透かし表示用)。1階なら null */
  levelBelow(): Entity[] | null {
    return this.active > 0 ? this.doc.levels[this.active - 1].entities : null
  }
  /** 下階の壁・柱を現在の階へ複製(外周壁の位置合わせ用)。複製数を返す */
  copyWallsFromBelow(): number {
    const below = this.levelBelow()
    if (!below) return 0
    this.commit()
    let n = 0
    for (const e of below) {
      if (e.type !== 'wall' && e.type !== 'column') continue
      const c = JSON.parse(JSON.stringify(e)) as Entity
      c.id = uid()
      this.doc.entities.push(c); n++
    }
    this.emit()
    return n
  }

  add(e: Entity): void { this.doc.entities.push(e); this.emit() }
  remove(ids: Set<string>): void {
    // 壁を消すときは載っている建具も消す
    const wallIds = new Set(this.doc.entities.filter(e => e.type === 'wall' && ids.has(e.id)).map(e => e.id))
    const filtered = this.doc.entities.filter(e =>
      !ids.has(e.id) && !(e.type === 'opening' && wallIds.has((e as Opening).wallId)))
    // doc.entities は levels[active].entities への参照なので、両方を同じ配列に差し替える
    this.doc.levels[this.active].entities = filtered
    this.doc.entities = filtered
    this.emit()
  }
  byId(id: string): Entity | undefined { return this.doc.entities.find(e => e.id === id) }
  /** 選択にグループの仲間を追加する(グループ化された要素はまとめて選ばれる) */
  expandGroups(ids: Set<string>): void {
    const groups = new Set<string>()
    for (const id of ids) {
      const e = this.byId(id)
      if (e?.group) groups.add(e.group)
    }
    if (!groups.size) return
    for (const e of this.doc.entities) {
      if (e.group && groups.has(e.group)) ids.add(e.id)
    }
  }
  walls(): Wall[] { return this.doc.entities.filter((e): e is Wall => e.type === 'wall') }
  openings(): Opening[] { return this.doc.entities.filter((e): e is Opening => e.type === 'opening') }
  rooms(): Room[] { return this.doc.entities.filter((e): e is Room => e.type === 'room') }
  stairs(): Stair[] { return this.doc.entities.filter((e): e is Stair => e.type === 'stair') }
  equipment(): Equipment[] { return this.doc.entities.filter((e): e is Equipment => e.type === 'equipment') }

  serialize(): string {
    // entities は levels への参照なので保存対象から外す
    return JSON.stringify({ version: 2, meta: this.doc.meta, levels: this.doc.levels }, null, 1)
  }
  load(json: string): void {
    const d = JSON.parse(json) as Partial<Doc>
    if (!d.meta) throw new Error('不正なファイル形式です')
    let levels: Level[]
    if (Array.isArray(d.levels) && d.levels.length) levels = d.levels
    else if (Array.isArray(d.entities)) levels = [{ id: uid(), name: '1F', entities: d.entities }] // v1 形式の移行
    else throw new Error('不正なファイル形式です')
    this.commit()
    this.doc.meta = d.meta as ProjectMeta
    this.doc.levels = levels
    this.doc.meta.floors = levels.length
    this.active = 0
    this.doc.entities = levels[0].entities
    this.emit()
  }
}
