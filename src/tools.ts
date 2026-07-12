// ツール(作図・選択)とポインタ操作
import {
  Store, Entity, Wall, Opening, SketchE, uid, OpeningKind, StairKind, FurnKind, EquipKind, PlantKind,
  FURN_DEFAULTS, isWindow, Room, RoomUse, DimAnchor, equipSize
} from './model'
import { Renderer2D, elevAxis, ElevWallProj } from './renderer2d'
import {
  Pt, pt, sub, add, dist, distToSeg, projT, lerp, snapTo, pointInPoly, norm, perp, polyArea, rotate,
  arcThrough, angleDetentDeg, lineIntersect, polyCentroid, sketchFaces, faceKey, faceInfo, strokePerpGuide,
  CURSOR_PENCIL, CURSOR_HAND
} from './geometry'
import {
  drawOpening, drawFurniture, drawStair, drawEquipment, drawPlanting, drawColumn,
  drawCustom, drawDimension, drawLabel, openingCenter
} from './symbols'

export type ToolName =
  | 'select' | 'wall' | 'column' | 'door' | 'window' | 'stair' | 'furniture'
  | 'equipment' | 'planting' | 'dimension' | 'label' | 'room' | 'pencil' | 'component'

/** 長方形 / 鉛筆(多角形)の入力モード(部屋・鉛筆ツール共通) */
export type DrawMode = 'rect' | 'poly'

/** 各ツールの現在パラメータ(左パネルの「ツール設定」から編集) */
export const params = {
  // offR / offL = 基準線(通り芯)から右側・左側の面までの距離。lock で連動
  wall: { thickness: 120, height: 2400, structural: false, arc: false, offR: 60, offL: 60, lock: true },
  column: { w: 300, d: 300, h: 2400, shape: 'rect' as 'rect' | 'round' },
  door: { kind: 'door_single' as OpeningKind, width: 780, head: 2000 },
  window: { kind: 'win_sliding' as OpeningKind, width: 1650, sill: 900, head: 2000 },
  stair: { kind: 'straight' as StairKind, width: 910, treads: 13, tread: 225, riser: 200 },
  furniture: { kind: 'bed_s' as FurnKind },
  equipment: { kind: 'boiler' as EquipKind },
  planting: { kind: 'tree' as PlantKind, height: 3000 },
  room: { use: '居室' as RoomUse, mode: 'rect' as DrawMode },
  pencil: { mode: 'poly' as DrawMode, color: undefined as string | undefined },
  label: { size: 300 }
}

/** スナップ種別の有効 / 無効(ステータスバーのガイド設定から変更) */
export const SNAP_KINDS = ['端点', '中点', '中心', '図心', '交点', '仮想交点', '延長', '線上'] as const

interface ComponentDef { name: string; entities: Entity[] }

export class ToolManager {
  tool: ToolName = 'select'
  onToolChange: (t: ToolName) => void = () => {}
  onSelectionChange: () => void = () => {}
  setHint: (s: string) => void = () => {}
  snapStep = 455
  placingComponent: ComponentDef | null = null

  private cursor: Pt = pt(0, 0)        // スナップ後のワールド座標
  private rawCursor: Pt = pt(0, 0)
  private rot = 0                       // 配置系ツールの回転
  private wallStart: Pt | null = null
  /** 円弧壁: 2点目(終点)。3点目のクリックで弧を確定 */
  private arcEnd: Pt | null = null
  /** 直近に配置した階段(ドラッグで向き・長さを調整) */
  private stairAdjust: string | null = null
  private dimPts: Pt[] = []
  private roomPts: Pt[] = []
  /** 長方形モード(部屋・鉛筆)の始点 */
  private rectStart: Pt | null = null
  /** 鉛筆ツールの現在ストロークの点列(末尾 = 直前の点) */
  private penPts: Pt[] = []
  /** 鉛筆ストロークの追記先スケッチ id */
  private penTarget: string | null = null
  /** 物理数値キーボードの寸法入力バッファ(Enter で確定) */
  private numBuf = ''
  /** カーソル上のモード切替アイコン(鉛筆 / 長方形)のヒット領域(ワールド座標) */
  private modeIcons: { c: Pt; r: number; mode: DrawMode }[] = []
  /** 基準点複写: 基準点の選択待ち */
  private dupAwaitBase = false
  /** 基準点複写: 選択した基準点(ガイド表示用) */
  private dupFrom: Pt | null = null
  /** スナップ種別の有効/無効 */
  snapEnabled: Record<string, boolean> = Object.fromEntries(SNAP_KINDS.map(k => [k, true]))
  private dragging = false
  private dragStart: Pt = pt(0, 0)
  private dragOrig: Map<string, Entity> = new Map()
  private marquee: { start: Pt; cur: Pt; additive: boolean } | null = null
  /** 直近のスナップ種別(視覚フィードバック用): 端点・中点・中心・図心・交点・仮想交点・延長・グリッド */
  private snapKind: string | null = null
  /** 延長・仮想交点のガイド線(セグメント端 → スナップ点) */
  private snapGuides: { a: Pt; b: Pt }[] = []
  /** CAD スナップ候補のキャッシュ(モデル変更時に再構築) */
  private snapCache: { p: Pt; kind: string; wallId?: string; ref?: DimAnchor }[] = []
  private snapDirty = true
  /** 直近のスナップが指した従属先(寸法線のアンカー用) */
  private lastSnapRef: DimAnchor | null = null
  /** 寸法作図中の各点のアンカー */
  private dimRefs: (DimAnchor | null)[] = []
  /** 磁石吸着した接触面(緑ガイド表示用) */
  private lastMagnet: { wall: Wall; side: 1 | -1 } | null = null
  /** 変形ハンドル(壁端点・部屋頂点・家具の角など)のドラッグ中 */
  private handleDrag: { entId: string; key: string } | null = null
  /** 複数選択のメンバー再クリック: 動かさなければ単体に絞る */
  private drillPending: string | null = null
  /** スケッチ再クリック: 動かさなければ up で選択サイクルを進める */
  private sketchCyclePend: { ent: SketchE; p: Pt } | null = null
  /** 建具配置時の反転状態(R / F で切替) */
  placeFlip = false
  placeSwap = false
  /** 部屋・文字のダブルクリック編集 */
  onRename: (e: Entity) => void = () => {}

  // 3D ビューのゴーストプレビュー用に内部状態を公開
  get placeRot(): number { return this.rot }
  get wallStartPt(): Pt | null { return this.wallStart }
  get roomPoints(): Pt[] { return this.roomPts }
  get dimPoints(): Pt[] { return this.dimPts }
  get pencilPoints(): Pt[] { return this.penPts }
  get rectStartPt(): Pt | null { return this.rectStart }
  /** 3D ビューなど外部から使うスナップ(結果の点 + 種別 + ガイド線) */
  snapInfo(p: Pt): { p: Pt; kind: string | null; guides: { a: Pt; b: Pt }[] } {
    const sp = this.snapPoint(p)
    return { p: sp, kind: this.snapKind, guides: [...this.snapGuides] }
  }
  /** 3D ビューのカーソル位置を共有(数値入力の方向決定に使う) */
  setCursorHint(p: Pt): void { this.cursor = p }
  /** 数値入力バッファ(3D 側での表示用) */
  get numBuffer(): string { return this.numBuf }
  private panning = false
  private panStart: Pt = pt(0, 0)
  private panView: Pt = pt(0, 0)
  private spaceDown = false

  constructor(public store: Store, public r: Renderer2D, public canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', e => this.down(e))
    canvas.addEventListener('pointermove', e => this.move(e))
    canvas.addEventListener('pointerup', e => this.up(e))
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false })
    canvas.addEventListener('dblclick', () => this.dblclick())
    canvas.addEventListener('contextmenu', e => {
      e.preventDefault()
      if (this.panMoved) return // 右ドラッグでパンした時はキャンセルしない
      // 複写(基準点待ち・配置中)の右クリックはキャンセルして選択ツールへ
      if (this.dupAwaitBase || this.tool === 'component') {
        this.cancel()
        this.setTool('select')
        return
      }
      this.cancel()
    })
    r.overlay = (ctx, zoom) => this.drawOverlay(ctx, zoom)
    store.onChange(() => {
      this.snapDirty = true
      this.applyConstraints() // 取り付け・寸法アンカーの追従(emit はしない)
    })
  }

  /**
   * 拘束の追従:
   * - 壁に取り付いた家具等は、壁の厚みが変わっても面にピッタリ付いたまま
   * - スナップ点に従属した寸法線の端点は、対象の変形にリアルタイム追従
   */
  private applying = false
  private applyConstraints(): void {
    if (this.applying) return
    this.applying = true
    for (const e of this.store.doc.entities) {
      if ((e.type === 'furniture' || e.type === 'column' || e.type === 'custom' ||
        e.type === 'equipment' || e.type === 'stair') && e.attach) {
        const w = this.store.byId(e.attach.wallId)
        if (w?.type !== 'wall') { e.attach = undefined; continue }
        const dW = norm(sub(w.b, w.a)), n = perp(dW)
        const corners = this.cornersOf(e)
        if (!corners) continue
        const ss = corners.map(c => (c.x - w.a.x) * n.x + (c.y - w.a.y) * n.y)
        const h = w.thickness / 2
        // 取り付き側の面に最寄りのエッジをピッタリ合わせる
        const shift = e.attach.side === 1 ? h - Math.min(...ss) : -h - Math.max(...ss)
        if (Math.abs(shift) > 0.1 && Math.abs(shift) < 500) {
          e.pos = add(e.pos, pt(n.x * shift, n.y * shift))
        }
      } else if (e.type === 'dimension') {
        const pa = e.anchorA ? this.resolveAnchor(e.anchorA) : null
        const pb = e.anchorB ? this.resolveAnchor(e.anchorB) : null
        if (e.anchorA && !pa) e.anchorA = undefined
        if (e.anchorB && !pb) e.anchorB = undefined
        if (pa) e.a = pa
        if (pb) e.b = pb
      }
    }
    this.applying = false
  }
  private resolveAnchor(a: DimAnchor): Pt | null {
    const e = this.store.byId(a.entId)
    if (!e) return null
    if (e.type === 'wall' && a.kind === 'wall' && a.t !== undefined) return lerp(e.a, e.b, a.t)
    if (e.type === 'room') {
      if (a.kind === 'roomV' && a.vi !== undefined) return e.poly[a.vi] ? { ...e.poly[a.vi] } : null
      if (a.kind === 'roomC') return polyCentroid(e.poly)
    }
    if (a.kind === 'center' && 'pos' in e) return { ...(e as { pos: Pt }).pos }
    return null
  }

  /** CAD スナップ候補(端点・中点・中心・図心・交点・仮想交点)を収集 */
  private buildSnapCache(): void {
    this.snapDirty = false
    const out: { p: Pt; kind: string; wallId?: string; ref?: DimAnchor }[] = []
    const ents = this.store.doc.entities
    const walls: Wall[] = []
    for (const e of ents) {
      if (e.type === 'wall') {
        walls.push(e)
        out.push({ p: e.a, kind: '端点', wallId: e.id, ref: { entId: e.id, kind: 'wall', t: 0 } })
        out.push({ p: e.b, kind: '端点', wallId: e.id, ref: { entId: e.id, kind: 'wall', t: 1 } })
        out.push({ p: lerp(e.a, e.b, 0.5), kind: '中点', wallId: e.id, ref: { entId: e.id, kind: 'wall', t: 0.5 } })
      } else if (e.type === 'room') {
        for (let i = 0; i < e.poly.length; i++) {
          out.push({ p: e.poly[i], kind: '端点', ref: { entId: e.id, kind: 'roomV', vi: i } })
          out.push({ p: lerp(e.poly[i], e.poly[(i + 1) % e.poly.length], 0.5), kind: '中点' })
        }
        out.push({ p: polyCentroid(e.poly), kind: '図心', ref: { entId: e.id, kind: 'roomC' } })
      } else if (e.type === 'dimension') {
        out.push({ p: e.a, kind: '端点' }, { p: e.b, kind: '端点' })
      } else if (e.type === 'sketch') {
        for (const ed of e.edges) {
          out.push({ p: ed.a, kind: '端点' }, { p: ed.b, kind: '端点' })
          out.push({ p: lerp(ed.a, ed.b, 0.5), kind: '中点' })
        }
      } else if ('pos' in e && (e.type === 'furniture' || e.type === 'column' || e.type === 'custom' ||
        e.type === 'equipment' || e.type === 'planting' || e.type === 'stair')) {
        out.push({ p: (e as { pos: Pt }).pos, kind: '中心', ref: { entId: e.id, kind: 'center' } })
      }
    }
    // 壁の中心線同士の交点・仮想交点(延長線上の交わり)
    const EXT = 3000 // 仮想交点を探す延長距離 mm
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const A = walls[i], B = walls[j]
        const dA = norm(sub(A.b, A.a)), dB = norm(sub(B.b, B.a))
        const X = lineIntersect(A.a, dA, B.a, dB)
        if (!X) continue
        const LA = dist(A.a, A.b), LB = dist(B.a, B.b)
        const tA = (X.x - A.a.x) * dA.x + (X.y - A.a.y) * dA.y
        const tB = (X.x - B.a.x) * dB.x + (X.y - B.a.y) * dB.y
        const inA = tA >= -1 && tA <= LA + 1
        const inB = tB >= -1 && tB <= LB + 1
        // 端点同士の接合(既に端点スナップ対象)は除外
        const nearEnd = Math.min(dist(X, A.a), dist(X, A.b), dist(X, B.a), dist(X, B.b)) < 10
        if (inA && inB) {
          if (!nearEnd) out.push({ p: X, kind: '交点' })
        } else if (tA >= -EXT && tA <= LA + EXT && tB >= -EXT && tB <= LB + EXT) {
          out.push({ p: X, kind: '仮想交点' })
        }
      }
    }
    this.snapCache = out
  }

  setTool(t: ToolName): void {
    this.tool = t
    this.wallStart = null; this.dimPts = []; this.roomPts = []
    this.rectStart = null; this.penPts = []; this.penTarget = null; this.numBuf = ''
    if (t !== 'component') { this.placingComponent = null; this.dupFrom = null; this.dupAwaitBase = false }
    this.setSketchSub(null)
    this.sketchLocked = false
    this.onToolChange(t)
    this.updateHint()
    this.updateCursor()
    this.r.requestDraw()
  }

  private updateHint(): void {
    const hints: Record<ToolName, string> = {
      select: 'クリック: 面→閉路→全体(以降ロック)。閉路中は辺クリックでその辺だけ / Space+ドラッグ: 視点移動 / Delete: 削除 / R: 回転',
      wall: 'クリックで始点→終点(連続入力) / ツール設定の「円弧壁」で 3点目=通過点の弧 / Shift: 直交 / 右クリック: 終了',
      column: 'クリックで柱を配置 / R: 90°回転',
      door: '壁の上でクリックしてドアを配置 / R・F: 内外反転 / G: 吊元切替',
      window: '壁の上でクリックして窓を配置 / R・F: 反転',
      stair: 'クリック+そのままドラッグで向き・長さを調整 / Tab: 形状切替 / R: 90°回転',
      furniture: 'クリックで家具を配置 / R: 90°回転',
      equipment: 'クリックで設備を配置 / R: 90°回転',
      planting: 'クリックで植栽・人物を配置',
      dimension: '2点をクリック→3点目で寸法線の位置を決定',
      label: 'クリックで文字を配置(プロパティで編集)',
      room: params.room.mode === 'rect'
        ? '2点クリックで長方形の部屋 / 数値入力+Enter で寸法指定(幅,奥行) / Tab またはカーソル上のアイコンでモード切替'
        : '頂点を順にクリック / ダブルクリックまたは始点クリックで閉じる / Tab: 長方形モード',
      pencil: params.pencil.mode === 'rect'
        ? '2点クリックで長方形を描く / 数値入力+Enter で寸法指定(幅,奥行) / Tab: 鉛筆モード'
        : 'クリックで線を描く(閉じると面になる) / 数値入力+Enter で長さ指定 / 右クリックで終了 / Tab: 長方形モード',
      component: 'クリックでコンポーネントを配置 / R: 90°回転'
    }
    if (this.r.elevation) {
      const elevHints: Partial<Record<ToolName, string>> = {
        select: 'クリック: 選択 / ドラッグ: 移動 / 壁の上端をドラッグ: 高さ変更 / 窓は上下ドラッグで窓台高',
        wall: 'クリックで始点→終点(建物の手前の面に配置されます)',
        door: '壁の上でクリックしてドアを配置',
        window: '壁の上でクリックして窓を配置(クリックした高さ = 窓台高)'
      }
      this.setHint(elevHints[this.tool] ?? 'このツールは立面図では使えません(選択・壁・ドア・窓が使えます)')
      return
    }
    this.setHint(hints[this.tool])
  }

  // ---------- 座標・スナップ ----------
  private eventPt(e: PointerEvent | WheelEvent): Pt {
    const rect = this.canvas.getBoundingClientRect()
    return this.r.vp.toWorld(pt(e.clientX - rect.left, e.clientY - rect.top))
  }
  /** 延長スナップの対象セグメント(壁の中心線 + 部屋の辺 + スケッチの辺) */
  private extSegments(excludeWallId?: string): { a: Pt; b: Pt }[] {
    const out: { a: Pt; b: Pt }[] = []
    for (const e of this.store.doc.entities) {
      if (e.hidden) continue
      if (e.type === 'wall' && e.id !== excludeWallId) out.push({ a: e.a, b: e.b })
      else if (e.type === 'room') {
        for (let i = 0; i < e.poly.length; i++) out.push({ a: e.poly[i], b: e.poly[(i + 1) % e.poly.length] })
      } else if (e.type === 'sketch') {
        for (const ed of e.edges) out.push({ a: ed.a, b: ed.b })
      }
    }
    return out
  }

  private snapPoint(p: Pt, excludeWallId?: string): Pt {
    if (this.snapDirty) this.buildSnapCache()
    const tol = 12 / this.r.vp.zoom
    this.snapGuides = []
    // 優先度順に候補を探す(CAD 流)
    this.lastSnapRef = null
    const PRIORITY = ['端点', '交点', '中点', '中心', '図心', '仮想交点'].filter(k => this.snapEnabled[k])
    for (const kind of PRIORITY) {
      let best: { p: Pt; wallId?: string; ref?: DimAnchor } | null = null
      let bd = tol
      for (const c of this.snapCache) {
        if (c.kind !== kind) continue
        if (excludeWallId && c.wallId === excludeWallId) continue
        const dd = dist(p, c.p)
        if (dd < bd) { bd = dd; best = c }
      }
      if (best) {
        this.snapKind = kind
        this.lastSnapRef = best.ref ?? null
        if (kind === '仮想交点') {
          // ガイド: 近い壁の端点からスナップ点まで
          for (const w of this.store.walls()) {
            for (const q of [w.a, w.b]) {
              if (dist(q, best.p) < 3200 && dist(q, best.p) > 10 &&
                distToSeg(best.p, w.a, w.b) < 20 + dist(q, best.p)) {
                const dW = norm(sub(w.b, w.a))
                const along = Math.abs((best.p.x - q.x) * dW.x + (best.p.y - q.y) * dW.y)
                if (Math.abs(along - dist(q, best.p)) < 5) this.snapGuides.push({ a: q, b: best.p })
              }
            }
          }
        }
        return { ...best.p }
      }
    }
    // 延長: 壁・部屋・スケッチ辺の延長線上(端から 3000mm 以内)。
    // グリッドの角点で一旦止まる(延長方向に沿ってグリッドへ吸着)
    if (this.snapEnabled['延長']) {
      let bestExt: { p: Pt; from: Pt; d: Pt } | null = null
      let bd = tol
      for (const s of this.extSegments(excludeWallId)) {
        const dW = norm(sub(s.b, s.a))
        const L = dist(s.a, s.b)
        if (L < 1) continue
        const t = (p.x - s.a.x) * dW.x + (p.y - s.a.y) * dW.y
        if (t >= -1 && t <= L + 1) continue // セグメント内は対象外
        if (t < -3000 || t > L + 3000) continue
        const foot = pt(s.a.x + dW.x * t, s.a.y + dW.y * t)
        const dd = dist(p, foot)
        if (dd < bd) { bd = dd; bestExt = { p: foot, from: t < 0 ? s.a : s.b, d: dW } }
      }
      if (bestExt) {
        // 延長線に沿ってグリッド角点へ吸着(軸平行なら座標を、斜めは距離を丸める)
        let foot = bestExt.p
        if (this.snapStep > 0) {
          if (Math.abs(bestExt.d.x) > 0.999) foot = pt(snapTo(foot.x, this.snapStep), foot.y)
          else if (Math.abs(bestExt.d.y) > 0.999) foot = pt(foot.x, snapTo(foot.y, this.snapStep))
          else {
            const along = (foot.x - bestExt.from.x) * bestExt.d.x + (foot.y - bestExt.from.y) * bestExt.d.y
            const sn = snapTo(along, this.snapStep)
            foot = pt(bestExt.from.x + bestExt.d.x * sn, bestExt.from.y + bestExt.d.y * sn)
          }
        }
        this.snapKind = '延長'
        this.snapGuides = [{ a: bestExt.from, b: foot }]
        return { ...foot }
      }
    }
    // 線上: スケッチ辺の上の任意の点(辺の途中から線を引ける)
    if (this.snapEnabled['線上']) {
      for (const e of this.store.doc.entities) {
        if (e.type !== 'sketch' || e.hidden) continue
        for (const ed of e.edges) {
          if (distToSeg(p, ed.a, ed.b) < tol) {
            this.snapKind = '線上'
            return lerp(ed.a, ed.b, projT(p, ed.a, ed.b))
          }
        }
      }
    }
    // 鉛筆: 始点から 1 辺目と垂直方向の延長ガイド(3 辺目で長方形を閉じやすく)
    if (this.tool === 'pencil' && params.pencil.mode === 'poly' && this.penPts.length >= 2) {
      const g = strokePerpGuide(this.penPts, p, tol * 1.5)
      if (g) {
        this.snapKind = '垂直'
        this.snapGuides.push(g.guide)
        return g.p
      }
    }
    this.snapKind = this.snapStep > 0 ? 'グリッド' : null
    return pt(snapTo(p.x, this.snapStep), snapTo(p.y, this.snapStep))
  }
  private nearestWall(p: Pt): { wall: Wall; t: number } | null {
    let best: { wall: Wall; t: number } | null = null
    let bd = Math.max(200, 14 / this.r.vp.zoom)
    for (const w of this.store.walls()) {
      const d = distToSeg(p, w.a, w.b)
      if (d < bd + w.thickness / 2) { bd = d; best = { wall: w, t: projT(p, w.a, w.b) } }
    }
    return best
  }

  // ---------- ヒットテスト ----------
  hitTest(p: Pt): Entity | null {
    const ents = this.store.doc.entities.filter(e => !e.hidden)
    const walls = new Map<string, Wall>()
    for (const e of ents) if (e.type === 'wall') walls.set(e.id, e)
    const tol = 10 / this.r.vp.zoom
    // 優先度: 小物 → スケッチの辺 → 壁 → 部屋 → スケッチの面
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i]
      if (e.type === 'opening') {
        const wl = walls.get(e.wallId); if (!wl) continue
        const c = lerp(wl.a, wl.b, e.t)
        if (dist(p, c) < e.width / 2 + tol) return e
      } else if (e.type === 'furniture' || e.type === 'equipment' || e.type === 'planting' || e.type === 'stair' || e.type === 'label' || e.type === 'column' || e.type === 'custom') {
        const b = this.r.entityBounds(e, walls)
        if (b && p.x >= b.min.x - tol && p.x <= b.max.x + tol && p.y >= b.min.y - tol && p.y <= b.max.y + tol) return e
      } else if (e.type === 'dimension') {
        const n = perp(norm(sub(e.b, e.a)))
        const a2 = add(e.a, { x: n.x * e.offset, y: n.y * e.offset })
        const b2 = add(e.b, { x: n.x * e.offset, y: n.y * e.offset })
        if (distToSeg(p, a2, b2) < tol * 2) return e
      }
    }
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i]
      if (e.type === 'sketch' && e.edges.some(ed => distToSeg(p, ed.a, ed.b) < tol * 1.5)) return e
    }
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i]
      if (e.type === 'wall' && distToSeg(p, e.a, e.b) < e.thickness / 2 + tol) return e
    }
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i]
      if (e.type === 'room' && pointInPoly(p, e.poly)) return e
    }
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i]
      if (e.type === 'sketch' && sketchFaces(e).some(f => pointInPoly(p, f))) return e
    }
    return null
  }

  // ---------- スケッチ(鉛筆)のサブ選択: クリック回数で 全体→面→閉路→辺 ----------
  private setSketchSub(sub: { id: string; mode: 'face' | 'loop' | 'edge'; faceIdx?: number; edgeIdx?: number } | null): void {
    this.r.sketchSub = sub
    this.onSketchSub(sub)
  }
  /** サブ選択の変化(消しゴムボタンの表示切替などに使う) */
  onSketchSub: (sub: { id: string; mode: 'face' | 'loop' | 'edge'; faceIdx?: number; edgeIdx?: number } | null) => void = () => {}
  get sketchSub(): { id: string; mode: 'face' | 'loop' | 'edge'; faceIdx?: number; edgeIdx?: number } | null {
    return this.r.sketchSub
  }
  /** 全体選択のロック(4 回目以降のクリックで選択が切り替わらない) */
  private sketchLocked = false
  private faceIdxAt(e: SketchE, p: Pt): number {
    // クリック位置を含む最小の面(入れ子は内側を優先)
    const faces = sketchFaces(e)
    let best = -1, bestArea = Infinity
    faces.forEach((f, i) => {
      if (!pointInPoly(p, f)) return
      const a = Math.abs(polyArea(f))
      if (a < bestArea) { bestArea = a; best = i }
    })
    return best
  }
  private edgeIdxAt(e: SketchE, p: Pt): number {
    let best = -1, bd = 20 / this.r.vp.zoom + 40
    e.edges.forEach((ed, i) => {
      const d = distToSeg(p, ed.a, ed.b)
      if (d < bd) { bd = d; best = i }
    })
    return best
  }
  /** 初回選択: 1 回目のクリックで「面」を選択(面がなければ辺 → 全体) */
  private initialSketchSub(e: SketchE, p: Pt): void {
    this.sketchLocked = false
    const fi = this.faceIdxAt(e, p)
    if (fi >= 0) { this.setSketchSub({ id: e.id, mode: 'face', faceIdx: fi }); return }
    const ei = this.edgeIdxAt(e, p)
    if (ei >= 0) this.setSketchSub({ id: e.id, mode: 'edge', edgeIdx: ei })
    else this.setSketchSub(null)
  }
  /** 再クリック(静止時)のサイクル: 面 → 閉路の辺 → 全体 → ロック。
   *  閉路選択中に辺の上でクリックするとその辺だけを選択 */
  private cycleSketchSub(e: SketchE, p: Pt): void {
    if (this.sketchLocked) return
    const cur = this.r.sketchSub?.id === e.id ? this.r.sketchSub : null
    if (!cur) { this.initialSketchSub(e, p); this.r.requestDraw(); return }
    if (cur.mode === 'face') {
      this.setSketchSub({ id: e.id, mode: 'loop', faceIdx: cur.faceIdx })
    } else if (cur.mode === 'loop') {
      const ei = this.edgeIdxAt(e, p)
      if (ei >= 0) this.setSketchSub({ id: e.id, mode: 'edge', edgeIdx: ei })
      else { this.setSketchSub(null); this.sketchLocked = true } // 全体(以降ロック)
    } else {
      this.setSketchSub(null)
      this.sketchLocked = true
    }
    this.r.requestDraw()
  }
  /** 選択中の面(または内側の立体)を削除 = 貫通穴にする(消しゴムアイコン) */
  eraseSelectedFace(): void {
    const sub = this.r.sketchSub
    if (!sub || sub.faceIdx === undefined) return
    const e = this.store.byId(sub.id)
    if (e?.type !== 'sketch') return
    const faces = sketchFaces(e)
    const f = faces[sub.faceIdx]
    if (!f) return
    this.store.commit()
    e.faces ??= {}
    const info = faceInfo(e, f)
    e.faces[faceKey(f)] = { ...info, dead: true, h: undefined }
    this.setSketchSub(null)
    this.store.emit()
  }
  /** 選択中の面の押し出し高さを設定(プロパティ・3D の円錐つまみから) */
  setFaceHeight(id: string, poly: Pt[], h: number): void {
    const e = this.store.byId(id)
    if (e?.type !== 'sketch') return
    e.faces ??= {}
    const info = faceInfo(e, poly)
    e.faces[faceKey(poly)] = { ...info, h: h > 0 ? h : undefined, dead: false }
  }

  // ---------- ポインタイベント ----------
  private panMoved = false
  private down(e: PointerEvent): void {
    try { this.canvas.setPointerCapture(e.pointerId) } catch { /* 合成イベント等では不可 */ }
    const p = this.eventPt(e)
    // 中ボタン / 右ボタン / Space+左 でパン(視点移動)
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      this.panning = true
      this.panMoved = false
      this.panStart = pt(e.clientX, e.clientY)
      this.panView = { ...this.r.vp.view }
      return
    }
    if (e.button !== 0) return
    if (this.r.elevation) { this.elevDown(p); return } // 立面図: 選択・ドラッグ編集
    // カーソル上のモード切替アイコン(鉛筆 / 長方形)のクリック
    if ((this.tool === 'room' || this.tool === 'pencil') && !this.rectStart && !this.penPts.length && !this.roomPts.length) {
      for (const ic of this.modeIcons) {
        if (dist(p, ic.c) < ic.r) {
          const pr = this.tool === 'room' ? params.room : params.pencil
          pr.mode = ic.mode
          this.updateHint()
          this.onToolChange(this.tool) // ツール設定パネルを更新
          this.r.requestDraw()
          return
        }
      }
    }
    // 基準点複写: 最初のクリック = コピーの基準点
    if (this.dupAwaitBase) {
      this.pickDupBase(p)
      return
    }
    const sp = this.snapPoint(p)

    switch (this.tool) {
      case 'select': {
        // 選択中の要素の変形ハンドルを掴んだらドラッグ開始
        const hTol = 10 / this.r.vp.zoom
        for (const id of this.r.selection) {
          const ent = this.store.byId(id)
          if (!ent) continue
          for (const h of this.handlesFor(ent)) {
            if (dist(p, h.pos) < hTol) {
              this.store.commit()
              this.handleDrag = { entId: id, key: h.key }
              this.canvas.style.cursor = 'grabbing'
              return
            }
          }
        }
        const hit = this.hitTest(p)
        if (hit) {
          if (!this.r.selection.has(hit.id)) {
            if (!e.shiftKey) this.r.selection.clear()
            this.r.selection.add(hit.id)
            // スケッチは 1 回目のクリックで「面」を選択
            if (hit.type === 'sketch' && !e.shiftKey) this.initialSketchSub(hit, p)
            else { this.setSketchSub(null); this.sketchLocked = false }
            this.store.expandGroups(this.r.selection) // グループはまとめて選択
          } else if (e.shiftKey) {
            this.r.selection.delete(hit.id)
          } else if (this.r.selection.size === 1 && hit.type === 'sketch') {
            // スケッチの再クリック: 動かさなければ up で 面 → 閉路 → 全体 → ロック と進める
            this.sketchCyclePend = { ent: hit, p }
          } else if (this.r.selection.size > 1) {
            // 複数選択のメンバー再クリック: ドラッグ=全体移動 / クリックだけなら単体に絞る(up で判定)
            this.drillPending = hit.id
          }
          this.dragging = true
          this.dragStart = p
          this.dragOrig = new Map()
          for (const id of this.r.selection) {
            const ent = this.store.byId(id)
            if (ent) this.dragOrig.set(id, JSON.parse(JSON.stringify(ent)))
          }
          this.store.commit()
        } else {
          // 何もない場所からのドラッグ → 範囲選択(Shift で追加選択)
          if (!e.shiftKey) { this.r.selection.clear(); this.setSketchSub(null); this.sketchLocked = false }
          this.marquee = { start: p, cur: p, additive: e.shiftKey }
        }
        this.onSelectionChange()
        this.r.requestDraw()
        break
      }
      case 'wall': case 'door': case 'window': case 'stair': case 'column':
      case 'furniture': case 'equipment': case 'planting': case 'label': case 'component':
      case 'dimension': case 'room': case 'pencil':
        this.placeAt(p, { shift: e.shiftKey })
        break
    }
    this.r.requestDraw()
  }

  private move(e: PointerEvent): void {
    const p = this.eventPt(e)
    this.rawCursor = p
    if (this.panning) {
      const z = this.r.vp.zoom
      if (Math.abs(e.clientX - this.panStart.x) + Math.abs(e.clientY - this.panStart.y) > 3) this.panMoved = true
      this.r.vp.view = {
        x: this.panView.x - (e.clientX - this.panStart.x) / z,
        y: this.panView.y - (e.clientY - this.panStart.y) / z
      }
      this.r.requestDraw()
      return
    }
    // 立面図: ドラッグ編集 + スナップカーソル・建具ゴーストの更新
    if (this.r.elevation) {
      if (this.elevDrag && (e.buttons & 1)) {
        this.elevMove(p)
        this.r.requestDraw()
        return
      }
      this.elevCursor = this.elevSnap(p)
      this.elevHover = null
      if (this.tool === 'door' || this.tool === 'window') {
        this.elevHover = [...this.r.elevWalls()].reverse().find(w =>
          w.facing && this.elevCursor.x >= w.ua && this.elevCursor.x <= w.ub &&
          this.elevCursor.y >= w.y1 && this.elevCursor.y <= w.y0) ?? null
      }
      this.r.requestDraw()
      this.onCursor(this.elevCursor)
      return
    }
    this.cursor = this.snapPoint(p)
    if (this.tool === 'wall' && this.wallStart && e.shiftKey) this.cursor = this.ortho(this.wallStart, this.cursor)
    // 基準点複写: 基準点からの水平・垂直・45°(対角)へ吸着
    if (this.tool === 'component' && this.dupFrom && this.snapKind === 'グリッド') {
      const v = sub(this.cursor, this.dupFrom)
      const L = Math.hypot(v.x, v.y)
      if (L > 1) {
        const deg = (Math.atan2(v.y, v.x) * 180) / Math.PI
        const snapped = angleDetentDeg(deg, 4)
        if (snapped !== deg) {
          const rad = (snapped * Math.PI) / 180
          this.cursor = add(this.dupFrom, pt(Math.cos(rad) * L, Math.sin(rad) * L))
        }
      }
    }

    // 変形つまみの上では OS の「つかむ手」カーソル
    if (this.tool === 'select' && !this.dragging && !this.handleDrag && !this.marquee && !this.spaceDown) {
      const hTol = 10 / this.r.vp.zoom
      let over = false
      for (const id of this.r.selection) {
        const ent = this.store.byId(id)
        if (!ent) continue
        if (this.handlesFor(ent).some(hh => dist(p, hh.pos) < hTol)) { over = true; break }
      }
      this.canvas.style.cursor = over ? 'grab' : ''
      // 閉路選択中: ホバーした辺を強調(クリックでその辺だけを選択)
      const sub = this.r.sketchSub
      let hover: { id: string; edgeIdx: number } | null = null
      if (sub?.mode === 'loop') {
        const ent = this.store.byId(sub.id)
        if (ent?.type === 'sketch') {
          const ei = this.edgeIdxAt(ent, p)
          if (ei >= 0) hover = { id: ent.id, edgeIdx: ei }
        }
      }
      if (JSON.stringify(hover) !== JSON.stringify(this.r.sketchHover)) {
        this.r.sketchHover = hover
        this.r.requestDraw()
      }
    }

    if (this.handleDrag) {
      const ent = this.store.byId(this.handleDrag.entId)
      if (ent) {
        const h = this.handlesFor(ent).find(x => x.key === this.handleDrag!.key)
        if (h) {
          let q = h.raw ? p : this.snapPoint(p, ent.type === 'wall' ? ent.id : undefined)
          if (e.shiftKey && ent.type === 'wall') {
            q = this.ortho(ent[this.handleDrag.key === 'a' ? 'b' : 'a'], q)
          }
          h.apply(q)
          this.store.emit()
          this.onSelectionChange()
        }
      }
      this.r.requestDraw()
      return
    }
    if (this.marquee) {
      this.marquee.cur = p
      this.r.requestDraw()
      return
    }
    if (this.stairAdjust && (e.buttons & 1)) {
      const st = this.store.byId(this.stairAdjust)
      if (st?.type === 'stair') {
        const vec = sub(p, st.pos)
        const len = Math.hypot(vec.x, vec.y)
        if (len > 300) {
          st.rot = Math.round(Math.atan2(vec.y, vec.x) / (Math.PI / 12)) * (Math.PI / 12) // 15°刻み
          if (st.kind === 'straight') {
            st.treads = Math.min(30, Math.max(3, Math.round(len / st.tread)))
          }
          this.store.emit()
        }
      }
      this.r.requestDraw()
      return
    }
    if (this.dragging && this.tool === 'select') {
      const d = sub(p, this.dragStart)
      if (Math.abs(d.x) + Math.abs(d.y) > 3 / this.r.vp.zoom) {
        this.drillPending = null
        this.sketchCyclePend = null // 移動中は選択を切り替えない
      }
      const sd = pt(snapTo(d.x, this.snapStep), snapTo(d.y, this.snapStep))
      for (const [id, orig] of this.dragOrig) {
        const ent = this.store.byId(id)
        if (!ent) continue
        this.applyMove(ent, orig, sd, p)
      }
      this.store.emit()
      this.onSelectionChange()
    }
    this.r.requestDraw()
    this.onCursor(this.cursor)
  }
  onCursor: (p: Pt) => void = () => {}

  private applyMove(ent: Entity, orig: Entity, d: Pt, raw: Pt): void {
    if (ent.type === 'wall' && orig.type === 'wall') {
      ent.a = add(orig.a, d); ent.b = add(orig.b, d)
    } else if (ent.type === 'opening' && orig.type === 'opening') {
      const wl = this.store.byId(ent.wallId) as Wall | undefined
      if (!wl) return
      if (this.dragOrig.has(ent.wallId)) {
        // 親の壁ごと移動している → 壁に対する相対位置は変えない
        ent.t = orig.t
      } else if (this.dragOrig.size > 1) {
        // 複数同時移動: 壁方向の移動量ぶんだけスライド
        const dW = norm(sub(wl.b, wl.a))
        const L = Math.max(1, dist(wl.a, wl.b))
        const half = Math.min(0.5, ent.width / (2 * L))
        const dt = (d.x * dW.x + d.y * dW.y) / L
        ent.t = Math.min(Math.max(orig.t + dt, half), 1 - half)
      } else {
        // 単体: カーソル位置へ(壁の内側にクランプ)
        const L = Math.max(1, dist(wl.a, wl.b))
        const half = Math.min(0.5, ent.width / (2 * L))
        ent.t = Math.min(Math.max(projT(raw, wl.a, wl.b), half), 1 - half)
      }
    } else if (ent.type === 'room' && orig.type === 'room') {
      ent.poly = orig.poly.map(q => add(q, d))
    } else if (ent.type === 'sketch' && orig.type === 'sketch') {
      ent.edges = orig.edges.map(ed => ({ ...ed, a: add(ed.a, d), b: add(ed.b, d) }))
      // 面キー(図心)も一緒に平行移動して押し出し高さを保つ
      if (orig.faces) {
        ent.faces = {}
        for (const [k, v] of Object.entries(orig.faces)) {
          const [x, y] = k.split(':').map(Number)
          ent.faces[`${Math.round(x + d.x)}:${Math.round(y + d.y)}`] = v
        }
      }
    } else if (ent.type === 'dimension' && orig.type === 'dimension') {
      ent.a = add(orig.a, d); ent.b = add(orig.b, d)
      ent.anchorA = undefined; ent.anchorB = undefined // 手動移動で従属を解除
    } else if ('pos' in ent && 'pos' in orig) {
      ent.pos = add((orig as { pos: Pt }).pos, d)
      if ('attach' in ent) ent.attach = undefined
      if (this.dragOrig.size === 1) this.magnetizeEntity(ent) // 単体移動は壁面に吸着(付けば attach 記録)
    }
  }

  private up(e: PointerEvent): void {
    this.panning = false
    this.dragging = false
    this.stairAdjust = null
    this.lastMagnet = null
    this.elevDrag = null
    if (this.drillPending) {
      this.r.selection.clear()
      this.r.selection.add(this.drillPending)
      this.drillPending = null
      this.onSelectionChange()
      this.r.requestDraw()
    }
    if (this.sketchCyclePend) {
      // 静止クリック: 選択サイクルを進める(面 → 閉路 → 全体 → ロック / 閉路中は辺クリックでその辺)
      this.cycleSketchSub(this.sketchCyclePend.ent, this.sketchCyclePend.p)
      this.sketchCyclePend = null
      this.onSelectionChange()
      this.r.requestDraw()
    }
    if (this.handleDrag) this.canvas.style.cursor = ''
    this.handleDrag = null
    if (this.marquee) {
      const { start, cur, additive } = this.marquee
      this.marquee = null
      const minX = Math.min(start.x, cur.x), maxX = Math.max(start.x, cur.x)
      const minY = Math.min(start.y, cur.y), maxY = Math.max(start.y, cur.y)
      // 数 px 以上ドラッグしたときだけ範囲選択として扱う(触れた要素をすべて選択)
      if ((maxX - minX) * this.r.vp.zoom > 4 || (maxY - minY) * this.r.vp.zoom > 4) {
        if (!additive) this.r.selection.clear()
        const walls = new Map<string, Wall>()
        for (const en of this.store.doc.entities) if (en.type === 'wall') walls.set(en.id, en)
        for (const en of this.store.doc.entities) {
          const b = this.r.entityBounds(en, walls)
          if (!b) continue
          if (b.max.x >= minX && b.min.x <= maxX && b.max.y >= minY && b.min.y <= maxY) {
            this.r.selection.add(en.id)
          }
        }
        this.store.expandGroups(this.r.selection)
        this.onSelectionChange()
      }
      this.r.requestDraw()
    }
  }

  private dblclick(): void {
    if (this.tool === 'pencil' && this.penPts.length) { this.penPts = []; this.penTarget = null; this.r.requestDraw(); return }
    if (this.tool === 'room' && this.roomPts.length >= 3) { this.closeRoom(); return }
    if (this.tool === 'select') {
      const hit = this.hitTest(this.rawCursor)
      if (hit && (hit.type === 'room' || hit.type === 'label')) this.onRename(hit)
    }
  }

  private closeRoom(): void {
    this.store.commit()
    this.store.add({ id: uid(), type: 'room', poly: this.roomPts, name: '部屋', use: params.room.use, showArea: true })
    this.roomPts = []
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault()
    const vp = this.r.vp
    // トラックパッドの2本指スクロール(横成分あり)や Shift+ホイールは視点移動、
    // ピンチ(ctrlKey)と通常の縦ホイールはズーム
    const isPan = !e.ctrlKey && !e.metaKey && (e.shiftKey || Math.abs(e.deltaX) > 0.5)
    if (isPan) {
      vp.view = add(vp.view, pt(e.deltaX / vp.zoom, e.deltaY / vp.zoom))
      this.r.requestDraw()
      return
    }
    const rect = this.canvas.getBoundingClientRect()
    const s = pt(e.clientX - rect.left, e.clientY - rect.top)
    const before = vp.toWorld(s)
    vp.zoom *= Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0012))
    vp.zoom = Math.max(0.004, Math.min(3, vp.zoom))
    const after = vp.toWorld(s)
    vp.view = add(vp.view, sub(before, after))
    this.r.requestDraw()
    this.onZoom(vp.zoom)
  }
  onZoom: (z: number) => void = () => {}

  cancel(): void {
    this.wallStart = null; this.arcEnd = null; this.dimPts = []; this.roomPts = []
    this.rectStart = null; this.penPts = []; this.penTarget = null; this.numBuf = ''
    this.dupAwaitBase = false; this.dupFrom = null
    this.elevWallStart = null
    this.updateCursor()
    this.r.requestDraw()
  }
  /** ヒントバーを現在の状態(立面図かどうか等)に合わせて更新 */
  refreshHint(): void { this.updateHint() }

  /**
   * 作図中の Undo(⌘Z): 今引いている線・入力バッファを取り消す。
   * 取り消すものがなければ false(通常の Undo に委ねる)
   */
  undoDraft(): boolean {
    if (this.numBuf) { this.numBuf = ''; this.r.requestDraw(); return true }
    if (this.rectStart) { this.rectStart = null; this.r.requestDraw(); return true }
    if (this.tool === 'wall' && (this.wallStart || this.arcEnd)) {
      this.arcEnd = null; this.wallStart = null
      this.r.requestDraw(); return true
    }
    if (this.tool === 'room' && this.roomPts.length) {
      this.roomPts.pop(); this.r.requestDraw(); return true
    }
    if (this.tool === 'pencil' && this.penPts.length) {
      if (this.penPts.length >= 2) this.store.undo() // 直前の辺を取り消す
      this.penPts.pop()
      if (!this.penPts.length) this.penTarget = null
      this.r.requestDraw(); return true
    }
    if (this.tool === 'dimension' && this.dimPts.length) {
      this.dimPts.pop(); this.dimRefs.pop(); this.r.requestDraw(); return true
    }
    return false
  }

  // ---------- 基準点複写 ----------
  /** 複製アイコン → 基準点の選択待ちへ(カーソルが十字になる) */
  beginDuplicate(): void {
    this.dupAwaitBase = true
    this.canvas.style.cursor = 'crosshair'
    this.setHint('コピーの基準にする点をクリックしてください(端点・交点などに吸着)')
  }
  get awaitingDupBase(): boolean { return this.dupAwaitBase }
  /** 基準点が決まったとき(main 側でコンポーネント化して配置モードへ) */
  onDupBase: (base: Pt) => void = () => {}
  get dupBase(): Pt | null { return this.dupFrom }
  /** 基準点の確定(2D クリック / 3D クリック共通) */
  pickDupBase(p: Pt): void {
    const base = this.snapPoint(p)
    this.dupAwaitBase = false
    this.dupFrom = base
    this.updateCursor()
    this.onDupBase(base)
  }

  /** 鉛筆 ⇄ 長方形のモード切替(2D のカーソルアイコン・3D のアイコン共通) */
  toggleDrawMode(): void {
    if (this.tool !== 'room' && this.tool !== 'pencil') return
    const pr = this.tool === 'room' ? params.room : params.pencil
    pr.mode = pr.mode === 'rect' ? 'poly' : 'rect'
    this.updateHint()
    this.onToolChange(this.tool)
    this.r.requestDraw()
  }

  /** 数値入力バッファ(部屋・鉛筆の寸法指定)を確定 */
  private applyNumBuf(): void {
    const buf = this.numBuf
    this.numBuf = ''
    if (!buf) return
    const nums = buf.split(/[,xX]/).map(s => parseFloat(s)).filter(v => !Number.isNaN(v) && v > 0)
    if (!nums.length) return
    const c = this.cursor
    if (this.rectStart) {
      // 長方形: 「幅,奥行」(1 つなら正方形)。向きは現在のカーソル側
      const w = nums[0], d = nums[1] ?? nums[0]
      const sx = c.x >= this.rectStart.x ? 1 : -1
      const sy = c.y >= this.rectStart.y ? 1 : -1
      const end = pt(this.rectStart.x + w * sx, this.rectStart.y + d * sy)
      this.commitRect(this.rectStart, end)
      this.rectStart = null
    } else if (this.tool === 'pencil' && this.penPts.length) {
      // 鉛筆の線: 長さ指定(現在のカーソル方向へ)
      const last = this.penPts[this.penPts.length - 1]
      const dir = norm(sub(c, last))
      if (dir.x || dir.y) {
        const next = add(last, pt(dir.x * nums[0], dir.y * nums[0]))
        this.addSketchEdge(last, next)
        this.penPts.push(next)
      }
    } else if (this.tool === 'room' && this.roomPts.length) {
      const last = this.roomPts[this.roomPts.length - 1]
      const dir = norm(sub(c, last))
      if (dir.x || dir.y) this.roomPts.push(add(last, pt(dir.x * nums[0], dir.y * nums[0])))
    }
    this.r.requestDraw()
  }

  /** ツール・Space の状態に合わせたカーソル(Space = 手 / 鉛筆 = 鉛筆アイコン) */
  private updateCursor(): void {
    this.canvas.style.cursor = this.spaceDown ? CURSOR_HAND
      : this.tool === 'pencil' ? CURSOR_PENCIL
      : this.dupAwaitBase ? 'crosshair' : ''
  }

  key(e: KeyboardEvent): void {
    if (e.key === ' ') {
      this.spaceDown = e.type === 'keydown'
      this.updateCursor()
      return
    }
    if (e.type !== 'keydown') return
    if (e.key === 'Escape') {
      // Esc: 作図キャンセル + 選択解除 + 選択ツールへ戻る
      this.cancel()
      this.r.selection.clear()
      this.setSketchSub(null)
      this.sketchLocked = false
      this.onSelectionChange()
      if (this.tool !== 'select') this.setTool('select')
      return
    }
    // 数値キーボードで寸法入力(部屋・鉛筆の作図中)
    if ((this.tool === 'room' || this.tool === 'pencil') &&
      (this.rectStart || this.penPts.length || this.roomPts.length)) {
      if (/^[0-9.,]$/.test(e.key) || (e.key.toLowerCase() === 'x' && this.numBuf)) {
        this.numBuf += e.key
        this.r.requestDraw()
        return
      }
      if (e.key === 'Backspace' && this.numBuf) {
        this.numBuf = this.numBuf.slice(0, -1)
        this.r.requestDraw()
        return
      }
      if (e.key === 'Enter' && this.numBuf) {
        this.applyNumBuf()
        return
      }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // スケッチのサブ選択中: 辺だけ / 面だけを削除(辺を消すと面はマージされる)
      const sub = this.r.sketchSub
      if (sub) {
        const ent = this.store.byId(sub.id)
        if (ent?.type === 'sketch') {
          if (sub.mode === 'edge' && sub.edgeIdx !== undefined) {
            this.store.commit()
            ent.edges.splice(sub.edgeIdx, 1)
            if (!ent.edges.length) this.store.remove(new Set([ent.id]))
            this.setSketchSub(null)
            this.store.emit()
            return
          }
          if (sub.faceIdx !== undefined) { this.eraseSelectedFace(); return }
        }
      }
      if (this.r.selection.size) {
        this.store.commit()
        this.store.remove(this.r.selection)
        this.r.selection.clear()
        this.onSelectionChange()
      }
      return
    }
    if (e.key === 'Tab' && (this.tool === 'stair' || this.tool === 'room' || this.tool === 'pencil')) {
      e.preventDefault()
      if (this.tool === 'stair') {
        const kinds: StairKind[] = ['straight', 'l', 'u', 'spiral']
        params.stair.kind = kinds[(kinds.indexOf(params.stair.kind) + 1) % kinds.length]
      } else {
        const pr = this.tool === 'room' ? params.room : params.pencil
        pr.mode = pr.mode === 'rect' ? 'poly' : 'rect'
        this.updateHint()
      }
      this.onToolChange(this.tool) // ツール設定パネルを更新
      this.r.requestDraw()
      return
    }
    const k = e.key.toLowerCase()
    if (k === 'r') { this.rotateSelection(); return }
    if (k === 'f' || k === 'g') {
      // 配置中: プレビューの反転 / 選択中: 建具の反転
      if (!this.r.selection.size && (this.tool === 'door' || this.tool === 'window')) {
        if (k === 'f') this.placeFlip = !this.placeFlip; else this.placeSwap = !this.placeSwap
        this.r.requestDraw()
        return
      }
      for (const id of this.r.selection) {
        const ent = this.store.byId(id)
        if (ent?.type === 'opening') {
          this.store.commit()
          if (k === 'f') ent.flip = !ent.flip; else ent.swap = !ent.swap
          this.store.emit()
        }
      }
      return
    }
    const map: Record<string, ToolName> = {
      v: 'select', w: 'wall', c: 'column', d: 'door', n: 'window', s: 'stair',
      f: 'furniture', e: 'equipment', p: 'planting', m: 'dimension', t: 'label', a: 'room', l: 'pencil'
    }
    if (map[k] && !e.metaKey && !e.ctrlKey) this.setTool(map[k])
  }

  private ortho(a: Pt, b: Pt): Pt {
    return Math.abs(b.x - a.x) > Math.abs(b.y - a.y) ? pt(b.x, a.y) : pt(a.x, b.y)
  }

  /** 3点(始点・終点・通過点)を通る円弧を短い壁のチェーンで生成(グループ化) */
  private buildArcWalls(A: Pt, B: Pt, P: Pt): void {
    const arc = arcThrough(A, B, P)
    this.store.commit()
    if (!arc) {
      // ほぼ一直線 → 普通の壁
      this.store.add({
        id: uid(), type: 'wall', a: A, b: B,
        thickness: params.wall.thickness, height: params.wall.height, structural: params.wall.structural
      })
      return
    }
    const g = uid()
    for (let i = 0; i < arc.length - 1; i++) {
      this.store.doc.entities.push({
        id: uid(), type: 'wall', a: arc[i], b: arc[i + 1],
        thickness: params.wall.thickness, height: params.wall.height, structural: params.wall.structural,
        group: g
      })
    }
    this.store.emit()
  }

  /** 家具・柱・部品の辺を近くの壁面にピッタリ吸着させる(150mm 以内) */
  /** 吸着・取り付け対象のフットプリント角(回転込みワールド座標)。対象外は null */
  private cornersOf(ent: Entity): Pt[] | null {
    if (ent.type === 'furniture' || ent.type === 'column' || ent.type === 'custom') {
      return [-1, 1].flatMap(sx => [-1, 1].map(sy =>
        add(ent.pos, rotate(pt((sx * ent.w) / 2, (sy * ent.d) / 2), ent.rot))))
    }
    if (ent.type === 'equipment') {
      const s = equipSize(ent)
      return [-1, 1].flatMap(sx => [-1, 1].map(sy =>
        add(ent.pos, rotate(pt((sx * s.w) / 2, (sy * s.d) / 2), ent.rot))))
    }
    if (ent.type === 'stair') {
      // ローカル外形(pos は角基準)
      let x0 = 0, y0 = 0, x1 = 0, y1 = 0
      const T = ent.tread, W = ent.width
      if (ent.kind === 'straight') { x1 = ent.treads * T; y1 = W }
      else if (ent.kind === 'l') { const n1 = Math.max(1, Math.floor(ent.treads / 2)); x1 = n1 * T + W; y1 = W + (ent.treads - n1 - 1) * T }
      else if (ent.kind === 'u') { const n1 = Math.max(1, Math.floor((ent.treads - 1) / 2)); x1 = Math.max(n1, ent.treads - 1 - n1) * T + W; y1 = W * 2 }
      else { x0 = -W; y0 = -W; x1 = W; y1 = W }
      return [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)].map(q => add(ent.pos, rotate(q, ent.rot)))
    }
    return null
  }

  magnetizeEntity(ent: Entity): void {
    if (ent.type !== 'furniture' && ent.type !== 'column' && ent.type !== 'custom' &&
      ent.type !== 'equipment' && ent.type !== 'stair') return
    const tol = 250 // 半グリッド(227mm)ずれても届く
    this.lastMagnet = null
    let attached: { wall: Wall; side: 1 | -1 } | null = null
    for (let pass = 0; pass < 2; pass++) { // 直交する2枚の壁に順に吸着できるよう2回
      const corners = this.cornersOf(ent)
      if (!corners) return
      let best: { shift: Pt; gap: number; wall: Wall; side: 1 | -1 } | null = null
      for (const w of this.store.walls()) {
        const dW = norm(sub(w.b, w.a)), n = perp(dW)
        const L = dist(w.a, w.b), h = w.thickness / 2
        const ts = corners.map(c => (c.x - w.a.x) * dW.x + (c.y - w.a.y) * dW.y)
        if (Math.max(...ts) < 0 || Math.min(...ts) > L) continue // 壁の範囲外
        const ss = corners.map(c => (c.x - w.a.x) * n.x + (c.y - w.a.y) * n.y)
        const smin = Math.min(...ss), smax = Math.max(...ss)
        for (const [gap, dir] of [[smin - h, -1], [-h - smax, 1]] as const) {
          // 食い込んでいる場合(グリッドスナップで壁に埋まった場合など、-300mm まで)も面まで押し出す
          if (gap <= -300 || gap >= tol || Math.abs(gap) < 0.5) continue
          if (!best || Math.abs(gap) < best.gap) {
            best = { shift: pt(n.x * gap * dir, n.y * gap * dir), gap: Math.abs(gap), wall: w, side: (dir === -1 ? 1 : -1) as 1 | -1 }
          }
        }
      }
      if (!best) break
      ent.pos = add(ent.pos, best.shift)
      attached = { wall: best.wall, side: best.side }
    }
    if (attached) {
      // 壁への取り付けを記録 → 壁の厚みが変わっても追従する
      ent.attach = { wallId: attached.wall.id, side: attached.side }
      this.lastMagnet = attached
    }
  }
  magnetizeById(id: string): void {
    const ent = this.store.byId(id)
    if (ent) this.magnetizeEntity(ent)
  }

  // ---------- 立面図の編集(選択・水平移動・高さ・建具の位置/窓台高・壁/建具の配置) ----------
  private elevDrag: {
    kind: 'wallU' | 'wallH' | 'open'
    id: string
    startX: number
    floorY: number
    origA?: Pt; origB?: Pt
    /** 建具ドラッグ用: 壁の両端の立面 U 座標 */
    uA?: number; uB?: number
  } | null = null
  /** 立面図のスナップ済みカーソル・ガイド線・建具ツールのホバー先・壁ツールの始点 */
  private elevCursor: Pt = pt(0, 0)
  private elevGuides: { a: Pt; b: Pt }[] = []
  private elevHover: ElevWallProj | null = null
  private elevWallStart: number | null = null

  /** 立面図のスナップ: 壁の端・建具の端の X / 壁の天端・GL の Y に吸着(ガイド線付き)。他はグリッド */
  private elevSnap(p: Pt): Pt {
    this.elevGuides = []
    const tol = 12 / this.r.vp.zoom
    const walls = this.r.elevWalls()
    const opens = this.r.elevOpenings()
    const xC: { v: number; src: Pt }[] = []
    const yC: { v: number; src: Pt }[] = [{ v: 0, src: pt(p.x, 0) }]
    for (const w of walls) {
      xC.push({ v: w.ua, src: pt(w.ua, w.y1) }, { v: w.ub, src: pt(w.ub, w.y1) })
      yC.push({ v: w.y1, src: pt(w.ua, w.y1) })
    }
    for (const o of opens) {
      xC.push({ v: o.x0, src: pt(o.x0, o.y1) }, { v: o.x1, src: pt(o.x1, o.y1) })
      yC.push({ v: o.y0, src: pt(o.x0, o.y0) }, { v: o.y1, src: pt(o.x0, o.y1) })
    }
    let bx: { v: number; src: Pt } | null = null
    let by: { v: number; src: Pt } | null = null
    for (const c of xC) if (Math.abs(c.v - p.x) < (bx ? Math.abs(bx.v - p.x) : tol)) bx = c
    for (const c of yC) if (Math.abs(c.v - p.y) < (by ? Math.abs(by.v - p.y) : tol)) by = c
    const out = pt(
      bx ? bx.v : snapTo(p.x, this.snapStep),
      by ? by.v : -Math.max(0, snapTo(-p.y, 50))
    )
    if (bx && Math.abs(out.y - bx.src.y) > 1) this.elevGuides.push({ a: bx.src, b: pt(bx.v, out.y) })
    if (by && Math.abs(out.x - by.src.x) > 1) this.elevGuides.push({ a: by.src, b: pt(out.x, by.v) })
    return out
  }

  /** 立面図: 壁を追加(視点側=手前の面の奥行きに、立面の横方向へ) */
  private elevAddWall(x0: number, x1: number): void {
    const elev = this.r.elevation
    if (!elev) return
    const { u, v } = elevAxis(elev.dir)
    const walls = this.r.elevWalls()
    const d = walls.length ? Math.max(...walls.map(w => w.depth)) : 0
    const A = pt(u.x * x0 + v.x * d, u.y * x0 + v.y * d)
    const B = pt(u.x * x1 + v.x * d, u.y * x1 + v.y * d)
    this.store.commit()
    this.store.add({
      id: uid(), type: 'wall', a: A, b: B,
      thickness: params.wall.offR + params.wall.offL,
      height: params.wall.height, structural: params.wall.structural
    })
  }

  /** 立面図: クリック位置の壁に建具を配置(クリック高さ = 窓台高) */
  private elevPlaceOpening(sp: Pt): void {
    const wp = [...this.r.elevWalls()].reverse().find(w =>
      w.facing && sp.x >= w.ua && sp.x <= w.ub && sp.y >= w.y1 && sp.y <= w.y0)
    if (!wp) { this.setHint('壁の上でクリックしてください'); return }
    const { u } = elevAxis(this.r.elevation!.dir)
    const uA = wp.w.a.x * u.x + wp.w.a.y * u.y
    const uB = wp.w.b.x * u.x + wp.w.b.y * u.y
    if (Math.abs(uB - uA) < 1) return
    const pr = this.tool === 'door' ? params.door : params.window
    const L = dist(wp.w.a, wp.w.b)
    const half = Math.min(0.5, pr.width / (2 * L))
    const t = Math.min(Math.max((sp.x - uA) / (uB - uA), half), 1 - half)
    let sill = 0
    let head = pr.head
    if (this.tool === 'window') {
      const winH = params.window.head - params.window.sill
      sill = Math.min(Math.max(0, snapTo(-sp.y - wp.floorY - winH / 2, 50)), Math.max(0, wp.w.height - winH))
      head = sill + winH
    }
    this.store.commit()
    this.store.doc.levels[wp.level].entities.push({
      id: uid(), type: 'opening', wallId: wp.w.id, t,
      width: pr.kind === 'door_double' ? Math.max(pr.width, 1200) : pr.width,
      kind: pr.kind, flip: this.placeFlip, swap: this.placeSwap, sill, head
    })
    this.store.emit()
  }

  private elevDown(p: Pt): void {
    // 作図ツール(壁・ドア・窓)は立面図でも使える
    const sp = this.elevSnap(p)
    if (this.tool === 'door' || this.tool === 'window') { this.elevPlaceOpening(sp); return }
    if (this.tool === 'wall') {
      if (this.elevWallStart === null) this.elevWallStart = sp.x
      else if (Math.abs(sp.x - this.elevWallStart) > 1) {
        this.elevAddWall(this.elevWallStart, sp.x)
        this.elevWallStart = sp.x // 連続入力
      }
      return
    }
    if (this.tool !== 'select') return
    const tol = 10 / this.r.vp.zoom
    // 建具を優先(手前の壁から)
    const opens = this.r.elevOpenings()
    for (let i = opens.length - 1; i >= 0; i--) {
      const op = opens[i]
      if (p.x >= op.x0 - tol && p.x <= op.x1 + tol && p.y >= op.y1 - tol && p.y <= op.y0 + tol) {
        this.r.selection.clear()
        this.r.selection.add(op.o.id)
        this.store.commit()
        const { u } = elevAxis(this.r.elevation!.dir)
        const U = (q: Pt): number => q.x * u.x + q.y * u.y
        this.elevDrag = {
          kind: 'open', id: op.o.id, startX: p.x, floorY: op.wall.floorY,
          uA: U(op.wall.w.a), uB: U(op.wall.w.b)
        }
        this.onSelectionChange()
        this.r.requestDraw()
        return
      }
    }
    // 壁(手前 = 後に描かれたものを優先)
    const walls = this.r.elevWalls()
    for (let i = walls.length - 1; i >= 0; i--) {
      const wp = walls[i]
      const inX = p.x >= wp.ua - tol && p.x <= wp.ub + tol
      if (!inX) continue
      // 上端: 高さドラッグ
      if (Math.abs(p.y - wp.y1) < tol) {
        this.r.selection.clear()
        this.r.selection.add(wp.w.id)
        this.store.commit()
        this.elevDrag = { kind: 'wallH', id: wp.w.id, startX: p.x, floorY: wp.floorY }
        this.onSelectionChange()
        this.r.requestDraw()
        return
      }
      if (p.y >= wp.y1 && p.y <= wp.y0 + tol) {
        this.r.selection.clear()
        this.r.selection.add(wp.w.id)
        this.store.commit()
        this.elevDrag = { kind: 'wallU', id: wp.w.id, startX: p.x, floorY: wp.floorY, origA: { ...wp.w.a }, origB: { ...wp.w.b } }
        this.onSelectionChange()
        this.r.requestDraw()
        return
      }
    }
    this.r.selection.clear()
    this.onSelectionChange()
    this.r.requestDraw()
  }

  private elevMove(p: Pt): void {
    const d = this.elevDrag
    if (!d || !this.r.elevation) return
    const ent = this.store.byId(d.id)
    if (!ent) return
    const { u } = elevAxis(this.r.elevation.dir)
    if (ent.type === 'wall' && d.kind === 'wallU' && d.origA && d.origB) {
      // 立面の横方向 = 平面の u 方向へ平行移動
      const du = snapTo(p.x - d.startX, this.snapStep)
      ent.a = add(d.origA, pt(u.x * du, u.y * du))
      ent.b = add(d.origB, pt(u.x * du, u.y * du))
    } else if (ent.type === 'wall' && d.kind === 'wallH') {
      ent.height = Math.max(300, snapTo(-p.y - d.floorY, 50))
    } else if (ent.type === 'opening') {
      const wall = this.store.byId(ent.wallId)
      if (wall?.type !== 'wall' || d.uA === undefined || d.uB === undefined || d.uA === d.uB) return
      const L = Math.max(1, dist(wall.a, wall.b))
      const half = Math.min(0.5, ent.width / (2 * L))
      const t = (p.x - d.uA) / (d.uB - d.uA)
      ent.t = Math.min(Math.max(t, half), 1 - half)
      if (isWindow(ent.kind)) {
        // 上下ドラッグで窓台高
        const winH = ent.head - ent.sill
        let sill = snapTo(-p.y - d.floorY - winH / 2, 50)
        sill = Math.min(Math.max(0, sill), Math.max(0, wall.height - winH))
        ent.sill = sill
        ent.head = sill + winH
      }
    }
    this.store.emit()
    this.onSelectionChange()
  }

  /** 選択要素(なければ配置プレビュー)を 90° 回転。建具は内外反転として扱う */
  rotateSelection(): void {
    if (!this.r.selection.size) {
      // 建具の配置中は R = 内外反転
      if (this.tool === 'door' || this.tool === 'window') this.placeFlip = !this.placeFlip
      else this.rot += Math.PI / 2
      this.r.requestDraw()
      return
    }
    this.store.commit()
    // 選択全体の共通中心で回す(複数選択でも相対位置が保たれ、形が崩れない)
    const ents = [...this.r.selection].map(id => this.store.byId(id)).filter((e): e is Entity => !!e)
    const ptsAll: Pt[] = []
    for (const ent of ents) {
      if (ent.type === 'wall' || ent.type === 'dimension') ptsAll.push(ent.a, ent.b)
      else if (ent.type === 'room') ptsAll.push(...ent.poly)
      else if (ent.type === 'sketch') ptsAll.push(...ent.edges.flatMap(ed => [ed.a, ed.b]))
      else if ('pos' in ent) ptsAll.push((ent as { pos: Pt }).pos)
    }
    if (!ptsAll.length) return
    const xs = ptsAll.map(q => q.x), ys = ptsAll.map(q => q.y)
    const c = pt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2)
    const rot90 = (q: Pt): Pt => pt(c.x - (q.y - c.y), c.y + (q.x - c.x))
    for (const ent of ents) {
      if (ent.type === 'wall' || ent.type === 'dimension') {
        ent.a = rot90(ent.a); ent.b = rot90(ent.b)
      } else if (ent.type === 'opening') {
        // 建具は壁に従属(壁が回れば一緒に回る)。単体選択なら内外反転
        if (ents.length === 1) ent.flip = !ent.flip
      } else if (ent.type === 'room') {
        ent.poly = ent.poly.map(rot90)
      } else if (ent.type === 'sketch') {
        ent.edges = ent.edges.map(ed => ({ ...ed, a: rot90(ed.a), b: rot90(ed.b) }))
        if (ent.faces) {
          const nf: typeof ent.faces = {}
          for (const [k, v] of Object.entries(ent.faces)) {
            const [x, y] = k.split(':').map(Number)
            const q = rot90(pt(x, y))
            nf[`${Math.round(q.x)}:${Math.round(q.y)}`] = v
          }
          ent.faces = nf
        }
      } else if ('pos' in ent) {
        ;(ent as { pos: Pt }).pos = rot90((ent as { pos: Pt }).pos)
        if ('rot' in ent) (ent as { rot: number }).rot += Math.PI / 2
        if ('attach' in ent) (ent as { attach?: unknown }).attach = undefined
      }
    }
    this.store.emit(); this.onSelectionChange()
  }

  /**
   * 現在のツールでワールド座標 p に配置する(2D クリック / 3D クリック共通)。
   * wallIdHint は 3D で壁を直接クリックした場合の建具配置先。
   */
  placeAt(p: Pt, opts: { shift?: boolean; wallId?: string; noSnap?: boolean } = {}): void {
    // noSnap: 3D 側で既にスナップ・軸ロック済みの点(再スナップでずれないように)
    const sp = opts.noSnap ? p : this.snapPoint(p)
    switch (this.tool) {
      case 'wall': {
        const q = opts.shift && this.wallStart ? this.ortho(this.wallStart, sp) : sp
        if (!this.wallStart) { this.wallStart = q }
        else if (params.wall.arc) {
          // 円弧壁: 始点 → 終点 → 通過点 の3クリックで弧を張る
          if (!this.arcEnd) {
            if (dist(this.wallStart, q) > 1) this.arcEnd = q
          } else {
            this.buildArcWalls(this.wallStart, this.arcEnd, sp)
            this.wallStart = this.arcEnd
            this.arcEnd = null
          }
        } else if (dist(this.wallStart, q) > 1) {
          // クリックした線 = 基準線(通り芯)。壁の本体は 右 offR / 左 offL の設定に従って配置
          const n = perp(norm(sub(q, this.wallStart)))
          const shift = (params.wall.offR - params.wall.offL) / 2
          this.store.commit()
          this.store.add({
            id: uid(), type: 'wall',
            a: add(this.wallStart, pt(n.x * shift, n.y * shift)),
            b: add(q, pt(n.x * shift, n.y * shift)),
            thickness: params.wall.offR + params.wall.offL,
            height: params.wall.height, structural: params.wall.structural,
            refOff: shift === 0 ? undefined : -shift
          })
          this.wallStart = q
        }
        break
      }
      case 'door': case 'window': {
        let wall: Wall | undefined
        let t = 0
        if (opts.wallId) {
          const w = this.store.byId(opts.wallId)
          if (w?.type === 'wall') { wall = w; t = projT(p, w.a, w.b) }
        } else {
          const hit = this.nearestWall(p)
          if (hit) { wall = hit.wall; t = hit.t }
        }
        if (!wall) { this.setHint('壁の上でクリックしてください'); return }
        const pr = this.tool === 'door' ? params.door : params.window
        this.store.commit()
        this.store.add({
          id: uid(), type: 'opening', wallId: wall.id, t,
          width: pr.kind === 'door_double' ? Math.max(pr.width, 1200) : pr.width,
          kind: pr.kind, flip: this.placeFlip, swap: this.placeSwap,
          sill: this.tool === 'window' ? params.window.sill : 0,
          head: pr.head
        })
        break
      }
      case 'stair': {
        this.store.commit()
        const st: Entity = { id: uid(), type: 'stair', pos: sp, rot: this.rot, ...params.stair }
        this.magnetizeEntity(st) // 壁面にピッタリ寄せる
        this.store.add(st)
        this.stairAdjust = st.id // そのままドラッグで向き・長さを調整できる
        break
      }
      case 'column': {
        this.store.commit()
        const col: Entity = { id: uid(), type: 'column', pos: sp, rot: this.rot, ...params.column }
        this.magnetizeEntity(col) // 壁面にピッタリ寄せる
        this.store.add(col)
        break
      }
      case 'furniture': {
        const def = FURN_DEFAULTS[params.furniture.kind]
        this.store.commit()
        const fur: Entity = { id: uid(), type: 'furniture', pos: sp, rot: this.rot, kind: params.furniture.kind, w: def.w, d: def.d, h: def.h }
        this.magnetizeEntity(fur) // 壁面にピッタリ寄せる
        this.store.add(fur)
        break
      }
      case 'equipment': {
        this.store.commit()
        const eq: Entity = { id: uid(), type: 'equipment', pos: sp, rot: this.rot, kind: params.equipment.kind }
        this.magnetizeEntity(eq) // 壁面にピッタリ寄せる
        this.store.add(eq)
        break
      }
      case 'planting':
        this.store.commit()
        this.store.add({ id: uid(), type: 'planting', pos: sp, kind: params.planting.kind, height: params.planting.height })
        break
      case 'label':
        this.store.commit()
        this.store.add({ id: uid(), type: 'label', pos: sp, text: 'テキスト', size: params.label.size })
        break
      case 'component':
        if (this.placingComponent) this.stampComponent(this.placingComponent, sp, this.rot)
        break
      case 'dimension': {
        this.dimPts.push(sp)
        this.dimRefs.push(this.lastSnapRef) // スナップ先を記録(従属寸法)
        if (this.dimPts.length === 3) {
          const [a, b] = this.dimPts
          const n = perp(norm(sub(b, a)))
          const off = (p.x - a.x) * n.x + (p.y - a.y) * n.y
          this.store.commit()
          this.store.add({
            id: uid(), type: 'dimension', a, b, offset: off,
            anchorA: this.dimRefs[0] ?? undefined,
            anchorB: this.dimRefs[1] ?? undefined
          })
          this.dimPts = []
          this.dimRefs = []
        }
        break
      }
      case 'room': {
        if (params.room.mode === 'rect') {
          // 長方形モード: 2点(対角)で部屋を作る
          if (!this.rectStart) this.rectStart = sp
          else { this.commitRect(this.rectStart, sp); this.rectStart = null }
        } else if (this.roomPts.length >= 3 && dist(sp, this.roomPts[0]) < Math.max(300, 20 / this.r.vp.zoom)) {
          this.closeRoom()
        } else {
          this.roomPts.push(sp)
        }
        break
      }
      case 'pencil': {
        if (params.pencil.mode === 'rect') {
          if (!this.rectStart) this.rectStart = sp
          else { this.commitRect(this.rectStart, sp); this.rectStart = null }
        } else if (!this.penPts.length) {
          this.penPts = [sp]
          this.penTarget = this.sketchAt(sp)?.id ?? null // 既存スケッチの上から始めたら追記
        } else if (dist(sp, this.penPts[this.penPts.length - 1]) > 1) {
          this.addSketchEdge(this.penPts[this.penPts.length - 1], sp)
          // 始点に戻って閉じたらストローク終了(SketchUp 流)
          if (this.penPts.length >= 2 && dist(sp, this.penPts[0]) < Math.max(100, 10 / this.r.vp.zoom)) {
            this.penPts = []
            this.penTarget = null
          } else {
            this.penPts.push(sp)
          }
        }
        break
      }
    }
  }

  // ---------- 長方形(部屋・鉛筆共通)とスケッチ辺の確定 ----------
  private commitRect(a: Pt, b: Pt): void {
    if (Math.abs(b.x - a.x) < 1 || Math.abs(b.y - a.y) < 1) return
    const poly = [pt(a.x, a.y), pt(b.x, a.y), pt(b.x, b.y), pt(a.x, b.y)]
    if (this.tool === 'room') {
      this.store.commit()
      this.store.add({ id: uid(), type: 'room', poly, name: '部屋', use: params.room.use, showArea: true })
    } else {
      this.store.commit()
      const target = this.sketchAt(a) ?? this.sketchAt(b)
      const edges = poly.map((q, i) => ({ a: q, b: poly[(i + 1) % 4], color: params.pencil.color }))
      if (target) { target.edges.push(...edges); this.store.emit() }
      else this.store.add({ id: uid(), type: 'sketch', edges })
    }
  }
  /** p の近くにあるスケッチ(辺 5mm 以内 or 面の内側) */
  private sketchAt(p: Pt): SketchE | null {
    for (const e of this.store.doc.entities) {
      if (e.type !== 'sketch' || e.hidden) continue
      if (e.edges.some(ed => distToSeg(p, ed.a, ed.b) < 5)) return e
      if (sketchFaces(e).some(f => pointInPoly(p, f))) return e
    }
    return null
  }
  /** 鉛筆: 辺を 1 本追加(必要ならスケッチを新規作成 / 触れた別のスケッチとマージ) */
  private addSketchEdge(a: Pt, b: Pt): void {
    this.store.commit()
    let target = this.penTarget ? this.store.byId(this.penTarget) as SketchE | undefined : undefined
    if (target?.type !== 'sketch') target = undefined
    if (!target) {
      target = { id: uid(), type: 'sketch', edges: [] }
      this.store.doc.entities.push(target)
      this.penTarget = target.id
    }
    target.edges.push({ a: { ...a }, b: { ...b }, color: params.pencil.color })
    // 終点が別のスケッチに触れたらマージ(またいで閉路が作れる)
    for (const e of [...this.store.doc.entities]) {
      if (e.type !== 'sketch' || e === target || e.hidden) continue
      const touch = e.edges.some(ed =>
        distToSeg(b, ed.a, ed.b) < 5 || dist(a, ed.a) < 5 || dist(a, ed.b) < 5)
      if (touch) {
        target.edges.push(...e.edges)
        target.faces = { ...e.faces, ...target.faces }
        this.store.remove(new Set([e.id]))
        break
      }
    }
    this.store.emit()
  }

  // ---------- コンポーネント配置 ----------
  placeComponent(def: ComponentDef): void {
    this.placingComponent = def
    this.setTool('component')
  }
  private stampComponent(def: ComponentDef, at: Pt, rot: number): void {
    this.store.commit()
    const idMap = new Map<string, string>()
    const cos = Math.cos(rot), sin = Math.sin(rot)
    const tr = (q: Pt): Pt => pt(at.x + q.x * cos - q.y * sin, at.y + q.x * sin + q.y * cos)
    const clones: Entity[] = JSON.parse(JSON.stringify(def.entities))
    const groupMap = new Map<string, string>()
    for (const c of clones) {
      const nid = uid(); idMap.set(c.id, nid); c.id = nid
      if (c.group) { // 複製元とグループを共有しないよう振り直す
        if (!groupMap.has(c.group)) groupMap.set(c.group, uid())
        c.group = groupMap.get(c.group)
      }
    }
    for (const c of clones) {
      if (c.type === 'wall') { c.a = tr(c.a); c.b = tr(c.b) }
      else if (c.type === 'opening') { c.wallId = idMap.get(c.wallId) ?? c.wallId }
      else if (c.type === 'room') c.poly = c.poly.map(tr)
      else if (c.type === 'dimension') { c.a = tr(c.a); c.b = tr(c.b) }
      else if (c.type === 'sketch') {
        c.edges = c.edges.map(ed => ({ ...ed, a: tr(ed.a), b: tr(ed.b) }))
        if (c.faces) {
          const nf: typeof c.faces = {}
          for (const [k, v] of Object.entries(c.faces)) {
            const [x, y] = k.split(':').map(Number)
            const q = tr(pt(x, y))
            nf[`${Math.round(q.x)}:${Math.round(q.y)}`] = v
          }
          c.faces = nf
        }
      }
      else if ('pos' in c) {
        c.pos = tr((c as { pos: Pt }).pos)
        if ('rot' in c) (c as { rot: number }).rot += rot
      }
      this.store.doc.entities.push(c)
    }
    this.store.emit()
  }

  /** 建具の両端 → 壁の両端までの距離を表示(配置時・ドラッグ時) */
  private drawEdgeDistances(ctx: CanvasRenderingContext2D, zoom: number, wall: Wall, t: number, width: number): void {
    const L = dist(wall.a, wall.b)
    if (L < 1) return
    const d = norm(sub(wall.b, wall.a)), n = perp(d)
    const off = wall.thickness / 2 + 14 / zoom
    const cAt = t * L
    const e1 = Math.max(0, cAt - width / 2)          // 壁始端 → 建具左端
    const e2 = Math.max(0, L - cAt - width / 2)      // 建具右端 → 壁終端
    const seg = (from: number, to: number): void => {
      if (to - from < 1) return
      const p1 = add(wall.a, pt(d.x * from + n.x * off, d.y * from + n.y * off))
      const p2 = add(wall.a, pt(d.x * to + n.x * off, d.y * to + n.y * off))
      ctx.save()
      ctx.strokeStyle = '#2563eb'; ctx.fillStyle = '#2563eb'
      ctx.lineWidth = 1 / zoom
      ctx.setLineDash([6 / zoom, 4 / zoom])
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke()
      ctx.setLineDash([])
      // 端の目印
      for (const q of [p1, p2]) {
        ctx.beginPath(); ctx.moveTo(q.x - n.x * 5 / zoom, q.y - n.y * 5 / zoom); ctx.lineTo(q.x + n.x * 5 / zoom, q.y + n.y * 5 / zoom); ctx.stroke()
      }
      const mid = pt((p1.x + p2.x) / 2, (p1.y + p2.y) / 2)
      let ang = Math.atan2(d.y, d.x)
      if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI
      ctx.translate(mid.x, mid.y); ctx.rotate(ang)
      ctx.font = `${12 / zoom}px sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      ctx.fillText(`${Math.round(to - from)}`, 0, -3 / zoom)
      ctx.restore()
    }
    seg(0, e1)
    seg(cAt + width / 2, L)
  }

  /**
   * 選択要素の変形ハンドル。
   * 壁: 両端点 / 部屋: 各頂点 / 家具・柱: 4隅(反対の角を固定して幅・奥行を変更)
   * 階段: 幅 / 建具: 両端(幅を変更)
   */
  private handlesFor(ent: Entity): { key: string; pos: Pt; raw?: boolean; shape?: 'circle'; apply: (q: Pt) => void }[] {
    // 回転ハンドル(円形): rot を持つ要素の上に表示。ドラッグで自由回転(45°ごとに吸着)
    const rotHandle = (e: { pos: Pt; rot: number }, offset: number): { key: string; pos: Pt; raw: true; shape: 'circle'; apply: (q: Pt) => void } => ({
      key: 'rotH', raw: true, shape: 'circle',
      pos: add(e.pos, rotate(pt(0, -offset), e.rot)),
      apply: (q: Pt) => {
        const ang = Math.atan2(q.y - e.pos.y, q.x - e.pos.x) + Math.PI / 2
        e.rot = (angleDetentDeg((ang * 180) / Math.PI) * Math.PI) / 180
      }
    })
    switch (ent.type) {
      case 'wall': {
        const out: { key: string; pos: Pt; raw?: boolean; apply: (q: Pt) => void }[] =
          (['a', 'b'] as const).map(end => ({
            key: end as string, pos: ent[end], apply: (q: Pt) => { ent[end] = q }
          }))
        // 長辺の中点に厚みハンドル: 中心線から掴んだ距離 ×2 = 新しい厚さ
        const n = perp(norm(sub(ent.b, ent.a)))
        const mid = lerp(ent.a, ent.b, 0.5)
        out.push({
          key: 't', raw: true,
          pos: add(mid, pt(n.x * ent.thickness / 2, n.y * ent.thickness / 2)),
          apply: (q: Pt) => {
            const off = (q.x - mid.x) * n.x + (q.y - mid.y) * n.y
            ent.thickness = Math.max(30, Math.round(Math.abs(off) * 2 / 5) * 5)
          }
        })
        return out
      }
      case 'room':
        return ent.poly.map((v, i) => ({
          key: `v${i}`, pos: v, apply: (q: Pt) => { ent.poly[i] = q }
        }))
      case 'sketch': {
        // 辺サブ選択中: その辺の両端だけ / 通常: 全頂点(同じ位置の端点はまとめて動く=スケール変更)
        const sub = this.r.sketchSub?.id === ent.id ? this.r.sketchSub : null
        if (sub?.mode === 'edge' && sub.edgeIdx !== undefined && ent.edges[sub.edgeIdx]) {
          // 辺の両端つまみ: 同じ位置の端点(接続している辺)も一緒に動かして接続を保つ。
          // 並行位置にある反対側の辺は変わらない
          const ed = ent.edges[sub.edgeIdx]
          return (['a', 'b'] as const).map(end => ({
            key: `e${end}`, pos: ed[end],
            apply: (q: Pt) => {
              const cur = { ...ed[end] }
              for (const e2 of ent.edges) {
                if (dist(e2.a, cur) < 3) e2.a = { ...q }
                if (dist(e2.b, cur) < 3) e2.b = { ...q }
              }
            }
          }))
        }
        const seen: Pt[] = []
        const out: { key: string; pos: Pt; apply: (q: Pt) => void }[] = []
        for (const ed of ent.edges) {
          for (const p of [ed.a, ed.b]) {
            if (seen.some(s => dist(s, p) < 3)) continue
            seen.push(p)
            out.push({
              key: `v${out.length}`, pos: p,
              apply: (q: Pt) => {
                // 同じ位置にある端点(接続点)をまとめて動かす
                const cur = { ...p }
                for (const e2 of ent.edges) {
                  if (dist(e2.a, cur) < 3) e2.a = { ...q }
                  if (dist(e2.b, cur) < 3) e2.b = { ...q }
                }
              }
            })
          }
        }
        return out
      }
      case 'furniture': case 'column': case 'custom': {
        const out: { key: string; pos: Pt; raw?: boolean; shape?: 'circle'; apply: (q: Pt) => void }[] = [
          rotHandle(ent, ent.d / 2 + 24 / this.r.vp.zoom)
        ]
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            const local = pt((sx * ent.w) / 2, (sy * ent.d) / 2)
            out.push({
              key: `c${sx}${sy}`,
              pos: add(ent.pos, rotate(local, ent.rot)),
              apply: (q: Pt) => {
                // 反対側の角を固定したまま幅・奥行を変更
                const l = rotate(sub(q, ent.pos), -ent.rot)
                const ax = (-sx * ent.w) / 2, ay = (-sy * ent.d) / 2
                const w = Math.max(50, Math.abs(l.x - ax))
                const d = Math.max(50, Math.abs(l.y - ay))
                const cLocal = pt((l.x + ax) / 2, (l.y + ay) / 2)
                ent.pos = add(ent.pos, rotate(cLocal, ent.rot))
                ent.w = w; ent.d = d
              }
            })
          }
        }
        return out
      }
      case 'equipment': {
        // 家具と同様に 4 隅でリサイズできる
        const s = equipSize(ent)
        const out: { key: string; pos: Pt; raw?: boolean; shape?: 'circle'; apply: (q: Pt) => void }[] = [
          rotHandle(ent, s.d / 2 + 24 / this.r.vp.zoom)
        ]
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            out.push({
              key: `c${sx}${sy}`,
              pos: add(ent.pos, rotate(pt((sx * s.w) / 2, (sy * s.d) / 2), ent.rot)),
              apply: (q: Pt) => {
                const cur = equipSize(ent)
                const l = rotate(sub(q, ent.pos), -ent.rot)
                const ax = (-sx * cur.w) / 2, ay = (-sy * cur.d) / 2
                const w = Math.max(100, Math.abs(l.x - ax))
                const d = Math.max(80, Math.abs(l.y - ay))
                const cLocal = pt((l.x + ax) / 2, (l.y + ay) / 2)
                ent.pos = add(ent.pos, rotate(cLocal, ent.rot))
                ent.w = w; ent.d = d
              }
            })
          }
        }
        return out
      }
      case 'stair': {
        if (ent.kind === 'spiral') {
          return [{
            key: 'r', pos: add(ent.pos, rotate(pt(ent.width, 0), ent.rot)), raw: true,
            apply: (q: Pt) => { ent.width = Math.max(300, Math.round(dist(q, ent.pos))) }
          }]
        }
        const len = Math.max(1, Math.floor(ent.treads / (ent.kind === 'straight' ? 1 : 2))) * ent.tread
        return [
          rotHandle(ent, 24 / this.r.vp.zoom + 150),
          {
            key: 'w', pos: add(ent.pos, rotate(pt(len / 2, ent.width), ent.rot)), raw: true,
            apply: (q: Pt) => {
              const l = rotate(sub(q, ent.pos), -ent.rot)
              ent.width = Math.max(300, Math.round(l.y))
            }
          }
        ]
      }
      case 'dimension': {
        // 両端点 + 寸法線オフセットのハンドル(端点はスナップ先に再従属)
        const n = perp(norm(sub(ent.b, ent.a)))
        const mid = lerp(ent.a, ent.b, 0.5)
        return [
          { key: 'a', pos: ent.a, apply: (q: Pt) => { ent.a = q; ent.anchorA = this.lastSnapRef ?? undefined } },
          { key: 'b', pos: ent.b, apply: (q: Pt) => { ent.b = q; ent.anchorB = this.lastSnapRef ?? undefined } },
          {
            key: 'off', raw: true,
            pos: add(mid, pt(n.x * ent.offset, n.y * ent.offset)),
            apply: (q: Pt) => { ent.offset = (q.x - mid.x) * n.x + (q.y - mid.y) * n.y }
          }
        ]
      }
      case 'planting': {
        // 円周上のハンドルで大きさ(高さ)を変更
        const r = ent.kind === 'tree' ? Math.max(400, ent.height / 4)
          : ent.kind === 'shrub' ? Math.max(250, ent.height / 3) : 260
        return [{
          key: 'r', raw: true, pos: add(ent.pos, pt(r, 0)),
          apply: (q: Pt) => {
            const d = Math.max(100, dist(q, ent.pos))
            const h = ent.kind === 'tree' ? d * 4 : ent.kind === 'shrub' ? d * 3 : d * 7.3
            ent.height = Math.max(200, Math.round(h / 50) * 50)
          }
        }]
      }
      case 'opening': {
        const wall = this.store.byId(ent.wallId)
        if (wall?.type !== 'wall') return []
        const L = Math.max(1, dist(wall.a, wall.b))
        const half = ent.width / (2 * L)
        return ([-1, 1] as const).map(s => ({
          key: `e${s}`, pos: lerp(wall.a, wall.b, ent.t + s * half), raw: true,
          apply: (q: Pt) => {
            const other = ent.t - s * (ent.width / (2 * L))  // 反対側の端は固定
            const tq = projT(q, wall.a, wall.b)
            const width = Math.max(150, Math.abs(tq - other) * L)
            ent.t = (tq + other) / 2
            ent.width = width
          }
        }))
      }
      default:
        return []
    }
  }

  /** コンポーネントのゴーストプレビュー(カーソル位置に半透明で表示) */
  private drawComponentPreview(ctx: CanvasRenderingContext2D, zoom: number, def: { entities: Entity[] }, at: Pt, rot: number): void {
    const cos = Math.cos(rot), sin = Math.sin(rot)
    const tr = (q: Pt): Pt => pt(at.x + q.x * cos - q.y * sin, at.y + q.x * sin + q.y * cos)
    ctx.save()
    ctx.globalAlpha = 0.5
    for (const src of def.entities) {
      const e: Entity = JSON.parse(JSON.stringify(src))
      if (e.type === 'wall') {
        e.a = tr(e.a); e.b = tr(e.b)
        const dW = norm(sub(e.b, e.a)), n = perp(dW), h = e.thickness / 2
        ctx.fillStyle = '#e5e5e5'; ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1 / zoom
        ctx.beginPath()
        ctx.moveTo(e.a.x + n.x * h, e.a.y + n.y * h)
        ctx.lineTo(e.b.x + n.x * h, e.b.y + n.y * h)
        ctx.lineTo(e.b.x - n.x * h, e.b.y - n.y * h)
        ctx.lineTo(e.a.x - n.x * h, e.a.y - n.y * h)
        ctx.closePath(); ctx.fill(); ctx.stroke()
      } else if (e.type === 'room') {
        e.poly = e.poly.map(tr)
        ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 0.7 / zoom
        ctx.setLineDash([160, 110])
        ctx.beginPath()
        e.poly.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)))
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([])
      } else if (e.type === 'dimension') {
        e.a = tr(e.a); e.b = tr(e.b)
        drawDimension(ctx, e, zoom)
      } else if (e.type === 'sketch') {
        ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1 / zoom
        for (const ed of e.edges) {
          const a2 = tr(ed.a), b2 = tr(ed.b)
          ctx.beginPath(); ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y); ctx.stroke()
        }
      } else if ('pos' in e) {
        ;(e as { pos: Pt }).pos = tr((e as { pos: Pt }).pos)
        if ('rot' in e) (e as { rot: number }).rot += rot
        if (e.type === 'furniture') drawFurniture(ctx, e, zoom)
        else if (e.type === 'column') drawColumn(ctx, e, zoom)
        else if (e.type === 'stair') drawStair(ctx, e, zoom)
        else if (e.type === 'equipment') drawEquipment(ctx, e, zoom)
        else if (e.type === 'planting') drawPlanting(ctx, e, zoom)
        else if (e.type === 'custom') drawCustom(ctx, e, zoom)
        else if (e.type === 'label') drawLabel(ctx, e)
      }
    }
    ctx.restore()
  }

  /** 変形中の要素の縦横寸法をエッジ沿いに表示 */
  private drawResizeDims(ctx: CanvasRenderingContext2D, zoom: number, ent: Entity): void {
    ctx.save()
    ctx.fillStyle = '#2563eb'
    if (ent.type === 'wall') {
      this.edgeLen(ctx, zoom, ent.a, ent.b)
    } else if (ent.type === 'furniture' || ent.type === 'column' || ent.type === 'custom') {
      const c = (sx: number, sy: number): Pt => add(ent.pos, rotate(pt((sx * ent.w) / 2, (sy * ent.d) / 2), ent.rot))
      this.edgeLen(ctx, zoom, c(-1, -1), c(1, -1))   // 幅(上辺)
      this.edgeLen(ctx, zoom, c(1, -1), c(1, 1))     // 奥行(右辺)
    } else if (ent.type === 'room') {
      for (let i = 0; i < ent.poly.length; i++) {
        this.edgeLen(ctx, zoom, ent.poly[i], ent.poly[(i + 1) % ent.poly.length])
      }
    } else if (ent.type === 'opening') {
      const wall = this.store.byId(ent.wallId)
      if (wall?.type === 'wall') {
        const { c } = openingCenter(ent, wall)
        ctx.font = `${13 / zoom}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(`${Math.round(ent.width)}`, c.x, c.y - (wall.thickness / 2 + 16 / zoom))
        this.drawEdgeDistances(ctx, zoom, wall, ent.t, ent.width)
      }
    } else if (ent.type === 'stair') {
      ctx.font = `${13 / zoom}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(`幅 ${Math.round(ent.width)}`, ent.pos.x, ent.pos.y - 14 / zoom)
    }
    ctx.restore()
  }

  /** 辺の中点に長さ(mm)を描く */
  private edgeLen(ctx: CanvasRenderingContext2D, zoom: number, a: Pt, b: Pt): void {
    const L = dist(a, b)
    if (L < 1) return
    const d = norm(sub(b, a)), n = perp(d)
    let ang = Math.atan2(d.y, d.x)
    if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI
    ctx.save()
    ctx.translate((a.x + b.x) / 2 - n.x * 8 / zoom, (a.y + b.y) / 2 - n.y * 8 / zoom)
    ctx.rotate(ang)
    ctx.font = `${12 / zoom}px sans-serif`
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillText(`${Math.round(L)}`, 0, 0)
    ctx.restore()
  }

  // ---------- プレビュー描画 ----------
  /** 立面図用のオーバーレイ: スナップガイド・壁/建具のゴースト・ドラッグ中の寸法 */
  private drawElevOverlay(ctx: CanvasRenderingContext2D, zoom: number): void {
    const c = this.elevCursor
    // スナップガイド(緑の点線)
    if (this.elevGuides.length) {
      ctx.save()
      ctx.strokeStyle = '#16a34a'
      ctx.lineWidth = 1 / zoom
      ctx.setLineDash([7 / zoom, 5 / zoom])
      for (const g of this.elevGuides) {
        ctx.beginPath(); ctx.moveTo(g.a.x, g.a.y); ctx.lineTo(g.b.x, g.b.y); ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.restore()
    }
    // 作図ツールの十字カーソル
    if (this.tool === 'wall' || this.tool === 'door' || this.tool === 'window') {
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = 1 / zoom
      const s = 8 / zoom
      ctx.beginPath()
      ctx.moveTo(c.x - s, c.y); ctx.lineTo(c.x + s, c.y)
      ctx.moveTo(c.x, c.y - s); ctx.lineTo(c.x, c.y + s)
      ctx.stroke()
    }
    ctx.fillStyle = '#2563eb'
    ctx.strokeStyle = '#2563eb'
    // 壁ツール: 始点からのゴースト(高さ = ツール設定)+ 長さ
    if (this.tool === 'wall' && this.elevWallStart !== null) {
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.lineWidth = 1 / zoom
      const x0 = Math.min(this.elevWallStart, c.x), x1 = Math.max(this.elevWallStart, c.x)
      ctx.strokeRect(x0, -params.wall.height, x1 - x0, params.wall.height)
      ctx.globalAlpha = 1
      ctx.font = `${13 / zoom}px sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      ctx.fillText(`${Math.round(x1 - x0)}`, (x0 + x1) / 2, -params.wall.height - 6 / zoom)
      ctx.restore()
    }
    // 建具ツール: ホバー中の壁にゴースト + 壁端からの距離
    if ((this.tool === 'door' || this.tool === 'window') && this.elevHover) {
      const wp = this.elevHover
      const pr = this.tool === 'door' ? params.door : params.window
      const winH = this.tool === 'window' ? params.window.head - params.window.sill : pr.head
      let sill = 0
      if (this.tool === 'window') {
        sill = Math.min(Math.max(0, snapTo(-c.y - wp.floorY - winH / 2, 50)), Math.max(0, wp.w.height - winH))
      }
      const cx = Math.min(Math.max(c.x, wp.ua + pr.width / 2), wp.ub - pr.width / 2)
      const gy0 = -(wp.floorY + sill), gy1 = -(wp.floorY + sill + winH)
      ctx.save()
      ctx.globalAlpha = 0.5
      ctx.lineWidth = 1.2 / zoom
      ctx.strokeRect(cx - pr.width / 2, gy1, pr.width, gy0 - gy1)
      ctx.globalAlpha = 1
      this.elevEdgeDims(ctx, zoom, wp, cx - pr.width / 2, cx + pr.width / 2, (gy0 + gy1) / 2)
      if (this.tool === 'window') {
        ctx.font = `${12 / zoom}px sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        ctx.fillText(`窓台高 ${Math.round(sill)}`, cx, gy0 + 6 / zoom)
      }
      ctx.restore()
    }
    // 建具ドラッグ中: 壁端からの距離 + 窓台高
    if (this.elevDrag?.kind === 'open') {
      const op = this.r.elevOpenings().find(o => o.o.id === this.elevDrag!.id)
      if (op) {
        ctx.save()
        this.elevEdgeDims(ctx, zoom, op.wall, op.x0, op.x1, (op.y0 + op.y1) / 2)
        if (isWindow(op.o.kind)) {
          ctx.font = `${12 / zoom}px sans-serif`
          ctx.textAlign = 'center'; ctx.textBaseline = 'top'
          ctx.fillText(`窓台高 ${Math.round(op.o.sill)}`, (op.x0 + op.x1) / 2, op.y0 + 6 / zoom)
        }
        ctx.restore()
      }
    }
  }
  /** 立面図: 壁の両端 → 建具の両端の距離(点線 + 数字) */
  private elevEdgeDims(ctx: CanvasRenderingContext2D, zoom: number, wp: ElevWallProj, x0: number, x1: number, y: number): void {
    const seg = (from: number, to: number): void => {
      if (to - from < 1) return
      ctx.save()
      ctx.strokeStyle = '#2563eb'; ctx.fillStyle = '#2563eb'
      ctx.lineWidth = 1 / zoom
      ctx.setLineDash([6 / zoom, 4 / zoom])
      ctx.beginPath(); ctx.moveTo(from, y); ctx.lineTo(to, y); ctx.stroke()
      ctx.setLineDash([])
      ctx.font = `${12 / zoom}px sans-serif`
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
      ctx.fillText(`${Math.round(to - from)}`, (from + to) / 2, y - 3 / zoom)
      ctx.restore()
    }
    seg(wp.ua, x0)
    seg(x1, wp.ub)
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (this.r.elevation) { this.drawElevOverlay(ctx, zoom); return }
    const c = this.cursor
    ctx.strokeStyle = '#2563eb'
    ctx.fillStyle = '#2563eb'
    // 範囲選択の矩形(緑の点線に統一)
    if (this.marquee) {
      const { start, cur } = this.marquee
      ctx.save()
      ctx.fillStyle = 'rgba(22, 163, 74, 0.06)'
      ctx.strokeStyle = '#16a34a'
      ctx.lineWidth = 1 / zoom
      ctx.setLineDash([8 / zoom, 5 / zoom])
      ctx.fillRect(start.x, start.y, cur.x - start.x, cur.y - start.y)
      ctx.strokeRect(start.x, start.y, cur.x - start.x, cur.y - start.y)
      ctx.restore()
      return
    }
    // 基準点複写: 基準点の選択待ち(十字カーソル + ラベルで明確化)
    if (this.dupAwaitBase) {
      ctx.save()
      ctx.strokeStyle = '#2563eb'; ctx.fillStyle = '#2563eb'
      ctx.lineWidth = 1.2 / zoom
      const s = 14 / zoom
      ctx.beginPath()
      ctx.moveTo(c.x - s, c.y); ctx.lineTo(c.x + s, c.y)
      ctx.moveTo(c.x, c.y - s); ctx.lineTo(c.x, c.y + s)
      ctx.stroke()
      ctx.font = `${12 / zoom}px sans-serif`
      const label = 'コピーの基準点をクリック(右クリックでキャンセル)'
      const w = ctx.measureText(label).width + 14 / zoom
      ctx.fillStyle = '#1d4ed8'
      ctx.fillRect(c.x + 16 / zoom, c.y - 26 / zoom, w, 20 / zoom)
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(label, c.x + 23 / zoom, c.y - 16 / zoom)
      ctx.restore()
    }
    // カーソル十字 + 端点スナップの表示(緑の○)
    if (this.tool !== 'select') {
      ctx.lineWidth = 1 / zoom
      const s = 8 / zoom
      ctx.beginPath()
      ctx.moveTo(c.x - s, c.y); ctx.lineTo(c.x + s, c.y)
      ctx.moveTo(c.x, c.y - s); ctx.lineTo(c.x, c.y + s)
      ctx.stroke()
      if (this.snapKind && this.snapKind !== 'グリッド') {
        ctx.save()
        ctx.strokeStyle = '#16a34a'
        ctx.fillStyle = '#16a34a'
        ctx.lineWidth = 1.6 / zoom
        const R = 6 / zoom
        // 種別ごとのマーカー(CAD 慣例に寄せる)
        switch (this.snapKind) {
          case '端点': // 四角
            ctx.strokeRect(c.x - R, c.y - R, R * 2, R * 2)
            break
          case '中点': // 三角
            ctx.beginPath()
            ctx.moveTo(c.x, c.y - R); ctx.lineTo(c.x + R, c.y + R); ctx.lineTo(c.x - R, c.y + R)
            ctx.closePath(); ctx.stroke()
            break
          case '中心': case '図心': // 丸 + 十字
            ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI * 2); ctx.stroke()
            ctx.beginPath()
            ctx.moveTo(c.x - R, c.y); ctx.lineTo(c.x + R, c.y)
            ctx.moveTo(c.x, c.y - R); ctx.lineTo(c.x, c.y + R)
            ctx.stroke()
            break
          default: // 交点・仮想交点・延長 = ×
            ctx.beginPath()
            ctx.moveTo(c.x - R, c.y - R); ctx.lineTo(c.x + R, c.y + R)
            ctx.moveTo(c.x + R, c.y - R); ctx.lineTo(c.x - R, c.y + R)
            ctx.stroke()
        }
        // ガイド線(延長・仮想交点)
        if (this.snapGuides.length) {
          ctx.setLineDash([7 / zoom, 5 / zoom])
          ctx.lineWidth = 1 / zoom
          for (const g of this.snapGuides) {
            ctx.beginPath(); ctx.moveTo(g.a.x, g.a.y); ctx.lineTo(g.b.x, g.b.y); ctx.stroke()
          }
          ctx.setLineDash([])
        }
        // 種別ラベル
        ctx.font = `${11 / zoom}px sans-serif`
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'
        ctx.fillText(this.snapKind, c.x + 10 / zoom, c.y - 8 / zoom)
        ctx.restore()
      }
    }
    // 壁への吸着中: 接触面に緑のガイドラインを表示
    if (this.dragging && this.lastMagnet) {
      const { wall, side } = this.lastMagnet
      const dW = norm(sub(wall.b, wall.a)), n = perp(dW)
      const h = wall.thickness / 2
      ctx.save()
      ctx.strokeStyle = '#16a34a'
      ctx.lineWidth = 3 / zoom
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.moveTo(wall.a.x + n.x * h * side, wall.a.y + n.y * h * side)
      ctx.lineTo(wall.b.x + n.x * h * side, wall.b.y + n.y * h * side)
      ctx.stroke()
      ctx.restore()
    }

    // 変形中は縦横の寸法をエッジ沿いに表示(回転中は角度)
    if (this.handleDrag) {
      const ent = this.store.byId(this.handleDrag.entId)
      if (ent) {
        if (this.handleDrag.key === 'rotH' && 'rot' in ent && 'pos' in ent) {
          const deg = Math.round((((ent as { rot: number }).rot * 180) / Math.PI) % 360 + 360) % 360
          ctx.save()
          ctx.fillStyle = '#2563eb'
          ctx.font = `${13 / zoom}px sans-serif`
          ctx.textAlign = 'center'
          const pp = (ent as { pos: Pt }).pos
          ctx.fillText(`${deg}°`, pp.x, pp.y - 30 / zoom)
          ctx.restore()
        } else {
          this.drawResizeDims(ctx, zoom, ent)
        }
      }
    }

    // 選択中の要素の変形ハンドル(濃い青の四角 = 掴んで変形できる)
    if (this.tool === 'select' && this.r.selection.size) {
      const hs = 5.5 / zoom
      ctx.save()
      ctx.fillStyle = '#2563eb'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.6 / zoom
      for (const id of this.r.selection) {
        const ent = this.store.byId(id)
        if (!ent) continue
        for (const h of this.handlesFor(ent)) {
          ctx.beginPath()
          if (h.shape === 'circle') ctx.arc(h.pos.x, h.pos.y, hs * 1.15, 0, Math.PI * 2)
          else ctx.rect(h.pos.x - hs, h.pos.y - hs, hs * 2, hs * 2)
          ctx.fill(); ctx.stroke()
        }
      }
      ctx.restore()
    }

    ctx.globalAlpha = 0.55
    if (this.tool === 'wall' && this.wallStart && params.wall.arc && this.arcEnd) {
      // 円弧壁プレビュー: カーソル=通過点
      const arc = arcThrough(this.wallStart, this.arcEnd, c)
      const pts: Pt[] = arc ?? [this.wallStart, this.arcEnd]
      ctx.lineWidth = Math.max(params.wall.thickness, 2 / zoom)
      ctx.strokeStyle = '#93c5fd'
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'
      ctx.beginPath()
      pts.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)))
      ctx.stroke()
      ctx.lineCap = 'butt'
    } else if (this.tool === 'wall' && this.wallStart) {
      const th = params.wall.thickness
      const d = norm(sub(c, this.wallStart)), n = perp(d)
      ctx.lineWidth = 1 / zoom
      ctx.beginPath()
      ctx.moveTo(this.wallStart.x + n.x * th / 2, this.wallStart.y + n.y * th / 2)
      ctx.lineTo(c.x + n.x * th / 2, c.y + n.y * th / 2)
      ctx.lineTo(c.x - n.x * th / 2, c.y - n.y * th / 2)
      ctx.lineTo(this.wallStart.x - n.x * th / 2, this.wallStart.y - n.y * th / 2)
      ctx.closePath(); ctx.stroke()
      const L = Math.round(dist(this.wallStart, c))
      ctx.globalAlpha = 1
      ctx.font = `${13 / zoom}px sans-serif`
      ctx.fillText(`${L}`, (this.wallStart.x + c.x) / 2, (this.wallStart.y + c.y) / 2 - 10 / zoom)
    } else if (this.tool === 'door' || this.tool === 'window') {
      const hit = this.nearestWall(this.rawCursor)
      if (hit) {
        const pr = this.tool === 'door' ? params.door : params.window
        const prev: Opening = {
          id: '', type: 'opening', wallId: hit.wall.id, t: hit.t, width: pr.width,
          kind: pr.kind, flip: this.placeFlip, swap: this.placeSwap,
          sill: this.tool === 'window' ? params.window.sill : 0, head: pr.head
        }
        drawOpening(ctx, prev, hit.wall, zoom)
        this.drawEdgeDistances(ctx, zoom, hit.wall, hit.t, pr.width)
      }
    } else if (this.tool === 'select' && this.dragging && this.r.selection.size === 1) {
      // 建具ドラッグ中も壁端からの距離を表示
      const ent = this.store.byId([...this.r.selection][0])
      if (ent?.type === 'opening') {
        const wl = this.store.byId(ent.wallId) as Wall | undefined
        if (wl) this.drawEdgeDistances(ctx, zoom, wl, ent.t, ent.width)
      }
    } else if (this.tool === 'column') {
      drawColumn(ctx, { id: '', type: 'column', pos: c, rot: this.rot, ...params.column }, zoom)
    } else if (this.tool === 'stair') {
      drawStair(ctx, { id: '', type: 'stair', pos: c, rot: this.rot, ...params.stair }, zoom)
    } else if (this.tool === 'furniture') {
      const def = FURN_DEFAULTS[params.furniture.kind]
      drawFurniture(ctx, { id: '', type: 'furniture', pos: c, rot: this.rot, kind: params.furniture.kind, w: def.w, d: def.d, h: def.h }, zoom)
    } else if (this.tool === 'equipment') {
      drawEquipment(ctx, { id: '', type: 'equipment', pos: c, rot: this.rot, kind: params.equipment.kind }, zoom)
    } else if (this.tool === 'planting') {
      drawPlanting(ctx, { id: '', type: 'planting', pos: c, kind: params.planting.kind, height: params.planting.height }, zoom)
    } else if (this.tool === 'component' && this.placingComponent) {
      // 配置しようとしているコンポーネント(複製含む)を半透明で表示
      this.drawComponentPreview(ctx, zoom, this.placingComponent, c, this.rot)
    } else if (this.tool === 'dimension' && this.dimPts.length) {
      ctx.lineWidth = 1 / zoom
      ctx.beginPath()
      ctx.moveTo(this.dimPts[0].x, this.dimPts[0].y)
      for (const q of this.dimPts.slice(1)) ctx.lineTo(q.x, q.y)
      ctx.lineTo(c.x, c.y)
      ctx.stroke()
    } else if ((this.tool === 'room' || this.tool === 'pencil') && this.rectStart) {
      // 長方形モードのプレビュー(部屋・鉛筆共通): 外形 + 縦横寸法 + 面積
      const a = this.rectStart
      ctx.lineWidth = 1 / zoom
      ctx.strokeRect(Math.min(a.x, c.x), Math.min(a.y, c.y), Math.abs(c.x - a.x), Math.abs(c.y - a.y))
      ctx.globalAlpha = 1
      this.edgeLen(ctx, zoom, pt(a.x, a.y), pt(c.x, a.y))
      this.edgeLen(ctx, zoom, pt(c.x, a.y), pt(c.x, c.y))
      const areaM2 = Math.abs((c.x - a.x) * (c.y - a.y)) / 1e6
      if (areaM2 > 0.01) {
        ctx.font = `${13 / zoom}px sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(`${areaM2.toFixed(2)} m²`, (a.x + c.x) / 2, (a.y + c.y) / 2)
      }
    } else if ((this.tool === 'room' && this.roomPts.length) || (this.tool === 'pencil' && this.penPts.length)) {
      // 多角形(部屋)・鉛筆の共通プレビュー: 折れ線 + 各辺の寸法 + 面積
      const base = this.tool === 'room' ? this.roomPts : this.penPts
      ctx.lineWidth = 1 / zoom
      ctx.beginPath()
      ctx.moveTo(base[0].x, base[0].y)
      for (const q of base.slice(1)) ctx.lineTo(q.x, q.y)
      ctx.lineTo(c.x, c.y)
      ctx.stroke()
      ctx.globalAlpha = 1
      const pts = [...base, c]
      for (let i = 0; i < pts.length - 1; i++) this.edgeLen(ctx, zoom, pts[i], pts[i + 1])
      if (pts.length >= 3) {
        const areaM2 = Math.abs(polyArea(pts)) / 1e6
        const cx = pts.reduce((s, q) => s + q.x, 0) / pts.length
        const cy = pts.reduce((s, q) => s + q.y, 0) / pts.length
        ctx.font = `${13 / zoom}px sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(`${areaM2.toFixed(2)} m²`, cx, cy)
      }
    }
    ctx.globalAlpha = 1

    // 基準点複写のガイド: 基準点 → カーソルの点線 + 距離(水平垂直・対角は角度吸着)
    if (this.tool === 'component' && this.dupFrom) {
      const f = this.dupFrom
      ctx.save()
      ctx.strokeStyle = '#16a34a'; ctx.fillStyle = '#16a34a'
      ctx.lineWidth = 1 / zoom
      const R = 6 / zoom
      ctx.beginPath()
      ctx.moveTo(f.x - R, f.y); ctx.lineTo(f.x + R, f.y)
      ctx.moveTo(f.x, f.y - R); ctx.lineTo(f.x, f.y + R)
      ctx.stroke()
      ctx.setLineDash([8 / zoom, 5 / zoom])
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(c.x, c.y); ctx.stroke()
      ctx.setLineDash([])
      const L = Math.round(dist(f, c))
      if (L > 1) {
        ctx.font = `${12 / zoom}px sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
        ctx.fillText(`${L}`, (f.x + c.x) / 2, (f.y + c.y) / 2 - 6 / zoom)
      }
      ctx.restore()
    }

    // 数値入力バッファ(Enter で確定)
    if (this.numBuf) {
      ctx.save()
      ctx.font = `${13 / zoom}px sans-serif`
      const label = `${this.numBuf} ⏎`
      const w = ctx.measureText(label).width + 14 / zoom
      ctx.fillStyle = '#1d4ed8'
      ctx.fillRect(c.x + 14 / zoom, c.y + 12 / zoom, w, 20 / zoom)
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText(label, c.x + 21 / zoom, c.y + 22 / zoom)
      ctx.restore()
    }

    // 部屋・鉛筆ツール: カーソル上のモードアイコン(現在のモードだけを青丸+白で表示。クリックで切替)
    this.modeIcons = []
    if (this.tool === 'room' || this.tool === 'pencil') {
      const pr = this.tool === 'room' ? params.room : params.pencil
      const R = 15 / zoom
      const cx0 = c.x + 30 / zoom
      const cy0 = c.y - 34 / zoom
      ctx.save()
      // 青い円 + 影
      ctx.beginPath(); ctx.arc(cx0, cy0, R, 0, Math.PI * 2)
      ctx.fillStyle = '#2563eb'
      ctx.shadowColor = 'rgba(0,0,0,0.25)'
      ctx.shadowBlur = 6 / zoom
      ctx.shadowOffsetY = 1.5 / zoom
      ctx.fill()
      ctx.shadowColor = 'transparent'
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.6 / zoom
      ctx.lineJoin = 'round'; ctx.lineCap = 'round'
      const u = R / 15 // アイコン内のスケール単位
      if (pr.mode === 'poly') {
        // 鉛筆: 本体(平行四辺形)+ 先端の三角 + 消しゴム側のキャップ
        ctx.beginPath()
        ctx.moveTo(cx0 - 6.5 * u, cy0 + 6.5 * u)   // 先端
        ctx.lineTo(cx0 - 4.2 * u, cy0 + 1.8 * u)   // 芯の付け根(下側)
        ctx.lineTo(cx0 + 4.6 * u, cy0 - 7.0 * u)   // 上端(下側)
        ctx.lineTo(cx0 + 7.0 * u, cy0 - 4.6 * u)   // 上端(上側)
        ctx.lineTo(cx0 - 1.8 * u, cy0 + 4.2 * u)   // 芯の付け根(上側)
        ctx.closePath()
        ctx.stroke()
        // 芯(先端の塗り)
        ctx.beginPath()
        ctx.moveTo(cx0 - 6.5 * u, cy0 + 6.5 * u)
        ctx.lineTo(cx0 - 4.2 * u, cy0 + 1.8 * u)
        ctx.lineTo(cx0 - 1.8 * u, cy0 + 4.2 * u)
        ctx.closePath()
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        // 消しゴム側の区切り線
        ctx.beginPath()
        ctx.moveTo(cx0 + 3.2 * u, cy0 - 5.6 * u)
        ctx.lineTo(cx0 + 5.6 * u, cy0 - 3.2 * u)
        ctx.stroke()
      } else {
        // 長方形
        ctx.strokeRect(cx0 - 6.5 * u, cy0 - 4.5 * u, 13 * u, 9 * u)
      }
      ctx.restore()
      // クリックで反対のモードへ
      const other: DrawMode = pr.mode === 'poly' ? 'rect' : 'poly'
      this.modeIcons.push({ c: pt(cx0, cy0), r: R * 1.2, mode: other })
    }
  }
}
