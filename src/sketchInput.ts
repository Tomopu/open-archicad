// 3D ビューと部品スタジオで共通の作図オーバーレイ。
// 2D と同じ「十字カーソル + スナップガイド + 青い寸法ラベル + モード切替アイコン」を 3D 空間に描く。
// 状態(点列など)は呼び出し側が持ち、ここは表示と軸ロック計算だけを担う(単一情報源)。
import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { Pt, pt, dist } from './geometry'

export interface SnapInfo { p: Pt; kind: string | null; guides: { a: Pt; b: Pt }[] }

/** 直前の点から X / Y(平面) 軸に平行な方向へ吸着(±4°)。SketchUp の軸ガイド */
export function axisLock(last: Pt | null, p: Pt): { p: Pt; axis: 'x' | 'y' | null } {
  if (!last) return { p, axis: null }
  const dx = p.x - last.x, dy = p.y - last.y
  if (Math.hypot(dx, dy) < 1) return { p, axis: null }
  const T = Math.tan((4 * Math.PI) / 180)
  if (Math.abs(dy) <= Math.abs(dx) * T) return { p: pt(p.x, last.y), axis: 'x' }
  if (Math.abs(dx) <= Math.abs(dy) * T) return { p: pt(last.x, p.y), axis: 'y' }
  return { p, axis: null }
}

export interface OverlayState {
  camera: THREE.Camera
  canvas: HTMLCanvasElement
  /** スナップ・軸ロック適用済みのカーソル(平面 mm) */
  cursor: Pt
  /** 描画面の高さ(シーン単位 m) */
  y: number
  /** 確定済みの点列(鉛筆) */
  pts?: Pt[]
  /** 長方形モードの始点 */
  rectStart?: Pt | null
  snap?: SnapInfo | null
  axis?: 'x' | 'y' | null
  /** 十字カーソルの色(既定 = 青、計測 = オレンジ) */
  color?: number
  /** 追加の寸法ラベル(青の数字)。位置は平面 mm */
  dims?: { text: string; at: Pt }[]
  /** 鉛筆 / 長方形のモードアイコン(2D と同じ)。undefined で非表示 */
  mode?: 'poly' | 'rect' | null
  /** 十字カーソルの腕の長さ mm(既定 120。部品スタジオは小さめ) */
  crossMm?: number
}

const BLUE = 0x2563eb
const GREEN = 0x16a34a
const GLYPH: Record<'poly' | 'rect', string> = {
  poly: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M4 20l1.2-4.2L16 5a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L8.2 18.8 4 20z"/><path d="M14.5 6.5l3 3"/></svg>',
  rect: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><rect x="4" y="7" width="16" height="10" rx="1"/></svg>'
}

export class SketchOverlay {
  group = new THREE.Group()
  /** 太い線(Line2)のマテリアル。resolution は update で設定 */
  private crossMat = new LineMaterial({ color: BLUE, linewidth: 2.5, depthTest: false })
  private liveMat = new LineMaterial({ color: BLUE, linewidth: 2.5, depthTest: false })
  private axisMats = {
    x: new LineMaterial({ color: 0xdc2626, linewidth: 2, transparent: true, opacity: 0.65, depthTest: false }),
    y: new LineMaterial({ color: 0x2563eb, linewidth: 2, transparent: true, opacity: 0.65, depthTest: false })
  }
  private crossA: Line2
  private crossB: Line2
  private live: Line2
  private rect: Line2
  private axisLine: Line2
  private guideGroup = new THREE.Group()
  private guideMat = new THREE.LineDashedMaterial({ color: GREEN, dashSize: 0.09, gapSize: 0.06, depthTest: false })
  private labelEls: HTMLDivElement[] = []
  private snapLabel: HTMLDivElement
  private modeBtn: HTMLButtonElement
  private modeGlyph: 'poly' | 'rect' | null = null
  /** モードアイコンをクリックしたとき(鉛筆 ⇄ 長方形) */
  onModeToggle: () => void = () => {}
  private mm: number

  constructor(private container: HTMLElement, mmToUnit = 1 / 1000) {
    this.mm = mmToUnit
    const mkL2 = (mat: LineMaterial): Line2 => {
      const l = new Line2(new LineGeometry(), mat)
      l.renderOrder = 998
      l.visible = false
      return l
    }
    this.crossA = mkL2(this.crossMat)
    this.crossB = mkL2(this.crossMat)
    this.live = mkL2(this.liveMat)
    this.rect = mkL2(this.liveMat)
    this.axisLine = mkL2(this.axisMats.x)
    this.group.add(this.crossA, this.crossB, this.live, this.rect, this.guideGroup, this.axisLine)
    this.group.visible = false
    this.snapLabel = document.createElement('div')
    this.snapLabel.className = 'dim3d snap3d'
    this.snapLabel.style.display = 'none'
    container.appendChild(this.snapLabel)
    // モード切替アイコン(2D と同じ青丸 + 白グリフ)
    this.modeBtn = document.createElement('button')
    this.modeBtn.className = 'mode3d'
    this.modeBtn.style.display = 'none'
    this.modeBtn.addEventListener('pointerdown', ev => ev.stopPropagation())
    this.modeBtn.addEventListener('click', ev => { ev.stopPropagation(); this.onModeToggle() })
    container.appendChild(this.modeBtn)
  }

  private toV = (p: Pt, y: number): number[] => [p.x * this.mm, y, p.y * this.mm]

  private setLine(l: Line2, pts: number[][]): void {
    l.geometry.dispose()
    const g = new LineGeometry()
    g.setPositions(pts.flat())
    l.geometry = g
    l.visible = true
  }

  private screen(camera: THREE.Camera, canvas: HTMLCanvasElement, p: Pt, y: number): { x: number; y: number } | null {
    const v = new THREE.Vector3(p.x * this.mm, y, p.y * this.mm)
    const pr = v.project(camera)
    if (pr.z > 1) return null
    const r = canvas.getBoundingClientRect()
    const host = this.container.getBoundingClientRect()
    return { x: ((pr.x + 1) / 2) * r.width + (r.left - host.left), y: ((1 - pr.y) / 2) * r.height + (r.top - host.top) }
  }

  /** 青い寸法ラベルを必要数だけ用意して配置 */
  private placeLabels(o: OverlayState, dims: { text: string; at: Pt }[]): void {
    while (this.labelEls.length < dims.length) {
      const d = document.createElement('div')
      d.className = 'dim3d'
      this.container.appendChild(d)
      this.labelEls.push(d)
    }
    this.labelEls.forEach((el, i) => {
      const dim = dims[i]
      if (!dim) { el.style.display = 'none'; return }
      const s = this.screen(o.camera, o.canvas, dim.at, o.y + 0.02)
      if (!s) { el.style.display = 'none'; return }
      el.textContent = dim.text
      el.style.display = 'block'
      el.style.left = `${s.x}px`
      el.style.top = `${s.y - 22}px`
    })
  }

  update(o: OverlayState): void {
    this.group.visible = true
    // Line2 の太さはピクセル指定: キャンバス解像度を渡す
    const r = o.canvas.getBoundingClientRect()
    for (const m of [this.crossMat, this.liveMat, this.axisMats.x, this.axisMats.y]) {
      m.resolution.set(r.width, r.height)
    }
    const y = o.y + 0.012
    const c = o.cursor
    // 十字カーソル(小さめ・太め)
    const s = o.crossMm ?? 120 // mm
    this.crossMat.color.setHex(o.color ?? BLUE)
    this.setLine(this.crossA, [this.toV(pt(c.x - s, c.y), y), this.toV(pt(c.x + s, c.y), y)])
    this.setLine(this.crossB, [this.toV(pt(c.x, c.y - s), y), this.toV(pt(c.x, c.y + s), y)])
    // ライブ描画線(鉛筆・部屋の多角形)
    const pts = o.pts ?? []
    const dims: { text: string; at: Pt }[] = [...(o.dims ?? [])]
    if (pts.length) {
      this.setLine(this.live, [...pts, c].map(q => this.toV(q, y)))
      const last = pts[pts.length - 1]
      const L = Math.round(dist(last, c))
      if (L > 1) dims.push({ text: `${L}`, at: pt((last.x + c.x) / 2, (last.y + c.y) / 2) })
    } else {
      this.live.visible = false
    }
    // 長方形プレビュー
    if (o.rectStart) {
      const a = o.rectStart
      this.setLine(this.rect, [
        this.toV(a, y), this.toV(pt(c.x, a.y), y), this.toV(c, y), this.toV(pt(a.x, c.y), y), this.toV(a, y)
      ])
      dims.push(
        { text: `${Math.round(Math.abs(c.x - a.x))}`, at: pt((a.x + c.x) / 2, a.y) },
        { text: `${Math.round(Math.abs(c.y - a.y))}`, at: pt(c.x, (a.y + c.y) / 2) }
      )
    } else {
      this.rect.visible = false
    }
    // スナップガイド(緑の点線)+ 種別ラベル
    this.guideGroup.children.forEach(g => (g as THREE.Line).geometry.dispose())
    this.guideGroup.clear()
    for (const g of o.snap?.guides ?? []) {
      const ln = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(...this.toV(g.a, y)), new THREE.Vector3(...this.toV(g.b, y))
        ]), this.guideMat)
      ln.computeLineDistances()
      ln.renderOrder = 996
      this.guideGroup.add(ln)
    }
    const kind = o.snap?.kind
    const sc = this.screen(o.camera, o.canvas, c, y)
    if (kind && kind !== 'グリッド' && sc) {
      this.snapLabel.textContent = kind
      this.snapLabel.style.display = 'block'
      this.snapLabel.style.left = `${sc.x + 12}px`
      this.snapLabel.style.top = `${sc.y + 8}px`
    } else {
      this.snapLabel.style.display = 'none'
    }
    // 軸平行ガイド(X = 赤 / 平面 Y = 青)
    const last = o.rectStart ?? (pts.length ? pts[pts.length - 1] : null)
    if (o.axis && last) {
      this.axisLine.material = this.axisMats[o.axis]
      const ext = 2000
      const dir = o.axis === 'x' ? pt(1, 0) : pt(0, 1)
      this.setLine(this.axisLine, [
        this.toV(pt(last.x - dir.x * ext, last.y - dir.y * ext), y),
        this.toV(pt(c.x + dir.x * ext, c.y + dir.y * ext), y)
      ])
    } else {
      this.axisLine.visible = false
    }
    // モードアイコン(2D と同じ: 現在のモードを表示、クリックで切替)
    if (o.mode && sc) {
      if (this.modeGlyph !== o.mode) {
        this.modeGlyph = o.mode
        this.modeBtn.innerHTML = GLYPH[o.mode]
        this.modeBtn.title = o.mode === 'poly' ? '鉛筆モード(クリックで長方形へ)' : '長方形モード(クリックで鉛筆へ)'
      }
      this.modeBtn.style.display = 'flex'
      this.modeBtn.style.left = `${sc.x + 22}px`
      this.modeBtn.style.top = `${sc.y - 42}px`
    } else {
      this.modeBtn.style.display = 'none'
    }
    this.placeLabels(o, dims)
  }

  hide(): void {
    this.group.visible = false
    this.snapLabel.style.display = 'none'
    this.modeBtn.style.display = 'none'
    for (const l of this.labelEls) l.style.display = 'none'
  }

  dispose(): void {
    this.group.traverse(obj => { if (obj instanceof THREE.Line) obj.geometry.dispose() })
    this.snapLabel.remove()
    this.modeBtn.remove()
    for (const l of this.labelEls) l.remove()
  }
}
