// 立体(角柱)の面・辺の選択 — 3D モードと部品スタジオで共通のロジックと表示。
// スケッチから変換した n 角柱(CustomE.symbolPoly)とスタジオの多角形パーツ(pts)を
// 同じ「フットプリント + 上下面」モデルで扱う。
import * as THREE from 'three'
import { Pt, pt, dist, distToSeg } from './geometry'

/** 角柱の参照情報(ワールド座標。poly は平面 mm / y はシーン単位 m) */
export interface Prism {
  poly: Pt[]
  y0: number
  y1: number
}
export type FaceRef = { kind: 'top' | 'bottom' } | { kind: 'side'; i: number }
export const sameFace = (a: FaceRef | null, b: FaceRef | null): boolean =>
  !!a && !!b && a.kind === b.kind && (a.kind !== 'side' || a.i === (b as { i: number }).i)

/** ヒット点 + 法線 → どの面か */
export function faceFromHit(prism: Prism, point: THREE.Vector3, normal: THREE.Vector3 | null): FaceRef | null {
  if (normal) {
    if (normal.y > 0.7) return { kind: 'top' }
    if (normal.y < -0.7) return { kind: 'bottom' }
  }
  const p2 = pt(point.x * 1000, point.z * 1000)
  let best = -1
  let bd = Infinity
  for (let i = 0; i < prism.poly.length; i++) {
    const d = distToSeg(p2, prism.poly[i], prism.poly[(i + 1) % prism.poly.length])
    if (d < bd) { bd = d; best = i }
  }
  return best >= 0 ? { kind: 'side', i: best } : null
}

/** 面を構成する辺。vi = 編集できるフットプリント頂点 index(垂直辺は null) */
export interface SolidEdge {
  a: THREE.Vector3
  b: THREE.Vector3
  /** フットプリント頂点 [始点, 終点](水平辺のみ) */
  vi: [number, number] | null
}
export function edgesOfFace(prism: Prism, face: FaceRef): SolidEdge[] {
  const M = 1 / 1000
  const v = (q: Pt, y: number): THREE.Vector3 => new THREE.Vector3(q.x * M, y, q.y * M)
  const n = prism.poly.length
  const out: SolidEdge[] = []
  if (face.kind === 'top' || face.kind === 'bottom') {
    const y = face.kind === 'top' ? prism.y1 : prism.y0
    for (let i = 0; i < n; i++) {
      out.push({ a: v(prism.poly[i], y), b: v(prism.poly[(i + 1) % n], y), vi: [i, (i + 1) % n] })
    }
  } else {
    const i = (face as { kind: 'side'; i: number }).i
    const a = prism.poly[i], b = prism.poly[(i + 1) % n]
    out.push({ a: v(a, prism.y0), b: v(b, prism.y0), vi: [i, (i + 1) % n] })
    out.push({ a: v(a, prism.y1), b: v(b, prism.y1), vi: [i, (i + 1) % n] })
    out.push({ a: v(a, prism.y0), b: v(a, prism.y1), vi: null })
    out.push({ a: v(b, prism.y0), b: v(b, prism.y1), vi: null })
  }
  return out
}

/** ポインタに最も近い辺(スクリーン空間で判定) */
export function nearestEdge(
  edges: SolidEdge[], camera: THREE.Camera, canvas: HTMLCanvasElement,
  clientX: number, clientY: number, tolPx = 14
): number {
  const r = canvas.getBoundingClientRect()
  const sx = clientX - r.left, sy = clientY - r.top
  const proj = (v: THREE.Vector3): Pt | null => {
    const q = v.clone().project(camera)
    if (q.z > 1) return null
    return pt(((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height)
  }
  let best = -1
  let bd = tolPx
  edges.forEach((e, i) => {
    const a = proj(e.a), b = proj(e.b)
    if (!a || !b) return
    const d = distToSeg(pt(sx, sy), a, b)
    if (d < bd) { bd = d; best = i }
  })
  return best
}

/** 面・辺のハイライト表示(共通) */
export class SolidHighlight {
  group = new THREE.Group()
  private hoverMat = new THREE.MeshBasicMaterial({
    color: 0x60a5fa, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 // 共面 Z ファイティング防止
  })
  private selMat = new THREE.MeshBasicMaterial({
    color: 0x2563eb, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
  })
  private edgeMat = new THREE.LineBasicMaterial({ color: 0x1d4ed8, depthTest: false })
  private edgeHoverMat = new THREE.LineBasicMaterial({ color: 0x60a5fa, linewidth: 2, depthTest: false })

  private faceGeometry(prism: Prism, face: FaceRef): THREE.BufferGeometry {
    const M = 1 / 1000
    if (face.kind === 'side') {
      const fi = (face as { kind: 'side'; i: number }).i
      const n = prism.poly.length
      const a = prism.poly[fi], b = prism.poly[(fi + 1) % n]
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute([
        a.x * M, prism.y0, a.y * M, b.x * M, prism.y0, b.y * M, b.x * M, prism.y1, b.y * M,
        a.x * M, prism.y0, a.y * M, b.x * M, prism.y1, b.y * M, a.x * M, prism.y1, a.y * M
      ], 3))
      return g
    }
    const shape = new THREE.Shape(prism.poly.map(q => new THREE.Vector2(q.x * M, q.y * M)))
    const g = new THREE.ShapeGeometry(shape)
    g.rotateX(Math.PI / 2)
    g.translate(0, face.kind === 'top' ? prism.y1 + 0.004 : prism.y0 - 0.004, 0)
    return g
  }

  /** 面のハイライト(hover = 薄く / sel = 濃く) */
  showFace(prism: Prism, face: FaceRef, kind: 'hover' | 'sel'): void {
    const m = new THREE.Mesh(this.faceGeometry(prism, face), kind === 'hover' ? this.hoverMat : this.selMat)
    m.renderOrder = 992
    this.group.add(m)
  }
  /** 面を構成する辺をまとめて強調 */
  showEdges(prism: Prism, face: FaceRef): void {
    for (const e of edgesOfFace(prism, face)) {
      const g = new THREE.BufferGeometry().setFromPoints([e.a, e.b])
      const ln = new THREE.Line(g, this.edgeMat)
      ln.renderOrder = 993
      this.group.add(ln)
    }
  }
  /** 1 本の辺の強調(hover = 明るく / sel = 濃く+太く見せるため二重) */
  showEdge(e: SolidEdge, kind: 'hover' | 'sel'): void {
    const g = new THREE.BufferGeometry().setFromPoints([e.a, e.b])
    const ln = new THREE.Line(g, kind === 'hover' ? this.edgeHoverMat : this.edgeMat)
    ln.renderOrder = 994
    this.group.add(ln)
    if (kind === 'sel') {
      // 少し持ち上げた重ね描きで太く見せる
      const g2 = new THREE.BufferGeometry().setFromPoints([
        e.a.clone().add(new THREE.Vector3(0, 0.004, 0)), e.b.clone().add(new THREE.Vector3(0, 0.004, 0))])
      const ln2 = new THREE.Line(g2, this.edgeMat)
      ln2.renderOrder = 994
      this.group.add(ln2)
    }
  }
  clear(): void {
    this.group.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) o.geometry.dispose() })
    this.group.clear()
  }
}

/** フットプリント頂点の移動(端点つまみ): 同一位置の頂点をまとめて動かした新しい poly を返す */
export function movePolyVertex(poly: Pt[], vi: number, to: Pt): Pt[] {
  const cur = poly[vi]
  return poly.map((q, i) => (i === vi || dist(q, cur) < 3 ? { ...to } : q))
}
