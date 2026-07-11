// JIS A 0150(建築製図通則)の平面表示記号に準拠した 2D 記号描画
// ctx はワールド座標(mm)に変換済み。線幅は zoom で割って画面ピクセル一定にする。
import {
  Wall, Opening, Stair, Furniture, Equipment, Planting, DimensionE, LabelE, Room, SketchE, isWindow, MATERIALS
} from './model'
import {
  Pt, sub, norm, perp, lerp, dist, netPolyArea, labelAnchor,
  sketchFaces, faceNesting, faceInfo, polyCentroid
} from './geometry'

const INK = '#1f2937'
const THIN = '#6b7280'

function lw(ctx: CanvasRenderingContext2D, zoom: number, px: number): void {
  ctx.lineWidth = px / zoom
}
function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, angle = 0, color = INK): void {
  ctx.save()
  ctx.translate(x, y)
  if (angle) ctx.rotate(angle)
  ctx.fillStyle = color
  ctx.font = `${size}px -apple-system, "Hiragino Sans", sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText(s, 0, 0)
  ctx.restore()
}

// ---------------- 柱(構造断面は塗りつぶし表示) ----------------
export function drawColumn(ctx: CanvasRenderingContext2D, c: import('./model').Column, zoom: number): void {
  ctx.save()
  ctx.translate(c.pos.x, c.pos.y); ctx.rotate(c.rot)
  ctx.fillStyle = c.color ?? '#374151'; ctx.strokeStyle = INK; lw(ctx, zoom, 1.2)
  ctx.beginPath()
  if (c.shape === 'round') ctx.arc(0, 0, c.w / 2, 0, Math.PI * 2)
  else ctx.rect(-c.w / 2, -c.d / 2, c.w, c.d)
  ctx.fill(); ctx.stroke()
  ctx.restore()
}

// ---------------- 建具(開口部) ----------------
export function openingCenter(o: Opening, w: Wall): { c: Pt; ang: number } {
  const c = lerp(w.a, w.b, o.t)
  const d = sub(w.b, w.a)
  return { c, ang: Math.atan2(d.y, d.x) }
}

export function drawOpening(ctx: CanvasRenderingContext2D, o: Opening, w: Wall, zoom: number): void {
  const { c, ang } = openingCenter(o, w)
  const hw = o.width / 2, ht = w.thickness / 2
  ctx.save()
  ctx.translate(c.x, c.y); ctx.rotate(ang)
  if (o.flip) ctx.scale(1, -1)
  if (o.swap) ctx.scale(-1, 1)

  // 開口部の白抜き(壁のアウトライン分も消す)
  const pad = 2.5 / zoom
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(-hw, -ht - pad, o.width, w.thickness + pad * 2)
  // 開口両端(方立)
  ctx.strokeStyle = INK; lw(ctx, zoom, 1.2)
  line(ctx, -hw, -ht, -hw, ht); line(ctx, hw, -ht, hw, ht)

  lw(ctx, zoom, 1)
  switch (o.kind) {
    case 'door_single': { // 片開き戸: 戸の線 + 開き軌跡の 1/4 円弧
      ctx.beginPath(); ctx.moveTo(-hw, 0); ctx.lineTo(-hw, -o.width); ctx.stroke()
      ctx.beginPath(); ctx.arc(-hw, 0, o.width, -Math.PI / 2, 0); ctx.stroke()
      break
    }
    case 'door_double': { // 両開き戸: 左右対称の 1/4 円弧
      ctx.beginPath(); ctx.moveTo(-hw, 0); ctx.lineTo(-hw, -hw); ctx.stroke()
      ctx.beginPath(); ctx.arc(-hw, 0, hw, -Math.PI / 2, 0); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(hw, 0); ctx.lineTo(hw, -hw); ctx.stroke()
      ctx.beginPath(); ctx.arc(hw, 0, hw, Math.PI, Math.PI * 1.5); ctx.stroke()
      break
    }
    case 'door_sliding': { // 引違い戸: 前後にずれた 2 本の戸
      const off = Math.max(30, w.thickness / 5)
      line(ctx, -hw, -off, hw * 0.1, -off)
      line(ctx, -hw * 0.1, off, hw, off)
      break
    }
    case 'door_pocket': { // 片引き戸: 戸 1 枚 + 戸袋(破線)
      const off = Math.max(30, w.thickness / 5)
      line(ctx, -hw, -off, hw * 0.15, -off)
      ctx.setLineDash([60, 40])
      line(ctx, hw * 0.15, -off, hw, -off)
      ctx.setLineDash([])
      break
    }
    case 'door_folding': { // 折りたたみ戸: ジグザグ
      ctx.beginPath()
      const seg = o.width / 4
      ctx.moveTo(-hw, 0)
      for (let i = 0; i < 4; i++) {
        ctx.lineTo(-hw + seg * (i + 0.5), (i % 2 === 0 ? -1 : -0.2) * seg * 1.2)
        ctx.lineTo(-hw + seg * (i + 1), 0)
      }
      ctx.stroke()
      break
    }
    case 'win_sliding': { // 引違い窓: 外郭線 + 互い違いの 2 本
      lw(ctx, zoom, 0.8)
      line(ctx, -hw, -ht, hw, -ht); line(ctx, -hw, ht, hw, ht)
      lw(ctx, zoom, 1.2)
      const off = w.thickness / 6
      line(ctx, -hw, -off, hw * 0.08, -off)
      line(ctx, -hw * 0.08, off, hw, off)
      break
    }
    case 'win_fix': { // はめ殺し窓: 外郭線 + 中心 1 本
      lw(ctx, zoom, 0.8)
      line(ctx, -hw, -ht, hw, -ht); line(ctx, -hw, ht, hw, ht)
      lw(ctx, zoom, 1.2)
      line(ctx, -hw, 0, hw, 0)
      break
    }
    case 'win_single': { // 片開き窓: 外郭線 + 開き弧(細)
      lw(ctx, zoom, 0.8)
      line(ctx, -hw, -ht, hw, -ht); line(ctx, -hw, ht, hw, ht)
      line(ctx, -hw, 0, -hw + o.width * 0.5, -o.width * 0.5)
      ctx.beginPath(); ctx.arc(-hw, 0, o.width * 0.7, -Math.PI / 4, 0); ctx.stroke()
      break
    }
  }
  ctx.restore()

  // 窓台高(腰高)の表記: 実務図面の「h=900」添記に倣い、腰窓のみ記載(掃き出しは省略)
  if (isWindow(o.kind) && o.sill > 0) {
    const d = { x: Math.cos(ang), y: Math.sin(ang) }
    const n = perp(d)
    const side = o.flip ? -1 : 1
    const off = w.thickness / 2 + 240
    text(ctx, `h=${o.sill}`, c.x + n.x * off * side, c.y + n.y * off * side, 170, 0, THIN)
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
}

// ---------------- 階段 ----------------
/** 昇り方向の矢印(始点に○、終点に矢) */
function upArrow(ctx: CanvasRenderingContext2D, pts: Pt[], zoom: number): void {
  ctx.strokeStyle = INK; lw(ctx, zoom, 1)
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.stroke()
  const s = pts[0]
  ctx.beginPath(); ctx.arc(s.x, s.y, 60, 0, Math.PI * 2); ctx.stroke()
  const e = pts[pts.length - 1], pv = pts[pts.length - 2]
  const d = norm(sub(e, pv)), n = perp(d), L = 140, W = 55
  ctx.beginPath()
  ctx.moveTo(e.x, e.y)
  ctx.lineTo(e.x - d.x * L + n.x * W, e.y - d.y * L + n.y * W)
  ctx.lineTo(e.x - d.x * L - n.x * W, e.y - d.y * L - n.y * W)
  ctx.closePath(); ctx.fillStyle = INK; ctx.fill()
}

export function drawStair(ctx: CanvasRenderingContext2D, s: Stair, zoom: number): void {
  ctx.save()
  ctx.translate(s.pos.x, s.pos.y); ctx.rotate(s.rot)
  ctx.strokeStyle = INK
  const W = s.width, T = s.tread
  if (s.kind === 'straight') {
    const L = s.treads * T
    lw(ctx, zoom, 1.4); ctx.strokeRect(0, 0, L, W)
    lw(ctx, zoom, 0.8)
    for (let i = 1; i < s.treads; i++) line(ctx, i * T, 0, i * T, W)
    upArrow(ctx, [{ x: T * 0.7, y: W / 2 }, { x: L - T * 0.5, y: W / 2 }], zoom)
  } else if (s.kind === 'l') { // かね折れ: 直進 → 踊り場 → 直角に曲がる
    const n1 = Math.max(1, Math.floor(s.treads / 2)), n2 = Math.max(1, s.treads - n1 - 1)
    const L1 = n1 * T, L2 = n2 * T
    lw(ctx, zoom, 1.4)
    ctx.strokeRect(0, 0, L1 + W, W)                 // 第1走行+踊り場
    ctx.strokeRect(L1, W, W, L2)                    // 第2走行(下向き +y)
    lw(ctx, zoom, 0.8)
    for (let i = 1; i <= n1; i++) line(ctx, i * T, 0, i * T, W)
    for (let i = 1; i <= n2; i++) line(ctx, L1, W + i * T - T + T, L1 + W, W + i * T)
    for (let i = 1; i < n2; i++) line(ctx, L1, W + i * T, L1 + W, W + i * T)
    upArrow(ctx, [{ x: T * 0.7, y: W / 2 }, { x: L1 + W / 2, y: W / 2 }, { x: L1 + W / 2, y: W + L2 - T * 0.4 }], zoom)
  } else if (s.kind === 'u') { // 折返し: 平行 2 走行 + 踊り場
    const n1 = Math.max(1, Math.floor((s.treads - 1) / 2)), n2 = Math.max(1, s.treads - 1 - n1)
    const L = Math.max(n1, n2) * T
    lw(ctx, zoom, 1.4)
    ctx.strokeRect(0, 0, L + W, W * 2)              // 外郭(踊り場含む)
    line(ctx, 0, W, L, W)                            // 中桁
    lw(ctx, zoom, 0.8)
    for (let i = 1; i <= n1; i++) line(ctx, i * T, 0, i * T, W)
    for (let i = 1; i <= n2; i++) line(ctx, i * T, W, i * T, W * 2)
    upArrow(ctx, [
      { x: T * 0.7, y: W / 2 }, { x: L + W / 2, y: W / 2 },
      { x: L + W / 2, y: W * 1.5 }, { x: T * 0.7, y: W * 1.5 }
    ], zoom)
  } else { // 螺旋階段
    const R = s.width, r = 90
    lw(ctx, zoom, 1.4)
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke()
    lw(ctx, zoom, 0.8)
    const total = Math.PI * 1.75
    for (let i = 0; i <= s.treads; i++) {
      const a = (i / s.treads) * total
      line(ctx, Math.cos(a) * r, Math.sin(a) * r, Math.cos(a) * R, Math.sin(a) * R)
    }
    // 弧に沿った昇り矢印
    const mid = (R + r) / 2, pts: Pt[] = []
    for (let i = 0; i <= 16; i++) {
      const a = 0.15 + (i / 16) * (total - 0.4)
      pts.push({ x: Math.cos(a) * mid, y: Math.sin(a) * mid })
    }
    upArrow(ctx, pts, zoom)
  }
  ctx.restore()
}

// ---------------- 家具 ----------------
export function drawFurniture(ctx: CanvasRenderingContext2D, f: Furniture, zoom: number): void {
  ctx.save()
  ctx.translate(f.pos.x, f.pos.y); ctx.rotate(f.rot)
  const w = f.w, d = f.d, hw = w / 2, hd = d / 2
  ctx.strokeStyle = INK; lw(ctx, zoom, 1)
  ctx.fillStyle = f.color ?? '#ffffff'
  const rect = (): void => { ctx.beginPath(); ctx.rect(-hw, -hd, w, d); ctx.fill(); ctx.stroke() }
  switch (f.kind) {
    case 'bed_s': case 'bed_d':
      rect()
      lw(ctx, zoom, 0.7)
      ctx.strokeRect(-hw + 60, -hd + 60, w - 120, 360)      // 枕
      line(ctx, -hw, -hd + 500, hw, -hd + 500)              // 掛け布団の折り返し
      break
    case 'table': case 'desk': case 'box': rect(); break
    case 'chair':
      rect(); lw(ctx, zoom, 0.7); line(ctx, -hw, -hd + 90, hw, -hd + 90)
      break
    case 'sofa':
      rect(); lw(ctx, zoom, 0.7)
      ctx.strokeRect(-hw, -hd, 150, d); ctx.strokeRect(hw - 150, -hd, 150, d)  // 肘掛け
      line(ctx, -hw + 150, -hd + 180, hw - 150, -hd + 180)                     // 背もたれ
      break
    case 'kitchen':
      rect(); lw(ctx, zoom, 0.7)
      ctx.strokeRect(-hw + 150, -hd + 90, 700, d - 180)      // シンク
      for (const dx of [w * 0.28, w * 0.28 + 260]) {         // コンロ
        ctx.beginPath(); ctx.arc(-hw + dx + 500, 0, 105, 0, Math.PI * 2); ctx.stroke()
      }
      break
    case 'toilet':
      ctx.beginPath(); ctx.rect(-hw, -hd, w, 180); ctx.fill(); ctx.stroke()   // タンク
      ctx.beginPath(); ctx.ellipse(0, 120, w * 0.42, hd - 150, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      break
    case 'bathtub':
      rect(); lw(ctx, zoom, 0.7)
      ctx.beginPath()
      ctx.roundRect(-hw + 90, -hd + 90, w - 180, d - 180, 120)
      ctx.stroke()
      break
    case 'washbasin':
      rect(); lw(ctx, zoom, 0.7)
      ctx.beginPath(); ctx.ellipse(0, 40, w * 0.3, d * 0.28, 0, 0, Math.PI * 2); ctx.stroke()
      break
    case 'fridge': rect(); lw(ctx, zoom, 0.7); line(ctx, -hw, -hd, hw, hd); text(ctx, 'R', 0, 0, 200, -f.rot, THIN); break
    case 'washer':
      rect(); lw(ctx, zoom, 0.7)
      ctx.beginPath(); ctx.arc(0, 0, Math.min(hw, hd) - 90, 0, Math.PI * 2); ctx.stroke()
      break
    case 'closet':
      rect(); lw(ctx, zoom, 0.7); line(ctx, -hw, 0, hw, 0)
      // ハンガーパイプの破線
      ctx.setLineDash([80, 60]); line(ctx, -hw + 90, -hd / 2, hw - 90, -hd / 2); ctx.setLineDash([])
      break
  }
  ctx.restore()
}

// ---------------- カスタム部品(部品スタジオ製): 矩形/円 + ラベル ----------------
export function drawCustom(ctx: CanvasRenderingContext2D, e: import('./model').CustomE, zoom: number): void {
  ctx.save()
  ctx.translate(e.pos.x, e.pos.y); ctx.rotate(e.rot)
  ctx.strokeStyle = INK; ctx.fillStyle = e.color ?? '#ffffff'; lw(ctx, zoom, 1)
  ctx.beginPath()
  if (e.symbol === 'round') ctx.ellipse(0, 0, e.w / 2, e.d / 2, 0, 0, Math.PI * 2)
  else ctx.rect(-e.w / 2, -e.d / 2, e.w, e.d)
  ctx.fill(); ctx.stroke()
  ctx.restore()
  if (e.label) text(ctx, e.label, e.pos.x, e.pos.y, Math.min(240, e.d * 0.3))
}

// ---------------- 設備(電気・給排水は JIS C 0303 系の慣用記号) ----------------
export function drawEquipment(ctx: CanvasRenderingContext2D, e: Equipment, zoom: number): void {
  ctx.save()
  ctx.translate(e.pos.x, e.pos.y); ctx.rotate(e.rot)
  ctx.strokeStyle = INK; ctx.fillStyle = '#fff'; lw(ctx, zoom, 1)
  switch (e.kind) {
    case 'boiler':
      ctx.beginPath(); ctx.rect(-300, -150, 600, 300); ctx.fill(); ctx.stroke()
      text(ctx, '給湯', 0, 0, 170)
      break
    case 'heater':
      ctx.beginPath(); ctx.rect(-300, -150, 600, 300); ctx.fill(); ctx.stroke()
      text(ctx, 'EH', 0, 0, 170)
      break
    case 'ventfan': { // 換気扇: ○ + 羽根
      ctx.beginPath(); ctx.arc(0, 0, 150, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      lw(ctx, zoom, 0.8)
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3
        ctx.beginPath()
        ctx.moveTo(0, 0)
        ctx.quadraticCurveTo(Math.cos(a + 0.5) * 130, Math.sin(a + 0.5) * 130, Math.cos(a) * 145, Math.sin(a) * 145)
        ctx.stroke()
      }
      break
    }
    case 'alarm': // 住宅用火災警報器(煙式): ○ + S
      ctx.beginPath(); ctx.arc(0, 0, 130, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      text(ctx, 'S', 0, 0, 170)
      break
    case 'ac_indoor':
      ctx.beginPath(); ctx.rect(-400, -125, 800, 250); ctx.fill(); ctx.stroke()
      text(ctx, 'RC', 0, 0, 160)
      break
    case 'ac_outdoor':
      ctx.beginPath(); ctx.rect(-400, -160, 800, 320); ctx.fill(); ctx.stroke()
      lw(ctx, zoom, 0.8)
      ctx.beginPath(); ctx.arc(-160, 0, 120, 0, Math.PI * 2); ctx.stroke()
      text(ctx, 'OU', 200, 0, 150)
      break
    case 'panel': { // 分電盤: 矩形に斜線ハッチ
      ctx.beginPath(); ctx.rect(-250, -80, 500, 160); ctx.fill(); ctx.stroke()
      lw(ctx, zoom, 0.8)
      for (let x = -250; x < 250; x += 90) line(ctx, x, 80, Math.min(x + 160, 250), 80 - Math.min(160, 250 - x))
      break
    }
  }
  ctx.restore()
}

// ---------------- 植栽・人物 ----------------
export function drawPlanting(ctx: CanvasRenderingContext2D, p: Planting, zoom: number): void {
  ctx.save()
  ctx.translate(p.pos.x, p.pos.y)
  ctx.strokeStyle = INK; lw(ctx, zoom, 1)
  if (p.kind === 'tree') {
    const r = Math.max(400, p.height / 4)
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(0, 0, 25, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill()
    lw(ctx, zoom, 0.7)
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4
      line(ctx, Math.cos(a) * r * 0.35, Math.sin(a) * r * 0.35, Math.cos(a) * r, Math.sin(a) * r)
    }
  } else if (p.kind === 'shrub') {
    const r = Math.max(250, p.height / 3), n = 9
    ctx.beginPath()
    for (let i = 0; i < n; i++) {
      const a1 = (i / n) * Math.PI * 2, a2 = ((i + 1) / n) * Math.PI * 2
      const mx = Math.cos((a1 + a2) / 2) * r * 1.25, my = Math.sin((a1 + a2) / 2) * r * 1.25
      if (i === 0) ctx.moveTo(Math.cos(a1) * r, Math.sin(a1) * r)
      ctx.quadraticCurveTo(mx, my, Math.cos(a2) * r, Math.sin(a2) * r)
    }
    ctx.stroke()
  } else { // 人物(平面): 頭 + 肩
    ctx.beginPath(); ctx.ellipse(0, 0, 230, 110, 0, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.arc(0, 0, 95, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke()
  }
  ctx.restore()
}

// ---------------- 寸法(端部は建築慣用の斜線/黒丸) ----------------
export function drawDimension(ctx: CanvasRenderingContext2D, dm: DimensionE, zoom: number): void {
  const d = norm(sub(dm.b, dm.a)), n = perp(d)
  const off = dm.offset
  const a2 = { x: dm.a.x + n.x * off, y: dm.a.y + n.y * off }
  const b2 = { x: dm.b.x + n.x * off, y: dm.b.y + n.y * off }
  const ext = Math.sign(off) * 60
  ctx.strokeStyle = THIN; lw(ctx, zoom, 0.7)
  line(ctx, dm.a.x, dm.a.y, a2.x + n.x * ext, a2.y + n.y * ext)   // 引出線
  line(ctx, dm.b.x, dm.b.y, b2.x + n.x * ext, b2.y + n.y * ext)
  ctx.strokeStyle = INK; lw(ctx, zoom, 0.9)
  line(ctx, a2.x, a2.y, b2.x, b2.y)                               // 寸法線
  // 端末記号(45° 斜線)
  const t = 80
  for (const p of [a2, b2]) {
    line(ctx, p.x - (d.x - n.x) * t * 0.7, p.y - (d.y - n.y) * t * 0.7, p.x + (d.x - n.x) * t * 0.7, p.y + (d.y - n.y) * t * 0.7)
  }
  const mid = lerp(a2, b2, 0.5)
  let ang = Math.atan2(d.y, d.x)
  if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI
  // 寸法値は寸法線の上側に
  ctx.save()
  ctx.translate(mid.x, mid.y); ctx.rotate(ang)
  ctx.fillStyle = INK
  ctx.font = `220px -apple-system, "Hiragino Sans", sans-serif`
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillText(`${Math.round(dist(dm.a, dm.b))}`, 0, -40)
  ctx.restore()
}

// ---------------- 部屋・エリア ----------------
/** holes = この部屋に完全に内包される他の部屋のポリゴン(面積から差し引き、ラベルも避ける) */
export function drawRoom(ctx: CanvasRenderingContext2D, r: Room, zoom: number, holes: Pt[][] = []): void {
  if (r.poly.length < 3) return
  ctx.beginPath()
  r.poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
  // 単色 or 床マテリアルの色を薄く敷く
  const cHex = r.color ?? MATERIALS.find(m => m.id === r.material)?.color
  if (cHex) {
    const n = parseInt(cHex.slice(1), 16)
    ctx.fillStyle = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, 0.2)`
  } else {
    ctx.fillStyle = 'rgba(37, 99, 235, 0.035)'
  }
  ctx.fill()
  ctx.strokeStyle = THIN; lw(ctx, zoom, 0.7)
  ctx.setLineDash([160, 110]); ctx.stroke(); ctx.setLineDash([])
  // 吹き抜け: 製図記号のバッテン(対角線の点線)
  if (r.use === '吹き抜け') {
    const xs = r.poly.map(q => q.x), ys = r.poly.map(q => q.y)
    const x0 = Math.min(...xs), x1 = Math.max(...xs)
    const y0 = Math.min(...ys), y1 = Math.max(...ys)
    ctx.save()
    ctx.strokeStyle = THIN; lw(ctx, zoom, 0.8)
    ctx.setLineDash([200, 130])
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x1, y0); ctx.lineTo(x0, y1); ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }
  const c = labelAnchor(r.poly, holes)
  const areaM2 = netPolyArea(r.poly, holes) / 1e6
  text(ctx, r.name, c.x, c.y - (r.showArea ? 170 : 0), 280)
  if (r.showArea) {
    text(ctx, `${areaM2.toFixed(2)} m² (${(areaM2 / 1.62).toFixed(1)} 帖)`, c.x, c.y + 190, 210, 0, THIN)
  }
}

export function drawLabel(ctx: CanvasRenderingContext2D, l: LabelE): void {
  text(ctx, l.text, l.pos.x, l.pos.y, l.size)
}

// ---------------- スケッチ(鉛筆ツール) ----------------
/**
 * 閉路 = 面として薄く塗る(削除された面は塗らない)。押し出し高さがある面は
 * 少し濃く塗って h=**** を添記。辺は個別の色に対応。
 * sub: 選択中の面/閉路/辺のハイライト指定
 */
export function drawSketch(
  ctx: CanvasRenderingContext2D, s: SketchE, zoom: number,
  sub?: { mode: 'face' | 'loop' | 'edge'; faceIdx?: number; edgeIdx?: number } | null
): void {
  const faces = sketchFaces(s)
  const parents = faceNesting(faces)
  // 面の塗り(親 → 子の順で上塗り)
  const order = faces.map((_, i) => i).sort((a, b) => (parents[a] === -1 ? 0 : 1) - (parents[b] === -1 ? 0 : 1))
  for (const i of order) {
    const info = faceInfo(s, faces[i])
    if (info.dead) {
      // 削除された面(貫通穴)は白抜き + 細い×印
      ctx.fillStyle = '#ffffff'
      fillPoly(ctx, faces[i])
      continue
    }
    const h = info.h ?? 0
    ctx.fillStyle = h > 0 ? 'rgba(37, 99, 235, 0.10)' : 'rgba(37, 99, 235, 0.045)'
    fillPoly(ctx, faces[i])
    if (h > 0) {
      const c = polyCentroid(faces[i])
      text(ctx, `h=${h}`, c.x, c.y, 170, 0, THIN)
    }
  }
  // 選択中の面ハイライト
  if (sub && sub.mode === 'face' && sub.faceIdx !== undefined && faces[sub.faceIdx]) {
    ctx.fillStyle = 'rgba(37, 99, 235, 0.22)'
    fillPoly(ctx, faces[sub.faceIdx])
  }
  // 辺
  for (let i = 0; i < s.edges.length; i++) {
    const e = s.edges[i]
    ctx.strokeStyle = e.color ?? INK
    lw(ctx, zoom, 1.2)
    line(ctx, e.a.x, e.a.y, e.b.x, e.b.y)
  }
  // 選択ハイライト(閉路 = 面の境界の辺 / 単一の辺)
  if (sub && (sub.mode === 'loop' || sub.mode === 'edge')) {
    ctx.save()
    ctx.strokeStyle = '#2563eb'
    lw(ctx, zoom, 2.6)
    if (sub.mode === 'edge' && sub.edgeIdx !== undefined && s.edges[sub.edgeIdx]) {
      const e = s.edges[sub.edgeIdx]
      line(ctx, e.a.x, e.a.y, e.b.x, e.b.y)
    } else if (sub.mode === 'loop' && sub.faceIdx !== undefined && faces[sub.faceIdx]) {
      const f = faces[sub.faceIdx]
      ctx.beginPath()
      f.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath(); ctx.stroke()
    }
    ctx.restore()
  }
}
function fillPoly(ctx: CanvasRenderingContext2D, poly: Pt[]): void {
  ctx.beginPath()
  poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath(); ctx.fill()
}
