// ツール(作図・選択)とポインタ操作
import {
  Store, Entity, Wall, Opening, uid, OpeningKind, StairKind, FurnKind, EquipKind, PlantKind,
  FURN_DEFAULTS, isWindow, Room, RoomUse, DimAnchor
} from './model'
import { Renderer2D } from './renderer2d'
import {
  Pt, pt, sub, add, dist, distToSeg, projT, lerp, snapTo, pointInPoly, norm, perp, polyArea, rotate,
  arcThrough, angleDetentDeg, lineIntersect, polyCentroid
} from './geometry'
import {
  drawOpening, drawFurniture, drawStair, drawEquipment, drawPlanting, drawColumn,
  drawCustom, drawDimension, drawLabel, openingCenter
} from './symbols'

export type ToolName =
  | 'select' | 'wall' | 'column' | 'door' | 'window' | 'stair' | 'furniture'
  | 'equipment' | 'planting' | 'dimension' | 'label' | 'room' | 'component'

/** 各ツールの現在パラメータ(左パネルの「ツール設定」から編集) */
export const params = {
  wall: { thickness: 120, height: 2400, structural: false, arc: false },
  column: { w: 300, d: 300, h: 2400, shape: 'rect' as 'rect' | 'round' },
  door: { kind: 'door_single' as OpeningKind, width: 780, head: 2000 },
  window: { kind: 'win_sliding' as OpeningKind, width: 1650, sill: 900, head: 2000 },
  stair: { kind: 'straight' as StairKind, width: 910, treads: 13, tread: 225, riser: 200 },
  furniture: { kind: 'bed_s' as FurnKind },
  equipment: { kind: 'boiler' as EquipKind },
  planting: { kind: 'tree' as PlantKind, height: 3000 },
  room: { use: '居室' as RoomUse },
  label: { size: 300 }
}

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
      if (!this.panMoved) this.cancel() // 右ドラッグでパンした時はキャンセルしない
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
    if (t !== 'component') this.placingComponent = null
    this.onToolChange(t)
    this.updateHint()
    this.r.requestDraw()
  }

  private updateHint(): void {
    const hints: Record<ToolName, string> = {
      select: 'クリック: 選択 / ドラッグ: 移動 / Delete: 削除 / R: 回転',
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
      room: '頂点を順にクリック / ダブルクリックまたは始点クリックで閉じる',
      component: 'クリックでコンポーネントを配置 / R: 90°回転'
    }
    this.setHint(hints[this.tool])
  }

  // ---------- 座標・スナップ ----------
  private eventPt(e: PointerEvent | WheelEvent): Pt {
    const rect = this.canvas.getBoundingClientRect()
    return this.r.vp.toWorld(pt(e.clientX - rect.left, e.clientY - rect.top))
  }
  private snapPoint(p: Pt, excludeWallId?: string): Pt {
    if (this.snapDirty) this.buildSnapCache()
    const tol = 12 / this.r.vp.zoom
    this.snapGuides = []
    // 優先度順に候補を探す(CAD 流)
    this.lastSnapRef = null
    const PRIORITY = ['端点', '交点', '中点', '中心', '図心', '仮想交点']
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
    // 延長: 壁の中心線の延長線上(端から 3000mm 以内)
    let bestExt: { p: Pt; from: Pt } | null = null
    let bd = tol
    for (const w of this.store.walls()) {
      if (w.id === excludeWallId) continue
      const dW = norm(sub(w.b, w.a))
      const L = dist(w.a, w.b)
      const t = (p.x - w.a.x) * dW.x + (p.y - w.a.y) * dW.y
      if (t >= -1 && t <= L + 1) continue // セグメント内は対象外
      if (t < -3000 || t > L + 3000) continue
      const foot = pt(w.a.x + dW.x * t, w.a.y + dW.y * t)
      const dd = dist(p, foot)
      if (dd < bd) { bd = dd; bestExt = { p: foot, from: t < 0 ? w.a : w.b } }
    }
    if (bestExt) {
      this.snapKind = '延長'
      this.snapGuides = [{ a: bestExt.from, b: bestExt.p }]
      return { ...bestExt.p }
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
    const ents = this.store.doc.entities
    const walls = new Map<string, Wall>()
    for (const e of ents) if (e.type === 'wall') walls.set(e.id, e)
    const tol = 10 / this.r.vp.zoom
    // 優先度: 小物 → 壁 → 部屋
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
      if (e.type === 'wall' && distToSeg(p, e.a, e.b) < e.thickness / 2 + tol) return e
    }
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i]
      if (e.type === 'room' && pointInPoly(p, e.poly)) return e
    }
    return null
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
            this.store.expandGroups(this.r.selection) // グループはまとめて選択
          } else if (e.shiftKey) {
            this.r.selection.delete(hit.id)
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
          if (!e.shiftKey) this.r.selection.clear()
          this.marquee = { start: p, cur: p, additive: e.shiftKey }
        }
        this.onSelectionChange()
        this.r.requestDraw()
        break
      }
      case 'wall': case 'door': case 'window': case 'stair': case 'column':
      case 'furniture': case 'equipment': case 'planting': case 'label': case 'component':
      case 'dimension': case 'room':
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
    this.cursor = this.snapPoint(p)
    if (this.tool === 'wall' && this.wallStart && e.shiftKey) this.cursor = this.ortho(this.wallStart, this.cursor)

    // 変形つまみの上では OS の「つかむ手」カーソル
    if (this.tool === 'select' && !this.dragging && !this.handleDrag && !this.marquee) {
      const hTol = 10 / this.r.vp.zoom
      let over = false
      for (const id of this.r.selection) {
        const ent = this.store.byId(id)
        if (!ent) continue
        if (this.handlesFor(ent).some(hh => dist(p, hh.pos) < hTol)) { over = true; break }
      }
      this.canvas.style.cursor = over ? 'grab' : ''
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
      if (Math.abs(d.x) + Math.abs(d.y) > 3 / this.r.vp.zoom) this.drillPending = null
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
    if (this.drillPending) {
      this.r.selection.clear()
      this.r.selection.add(this.drillPending)
      this.drillPending = null
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
    this.r.requestDraw()
  }

  key(e: KeyboardEvent): void {
    if (e.key === ' ') { this.spaceDown = e.type === 'keydown'; return }
    if (e.type !== 'keydown') return
    if (e.key === 'Escape') { this.cancel(); this.r.selection.clear(); this.onSelectionChange(); return }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.r.selection.size) {
        this.store.commit()
        this.store.remove(this.r.selection)
        this.r.selection.clear()
        this.onSelectionChange()
      }
      return
    }
    if (e.key === 'Tab' && this.tool === 'stair') {
      e.preventDefault()
      const kinds: StairKind[] = ['straight', 'l', 'u', 'spiral']
      params.stair.kind = kinds[(kinds.indexOf(params.stair.kind) + 1) % kinds.length]
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
      f: 'furniture', e: 'equipment', p: 'planting', m: 'dimension', t: 'label', a: 'room'
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
      return [-1, 1].flatMap(sx => [-1, 1].map(sy =>
        add(ent.pos, rotate(pt(sx * 250, sy * 150), ent.rot))))
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
    for (const id of this.r.selection) {
      const ent = this.store.byId(id)
      if (!ent) continue
      if ('rot' in ent) (ent as { rot: number }).rot += Math.PI / 2
      else if (ent.type === 'opening') ent.flip = !ent.flip
      else if (ent.type === 'wall') {
        // 中点を軸に 90° 回転
        const c = pt((ent.a.x + ent.b.x) / 2, (ent.a.y + ent.b.y) / 2)
        const rot90 = (q: Pt): Pt => pt(c.x - (q.y - c.y), c.y + (q.x - c.x))
        ent.a = rot90(ent.a); ent.b = rot90(ent.b)
      } else if (ent.type === 'room') {
        const xs = ent.poly.map(q => q.x), ys = ent.poly.map(q => q.y)
        const c = pt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2)
        ent.poly = ent.poly.map(q => pt(c.x - (q.y - c.y), c.y + (q.x - c.x)))
      }
    }
    this.store.emit(); this.onSelectionChange()
  }

  /**
   * 現在のツールでワールド座標 p に配置する(2D クリック / 3D クリック共通)。
   * wallIdHint は 3D で壁を直接クリックした場合の建具配置先。
   */
  placeAt(p: Pt, opts: { shift?: boolean; wallId?: string } = {}): void {
    const sp = this.snapPoint(p)
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
          this.store.commit()
          this.store.add({
            id: uid(), type: 'wall', a: this.wallStart, b: q,
            thickness: params.wall.thickness, height: params.wall.height, structural: params.wall.structural
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
        if (this.roomPts.length >= 3 && dist(sp, this.roomPts[0]) < Math.max(300, 20 / this.r.vp.zoom)) {
          this.closeRoom()
        } else {
          this.roomPts.push(sp)
        }
        break
      }
    }
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
      case 'equipment':
        return [rotHandle(ent, 300 + 20 / this.r.vp.zoom)]
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
  private drawOverlay(ctx: CanvasRenderingContext2D, zoom: number): void {
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
    } else if (this.tool === 'room' && this.roomPts.length) {
      ctx.lineWidth = 1 / zoom
      ctx.beginPath()
      ctx.moveTo(this.roomPts[0].x, this.roomPts[0].y)
      for (const q of this.roomPts.slice(1)) ctx.lineTo(q.x, q.y)
      ctx.lineTo(c.x, c.y)
      ctx.stroke()
      // 各辺の寸法と現在の面積を表示
      ctx.globalAlpha = 1
      const pts = [...this.roomPts, c]
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
  }
}
