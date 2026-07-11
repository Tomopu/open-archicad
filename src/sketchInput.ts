// 3D ビューと部品スタジオで共通の作図オーバーレイ。
// 2D と同じ「十字カーソル + スナップガイド + 青い寸法ラベル」を 3D 空間に描く。
// 状態(点列など)は呼び出し側が持ち、ここは表示と軸ロック計算だけを担う(単一情報源)。
import * as THREE from 'three'
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
}

const BLUE = 0x2563eb
const GREEN = 0x16a34a

export class SketchOverlay {
  group = new THREE.Group()
  private cross: THREE.LineSegments
  private crossMat = new THREE.LineBasicMaterial({ color: BLUE, depthTest: false })
  private live: THREE.Line
  private rect: THREE.LineLoop
  private guideGroup = new THREE.Group()
  private guideMat = new THREE.LineDashedMaterial({ color: GREEN, dashSize: 0.09, gapSize: 0.06, depthTest: false })
  private axisMats = {
    x: new THREE.LineBasicMaterial({ color: 0xdc2626, transparent: true, opacity: 0.6, depthTest: false }),
    y: new THREE.LineBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.6, depthTest: false })
  }
  private axisLine: THREE.Line
  private labelEls: HTMLDivElement[] = []
  private snapLabel: HTMLDivElement
  private mm: number

  constructor(private container: HTMLElement, mmToUnit = 1 / 1000) {
    this.mm = mmToUnit
    const mkLine = <T extends THREE.Line>(L: new (g: THREE.BufferGeometry, m: THREE.Material) => T, mat: THREE.Material): T => {
      const l = new L(new THREE.BufferGeometry(), mat)
      l.renderOrder = 997
      return l
    }
    this.cross = new THREE.LineSegments(new THREE.BufferGeometry(), this.crossMat)
    this.cross.renderOrder = 999
    this.live = mkLine(THREE.Line, new THREE.LineBasicMaterial({ color: BLUE, depthTest: false }))
    this.rect = mkLine(THREE.LineLoop, new THREE.LineBasicMaterial({ color: BLUE, depthTest: false }))
    this.axisLine = mkLine(THREE.Line, this.axisMats.x)
    this.group.add(this.cross, this.live, this.rect, this.guideGroup, this.axisLine)
    this.group.visible = false
    this.snapLabel = document.createElement('div')
    this.snapLabel.className = 'dim3d snap3d'
    this.snapLabel.style.display = 'none'
    container.appendChild(this.snapLabel)
  }

  private toV = (p: Pt, y: number): THREE.Vector3 => new THREE.Vector3(p.x * this.mm, y, p.y * this.mm)

  private screen(camera: THREE.Camera, canvas: HTMLCanvasElement, v: THREE.Vector3): { x: number; y: number } | null {
    const pr = v.clone().project(camera)
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
      const s = this.screen(o.camera, o.canvas, this.toV(dim.at, o.y + 0.02))
      if (!s) { el.style.display = 'none'; return }
      el.textContent = dim.text
      el.style.display = 'block'
      el.style.left = `${s.x}px`
      el.style.top = `${s.y - 22}px`
    })
  }

  update(o: OverlayState): void {
    this.group.visible = true
    const y = o.y + 0.012
    const c = o.cursor
    // 十字カーソル(2D と同じ見た目)
    const s = 220 // mm
    this.crossMat.color.setHex(o.color ?? BLUE)
    this.cross.geometry.setFromPoints([
      this.toV(pt(c.x - s, c.y), y), this.toV(pt(c.x + s, c.y), y),
      this.toV(pt(c.x, c.y - s), y), this.toV(pt(c.x, c.y + s), y)
    ])
    // ライブ描画線(鉛筆・部屋の多角形)
    const pts = o.pts ?? []
    const dims: { text: string; at: Pt }[] = [...(o.dims ?? [])]
    if (pts.length) {
      this.live.visible = true
      this.live.geometry.setFromPoints([...pts, c].map(q => this.toV(q, y)))
      const last = pts[pts.length - 1]
      const L = Math.round(dist(last, c))
      if (L > 1) dims.push({ text: `${L}`, at: pt((last.x + c.x) / 2, (last.y + c.y) / 2) })
    } else {
      this.live.visible = false
    }
    // 長方形プレビュー
    if (o.rectStart) {
      const a = o.rectStart
      this.rect.visible = true
      this.rect.geometry.setFromPoints([
        this.toV(a, y), this.toV(pt(c.x, a.y), y), this.toV(c, y), this.toV(pt(a.x, c.y), y)
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
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.toV(g.a, y), this.toV(g.b, y)]), this.guideMat)
      ln.computeLineDistances()
      ln.renderOrder = 996
      this.guideGroup.add(ln)
    }
    const kind = o.snap?.kind
    if (kind && kind !== 'グリッド') {
      const sc = this.screen(o.camera, o.canvas, this.toV(c, y))
      if (sc) {
        this.snapLabel.textContent = kind
        this.snapLabel.style.display = 'block'
        this.snapLabel.style.left = `${sc.x + 12}px`
        this.snapLabel.style.top = `${sc.y + 8}px`
      }
    } else {
      this.snapLabel.style.display = 'none'
    }
    // 軸平行ガイド(X = 赤 / 平面 Y = 青)
    const last = o.rectStart ?? (pts.length ? pts[pts.length - 1] : null)
    if (o.axis && last) {
      this.axisLine.visible = true
      this.axisLine.material = this.axisMats[o.axis]
      const ext = 2000
      const dir = o.axis === 'x' ? pt(1, 0) : pt(0, 1)
      this.axisLine.geometry.setFromPoints([
        this.toV(pt(last.x - dir.x * ext, last.y - dir.y * ext), y),
        this.toV(pt(c.x + dir.x * ext, c.y + dir.y * ext), y)
      ])
    } else {
      this.axisLine.visible = false
    }
    this.placeLabels(o, dims)
  }

  hide(): void {
    if (!this.group.visible && !this.labelEls.some(l => l.style.display !== 'none')) return
    this.group.visible = false
    this.snapLabel.style.display = 'none'
    for (const l of this.labelEls) l.style.display = 'none'
  }

  dispose(): void {
    this.group.traverse(obj => { if (obj instanceof THREE.Line) obj.geometry.dispose() })
    this.snapLabel.remove()
    for (const l of this.labelEls) l.remove()
  }
}
