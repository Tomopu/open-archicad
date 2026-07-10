// 幾何計算ユーティリティ(単位: mm)
export interface Pt { x: number; y: number }

export const pt = (x: number, y: number): Pt => ({ x, y })
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
export const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s })
export const len = (a: Pt): number => Math.hypot(a.x, a.y)
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
export const norm = (a: Pt): Pt => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l } }
export const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x })
export const rotate = (p: Pt, ang: number): Pt => {
  const c = Math.cos(ang), s = Math.sin(ang)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/** 点 p から線分 ab への最近点のパラメータ t (0..1) */
export function projT(p: Pt, a: Pt, b: Pt): number {
  const d = sub(b, a); const l2 = d.x * d.x + d.y * d.y
  if (l2 === 0) return 0
  return Math.max(0, Math.min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / l2))
}
export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  return dist(p, lerp(a, b, projT(p, a, b)))
}

/** 多角形の符号付き面積 (mm²)。反時計回りで正 */
export function polyArea(poly: Pt[]): number {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}
export function polyCentroid(poly: Pt[]): Pt {
  const a = polyArea(poly)
  if (Math.abs(a) < 1e-9) return poly[0] ?? pt(0, 0)
  let cx = 0, cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    const f = p.x * q.y - q.x * p.y
    cx += (p.x + q.x) * f; cy += (p.y + q.y) * f
  }
  return { x: cx / (6 * a), y: cy / (6 * a) }
}
export function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
/** 多角形境界への最短距離 */
export function distToPoly(p: Pt, poly: Pt[]): number {
  let d = Infinity
  for (let i = 0; i < poly.length; i++) d = Math.min(d, distToSeg(p, poly[i], poly[(i + 1) % poly.length]))
  return d
}
export function bbox(pts: Pt[]): { min: Pt; max: Pt } {
  const min = pt(Infinity, Infinity), max = pt(-Infinity, -Infinity)
  for (const p of pts) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y)
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y)
  }
  return { min, max }
}
export const snapTo = (v: number, step: number): number => (step > 0 ? Math.round(v / step) * step : v)

/** 3点を通る円弧を折れ線(約400mm刻み)で返す。ほぼ一直線なら null */
export function arcThrough(A: Pt, B: Pt, P: Pt): Pt[] | null {
  const d = 2 * (A.x * (B.y - P.y) + B.x * (P.y - A.y) + P.x * (A.y - B.y))
  if (Math.abs(d) < 1e-6) return null
  const a2 = A.x * A.x + A.y * A.y, b2 = B.x * B.x + B.y * B.y, p2 = P.x * P.x + P.y * P.y
  const cx = (a2 * (B.y - P.y) + b2 * (P.y - A.y) + p2 * (A.y - B.y)) / d
  const cy = (a2 * (P.x - B.x) + b2 * (A.x - P.x) + p2 * (B.x - A.x)) / d
  const R = Math.hypot(A.x - cx, A.y - cy)
  if (R > 100000) return null // ほぼ直線
  const a0 = Math.atan2(A.y - cy, A.x - cx)
  const a1 = Math.atan2(B.y - cy, B.x - cx)
  const aP = Math.atan2(P.y - cy, P.x - cx)
  const ccw = (x: number): number => ((x - a0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
  const sweepCCW = ccw(a1)
  // 通過点 P を含む方向に回る
  const sweep = ccw(aP) <= sweepCCW ? sweepCCW : sweepCCW - Math.PI * 2
  const n = Math.min(36, Math.max(4, Math.round((Math.abs(sweep) * R) / 400)))
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n
    pts.push(pt(cx + Math.cos(a) * R, cy + Math.sin(a) * R))
  }
  return pts
}

/** 角度(度)を 45° の倍数付近(±6°)で吸着させる(回転のガイド) */
export function angleDetentDeg(deg: number, range = 6): number {
  const m = Math.round(deg / 45) * 45
  return Math.abs(deg - m) < range ? m : deg
}

/** 2直線(点+方向)の交点。平行なら null */
export function lineIntersect(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt | null {
  const c = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(c) < 1e-9) return null
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / c
  return pt(p1.x + d1.x * t, p1.y + d1.y * t)
}

/** inner の全頂点が outer に含まれるか(部屋の入れ子判定)。
 *  境界線上の頂点(共有辺)も「含まれる」とみなす */
export function polyContains(outer: Pt[], inner: Pt[]): boolean {
  if (!inner.length) return false
  const TOL = 10 // mm
  return inner.every(p => pointInPoly(p, outer) || distToPoly(p, outer) < TOL) &&
    // 全頂点が境界上で実は外側、というケースを除外(重心が内側にあること)
    pointInPoly(polyCentroid(inner), outer)
}
/** 内包する穴(入れ子の部屋)を除いた正味面積 (mm²) */
export function netPolyArea(outer: Pt[], holes: Pt[][]): number {
  return Math.max(0, Math.abs(polyArea(outer)) - holes.reduce((s, h) => s + Math.abs(polyArea(h)), 0))
}
/** ラベルの置き場所: outer の内側かつ holes の外側で、境界から最も離れた点 */
export function labelAnchor(outer: Pt[], holes: Pt[][]): Pt {
  const inside = (p: Pt): boolean => pointInPoly(p, outer) && !holes.some(h => pointInPoly(p, h))
  const score = (p: Pt): number => Math.min(distToPoly(p, outer), ...holes.map(h => distToPoly(p, h)))
  const c = polyCentroid(outer)
  if (!holes.length && inside(c)) return c
  let best = c
  let bestScore = inside(c) ? score(c) : -1
  const b = bbox(outer), N = 14
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const p = pt(b.min.x + ((b.max.x - b.min.x) * i) / N, b.min.y + ((b.max.y - b.min.y) * j) / N)
      if (!inside(p)) continue
      const s = score(p)
      if (s > bestScore) { bestScore = s; best = p }
    }
  }
  return best
}
