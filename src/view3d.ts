// 3D ビュー — 平面図から 3D モデルを自動生成する。
// このモジュールは 3D タブを開いたときに動的 import され、
// 描画もカメラ操作時のみ(常時レンダリングループなし=無駄な計算をしない)。
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { Store, Wall, Opening, Entity, SketchE, isWindow, MATERIALS, TexKind, FURN_DEFAULTS } from './model'
import {
  Pt, pt, sub, norm, dist, distToSeg, snapTo, angleDetentDeg,
  sketchFaces, faceNesting, faceInfo, faceKey, polyCentroid
} from './geometry'

const M = 1 / 1000 // mm → m

export type ViewPreset =
  | 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left' | 'side'
  | 'iso' | 'iso-sw' | 'iso-se' | 'iso-nw' | 'iso-ne'
/** 床スラブ厚(m)。スラブは各階の 0〜+FLOOR_T に置き、壁・柱はスラブを貫通して階の底まで届く */
const FLOOR_T = 0.1

/** 3D ドラッグの移動量(mm)を 2D モデルへ適用する */
function moveEntity(ent: Entity, dxmm: number, dzmm: number): void {
  const mv = (q: Pt): Pt => pt(q.x + dxmm, q.y + dzmm)
  if (ent.type === 'wall' || ent.type === 'dimension') {
    ent.a = mv(ent.a); ent.b = mv(ent.b)
    if (ent.type === 'dimension') { ent.anchorA = undefined; ent.anchorB = undefined }
  }
  else if (ent.type === 'room') ent.poly = ent.poly.map(mv)
  else if (ent.type === 'sketch') {
    ent.edges = ent.edges.map(ed => ({ ...ed, a: mv(ed.a), b: mv(ed.b) }))
    if (ent.faces) {
      const nf: typeof ent.faces = {}
      for (const [k, v] of Object.entries(ent.faces)) {
        const [x, y] = k.split(':').map(Number)
        nf[`${Math.round(x + dxmm)}:${Math.round(y + dzmm)}`] = v
      }
      ent.faces = nf
    }
  }
  else if ('pos' in ent) {
    ;(ent as { pos: Pt }).pos = mv((ent as { pos: Pt }).pos)
    if ('attach' in ent) (ent as { attach?: unknown }).attach = undefined // 移動したら取り付け解除
  }
}

const MAT = {
  wall: new THREE.MeshLambertMaterial({ color: 0xf5f5f4 }),
  structural: new THREE.MeshLambertMaterial({ color: 0xe7e5e4 }),
  floor: new THREE.MeshLambertMaterial({ color: 0xd6cfc4 }),
  glass: new THREE.MeshLambertMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.45 }),
  door: new THREE.MeshLambertMaterial({ color: 0xa16207 }),
  furniture: new THREE.MeshLambertMaterial({ color: 0xd4b896 }),
  equipment: new THREE.MeshLambertMaterial({ color: 0x9ca3af }),
  stair: new THREE.MeshLambertMaterial({ color: 0xd1d5db }),
  trunk: new THREE.MeshLambertMaterial({ color: 0x854d0e }),
  leaf: new THREE.MeshLambertMaterial({ color: 0x4d7c0f }),
  person: new THREE.MeshLambertMaterial({ color: 0x64748b }),
  ground: new THREE.MeshLambertMaterial({ color: 0xf4f4f5 }),
  column: new THREE.MeshLambertMaterial({ color: 0x6b7280 }), // 2D と同じく構造材の濃色(壁と見分けられるように)
  woodDark: new THREE.MeshLambertMaterial({ color: 0x8a5f3b }),
  fabric: new THREE.MeshLambertMaterial({ color: 0xb8bcc4 }),
  white: new THREE.MeshLambertMaterial({ color: 0xfafafa }),
  dark: new THREE.MeshLambertMaterial({ color: 0x374151 }),
  water: new THREE.MeshLambertMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.6 }),
  selected: new THREE.MeshLambertMaterial({ color: 0x93b4f8, emissive: 0x1d4ed8, emissiveIntensity: 0.18 })
}

// ---------------- マテリアル(仕上げ): Canvas でテクスチャを生成(外部画像なし) ----------------
const TEXGEN: Record<TexKind, (c: CanvasRenderingContext2D, s: number) => void> = {
  wood: (c, s) => {
    for (let x = 0; x < s; x += 10 + Math.random() * 14) {
      c.strokeStyle = `rgba(70, 40, 12, ${0.08 + Math.random() * 0.12})`
      c.lineWidth = 1 + Math.random() * 2
      c.beginPath(); c.moveTo(x, 0)
      c.bezierCurveTo(x + 5, s * 0.3, x - 5, s * 0.7, x + 3, s)
      c.stroke()
    }
  },
  brick: (c, s) => {
    const bh = s / 6, bw = s / 3
    c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 2.5
    for (let row = 0; row < 6; row++) {
      const y = row * bh
      c.beginPath(); c.moveTo(0, y); c.lineTo(s, y); c.stroke()
      const off = row % 2 ? bw / 2 : 0
      for (let x = off; x <= s; x += bw) {
        c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + bh); c.stroke()
      }
    }
  },
  tile: (c, s) => {
    const g = s / 4
    c.strokeStyle = 'rgba(90,100,110,0.5)'; c.lineWidth = 2
    for (let i = 0; i <= 4; i++) {
      c.beginPath(); c.moveTo(i * g, 0); c.lineTo(i * g, s); c.stroke()
      c.beginPath(); c.moveTo(0, i * g); c.lineTo(s, i * g); c.stroke()
    }
  },
  tatami: (c, s) => {
    c.strokeStyle = 'rgba(90,100,50,0.35)'
    c.lineWidth = 1
    for (let y = 0; y < s; y += 3) { c.beginPath(); c.moveTo(0, y); c.lineTo(s, y); c.stroke() }
    c.strokeStyle = 'rgba(60,70,30,0.7)'; c.lineWidth = 3
    c.strokeRect(1, 1, s - 2, s - 2)
    c.beginPath(); c.moveTo(s / 2, 0); c.lineTo(s / 2, s); c.stroke()
  },
  grass: (c, s) => {
    for (let i = 0; i < 500; i++) {
      c.fillStyle = `rgba(${40 + Math.random() * 50}, ${100 + Math.random() * 60}, 40, 0.25)`
      c.fillRect(Math.random() * s, Math.random() * s, 2, 3 + Math.random() * 3)
    }
  },
  stone: (c, s) => {
    for (let i = 0; i < 40; i++) {
      const g = 120 + Math.random() * 60
      c.fillStyle = `rgba(${g}, ${g}, ${g + 5}, 0.25)`
      c.beginPath()
      c.ellipse(Math.random() * s, Math.random() * s, 8 + Math.random() * 20, 6 + Math.random() * 14, Math.random() * 3, 0, Math.PI * 2)
      c.fill()
    }
  },
  concrete: (c, s) => {
    for (let i = 0; i < 900; i++) {
      const g = 150 + Math.random() * 80
      c.fillStyle = `rgba(${g}, ${g}, ${g}, 0.12)`
      c.fillRect(Math.random() * s, Math.random() * s, 2, 2)
    }
  }
}
const PREVIEW_MAT = new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.32, depthWrite: false })
/** BoxGeometry の UV をワールド寸法基準に変換(テクスチャが伸び縮みしないように)。
 *  tile = 1 タイルの実寸(m)。uOff で壁に沿った連続性を保つ */
function uvWorldScale(geo: THREE.BufferGeometry, w: number, h: number, d: number, uOff = 0): void {
  const tile = 0.9
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv) return
  for (let i = 0; i < uv.count; i++) {
    let su = 1, sv = 1
    if (i < 8) { su = d / tile; sv = h / tile }        // ±x 面
    else if (i < 16) { su = w / tile; sv = d / tile }  // ±y 面
    else { su = w / tile; sv = h / tile }              // ±z 面(壁の長面)
    uv.setXY(i, uv.getX(i) * su + uOff / tile, uv.getY(i) * sv)
  }
}

/** 既定寸法の近くでは既定値に吸い付く(一瞬止まるガイド) */
function detent(v: number, def?: number, range = 45): number {
  return def !== undefined && Math.abs(v - def) < range ? def : v
}
/** エンティティの「デフォルト寸法」(家具=プリセット、部品=作成時、壁高=2400) */
function defaultDims(e: Entity): { w?: number; d?: number; h?: number } {
  if (e.type === 'furniture') { const f = FURN_DEFAULTS[e.kind]; return { w: f.w, d: f.d, h: f.h } }
  if (e.type === 'custom') return { w: e.w0, d: e.d0, h: e.h0 }
  if (e.type === 'wall') return { h: 2400 }
  return {}
}

/** 白の縁取り付きつまみ(円錐・球など) */
function mkOutlined(parent: THREE.Group, kind: string, x: number, y: number, z: number,
  whiteGeo: THREE.BufferGeometry, mainGeo: THREE.BufferGeometry, color: number): void {
  const g = new THREE.Group()
  const white = new THREE.Mesh(whiteGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }))
  const main = new THREE.Mesh(mainGeo, new THREE.MeshBasicMaterial({ color, depthTest: false }))
  white.renderOrder = 998; main.renderOrder = 999
  g.add(white, main)
  g.position.set(x, y, z)
  g.userData.gizmo = kind
  parent.add(g)
}

const lineMatCache = new Map<string, THREE.LineBasicMaterial>()
/** スケッチの辺の色付きラインマテリアル(キャッシュ) */
function sketchLineMat(c?: string): THREE.LineBasicMaterial {
  const key = c ?? '#1f2937'
  let m = lineMatCache.get(key)
  if (!m) { m = new THREE.LineBasicMaterial({ color: key }); lineMatCache.set(key, m) }
  return m
}

const colorCache = new Map<string, THREE.Material>()
/** 単色指定のマテリアル(キャッシュ)。仕上げより優先 */
function colorMat(c?: string): THREE.Material | null {
  if (!c) return null
  let m = colorCache.get(c)
  if (!m) { m = new THREE.MeshLambertMaterial({ color: c }); colorCache.set(c, m) }
  return m
}
const matCache = new Map<string, THREE.Material>()
/** マテリアル id → three.js マテリアル(キャッシュ)。未指定・不明は null */
function finishMat(id?: string): THREE.Material | null {
  if (!id) return null
  const cached = matCache.get(id)
  if (cached) return cached
  const def = MATERIALS.find(m => m.id === id)
  if (!def) return null
  let map: THREE.Texture | undefined
  if (def.tex) {
    const S = 128
    const cv = document.createElement('canvas')
    cv.width = cv.height = S
    const c = cv.getContext('2d')!
    c.fillStyle = def.color
    c.fillRect(0, 0, S, S)
    TEXGEN[def.tex](c, S)
    map = new THREE.CanvasTexture(cv)
    map.wrapS = map.wrapT = THREE.RepeatWrapping
    map.repeat.set(1, 1) // タイル密度は UV 側でワールド寸法に合わせる
  }
  const mat = new THREE.MeshLambertMaterial({
    color: map ? 0xffffff : def.color,
    map,
    transparent: def.opacity !== undefined,
    opacity: def.opacity ?? 1
  })
  matCache.set(id, mat)
  return mat
}

export class View3D {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  private model = new THREE.Group()
  /** 現在構築中の階のグループ(rebuild 中に切り替わる) */
  private target: THREE.Group = this.model
  private levelIdx = 0

  // ---- 3D 直接編集(選択・移動・配置 → 2D に即時反映) ----
  private store: Store | null = null
  /** 現在の選択(2D 側と共有するため関数で参照) */
  getSelection: () => Set<string> = () => new Set()
  /** 3D 上でオブジェクトを選択したとき。mode: replace=通常 / drill=グループ展開なしで単体 / toggle=追加・除外 */
  onSelect: (id: string, levelIndex: number, mode?: 'replace' | 'drill' | 'toggle') => void = () => {}
  /** 3D 範囲選択(Shift+空ドラッグ)の結果 */
  onSelectSet: (ids: string[]) => void = () => {}
  /** ドラッグ後に壁面へ吸着させる(main 経由で 2D 側のロジックを使う) */
  magnetize: (id: string) => void = () => {}
  private marquee3d: { x0: number; y0: number; el: HTMLDivElement } | null = null
  /** 複数選択のメンバー再クリック: 動かさなければ単体に絞る */
  private drillPending: string | null = null
  private lastMoveIds: Set<string> = new Set()
  /** 移動確定時(2D 再描画などに使う) */
  onEdited: () => void = () => {}
  getSnap: () => number = () => 455
  /** 現在の 2D ツール(3D 上での配置に使う) */
  getTool: () => string = () => 'select'
  /** 3D 上でのクリック配置(wallId は壁を直接クリックした場合) */
  onPlace: (p: Pt, wallId: string | undefined, levelIndex: number) => void = () => {}
  onCancel: () => void = () => {}
  private raycaster = new THREE.Raycaster()
  private dragging: { id: string; level: number; planeY: number; last: THREE.Vector3 } | null = null
  /** 建具(窓・ドア)のドラッグ: 壁に沿って水平、窓は上下で取付高さも変更 */
  private openingDrag: { id: string; level: number } | null = null
  /** プッシュ/プル(上面を掴んで高さ変更)中 */
  private heightDrag: { id: string; baseY: number; point: THREE.Vector3 } | null = null
  /** ギズモ(サイズ・高さ・浮かせハンドル)のドラッグ中 */
  private gizmoDrag: {
    kind: string; id: string; grabY: number; startElev: number; startPtY: number
    startW?: number; startD?: number; startH?: number; startDist?: number
  } | null = null
  private gizmo = new THREE.Group()
  /** 回転モード(⟳ アイコンでトグル): XYZ の回転リングを表示 */
  rotateMode = false
  private rotDrag: { axis: 'x' | 'y' | 'z'; id: string; center: THREE.Vector3; startAngle: number; startDeg: number } | null = null
  private downAt = { x: 0, y: 0 }
  private levelYs: number[] = [0]
  private rebuildPending = false
  private ground!: THREE.Mesh
  private grid = new THREE.Group()
  private gridStepBuilt = 0
  /** 2D 側のグリッド幅 mm(グリッドの位置を平面図と一致させる) */
  getGrid: () => number = () => 910
  /** 階境界の点線・ワイヤーフレーム・断面(輪切り) */
  private floorLines = new THREE.Group()
  private wireframeOn = false
  private sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)
  private sectionOn = false
  private sectionFrac = 0.5
  /** 上階を隠す(内観の確認用) */
  showUpper = true
  /** 下階を隠す */
  showLower = true
  /** 計測モード */
  measureOn = false
  private measureA: THREE.Vector3 | null = null
  private measureGroup = new THREE.Group()
  onMeasure: (text: string) => void = () => {}
  private hint3d!: HTMLDivElement
  /** 配置プレビュー(ゴースト)用 */
  private preview = new THREE.Group()
  private previewBox: THREE.Mesh
  private previewPole: THREE.Mesh
  private previewLine: THREE.Line
  private axes = new THREE.Group()
  /** 描画のたびに呼ばれる(3D 上のアクションアイコン追従用) */
  onRendered: () => void = () => {}
  /** 配置プレビューのサイズ情報(main から供給) */
  getPreview: () => { kind: string; w: number; d: number; h: number; rot: number; sill?: number } | null = () => null
  /** 実形状プレビュー用のエンティティ生成(main から供給) */
  getPreviewEntity: (p: Pt) => Entity | null = () => null
  private previewCustom = new THREE.Group()
  private previewSig = ''
  /** ドラッグ中の寸法ライン(2D と同じ青い点線) */
  private dimGroup = new THREE.Group()
  private dimLines: THREE.Line[] = []
  getWallStart: () => Pt | null = () => null
  getRoomPts: () => Pt[] = () => []
  getDimPts: () => Pt[] = () => []

  /** 1 フレームに 1 回だけ再構築(プッシュ/プル中の軽量化) */
  private rebuildSoon(): void {
    if (this.rebuildPending || !this.store) return
    this.rebuildPending = true
    requestAnimationFrame(() => {
      this.rebuildPending = false
      if (this.store) this.rebuild(this.store)
    })
  }

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    // 高 DPI ディスプレイでの過剰なピクセル描画を抑える(軽量化)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500)
    this.camera.position.set(12, 10, 12)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('change', () => this.render())

    this.scene.background = new THREE.Color(0xffffff)
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd4d4d8, 1.1)
    const dir = new THREE.DirectionalLight(0xffffff, 1.2)
    dir.position.set(8, 14, 6)
    this.scene.add(hemi, dir, this.model)

    this.ground = new THREE.Mesh(new THREE.CircleGeometry(60, 48).rotateX(-Math.PI / 2), MAT.ground)
    this.ground.position.y = -0.06
    this.scene.add(this.ground)
    this.buildGrid(910)
    this.scene.add(this.grid, this.floorLines)
    this.scene.add(this.gizmo, this.measureGroup, this.preview)
    // XYZ 軸: 太い円柱で表現し、実質無限長(±250m)に見せる
    {
      const L = 500, R = 0.025
      const axisDefs: [number, [number, number, number]][] = [
        [0xdc2626, [0, 0, -Math.PI / 2]], // X 赤
        [0x16a34a, [0, 0, 0]],            // Y 緑
        [0x2563eb, [Math.PI / 2, 0, 0]]   // Z 青
      ]
      for (const [color, rot] of axisDefs) {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(R, R, L, 8),
          new THREE.MeshBasicMaterial({ color }))
        m.rotation.set(rot[0], rot[1], rot[2])
        this.axes.add(m)
      }
    }
    this.axes.visible = false
    this.scene.add(this.axes)
    const pm = new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.32, depthWrite: false })
    this.previewBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), pm)
    this.previewPole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 8), new THREE.MeshBasicMaterial({ color: 0x2563eb }))
    this.previewLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x2563eb }))
    this.preview.add(this.previewBox, this.previewPole, this.previewLine, this.previewCustom)
    this.preview.visible = false
    // 点線の寸法ライン ×3(壁の左右 + 床からの高さ)
    for (let i = 0; i < 3; i++) {
      const ln = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineDashedMaterial({ color: 0x2563eb, dashSize: 0.12, gapSize: 0.08, depthTest: false }))
      ln.renderOrder = 998
      this.dimLines.push(ln)
      this.dimGroup.add(ln)
    }
    this.dimGroup.visible = false
    this.scene.add(this.dimGroup)

    // ドラッグ中の寸法・計測結果の表示用フローティングラベル
    this.hint3d = document.createElement('div')
    this.hint3d.style.cssText =
      'position:absolute;z-index:30;background:rgba(255,255,255,.95);border:1px solid #e5e5e5;' +
      'border-radius:6px;padding:3px 8px;font-size:11px;color:#1a1a1a;pointer-events:none;display:none;' +
      'font-variant-numeric:tabular-nums;box-shadow:0 2px 8px rgba(0,0,0,.1)'
    container.appendChild(this.hint3d)

    // 3D 直接編集: クリックで選択、選択物のドラッグで移動(カメラ操作と共存)
    // capture=true で OrbitControls より先に受け取り、オブジェクトを掴んだときは
    // stopPropagation してカメラが一緒に回らないようにする
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', e => this.pointerDown(e), true)
    el.addEventListener('pointermove', e => this.pointerMove(e))
    el.addEventListener('pointerup', e => this.pointerUp(e))
    // キャンバス外で離した場合もドラッグを確実に終了(つまみが付いてくる問題の防止)
    window.addEventListener('pointerup', e => {
      if (this.dragging || this.heightDrag || this.gizmoDrag || this.openingDrag || this.rotDrag) this.pointerUp(e)
    })
    el.addEventListener('contextmenu', e => { e.preventDefault(); this.onCancel(); this.hidePreview() })
    el.addEventListener('pointerleave', () => this.hidePreview())

    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
  }

  /**
   * 平面図と同じ位置のグリッド(原点基準・gridStep の倍数)。
   * 主線 = 実線 / 1 グリッドを 4 等分する補助線 = 点線
   */
  private buildGrid(stepMm: number): void {
    this.grid.traverse(o => {
      if (o instanceof THREE.LineSegments) { o.geometry.dispose(); (o.material as THREE.Material).dispose() }
    })
    this.grid.clear()
    this.gridStepBuilt = stepMm
    const step = stepMm * M
    const half = 30 // ±30m
    const n = Math.floor(half / step)
    const main: number[] = []
    const quart: number[] = []
    for (let i = -n; i <= n; i++) {
      const c = i * step
      main.push(-half, 0, c, half, 0, c, c, 0, -half, c, 0, half)
      for (let q = 1; q < 4; q++) {
        const cq = c + (q * step) / 4
        if (cq > half) continue
        quart.push(-half, 0, cq, half, 0, cq, cq, 0, -half, cq, 0, half)
      }
    }
    const mk = (arr: number[], mat: THREE.Material): THREE.LineSegments => {
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3))
      return new THREE.LineSegments(g, mat)
    }
    const quartL = mk(quart, new THREE.LineDashedMaterial({ color: 0xededf0, dashSize: 0.10, gapSize: 0.09 }))
    quartL.computeLineDistances()
    this.grid.add(quartL, mk(main, new THREE.LineBasicMaterial({ color: 0xdfdfe3 })))
  }

  /** ワイヤーフレーム表示の切替 */
  setWireframe(v: boolean): void {
    this.wireframeOn = v
    this.applyWireframe()
    this.render()
  }
  private applyWireframe(): void {
    const seen = new Set<THREE.Material>()
    this.model.traverse(o => {
      if (!(o instanceof THREE.Mesh)) return
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (seen.has(m)) continue
        seen.add(m)
        if ('wireframe' in m) (m as THREE.MeshLambertMaterial).wireframe = this.wireframeOn
      }
    })
  }

  /** 断面(輪切り)表示: frac = 建物高さに対する切断位置 0..1 */
  setSection(on: boolean, frac?: number): void {
    this.sectionOn = on
    if (frac !== undefined) this.sectionFrac = frac
    if (!on) {
      this.renderer.clippingPlanes = []
    } else {
      const bb = new THREE.Box3().setFromObject(this.model)
      const top = bb.isEmpty() ? 3 : bb.max.y
      this.sectionPlane.constant = Math.max(0.05, top * this.sectionFrac)
      this.renderer.clippingPlanes = [this.sectionPlane]
    }
    this.render()
  }

  // ---------------- 3D 直接編集 ----------------
  private ray(e: PointerEvent): THREE.Raycaster {
    const r = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    )
    this.raycaster.setFromCamera(ndc, this.camera)
    return this.raycaster
  }
  /** activeOnly: 編集中の階のオブジェクトだけを対象にする(選択時) */
  private pick(e: PointerEvent, activeOnly = false): { id: string; level: number; point: THREE.Vector3; topFace: boolean } | null {
    const hits = this.ray(e).intersectObjects(this.model.children, true)
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object
      while (o && !o.userData.entId) o = o.parent
      if (o) {
        if (activeOnly && o.userData.level !== (this.store?.active ?? 0)) continue
        const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null
        return {
          id: o.userData.entId as string,
          level: o.userData.level as number,
          point: h.point,
          topFace: (n?.y ?? 0) > 0.7
        }
      }
    }
    return null
  }
  private showHint(text: string, clientX: number, clientY: number): void {
    const r = this.container.getBoundingClientRect()
    this.hint3d.textContent = text
    this.hint3d.style.display = 'block'
    this.hint3d.style.left = `${clientX - r.left + 14}px`
    this.hint3d.style.top = `${clientY - r.top - 26}px`
  }
  hideHint(): void { this.hint3d.style.display = 'none' }

  /** ワールド座標の少し上にヒントを表示(オブジェクトと重ならないように) */
  showHintWorld(text: string, world: THREE.Vector3): void {
    const pr = world.clone().project(this.camera)
    if (pr.z > 1) { this.hideHint(); return }
    const r = this.renderer.domElement.getBoundingClientRect()
    const x = ((pr.x + 1) / 2) * r.width
    const y = ((1 - pr.y) / 2) * r.height
    this.hint3d.textContent = text
    this.hint3d.style.display = 'block'
    // 一旦表示してから幅を測って中央寄せ
    this.hint3d.style.left = `${Math.max(4, x - this.hint3d.offsetWidth / 2)}px`
    this.hint3d.style.top = `${Math.max(4, y - 34)}px`
  }

  /**
   * 選択オブジェクトのギズモ(サイズ・高さ・浮かせのハンドル)。
   * 家具・柱に表示: 赤=幅 / 緑=奥行 / 青(円錐)=高さ / 紫(球)=浮かせ
   */
  private updateGizmo(): void {
    this.gizmo.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    this.gizmo.clear()
    this.gizmo.position.set(0, 0, 0)
    if (!this.store) return
    const sel = [...this.getSelection()]
    if (sel.length !== 1) return
    const e = this.store.byId(sel[0])
    if (!e) return
    const yBase = this.levelYs[this.store.active] ?? 0
    // 回転モード: XYZ 回転リング(rot を持つ要素のみ。X/Z の傾きは家具・部品のみ)
    if (this.rotateMode) {
      if (!('rot' in e) || !('pos' in e)) return
      const ep = (e as { pos: Pt }).pos
      const hgt = 'h' in e ? (e as { h: number }).h : 'height' in e ? (e as { height: number }).height : 1000
      const elevM = ('elev' in e ? ((e as { elev?: number }).elev ?? 0) : 0) * M
      const cy = yBase + elevM + (hgt * M) / 2
      const rad = Math.max(0.5, Math.hypot(
        ('w' in e ? (e as { w: number }).w : 800) * M,
        ('d' in e ? (e as { d: number }).d : 800) * M) / 2 + 0.18)
      const ring = (axis: 'x' | 'y' | 'z', color: number): void => {
        const t = new THREE.Mesh(
          new THREE.TorusGeometry(rad, 0.028, 8, 56),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false }))
        t.renderOrder = 999
        if (axis === 'y') t.rotation.x = Math.PI / 2
        else if (axis === 'x') t.rotation.y = Math.PI / 2
        t.position.set(ep.x * M, cy, ep.y * M)
        t.userData.gizmo = `r${axis}`
        this.gizmo.add(t)
      }
      ring('y', 0x16a34a)
      if (e.type === 'furniture' || e.type === 'custom') { ring('x', 0xdc2626); ring('z', 0x2563eb) }
      return
    }
    const mkH = (geo: THREE.BufferGeometry, color: number, kind: string, x: number, y: number, z: number): void => {
      // 白縁取り: 一回り大きい白ジオメトリを重ねる
      const g = new THREE.Group()
      const white = new THREE.Mesh(geo.clone().scale(1.35, 1.35, 1.35),
        new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }))
      const main = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false }))
      white.renderOrder = 998; main.renderOrder = 999
      g.add(white, main)
      g.position.set(x, y, z)
      g.userData.gizmo = kind
      this.gizmo.add(g)
    }
    if (e.type === 'wall') {
      // 壁: 両端=長さ(青四角) / 側面中央=厚み(オレンジ) / 天面中央=高さ(青円錐)
      const mid = pt((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2)
      const d = norm(sub(e.b, e.a)), n = { x: -d.y, z: d.x }
      const my = yBase + e.height * M / 2
      mkH(new THREE.BoxGeometry(0.13, 0.13, 0.13), 0x2563eb, 'wa',
        e.a.x * M - d.x * 0.15, my, e.a.y * M - d.y * 0.15)
      mkH(new THREE.BoxGeometry(0.13, 0.13, 0.13), 0x2563eb, 'wb',
        e.b.x * M + d.x * 0.15, my, e.b.y * M + d.y * 0.15)
      mkH(new THREE.BoxGeometry(0.12, 0.12, 0.12), 0xea580c, 't',
        mid.x * M + n.x * (e.thickness * M / 2 + 0.15), my, mid.y * M + n.z * (e.thickness * M / 2 + 0.15))
      mkH(new THREE.ConeGeometry(0.09, 0.2, 12), 0x2563eb, 'h', mid.x * M, yBase + e.height * M + 0.15, mid.y * M)
      return
    }
    if (e.type === 'sketch') {
      // 各面の中心に高さ(押し出し)の円錐つまみ。ドラッグで立体化・高さ変更
      const faces = sketchFaces(e)
      faces.forEach((f, i) => {
        const info = faceInfo(e, f)
        if (info.dead) return
        const c = polyCentroid(f)
        mkOutlined(this.gizmo, `sf${i}`, c.x * M, yBase + (info.h ?? 0) * M + 0.14, c.y * M,
          new THREE.ConeGeometry(0.10, 0.21, 12), new THREE.ConeGeometry(0.072, 0.16, 12), 0x2563eb)
      })
      return
    }
    if (e.type !== 'furniture' && e.type !== 'column' && e.type !== 'custom') return
    const elev = (e.type !== 'column' ? (e.elev ?? 0) : 0) * M
    const cx = e.pos.x * M, cz = e.pos.y * M
    const midY = yBase + elev + (e.h * M) / 2
    const topY = yBase + elev + e.h * M
    // 2D と同じ見た目のつまみ: 濃い青の四角 + 白い縁
    const mkSquare = (kind: string, x: number, y: number, z: number): void => {
      const g = new THREE.Group()
      const white = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.10),
        new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }))
      const blue = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.072, 0.072),
        new THREE.MeshBasicMaterial({ color: 0x2563eb, depthTest: false }))
      white.renderOrder = 998; blue.renderOrder = 999
      g.add(white, blue)
      g.position.set(x, y, z)
      g.rotation.y = -e.rot
      g.userData.gizmo = kind
      this.gizmo.add(g)
    }
    const off = 0.16
    const dirW = { x: Math.cos(e.rot), z: Math.sin(e.rot) }       // ローカル +x
    const dirD = { x: -Math.sin(e.rot), z: Math.cos(e.rot) }      // ローカル +y(平面図の下)
    const hw = e.w * M / 2 + off, hd = e.d * M / 2 + off
    // 四辺の中点: その方向へ伸縮(反対の辺は固定)
    mkSquare('ex+', cx + dirW.x * hw, midY, cz + dirW.z * hw)
    mkSquare('ex-', cx - dirW.x * hw, midY, cz - dirW.z * hw)
    mkSquare('ez+', cx + dirD.x * hd, midY, cz + dirD.z * hd)
    mkSquare('ez-', cx - dirD.x * hd, midY, cz - dirD.z * hd)
    // 四隅: 全体スケール
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        mkSquare('corner',
          cx + dirW.x * hw * sx + dirD.x * hd * sz, midY,
          cz + dirW.z * hw * sx + dirD.z * hd * sz)
      }
    }
    // 高さ(青の円錐)と浮かせ(紫の球)は上に。どちらも白の縁取り付き
    mkOutlined(this.gizmo, 'h', cx, topY + off, cz,
      new THREE.ConeGeometry(0.10, 0.21, 12), new THREE.ConeGeometry(0.072, 0.16, 12), 0x2563eb)
    if (e.type === 'furniture' || e.type === 'custom') {
      mkOutlined(this.gizmo, 'elev', cx, topY + off * 2.8, cz,
        new THREE.SphereGeometry(0.068, 12, 10), new THREE.SphereGeometry(0.05, 12, 10), 0x9333ea)
    }
  }

  /** 選択状態のハイライトを再構築なしで反映(軽量) */
  highlightSelection(): void {
    const sel = this.getSelection()
    for (const g of this.model.children) {
      for (const child of g.children) {
        const id = child.userData.entId as string | undefined
        if (!id) continue
        const on = sel.has(id)
        child.traverse(o => {
          if (o instanceof THREE.Mesh) {
            if (!o.userData.baseMat) o.userData.baseMat = o.material
            o.material = on ? MAT.selected : o.userData.baseMat
          }
        })
      }
    }
    this.updateGizmo()
    this.render()
  }

  // ---------------- 視点プリセット・表示切替・書き出し(3D CAD 補助機能) ----------------
  setView(preset: ViewPreset): void {
    const bb = new THREE.Box3().setFromObject(this.model)
    const c = bb.isEmpty() ? new THREE.Vector3(0, 1, 0) : bb.getCenter(new THREE.Vector3())
    const size = bb.isEmpty() ? 10 : bb.getSize(new THREE.Vector3()).length()
    const d = Math.max(6, size * 1.1)
    const i7 = d * 0.7, i6 = d * 0.6, e15 = d * 0.15
    // 平面図の上 = 北(-z)。南 = +z / 東 = +x / 西 = -x
    const pos: Record<ViewPreset, number[]> = {
      top: [c.x, c.y + d, c.z + 0.01],
      bottom: [c.x, c.y - d, c.z + 0.01],
      front: [c.x, c.y + e15, c.z + d],
      back: [c.x, c.y + e15, c.z - d],
      right: [c.x + d, c.y + e15, c.z],
      left: [c.x - d, c.y + e15, c.z],
      side: [c.x + d, c.y + e15, c.z],
      iso: [c.x + i7, c.y + i6, c.z + i7],
      'iso-sw': [c.x - i7, c.y + i6, c.z + i7],
      'iso-se': [c.x + i7, c.y + i6, c.z + i7],
      'iso-nw': [c.x - i7, c.y + i6, c.z - i7],
      'iso-ne': [c.x + i7, c.y + i6, c.z - i7]
    }
    const p = pos[preset]
    this.camera.position.set(p[0], p[1], p[2])
    this.controls.target.copy(c)
    this.controls.update()
    this.render()
  }

  /** 上階・下階の表示/非表示。再構築なしで階グループの visible を切り替え */
  applyFloorVisibility(): void {
    if (!this.store) return
    const a = this.store.active
    this.model.children.forEach((g, i) => {
      g.visible = i === a || (i < a ? this.showLower : this.showUpper)
    })
    this.render()
  }

  /** 現在のビューを PNG で書き出し */
  exportPNG(): Promise<Blob | null> {
    this.render()
    return new Promise(res => this.renderer.domElement.toBlob(b => res(b), 'image/png'))
  }

  clearMeasure(): void {
    this.measureGroup.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Line) o.geometry.dispose() })
    this.measureGroup.clear()
    this.measureA = null
    this.hideHint()
    this.render()
  }

  private groundPoint(e: PointerEvent): Pt | null {
    const y = this.levelYs[this.store?.active ?? 0] ?? 0
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y)
    const p = new THREE.Vector3()
    if (!this.ray(e).ray.intersectPlane(plane, p)) return null
    return pt(p.x * 1000, p.z * 1000)
  }

  private pointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !this.store) return
    this.downAt = { x: e.clientX, y: e.clientY }
    if (this.measureOn) { e.stopPropagation(); return } // 計測クリックは up で処理
    // ギズモのハンドルを最優先で判定(つまみはグループなので再帰 + 親を辿る)
    const gHits = this.ray(e).intersectObjects(this.gizmo.children, true)
    if (gHits.length) {
      let go: THREE.Object3D | null = gHits[0].object
      while (go && !go.userData.gizmo) go = go.parent
      const kind = go?.userData.gizmo as string | undefined
      const sel = [...this.getSelection()]
      const ent = sel.length === 1 ? this.store.byId(sel[0]) : undefined
      // 回転リング
      if (kind?.startsWith('r') && ent && 'rot' in ent && 'pos' in ent) {
        e.stopPropagation()
        try { this.renderer.domElement.setPointerCapture(e.pointerId) } catch { /* noop */ }
        this.controls.enabled = false
        this.renderer.domElement.style.cursor = 'grabbing'
        this.store.commit()
        const axis = kind[1] as 'x' | 'y' | 'z'
        const center = (this.gizmo.children[0] as THREE.Mesh).position.clone()
        const startDeg = axis === 'y'
          ? ((ent as { rot: number }).rot * 180) / Math.PI
          : axis === 'x' ? ((ent as { tiltX?: number }).tiltX ?? 0) : ((ent as { tiltZ?: number }).tiltZ ?? 0)
        this.rotDrag = {
          axis, id: ent.id, center,
          startAngle: this.ringAngle(e, axis, center),
          startDeg
        }
        return
      }
      if (kind && ent && (ent.type === 'furniture' || ent.type === 'column' || ent.type === 'wall' || ent.type === 'custom' || ent.type === 'sketch')) {
        e.stopPropagation()
        try { this.renderer.domElement.setPointerCapture(e.pointerId) } catch { /* noop */ }
        this.controls.enabled = false
        this.renderer.domElement.style.cursor = 'grabbing'
        this.store.commit()
        const hasWD = ent.type === 'furniture' || ent.type === 'column' || ent.type === 'custom'
        const startDist = hasWD
          ? Math.hypot(gHits[0].point.x - ent.pos.x * M, gHits[0].point.z - ent.pos.y * M)
          : 1
        this.gizmoDrag = {
          kind, id: ent.id,
          grabY: gHits[0].point.y,
          startElev: ent.type === 'furniture' ? (ent.elev ?? 0) : 0,
          startPtY: gHits[0].point.y,
          startW: hasWD ? ent.w : 0,
          startD: hasWD ? ent.d : 0,
          startH: hasWD ? ent.h : 0,
          startDist: Math.max(0.05, startDist)
        }
        return
      }
    }
    if (this.getTool() !== 'select') return // 配置ツール中はクリック(up)で配置。ドラッグはカメラ操作のまま
    // 選択は編集中の階のオブジェクトのみ(1F 編集中は 1F だけ選べる)
    const hit = this.pick(e, true)
    if (!hit) {
      // Shift+空ドラッグ → 範囲選択(緑の点線)
      if (e.shiftKey) {
        e.stopPropagation()
        this.controls.enabled = false
        const el = document.createElement('div')
        el.style.cssText =
          'position:absolute;z-index:40;border:1.5px dashed #16a34a;background:rgba(22,163,74,.06);pointer-events:none'
        this.container.appendChild(el)
        this.marquee3d = { x0: e.clientX, y0: e.clientY, el }
      }
      return
    }
    // オブジェクトを掴んだ: カメラを回さない(capture で controls より先に止める)
    e.stopPropagation()
    try { this.renderer.domElement.setPointerCapture(e.pointerId) } catch { /* 合成イベント等 */ }
    this.controls.enabled = false
    const selNow = this.getSelection()
    const already = selNow.has(hit.id)
    // Shift+クリック: 選択に追加 / 除外(複数選択)。ドラッグはしない
    if (e.shiftKey) {
      this.onSelect(hit.id, hit.level, 'toggle')
      this.highlightSelection()
      return
    }
    if (already && selNow.size > 1) {
      // 複数選択のメンバーを再クリック: ドラッグ=全体を一括移動 / クリック(動かさない)=その要素に絞る
      this.drillPending = hit.id
    } else if (!already) {
      this.onSelect(hit.id, hit.level, 'replace')
    }
    this.highlightSelection()
    const movable = this.store.byId(hit.id)
    if (!movable) return
    if (movable.type === 'opening') {
      // 建具は壁に沿って移動(窓は上下で取付高さも変更)
      this.store.commit()
      this.openingDrag = { id: hit.id, level: hit.level }
      return
    }
    this.store.commit()
    // 掴んで動かす = 常に平面移動(高さ変更は青い円錐つまみからのみ)
    this.dragging = { id: hit.id, level: hit.level, planeY: hit.point.y, last: hit.point.clone() }
  }
  /** 回転リング: 軸の平面上でのポインタ角度 */
  private ringAngle(e: PointerEvent, axis: 'x' | 'y' | 'z', center: THREE.Vector3): number {
    const n = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, center)
    const p = new THREE.Vector3()
    if (!this.ray(e).ray.intersectPlane(plane, p)) return 0
    const v = p.sub(center)
    if (axis === 'y') return Math.atan2(v.z, v.x)
    if (axis === 'x') return Math.atan2(v.y, v.z)
    return Math.atan2(v.y, v.x)
  }

  private pointerMove(e: PointerEvent): void {
    if (this.rotDrag && this.store) {
      const ent = this.store.byId(this.rotDrag.id)
      if (!ent) return
      const now = this.ringAngle(e, this.rotDrag.axis, this.rotDrag.center)
      let deltaDeg = ((now - this.rotDrag.startAngle) * 180) / Math.PI
      if (this.rotDrag.axis === 'y') deltaDeg = -deltaDeg // 平面図の回転向きに合わせる
      const deg = angleDetentDeg(this.rotDrag.startDeg + deltaDeg) // 45°ごとに一瞬止まる
      if (this.rotDrag.axis === 'y') (ent as { rot: number }).rot = (deg * Math.PI) / 180
      else if (this.rotDrag.axis === 'x') (ent as { tiltX?: number }).tiltX = deg
      else (ent as { tiltZ?: number }).tiltZ = deg
      this.showHint(`${Math.round(((deg % 360) + 360) % 360)}°`, e.clientX, e.clientY)
      this.rebuildSoon()
      return
    }
    if (this.marquee3d) {
      const r = this.container.getBoundingClientRect()
      const m = this.marquee3d
      const x = Math.min(m.x0, e.clientX) - r.left, y = Math.min(m.y0, e.clientY) - r.top
      m.el.style.left = `${x}px`
      m.el.style.top = `${y}px`
      m.el.style.width = `${Math.abs(e.clientX - m.x0)}px`
      m.el.style.height = `${Math.abs(e.clientY - m.y0)}px`
      return
    }
    if (this.openingDrag && this.store) {
      const o = this.store.byId(this.openingDrag.id)
      if (o?.type !== 'opening') return
      const wall = this.store.byId(o.wallId)
      if (wall?.type !== 'wall') return
      // 壁の中心線を含む鉛直面とレイの交点 → 壁沿い位置 t と高さを同時に決める
      const d = norm(sub(wall.b, wall.a))
      const n3 = new THREE.Vector3(-d.y, 0, d.x)
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        n3, new THREE.Vector3(wall.a.x * M, 0, wall.a.y * M))
      const p = new THREE.Vector3()
      if (!this.ray(e).ray.intersectPlane(plane, p)) return
      const L = Math.max(1, dist(wall.a, wall.b))
      const along = ((p.x - wall.a.x * M) * d.x + (p.z - wall.a.y * M) * d.y) / M
      const half = Math.min(0.5, o.width / (2 * L))
      o.t = Math.min(Math.max(along / L, half), 1 - half)     // 壁の内側にクランプ
      if (isWindow(o.kind)) {
        // 窓は上下ドラッグで取付高さ(窓台高)を変更。壁の中に収まる範囲へクランプ
        const yBase = this.levelYs[this.openingDrag.level] ?? 0
        const winH = o.head - o.sill
        let sill = snapTo((p.y - yBase) * 1000 - winH / 2, 50)
        sill = Math.min(Math.max(0, sill), Math.max(0, wall.height - winH))
        o.sill = sill
        o.head = sill + winH
      }
      const left = Math.round(o.t * L - o.width / 2)
      const right = Math.round(L - o.t * L - o.width / 2)
      const sillTxt = isWindow(o.kind) ? ` ・ 床から ${o.sill}` : ''
      const yTop = (this.levelYs[this.openingDrag.level] ?? 0) + wall.height * M + 0.25
      this.showHintWorld(`左端 ${left} ・ 右端 ${right}${sillTxt}`,
        new THREE.Vector3((wall.a.x + d.x * o.t * L) * M, yTop, (wall.a.y + d.y * o.t * L) * M))
      // 2D と同じ青い点線で寸法ラインを表示
      {
        const yB = this.levelYs[this.openingDrag.level] ?? 0
        const midY = yB + ((o.sill + o.head) / 2) * M
        const A = new THREE.Vector3(wall.a.x * M, midY, wall.a.y * M)
        const B = new THREE.Vector3(wall.b.x * M, midY, wall.b.y * M)
        const lEdge = new THREE.Vector3(
          (wall.a.x + d.x * (o.t * L - o.width / 2)) * M, midY, (wall.a.y + d.y * (o.t * L - o.width / 2)) * M)
        const rEdge = new THREE.Vector3(
          (wall.a.x + d.x * (o.t * L + o.width / 2)) * M, midY, (wall.a.y + d.y * (o.t * L + o.width / 2)) * M)
        const cX = (wall.a.x + d.x * o.t * L) * M, cZ = (wall.a.y + d.y * o.t * L) * M
        this.dimLines[0].geometry.setFromPoints([A, lEdge]); this.dimLines[0].computeLineDistances()
        this.dimLines[1].geometry.setFromPoints([rEdge, B]); this.dimLines[1].computeLineDistances()
        this.dimLines[2].visible = isWindow(o.kind)
        if (isWindow(o.kind)) {
          this.dimLines[2].geometry.setFromPoints([
            new THREE.Vector3(cX, yB, cZ), new THREE.Vector3(cX, yB + o.sill * M, cZ)])
          this.dimLines[2].computeLineDistances()
        }
        this.dimGroup.visible = true
      }
      this.rebuildSoon()
      return
    }
    if (this.gizmoDrag && this.store) {
      const ent = this.store.byId(this.gizmoDrag.id)
      if (!ent) return
      if (ent.type === 'sketch' && this.gizmoDrag.kind.startsWith('sf')) {
        // 面の円錐つまみ: 上下ドラッグで押し出し高さ(0 = 平面に戻る)
        const idx = parseInt(this.gizmoDrag.kind.slice(2), 10)
        const f = sketchFaces(ent)[idx]
        if (!f) return
        const c = polyCentroid(f)
        const dir = this.camera.getWorldDirection(new THREE.Vector3())
        const n = new THREE.Vector3(dir.x, 0, dir.z).normalize()
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          n, new THREE.Vector3(c.x * M, this.gizmoDrag.grabY, c.y * M))
        const p = new THREE.Vector3()
        if (!this.ray(e).ray.intersectPlane(plane, p)) return
        const yBase = this.levelYs[this.store.active] ?? 0
        const h = Math.max(0, snapTo((p.y - yBase) * 1000, 50))
        ent.faces ??= {}
        const info = faceInfo(ent, f)
        ent.faces[faceKey(f)] = { ...info, h: h > 0 ? h : undefined, dead: false }
        this.showHint(`高さ ${h}`, e.clientX, e.clientY)
        this.rebuildSoon()
        return
      }
      if (ent.type === 'wall') {
        const k = this.gizmoDrag.kind
        if (k === 'wa' || k === 'wb') {
          // 端点を壁の軸に沿ってスライド(長さ変更)
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.gizmoDrag.grabY)
          const p = new THREE.Vector3()
          if (!this.ray(e).ray.intersectPlane(plane, p)) return
          const other = k === 'wa' ? ent.b : ent.a
          const dirV = norm(sub(k === 'wa' ? ent.a : ent.b, other))
          const along = (p.x / M - other.x) * dirV.x + (p.z / M - other.y) * dirV.y
          const len = Math.max(100, snapTo(along, this.getSnap()))
          const np = pt(other.x + dirV.x * len, other.y + dirV.y * len)
          if (k === 'wa') ent.a = np; else ent.b = np
          this.showHint(`長さ ${Math.round(len)}`, e.clientX, e.clientY)
          this.rebuildSoon()
          return
        }
        if (k === 't') {
          // 水平面との交点から中心線までの距離 ×2 = 厚み
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.gizmoDrag.grabY)
          const p = new THREE.Vector3()
          if (!this.ray(e).ray.intersectPlane(plane, p)) return
          const distMm = distToSeg(pt(p.x / M, p.z / M), ent.a, ent.b)
          ent.thickness = Math.max(30, Math.round(distMm * 2 / 5) * 5)
          this.showHint(`厚さ ${ent.thickness}`, e.clientX, e.clientY)
        } else if (k === 'h') {
          const dir = this.camera.getWorldDirection(new THREE.Vector3())
          const n = new THREE.Vector3(dir.x, 0, dir.z).normalize()
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
            n, new THREE.Vector3((ent.a.x + ent.b.x) / 2 * M, this.gizmoDrag.grabY, (ent.a.y + ent.b.y) / 2 * M))
          const p = new THREE.Vector3()
          if (!this.ray(e).ray.intersectPlane(plane, p)) return
          const yBase = this.levelYs[this.store.active] ?? 0
          ent.height = Math.max(300, detent(snapTo((p.y - yBase) * 1000, 50), 2400))
          this.showHint(`高さ ${ent.height}`, e.clientX, e.clientY)
        }
        this.rebuildSoon()
        return
      }
      if (ent.type !== 'furniture' && ent.type !== 'column' && ent.type !== 'custom') return
      const snap = 50 // サイズ変更は 50mm 刻み
      const k = this.gizmoDrag.kind
      if (k.startsWith('ex') || k.startsWith('ez') || k === 'corner') {
        // 水平面との交点をローカル座標へ
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.gizmoDrag.grabY)
        const p = new THREE.Vector3()
        if (!this.ray(e).ray.intersectPlane(plane, p)) return
        const lx = (p.x - ent.pos.x * M) * 1000, lz = (p.z - ent.pos.y * M) * 1000
        const cos = Math.cos(ent.rot), sin = Math.sin(ent.rot)
        const local = { x: lx * cos + lz * sin, y: -lx * sin + lz * cos }
        if (k === 'corner') {
          // 四隅: 全体スケール(中心固定で W/D/H を等倍)。既定寸法で一瞬止まる
          const dd = defaultDims(ent)
          const f = Math.hypot(p.x - ent.pos.x * M, p.z - ent.pos.y * M) / (this.gizmoDrag.startDist ?? 1)
          ent.w = Math.max(50, detent(snapTo((this.gizmoDrag.startW ?? ent.w) * f, snap), dd.w))
          ent.d = Math.max(50, detent(snapTo((this.gizmoDrag.startD ?? ent.d) * f, snap), dd.d))
          ent.h = Math.max(50, detent(snapTo((this.gizmoDrag.startH ?? ent.h) * f, snap), dd.h))
        } else {
          // 四辺: その辺に平行な方向へ伸縮(反対の辺を固定)
          const axis = k[1] === 'x' ? 'x' : 'y'
          const sign = k[2] === '+' ? 1 : -1
          const size = axis === 'x' ? ent.w : ent.d
          const dd = defaultDims(ent)
          const v = Math.max(50, detent(
            snapTo(sign * (axis === 'x' ? local.x : local.y) + size / 2, snap),
            axis === 'x' ? dd.w : dd.d))
          const shiftLocal = (sign * (v - size)) / 2
          const dxm = axis === 'x' ? shiftLocal : 0
          const dym = axis === 'x' ? 0 : shiftLocal
          ent.pos = pt(ent.pos.x + dxm * cos - dym * sin, ent.pos.y + dxm * sin + dym * cos)
          if (axis === 'x') ent.w = v; else ent.d = v
        }
      } else {
        // 高さ・浮かせ: カメラに正対する鉛直面との交点の高さで決める
        const dir = this.camera.getWorldDirection(new THREE.Vector3())
        const n = new THREE.Vector3(dir.x, 0, dir.z).normalize()
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(ent.pos.x * M, this.gizmoDrag.grabY, ent.pos.y * M))
        const p = new THREE.Vector3()
        if (!this.ray(e).ray.intersectPlane(plane, p)) return
        if (k === 'h') {
          const yBase = this.levelYs[this.store.active] ?? 0
          const elev = ent.type !== 'column' ? (ent.elev ?? 0) : 0
          ent.h = Math.max(50, detent(snapTo((p.y - yBase) * 1000 - elev, 50), defaultDims(ent).h))
        } else if (ent.type === 'furniture' || ent.type === 'custom') {
          ent.elev = Math.max(0, snapTo(this.gizmoDrag.startElev + (p.y - this.gizmoDrag.startPtY) * 1000, 50))
        }
      }
      const elevTxt = ent.type === 'furniture' && (ent.elev ?? 0) > 0 ? ` ・ 浮かせ ${ent.elev}` : ''
      this.showHint(`幅 ${ent.w} ・ 奥行 ${ent.d} ・ 高さ ${ent.h}${elevTxt}`, e.clientX, e.clientY)
      this.rebuildSoon()
      return
    }
    if (this.heightDrag && this.store) {
      // カメラに正対する鉛直面とレイの交点の高さ = 新しいオブジェクト高さ
      const dir = this.camera.getWorldDirection(new THREE.Vector3())
      const n = new THREE.Vector3(dir.x, 0, dir.z).normalize()
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.heightDrag.point)
      const p = new THREE.Vector3()
      if (!this.ray(e).ray.intersectPlane(plane, p)) return
      const h = Math.max(100, snapTo((p.y - this.heightDrag.baseY) * 1000, 50))
      const ent = this.store.byId(this.heightDrag.id)
      if (!ent) return
      let shown = h
      if (ent.type === 'wall') { ent.height = Math.max(300, h); shown = ent.height }
      else if (ent.type === 'furniture' || ent.type === 'column' || ent.type === 'custom') { ent.h = h; shown = ent.h }
      this.showHint(`高さ ${shown}`, e.clientX, e.clientY)
      this.rebuildSoon()
      return
    }
    if (!this.dragging || !this.store) {
      if (!this.dragging && !this.heightDrag && !this.gizmoDrag && !this.openingDrag) {
        this.updatePreview(e)
        // つまみの上では OS の「つかむ手」カーソルに
        if (this.gizmo.children.length) {
          const over = this.ray(e).intersectObjects(this.gizmo.children, true).length > 0
          this.renderer.domElement.style.cursor = over ? 'grab' : ''
        } else if (this.renderer.domElement.style.cursor === 'grab') {
          this.renderer.domElement.style.cursor = ''
        }
      }
      return
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.dragging.planeY)
    const p = new THREE.Vector3()
    if (!this.ray(e).ray.intersectPlane(plane, p)) return
    const snap = this.getSnap()
    const dx = snapTo((p.x - this.dragging.last.x) * 1000, snap)
    const dz = snapTo((p.z - this.dragging.last.z) * 1000, snap)
    if (!dx && !dz) return
    this.dragging.last.x += dx / 1000
    this.dragging.last.z += dz / 1000
    // 選択中の要素(グループ含む)をまとめて動かす
    const ids = this.getSelection()
    const moveIds = new Set(ids.has(this.dragging.id) ? ids : [this.dragging.id])
    for (const id of moveIds) {
      const ent = this.store.byId(id)
      if (ent && ent.type !== 'opening') moveEntity(ent, dx, dz)
    }
    // 壁を動かすときは、載っている窓・ドアのメッシュも一緒に動かす(データは t 参照なので追従済み)
    for (const e of this.store.doc.entities) {
      if (e.type === 'opening' && moveIds.has(e.wallId)) moveIds.add(e.id)
    }
    // 軽量化: ドラッグ中はシーンを作り直さず、該当メッシュを平行移動するだけ
    for (const g of this.model.children) {
      for (const child of g.children) {
        if (moveIds.has(child.userData.entId as string)) {
          child.position.x += dx / 1000
          child.position.z += dz / 1000
        }
      }
    }
    // つまみもオブジェクトと一緒に動かす
    this.gizmo.position.x += dx / 1000
    this.gizmo.position.z += dz / 1000
    this.lastMoveIds = moveIds
    this.render()
  }
  private pointerUp(e: PointerEvent): void {
    if (this.marquee3d && this.store) {
      const m = this.marquee3d
      this.marquee3d = null
      m.el.remove()
      this.controls.enabled = true
      const rc = this.renderer.domElement.getBoundingClientRect()
      const x1 = Math.min(m.x0, e.clientX) - rc.left, x2 = Math.max(m.x0, e.clientX) - rc.left
      const y1 = Math.min(m.y0, e.clientY) - rc.top, y2 = Math.max(m.y0, e.clientY) - rc.top
      if (x2 - x1 > 6 || y2 - y1 > 6) {
        const ids = new Set<string>()
        const bb = new THREE.Box3()
        const c = new THREE.Vector3()
        for (const g of this.model.children) {
          if (!g.visible) continue
          for (const child of g.children) {
            const id = child.userData.entId as string | undefined
            if (!id) continue
            bb.setFromObject(child)
            if (bb.isEmpty()) continue
            bb.getCenter(c)
            const pr = c.project(this.camera)
            if (pr.z > 1) continue
            const sx = ((pr.x + 1) / 2) * rc.width, sy = ((1 - pr.y) / 2) * rc.height
            if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) ids.add(id)
          }
        }
        this.onSelectSet([...ids])
        this.highlightSelection()
      }
      return
    }
    const moved = Math.abs(e.clientX - this.downAt.x) + Math.abs(e.clientY - this.downAt.y) >= 4
    if (this.rotDrag) {
      this.rotDrag = null
      this.hideHint()
      this.controls.enabled = true
      this.renderer.domElement.style.cursor = ''
      this.onEdited()
      return
    }
    if (this.dragging || this.heightDrag || this.gizmoDrag || this.openingDrag) {
      const wasDrag = moved
      if (this.dragging && wasDrag) {
        for (const id of this.lastMoveIds) this.magnetize(id) // 壁面にピッタリ吸着
        this.lastMoveIds = new Set()
      }
      if (!wasDrag && this.drillPending && this.store) {
        // クリック(動かさない)→ その要素だけに絞る
        this.onSelect(this.drillPending, this.store.active, 'drill')
        this.highlightSelection()
      }
      this.drillPending = null
      this.dragging = null
      this.heightDrag = null
      this.gizmoDrag = null
      this.openingDrag = null
      this.hideHint()
      this.dimGroup.visible = false
      this.renderer.domElement.style.cursor = ''
      this.controls.enabled = true
      this.onEdited() // 確定時に 1 回だけ再構築(壁の接合などを正しく再計算)
      return
    }
    this.controls.enabled = true
    if (e.button !== 0 || !this.store || moved) return
    // 計測モード: 2 点クリックで距離を測る
    if (this.measureOn) {
      const hit = this.pick(e)
      const p = hit ? hit.point.clone() : (() => {
        const gp = this.groundPoint(e)
        return gp ? new THREE.Vector3(gp.x * M, this.levelYs[this.store.active] ?? 0, gp.y * M) : null
      })()
      if (!p) return
      const marker = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xdc2626, depthTest: false }))
      marker.renderOrder = 999
      marker.position.copy(p)
      if (!this.measureA) {
        this.clearMeasure()
        this.measureGroup.add(marker)
        this.measureA = p
        this.onMeasure('終点をクリックしてください')
      } else {
        this.measureGroup.add(marker)
        const geo = new THREE.BufferGeometry().setFromPoints([this.measureA, p])
        const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xdc2626, depthTest: false }))
        line.renderOrder = 999
        this.measureGroup.add(line)
        const mm = Math.round(this.measureA.distanceTo(p) * 1000)
        this.onMeasure(`距離: ${mm} mm (${(mm / 1000).toFixed(3)} m)`)
        const mid = this.measureA.clone().add(p).multiplyScalar(0.5)
        mid.y += 0.12
        this.showHintWorld(`${mm} mm`, mid)
        this.measureA = null
      }
      this.render()
      return
    }
    const tool = this.getTool()
    if (tool === 'door' || tool === 'window') {
      const hit = this.pick(e)
      if (hit) this.onPlace(pt(hit.point.x * 1000, hit.point.z * 1000), hit.id, hit.level)
      return
    }
    if (tool !== 'select') {
      const p = this.groundPoint(e)
      if (p) this.onPlace(p, undefined, this.store.active)
      return
    }
    if (!this.pick(e, true)) {
      this.onSelect('', this.store.active, 'replace') // 空クリックで選択解除
      this.highlightSelection()
    }
  }

  resize(): void {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.render()
  }

  render(): void {
    // つまみはカメラ距離に応じてスケール。上限 1.0 なので、ズームアウトすると画面上でも小さくなる
    for (const child of this.gizmo.children) {
      if ((child.userData.gizmo as string | undefined)?.startsWith('r')) continue
      const d = child.position.distanceTo(this.camera.position)
      child.scale.setScalar(Math.min(1.0, Math.max(0.2, d / 9)))
    }
    this.renderer.render(this.scene, this.camera)
    this.onRendered()
  }

  setAxesVisible(v: boolean): void { this.axes.visible = v; this.render() }
  setGroundVisible(v: boolean): void { this.ground.visible = v; this.render() } // グリッドは常に表示

  /** 選択要素のバウンディングボックス上端中央のスクリーン座標(3D アクションアイコン用) */
  projectSelection(ids: Set<string>): { x: number; y: number } | null {
    if (!ids.size) return null
    const bb = new THREE.Box3()
    let found = false
    for (const g of this.model.children) {
      if (!g.visible) continue
      for (const child of g.children) {
        if (ids.has(child.userData.entId as string)) { bb.expandByObject(child); found = true }
      }
    }
    if (!found || bb.isEmpty()) return null
    const c = bb.getCenter(new THREE.Vector3())
    c.y = bb.max.y
    const pr = c.project(this.camera)
    if (pr.z > 1) return null // カメラの後ろ
    const r = this.renderer.domElement.getBoundingClientRect()
    return { x: ((pr.x + 1) / 2) * r.width, y: ((1 - pr.y) / 2) * r.height }
  }

  hidePreview(): void {
    if (!this.preview.visible) return
    this.preview.visible = false
    this.hideHint()
    this.render()
  }

  /** 配置ツールのゴーストプレビューをカーソル位置に表示 */
  private updatePreview(e: PointerEvent): void {
    const tool = this.getTool()
    const place = ['wall', 'column', 'stair', 'furniture', 'equipment', 'planting', 'label', 'component', 'door', 'window', 'room', 'dimension', 'pencil']
    if (tool === 'select' || this.measureOn || !place.includes(tool) || !this.store) { this.hidePreview(); return }
    const yBase = this.levelYs[this.store.active] ?? 0
    this.previewBox.visible = false
    this.previewPole.visible = false
    this.previewLine.visible = false
    this.previewCustom.visible = false
    const info = this.getPreview()

    if (tool === 'door' || tool === 'window') {
      const hit = this.pick(e)
      const wall = hit ? this.store.byId(hit.id) : undefined
      if (hit && wall?.type === 'wall' && info) {
        const d = norm(sub(wall.b, wall.a))
        const sill = info.sill ?? 0
        const hgt = Math.max(0.05, (info.h - sill) * M)
        this.previewBox.visible = true
        this.previewBox.scale.set(info.w * M, hgt, wall.thickness * M + 0.02)
        this.previewBox.position.set(hit.point.x, yBase + sill * M + hgt / 2, hit.point.z)
        this.previewBox.rotation.y = -Math.atan2(d.y, d.x)
      }
    } else if (tool === 'wall' && info) {
      const gp = this.groundPoint(e)
      if (gp) {
        const start = this.getWallStart()
        this.previewPole.visible = true
        const poleH = info.h * M
        const px = (start ? gp.x : snapTo(gp.x, this.getSnap())) * M
        const pz = (start ? gp.y : snapTo(gp.y, this.getSnap())) * M
        this.previewPole.scale.set(1, poleH, 1)
        this.previewPole.position.set(start ? start.x * M : px, yBase + poleH / 2, start ? start.y * M : pz)
        if (start) {
          // 1回目クリック後: 始点から伸びる半透明の壁 + 長さ表示
          const ex = snapTo(gp.x, this.getSnap()), ez = snapTo(gp.y, this.getSnap())
          const len = Math.hypot(ex - start.x, ez - start.y)
          if (len > 1) {
            this.previewBox.visible = true
            this.previewBox.scale.set(len * M, info.h * M, info.d * M)
            this.previewBox.position.set((start.x + ex) / 2 * M, yBase + info.h * M / 2, (start.y + ez) / 2 * M)
            this.previewBox.rotation.y = -Math.atan2(ez - start.y, ex - start.x)
            this.showHint(`${Math.round(len)} mm`, e.clientX, e.clientY)
          }
        }
      }
    } else if (tool === 'room' || tool === 'dimension' || tool === 'pencil') {
      const gp = this.groundPoint(e)
      const pts = tool === 'dimension' ? this.getDimPts() : this.getRoomPts()
      if (gp) {
        const v: THREE.Vector3[] = pts.map(q => new THREE.Vector3(q.x * M, yBase + 0.03, q.y * M))
        v.push(new THREE.Vector3(snapTo(gp.x, this.getSnap()) * M, yBase + 0.03, snapTo(gp.y, this.getSnap()) * M))
        if (v.length >= 2) {
          this.previewLine.visible = true
          this.previewLine.geometry.setFromPoints(v)
        }
        this.previewPole.visible = true
        this.previewPole.scale.set(1, 0.6, 1)
        this.previewPole.position.set(v[v.length - 1].x, yBase + 0.3, v[v.length - 1].z)
      }
    } else if (info) {
      const gp = this.groundPoint(e)
      if (gp) {
        const gx = snapTo(gp.x, this.getSnap()), gz = snapTo(gp.y, this.getSnap())
        const proto = this.getPreviewEntity(pt(gx, gz))
        if (proto) {
          // 実際に配置される形状そのものを半透明で構築(スナップ位置が変わった時だけ再構築)
          const sig = JSON.stringify(proto)
          if (sig !== this.previewSig) {
            this.previewSig = sig
            this.previewCustom.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
            this.previewCustom.clear()
            const prevTarget = this.target
            this.target = this.previewCustom
            this.buildOne(proto)
            this.target = prevTarget
            this.previewCustom.traverse(o => {
              if (o instanceof THREE.Mesh) o.material = PREVIEW_MAT
            })
          }
          this.previewCustom.position.y = yBase
          this.previewCustom.visible = true
        } else {
          this.previewBox.visible = true
          this.previewBox.scale.set(Math.max(0.05, info.w * M), Math.max(0.05, info.h * M), Math.max(0.05, info.d * M))
          this.previewBox.position.set(gx * M, yBase + info.h * M / 2, gz * M)
          this.previewBox.rotation.y = -info.rot
        }
      }
    }
    this.preview.visible = this.previewBox.visible || this.previewPole.visible || this.previewLine.visible || this.previewCustom.visible
    this.render()
  }

  /** 平面図から 3D モデルを再構築(全階を積層して一棟まるごと生成) */
  rebuild(store: Store): void {
    this.store = store
    // グリッドを 2D と同じ幅に(変わったときだけ作り直す)
    if (this.getGrid() !== this.gridStepBuilt) this.buildGrid(this.getGrid())
    // 軽量化: 古いジオメトリを GPU から確実に解放(解放しないと徐々に重くなる)
    this.model.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose() })
    this.model.clear()
    this.levelYs = []
    let yBase = 0
    for (let li = 0; li < store.doc.levels.length; li++) {
      const level = store.doc.levels[li]
      this.levelYs.push(yBase + FLOOR_T) // コンテンツの床面 = スラブ上面
      const g = new THREE.Group()
      g.position.y = yBase
      this.model.add(g)
      this.target = g
      this.levelIdx = li
      this.buildLevel(level.entities)
      // 次の階の床レベル = 階高(設定があれば)/ なければ最大壁高 + 床スラブ厚
      if (level.height && level.height > 0) {
        yBase += level.height * M
      } else {
        const maxWallH = Math.max(2400, ...level.entities.filter((e): e is Wall => e.type === 'wall').map(w => w.height))
        yBase += maxWallH * M + 0.1
      }
    }
    this.target = this.model

    // 階の境界に薄い点線を表示(1F と 2F の境目など)
    this.floorLines.traverse(o => {
      if (o instanceof THREE.Line) { o.geometry.dispose(); (o.material as THREE.Material).dispose() }
    })
    this.floorLines.clear()
    {
      const bb = new THREE.Box3().setFromObject(this.model)
      if (!bb.isEmpty()) {
        for (let i = 1; i < this.levelYs.length; i++) {
          const y = this.levelYs[i] - FLOOR_T
          const m = 0.05
          const ptsL = [
            new THREE.Vector3(bb.min.x - m, y, bb.min.z - m),
            new THREE.Vector3(bb.max.x + m, y, bb.min.z - m),
            new THREE.Vector3(bb.max.x + m, y, bb.max.z + m),
            new THREE.Vector3(bb.min.x - m, y, bb.max.z + m),
            new THREE.Vector3(bb.min.x - m, y, bb.min.z - m)
          ]
          const ln = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(ptsL),
            new THREE.LineDashedMaterial({ color: 0x9ca3af, dashSize: 0.16, gapSize: 0.12, transparent: true, opacity: 0.7 }))
          ln.computeLineDistances()
          this.floorLines.add(ln)
        }
      }
    }

    // ワイヤーフレーム・上下階の表示設定を反映
    if (this.wireframeOn) this.applyWireframe()
    if (this.sectionOn) this.setSection(true)
    const active = store.active
    this.model.children.forEach((g, i) => {
      g.visible = i === active || (i < active ? this.showLower : this.showUpper)
    })

    // カメラの注視点合わせは初回だけ(再構築のたびに視点が飛ばないように)
    if (!this.didFitCamera) {
      const bb = new THREE.Box3().setFromObject(this.model)
      if (!bb.isEmpty()) {
        const c = bb.getCenter(new THREE.Vector3())
        this.controls.target.set(c.x, 1, c.z)
        this.controls.update()
        this.didFitCamera = true
      }
    }
    this.highlightSelection() // render も行う
  }
  private didFitCamera = false

  private buildLevel(ents: import('./model').Entity[]): void {
    const openingsByWall = new Map<string, Opening[]>()
    for (const e of ents) {
      if (e.type === 'opening') {
        const arr = openingsByWall.get(e.wallId) ?? []
        arr.push(e); openingsByWall.set(e.wallId, arr)
      }
    }
    // 2D と同じ接合判定。延長量 = 相手の壁の厚みの半分(厚み違いでも段差が出ない)。
    // 平行(一直線)に続く壁は延長しない(側面が同一平面になり Z ファイトが起きるため)
    const walls = ents.filter((e): e is Wall => e.type === 'wall')
    const joinExt = (p: Pt, self: Wall): number => {
      const ds = norm(sub(self.b, self.a))
      let ext = 0
      for (const w of walls) {
        if (w === self || distToSeg(p, w.a, w.b) >= w.thickness / 2 + 1) continue
        const dw = norm(sub(w.b, w.a))
        const c = Math.abs(ds.x * dw.y - ds.y * dw.x) // sin(交差角)
        const k = Math.abs(ds.x * dw.x + ds.y * dw.y) // cos(交差角)
        if (c <= 0.25) continue // 平行は延長しない
        // 相手の壁からはみ出さない最大延長(直角なら相手の半厚と一致、斜めでは短くなる)
        const safe = Math.max(0, (w.thickness / 2 - (self.thickness / 2) * k) / c)
        ext = Math.max(ext, Math.min(w.thickness / 2, safe))
      }
      return ext * M
    }
    let wallIdx = 0

    let floorIdx = 0
    for (const e of ents) {
      if (e.hidden) continue
      const before = this.target.children.length
      if (e.type === 'wall') this.buildWall(e, openingsByWall.get(e.id) ?? [], joinExt(e.a, e), joinExt(e.b, e), wallIdx++)
      else if (e.type === 'room') {
        if (e.use !== '吹き抜け') this.buildFloor(e.poly, colorMat(e.color) ?? finishMat(e.material), floorIdx++)
      }
      else if (e.type === 'stair') this.buildStair(e, colorMat(e.color) ?? finishMat(e.material))
      else if (e.type === 'sketch') this.buildSketch(e)
      else if (e.type === 'furniture' || e.type === 'equipment' || e.type === 'column' || e.type === 'planting' || e.type === 'custom') {
        this.buildOne(e)
      }

      // この要素として追加されたメッシュに id を付与(3D での選択・移動用)。
      // 建具メッシュには開口自身の id が付いているので上書きしない
      for (let i = before; i < this.target.children.length; i++) {
        const child = this.target.children[i]
        if (!child.userData.entId) {
          child.userData.entId = e.id
          child.userData.level = this.levelIdx
        }
        // 床スラブの上に載せる(部屋=スラブ自身、植栽=屋外の地面なのでそのまま)
        if (e.type !== 'room' && e.type !== 'planting') child.position.y += FLOOR_T
      }
    }
  }

  /** 位置ベースの単一エンティティを構築(本編とゴーストプレビューで共用) */
  private buildOne(e: Entity): void {
    if (e.type === 'furniture') this.buildFurniture(e)
    else if (e.type === 'stair') this.buildStair(e, colorMat(e.color) ?? finishMat(e.material))
    else if (e.type === 'equipment') this.buildEquipment(e)
    else if (e.type === 'column') {
      const cm = colorMat(e.color) ?? finishMat(e.material) ?? MAT.column
      const hh = e.h * M + FLOOR_T // スラブ貫通で階の底まで
      if (e.shape === 'round') {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(e.w * M / 2, e.w * M / 2, hh, 20), cm)
        m.position.set(e.pos.x * M, (e.h * M - FLOOR_T) / 2, e.pos.y * M)
        this.target.add(m)
      } else {
        this.box(e.w * M, hh, e.d * M, cm, e.pos.x * M, (e.h * M - FLOOR_T) / 2, e.pos.y * M, -e.rot)
      }
    } else if (e.type === 'planting') this.buildPlanting(e.kind, e.pos.x * M, e.pos.y * M, e.height * M)
    else if (e.type === 'custom') {
      // 部品スタジオ製: 保存済みメッシュを寸法比でスケールして表示
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(e.positions, 3))
      geo.computeVertexNormals()
      const mesh = new THREE.Mesh(geo, colorMat(e.color) ?? MAT.furniture)
      mesh.scale.set((e.w / e.w0) * M, (e.h / e.h0) * M, (e.d / e.d0) * M)
      mesh.position.set(e.pos.x * M, (e.elev ?? 0) * M, e.pos.y * M)
      mesh.rotation.y = -e.rot
      if (e.tiltX) mesh.rotation.x = (e.tiltX * Math.PI) / 180
      if (e.tiltZ) mesh.rotation.z = (e.tiltZ * Math.PI) / 180
      this.target.add(mesh)
    }
  }

  /** 家具: 種類ごとに組み立てる(単純な箱の集合なので軽い) */
  private buildFurniture(e: import('./model').Furniture): void {
    const g = new THREE.Group()
    g.position.set(e.pos.x * M, ((e.elev ?? 0)) * M, e.pos.y * M)
    g.rotation.y = -e.rot
    if (e.tiltX) g.rotation.x = (e.tiltX * Math.PI) / 180
    if (e.tiltZ) g.rotation.z = (e.tiltZ * Math.PI) / 180
    const mat = colorMat(e.color) ?? finishMat(e.material) ?? MAT.furniture
    const W = e.w * M, D = e.d * M, H = e.h * M
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material = mat): void => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d)), m)
      mesh.position.set(x, y, z)
      g.add(mesh)
    }
    const wood = MAT.woodDark, fabric = MAT.fabric, white = MAT.white, metal = MAT.equipment
    const legs = (lw: number, lh: number): void => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        add(lw, lh, lw, sx * (W / 2 - lw), lh / 2, sz * (D / 2 - lw), wood)
      }
    }
    switch (e.kind) {
      case 'bed_s': case 'bed_d':
        add(W, H * 0.4, D, 0, H * 0.2, 0, wood)                       // フレーム
        add(W * 0.96, H * 0.45, D * 0.96, 0, H * 0.6, 0, white)       // マットレス
        add(W * 0.6, H * 0.25, D * 0.16, 0, H * 0.9, -D * 0.36, fabric) // 枕
        add(W, H * 0.9, 0.03, 0, H * 0.65, -D / 2 + 0.015, wood)      // ヘッドボード
        break
      case 'table': case 'desk':
        add(W, 0.035, D, 0, H - 0.018, 0, mat)                        // 天板
        legs(0.045, H - 0.035)
        break
      case 'chair':
        add(W, 0.04, D, 0, H * 0.55, 0, mat)                          // 座面
        add(W, H * 0.45, 0.035, 0, H * 0.78, -D / 2 + 0.018, mat)     // 背もたれ
        legs(0.03, H * 0.53)
        break
      case 'sofa':
        add(W, H * 0.45, D, 0, H * 0.23, 0, fabric)                   // 座部
        add(W, H * 0.55, D * 0.25, 0, H * 0.6, -D * 0.37, fabric)     // 背
        add(W * 0.1, H * 0.7, D, -W * 0.45, H * 0.35, 0, fabric)      // 肘掛け
        add(W * 0.1, H * 0.7, D, W * 0.45, H * 0.35, 0, fabric)
        break
      case 'kitchen': {
        add(W, H, D, 0, H / 2, 0, mat)                                // 本体
        add(W, 0.02, D, 0, H + 0.01, 0, white)                        // 天板
        const sink = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, D * 0.6), metal)
        sink.position.set(-W * 0.25, H + 0.025, 0)
        g.add(sink)
        for (const dx of [0.12, 0.36]) {                              // コンロ
          const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 16), MAT.dark)
          burner.position.set(W * dx, H + 0.03, 0)
          g.add(burner)
        }
        break
      }
      case 'toilet': {
        add(W * 0.9, H * 0.9, D * 0.3, 0, H * 0.55, -D * 0.33, white) // タンク
        const bowl = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.42, W * 0.3, H * 0.55, 16), white)
        bowl.position.set(0, H * 0.28, D * 0.12)
        g.add(bowl)
        add(W * 0.85, 0.03, D * 0.55, 0, H * 0.58, D * 0.1, white)    // 便座
        break
      }
      case 'bathtub':
        add(W, H, D, 0, H / 2, 0, white)                              // 外郭
        add(W - 0.16, 0.02, D - 0.16, 0, H - 0.06, 0, MAT.water)      // 湯面
        break
      case 'washbasin': {
        add(W, H * 0.75, D, 0, H * 0.375, 0, mat)                     // キャビネット
        const basin = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.3, W * 0.22, 0.12, 16), white)
        basin.position.set(0, H * 0.78, 0)
        g.add(basin)
        add(0.03, H * 0.22, 0.03, 0, H * 0.86, -D * 0.3, metal)       // 水栓
        break
      }
      case 'fridge':
        add(W, H, D, 0, H / 2, 0, white)
        add(0.02, H * 0.3, 0.04, -W / 2 + 0.03, H * 0.72, D / 2 + 0.02, metal) // 取っ手
        add(W, 0.008, D, 0, H * 0.62, 0.001, metal)                   // ドア分割線
        break
      case 'washer': {
        add(W, H, D, 0, H / 2, 0, white)
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.32, W * 0.32, 0.02, 20), MAT.dark)
        drum.rotation.x = Math.PI / 2
        drum.position.set(0, H * 0.48, D / 2 + 0.01)
        g.add(drum)
        break
      }
      case 'closet':
        add(W, H, D, 0, H / 2, 0, mat)
        add(0.006, H, D, 0, H / 2, 0.001, wood)                       // 中央分割
        for (const sx of [-1, 1]) add(0.015, H * 0.25, 0.02, sx * W * 0.06, H * 0.5, D / 2 + 0.012, metal) // 取っ手
        break
      default: // box その他
        add(W, H, D, 0, H / 2, 0, mat)
    }
    this.target.add(g)
  }

  /** 設備: 種類ごとの形状 */
  private buildEquipment(e: import('./model').Equipment): void {
    const g = new THREE.Group()
    g.position.set(e.pos.x * M, 0, e.pos.y * M)
    g.rotation.y = -e.rot
    const metal = MAT.equipment, white = MAT.white
    switch (e.kind) {
      case 'ventfan': { // 換気扇: 壁付けの丸型フード + 羽根
        const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.1, 16), white)
        hood.rotation.x = Math.PI / 2
        hood.position.y = 2.2
        g.add(hood)
        for (let i = 0; i < 4; i++) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.02, 0.035), metal)
          blade.position.set(Math.cos(i * Math.PI / 2) * 0.06, 2.2, Math.sin(i * Math.PI / 2) * 0.06 + 0.03)
          blade.rotation.y = i * Math.PI / 2 + 0.5
          g.add(blade)
        }
        break
      }
      case 'alarm': { // 火災警報器: 天井の小さな円盤
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.04, 14), white)
        disc.position.y = 2.35
        g.add(disc)
        break
      }
      case 'ac_indoor': {
        const unit = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.28, 0.22), white)
        unit.position.y = 2.1
        g.add(unit)
        const vent = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.03, 0.02), metal)
        vent.position.set(0, 2.0, 0.1)
        g.add(vent)
        break
      }
      case 'ac_outdoor': {
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.6, 0.3), white)
        body.position.y = 0.35
        g.add(body)
        const fan = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.025, 8, 20), metal)
        fan.position.set(-0.15, 0.38, 0.16)
        g.add(fan)
        break
      }
      case 'boiler': case 'heater': {
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.3), white)
        body.position.y = 0.75
        g.add(body)
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), metal)
        pipe.position.set(0.15, 0.2, 0)
        g.add(pipe)
        break
      }
      case 'panel': {
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.12), white)
        body.position.y = 1.9
        g.add(body)
        break
      }
    }
    this.target.add(g)
  }

  private box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, rotY = 0): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat)
    m.position.set(x, y, z)
    m.rotation.y = rotY
    this.target.add(m)
    return m
  }

  private buildWall(w: Wall, openings: Opening[], extA: number, extB: number, idx = 0): void {
    const L = dist(w.a, w.b) * M
    if (L < 0.01) return
    // 天面の Z ファイト防止: 壁ごとに 1mm 未満の高さ差を付けて共面を避ける(見た目には分からない)
    const topBias = ((idx * 37) % 101) * 0.00001
    const H = w.height * M - topBias, T = w.thickness * M
    const d = norm(sub(w.b, w.a))
    const ang = Math.atan2(d.y, d.x)
    const mat = colorMat(w.color) ?? finishMat(w.material) ?? (w.structural ? MAT.structural : MAT.wall)
    const place = (from: number, to: number, y0: number, y1: number, m: THREE.Material): void => {
      if (to - from < 0.005 || y1 - y0 < 0.005) return
      const bottom = y0 === 0 ? -FLOOR_T : y0 // 接地部はスラブを貫通して階の底まで(階間の隙間防止)
      const mid = (from + to) / 2 // m 単位(壁始点からの距離)
      const cx = w.a.x * M + d.x * mid
      const cz = w.a.y * M + d.y * mid
      const mesh = this.box(to - from, y1 - bottom, T, m, cx, (bottom + y1) / 2, cz, -ang)
      // テクスチャを実寸基準に(窓の移動でレンガが伸び縮みしない)
      uvWorldScale(mesh.geometry, to - from, y1 - bottom, T, from)
    }
    const sorted = [...openings].sort((a, b) => a.t - b.t)
    // 接合端は相手の厚み分だけ延長して角の隙間をなくす。2mm 短くして端面を相手の内部に隠す
    let cur = extA > 0 ? -(extA - 0.002) : 0
    for (const o of sorted) {
      const c = o.t * L, half = (o.width * M) / 2
      const from = Math.max(cur, c - half), to = Math.min(L, c + half)
      place(cur, from, 0, H, mat)                       // 開口までの壁
      const head = Math.min(o.head * M, H)
      place(from, to, head, H, mat)                     // まぐさ(開口上部)
      if (isWindow(o.kind)) {
        const sill = Math.min(o.sill * M, head)
        place(from, to, 0, sill, mat)                   // 腰壁
        // ガラス
        const gm = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.01, to - from - 0.004), Math.max(0.01, head - sill - 0.004), 0.02), MAT.glass)
        const mid = (from + to) / 2
        gm.position.set(w.a.x * M + d.x * mid, (sill + head) / 2, w.a.y * M + d.y * mid)
        gm.rotation.y = -ang
        gm.userData.entId = o.id
        gm.userData.level = this.levelIdx
        this.target.add(gm)
      } else {
        // ドアの建具(薄板)
        const dm = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.01, to - from - 0.004), head - 0.002, 0.04), MAT.door)
        const mid = (from + to) / 2
        dm.position.set(w.a.x * M + d.x * mid, head / 2, w.a.y * M + d.y * mid)
        dm.rotation.y = -ang
        dm.userData.entId = o.id
        dm.userData.level = this.levelIdx
        this.target.add(dm)
      }
      cur = to
    }
    place(cur, L + (extB > 0 ? extB - 0.002 : 0), 0, H, mat)
  }

  /**
   * スケッチ(鉛筆): 閉路 = 面。押し出し高さのある面は立体に、
   * 内側の面(入れ子)は外側から貫通して抜き、それ自身の高さで立ち上げる。
   * 削除(dead)された面は穴のまま。辺は色付きラインで表示。
   */
  private buildSketch(e: SketchE): void {
    const g = new THREE.Group()
    const faces = sketchFaces(e)
    const parents = faceNesting(faces)
    const toV2 = (poly: Pt[]): THREE.Vector2[] => poly.map(p => new THREE.Vector2(p.x * M, p.y * M))
    for (let i = 0; i < faces.length; i++) {
      const info = faceInfo(e, faces[i])
      if (info.dead) continue
      const shape = new THREE.Shape(toV2(faces[i]))
      for (let j = 0; j < faces.length; j++) {
        if (parents[j] === i) shape.holes.push(new THREE.Path(toV2(faces[j]))) // 内側の面は貫通
      }
      const hM = (info.h ?? 0) * M
      let geo: THREE.BufferGeometry
      if (hM > 0.001) {
        geo = new THREE.ExtrudeGeometry(shape, { depth: hM, bevelEnabled: false })
        geo.rotateX(Math.PI / 2)
        geo.translate(0, hM, 0) // 床面から上へ
      } else {
        geo = new THREE.ShapeGeometry(shape)
        geo.rotateX(Math.PI / 2)
        geo.translate(0, 0.004, 0) // 床とのZファイト防止
      }
      const mesh = new THREE.Mesh(geo, hM > 0.001 ? MAT.wall : MAT.stair)
      g.add(mesh)
    }
    // 辺(色付き)
    for (const ed of e.edges) {
      const lg = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ed.a.x * M, 0.008, ed.a.y * M),
        new THREE.Vector3(ed.b.x * M, 0.008, ed.b.y * M)
      ])
      g.add(new THREE.Line(lg, sketchLineMat(ed.color)))
    }
    this.target.add(g)
  }

  private buildFloor(poly: { x: number; y: number }[], mat: THREE.Material | null = null, idx = 0): void {
    if (poly.length < 3) return
    const shape = new THREE.Shape(poly.map(p => new THREE.Vector2(p.x * M, p.y * M)))
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.1, bevelEnabled: false })
    geo.rotateX(Math.PI / 2) // XY 平面 → XZ 平面(y=平面図の y → z)
    const mesh = new THREE.Mesh(geo, mat ?? MAT.floor)
    // スラブは 0〜+FLOOR_T(地面より上)。微小オフセットで重なった床の Z ファイト防止
    mesh.position.y = FLOOR_T + idx * 0.002
    this.target.add(mesh)
  }

  private buildStair(s: { pos: { x: number; y: number }; rot: number; kind: string; width: number; treads: number; tread: number; riser: number }, mat: THREE.Material | null = null): void {
    const SM = mat ?? MAT.stair
    const g = new THREE.Group()
    g.position.set(s.pos.x * M, 0, s.pos.y * M)
    g.rotation.y = -s.rot
    const W = s.width * M, T = s.tread * M, R = s.riser * M
    const step = (x: number, z: number, i: number, rotY = 0): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(T, R * (i + 1), W), SM)
      m.position.set(x, (R * (i + 1)) / 2, z)
      m.rotation.y = rotY
      g.add(m)
    }
    if (s.kind === 'straight') {
      for (let i = 0; i < s.treads; i++) step(i * T + T / 2, W / 2, i)
    } else if (s.kind === 'l') {
      const n1 = Math.max(1, Math.floor(s.treads / 2)), n2 = s.treads - n1 - 1
      for (let i = 0; i < n1; i++) step(i * T + T / 2, W / 2, i)
      const lm = new THREE.Mesh(new THREE.BoxGeometry(W, R * (n1 + 1), W), SM) // 踊り場
      lm.position.set(n1 * T + W / 2, (R * (n1 + 1)) / 2, W / 2)
      g.add(lm)
      for (let i = 0; i < n2; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(W, R * (n1 + 2 + i), T), SM)
        m.position.set(n1 * T + W / 2, (R * (n1 + 2 + i)) / 2, W + i * T + T / 2)
        g.add(m)
      }
    } else if (s.kind === 'u') {
      const n1 = Math.max(1, Math.floor((s.treads - 1) / 2)), n2 = s.treads - 1 - n1
      const L = Math.max(n1, n2) * T
      for (let i = 0; i < n1; i++) step(i * T + T / 2, W / 2, i)
      const lm = new THREE.Mesh(new THREE.BoxGeometry(W, R * (n1 + 1), W * 2), SM)
      lm.position.set(L + W / 2, (R * (n1 + 1)) / 2, W)
      g.add(lm)
      for (let i = 0; i < n2; i++) {
        const x = L - i * T - T / 2
        const m = new THREE.Mesh(new THREE.BoxGeometry(T, R * (n1 + 2 + i), W), SM)
        m.position.set(x, (R * (n1 + 2 + i)) / 2, W * 1.5)
        g.add(m)
      }
    } else { // 螺旋
      const total = Math.PI * 1.75, Rout = s.width * M
      for (let i = 0; i < s.treads; i++) {
        const a = (i / s.treads) * total
        const m = new THREE.Mesh(new THREE.BoxGeometry(Rout, R * (i + 1), Rout * 0.28), SM)
        m.position.set(Math.cos(a) * Rout * 0.5, (R * (i + 1)) / 2, Math.sin(a) * Rout * 0.5)
        m.rotation.y = -a
        g.add(m)
      }
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, R * (s.treads + 1)), MAT.equipment)
      pole.position.y = (R * (s.treads + 1)) / 2
      g.add(pole)
    }
    this.target.add(g)
  }

  private buildPlanting(kind: string, x: number, z: number, h: number): void {
    const g = new THREE.Group()
    g.position.set(x, 0, z)
    if (kind === 'tree') {
      // ローポリツリー: テーパー幹(樹冠の中まで届く)+ 中心軸上に密に重ねた樹冠
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.025, h * 0.05, h * 0.55, 8), MAT.trunk)
      trunk.position.y = h * 0.275
      g.add(trunk)
      // 樹冠: 大球を軸上に、その周囲に食い込む小球(全て相互に重なる=浮きなし)
      const main = new THREE.Mesh(new THREE.SphereGeometry(h * 0.27, 12, 9), MAT.leaf)
      main.position.y = h * 0.66
      main.scale.y = 0.92
      g.add(main)
      const around: [number, number, number, number][] = [
        [h * 0.15, h * 0.58, 0, h * 0.2],
        [-h * 0.13, h * 0.6, h * 0.08, h * 0.19],
        [0, h * 0.62, -h * 0.15, h * 0.19],
        [0.01, h * 0.82, 0.02, h * 0.18]
      ]
      for (const [cx, cy, cz, r] of around) {
        const c = new THREE.Mesh(new THREE.SphereGeometry(r, 11, 8), MAT.leaf)
        c.position.set(cx, cy, cz)
        c.scale.y = 0.9
        g.add(c)
      }
    } else if (kind === 'shrub') {
      // 低木: 地面に接する丸い株(中心球 + 密に食い込む周囲球、幹なし)
      const main = new THREE.Mesh(new THREE.SphereGeometry(h * 0.5, 12, 9), MAT.leaf)
      main.position.y = h * 0.46
      main.scale.y = 0.9
      g.add(main)
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.5
        const r = h * 0.34
        const c = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), MAT.leaf)
        c.position.set(Math.cos(a) * h * 0.22, h * 0.34, Math.sin(a) * h * 0.22)
        c.scale.y = 0.88
        g.add(c)
      }
    } else {
      // 人物: 頭・胴体・腕・脚のシンプルな人型
      const H = h || 1.9
      const skin = MAT.person
      const head = new THREE.Mesh(new THREE.SphereGeometry(H * 0.065, 12, 10), skin)
      head.position.y = H * 0.925
      const torso = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.075, H * 0.09, H * 0.33, 10), MAT.fabric)
      torso.position.y = H * 0.69
      const hips = new THREE.Mesh(new THREE.SphereGeometry(H * 0.08, 8, 6), MAT.dark)
      hips.position.y = H * 0.52
      hips.scale.y = 0.5
      g.add(head, torso, hips)
      for (const sx of [-1, 1]) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.022, H * 0.02, H * 0.32, 8), skin)
        arm.position.set(sx * H * 0.105, H * 0.68, 0)
        arm.rotation.z = sx * 0.08
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(H * 0.035, H * 0.028, H * 0.48, 8), MAT.dark)
        leg.position.set(sx * H * 0.045, H * 0.26, 0)
        const foot = new THREE.Mesh(new THREE.BoxGeometry(H * 0.05, H * 0.025, H * 0.11), MAT.dark)
        foot.position.set(sx * H * 0.045, H * 0.012, H * 0.02)
        g.add(arm, leg, foot)
      }
    }
    this.target.add(g)
  }

  // ---------------- 書き出し ----------------
  /** OBJ 書き出し(SketchUp / Blender / AutoCAD 等で読み込み可) */
  exportOBJ(): string {
    const out: string[] = ['# Open ArchiCAD OBJ export (unit: meters)']
    let offset = 1
    this.model.updateMatrixWorld(true)
    this.model.traverse(obj => {
      if (!(obj instanceof THREE.Mesh)) return
      const geo = obj.geometry as THREE.BufferGeometry
      const posAttr = geo.getAttribute('position')
      if (!posAttr) return
      out.push(`o mesh_${offset}`)
      const v = new THREE.Vector3()
      for (let i = 0; i < posAttr.count; i++) {
        v.fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld)
        out.push(`v ${v.x.toFixed(5)} ${v.y.toFixed(5)} ${(-v.z).toFixed(5)}`)
      }
      const idx = geo.getIndex()
      if (idx) {
        for (let i = 0; i < idx.count; i += 3) {
          out.push(`f ${offset + idx.getX(i)} ${offset + idx.getX(i + 2)} ${offset + idx.getX(i + 1)}`)
        }
      } else {
        for (let i = 0; i < posAttr.count; i += 3) {
          out.push(`f ${offset + i} ${offset + i + 2} ${offset + i + 1}`)
        }
      }
      offset += posAttr.count
    })
    return out.join('\n')
  }

  /** glTF (GLB) 書き出し(Blender 等) */
  exportGLB(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      new GLTFExporter().parse(
        this.model,
        result => resolve(new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' })),
        err => reject(err),
        { binary: true }
      )
    })
  }
}
