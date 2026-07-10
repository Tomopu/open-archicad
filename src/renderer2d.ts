// 2D 図面レンダラー — 再描画は要求時のみ(requestAnimationFrame 1回)。無駄な計算をしない。
import { Store, Wall, Opening, Entity } from './model'
import { Pt, sub, norm, perp, lerp, bbox, distToSeg, polyContains, lineIntersect, dist } from './geometry'
import * as sym from './symbols'

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

    if (this.showGrid) this.drawGrid(w, h)

    // ワールド座標系へ
    ctx.save()
    ctx.setTransform(dpr * vp.zoom, 0, 0, dpr * vp.zoom, -vp.view.x * vp.zoom * dpr, -vp.view.y * vp.zoom * dpr)

    const ents = this.store.doc.entities
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
  /** 端点 p が他の壁に接している場合、相手の厚みの半分(最大値)を返す。接していなければ 0 */
  private joinExt(p: Pt, self: Wall, walls: Wall[]): number {
    let ext = 0
    for (const w of walls) {
      if (w === self) continue
      if (distToSeg(p, w.a, w.b) < w.thickness / 2 + 1) ext = Math.max(ext, w.thickness / 2)
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
      // 鋭角すぎるマイターはスパイク防止のため不採用
      if (!X || dist(X, P) > Math.max(h, hO) * 4) return null
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
      case 'equipment': return { min: { x: e.pos.x - 450, y: e.pos.y - 250 }, max: { x: e.pos.x + 450, y: e.pos.y + 250 } }
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
