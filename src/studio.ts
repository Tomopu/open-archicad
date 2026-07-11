// 部品スタジオ — 2D 図面から独立した 3D モデリングモード。
// プリミティブ(箱・円柱・球・円錐)を組み合わせ/くり抜き/交差(CSG)してオリジナル部品を作る。
// 複数選択 → ブール演算アイコン・一括拡大縮小。回転はリングで自由回転(45°吸着)。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg'
import { CustomE, uid } from './model'
import { Pt, pt, dist, angleDetentDeg, snapTo } from './geometry'
import { SketchOverlay, axisLock, SnapInfo } from './sketchInput'
import { params } from './tools'

type PartKind = 'box' | 'cyl' | 'sphere' | 'cone' | 'poly' | 'baked'
export interface StudioPart {
  kind: PartKind
  op: 'add' | 'sub'
  x: number; y: number; z: number      // 位置 mm(y は底面高さ)
  sx: number; sy: number; sz: number   // 寸法 mm
  rot: number                          // Y軸回転(度)
  rx?: number; rz?: number             // X/Z軸回転(度)
  /** poly(鉛筆)用: 平面形状の頂点(mm、bbox 中心原点) */
  pts?: { x: number; y: number }[]
  /** baked(ブール演算の結果)用: 底面中央原点の三角形メッシュと元寸法 */
  positions?: number[]
  bx?: number; by?: number; bz?: number
}
const KIND_LABEL: Record<PartKind, string> = { box: '箱', cyl: '円柱', sphere: '球', cone: '円錐', poly: '鉛筆形状', baked: '演算結果' }
const KIND_ICON: Record<PartKind, string> = {
  box: '<rect x="5" y="7" width="14" height="12" rx="1"/><path d="M5 7l3-3h14l-3 3M19 7l3-3v12l-3 3"/>',
  cyl: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12M19 6v12"/><ellipse cx="12" cy="18" rx="7" ry="3"/>',
  sphere: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>',
  cone: '<path d="M12 4L5 18h0"/><path d="M12 4l7 14"/><ellipse cx="12" cy="18" rx="7" ry="3"/>',
  poly: '<path d="M4 20 l1-4 L16 5 a1.6 1.6 0 0 1 2.3 0 l0.7 0.7 a1.6 1.6 0 0 1 0 2.3 L8 19 z"/><path d="M14.5 6.5 l3 3"/>',
  baked: '<path d="M4 12a8 8 0 1 0 16 0 8 8 0 0 0-16 0"/><path d="M8 12h8M12 8v8"/>'
}
const MM = 1 / 1000

function partGeometry(p: StudioPart): THREE.BufferGeometry {
  let g: THREE.BufferGeometry
  switch (p.kind) {
    case 'box': g = new THREE.BoxGeometry(p.sx, p.sy, p.sz); break
    case 'cyl': g = new THREE.CylinderGeometry(p.sx / 2, p.sx / 2, p.sy, 24); break
    case 'sphere': g = new THREE.SphereGeometry(p.sx / 2, 20, 14).scale(1, p.sy / p.sx, p.sz / p.sx); break
    case 'cone': g = new THREE.ConeGeometry(p.sx / 2, p.sy, 20); break
    case 'poly': {
      // 鉛筆で描いた平面形状の押し出し(plan y → +z)
      const pts = p.pts ?? []
      const shape = new THREE.Shape(pts.map(q => new THREE.Vector2(q.x, -q.y)))
      g = new THREE.ExtrudeGeometry(shape, { depth: p.sy, bevelEnabled: false })
      g.rotateX(-Math.PI / 2)
      g.scale(p.sx / (p.bx ?? p.sx), 1, p.sz / (p.bz ?? p.sz))
      g.translate(0, -p.sy / 2, 0) // 中心原点に合わせる
      break
    }
    case 'baked': {
      g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.positions ?? [], 3))
      g.scale(p.sx / (p.bx ?? p.sx), p.sy / (p.by ?? p.sy), p.sz / (p.bz ?? p.sz))
      g.translate(0, -p.sy / 2, 0) // 底面中央原点 → 中心原点に合わせる
      g.computeVertexNormals()
      break
    }
  }
  if (p.rx) g.rotateX((p.rx * Math.PI) / 180)
  if (p.rz) g.rotateZ((p.rz * Math.PI) / 180)
  g.rotateY((-p.rot * Math.PI) / 180)
  g.translate(p.x, p.y + p.sy / 2, p.z)
  return g
}

function csgOf(parts: StudioPart[], mode: 'recipe' | 'union' | 'subtract' | 'intersect'): THREE.BufferGeometry | null {
  const ev = new Evaluator()
  let acc: Brush | null = null
  for (const p of parts) {
    const brush = new Brush(partGeometry(p))
    brush.updateMatrixWorld()
    if (!acc) {
      if (mode !== 'recipe' || p.op === 'add') acc = brush
      continue
    }
    const op = mode === 'recipe' ? (p.op === 'add' ? ADDITION : SUBTRACTION)
      : mode === 'union' ? ADDITION
      : mode === 'subtract' ? SUBTRACTION
      : INTERSECTION
    acc = ev.evaluate(acc, brush, op)
  }
  return acc ? acc.geometry : null
}

/** ジオメトリを baked パーツへ(底面中央原点に正規化) */
function bakePart(geo: THREE.BufferGeometry, op: 'add' | 'sub'): StudioPart | null {
  geo.computeBoundingBox()
  const bb = geo.boundingBox!
  if (bb.isEmpty()) return null
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2
  geo.translate(-cx, -bb.min.y, -cz)
  const sx = Math.max(10, Math.round(bb.max.x - bb.min.x))
  const sy = Math.max(10, Math.round(bb.max.y - bb.min.y))
  const sz = Math.max(10, Math.round(bb.max.z - bb.min.z))
  const posAttr = geo.getAttribute('position')
  const positions: number[] = []
  const idx = geo.getIndex()
  const push = (i: number): void => {
    positions.push(
      Math.round(posAttr.getX(i) * 10) / 10,
      Math.round(posAttr.getY(i) * 10) / 10,
      Math.round(posAttr.getZ(i) * 10) / 10)
  }
  if (idx) for (let i = 0; i < idx.count; i++) push(idx.getX(i))
  else for (let i = 0; i < posAttr.count; i++) push(i)
  return {
    kind: 'baked', op, x: Math.round(cx), y: Math.round(bb.min.y), z: Math.round(cz),
    sx, sy, sz, rot: 0, positions, bx: sx, by: sy, bz: sz
  }
}

export interface StudioInitial {
  name?: string
  label?: string
  symbol?: 'rect' | 'round'
  parts?: unknown
}

export function openStudio(onSave: (ent: CustomE, name: string) => void, initial?: StudioInitial): void {
  // ---------- モーダル DOM ----------
  const modal = document.createElement('div')
  modal.className = 'studio-modal'
  const railBtn = (kind: string, title: string, icon: string): string =>
    `<button data-add="${kind}" title="${title}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">${icon}</svg><span>${title}</span></button>`
  modal.innerHTML = `
    <div class="studio-head">
      <b>部品スタジオ</b>
      <div class="field" style="width:170px"><label style="width:auto">名前</label><input class="st-name"></div>
      <div class="field"><label style="width:auto">2D記号</label><select class="st-symbol"><option value="rect">矩形</option><option value="round">円</option></select></div>
      <div class="field" style="width:130px"><label style="width:auto">ラベル</label><input class="st-label"></div>
      <label class="hint" style="display:flex;align-items:center;gap:3px" title="XYZ軸を表示">
        <input type="checkbox" class="st-axes"> 軸
      </label>
      <span style="flex:1"></span>
      <button data-a="preview">CSGプレビュー</button>
      <button data-a="save" style="color:var(--accent);border:1px solid #bfdbfe">保存して閉じる</button>
      <button data-a="close">キャンセル</button>
    </div>
    <div class="studio-main">
      <div class="studio-rail">
        ${railBtn('box', '箱', KIND_ICON.box)}
        ${railBtn('cyl', '円柱', KIND_ICON.cyl)}
        ${railBtn('sphere', '球', KIND_ICON.sphere)}
        ${railBtn('cone', '円錐', KIND_ICON.cone)}
        ${railBtn('pen', '鉛筆', KIND_ICON.poly)}
      </div>
      <div class="studio-view">
        <div class="studio-actions" hidden>
          <button data-pa="dup" title="複製"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          <button data-pa="rot" title="回転リング(自由回転、45°ごとに吸着)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11a8.5 8.5 0 1 0-2.2 7"/><path d="M21 4.5V11h-6.5"/></svg></button>
          <button data-pa="union" title="合成(マージ)" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/></svg></button>
          <button data-pa="subtract" title="くり抜き(先に選択した形から差し引く)" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6" stroke-dasharray="2.5 2"/></svg></button>
          <button data-pa="intersect" title="交差(重なり部分だけ残す)" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 7.4a6 6 0 0 1 0 9.2 6 6 0 0 1 0-9.2z" fill="currentColor" fill-opacity=".25"/><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/></svg></button>
          <button data-pa="del" title="削除" style="color:var(--danger)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12M10 11v5M14 11v5"/></svg></button>
        </div>
        <div class="studio-scale"><div class="segs"></div><div class="label"></div></div>
        <div class="studio-hint">クリック: 選択 / Shift+クリック: 追加選択 / ドラッグ: 移動 / 紫球: 高さ / 赤=くり抜き / 鉛筆: 地面をクリックして多角形(ダブルクリックで閉じる、2点なら長方形)</div>
      </div>
      <div class="studio-side">
        <div class="panel-title">パーツ一覧</div>
        <div class="studio-parts"></div>
        <div class="panel-title">選択中のパーツ</div>
        <div class="studio-fields props"></div>
      </div>
    </div>`
  document.body.appendChild(modal)
  // アイコンのホバーで名前を表示
  modal.querySelectorAll('button[title]').forEach(b => { (b as HTMLElement).dataset.tip = (b as HTMLElement).title })
  ;(modal.querySelector('.st-name') as HTMLInputElement).value = initial?.name ?? 'オリジナル部品'
  ;(modal.querySelector('.st-label') as HTMLInputElement).value = initial?.label ?? ''
  ;(modal.querySelector('.st-symbol') as HTMLSelectElement).value = initial?.symbol ?? 'rect'

  // ---------- 3D シーン ----------
  const viewEl = modal.querySelector('.studio-view') as HTMLElement
  const actionsEl = modal.querySelector('.studio-actions') as HTMLElement
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  viewEl.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xffffff)
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100)
  camera.position.set(1.6, 1.4, 1.6)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 0.25, 0)
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd4d4d8, 1.1))
  const dirL = new THREE.DirectionalLight(0xffffff, 1.1)
  dirL.position.set(3, 5, 2)
  scene.add(dirL)
  scene.add(new THREE.GridHelper(4, 40, 0xe4e4e7, 0xf0f0f1))
  // XYZ 軸(トグル)
  const axes = new THREE.Group()
  {
    const L = 100, R = 0.012
    const defs: [number, [number, number, number]][] = [
      [0xdc2626, [0, 0, -Math.PI / 2]], [0x16a34a, [0, 0, 0]], [0x2563eb, [Math.PI / 2, 0, 0]]
    ]
    for (const [color, rot] of defs) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(R, R, L, 8), new THREE.MeshBasicMaterial({ color }))
      m.rotation.set(rot[0], rot[1], rot[2])
      axes.add(m)
    }
  }
  axes.visible = false
  scene.add(axes)
  const partsGroup = new THREE.Group()
  partsGroup.scale.setScalar(MM)
  const resultGroup = new THREE.Group()
  resultGroup.scale.setScalar(MM)
  const gizmo = new THREE.Group()
  scene.add(partsGroup, resultGroup, gizmo)

  const MAT_ADD = new THREE.MeshLambertMaterial({ color: 0xd4d4d8 })
  const MAT_SUB = new THREE.MeshLambertMaterial({ color: 0xef4444, transparent: true, opacity: 0.45 })
  const MAT_SEL = new THREE.MeshLambertMaterial({ color: 0x93b4f8, emissive: 0x1d4ed8, emissiveIntensity: 0.2 })
  const MAT_RESULT = new THREE.MeshLambertMaterial({ color: 0xd4b896 })

  // ---------- 状態 ----------
  const initParts = Array.isArray(initial?.parts) ? (initial!.parts as StudioPart[]) : null
  const parts: StudioPart[] = initParts && initParts.length
    ? JSON.parse(JSON.stringify(initParts))
    : [{ kind: 'box', op: 'add', x: 0, y: 0, z: 0, sx: 600, sy: 400, sz: 400, rot: 0 }]
  const selSet = new Set<number>([0])
  let previewing = false
  let rotMode = false
  const primary = (): number => (selSet.size ? Math.max(...selSet) : -1)

  // ---------- 鉛筆(多角形 / 長方形 → 押し出し)。3D モードと同じ入力機構(sketchInput)を共用 ----------
  let penMode = false
  let penPts: Pt[] = []                 // mm(平面)
  let penRectStart: Pt | null = null
  const sketchOv = new SketchOverlay(viewEl, MM)
  scene.add(sketchOv.group)
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  /** クリック位置 → 平面 mm 座標 */
  const groundPt = (e: PointerEvent): Pt | null => {
    ray.setFromCamera(ndc(e), camera)
    const q = new THREE.Vector3()
    if (!ray.ray.intersectPlane(groundPlane, q)) return null
    return pt(q.x / MM, q.z / MM)
  }
  /** スタジオ内のスナップ: 描画中の点・パーツの中心 / 角に吸着 → なければ 10mm グリッド */
  const studioSnap = (p: Pt): SnapInfo => {
    const tol = 60
    const cands: { p: Pt; kind: string }[] = penPts.map(q => ({ p: q, kind: '端点' }))
    for (const part of parts) {
      cands.push({ p: pt(part.x, part.z), kind: '中心' })
      const hw = part.sx / 2, hd = part.sz / 2
      const rad = (part.rot * Math.PI) / 180
      const cos = Math.cos(rad), sin = Math.sin(rad)
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          cands.push({
            p: pt(part.x + sx * hw * cos - sz * hd * sin, part.z + sx * hw * sin + sz * hd * cos),
            kind: '端点'
          })
        }
      }
    }
    let best: { p: Pt; kind: string } | null = null
    let bd = tol
    for (const c of cands) {
      const d = dist(p, c.p)
      if (d < bd) { bd = d; best = c }
    }
    if (best) return { p: { ...best.p }, kind: best.kind, guides: [] }
    return { p: pt(snapTo(p.x, 10), snapTo(p.y, 10)), kind: 'グリッド', guides: [] }
  }
  /** スナップ + 軸平行ロックを適用したカーソル */
  const penCursor = (e: PointerEvent): { cur: Pt; snap: SnapInfo; axis: 'x' | 'y' | null } | null => {
    const gp = groundPt(e)
    if (!gp) return null
    const snap = studioSnap(gp)
    let cur = snap.p
    let axis: 'x' | 'y' | null = null
    if (snap.kind === 'グリッド') {
      const al = axisLock(penRectStart ?? (penPts.length ? penPts[penPts.length - 1] : null), snap.p)
      cur = al.p
      axis = al.axis
    }
    return { cur, snap, axis }
  }

  // ---------- ギズモ ----------
  const mkSquare = (kind: string, x: number, y: number, z: number, color = 0x2563eb): void => {
    const g = new THREE.Group()
    const white = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }))
    const blue = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.044, 0.044),
      new THREE.MeshBasicMaterial({ color, depthTest: false }))
    white.renderOrder = 998; blue.renderOrder = 999
    g.add(white, blue)
    g.position.set(x, y, z)
    g.userData.g = kind
    gizmo.add(g)
  }
  const partsBBox = (idxs: number[]): THREE.Box3 => {
    const bb = new THREE.Box3()
    for (const i of idxs) {
      const p = parts[i]
      if (!p) continue
      const r = Math.hypot(p.sx, p.sz) / 2
      bb.expandByPoint(new THREE.Vector3((p.x - r) * MM, p.y * MM, (p.z - r) * MM))
      bb.expandByPoint(new THREE.Vector3((p.x + r) * MM, (p.y + p.sy) * MM, (p.z + r) * MM))
    }
    return bb
  }
  const updateGizmo = (): void => {
    gizmo.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    gizmo.clear()
    if (previewing || !selSet.size) return
    if (selSet.size > 1) {
      // 複数選択: 一括拡大縮小ハンドル(bbox の角)
      const bb = partsBBox([...selSet])
      mkSquare('scaleAll', bb.max.x + 0.1, (bb.min.y + bb.max.y) / 2, bb.max.z + 0.1, 0x9333ea)
      return
    }
    const p = parts[primary()]
    if (!p) return
    const cx = p.x * MM, cz = p.z * MM
    const midY = (p.y + p.sy / 2) * MM
    if (rotMode) {
      // XYZ 回転リング
      const rad = Math.max(0.3, Math.hypot(p.sx, p.sz) * MM / 2 + 0.12)
      const ring = (axis: 'x' | 'y' | 'z', color: number): void => {
        // 細く・最初は半透明。ホバー / 操作中に濃くなる
        const t = new THREE.Mesh(new THREE.TorusGeometry(rad, 0.011, 8, 72),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthTest: false }))
        t.renderOrder = 999
        if (axis === 'y') t.rotation.x = Math.PI / 2
        else if (axis === 'x') t.rotation.y = Math.PI / 2
        t.position.set(cx, midY, cz)
        t.userData.g = `r${axis}`
        gizmo.add(t)
      }
      ring('y', 0x16a34a); ring('x', 0xdc2626); ring('z', 0x2563eb)
      return
    }
    const off = 0.09
    const hx = (p.sx * MM) / 2 + off, hz = (p.sz * MM) / 2 + off
    const rad = (p.rot * Math.PI) / 180
    const dw = { x: Math.cos(rad), z: Math.sin(rad) }
    const dd = { x: -Math.sin(rad), z: Math.cos(rad) }
    // 四辺(面の押し引き)
    mkSquare('x+', cx + dw.x * hx, midY, cz + dw.z * hx)
    mkSquare('x-', cx - dw.x * hx, midY, cz - dw.z * hx)
    mkSquare('z+', cx + dd.x * hz, midY, cz + dd.z * hz)
    mkSquare('z-', cx - dd.x * hz, midY, cz - dd.z * hz)
    // 上面(高さ)= 円錐(白縁取り) / 底面 = 四角
    const mkOutlined = (kind: string, x: number, y: number, z: number,
      whiteGeo: THREE.BufferGeometry, mainGeo: THREE.BufferGeometry, color: number): void => {
      const g = new THREE.Group()
      const white = new THREE.Mesh(whiteGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }))
      const main = new THREE.Mesh(mainGeo, new THREE.MeshBasicMaterial({ color, depthTest: false }))
      white.renderOrder = 998; main.renderOrder = 999
      g.add(white, main)
      g.position.set(x, y, z)
      g.userData.g = kind
      gizmo.add(g)
    }
    mkOutlined('y+', cx, (p.y + p.sy) * MM + off, cz,
      new THREE.ConeGeometry(0.052, 0.115, 12), new THREE.ConeGeometry(0.038, 0.086, 12), 0x2563eb)
    mkSquare('y-', cx, p.y * MM - off, cz)
    // 高さ位置(Y軸に平行な移動)= 紫の球(白縁取り)
    mkOutlined('lift', cx, (p.y + p.sy) * MM + off * 1.9, cz,
      new THREE.SphereGeometry(0.042, 12, 10), new THREE.SphereGeometry(0.031, 12, 10), 0x9333ea)
  }
  /** リングの透明度: active を濃く、他を薄く。null なら既定に戻す */
  const emphasizeRing = (active: string | null): void => {
    for (const child of gizmo.children) {
      const k = child.userData.g as string | undefined
      if (!k?.startsWith('r')) continue
      const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial
      mat.opacity = active === null ? 0.35 : k === active ? 0.95 : 0.1
    }
    render()
  }

  const updateActions = (): void => {
    if (!selSet.size || previewing) { actionsEl.hidden = true; return }
    const bb = partsBBox([...selSet])
    const v = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y + 0.14, (bb.min.z + bb.max.z) / 2).project(camera)
    if (v.z > 1) { actionsEl.hidden = true; return }
    const r = renderer.domElement.getBoundingClientRect()
    const multi = selSet.size > 1
    ;(actionsEl.querySelector('[data-pa="union"]') as HTMLElement).hidden = !multi
    ;(actionsEl.querySelector('[data-pa="subtract"]') as HTMLElement).hidden = !multi
    ;(actionsEl.querySelector('[data-pa="intersect"]') as HTMLElement).hidden = !multi
    ;(actionsEl.querySelector('[data-pa="rot"]') as HTMLElement).hidden = multi
    actionsEl.hidden = false
    const aw = actionsEl.offsetWidth || 90
    actionsEl.style.left = `${Math.max(4, ((v.x + 1) / 2) * r.width - aw / 2)}px`
    actionsEl.style.top = `${Math.max(4, ((1 - v.y) / 2) * r.height - 92)}px`
  }
  // 縮尺バー(2D と同じ地図スタイル)
  const scaleEl = modal.querySelector('.studio-scale') as HTMLElement
  const updateScale = (): void => {
    const r = renderer.domElement.getBoundingClientRect()
    const pr = (v: THREE.Vector3): { x: number; y: number } => {
      const q = v.clone().project(camera)
      return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height }
    }
    const a = pr(controls.target)
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const b = pr(controls.target.clone().add(right))
    const pxPerM = Math.hypot(b.x - a.x, b.y - a.y) // 1m あたりの px
    const cands = [0.05, 0.1, 0.2, 0.5, 1, 2, 5]
    let best = cands[0]
    for (const c of cands) if (c * pxPerM <= 160) best = c
    const segs = scaleEl.querySelector('.segs') as HTMLElement
    segs.innerHTML = ''
    segs.style.width = `${Math.max(24, best * pxPerM)}px`
    for (let i = 0; i < 4; i++) {
      const sp = document.createElement('span')
      sp.style.width = '25%'
      segs.appendChild(sp)
    }
    ;(scaleEl.querySelector('.label') as HTMLElement).textContent =
      best >= 1 ? `${best} m` : `${best * 1000} mm`
  }

  const render = (): void => {
    // つまみはカメラ距離連動(上限 1.0 → ズームアウトで画面上も小さくなる)
    for (const child of gizmo.children) {
      if ((child.userData.g as string | undefined)?.startsWith('r')) continue
      const d = child.position.distanceTo(camera.position)
      child.scale.setScalar(Math.min(1.0, Math.max(0.25, d / 2.6)))
    }
    renderer.render(scene, camera)
    updateActions()
    updateScale()
  }
  controls.addEventListener('change', render)
  const resize = (): void => {
    const w = viewEl.clientWidth || 1, h = viewEl.clientHeight || 1
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    render()
  }
  new ResizeObserver(resize).observe(viewEl)
  ;(modal.querySelector('.st-axes') as HTMLInputElement).onchange = e => {
    axes.visible = (e.target as HTMLInputElement).checked
    render()
  }

  const rebuildParts = (): void => {
    partsGroup.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    partsGroup.clear()
    parts.forEach((p, i) => {
      const mesh = new THREE.Mesh(partGeometry(p), selSet.has(i) ? MAT_SEL : p.op === 'add' ? MAT_ADD : MAT_SUB)
      mesh.userData.idx = i
      partsGroup.add(mesh)
    })
    partsGroup.visible = !previewing
    updateGizmo()
    render()
  }
  const showPreview = (): void => {
    resultGroup.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    resultGroup.clear()
    const geo = csgOf(parts, 'recipe')
    if (geo) resultGroup.add(new THREE.Mesh(geo, MAT_RESULT))
    previewing = true
    partsGroup.visible = false
    updateGizmo()
    render()
  }
  const exitPreview = (): void => {
    if (!previewing) return
    previewing = false
    resultGroup.clear()
    partsGroup.visible = true
  }

  // ---------- UI: パーツ一覧・フィールド ----------
  const listEl = modal.querySelector('.studio-parts') as HTMLElement
  const fieldsEl = modal.querySelector('.studio-fields') as HTMLElement
  const renderList = (): void => {
    listEl.innerHTML = ''
    parts.forEach((p, i) => {
      const row = document.createElement('div')
      row.className = 'comp-item' + (selSet.has(i) ? ' active' : '')
      row.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5">${KIND_ICON[p.kind]}</svg>
        <span class="name">${KIND_LABEL[p.kind]}${p.op === 'sub' ? '(くり抜き)' : ''}</span>`
      row.onclick = ev => {
        if (ev.shiftKey) { if (selSet.has(i)) selSet.delete(i); else selSet.add(i) }
        else { selSet.clear(); selSet.add(i) }
        refresh()
      }
      const del = document.createElement('button')
      del.textContent = '×'
      del.onclick = ev => {
        ev.stopPropagation()
        parts.splice(i, 1)
        selSet.clear()
        if (parts.length) selSet.add(Math.min(i, parts.length - 1))
        refresh()
      }
      row.appendChild(del)
      listEl.appendChild(row)
    })
  }
  const num = (label: string, get: () => number, set: (v: number) => void): HTMLElement => {
    const div = document.createElement('div')
    div.className = 'field'
    div.innerHTML = `<label>${label}</label>`
    const inp = document.createElement('input')
    inp.type = 'number'; inp.value = String(get())
    inp.onchange = () => { set(parseFloat(inp.value) || 0); exitPreview(); rebuildParts(); renderList() }
    div.appendChild(inp)
    return div
  }
  const renderFields = (): void => {
    fieldsEl.innerHTML = ''
    if (selSet.size > 1) { fieldsEl.innerHTML = `<div class="empty">${selSet.size} 個を選択中(角の紫つまみで一括拡大縮小)</div>`; return }
    const p = parts[primary()]
    if (!p) { fieldsEl.innerHTML = '<div class="empty">パーツがありません</div>'; return }
    const opSel = document.createElement('select')
    opSel.innerHTML = '<option value="add">追加(合成)</option><option value="sub">くり抜き(差分)</option>'
    opSel.value = p.op
    opSel.onchange = () => { p.op = opSel.value as 'add' | 'sub'; exitPreview(); rebuildParts(); renderList() }
    const opDiv = document.createElement('div')
    opDiv.className = 'field'
    opDiv.innerHTML = '<label>操作</label>'
    opDiv.appendChild(opSel)
    fieldsEl.append(
      opDiv,
      num('X mm', () => p.x, v => { p.x = v }),
      num('Y(底面) mm', () => p.y, v => { p.y = v }),
      num('Z mm', () => p.z, v => { p.z = v }),
      num('幅 mm', () => p.sx, v => { p.sx = Math.max(10, v) }),
      num('高さ mm', () => p.sy, v => { p.sy = Math.max(10, v) }),
      num('奥行 mm', () => p.sz, v => { p.sz = Math.max(10, v) }),
      num('回転Y °', () => p.rot, v => { p.rot = v }),
      num('回転X °', () => p.rx ?? 0, v => { p.rx = v || undefined }),
      num('回転Z °', () => p.rz ?? 0, v => { p.rz = v || undefined })
    )
  }
  const refresh = (): void => { exitPreview(); rotMode = false; rebuildParts(); renderList(); renderFields() }

  const penButton = modal.querySelector('[data-add="pen"]') as HTMLButtonElement
  const setPenMode = (on: boolean): void => {
    penMode = on
    penPts = []
    penRectStart = null
    sketchOv.hide()
    penButton.classList.toggle('active', on)
    render()
  }
  /** 多角形(mm)をパーツ化 */
  const makePolyPart = (poly: Pt[]): void => {
    if (poly.length < 3) return
    const xs = poly.map(q => q.x), ys = poly.map(q => q.y)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const bw = Math.max(10, Math.round(Math.max(...xs) - Math.min(...xs)))
    const bh = Math.max(10, Math.round(Math.max(...ys) - Math.min(...ys)))
    parts.push({
      kind: 'poly', op: 'add',
      x: Math.round(cx), y: 0, z: Math.round(cy),
      sx: bw, sy: 400, sz: bh, rot: 0,
      pts: poly.map(q => ({ x: Math.round(q.x - cx), y: Math.round(q.y - cy) })),
      bx: bw, bz: bh
    })
    selSet.clear(); selSet.add(parts.length - 1)
  }
  /** 鉛筆の多角形を確定してパーツ化(2点なら長方形) */
  const closePen = (): void => {
    let poly = penPts
    if (poly.length === 2) {
      const [a, b] = poly
      poly = [a, pt(b.x, a.y), b, pt(a.x, b.y)]
    }
    makePolyPart(poly)
    setPenMode(false)
    refresh()
  }

  modal.querySelectorAll('[data-add]').forEach(b => {
    ;(b as HTMLButtonElement).onclick = () => {
      const kind = (b as HTMLElement).dataset.add as PartKind | 'pen'
      if (kind === 'pen') { setPenMode(!penMode); return } // 鉛筆はモード切替(地面をクリックして多角形)
      parts.push({ kind, op: 'add', x: 0, y: 0, z: 0, sx: 400, sy: 400, sz: 400, rot: 0 })
      selSet.clear(); selSet.add(parts.length - 1)
      refresh()
    }
  })

  // ---------- アクションアイコン ----------
  const applyBool = (mode: 'union' | 'subtract' | 'intersect'): void => {
    const idxs = [...selSet].sort((a, b) => a - b)
    if (idxs.length < 2) return
    const geo = csgOf(idxs.map(i => parts[i]), mode)
    if (!geo) return
    const baked = bakePart(geo, 'add')
    if (!baked) return
    // 選択パーツを削除して結果に置き換え
    for (let k = idxs.length - 1; k >= 0; k--) parts.splice(idxs[k], 1)
    parts.splice(idxs[0], 0, baked)
    selSet.clear(); selSet.add(idxs[0])
    refresh()
  }
  ;(actionsEl.querySelector('[data-pa="union"]') as HTMLButtonElement).onclick = () => applyBool('union')
  ;(actionsEl.querySelector('[data-pa="subtract"]') as HTMLButtonElement).onclick = () => applyBool('subtract')
  ;(actionsEl.querySelector('[data-pa="intersect"]') as HTMLButtonElement).onclick = () => applyBool('intersect')
  ;(actionsEl.querySelector('[data-pa="dup"]') as HTMLButtonElement).onclick = () => {
    const news: number[] = []
    for (const i of [...selSet].sort((a, b) => a - b)) {
      const p = parts[i]
      parts.push({ ...JSON.parse(JSON.stringify(p)), x: p.x + 200, z: p.z + 200 })
      news.push(parts.length - 1)
    }
    selSet.clear(); news.forEach(i => selSet.add(i))
    refresh()
  }
  ;(actionsEl.querySelector('[data-pa="rot"]') as HTMLButtonElement).onclick = () => {
    rotMode = !rotMode
    rebuildParts()
  }
  ;(actionsEl.querySelector('[data-pa="del"]') as HTMLButtonElement).onclick = () => {
    for (const i of [...selSet].sort((a, b) => b - a)) parts.splice(i, 1)
    selSet.clear()
    if (parts.length) selSet.add(parts.length - 1)
    refresh()
  }

  // ---------- 3D 上の操作 ----------
  const ray = new THREE.Raycaster()
  let dragIds: number[] | null = null
  let dragLast: THREE.Vector3 | null = null
  let dragMoved = false
  let handleDrag: { kind: string; grabY: number; startY?: number; startDist?: number; snapshot?: StudioPart[]; center?: THREE.Vector3 } | null = null
  let ringDrag: { axis: 'x' | 'y' | 'z'; center: THREE.Vector3; startAngle: number; startDeg: number } | null = null
  const ndc = (e: PointerEvent): THREE.Vector2 => {
    const r = renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }
  const ringAngle = (e: PointerEvent, axis: 'x' | 'y' | 'z', center: THREE.Vector3): number => {
    const n = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, center)
    const q = new THREE.Vector3()
    ray.setFromCamera(ndc(e), camera)
    if (!ray.ray.intersectPlane(plane, q)) return 0
    const v = q.sub(center)
    if (axis === 'y') return Math.atan2(v.z, v.x)
    if (axis === 'x') return Math.atan2(v.y, v.z)
    return Math.atan2(v.y, v.x)
  }

  renderer.domElement.addEventListener('pointerdown', e => {
    if (e.button !== 0 || previewing) return
    // 鉛筆モード: 地面(y=0)クリックで頂点を追加(3D モードと同じスナップ・軸ロック)。
    // 長方形モード(params.pencil.mode)は 2 点で確定、鉛筆は始点クリックで閉じる
    if (penMode) {
      e.stopPropagation()
      const pc = penCursor(e)
      if (!pc) return
      if (params.pencil.mode === 'rect') {
        if (!penRectStart) {
          penRectStart = pc.cur
        } else {
          const a = penRectStart
          makePolyPart([a, pt(pc.cur.x, a.y), pc.cur, pt(a.x, pc.cur.y)])
          setPenMode(false)
          refresh()
        }
        return
      }
      if (penPts.length >= 3 && dist(pc.cur, penPts[0]) < 80) { closePen(); return }
      penPts.push(pc.cur)
      return
    }
    try { renderer.domElement.setPointerCapture(e.pointerId) } catch { /* noop */ }
    ray.setFromCamera(ndc(e), camera)
    dragMoved = false
    // つまみ・リング優先
    const gh = ray.intersectObjects(gizmo.children, true)
    if (gh.length) {
      let o: THREE.Object3D | null = gh[0].object
      while (o && !o.userData.g) o = o.parent
      const kind = o?.userData.g as string | undefined
      if (kind) {
        e.stopPropagation()
        controls.enabled = false
        renderer.domElement.style.cursor = 'grabbing'
        if (kind.startsWith('r')) {
          const p = parts[primary()]
          const center = (gizmo.children[0] as THREE.Mesh).position.clone()
          const axis = kind[1] as 'x' | 'y' | 'z'
          ringDrag = {
            axis, center,
            startAngle: ringAngle(e, axis, center),
            startDeg: axis === 'y' ? p.rot : axis === 'x' ? (p.rx ?? 0) : (p.rz ?? 0)
          }
          emphasizeRing(kind)
        } else if (kind === 'scaleAll') {
          const bb = partsBBox([...selSet])
          const center = bb.getCenter(new THREE.Vector3())
          handleDrag = {
            kind, grabY: gh[0].point.y, center,
            startDist: Math.max(0.02, Math.hypot(gh[0].point.x - center.x, gh[0].point.z - center.z)),
            snapshot: JSON.parse(JSON.stringify(parts))
          }
        } else {
          handleDrag = { kind, grabY: gh[0].point.y, startY: parts[primary()]?.y ?? 0 }
        }
        return
      }
    }
    const hits = ray.intersectObjects(partsGroup.children, false)
    if (!hits.length) {
      // 空クリック(動かさなければ)で選択解除は pointerup で判定。ここではカメラ操作に任せる
      return
    }
    e.stopPropagation()
    controls.enabled = false
    const idx = hits[0].object.userData.idx as number
    if (e.shiftKey) {
      if (selSet.has(idx)) selSet.delete(idx); else selSet.add(idx)
      rebuildParts(); renderList(); renderFields()
      return
    }
    if (!selSet.has(idx)) { selSet.clear(); selSet.add(idx) }
    dragIds = [...selSet]
    dragLast = hits[0].point.clone()
    renderer.domElement.style.cursor = 'grabbing'
    rebuildParts(); renderList(); renderFields()
  }, true)

  renderer.domElement.addEventListener('pointermove', e => {
    if (penMode) {
      const pc = penCursor(e)
      if (pc) {
        sketchOv.update({
          camera, canvas: renderer.domElement,
          cursor: pc.cur, y: 0, pts: penPts, rectStart: penRectStart,
          snap: pc.snap, axis: pc.axis
        })
        render()
      }
      return
    }
    if (ringDrag) {
      const p = parts[primary()]
      if (!p) return
      const now = ringAngle(e, ringDrag.axis, ringDrag.center)
      let deltaDeg = ((now - ringDrag.startAngle) * 180) / Math.PI
      if (ringDrag.axis !== 'y') deltaDeg = -deltaDeg // マウスの動きに合わせた回転向き
      const deg = angleDetentDeg(ringDrag.startDeg + deltaDeg) // 45°ごとに一瞬止まる
      if (ringDrag.axis === 'y') p.rot = deg
      else if (ringDrag.axis === 'x') p.rx = deg || undefined
      else p.rz = deg || undefined
      exitPreview(); rebuildParts(); renderFields()
      return
    }
    if (handleDrag) {
      ray.setFromCamera(ndc(e), camera)
      const k = handleDrag.kind
      if (k === 'scaleAll') {
        // 複数選択の一括拡大縮小(相対位置・比率を保持)
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -handleDrag.grabY)
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        const c = handleDrag.center!
        const f = Math.max(0.05, Math.hypot(q.x - c.x, q.z - c.z) / handleDrag.startDist!)
        const snap = handleDrag.snapshot!
        const cxm = c.x / MM, czm = c.z / MM
        for (const idx of selSet) {
          const s0 = snap[idx]
          const p = parts[idx]
          if (!s0 || !p) continue
          // 相対位置・相対サイズを保ったまま bbox 中心基準で等倍
          p.x = Math.round(cxm + (s0.x - cxm) * f)
          p.z = Math.round(czm + (s0.z - czm) * f)
          p.y = Math.round(s0.y * f)
          p.sx = Math.max(10, Math.round((s0.sx * f) / 10) * 10)
          p.sy = Math.max(10, Math.round((s0.sy * f) / 10) * 10)
          p.sz = Math.max(10, Math.round((s0.sz * f) / 10) * 10)
        }
        exitPreview(); rebuildParts(); renderFields()
        return
      }
      const p = parts[primary()]
      if (!p) return
      if (k === 'lift') {
        // Y 軸に平行な高さ移動(掴んだ位置からの差分で動かす)
        const dir = camera.getWorldDirection(new THREE.Vector3())
        const n = new THREE.Vector3(dir.x, 0, dir.z).normalize()
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(p.x * MM, handleDrag.grabY, p.z * MM))
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        p.y = Math.round(((handleDrag.startY ?? 0) + (q.y - handleDrag.grabY) / MM) / 10) * 10
      } else if (k === 'y+' || k === 'y-') {
        const dir = camera.getWorldDirection(new THREE.Vector3())
        const n = new THREE.Vector3(dir.x, 0, dir.z).normalize()
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(p.x * MM, handleDrag.grabY, p.z * MM))
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        if (k === 'y+') {
          p.sy = Math.max(10, Math.round((q.y / MM - p.y) / 10) * 10) // 上面を押し引き(底面固定)
        } else {
          const top = p.y + p.sy
          const newY = Math.round((q.y / MM) / 10) * 10
          p.sy = Math.max(10, top - newY) // 底面を押し引き(上面固定)
          p.y = top - p.sy
        }
      } else {
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -handleDrag.grabY)
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        const lx = q.x / MM - p.x, lz = q.z / MM - p.z
        const rad = (p.rot * Math.PI) / 180
        const cos = Math.cos(rad), sin = Math.sin(rad)
        const local = { x: lx * cos + lz * sin, z: -lx * sin + lz * cos }
        const axis = k[0] === 'x' ? 'x' : 'z'
        const sign = k[1] === '+' ? 1 : -1
        const size = axis === 'x' ? p.sx : p.sz
        const v = Math.max(10, Math.round((sign * (axis === 'x' ? local.x : local.z) + size / 2) / 10) * 10)
        const shift = (sign * (v - size)) / 2
        if (axis === 'x') { p.sx = v; p.x += shift * cos; p.z += shift * sin }
        else { p.sz = v; p.x += shift * -sin; p.z += shift * cos }
      }
      exitPreview(); rebuildParts(); renderFields()
      return
    }
    if (dragIds && dragLast) {
      ray.setFromCamera(ndc(e), camera)
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -dragLast.y)
      const q = new THREE.Vector3()
      if (!ray.ray.intersectPlane(plane, q)) return
      const dx = Math.round(((q.x - dragLast.x) / MM) / 10) * 10
      const dz = Math.round(((q.z - dragLast.z) / MM) / 10) * 10
      if (!dx && !dz) return
      dragMoved = true
      dragLast.x += dx * MM
      dragLast.z += dz * MM
      for (const i of dragIds) { parts[i].x += dx; parts[i].z += dz }
      exitPreview(); rebuildParts(); renderFields()
      return
    }
    // つまみホバーで grab カーソル + リングのホバー強調
    if (!previewing && gizmo.children.length) {
      ray.setFromCamera(ndc(e), camera)
      const hits = ray.intersectObjects(gizmo.children, true)
      renderer.domElement.style.cursor = hits.length ? 'grab' : ''
      if (rotMode) {
        let hk: string | null = null
        if (hits.length) {
          let o: THREE.Object3D | null = hits[0].object
          while (o && !o.userData.g) o = o.parent
          hk = (o?.userData.g as string) ?? null
        }
        emphasizeRing(hk && hk.startsWith('r') ? hk : null)
      }
    }
  })
  const endInteraction = (e: PointerEvent): void => {
    const wasInteracting = !!(dragIds || handleDrag || ringDrag)
    dragIds = null
    dragLast = null
    handleDrag = null
    ringDrag = null
    controls.enabled = true
    renderer.domElement.style.cursor = ''
    // 空クリック(何もヒットせず・動かしていない)→ 選択解除
    if (!wasInteracting && !previewing && !penMode && e.button === 0) {
      ray.setFromCamera(ndc(e), camera)
      const hitPart = ray.intersectObjects(partsGroup.children, false).length > 0
      const hitGizmo = gizmo.children.length > 0 && ray.intersectObjects(gizmo.children, true).length > 0
      const cameraMoved = dragMoved
      if (!hitPart && !hitGizmo && !cameraMoved && selSet.size) {
        selSet.clear()
        rotMode = false
        rebuildParts(); renderList(); renderFields()
      }
    }
    if (rotMode) emphasizeRing(null)
  }
  renderer.domElement.addEventListener('pointerup', endInteraction)
  renderer.domElement.addEventListener('dblclick', () => { if (penMode && penPts.length >= 2) closePen() })
  renderer.domElement.addEventListener('contextmenu', e => {
    e.preventDefault()
    if (penMode) setPenMode(false) // 右クリックで鉛筆をキャンセル
  })
  // キャンバス外で離した場合も確実に終了(紫つまみが付いてくる問題の防止)
  const winUp = (e: PointerEvent): void => {
    if (dragIds || handleDrag || ringDrag) endInteraction(e)
  }
  window.addEventListener('pointerup', winUp)

  // ---------- プレビュー・保存・終了 ----------
  const close = (): void => {
    window.removeEventListener('pointerup', winUp)
    sketchOv.dispose()
    renderer.dispose()
    modal.remove()
  }
  ;(modal.querySelector('[data-a="close"]') as HTMLButtonElement).onclick = close
  ;(modal.querySelector('[data-a="preview"]') as HTMLButtonElement).onclick = () => {
    if (previewing) refresh()
    else showPreview()
  }
  ;(modal.querySelector('[data-a="save"]') as HTMLButtonElement).onclick = () => {
    const geo = csgOf(parts, 'recipe')
    if (!geo) { alert('「追加」のパーツが 1 つ以上必要です'); return }
    const baked = bakePart(geo, 'add')
    if (!baked) { alert('形状が空です'); return }
    const name = (modal.querySelector('.st-name') as HTMLInputElement).value || 'オリジナル部品'
    const ent: CustomE = {
      id: uid(), type: 'custom', pos: { x: 0, y: 0 }, rot: 0,
      w: baked.sx, d: baked.sz, h: baked.sy,
      w0: baked.sx, d0: baked.sz, h0: baked.sy,
      label: (modal.querySelector('.st-label') as HTMLInputElement).value,
      symbol: (modal.querySelector('.st-symbol') as HTMLSelectElement).value as 'rect' | 'round',
      positions: baked.positions ?? [],
      recipe: { parts: JSON.parse(JSON.stringify(parts)) }
    }
    onSave(ent, name)
    close()
  }

  refresh()
  resize()
}
