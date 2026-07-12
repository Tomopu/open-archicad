// 2D 図面レンダラー — 再描画は要求時のみ(requestAnimationFrame 1回)。無駄な計算をしない。
import { Store, Wall, Opening, Entity, isWindow, equipSize } from './model'
import { Pt, pt, sub, norm, perp, lerp, bbox, distToSeg, polyContains, lineIntersect, dist } from './geometry'
import * as sym from './symbols'

export type ElevDir = 'front' | 'back' | 'left' | 'right'
/** 立面図で使う壁 1 枚分の情報(階の床高さ mm 込み) */
interface ElevWall { w: Wall; floorY: number; level: number }
/** 立面図の視線方向: u = 画面右向きの平面ベクトル / v = 手前(視点)向き */
export const elevAxis = (dir: ElevDir): { u: Pt; v: Pt } => ({
  front: { u: pt(1, 0), v: pt(0, 1) },    // 南から(平面図の下から)見る
  back: { u: pt(-1, 0), v: pt(0, -1) },   // 北から
  right: { u: pt(0, -1), v: pt(1, 0) },   // 東から(右側面)
  left: { u: pt(0, 1), v: pt(-1, 0) }     // 西から(左側面)
}[dir])
/** 立面図に投影した壁(座標: x = 立面の横位置 mm / y = -高さ mm) */
export interface ElevWallProj {
  w: Wall; level: number; floorY: number
  ua: number; ub: number; y0: number; y1: number
  /** 立面に正対しているか(建具を描く対象) */
  facing: boolean
  depth: number
}
export interface ElevOpenProj {
  o: Opening; wall: ElevWallProj
  x0: number; x1: number; y0: number; y1: number
}

export class Viewport {
  zoom = 0.08          // px / mm
  view: Pt = { x: -3600, y: -1500 }  // 画面左上のワールド座標
  toScreen(p: Pt): Pt { return { x: (p.x - this.view.x) * this.zoom, y: (p.y - this.view.y) * this.zoom } }
  toWorld(s: Pt): Pt { return { x: s.x / this.zoom + this.view.x, y: s.y / this.zoom + this.view.y } }
}

export class Renderer2D {
  ctx: CanvasRenderingContext2D
  vp = new Viewport()
  selection = new Set<string>()
  /** リーガルチェック結果の要素ハイライト(id → 注意/不適合) */
  legalHighlights = new Map<string, 'warn' | 'error'>()
  /** ツールのプレビュー描画フック(ワールド座標系で呼ばれる) */
  overlay: ((ctx: CanvasRenderingContext2D, zoom: number) => void) | null = null
  /** 再描画後フック(選択オブジェクトのアクションアイコン追従などに使用) */
  onAfterDraw: (() => void) | null = null
  showGrid = true
  /** グリッド幅 mm(主グリッド。半分の位置に補助線も描く) */
  gridStep = 910
  /** 壁の基準線(通り芯)を表示 */
  showRefLine = true
  /** スケッチのサブ選択(面・閉路・辺)。ツール側から設定 */
  sketchSub: { id: string; mode: 'face' | 'loop' | 'edge'; faceIdx?: number; edgeIdx?: number } | null = null
  /** 閉路選択中にホバーしている辺(強調表示) */
  sketchHover: { id: string; edgeIdx: number } | null = null
  /** 立面図モード(正面・背面・左右側面)。null = 平面図 */
  elevation: { dir: ElevDir; cluster: number } | null = null
  /** 下階を透かして表示(2階以上で編集するときの位置合わせ用) */
  showGhost = true
  /** 壁厚の自動表記(t=120)を表示 */
  showWallT = true
  private dirty = false

  constructor(public canvas: HTMLCanvasElement, public store: Store) {
    this.ctx = canvas.getContext('2d')!
    new ResizeObserver(() => this.requestDraw()).observe(canvas)
    store.onChange(() => this.requestDraw())
  }

  requestDraw(): void {
    if (this.dirty) return
    this.dirty = true
    requestAnimationFrame(() => { this.dirty = false; this.draw() })
  }

  draw(): void {
    const { canvas, ctx, vp } = this
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth, h = canvas.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)

    // 立面図モード: 平面図の代わりに選択中の建物の立面を描く
    if (this.elevation) {
      if (this.showGrid) this.drawGrid(w, h)
      ctx.save()
      ctx.setTransform(dpr * vp.zoom, 0, 0, dpr * vp.zoom, -vp.view.x * vp.zoom * dpr, -vp.view.y * vp.zoom * dpr)
      this.drawElevation()
      ctx.restore()
      if (this.onAfterDraw) this.onAfterDraw()
      return
    }

    if (this.showGrid) this.drawGrid(w, h)

    // ワールド座標系へ
    ctx.save()
    ctx.setTransform(dpr * vp.zoom, 0, 0, dpr * vp.zoom, -vp.view.x * vp.zoom * dpr, -vp.view.y * vp.zoom * dpr)

    const ents = this.store.doc.entities.filter(e => !e.hidden)
    const walls = new Map<string, Wall>()
    for (const e of ents) if (e.type === 'wall') walls.set(e.id, e)

    // 下階の透かし(壁・柱・階段のみ薄く描く)
    const below = this.showGhost ? this.store.levelBelow() : null
    if (below) {
      ctx.save()
      ctx.globalAlpha = 0.16
      this.drawWalls(below.filter((e): e is Wall => e.type === 'wall'))
      for (const e of below) {
        if (e.type === 'column') sym.drawColumn(ctx, e, vp.zoom)
        else if (e.type === 'stair') sym.drawStair(ctx, e, vp.zoom)
      }
      ctx.restore()
    }

    // 描画順: 部屋 → 壁 → 柱 → 建具 → その他
    // 入れ子の部屋は外側の部屋の面積から差し引き、ラベルも重ならない位置に置く
    const roomsL = ents.filter((e): e is import('./model').Room => e.type === 'room')
    for (const e of roomsL) {
      const holes = roomsL.filter(o => o !== e && polyContains(e.poly, o.poly)).map(o => o.poly)
      sym.drawRoom(ctx, e, vp.zoom, holes)
    }
    this.drawWalls(ents.filter((e): e is Wall => e.type === 'wall'))
    for (const e of ents) if (e.type === 'column') sym.drawColumn(ctx, e, vp.zoom)
    for (const e of ents) if (e.type === 'custom') sym.drawCustom(ctx, e, vp.zoom)
    for (const e of ents) if (e.type === 'opening') {
      const wl = walls.get(e.wallId); if (wl) sym.drawOpening(ctx, e, wl, vp.zoom)
    }
    for (const e of ents) {
      if (e.type === 'stair') sym.drawStair(ctx, e, vp.zoom)
      else if (e.type === 'furniture') sym.drawFurniture(ctx, e, vp.zoom)
      else if (e.type === 'equipment') sym.drawEquipment(ctx, e, vp.zoom)
      else if (e.type === 'planting') sym.drawPlanting(ctx, e, vp.zoom)
      else if (e.type === 'dimension') sym.drawDimension(ctx, e, vp.zoom)
      else if (e.type === 'label') sym.drawLabel(ctx, e)
      else if (e.type === 'sketch') {
        sym.drawSketch(ctx, e, vp.zoom, this.sketchSub?.id === e.id ? this.sketchSub : null,
          this.sketchHover?.id === e.id ? this.sketchHover.edgeIdx : null)
      }
    }

    // リーガルチェックのハイライト(注意=黄 / 不適合=赤 の半透明塗り)
    if (this.legalHighlights.size) {
      for (const [id, level] of this.legalHighlights) {
        const e = this.store.byId(id)
        if (!e) continue
        ctx.fillStyle = level === 'error' ? 'rgba(239, 68, 68, 0.30)' : 'rgba(250, 204, 21, 0.35)'
        this.fillEntityShape(e, walls)
      }
    }

    // 選択ハイライト
    if (this.selection.size) {
      ctx.strokeStyle = '#2563eb'
      ctx.lineWidth = 1.6 / vp.zoom
      ctx.setLineDash([120 , 80])
      for (const id of this.selection) {
        const e = this.store.byId(id)
        if (e) this.strokeEntityBounds(e, walls)
      }
      ctx.setLineDash([])
    }

    if (this.overlay) this.overlay(ctx, vp.zoom)
    ctx.restore()
    if (this.onAfterDraw) this.onAfterDraw()
  }

  /**
   * 壁の 2 パス描画。
   * 1 パス目: アウトライン色で少し太らせて塗る / 2 パス目: 本体色で塗る。
   * 端点が他の壁に接している場合は厚さの半分だけ延長して塗るため、
   * L 字・T 字の接合部が欠けたり二重線になったりしない。
   */
  /** 端点同士の接合(角)のマイター情報: 相手の方向と半厚 */
  private miterInfo(walls: Wall[]): Map<Wall, { a?: { uOut: Pt; hO: number }; b?: { uOut: Pt; hO: number } }> {
    const map = new Map<Wall, { a?: { uOut: Pt; hO: number }; b?: { uOut: Pt; hO: number } }>()
    const TOL = 5
    for (const w of walls) {
      const info: { a?: { uOut: Pt; hO: number }; b?: { uOut: Pt; hO: number } } = {}
      for (const end of ['a', 'b'] as const) {
        const P = w[end]
        const dSelf = norm(sub(w.b, w.a))
        let partner: { uOut: Pt; hO: number } | null = null
        let count = 0
        for (const o of walls) {
          if (o === w) continue
          for (const oe of ['a', 'b'] as const) {
            if (dist(P, o[oe]) < TOL) {
              count++
              const other = oe === 'a' ? o.b : o.a
              const uOut = norm(sub(other, P))
              // 平行(一直線)は対象外
              if (Math.abs(dSelf.x * uOut.y - dSelf.y * uOut.x) > 0.08) {
                partner = { uOut, hO: o.thickness / 2 }
              }
            }
          }
        }
        if (count === 1 && partner) info[end] = partner // 2本の壁が角で出会う場合のみマイター
      }
      map.set(w, info)
    }
    return map
  }

  private drawWalls(walls: Wall[]): void {
    const { ctx, vp } = this
    const outline = 1.2 / vp.zoom
    // 延長量 = 接している「相手の壁」の厚みの半分(厚みが違う壁同士でも段差・欠けが出ない)
    const joined = walls.map(w => [this.joinExt(w.a, w, walls), this.joinExt(w.b, w, walls)] as const)
    const miters = this.miterInfo(walls)
    // パス1: アウトライン
    ctx.fillStyle = '#1f2937'
    walls.forEach((w, i) => this.fillWallQuad(w, joined[i][0], joined[i][1], outline, miters.get(w)))
    // パス2: 本体(非構造 → 構造の順で、構造壁の濃色を上に)。単色指定があればその色
    walls.forEach((w, i) => {
      if (w.structural) return
      ctx.fillStyle = w.color ?? '#f4f4f5'
      this.fillWallQuad(w, joined[i][0], joined[i][1], 0, miters.get(w))
    })
    walls.forEach((w, i) => {
      if (!w.structural) return
      ctx.fillStyle = w.color ?? '#374151'
      this.fillWallQuad(w, joined[i][0], joined[i][1], 0, miters.get(w))
    })

    // 基準線(通り芯): 壁の中心線 + refOff の位置に一点鎖線。両端を少し延長して描く
    if (this.showRefLine) {
      ctx.save()
      ctx.strokeStyle = '#b6bcc6'
      ctx.lineWidth = 0.7 / vp.zoom
      ctx.setLineDash([420 , 120, 50, 120])
      for (const w of walls) {
        const d = norm(sub(w.b, w.a)), n = perp(d)
        const off = w.refOff ?? 0
        const ext = 300
        ctx.beginPath()
        ctx.moveTo(w.a.x + n.x * off - d.x * ext, w.a.y + n.y * off - d.y * ext)
        ctx.lineTo(w.b.x + n.x * off + d.x * ext, w.b.y + n.y * off + d.y * ext)
        ctx.stroke()
      }
      ctx.setLineDash([])
      ctx.restore()
    }

    // 壁厚の表記(t=120)。ズームが十分なときだけ、壁の脇に沿って小さく描く
    if (this.showWallT && vp.zoom * 300 > 14) {
      ctx.save()
      ctx.fillStyle = '#9ca3af'
      for (const w of walls) {
        const len = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)
        if (len * vp.zoom < 60) continue // 短すぎる壁は省略
        const d = norm(sub(w.b, w.a)), n = perp(d)
        let ang = Math.atan2(d.y, d.x)
        if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI
        const mx = (w.a.x + w.b.x) / 2 + n.x * (w.thickness / 2 + 11 / vp.zoom)
        const my = (w.a.y + w.b.y) / 2 + n.y * (w.thickness / 2 + 11 / vp.zoom)
        ctx.save()
        ctx.translate(mx, my); ctx.rotate(ang)
        ctx.font = `${10 / vp.zoom}px sans-serif`
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(`t=${w.thickness}`, 0, 0)
        ctx.restore()
      }
      ctx.restore()
    }
  }
  /** 端点 p が他の壁に接している場合の延長量。
   *  相手の壁からはみ出さないよう交差角で制限(斜め壁が「勝手に伸びた」ように見えない) */
  private joinExt(p: Pt, self: Wall, walls: Wall[]): number {
    const ds = norm(sub(self.b, self.a))
    let ext = 0
    for (const w of walls) {
      if (w === self || distToSeg(p, w.a, w.b) >= w.thickness / 2 + 1) continue
      const dw = norm(sub(w.b, w.a))
      const c = Math.abs(ds.x * dw.y - ds.y * dw.x) // sin(交差角)
      const k = Math.abs(ds.x * dw.x + ds.y * dw.y) // cos(交差角)
      if (c <= 0.25) continue // ほぼ平行は延長しない
      const safe = Math.max(0, (w.thickness / 2 - (self.thickness / 2) * k) / c)
      ext = Math.max(ext, Math.min(w.thickness / 2, safe))
    }
    return ext
  }
  private fillWallQuad(
    w: Wall, extA: number, extB: number, grow: number,
    miter?: { a?: { uOut: Pt; hO: number }; b?: { uOut: Pt; hO: number } }
  ): void {
    const { ctx } = this
    const d = norm(sub(w.b, w.a)), n = perp(d)
    const h = w.thickness / 2 + grow
    const ea = extA + grow
    const eb = extB + grow
    // 既定は矩形 + 端の延長
    let aPlus: Pt = { x: w.a.x - d.x * ea + n.x * h, y: w.a.y - d.y * ea + n.y * h }
    let aMinus: Pt = { x: w.a.x - d.x * ea - n.x * h, y: w.a.y - d.y * ea - n.y * h }
    let bPlus: Pt = { x: w.b.x + d.x * eb + n.x * h, y: w.b.y + d.y * eb + n.y * h }
    let bMinus: Pt = { x: w.b.x + d.x * eb - n.x * h, y: w.b.y + d.y * eb - n.y * h }
    // 角(端点同士の接合)はマイター: 双方の側面の交点を頂点にする(斜め接合でもズレない)
    const mcorner = (P: Pt, uIn: Pt, m: { uOut: Pt; hO: number }, s: number): Pt | null => {
      const nW = perp(uIn), nO = perp(m.uOut)
      const hO = m.hO + grow
      const X = lineIntersect(
        { x: P.x + nW.x * h * s, y: P.y + nW.y * h * s }, uIn,
        { x: P.x + nO.x * hO * s, y: P.y + nO.y * hO * s }, m.uOut)
      if (!X) return null
      // 鋭角のマイターは伸びすぎるため、限界長で切ってベベル(三角形の壁の先端も綺麗に収まる)
      const lim = Math.max(h, hO) * 4
      const dx = dist(X, P)
      if (dx > lim) return { x: P.x + ((X.x - P.x) / dx) * lim, y: P.y + ((X.y - P.y) / dx) * lim }
      return X
    }
    if (miter?.a) {
      const uIn = { x: -d.x, y: -d.y }
      const cPlus = mcorner(w.a, uIn, miter.a, -1)  // uIn 系の -1 = クアッドの +n 側
      const cMinus = mcorner(w.a, uIn, miter.a, 1)
      if (cPlus && cMinus) { aPlus = cPlus; aMinus = cMinus }
    }
    if (miter?.b) {
      const cPlus = mcorner(w.b, d, miter.b, 1)
      const cMinus = mcorner(w.b, d, miter.b, -1)
      if (cPlus && cMinus) { bPlus = cPlus; bMinus = cMinus }
    }
    ctx.beginPath()
    ctx.moveTo(aPlus.x, aPlus.y)
    ctx.lineTo(bPlus.x, bPlus.y)
    ctx.lineTo(bMinus.x, bMinus.y)
    ctx.lineTo(aMinus.x, aMinus.y)
    ctx.closePath()
    ctx.fill()
  }

  // ---------------- 立面図(正面・背面・左右側面) ----------------
  /**
   * 建物クラスタ: 全階の壁を端点の接触でグループ化(複数棟の判定)。
   * 各壁はその階の床高さ(mm)付き。
   */
  buildingClusters(): ElevWall[][] {
    const all: ElevWall[] = []
    let yBase = 0
    this.store.doc.levels.forEach((level, li) => {
      const floorY = yBase + 100 // スラブ上面(FLOOR_T = 100mm)
      for (const e of level.entities) {
        if (e.type === 'wall' && !e.hidden) all.push({ w: e, floorY, level: li })
      }
      const walls = level.entities.filter((e): e is Wall => e.type === 'wall')
      yBase += level.height && level.height > 0
        ? level.height
        : Math.max(2400, ...walls.map(w => w.height)) + 100
    })
    // Union-Find で接触する壁をまとめる(XY 平面のみ。階をまたいでも同じ建物)
    const parent = all.map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
    const union = (a: number, b: number): void => { parent[find(a)] = find(b) }
    const touch = (a: Wall, b: Wall): boolean => {
      const tol = (a.thickness + b.thickness) / 2 + 50
      return [a.a, a.b].some(p => distToSeg(p, b.a, b.b) < tol) ||
        [b.a, b.b].some(p => distToSeg(p, a.a, a.b) < tol)
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (touch(all[i].w, all[j].w)) union(i, j)
      }
    }
    const groups = new Map<number, ElevWall[]>()
    all.forEach((ew, i) => {
      const r = find(i)
      if (!groups.has(r)) groups.set(r, [])
      groups.get(r)!.push(ew)
    })
    // 大きい順(まず母屋、次に離れなど)
    return [...groups.values()].sort((a, b) => b.length - a.length)
  }

  /** 選択中の建物の壁を立面図へ投影(奥 → 手前の順)。編集(ヒットテスト・ドラッグ)と描画で共用 */
  elevWalls(): ElevWallProj[] {
    const elev = this.elevation
    if (!elev) return []
    const clusters = this.buildingClusters()
    if (!clusters.length) return []
    const walls = clusters[Math.min(elev.cluster, clusters.length - 1)]
    const { u, v } = elevAxis(elev.dir)
    const U = (p: Pt): number => p.x * u.x + p.y * u.y
    const D = (p: Pt): number => p.x * v.x + p.y * v.y
    const out: ElevWallProj[] = walls.map(ew => {
      const { w } = ew
      let ua = U(w.a), ub = U(w.b)
      if (ua > ub) [ua, ub] = [ub, ua]
      // 端から見た壁(視線と平行)は厚み分の細い帯として見える
      if (ub - ua < w.thickness) { const c = (ua + ub) / 2; ua = c - w.thickness / 2; ub = c + w.thickness / 2 }
      const facing = Math.abs((w.b.x - w.a.x) * u.x + (w.b.y - w.a.y) * u.y) /
        Math.max(1, dist(w.a, w.b)) > 0.7
      return {
        w, level: ew.level, floorY: ew.floorY,
        ua, ub,
        // 壁はスラブ(100mm)を貫通して階の底まで届く = 1F は GL に接する
        y0: -(ew.floorY - 100),
        y1: -(ew.floorY + w.height),
        facing,
        depth: D(lerp(w.a, w.b, 0.5))
      }
    })
    return out.sort((a, b) => a.depth - b.depth)
  }
  /** 正対する壁に載っている建具の投影 */
  elevOpenings(): ElevOpenProj[] {
    const elev = this.elevation
    if (!elev) return []
    const { u } = elevAxis(elev.dir)
    const U = (p: Pt): number => p.x * u.x + p.y * u.y
    const byWall = new Map<string, Opening[]>()
    for (const level of this.store.doc.levels) {
      for (const e of level.entities) {
        if (e.type !== 'opening' || e.hidden) continue
        const arr = byWall.get(e.wallId) ?? []
        arr.push(e)
        byWall.set(e.wallId, arr)
      }
    }
    const out: ElevOpenProj[] = []
    for (const wp of this.elevWalls()) {
      if (!wp.facing) continue
      for (const o of byWall.get(wp.w.id) ?? []) {
        const cU = U(lerp(wp.w.a, wp.w.b, o.t))
        const sill = isWindow(o.kind) ? o.sill : 0
        out.push({
          o, wall: wp,
          x0: cU - o.width / 2, x1: cU + o.width / 2,
          y0: -(wp.floorY + sill), y1: -(wp.floorY + o.head)
        })
      }
    }
    return out
  }

  /** 立面図を開いたとき、建物が画面中央に収まるようにフィット */
  fitElevation(): void {
    const walls = this.elevWalls()
    if (!walls.length) return
    let minU = Infinity, maxU = -Infinity, minY = Infinity
    for (const w of walls) {
      minU = Math.min(minU, w.ua); maxU = Math.max(maxU, w.ub)
      minY = Math.min(minY, w.y1)
    }
    const w = Math.max(1000, maxU - minU)
    const h = Math.max(1000, -minY)
    const cw = this.canvas.clientWidth || 800, ch = this.canvas.clientHeight || 600
    this.vp.zoom = Math.max(0.004, Math.min(3, Math.min(cw / (w * 1.35), ch / (h * 1.8))))
    this.vp.view = {
      x: (minU + maxU) / 2 - cw / (2 * this.vp.zoom),
      y: (minY / 2) - ch / (2 * this.vp.zoom)
    }
    this.requestDraw()
  }

  /**
   * 選択中の建物の立面図を描く(ワールド座標: x = 立面の横位置 mm / y = -高さ mm)。
   * 奥の壁から手前の壁の順に白塗り+輪郭で描く簡易陰線処理。選択中はハイライト+上端に高さつまみ。
   */
  private drawElevation(): void {
    const { ctx, vp } = this
    const walls = this.elevWalls()
    if (!walls.length) {
      ctx.fillStyle = '#9ca3af'
      ctx.font = `${16 / vp.zoom}px sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText('壁がありません(立面図は壁から生成されます)', vp.view.x + 4000, vp.view.y + 3000)
      return
    }
    const opens = this.elevOpenings()
    const INK = '#1f2937'
    let minU = Infinity, maxU = -Infinity
    for (const wp of walls) { minU = Math.min(minU, wp.ua); maxU = Math.max(maxU, wp.ub) }
    // 同じ高さ範囲の壁はひとつのシルエットにマージして描く(接合部の縦線・段差を消す)
    const groups = new Map<string, { y0: number; y1: number; ivs: { x0: number; x1: number }[] }>()
    for (const wp of walls) {
      const key = `${Math.round(wp.y0)}:${Math.round(wp.y1)}`
      if (!groups.has(key)) groups.set(key, { y0: wp.y0, y1: wp.y1, ivs: [] })
      groups.get(key)!.ivs.push({ x0: wp.ua, x1: wp.ub })
    }
    ctx.lineWidth = 1.2 / vp.zoom
    for (const g of groups.values()) {
      g.ivs.sort((a, b) => a.x0 - b.x0)
      const merged: { x0: number; x1: number }[] = []
      for (const iv of g.ivs) {
        const last = merged[merged.length - 1]
        if (last && iv.x0 <= last.x1 + 1) last.x1 = Math.max(last.x1, iv.x1)
        else merged.push({ ...iv })
      }
      for (const m of merged) {
        ctx.fillStyle = '#fafafa'
        ctx.strokeStyle = INK
        ctx.fillRect(m.x0, g.y1, m.x1 - m.x0, g.y0 - g.y1)
        ctx.strokeRect(m.x0, g.y1, m.x1 - m.x0, g.y0 - g.y1)
      }
    }
    for (const wp of walls) {
      // この壁の建具
      for (const op of opens) {
        if (op.wall.w.id !== wp.w.id) continue
        const { o } = op
        ctx.fillStyle = isWindow(o.kind) ? '#eaf3fb' : '#f3ede2'
        ctx.fillRect(op.x0, op.y1, op.x1 - op.x0, op.y0 - op.y1)
        ctx.lineWidth = 1 / vp.zoom
        ctx.strokeRect(op.x0, op.y1, op.x1 - op.x0, op.y0 - op.y1)
        ctx.lineWidth = 0.6 / vp.zoom
        if (isWindow(o.kind)) {
          ctx.beginPath()
          ctx.moveTo((op.x0 + op.x1) / 2, op.y1); ctx.lineTo((op.x0 + op.x1) / 2, op.y0)
          ctx.moveTo(op.x0, (op.y0 + op.y1) / 2); ctx.lineTo(op.x1, (op.y0 + op.y1) / 2)
          ctx.stroke()
        } else {
          ctx.beginPath()
          ctx.arc(op.x1 - 120, (op.y0 + op.y1) / 2, 40, 0, Math.PI * 2)
          ctx.stroke()
        }
        if (this.selection.has(o.id)) {
          ctx.save()
          ctx.strokeStyle = '#2563eb'
          ctx.lineWidth = 1.8 / vp.zoom
          ctx.setLineDash([120, 80])
          ctx.strokeRect(op.x0, op.y1, op.x1 - op.x0, op.y0 - op.y1)
          ctx.setLineDash([])
          ctx.restore()
        }
      }
      // 選択ハイライト + 上端の高さつまみ
      if (this.selection.has(wp.w.id)) {
        ctx.save()
        ctx.strokeStyle = '#2563eb'
        ctx.lineWidth = 1.8 / vp.zoom
        ctx.setLineDash([120, 80])
        ctx.strokeRect(wp.ua, wp.y1, wp.ub - wp.ua, wp.y0 - wp.y1)
        ctx.setLineDash([])
        const hs = 5.5 / vp.zoom
        ctx.fillStyle = '#2563eb'
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.6 / vp.zoom
        ctx.beginPath()
        ctx.rect((wp.ua + wp.ub) / 2 - hs, wp.y1 - hs, hs * 2, hs * 2)
        ctx.fill(); ctx.stroke()
        ctx.restore()
      }
    }
    // 地盤線(GL)
    ctx.strokeStyle = INK
    ctx.lineWidth = 2.2 / vp.zoom
    ctx.beginPath()
    ctx.moveTo(minU - 1200, 0); ctx.lineTo(maxU + 1200, 0)
    ctx.stroke()
  }

  /** リーガルハイライト用に要素の実形状を塗る */
  private fillEntityShape(e: Entity, walls: Map<string, Wall>): void {
    const { ctx } = this
    if (e.type === 'room') {
      ctx.beginPath()
      e.poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath(); ctx.fill()
    } else if (e.type === 'wall') {
      this.fillWallQuad(e, 0, 0, 0)
    } else {
      const b = this.entityBounds(e, walls)
      if (b) ctx.fillRect(b.min.x, b.min.y, b.max.x - b.min.x, b.max.y - b.min.y)
    }
  }

  private drawGrid(w: number, h: number): void {
    const { ctx, vp } = this
    // 線はデバイスピクセルに揃えて描き、ズームによる見かけのズレ(にじみ)を防ぐ
    const lines = (step: number, color: string): void => {
      const px = step * vp.zoom
      if (px < 9) return
      const x0 = Math.floor(vp.view.x / step) * step
      const y0 = Math.floor(vp.view.y / step) * step
      ctx.beginPath()
      for (let x = x0; (x - vp.view.x) * vp.zoom < w; x += step) {
        const sx = Math.round((x - vp.view.x) * vp.zoom) + 0.5
        ctx.moveTo(sx, 0); ctx.lineTo(sx, h)
      }
      for (let y = y0; (y - vp.view.y) * vp.zoom < h; y += step) {
        const sy = Math.round((y - vp.view.y) * vp.zoom) + 0.5
        ctx.moveTo(0, sy); ctx.lineTo(w, sy)
      }
      ctx.strokeStyle = color; ctx.lineWidth = 1
      ctx.stroke()
    }
    lines(this.gridStep / 2, '#f7f7f7')  // 補助グリッド(スナップ既定値と同じ半グリッド)
    lines(this.gridStep, '#ececec')      // 主グリッド
    // 原点十字
    const o = vp.toScreen({ x: 0, y: 0 })
    ctx.strokeStyle = '#d4d4d8'
    ctx.beginPath()
    ctx.moveTo(o.x - 12, o.y); ctx.lineTo(o.x + 12, o.y)
    ctx.moveTo(o.x, o.y - 12); ctx.lineTo(o.x, o.y + 12)
    ctx.stroke()
  }

  entityBounds(e: Entity, walls: Map<string, Wall>): { min: Pt; max: Pt } | null {
    const m = 120
    switch (e.type) {
      case 'wall': {
        const b = bbox([e.a, e.b])
        return { min: { x: b.min.x - e.thickness, y: b.min.y - e.thickness }, max: { x: b.max.x + e.thickness, y: b.max.y + e.thickness } }
      }
      case 'opening': {
        const wl = walls.get(e.wallId); if (!wl) return null
        const { c, ang } = sym.openingCenter(e, wl)
        const d = { x: Math.cos(ang), y: Math.sin(ang) }, n = perp(d)
        const hw = e.width / 2, ht = wl.thickness / 2 + m
        return bbox([
          { x: c.x - d.x * hw - n.x * ht, y: c.y - d.y * hw - n.y * ht },
          { x: c.x + d.x * hw + n.x * ht, y: c.y + d.y * hw + n.y * ht },
          { x: c.x - d.x * hw + n.x * ht, y: c.y - d.y * hw + n.y * ht },
          { x: c.x + d.x * hw - n.x * ht, y: c.y + d.y * hw - n.y * ht }
        ])
      }
      case 'stair': {
        let w = 0, h = 0
        if (e.kind === 'straight') { w = e.treads * e.tread; h = e.width }
        else if (e.kind === 'l') { w = Math.floor(e.treads / 2) * e.tread + e.width; h = e.width + (e.treads - Math.floor(e.treads / 2)) * e.tread }
        else if (e.kind === 'u') { w = Math.ceil((e.treads - 1) / 2) * e.tread + e.width; h = e.width * 2 }
        else return { min: { x: e.pos.x - e.width, y: e.pos.y - e.width }, max: { x: e.pos.x + e.width, y: e.pos.y + e.width } }
        return this.rotBounds(e.pos, e.rot, 0, 0, w, h)
      }
      case 'furniture': return this.rotBounds(e.pos, e.rot, -e.w / 2, -e.d / 2, e.w, e.d)
      case 'column': return this.rotBounds(e.pos, e.rot, -e.w / 2, -e.d / 2, e.w, e.d)
      case 'custom': return this.rotBounds(e.pos, e.rot, -e.w / 2, -e.d / 2, e.w, e.d)
      case 'equipment': {
        const s = equipSize(e)
        return this.rotBounds(e.pos, e.rot, -s.w / 2, -s.d / 2, s.w, s.d)
      }
      case 'planting': {
        const r = e.kind === 'tree' ? Math.max(400, e.height / 4) : e.kind === 'shrub' ? Math.max(250, e.height / 3) : 260
        return { min: { x: e.pos.x - r, y: e.pos.y - r }, max: { x: e.pos.x + r, y: e.pos.y + r } }
      }
      case 'dimension': {
        const d = norm(sub(e.b, e.a)), n = perp(d)
        return bbox([e.a, e.b, { x: e.a.x + n.x * e.offset, y: e.a.y + n.y * e.offset }, { x: e.b.x + n.x * e.offset, y: e.b.y + n.y * e.offset }])
      }
      case 'label': {
        const w2 = e.text.length * e.size * 0.55, h2 = e.size * 0.7
        return { min: { x: e.pos.x - w2, y: e.pos.y - h2 }, max: { x: e.pos.x + w2, y: e.pos.y + h2 } }
      }
      case 'room': return bbox(e.poly)
      case 'sketch': {
        if (!e.edges.length) return null
        return bbox(e.edges.flatMap(ed => [ed.a, ed.b]))
      }
    }
  }

  private rotBounds(pos: Pt, rot: number, x: number, y: number, w: number, h: number): { min: Pt; max: Pt } {
    const c = Math.cos(rot), s = Math.sin(rot)
    const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([px, py]) => ({
      x: pos.x + px * c - py * s, y: pos.y + px * s + py * c
    }))
    return bbox(pts)
  }

  private strokeEntityBounds(e: Entity, walls: Map<string, Wall>): void {
    const b = this.entityBounds(e, walls)
    if (!b) return
    const m = 60
    this.ctx.strokeRect(b.min.x - m, b.min.y - m, b.max.x - b.min.x + m * 2, b.max.y - b.min.y + m * 2)
  }
}
