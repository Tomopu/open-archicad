// 入出力: 独自 JSON / DXF (AutoCAD互換) / OBJ (SketchUp・Blender互換)
import { Store, Entity, Wall, uid, FURN_DEFAULTS, EQUIP_LABEL } from './model'
import { Pt, pt, sub, norm, perp, lerp, polyCentroid } from './geometry'

// ---------------- ファイルユーティリティ ----------------
export function download(name: string, content: string | Blob, mime = 'application/octet-stream'): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.getElementById('file-input') as HTMLInputElement
    input.accept = accept
    input.value = ''
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.click()
  })
}

// ---------------- DXF 書き出し (AutoCAD R2000 / AC1015) ----------------
class DxfWriter {
  private lines: string[] = []
  g(code: number, value: string | number): void { this.lines.push(String(code), String(value)) }
  line(a: Pt, b: Pt, layer: string): void {
    this.g(0, 'LINE'); this.g(8, layer)
    this.g(10, a.x); this.g(20, -a.y); this.g(11, b.x); this.g(21, -b.y)
  }
  poly(pts: Pt[], closed: boolean, layer: string): void {
    this.g(0, 'LWPOLYLINE'); this.g(8, layer); this.g(90, pts.length); this.g(70, closed ? 1 : 0)
    for (const p of pts) { this.g(10, p.x); this.g(20, -p.y) }
  }
  circle(c: Pt, r: number, layer: string): void {
    this.g(0, 'CIRCLE'); this.g(8, layer); this.g(10, c.x); this.g(20, -c.y); this.g(40, r)
  }
  arc(c: Pt, r: number, a1: number, a2: number, layer: string): void {
    // 画面座標(y下向き)→ DXF(y上向き)で角度反転
    this.g(0, 'ARC'); this.g(8, layer); this.g(10, c.x); this.g(20, -c.y); this.g(40, r)
    this.g(50, ((-a2 * 180) / Math.PI + 360) % 360); this.g(51, ((-a1 * 180) / Math.PI + 360) % 360)
  }
  text(p: Pt, h: number, s: string, layer: string): void {
    this.g(0, 'TEXT'); this.g(8, layer); this.g(10, p.x); this.g(20, -p.y); this.g(40, h); this.g(1, s)
  }
  build(layers: string[]): string {
    const head: string[] = []
    const g = (c: number, v: string | number): void => { head.push(String(c), String(v)) }
    g(0, 'SECTION'); g(2, 'HEADER')
    g(9, '$ACADVER'); g(1, 'AC1015')
    g(9, '$INSUNITS'); g(70, 4) // ミリメートル
    g(0, 'ENDSEC')
    g(0, 'SECTION'); g(2, 'TABLES')
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length)
    for (const l of layers) {
      g(0, 'LAYER'); g(2, l); g(70, 0); g(62, 7); g(6, 'CONTINUOUS')
    }
    g(0, 'ENDTAB'); g(0, 'ENDSEC')
    g(0, 'SECTION'); g(2, 'ENTITIES')
    return [...head, ...this.lines, '0', 'ENDSEC', '0', 'EOF'].join('\r\n')
  }
}

export function exportDXF(store: Store): string {
  const d = new DxfWriter()
  const walls = new Map<string, Wall>()
  for (const e of store.doc.entities) if (e.type === 'wall') walls.set(e.id, e)

  for (const e of store.doc.entities) {
    switch (e.type) {
      case 'wall': {
        const dir = norm(sub(e.b, e.a)), n = perp(dir), h = e.thickness / 2
        d.poly([
          { x: e.a.x + n.x * h, y: e.a.y + n.y * h }, { x: e.b.x + n.x * h, y: e.b.y + n.y * h },
          { x: e.b.x - n.x * h, y: e.b.y - n.y * h }, { x: e.a.x - n.x * h, y: e.a.y - n.y * h }
        ], true, 'WALL')
        break
      }
      case 'opening': {
        const w = walls.get(e.wallId); if (!w) break
        const c = lerp(w.a, w.b, e.t)
        const dir = norm(sub(w.b, w.a)), n = perp(dir)
        const hw = e.width / 2, ht = w.thickness / 2
        const layer = e.kind.startsWith('win') ? 'WINDOW' : 'DOOR'
        // 方立 2 本
        for (const s of [-1, 1]) {
          d.line(
            { x: c.x + dir.x * hw * s + n.x * ht, y: c.y + dir.y * hw * s + n.y * ht },
            { x: c.x + dir.x * hw * s - n.x * ht, y: c.y + dir.y * hw * s - n.y * ht }, layer)
        }
        if (e.kind === 'door_single') {
          const hinge = { x: c.x - dir.x * hw, y: c.y - dir.y * hw }
          const ang = Math.atan2(dir.y, dir.x)
          d.line(hinge, { x: hinge.x - n.x * e.width, y: hinge.y - n.y * e.width }, layer)
          d.arc(hinge, e.width, ang - Math.PI / 2, ang, layer)
        } else {
          d.line(
            { x: c.x - dir.x * hw, y: c.y - dir.y * hw },
            { x: c.x + dir.x * hw, y: c.y + dir.y * hw }, layer)
        }
        break
      }
      case 'stair': {
        const cos = Math.cos(e.rot), sin = Math.sin(e.rot)
        const tr = (x: number, y: number): Pt => pt(e.pos.x + x * cos - y * sin, e.pos.y + x * sin + y * cos)
        if (e.kind === 'spiral') {
          d.circle(e.pos, e.width, 'STAIR'); d.circle(e.pos, 90, 'STAIR')
        } else {
          const L = e.treads * e.tread, W = e.width
          d.poly([tr(0, 0), tr(L, 0), tr(L, W), tr(0, W)], true, 'STAIR')
          for (let i = 1; i < e.treads; i++) d.line(tr(i * e.tread, 0), tr(i * e.tread, W), 'STAIR')
        }
        break
      }
      case 'furniture': {
        const cos = Math.cos(e.rot), sin = Math.sin(e.rot)
        const tr = (x: number, y: number): Pt => pt(e.pos.x + x * cos - y * sin, e.pos.y + x * sin + y * cos)
        d.poly([tr(-e.w / 2, -e.d / 2), tr(e.w / 2, -e.d / 2), tr(e.w / 2, e.d / 2), tr(-e.w / 2, e.d / 2)], true, 'FURNITURE')
        d.text(e.pos, 150, FURN_DEFAULTS[e.kind]?.label ?? e.kind, 'FURNITURE')
        break
      }
      case 'column': {
        if (e.shape === 'round') { d.circle(e.pos, e.w / 2, 'COLUMN'); break }
        const cos = Math.cos(e.rot), sin = Math.sin(e.rot)
        const tr = (x: number, y: number): Pt => pt(e.pos.x + x * cos - y * sin, e.pos.y + x * sin + y * cos)
        d.poly([tr(-e.w / 2, -e.d / 2), tr(e.w / 2, -e.d / 2), tr(e.w / 2, e.d / 2), tr(-e.w / 2, e.d / 2)], true, 'COLUMN')
        break
      }
      case 'custom': {
        const cos = Math.cos(e.rot), sin = Math.sin(e.rot)
        const tr = (x: number, y: number): Pt => pt(e.pos.x + x * cos - y * sin, e.pos.y + x * sin + y * cos)
        if (e.symbol === 'round') d.circle(e.pos, e.w / 2, 'FURNITURE')
        else d.poly([tr(-e.w / 2, -e.d / 2), tr(e.w / 2, -e.d / 2), tr(e.w / 2, e.d / 2), tr(-e.w / 2, e.d / 2)], true, 'FURNITURE')
        if (e.label) d.text(e.pos, 150, e.label, 'FURNITURE')
        break
      }
      case 'equipment':
        d.circle(e.pos, 150, 'EQUIPMENT')
        d.text({ x: e.pos.x + 200, y: e.pos.y }, 150, EQUIP_LABEL[e.kind] ?? e.kind, 'EQUIPMENT')
        break
      case 'planting':
        d.circle(e.pos, e.kind === 'tree' ? Math.max(400, e.height / 4) : 300, 'PLANTING')
        break
      case 'dimension': {
        const n = perp(norm(sub(e.b, e.a)))
        const a2 = { x: e.a.x + n.x * e.offset, y: e.a.y + n.y * e.offset }
        const b2 = { x: e.b.x + n.x * e.offset, y: e.b.y + n.y * e.offset }
        d.line(e.a, a2, 'DIM'); d.line(e.b, b2, 'DIM'); d.line(a2, b2, 'DIM')
        d.text(lerp(a2, b2, 0.5), 200, String(Math.round(Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y))), 'DIM')
        break
      }
      case 'label':
        d.text(e.pos, e.size, e.text, 'TEXT')
        break
      case 'room':
        d.poly(e.poly, true, 'ROOM')
        d.text(polyCentroid(e.poly), 280, e.name, 'ROOM')
        break
    }
  }
  return d.build(['WALL', 'COLUMN', 'DOOR', 'WINDOW', 'STAIR', 'FURNITURE', 'EQUIPMENT', 'PLANTING', 'DIM', 'TEXT', 'ROOM'])
}

// ---------------- DXF 読み込み(LINE / LWPOLYLINE / TEXT) ----------------
export function importDXF(content: string, store: Store): string {
  const rows = content.split(/\r?\n/)
  const ents: Entity[] = []
  let i = 0
  // ENTITIES セクションへ
  while (i < rows.length && !(rows[i].trim() === '2' || rows[i].trim() === 'ENTITIES')) i++
  const pairs: { code: number; val: string }[] = []
  for (let j = 0; j + 1 < rows.length; j += 2) {
    const code = parseInt(rows[j].trim(), 10)
    if (!Number.isNaN(code)) pairs.push({ code, val: rows[j + 1].trim() })
  }
  let k = 0
  const counts = { wall: 0, room: 0, label: 0 }
  while (k < pairs.length) {
    const p = pairs[k]
    if (p.code === 0 && p.val === 'LINE') {
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0
      k++
      while (k < pairs.length && pairs[k].code !== 0) {
        const q = pairs[k]
        if (q.code === 10) x1 = +q.val; else if (q.code === 20) y1 = -+q.val
        else if (q.code === 11) x2 = +q.val; else if (q.code === 21) y2 = -+q.val
        k++
      }
      if (Math.hypot(x2 - x1, y2 - y1) > 10) {
        ents.push({ id: uid(), type: 'wall', a: pt(x1, y1), b: pt(x2, y2), thickness: 120, height: 2400, structural: false })
        counts.wall++
      }
    } else if (p.code === 0 && p.val === 'LWPOLYLINE') {
      const poly: Pt[] = []
      let closed = false, x: number | null = null
      k++
      while (k < pairs.length && pairs[k].code !== 0) {
        const q = pairs[k]
        if (q.code === 70) closed = (+q.val & 1) === 1
        else if (q.code === 10) x = +q.val
        else if (q.code === 20 && x !== null) { poly.push(pt(x, -+q.val)); x = null }
        k++
      }
      if (closed && poly.length >= 3) {
        ents.push({ id: uid(), type: 'room', poly, name: '部屋', use: 'その他', showArea: true })
        counts.room++
      } else if (poly.length >= 2) {
        for (let m = 0; m < poly.length - 1; m++) {
          ents.push({ id: uid(), type: 'wall', a: poly[m], b: poly[m + 1], thickness: 120, height: 2400, structural: false })
          counts.wall++
        }
      }
    } else if (p.code === 0 && (p.val === 'TEXT' || p.val === 'MTEXT')) {
      let x = 0, y = 0, h = 300, s = ''
      k++
      while (k < pairs.length && pairs[k].code !== 0) {
        const q = pairs[k]
        if (q.code === 10) x = +q.val; else if (q.code === 20) y = -+q.val
        else if (q.code === 40) h = +q.val; else if (q.code === 1) s = q.val
        k++
      }
      if (s) { ents.push({ id: uid(), type: 'label', pos: pt(x, y), text: s, size: h }); counts.label++ }
    } else {
      k++
    }
  }
  if (!ents.length) throw new Error('読み込める要素(LINE / LWPOLYLINE / TEXT)が見つかりませんでした')
  store.commit()
  store.doc.entities.push(...ents)
  store.emit()
  return `壁 ${counts.wall} / 部屋 ${counts.room} / 文字 ${counts.label} を読み込みました`
}

// ---------------- コンポーネントライブラリ ----------------
export interface ComponentDef { name: string; entities: Entity[] }
const LS_KEY = 'oarc.components'

export function loadComponents(): ComponentDef[] {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') } catch { return [] }
}
export function saveComponents(list: ComponentDef[]): void {
  localStorage.setItem(LS_KEY, JSON.stringify(list))
}

/** 選択要素をコンポーネント化(基準点=境界中心、壁と建具の関係は保持) */
export function makeComponent(name: string, store: Store, ids: Set<string>): ComponentDef {
  const sel = store.doc.entities.filter(e => ids.has(e.id))
  // 選択中の壁に載る建具も含める
  const wallIds = new Set(sel.filter(e => e.type === 'wall').map(e => e.id))
  for (const e of store.doc.entities) {
    if (e.type === 'opening' && wallIds.has(e.wallId) && !ids.has(e.id)) sel.push(e)
  }
  const clones: Entity[] = JSON.parse(JSON.stringify(sel))
  // 基準点を原点へ
  const xs: number[] = [], ys: number[] = []
  const collect = (p: Pt): void => { xs.push(p.x); ys.push(p.y) }
  for (const c of clones) {
    if (c.type === 'wall' || c.type === 'dimension') { collect(c.a); collect(c.b) }
    else if (c.type === 'room') c.poly.forEach(collect)
    else if ('pos' in c) collect((c as { pos: Pt }).pos)
  }
  if (!xs.length) throw new Error('コンポーネント化できる要素がありません')
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const shift = (p: Pt): Pt => pt(p.x - cx, p.y - cy)
  for (const c of clones) {
    if (c.type === 'wall' || c.type === 'dimension') { c.a = shift(c.a); c.b = shift(c.b) }
    else if (c.type === 'room') c.poly = c.poly.map(shift)
    else if ('pos' in c) (c as { pos: Pt }).pos = shift((c as { pos: Pt }).pos)
  }
  return { name, entities: clones }
}
