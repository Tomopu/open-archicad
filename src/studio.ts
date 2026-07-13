// 部品スタジオ — 2D 図面から独立した 3D モデリングモード。
// プリミティブ(箱・円柱・球・円錐)を組み合わせ/くり抜き/交差(CSG)してオリジナル部品を作る。
// 複数選択 → ブール演算アイコン・一括拡大縮小。回転はリングで自由回転(45°吸着)。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Evaluator, Brush, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg'
import { CustomE, uid } from './model'
import { Pt, pt, dist, norm, angleDetentDeg, snapTo, strokePerpGuide, CURSOR_PENCIL, CURSOR_HAND } from './geometry'
import { SketchOverlay, axisLock, SnapInfo } from './sketchInput'
import {
  Prism, FaceRef, sameFace, faceFromHit, edgesOfFace, nearestEdge as nearestSolidEdge,
  SolidHighlight, movePolyVertex, sideNormal, extrudeSidePoly
} from './solidSelect'
import { params } from './tools'

type PartKind = 'box' | 'cyl' | 'sphere' | 'cone' | 'poly' | 'baked'
export interface StudioPart {
  kind: PartKind
  op: 'add' | 'sub'
  /** オブジェクト一覧での表示名(リネーム可能)と表示 / 非表示・色 */
  name?: string
  hidden?: boolean
  color?: string
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
    case 'cyl': g = new THREE.CylinderGeometry(p.sx / 2, p.sx / 2, p.sy, 24).scale(1, 1, p.sz / Math.max(1, p.sx)); break
    case 'sphere': g = new THREE.SphereGeometry(p.sx / 2, 20, 14).scale(1, p.sy / p.sx, p.sz / p.sx); break
    case 'cone': g = new THREE.ConeGeometry(p.sx / 2, p.sy, 20).scale(1, 1, p.sz / Math.max(1, p.sx)); break
    case 'poly': {
      // 鉛筆で描いた平面形状(plan y → +z)。高さ 0 = 厚さのない平面、> 0 で押し出し
      const pts = p.pts ?? []
      const shape = new THREE.Shape(pts.map(q => new THREE.Vector2(q.x, -q.y)))
      if (p.sy < 1) {
        g = new THREE.ShapeGeometry(shape)
        g.rotateX(-Math.PI / 2)
        g.scale(p.sx / (p.bx ?? p.sx), 1, p.sz / (p.bz ?? p.sz))
      } else {
        g = new THREE.ExtrudeGeometry(shape, { depth: p.sy, bevelEnabled: false })
        g.rotateX(-Math.PI / 2)
        g.scale(p.sx / (p.bx ?? p.sx), 1, p.sz / (p.bz ?? p.sz))
        g.translate(0, -p.sy / 2, 0) // 中心原点に合わせる
      }
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
    if (p.hidden) continue // 非表示のオブジェクトは演算から除外
    // 厚さ 0 の平面はそのままではブール演算できないため、演算時のみ 2mm の薄板にする
    const geoPart = p.kind === 'poly' && p.sy < 1 ? { ...p, sy: 2 } : p
    const brush = new Brush(partGeometry(geoPart))
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
  /** 自作の 2D 記号(再編集時に引き継ぐ) */
  symbolSketch?: { edges: import('./model').SketchEdge[] }
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
        <div class="st-toolopts props"></div>
      </div>
      <div class="studio-split" title="ドラッグでメニューの幅を変更"></div>
      <div class="studio-view">
        <div class="studio-toolbar">
          <button class="st-symmode" title="2D 記号を平面図モードで作図(3D 部品を半透明の下敷きに表示)">2D記号</button>
          <span class="sep"></span>
          <span class="hint">視点:</span>
          <button data-v="top" title="上面">上</button>
          <button data-v="front" title="正面">正</button>
          <button data-v="side" title="側面">横</button>
          <button data-v="iso" title="鳥瞰">鳥</button>
          <span class="sep"></span>
          <label class="hint" style="display:flex;align-items:center;gap:3px" title="XYZ軸を表示">
            <input type="checkbox" class="st-axes"> 軸
          </label>
          <label class="hint" style="display:flex;align-items:center;gap:3px" title="ワイヤーフレーム表示">
            <input type="checkbox" class="st-wire"> 線画
          </label>
          <label class="hint" style="display:flex;align-items:center;gap:3px" title="2D 記号(平面図での見え方)を高さ 0 に半透明で表示">
            <input type="checkbox" class="st-sym2d"> 2D記号を表示
          </label>
        </div>
        <div class="studio-actions" hidden>
          <button data-pa="dup" title="複製"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
          <button data-pa="rot" title="回転リング(自由回転、45°ごとに吸着)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11a8.5 8.5 0 1 0-2.2 7"/><path d="M21 4.5V11h-6.5"/></svg></button>
          <button data-pa="union" title="合成(マージ)" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/></svg></button>
          <button data-pa="subtract" title="くり抜き(先に選択した形から差し引く)" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6" stroke-dasharray="2.5 2"/></svg></button>
          <button data-pa="intersect" title="交差(重なり部分だけ残す)" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 7.4a6 6 0 0 1 0 9.2 6 6 0 0 1 0-9.2z" fill="currentColor" fill-opacity=".25"/><circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6"/></svg></button>
          <button data-pa="del" title="削除" style="color:var(--danger)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .9h7.4a1 1 0 0 0 1-.9l.8-12M10 11v5M14 11v5"/></svg></button>
        </div>
        <div class="studio-scale"><div class="segs"></div><div class="label"></div></div>
        <div class="studio-foot">
          <span class="st-coords">x: 0, y: 0</span>
          <span class="sep"></span>
          <label>スナップ
            <select class="st-snap">
              <option value="455">455 (半モジュール)</option>
              <option value="910">910 (1モジュール)</option>
              <option value="100">100</option>
              <option value="10" selected>10</option>
              <option value="0">なし</option>
            </select>
          </label>
          <label>長さ <input type="number" class="st-len" min="1" step="10" style="width:70px"> mm</label>
          <span class="spacer"></span>
          <span class="hint st-hint">クリック: 選択 / Shift+クリック: 追加 / ドラッグ: 移動 / 鉛筆: 地面をクリックして多角形(ダブルクリックで閉じる) / 数値 + Enter で長さ確定 / ⌘Z: 取り消し</span>
        </div>
      </div>
      <div class="studio-side">
        <div class="panel-title">オブジェクト一覧
          <span class="title-actions"><button class="st-merge" title="選択したオブジェクトをマージ(合成)" hidden>マージ</button></span>
        </div>
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
    const L = 100, R = 0.004
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

  // DoubleSide: 厚さ 0 の平面(鉛筆)も裏から見える
  const MAT_ADD = new THREE.MeshLambertMaterial({ color: 0xd4d4d8, side: THREE.DoubleSide })
  const MAT_SUB = new THREE.MeshLambertMaterial({ color: 0xef4444, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
  const MAT_SEL = new THREE.MeshLambertMaterial({ color: 0x93b4f8, emissive: 0x1d4ed8, emissiveIntensity: 0.2, side: THREE.DoubleSide })
  const MAT_RESULT = new THREE.MeshLambertMaterial({ color: 0xd4b896, side: THREE.DoubleSide })

  // ---------- 状態 ----------
  const initParts = Array.isArray(initial?.parts) ? (initial!.parts as StudioPart[]) : null
  const parts: StudioPart[] = initParts && initParts.length
    ? JSON.parse(JSON.stringify(initParts))
    : [{ kind: 'box', op: 'add', x: 0, y: 0, z: 0, sx: 600, sy: 400, sz: 400, rot: 0 }]
  const selSet = new Set<number>([0])
  let previewing = false
  let rotMode = false
  const primary = (): number => (selSet.size ? Math.max(...selSet) : -1)
  // Undo / Redo(3D モードと同じ ⌘Z / ⇧⌘Z)
  const undoStack: string[] = []
  const redoStack: string[] = []
  const pushUndo = (): void => {
    undoStack.push(JSON.stringify(parts))
    if (undoStack.length > 60) undoStack.shift()
    redoStack.length = 0
  }
  const restoreParts = (json: string): void => {
    parts.length = 0
    parts.push(...(JSON.parse(json) as StudioPart[]))
    selSet.clear()
    if (parts.length) selSet.add(parts.length - 1)
    refresh()
  }
  const studioUndo = (): void => {
    const j = undoStack.pop()
    if (j === undefined) return
    redoStack.push(JSON.stringify(parts))
    restoreParts(j)
  }
  const studioRedo = (): void => {
    const j = redoStack.pop()
    if (j === undefined) return
    undoStack.push(JSON.stringify(parts))
    restoreParts(j)
  }

  // ---------- 2D 記号モード(平面図で記号を作図。3D には反映されない) ----------
  let symMode = false
  let symEdges: import('./model').SketchEdge[] =
    JSON.parse(JSON.stringify(initial?.symbolSketch?.edges ?? []))
  let symStroke: Pt[] = []
  const symDrawGroup = new THREE.Group()
  scene.add(symDrawGroup)
  const GHOST_PART_MAT = new THREE.MeshLambertMaterial({ color: 0xd4d4d8, transparent: true, opacity: 0.22, side: THREE.DoubleSide })
  const drawSymEdges = (): void => {
    symDrawGroup.traverse(o => { if (o instanceof THREE.Line) o.geometry.dispose() })
    symDrawGroup.clear()
    for (const ed of symEdges) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ed.a.x * MM, 0.004, ed.a.y * MM),
        new THREE.Vector3(ed.b.x * MM, 0.004, ed.b.y * MM)])
      const ln = new THREE.Line(g, new THREE.LineBasicMaterial({ color: ed.color ?? '#1f2937' }))
      ln.renderOrder = 991
      symDrawGroup.add(ln)
    }
  }
  // 記号はモデル上「部品中心からの相対 mm」。スタジオでは絶対座標で扱うので変換する
  const symCenter = (): Pt => {
    const geo = csgOf(parts, 'recipe')
    if (!geo) return pt(0, 0)
    geo.computeBoundingBox()
    const bb = geo.boundingBox!
    return bb.isEmpty() ? pt(0, 0) : pt((bb.min.x + bb.max.x) / 2, (bb.min.z + bb.max.z) / 2)
  }
  if (symEdges.length) {
    const c = symCenter()
    symEdges = symEdges.map(ed => ({
      ...ed,
      a: pt(ed.a.x + c.x, ed.a.y + c.y),
      b: pt(ed.b.x + c.x, ed.b.y + c.y)
    }))
  }
  drawSymEdges()

  // ---------- 立体(多角形パーツ)の面・辺選択 — solidSelect 共有モジュール ----------
  const solidHL = new SolidHighlight()
  scene.add(solidHL.group)
  let solidSelS: { idx: number; mode: 'face' | 'edges' | 'edge'; face: FaceRef; edgeIdx?: number } | null = null
  let solidHoverS: { idx: number; face: FaceRef } | null = null
  let solidEdgeHoverS: number | null = null
  let solidCycPend: { idx: number; face: FaceRef | null; edgeIdx: number } | null = null
  const prismOfPart = (p: StudioPart | undefined): Prism | null => {
    if (!p || p.kind !== 'poly' || !p.pts?.length) return null
    const sxf = p.sx / (p.bx ?? p.sx), szf = p.sz / (p.bz ?? p.sz)
    const rad = (p.rot * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    const poly = p.pts.map(q => {
      const lx = q.x * sxf, lz = q.y * szf
      return pt(p.x + lx * cos - lz * sin, p.z + lx * sin + lz * cos)
    })
    return { poly, y0: p.y * MM, y1: (p.y + Math.max(p.sy, 0)) * MM }
  }
  const updateSolidHLS = (): void => {
    solidHL.clear()
    if (solidSelS) {
      const prism = prismOfPart(parts[solidSelS.idx])
      if (prism) {
        if (solidSelS.mode === 'face') solidHL.showFace(prism, solidSelS.face, 'sel')
        else if (solidSelS.mode === 'edges') {
          solidHL.showEdges(prism, solidSelS.face)
          if (solidEdgeHoverS !== null) {
            const e = edgesOfFace(prism, solidSelS.face)[solidEdgeHoverS]
            if (e) solidHL.showEdge(e, 'hover')
          }
        } else if (solidSelS.edgeIdx !== undefined) {
          const e = edgesOfFace(prism, solidSelS.face)[solidSelS.edgeIdx]
          if (e) solidHL.showEdge(e, 'sel')
        }
      }
    }
    if (solidHoverS && (!solidSelS || (solidSelS.mode === 'face' &&
      !(solidSelS.idx === solidHoverS.idx && sameFace(solidSelS.face, solidHoverS.face))))) {
      const prism = prismOfPart(parts[solidHoverS.idx])
      if (prism) solidHL.showFace(prism, solidHoverS.face, 'hover')
    }
  }
  // テスト用の状態フック(UI には影響しない)
  const dbgN = { cycle: 0, rebuild: 0, gizmo: 0 }
  ;(window as unknown as { __stDbg?: unknown }).__stDbg = {
    get n() { return { ...dbgN, gizmoKids: gizmo.children.map(o => o.userData.g) } },
    get sel() { return solidSelS }, get hover() { return solidHoverS },
    get edgeHover() { return solidEdgeHoverS }, get selSet() { return [...selSet] },
    get parts() { return parts }, get symMode() { return symMode }, get symEdges() { return symEdges },
    proj(xMm: number, zMm: number, yM = 0): { x: number; y: number } {
      const v = new THREE.Vector3(xMm * MM, yM, zMm * MM).project(camera)
      const rc = renderer.domElement.getBoundingClientRect()
      return { x: ((v.x + 1) / 2) * rc.width, y: ((1 - v.y) / 2) * rc.height }
    }
  }
  const setPartPolyWorld = (p: StudioPart, worldPoly: Pt[]): void => {
    const xs = worldPoly.map(q => q.x), ys = worldPoly.map(q => q.y)
    const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2)
    const cy = Math.round((Math.min(...ys) + Math.max(...ys)) / 2)
    const bw = Math.max(10, Math.round(Math.max(...xs) - Math.min(...xs)))
    const bh = Math.max(10, Math.round(Math.max(...ys) - Math.min(...ys)))
    p.x = cx; p.z = cy; p.rot = 0
    p.sx = bw; p.sz = bh; p.bx = bw; p.bz = bh
    p.pts = worldPoly.map(q => ({ x: Math.round(q.x - cx), y: Math.round(q.y - cy) }))
  }

  // ---------- 鉛筆(多角形 / 長方形 → 押し出し)。3D モードと同じ入力機構(sketchInput)を共用 ----------
  let penMode = false
  let penPts: Pt[] = []                 // mm(平面)
  let penRectStart: Pt | null = null
  const sketchOv = new SketchOverlay(viewEl, MM)
  sketchOv.onModeToggle = () => {
    params.pencil.mode = params.pencil.mode === 'rect' ? 'poly' : 'rect'
    penPts = []
    penRectStart = null
  }
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
  let stSnapStep = 10 // フッタの「スナップ」で変更
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
    if (stSnapStep > 0) return { p: pt(snapTo(p.x, stSnapStep), snapTo(p.y, stSnapStep)), kind: 'グリッド', guides: [] }
    return { p: pt(Math.round(p.x), Math.round(p.y)), kind: null, guides: [] }
  }
  /** スナップ + 軸平行ロックを適用したカーソル */
  const penCursor = (e: PointerEvent): { cur: Pt; snap: SnapInfo; axis: 'x' | 'y' | null } | null => {
    const gp = groundPt(e)
    if (!gp) return null
    let snap = studioSnap(gp)
    let cur = snap.p
    let axis: 'x' | 'y' | null = null
    if (snap.kind === 'グリッド') {
      // 始点から 1 辺目と垂直方向の延長ガイド(2D・3D と共通仕様)
      if (params.pencil.mode === 'poly' && penPts.length >= 2) {
        const g = strokePerpGuide(penPts, cur, 60)
        if (g) {
          // グリッドの交点で止める(2D・3D と同じ挙動)
          const foot = pt(snapTo(g.p.x, 10), snapTo(g.p.y, 10))
          snap = { p: foot, kind: '垂直', guides: [...snap.guides, { a: g.guide.a, b: foot }] }
          return { cur: foot, snap, axis: null }
        }
      }
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
    dbgN.gizmo++
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
    // 辺だけが選択されているとき: 端点つまみのみ(辺の長さ編集)
    if (solidSelS && solidSelS.mode === 'edge' && solidSelS.idx === primary() && solidSelS.edgeIdx !== undefined) {
      const prism = prismOfPart(p)
      if (prism) {
        const ed = edgesOfFace(prism, solidSelS.face)[solidSelS.edgeIdx]
        if (ed?.vi) {
          mkSquare('qe0', ed.a.x, ed.a.y + 0.01, ed.a.z, 0xf59e0b)
          mkSquare('qe1', ed.b.x, ed.b.y + 0.01, ed.b.z, 0xf59e0b)
          return
        }
      }
    }
    // 面だけが選択されているとき: その面に関係するつまみのみ
    if (solidSelS && solidSelS.idx === primary() &&
      (solidSelS.mode === 'face' || solidSelS.mode === 'edges')) {
      if (solidSelS.mode === 'edges') return // 辺の選択待ち
      const prism = prismOfPart(p)
      if (prism) {
        const mkCone = (kind: string, pos: THREE.Vector3, dir: THREE.Vector3): void => {
          const g = new THREE.Group()
          const white = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.21, 12),
            new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }))
          const blue = new THREE.Mesh(new THREE.ConeGeometry(0.072, 0.16, 12),
            new THREE.MeshBasicMaterial({ color: 0x2563eb, depthTest: false }))
          white.renderOrder = 998; blue.renderOrder = 999
          g.add(white, blue)
          g.position.copy(pos)
          g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
          g.userData.g = kind
          gizmo.add(g)
        }
        const offC = 0.09
        const f = solidSelS.face
        if (f.kind === 'side') {
          const i = f.i
          const a = prism.poly[i], b = prism.poly[(i + 1) % prism.poly.length]
          const n2 = sideNormal(prism.poly, i)
          const mid = pt((a.x + b.x) / 2, (a.y + b.y) / 2)
          mkCone('fx',
            new THREE.Vector3(mid.x * MM + n2.x * offC, (prism.y0 + prism.y1) / 2, mid.y * MM + n2.y * offC),
            new THREE.Vector3(n2.x, 0, n2.y))
        } else {
          const cxs = prism.poly.reduce((sum, q) => sum + q.x, 0) / prism.poly.length
          const cys = prism.poly.reduce((sum, q) => sum + q.y, 0) / prism.poly.length
          if (f.kind === 'top') {
            mkCone('y+', new THREE.Vector3(cxs * MM, prism.y1 + offC, cys * MM), new THREE.Vector3(0, 1, 0))
          } else {
            mkCone('y-', new THREE.Vector3(cxs * MM, prism.y0 - offC, cys * MM), new THREE.Vector3(0, -1, 0))
          }
        }
      }
      return
    }
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
    // 四隅: 反対の角を固定して幅・奥行を変更(3D モードと同じ)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        mkSquare(`c${sx === 1 ? 'p' : 'm'}${sz === 1 ? 'p' : 'm'}`,
          cx + dw.x * hx * sx + dd.x * hz * sz, midY,
          cz + dw.z * hx * sx + dd.z * hz * sz)
      }
    }
    // 鉛筆(多角形)パーツ: 各頂点のつまみ(掴んで形を変える)
    if (p.kind === 'poly' && p.pts?.length) {
      const sxf = p.sx / (p.bx ?? p.sx), szf = p.sz / (p.bz ?? p.sz)
      const cosR = Math.cos(rad), sinR = Math.sin(rad)
      p.pts.forEach((q, i) => {
        const lx = q.x * sxf, lz = q.y * szf
        mkSquare(`pv${i}`,
          (p.x + lx * cosR - lz * sinR) * MM, p.y * MM + 0.02,
          (p.z + lx * sinR + lz * cosR) * MM, 0x16a34a)
      })
    }
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
  // 2D 記号のプレビュー(高さ 0・半透明。3D 側と干渉しない表示ガイド)
  const symGroup = new THREE.Group()
  symGroup.visible = false
  scene.add(symGroup)
  const updateSym2d = (): void => {
    symGroup.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    symGroup.clear()
    if (!symGroup.visible) { render(); return }
    const bb = new THREE.Box3().setFromObject(partsGroup)
    if (bb.isEmpty()) { render(); return }
    const w = Math.max(0.05, bb.max.x - bb.min.x)
    const d = Math.max(0.05, bb.max.z - bb.min.z)
    const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2
    const round = (modal.querySelector('.st-symbol') as HTMLSelectElement).value === 'round'
    const geo = round
      ? new THREE.CircleGeometry(Math.max(w, d) / 2, 40).scale(1, d / Math.max(w, d), 1)
      : new THREE.PlaneGeometry(w, d)
    geo.rotateX(-Math.PI / 2)
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x2563eb, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false
    }))
    mesh.position.set(cx, 0.002, cz)
    symGroup.add(mesh)
    render()
  }
  ;(modal.querySelector('.st-sym2d') as HTMLInputElement).onchange = e => {
    symGroup.visible = (e.target as HTMLInputElement).checked
    updateSym2d()
  }
  ;(modal.querySelector('.st-symbol') as HTMLSelectElement).addEventListener('change', () => updateSym2d())

  // 線画(ワイヤーフレーム)
  ;(modal.querySelector('.st-wire') as HTMLInputElement).onchange = e => {
    const on = (e.target as HTMLInputElement).checked
    const seen = new Set<THREE.Material>()
    partsGroup.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return
      const m = o.material as THREE.MeshLambertMaterial
      if (!seen.has(m)) { seen.add(m); m.wireframe = on }
    })
    for (const m of [MAT_ADD, MAT_SUB, MAT_SEL, MAT_RESULT]) m.wireframe = on
    render()
  }
  // 視点プリセット(3D モードと同様)
  modal.querySelectorAll('[data-v]').forEach(b => {
    ;(b as HTMLButtonElement).onclick = () => {
      const bb = new THREE.Box3().setFromObject(partsGroup)
      const c = bb.isEmpty() ? new THREE.Vector3(0, 0.2, 0) : bb.getCenter(new THREE.Vector3())
      const size = bb.isEmpty() ? 2 : bb.getSize(new THREE.Vector3()).length()
      const d = Math.max(1.2, size * 1.4)
      const v = (b as HTMLElement).dataset.v
      const pos: Record<string, number[]> = {
        top: [c.x, c.y + d, c.z + 0.01],
        front: [c.x, c.y + d * 0.15, c.z + d],
        side: [c.x + d, c.y + d * 0.15, c.z],
        iso: [c.x + d * 0.7, c.y + d * 0.6, c.z + d * 0.7]
      }
      const q = pos[v ?? 'iso']
      camera.position.set(q[0], q[1], q[2])
      controls.target.copy(c)
      controls.update()
      render()
    }
  })
  // 2D 記号モード: 上面視点に切り替え、3D 部品を半透明の下敷きにして記号を作図
  const symBtn = modal.querySelector('.st-symmode') as HTMLButtonElement
  const setSymMode = (on: boolean): void => {
    symMode = on
    symBtn.classList.toggle('active', on)
    symStroke = []
    setPenMode(false)
    endPlacing()
    solidSelS = null; solidHoverS = null; updateSolidHLS()
    if (on) {
      // 上面(平面図)視点へ
      const bb = new THREE.Box3().setFromObject(partsGroup)
      const c = bb.isEmpty() ? new THREE.Vector3(0, 0, 0) : bb.getCenter(new THREE.Vector3())
      const size = bb.isEmpty() ? 2 : bb.getSize(new THREE.Vector3()).length()
      camera.position.set(c.x, Math.max(1.5, size * 1.6), c.z + 0.001)
      controls.target.set(c.x, 0, c.z)
      controls.update()
    }
    exitPreview()
    rebuildParts()
    sketchOv.hide()
    renderer.domElement.style.cursor = on ? CURSOR_PENCIL : ''
    render()
  }
  symBtn.onclick = () => setSymMode(!symMode)

  // 一覧のマージボタン(複数選択時)
  const mergeBtn = modal.querySelector('.st-merge') as HTMLButtonElement
  mergeBtn.onclick = () => applyBool('union')
  // 左レールのツール設定(鉛筆の入力モード・新規オブジェクトの色)
  const tooloptsEl = modal.querySelector('.st-toolopts') as HTMLElement
  const renderToolOpts = (): void => {
    tooloptsEl.innerHTML = '<div class="cp-title">ツール設定</div>'
    const modeSel = document.createElement('select')
    modeSel.innerHTML = '<option value="poly">鉛筆(線)</option><option value="rect">長方形(2点)</option>'
    modeSel.value = params.pencil.mode
    modeSel.onchange = () => { params.pencil.mode = modeSel.value as 'poly' | 'rect' }
    const modeDiv = document.createElement('div')
    modeDiv.className = 'field'
    modeDiv.innerHTML = '<label>入力モード</label>'
    modeDiv.appendChild(modeSel)
    const colorIn = document.createElement('input')
    colorIn.type = 'color'
    colorIn.value = params.pencil.color ?? '#d4d4d8'
    colorIn.onchange = () => { params.pencil.color = colorIn.value }
    const colorDiv = document.createElement('div')
    colorDiv.className = 'field'
    colorDiv.innerHTML = '<label>色(新規)</label>'
    colorDiv.appendChild(colorIn)
    tooloptsEl.append(modeDiv, colorDiv)
  }
  renderToolOpts()
  // 画面下部の長さ入力(鉛筆の辺の長さを mm で確定)
  // フッタ: スナップ幅の選択
  const snapSel = modal.querySelector('.st-snap') as HTMLSelectElement
  snapSel.onchange = () => { stSnapStep = parseInt(snapSel.value, 10) || 0 }
  const coordsEl = modal.querySelector('.st-coords') as HTMLElement
  // レールの幅をスプリッターで変更
  const railEl = modal.querySelector('.studio-rail') as HTMLElement
  const splitEl = modal.querySelector('.studio-split') as HTMLElement
  splitEl.addEventListener('pointerdown', e => {
    e.preventDefault()
    const startX = e.clientX
    const startW = railEl.getBoundingClientRect().width
    const mv = (ev: PointerEvent): void => {
      railEl.style.width = `${Math.min(340, Math.max(84, startW + ev.clientX - startX))}px`
      resize()
    }
    const up = (): void => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  })
  const lenIn = modal.querySelector('.st-len') as HTMLInputElement
  lenIn.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key !== 'Enter') return
    e.preventDefault()
    const len = parseFloat(lenIn.value)
    lenIn.value = ''
    if (!(len > 0) || !penMode || !penPts.length) return
    const last = penPts[penPts.length - 1]
    const dir = penHover ? norm(pt(penHover.x - last.x, penHover.y - last.y)) : pt(1, 0)
    if (dir.x || dir.y) {
      const next = pt(Math.round(last.x + dir.x * len), Math.round(last.y + dir.y * len))
      penPts.push(next)
      penHover = next
      sketchOv.update({
        camera, canvas: renderer.domElement,
        cursor: next, y: 0, pts: penPts, rectStart: penRectStart,
        snap: { p: next, kind: null, guides: [] }, mode: params.pencil.mode, crossMm: 20
      })
      render()
    }
  })

  const colorMats = new Map<string, THREE.MeshLambertMaterial>()
  const partMat = (p: StudioPart): THREE.Material => {
    if (p.op === 'sub') return MAT_SUB
    if (!p.color) return MAT_ADD
    let m = colorMats.get(p.color)
    if (!m) { m = new THREE.MeshLambertMaterial({ color: p.color, side: THREE.DoubleSide }); colorMats.set(p.color, m) }
    return m
  }
  const rebuildParts = (): void => {
    dbgN.rebuild++
    partsGroup.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    partsGroup.clear()
    parts.forEach((p, i) => {
      const mesh = new THREE.Mesh(partGeometry(p),
        symMode ? GHOST_PART_MAT
          : selSet.has(i) && solidSelS?.idx !== i ? MAT_SEL
          : partMat(p))
      mesh.userData.idx = i
      mesh.visible = !p.hidden
      partsGroup.add(mesh)
    })
    partsGroup.visible = !previewing
    if (solidSelS && !prismOfPart(parts[solidSelS.idx])) solidSelS = null
    if (solidHoverS && !prismOfPart(parts[solidHoverS.idx])) solidHoverS = null
    updateSolidHLS()
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

  // ---------- UI: オブジェクト一覧(3D モードと同等: 表示切替・リネーム・Shift 範囲選択)・フィールド ----------
  const listEl = modal.querySelector('.studio-parts') as HTMLElement
  const fieldsEl = modal.querySelector('.studio-fields') as HTMLElement
  const EYE_ON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 3l18 18M10.5 5.2A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.1 8.1 2.5 10.5 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.5 4.4-1.2"/></svg>'
  let listAnchor = -1 // Shift 範囲選択の起点
  const partLabel = (p: StudioPart): string =>
    p.name ?? `${KIND_LABEL[p.kind]}${p.op === 'sub' ? '(くり抜き)' : ''}`
  const renderList = (): void => {
    if (listEl.contains(document.activeElement)) return // リネーム入力中は再構築しない
    mergeBtn.hidden = selSet.size < 2
    listEl.innerHTML = ''
    parts.forEach((p, i) => {
      const row = document.createElement('div')
      row.className = 'comp-item obj-row' + (selSet.has(i) ? ' active' : '')
      // 表示 / 非表示(目のアイコン)
      const eye = document.createElement('button')
      eye.className = 'obj-eye' + (p.hidden ? ' off' : '')
      eye.title = p.hidden ? '表示する' : '非表示にする(CSG 演算からも除外)'
      eye.innerHTML = p.hidden ? EYE_OFF : EYE_ON
      eye.onclick = ev => {
        ev.stopPropagation()
        p.hidden = !p.hidden || undefined
        if (p.hidden) selSet.delete(i)
        exitPreview()
        rebuildParts()
        renderList()
      }
      row.appendChild(eye)
      const icon = document.createElement('span')
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5">${KIND_ICON[p.kind]}</svg>`
      row.appendChild(icon)
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = partLabel(p)
      if (p.hidden) name.style.opacity = '0.45'
      // 選択済みブロックの名前クリック → その場でリネーム(ポップアップなし)
      name.onclick = ev => {
        if (selSet.has(i) && selSet.size === 1) {
          ev.stopPropagation()
          const input = document.createElement('input')
          input.type = 'text'
          input.value = partLabel(p)
          input.className = 'inline-rename'
          let doneFlag = false
          const finish = (ok: boolean): void => {
            if (doneFlag) return
            doneFlag = true
            if (ok && input.value.trim()) p.name = input.value.trim()
            input.onblur = null
            input.remove()
            renderList()
          }
          input.onkeydown = kev => {
            kev.stopPropagation()
            if (kev.key === 'Enter') { kev.preventDefault(); finish(true) }
            else if (kev.key === 'Escape') finish(false)
          }
          input.onblur = () => finish(true)
          input.onclick = kev => kev.stopPropagation()
          input.onpointerdown = kev => kev.stopPropagation()
          name.replaceWith(input)
          input.focus()
          input.select()
        }
      }
      row.appendChild(name)
      row.onclick = ev => {
        if (ev.shiftKey && listAnchor >= 0) {
          // 範囲選択: 起点から今回の行まで
          const [a, b] = [Math.min(listAnchor, i), Math.max(listAnchor, i)]
          selSet.clear()
          for (let k = a; k <= b; k++) selSet.add(k)
        } else {
          selSet.clear()
          selSet.add(i)
          listAnchor = i
        }
        refresh()
      }
      const del = document.createElement('button')
      del.textContent = '×'
      del.title = '削除'
      del.onclick = ev => {
        ev.stopPropagation()
        pushUndo()
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
    inp.onchange = () => { pushUndo(); set(parseFloat(inp.value) || 0); exitPreview(); rebuildParts(); renderList() }
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
    // 色(オブジェクトに色を塗る)
    const colDiv = document.createElement('div')
    colDiv.className = 'field'
    colDiv.innerHTML = '<label>色</label>'
    const colIn = document.createElement('input')
    colIn.type = 'color'
    colIn.value = p.color ?? '#d4d4d8'
    colIn.onchange = () => { pushUndo(); p.color = colIn.value; exitPreview(); rebuildParts(); renderList() }
    colDiv.appendChild(colIn)
    fieldsEl.append(
      opDiv,
      colDiv,
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

  // Space 押下中 = 視点操作(手のカーソル)。2D・3D と共通の操作系
  let spaceOn = false
  /** 鉛筆の数値長さ入力(2D・3D と共通仕様): 数字 + Enter でその長さの辺 */
  let numBuf = ''
  let penHover: Pt | null = null
  const applyCursor = (): void => {
    const want = spaceOn ? CURSOR_HAND : penMode ? CURSOR_PENCIL : ''
    if (renderer.domElement.style.cursor !== want) renderer.domElement.style.cursor = want
  }
  const onSpaceKey = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === ' ') {
      spaceOn = e.type === 'keydown'
      applyCursor()
      e.preventDefault()
      return
    }
    if (e.type !== 'keydown') return
    // ⌘Z / ⇧⌘Z: パーツ操作の Undo / Redo(鉛筆の作図中は線を 1 本戻す)
    if (symMode && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (symStroke.length > 1) { symStroke.pop(); symEdges.pop() }
      else if (symStroke.length) symStroke = []
      else symEdges.pop()
      drawSymEdges()
      render()
      return
    }
    if (symMode && e.key === 'Escape') { symStroke = []; sketchOv.hide(); render(); return }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !penMode) {
      e.preventDefault()
      if (e.shiftKey) studioRedo(); else studioUndo()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && penMode) {
      e.preventDefault()
      if (penPts.length) penPts.pop()
      else if (penRectStart) penRectStart = null
      if (penHover) {
        sketchOv.update({
          camera, canvas: renderer.domElement,
          cursor: penHover, y: 0, pts: penPts, rectStart: penRectStart,
          snap: { p: penHover, kind: null, guides: [] }, mode: params.pencil.mode, crossMm: 20
        })
      }
      render()
      return
    }
    // 鉛筆(線)モード: 2 点目以降は数値 + Enter で長さ指定
    if (penMode && params.pencil.mode === 'poly' && penPts.length) {
      if (/^[0-9.]$/.test(e.key)) { numBuf += e.key; return }
      if (e.key === 'Backspace' && numBuf) { numBuf = numBuf.slice(0, -1); return }
      if (e.key === 'Enter' && numBuf) {
        const len = parseFloat(numBuf)
        numBuf = ''
        const last = penPts[penPts.length - 1]
        const dir = penHover ? norm(pt(penHover.x - last.x, penHover.y - last.y)) : pt(1, 0)
        if (len > 0 && (dir.x || dir.y)) {
          const next = pt(Math.round(last.x + dir.x * len), Math.round(last.y + dir.y * len))
          penPts.push(next)
          penHover = next // カーソル表示をその端点へ
          sketchOv.update({
            camera, canvas: renderer.domElement,
            cursor: next, y: 0, pts: penPts, rectStart: penRectStart,
            snap: { p: next, kind: null, guides: [] }, mode: params.pencil.mode, crossMm: 20
          })
        }
        render()
      }
    }
  }
  window.addEventListener('keydown', onSpaceKey)
  window.addEventListener('keyup', onSpaceKey)

  const penButton = modal.querySelector('[data-add="pen"]') as HTMLButtonElement
  const setPenMode = (on: boolean): void => {
    penMode = on
    penPts = []
    penRectStart = null
    numBuf = ''
    sketchOv.hide()
    penButton.classList.toggle('active', on)
    applyCursor()
    render()
  }
  /** 多角形パーツの再正規化: 頂点編集後に bbox 中心・寸法を取り直す */
  const renormPoly = (p: StudioPart): void => {
    if (!p.pts?.length) return
    const sxf = p.sx / (p.bx ?? p.sx), szf = p.sz / (p.bz ?? p.sz)
    const abs = p.pts.map(q => ({ x: q.x * sxf, y: q.y * szf }))
    const xs = abs.map(q => q.x), ys = abs.map(q => q.y)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const rad = (p.rot * Math.PI) / 180
    const cos = Math.cos(rad), sin = Math.sin(rad)
    p.x = Math.round(p.x + cx * cos - cy * sin)
    p.z = Math.round(p.z + cx * sin + cy * cos)
    const bw = Math.max(10, Math.round(Math.max(...xs) - Math.min(...xs)))
    const bh = Math.max(10, Math.round(Math.max(...ys) - Math.min(...ys)))
    p.sx = bw; p.sz = bh; p.bx = bw; p.bz = bh
    p.pts = abs.map(q => ({ x: Math.round(q.x - cx), y: Math.round(q.y - cy) }))
  }

  /** 多角形(mm)をパーツ化 */
  const makePolyPart = (poly: Pt[]): void => {
    if (poly.length < 3) return
    pushUndo()
    const xs = poly.map(q => q.x), ys = poly.map(q => q.y)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    const bw = Math.max(10, Math.round(Math.max(...xs) - Math.min(...xs)))
    const bh = Math.max(10, Math.round(Math.max(...ys) - Math.min(...ys)))
    parts.push({
      kind: 'poly', op: 'add',
      x: Math.round(cx), y: 0, z: Math.round(cy),
      sx: bw, sy: 0, sz: bh, rot: 0, // 厚さ 0 の平面(高さつまみ・プロパティで押し出せる)
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

  // レールのプリミティブ: クリック → 半透明ゴーストがカーソルに追従 → クリックで配置(3D モードと同様)
  let placing: PartKind | null = null
  const placeGhost = new THREE.Group()
  placeGhost.scale.setScalar(MM)
  placeGhost.visible = false
  scene.add(placeGhost)
  const PLACE_MAT = new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.32, depthWrite: false })
  const endPlacing = (): void => {
    placing = null
    placeGhost.visible = false
    placeGhost.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    placeGhost.clear()
    modal.querySelectorAll('.studio-rail button').forEach(b => b.classList.remove('placing'))
    render()
  }
  modal.querySelectorAll('[data-add]').forEach(b => {
    ;(b as HTMLButtonElement).onclick = () => {
      const kind = (b as HTMLElement).dataset.add as PartKind | 'pen'
      if (kind === 'pen') { endPlacing(); setPenMode(!penMode); return } // 鉛筆はモード切替
      setPenMode(false)
      endPlacing()
      placing = kind
      b.classList.add('placing')
      placeGhost.add(new THREE.Mesh(
        partGeometry({ kind, op: 'add', x: 0, y: 0, z: 0, sx: 400, sy: 400, sz: 400, rot: 0 }), PLACE_MAT))
      placeGhost.visible = false // 最初のマウス移動で表示
    }
  })

  // ---------- アクションアイコン ----------
  const applyBool = (mode: 'union' | 'subtract' | 'intersect'): void => {
    const idxs = [...selSet].sort((a, b) => a - b)
    if (idxs.length < 2) return
    pushUndo()
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
  // 基準点複写(3D モードと同じフロー): 基準点をクリック → ゴーストを見ながら配置先をクリック
  let dupState: { ids: number[]; base: Pt | null } | null = null
  const dupGhost = new THREE.Group()
  dupGhost.scale.setScalar(MM)
  dupGhost.visible = false
  scene.add(dupGhost)
  const DUP_MAT = new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.32, depthWrite: false })
  const endDup = (): void => {
    dupState = null
    dupGhost.visible = false
    dupGhost.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    dupGhost.clear()
    sketchOv.hide()
    render()
  }
  ;(actionsEl.querySelector('[data-pa="dup"]') as HTMLButtonElement).onclick = () => {
    if (!selSet.size) return
    dupState = { ids: [...selSet].sort((a, b) => a - b), base: null }
    renderer.domElement.style.cursor = 'crosshair'
  }
  ;(actionsEl.querySelector('[data-pa="rot"]') as HTMLButtonElement).onclick = () => {
    rotMode = !rotMode
    rebuildParts()
  }
  ;(actionsEl.querySelector('[data-pa="del"]') as HTMLButtonElement).onclick = () => {
    pushUndo()
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
  let handleDrag: {
    kind: string; grabY: number; startY?: number; startDist?: number
    snapshot?: StudioPart[]; center?: THREE.Vector3
    /** 面の垂直押し出し(fx): 開始時のフットプリントと面 */
    fx?: { poly: Pt[]; faceI: number; n: Pt; ground0: Pt }
  } | null = null
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
    if (spaceOn) return // Space 中は視点操作(OrbitControls に任せる)
    // 2D 記号モード: 鉛筆と同じ操作で記号の線を描く
    if (symMode) {
      e.stopPropagation()
      const pc = penCursor(e)
      if (!pc) return
      if (!symStroke.length) {
        symStroke = [pc.cur]
      } else {
        const last = symStroke[symStroke.length - 1]
        if (dist(pc.cur, last) > 1) {
          symEdges.push({ a: { ...last }, b: { ...pc.cur }, color: params.pencil.color, style: params.pencil.style === 'solid' ? undefined : params.pencil.style })
          if (symStroke.length >= 2 && dist(pc.cur, symStroke[0]) < 80) symStroke = []
          else symStroke.push(pc.cur)
          drawSymEdges()
        }
      }
      render()
      return
    }
    // プリミティブの配置モード: クリックで確定
    if (placing) {
      e.stopPropagation()
      const gp = groundPt(e)
      if (!gp) return
      const sp = studioSnap(gp).p
      pushUndo()
      parts.push({ kind: placing, op: 'add', x: Math.round(sp.x), y: 0, z: Math.round(sp.y), sx: 400, sy: 400, sz: 400, rot: 0, color: params.pencil.color })
      selSet.clear(); selSet.add(parts.length - 1)
      endPlacing()
      refresh()
      return
    }
    // 基準点複写: 1 クリック目 = 基準点 / 2 クリック目 = 配置先
    if (dupState) {
      e.stopPropagation()
      const gp = groundPt(e)
      if (!gp) return
      const sp = studioSnap(gp).p
      if (!dupState.base) {
        dupState.base = sp
        // ゴースト: 選択パーツの形をそのまま半透明で
        for (const i of dupState.ids) {
          const p = parts[i]
          if (!p) continue
          const geoPart = p.kind === 'poly' && p.sy < 1 ? { ...p, sy: 2 } : p
          dupGhost.add(new THREE.Mesh(partGeometry(geoPart), DUP_MAT))
        }
        dupGhost.position.set(0, 0, 0)
        dupGhost.visible = true
        render()
        return
      }
      pushUndo()
      const off = { x: sp.x - dupState.base.x, y: sp.y - dupState.base.y }
      const news: number[] = []
      for (const i of dupState.ids) {
        const p = parts[i]
        if (!p) continue
        parts.push({ ...JSON.parse(JSON.stringify(p)), x: Math.round(p.x + off.x), z: Math.round(p.z + off.y) })
        news.push(parts.length - 1)
      }
      selSet.clear(); news.forEach(i => selSet.add(i))
      renderer.domElement.style.cursor = ''
      endDup()
      refresh()
      return
    }
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
        pushUndo()
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
    // 多角形パーツ: 面 → 辺 → 1 辺 → 全体 のサイクル(静止クリックで進む)
    {
      const part = parts[idx]
      const prism = prismOfPart(part)
      if (prism) {
        const n = hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : null
        const f = faceFromHit(prism, hits[0].point, n)
        if (selSet.has(idx) && selSet.size === 1) {
          let edgeIdx = -1
          if (solidSelS?.mode === 'edges' && solidSelS.idx === idx) {
            edgeIdx = nearestSolidEdge(edgesOfFace(prism, solidSelS.face), camera, renderer.domElement, e.clientX, e.clientY)
          }
          solidCycPend = { idx, face: f, edgeIdx }
        } else if (f) {
          solidSelS = { idx, mode: 'face', face: f } // 1 回目のクリックで面
          updateSolidHLS()
        }
      } else if (solidSelS) {
        solidSelS = null
        updateSolidHLS()
      }
    }
    if (!selSet.has(idx)) { selSet.clear(); selSet.add(idx) }
    pushUndo()
    dragIds = [...selSet]
    dragLast = hits[0].point.clone()
    renderer.domElement.style.cursor = 'grabbing'
    rebuildParts(); renderList(); renderFields()
  }, true)

  renderer.domElement.addEventListener('pointermove', e => {
    { // フッタの座標表示(2D のステータスバーと同じ)
      const gpc = groundPt(e)
      if (gpc) coordsEl.textContent = `x: ${Math.round(gpc.x)}, y: ${Math.round(gpc.y)}`
    }
    if (spaceOn) return // 視点操作中はオーバーレイ更新もしない
    // 2D 記号モード: 鉛筆と同じ十字カーソル + ライブ線
    if (symMode) {
      const pc = penCursor(e)
      if (pc) {
        sketchOv.update({
          camera, canvas: renderer.domElement,
          cursor: pc.cur, y: 0, pts: symStroke,
          snap: pc.snap, axis: pc.axis, mode: 'poly', crossMm: 20
        })
        render()
      }
      return
    }
    // プリミティブ配置モード: ゴーストがカーソルに追従
    if (placing) {
      const gp = groundPt(e)
      if (gp) {
        const sp = studioSnap(gp).p
        placeGhost.position.set(sp.x * MM, 0, sp.y * MM)
        placeGhost.visible = true
        render()
      }
      return
    }
    // 基準点複写: 十字 + スナップガイド。基準点決定後はゴーストがカーソルに追従
    if (dupState) {
      const gp = groundPt(e)
      if (gp) {
        const snap = studioSnap(gp)
        sketchOv.update({
          camera, canvas: renderer.domElement,
          cursor: snap.p, y: 0, snap, crossMm: 20
        })
        if (dupState.base) {
          dupGhost.position.set((snap.p.x - dupState.base.x) * MM, 0, (snap.p.y - dupState.base.y) * MM)
        }
        render()
      }
      return
    }
    if (penMode) {
      const pc = penCursor(e)
      if (pc) {
        penHover = pc.cur
        sketchOv.update({
          camera, canvas: renderer.domElement,
          cursor: pc.cur, y: 0, pts: penPts, rectStart: penRectStart,
          snap: pc.snap, axis: pc.axis, mode: params.pencil.mode,
          dims: numBuf ? [{ text: `${numBuf} ⏎`, at: pc.cur }] : undefined,
          crossMm: 20
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
      if (k === 'qe0' || k === 'qe1') {
        const p = parts[primary()]
        const sel = solidSelS
        if (!p || !sel || sel.mode !== 'edge' || sel.edgeIdx === undefined) return
        const prism = prismOfPart(p)
        if (!prism) return
        const ed = edgesOfFace(prism, sel.face)[sel.edgeIdx]
        if (!ed?.vi) return
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -handleDrag.grabY)
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        const to = pt(Math.round(q.x / MM / 10) * 10, Math.round(q.z / MM / 10) * 10)
        setPartPolyWorld(p, movePolyVertex(prism.poly, k === 'qe0' ? ed.vi[0] : ed.vi[1], to))
        dragMoved = true
        exitPreview(); rebuildParts(); renderFields()
        updateSolidHLS(); updateGizmo()
        return
      }
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
      } else if (k === 'fx') {
        // 面の垂直押し出し: 選択面の辺だけ平行移動し、両端に頂点を挿入して面で埋める
        const sel = solidSelS
        if (p.kind !== 'poly' || !sel || sel.face.kind !== 'side') return
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -handleDrag.grabY)
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        const ground = pt(q.x / MM, q.z / MM)
        if (!handleDrag.fx) {
          const prism = prismOfPart(p)
          if (!prism) return
          handleDrag.fx = {
            poly: prism.poly.map(v => ({ ...v })),
            faceI: sel.face.i,
            n: sideNormal(prism.poly, sel.face.i),
            ground0: ground
          }
          return
        }
        const fx = handleDrag.fx
        const d = Math.round(((ground.x - fx.ground0.x) * fx.n.x + (ground.y - fx.ground0.y) * fx.n.y) / 10) * 10
        const res = extrudeSidePoly(fx.poly, fx.faceI, d)
        setPartPolyWorld(p, res.poly)
        solidSelS = { ...sel, face: { kind: 'side', i: res.newFaceI } }
        dragMoved = true
        exitPreview(); rebuildParts(); renderFields()
        updateSolidHLS(); updateGizmo()
        return
      } else if (k.startsWith('pv')) {
        // 多角形の頂点: 掴んで形を変える(bbox を再正規化)
        if (p.kind !== 'poly' || !p.pts) return
        const idx = parseInt(k.slice(2), 10)
        if (!p.pts[idx]) return
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -handleDrag.grabY)
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        const snapped = studioSnap(pt(q.x / MM, q.z / MM)).p
        const dx = snapped.x - p.x, dz = snapped.y - p.z
        const rad = (p.rot * Math.PI) / 180
        const cos = Math.cos(rad), sin = Math.sin(rad)
        const sxf = p.sx / (p.bx ?? p.sx), szf = p.sz / (p.bz ?? p.sz)
        p.pts[idx] = {
          x: Math.round((dx * cos + dz * sin) / (sxf || 1)),
          y: Math.round((-dx * sin + dz * cos) / (szf || 1))
        }
        renormPoly(p)
      } else if (k[0] === 'c' && k.length === 3) {
        // 四隅: 反対の角を固定して幅・奥行を変更
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -handleDrag.grabY)
        const q = new THREE.Vector3()
        if (!ray.ray.intersectPlane(plane, q)) return
        const lx = q.x / MM - p.x, lz = q.z / MM - p.z
        const rad = (p.rot * Math.PI) / 180
        const cos = Math.cos(rad), sin = Math.sin(rad)
        const local = { x: lx * cos + lz * sin, z: -lx * sin + lz * cos }
        const sx = k[1] === 'p' ? 1 : -1
        const sz = k[2] === 'p' ? 1 : -1
        const ax = (-sx * p.sx) / 2, az = (-sz * p.sz) / 2
        const w = Math.max(10, Math.round(Math.abs(local.x - ax) / 10) * 10)
        const d = Math.max(10, Math.round(Math.abs(local.z - az) / 10) * 10)
        const cLocal = { x: ax + (sx * w) / 2, z: az + (sz * d) / 2 }
        p.x += cLocal.x * cos - cLocal.z * sin
        p.z += cLocal.x * sin + cLocal.z * cos
        p.sx = w; p.sz = d
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
    // 立体(多角形パーツ)の面 / 辺ホバー
    if (!previewing && !penMode && !symMode) {
      ray.setFromCamera(ndc(e), camera)
      let hov: { idx: number; face: FaceRef } | null = null
      let eh: number | null = null
      const hits = ray.intersectObjects(partsGroup.children, false)
      if (hits.length) {
        const idx = hits[0].object.userData.idx as number
        const prism = prismOfPart(parts[idx])
        if (prism) {
          if (solidSelS?.mode === 'edges' && solidSelS.idx === idx) {
            const i = nearestSolidEdge(edgesOfFace(prism, solidSelS.face), camera, renderer.domElement, e.clientX, e.clientY)
            eh = i >= 0 ? i : null
          } else {
            const n = hits[0].face ? hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld) : null
            const f = faceFromHit(prism, hits[0].point, n)
            if (f) hov = { idx, face: f }
          }
        }
      } else if (solidSelS?.mode === 'edges') {
        const prism = prismOfPart(parts[solidSelS.idx])
        if (prism) {
          const i = nearestSolidEdge(edgesOfFace(prism, solidSelS.face), camera, renderer.domElement, e.clientX, e.clientY)
          eh = i >= 0 ? i : null
        }
      }
      const same = eh === solidEdgeHoverS &&
        ((hov === null) === (solidHoverS === null)) &&
        (!hov || !solidHoverS || (hov.idx === solidHoverS.idx && sameFace(hov.face, solidHoverS.face)))
      if (!same) {
        solidHoverS = hov
        solidEdgeHoverS = eh
        updateSolidHLS()
        render()
      }
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
    // 立体の面 / 辺サイクル(動かしていないときだけ進める)
    if (solidCycPend && !dragMoved) {
      const sc = solidCycPend
      const cur = solidSelS
      if (!cur || cur.idx !== sc.idx) {
        if (sc.face) solidSelS = { idx: sc.idx, mode: 'face', face: sc.face }
      } else if (cur.mode === 'face') {
        solidSelS = sc.face && sameFace(cur.face, sc.face)
          ? { idx: cur.idx, mode: 'edges', face: cur.face }
          : sc.face ? { idx: cur.idx, mode: 'face', face: sc.face } : cur
      } else if (cur.mode === 'edges') {
        if (sc.edgeIdx >= 0) solidSelS = { idx: cur.idx, mode: 'edge', face: cur.face, edgeIdx: sc.edgeIdx }
        else solidSelS = null // 全体選択
      } else {
        solidSelS = null
      }
      solidEdgeHoverS = null
      dbgN.cycle++
      rebuildParts() // 面・辺の選択中は全体の青色をやめる(色の切替を反映)
      updateSolidHLS()
      updateGizmo()
      render()
    }
    solidCycPend = null
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
      if (!hitPart && !hitGizmo && !cameraMoved && (selSet.size || solidSelS)) {
        selSet.clear()
        rotMode = false
        solidSelS = null; solidHoverS = null; solidEdgeHoverS = null
        updateSolidHLS()
        rebuildParts(); renderList(); renderFields()
      }
    }
    if (rotMode) emphasizeRing(null)
  }
  renderer.domElement.addEventListener('pointerup', endInteraction)
  renderer.domElement.addEventListener('dblclick', () => { if (penMode && penPts.length >= 2) closePen() })
  renderer.domElement.addEventListener('contextmenu', e => {
    e.preventDefault()
    if (symMode) { symStroke = []; sketchOv.hide(); render(); return } // 右クリックで線を終了
    if (penMode) setPenMode(false) // 右クリックで鉛筆をキャンセル
    if (placing) endPlacing() // 右クリックで配置をキャンセル
    if (dupState) { renderer.domElement.style.cursor = ''; endDup() } // 右クリックで複写をキャンセル
  })
  // キャンバス外で離した場合も確実に終了(紫つまみが付いてくる問題の防止)
  const winUp = (e: PointerEvent): void => {
    if (dragIds || handleDrag || ringDrag) endInteraction(e)
  }
  window.addEventListener('pointerup', winUp)

  // ---------- プレビュー・保存・終了 ----------
  const close = (): void => {
    window.removeEventListener('pointerup', winUp)
    window.removeEventListener('keydown', onSpaceKey)
    window.removeEventListener('keyup', onSpaceKey)
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
    if (symEdges.length) {
      // 保存時に部品中心からの相対座標へ(2D 図面で部品位置に追従させるため)
      const rel = (q: Pt): Pt => pt(Math.round(q.x - baked.x), Math.round(q.y - baked.z))
      ent.symbolSketch = { edges: symEdges.map(ed => ({ ...ed, a: rel(ed.a), b: rel(ed.b) })) }
    }
    onSave(ent, name)
    close()
  }

  refresh()
  resize()
}
