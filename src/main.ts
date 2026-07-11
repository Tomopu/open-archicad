// Open ArchiCAD — エントリポイント(UI 統合)
import './style.css'
import {
  Store, newDoc, Entity, uid, OPENING_LABEL, STAIR_LABEL, FURN_DEFAULTS, EQUIP_LABEL, PLANT_LABEL,
  OpeningKind, StairKind, FurnKind, EquipKind, PlantKind, RoomUse, isWindow, MATERIALS, equipSize
} from './model'
import { Renderer2D } from './renderer2d'
import { ToolManager, ToolName, params, SNAP_KINDS } from './tools'
import * as geomApi from './geometry'
import { runLegalCheck } from './legal'
import {
  download, pickFile, exportDXF, importDXF,
  loadComponents, saveComponents, makeComponent, ComponentDef
} from './io'
import type { View3D } from './view3d'

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T

const store = new Store()
const canvas = $('#canvas2d') as HTMLCanvasElement
const renderer = new Renderer2D(canvas, store)
const tm = new ToolManager(store, renderer, canvas)

// ================= ツールパレット =================
const TOOL_DEFS: { name: ToolName; label: string; kbd: string; icon: string }[] = [
  { name: 'select', label: '選択', kbd: 'V', icon: '<path d="M6 3 L18 12 L12 13 L15 20 L12.5 21 L9.5 14 L6 17 Z"/>' },
  { name: 'pencil', label: '鉛筆', kbd: 'L', icon: '<path d="M4 20 l1-4 L16 5 a1.6 1.6 0 0 1 2.3 0 l0.7 0.7 a1.6 1.6 0 0 1 0 2.3 L8 19 z"/><path d="M14.5 6.5 l3 3"/>' },
  { name: 'wall', label: '壁', kbd: 'W', icon: '<path d="M3 10 h18 M3 14 h18"/>' },
  { name: 'column', label: '柱', kbd: 'C', icon: '<rect x="8" y="8" width="8" height="8" fill="currentColor"/>' },
  { name: 'door', label: 'ドア', kbd: 'D', icon: '<path d="M4 12 h3 M17 12 h3 M7 12 v-7 M7 5 a10 10 0 0 1 10 7"/>' },
  { name: 'window', label: '窓', kbd: 'N', icon: '<path d="M3 10 h18 M3 14 h18 M8 12 h8"/>' },
  { name: 'stair', label: '階段', kbd: 'S', icon: '<path d="M3 20 h5 v-4 h5 v-4 h5 v-4 h3"/>' },
  { name: 'furniture', label: '家具/設備', kbd: 'F', icon: '<rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M6 17 v3 M18 17 v3 M4 12 h16"/>' },
  { name: 'planting', label: '植栽/人', kbd: 'P', icon: '<circle cx="12" cy="10" r="6"/><path d="M12 16 v5"/>' },
  { name: 'dimension', label: '寸法', kbd: 'M', icon: '<path d="M4 8 v8 M20 8 v8 M4 12 h16 M6 10 l-2 2 2 2 M18 10 l2 2 -2 2"/>' },
  { name: 'label', label: '文字', kbd: 'T', icon: '<path d="M6 6 h12 M12 6 v13"/>' },
  { name: 'room', label: '部屋', kbd: 'A', icon: '<path d="M4 4 h16 v16 h-16 z" stroke-dasharray="3 2.4"/>' }
]

const palette = $('#tool-palette')
for (const t of TOOL_DEFS) {
  const b = document.createElement('button')
  b.innerHTML = `<svg viewBox="0 0 24 24">${t.icon}</svg>${t.label}<span class="kbd">${t.kbd}</span>`
  b.onclick = () => tm.setTool(t.name)
  b.dataset.tool = t.name
  palette.appendChild(b)
}
tm.onToolChange = t => {
  palette.querySelectorAll('button').forEach(b => b.classList.toggle('active',
    b.dataset.tool === t || (b.dataset.tool === 'furniture' && t === 'equipment'))) // 家具/設備は統合ボタン
  document.querySelectorAll('.comp-item').forEach(el => el.classList.toggle('active', t === 'component'))
  renderToolOptions()
}

// ================= フォーム部品 =================
function field(label: string, input: HTMLElement): HTMLElement {
  const div = document.createElement('div')
  div.className = 'field'
  const l = document.createElement('label')
  l.textContent = label
  div.append(l, input)
  return div
}
function numInput(value: number, onchange: (v: number) => void, step = 1, min?: number, max?: number): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'number'; i.value = String(Math.round(value * 100) / 100); i.step = String(step)
  if (min !== undefined) i.min = String(min)
  if (max !== undefined) i.max = String(max)
  i.onchange = () => {
    let v = parseFloat(i.value) || 0
    if (min !== undefined) v = Math.max(min, v)
    if (max !== undefined) v = Math.min(max, v)
    i.value = String(v)
    onchange(v)
  }
  return i
}
function textInput(value: string, onchange: (v: string) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'text'; i.value = value
  i.onchange = () => onchange(i.value)
  return i
}
function select<T extends string>(options: [T, string][], value: T, onchange: (v: T) => void): HTMLSelectElement {
  const s = document.createElement('select')
  for (const [v, label] of options) {
    const o = document.createElement('option')
    o.value = v; o.textContent = label
    s.appendChild(o)
  }
  s.value = value
  s.onchange = () => onchange(s.value as T)
  return s
}
function checkbox(label: string, value: boolean, onchange: (v: boolean) => void): HTMLElement {
  const i = document.createElement('input')
  i.type = 'checkbox'; i.checked = value
  i.onchange = () => onchange(i.checked)
  return field(label, i)
}
/**
 * 連動ロック付きの 2 段数値入力(Mac の寸法リンク風: 右にブラケット + 鎖トグル)。
 * ロック中は片方を変更するともう片方も同じ値になる。
 */
function linkedPair(
  label1: string, v1: number, label2: string, v2: number, locked: boolean,
  onChange: (a: number, b: number, locked: boolean) => void
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'linked-pair'
  const col = document.createElement('div')
  col.className = 'lp-fields'
  const i1 = numInput(v1, () => sync(1))
  const i2 = numInput(v2, () => sync(2))
  const sync = (src: 1 | 2): void => {
    let a = Math.max(0, parseFloat(i1.value) || 0)
    let b = Math.max(0, parseFloat(i2.value) || 0)
    if (isLocked) {
      if (src === 1) b = a; else a = b
      i1.value = String(a); i2.value = String(b)
    }
    onChange(a, b, isLocked)
  }
  col.append(field(label1, i1), field(label2, i2))
  let isLocked = locked
  const link = document.createElement('div')
  link.className = 'lp-link'
  const btn = document.createElement('button')
  btn.type = 'button'
  const paint = (): void => {
    btn.className = 'lp-btn' + (isLocked ? ' on' : '')
    btn.title = isLocked ? '連動中(クリックで解除)' : '連動なし(クリックでロック)'
    btn.dataset.tip = btn.title
    btn.innerHTML = isLocked
      ? '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12h6M8 8V7a4 4 0 0 1 8 0v1M8 16v1a4 4 0 0 0 8 0v-1"/></svg>'
      : '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 7V6a4 4 0 0 1 8 0v1M8 17v1a4 4 0 0 0 8 0v-1"/></svg>'
  }
  paint()
  btn.onclick = () => {
    isLocked = !isLocked
    paint()
    if (isLocked) { i2.value = i1.value; sync(1) }
    else onChange(parseFloat(i1.value) || 0, parseFloat(i2.value) || 0, isLocked)
  }
  link.append(el('div', 'lp-bracket top'), btn, el('div', 'lp-bracket bottom'))
  wrap.append(col, link)
  return wrap
}
function el(tag: string, cls: string): HTMLElement {
  const d = document.createElement(tag)
  d.className = cls
  return d
}

// ================= ツール設定パネル =================
const toolOptions = $('#tool-options')
function renderToolOptions(): void {
  toolOptions.innerHTML = ''
  const t = tm.tool
  if (t === 'wall') {
    // 厚さ = 基準線(通り芯)から右側 + 左側。鎖アイコンで左右連動
    toolOptions.append(
      field('厚さ mm', numInput(params.wall.thickness, v => {
        params.wall.thickness = v
        params.wall.offR = v / 2; params.wall.offL = v / 2
        renderToolOptions()
      })),
      linkedPair('基準線→右 mm', params.wall.offR, '基準線→左 mm', params.wall.offL, params.wall.lock,
        (r, l, locked) => {
          params.wall.offR = r; params.wall.offL = l; params.wall.lock = locked
          params.wall.thickness = r + l
        }),
      field('高さ mm', numInput(params.wall.height, v => { params.wall.height = v })),
      checkbox('構造壁(塗り)', params.wall.structural, v => { params.wall.structural = v }),
      checkbox('円弧壁(3点指定)', params.wall.arc, v => { params.wall.arc = v })
    )
  } else if (t === 'column') {
    toolOptions.append(
      field('形状', select([['rect', '角柱'], ['round', '丸柱']], params.column.shape, v => { params.column.shape = v })),
      field('幅 mm', numInput(params.column.w, v => { params.column.w = v })),
      field('奥行 mm', numInput(params.column.d, v => { params.column.d = v })),
      field('高さ mm', numInput(params.column.h, v => { params.column.h = v }))
    )
  } else if (t === 'door') {
    const kinds = (Object.entries(OPENING_LABEL) as [OpeningKind, string][]).filter(([k]) => !isWindow(k))
    toolOptions.append(
      field('種類', select(kinds, params.door.kind, v => { params.door.kind = v })),
      field('幅 mm', numInput(params.door.width, v => { params.door.width = v })),
      field('高さ mm', numInput(params.door.head, v => { params.door.head = v }))
    )
  } else if (t === 'window') {
    const kinds = (Object.entries(OPENING_LABEL) as [OpeningKind, string][]).filter(([k]) => isWindow(k))
    toolOptions.append(
      field('種類', select(kinds, params.window.kind, v => { params.window.kind = v })),
      field('幅 mm', numInput(params.window.width, v => { params.window.width = v })),
      field('窓台高 mm', numInput(params.window.sill, v => { params.window.sill = v })),
      field('上端高 mm', numInput(params.window.head, v => { params.window.head = v }))
    )
  } else if (t === 'stair') {
    toolOptions.append(
      field('形状', select(Object.entries(STAIR_LABEL) as [StairKind, string][], params.stair.kind, v => { params.stair.kind = v })),
      field('幅 mm', numInput(params.stair.width, v => { params.stair.width = v })),
      field('段数', numInput(params.stair.treads, v => { params.stair.treads = Math.max(2, Math.round(v)) })),
      field('踏面 mm', numInput(params.stair.tread, v => { params.stair.tread = v })),
      field('蹴上げ mm', numInput(params.stair.riser, v => { params.stair.riser = v }))
    )
  } else if (t === 'furniture' || t === 'equipment') {
    // 家具と設備は統合ツール: カテゴリで切替
    toolOptions.append(field('カテゴリ', select(
      [['furniture', '家具'], ['equipment', '設備']] as ['furniture' | 'equipment', string][],
      t, v => tm.setTool(v))))
    if (t === 'furniture') {
      const kinds = (Object.entries(FURN_DEFAULTS) as [FurnKind, { label: string }][]).map(([k, v]) => [k, v.label] as [FurnKind, string])
      toolOptions.append(field('種類', select(kinds, params.furniture.kind, v => { params.furniture.kind = v })))
    } else {
      toolOptions.append(field('種類', select(Object.entries(EQUIP_LABEL) as [EquipKind, string][], params.equipment.kind, v => { params.equipment.kind = v })))
    }
  } else if (t === 'planting') {
    const PLANT_H: Record<PlantKind, number> = { tree: 3000, shrub: 600, person: 1900 }
    toolOptions.append(
      field('種類', select(Object.entries(PLANT_LABEL) as [PlantKind, string][], params.planting.kind, v => {
        params.planting.kind = v
        params.planting.height = PLANT_H[v]  // 種類に応じた既定高さ(人物は 1900mm)
        renderToolOptions()
      })),
      field('高さ mm', numInput(params.planting.height, v => { params.planting.height = v }))
    )
  } else if (t === 'room') {
    toolOptions.append(
      field('入力モード', select([['rect', '長方形(2点)'], ['poly', '鉛筆(多角形)']], params.room.mode, v => { params.room.mode = v; tm.setTool('room') })),
      field('用途', select(ROOM_USES.map(u => [u, u]), params.room.use, v => { params.room.use = v }))
    )
  } else if (t === 'pencil') {
    toolOptions.append(
      field('入力モード', select([['poly', '鉛筆(線)'], ['rect', '長方形(2点)']], params.pencil.mode, v => { params.pencil.mode = v; tm.setTool('pencil') }))
    )
    const colorBtn = document.createElement('button')
    colorBtn.className = 'color-swatch-btn'
    const sq = document.createElement('span')
    sq.className = 'color-swatch'
    if (params.pencil.color) sq.style.background = params.pencil.color
    else sq.classList.add('none')
    const lbl = document.createElement('span')
    lbl.textContent = params.pencil.color ?? '既定(黒)'
    colorBtn.append(sq, lbl)
    colorBtn.onclick = () => openColorPop(colorBtn, params.pencil.color, c => { params.pencil.color = c; renderToolOptions() })
    toolOptions.append(field('辺の色', colorBtn))
  } else if (t === 'label') {
    toolOptions.append(field('文字高 mm', numInput(params.label.size, v => { params.label.size = v })))
  } else {
    toolOptions.innerHTML = '<div class="empty">このツールに設定はありません</div>'
  }
}
const ROOM_USES: RoomUse[] = ['居室', '寝室', 'キッチン', '浴室', '洗面所', 'トイレ', '廊下', '玄関', '収納', '階段室', '吹き抜け', 'その他']

// ================= プロパティパネル =================
const propsEl = $('#properties')
const MAT_OPTS: [string, string][] = [['', 'なし(既定)'], ...MATERIALS.map(m => [m.id, m.label] as [string, string])]
function materialField(e: { material?: string }, upd: (fn: () => void) => void): HTMLElement {
  return field('仕上げ', select(MAT_OPTS, e.material ?? '', v => upd(() => { e.material = v || undefined })))
}

// ================= カラーピッカー(スウォッチ・履歴・保存・HEX/RGB・スポイト) =================
const COLOR_PRESETS = [
  '#f5f5f4', '#d4d4d8', '#737373', '#1f2937', '#fecaca', '#dc2626', '#fed7aa', '#ea580c',
  '#fef08a', '#ca8a04', '#bbf7d0', '#16a34a', '#bae6fd', '#0284c7', '#c7d2fe', '#4f46e5',
  '#e9d5ff', '#9333ea', '#fbcfe8', '#db2777'
]
const loadJson = <T,>(key: string, def: T): T => {
  try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return def }
}
let colorHistory: string[] = loadJson('oarc.colorhist', [])
let colorSwatches: string[] = loadJson('oarc.swatches', [])
let colorPop: HTMLDivElement | null = null

function closeColorPop(): void {
  colorPop?.remove()
  colorPop = null
}
function openColorPop(anchor: HTMLElement, current: string | undefined, apply: (c: string | undefined) => void): void {
  closeColorPop()
  const pop = document.createElement('div')
  colorPop = pop
  pop.className = 'color-pop'
  let cur = current ?? '#f5f5f4'

  const pushHistory = (c: string): void => {
    colorHistory = [c, ...colorHistory.filter(x => x !== c)].slice(0, 10)
    localStorage.setItem('oarc.colorhist', JSON.stringify(colorHistory))
  }
  const commit = (c: string | undefined): void => {
    if (c) { cur = c; pushHistory(c) }
    apply(c)
    closeColorPop()
  }
  const swatchRow = (title: string, colors: string[], removable = false): HTMLElement => {
    const wrap = document.createElement('div')
    wrap.className = 'cp-section'
    wrap.innerHTML = `<div class="cp-title">${title}</div>`
    const grid = document.createElement('div')
    grid.className = 'cp-grid'
    for (const c of colors) {
      const b = document.createElement('button')
      b.className = 'cp-swatch'
      b.style.background = c
      b.title = c
      b.onclick = () => commit(c)
      if (removable) {
        b.oncontextmenu = ev => {
          ev.preventDefault()
          colorSwatches = colorSwatches.filter(x => x !== c)
          localStorage.setItem('oarc.swatches', JSON.stringify(colorSwatches))
          closeColorPop()
        }
        b.title = `${c}(右クリックで削除)`
      }
      grid.appendChild(b)
    }
    wrap.appendChild(grid)
    return wrap
  }

  pop.appendChild(swatchRow('プリセット', COLOR_PRESETS))
  if (colorHistory.length) pop.appendChild(swatchRow('履歴', colorHistory))
  const savedSec = swatchRow('保存した色', colorSwatches, true)
  const saveBtn = document.createElement('button')
  saveBtn.className = 'cp-mini'
  saveBtn.textContent = '＋現在の色を保存'
  saveBtn.onclick = () => {
    if (!colorSwatches.includes(cur)) {
      colorSwatches.push(cur)
      localStorage.setItem('oarc.swatches', JSON.stringify(colorSwatches))
    }
    closeColorPop()
    openColorPop(anchor, cur, apply)
  }
  savedSec.appendChild(saveBtn)
  pop.appendChild(savedSec)

  // HEX / RGB / ネイティブピッカー / スポイト
  const io = document.createElement('div')
  io.className = 'cp-section cp-io'
  const hex = document.createElement('input')
  hex.value = cur
  hex.placeholder = '#rrggbb'
  hex.style.width = '70px'
  const rgb: HTMLInputElement[] = [0, 1, 2].map(i => {
    const n = document.createElement('input')
    n.type = 'number'; n.min = '0'; n.max = '255'; n.style.width = '46px'
    const v = parseInt(cur.slice(1), 16)
    n.value = String((v >> (16 - i * 8)) & 255)
    return n
  })
  const syncFromHex = (): void => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.value.trim())
    if (!m) return
    const v = parseInt(m[1], 16)
    rgb.forEach((n, i) => { n.value = String((v >> (16 - i * 8)) & 255) })
  }
  const syncFromRgb = (): void => {
    const [r, g, b] = rgb.map(n => Math.max(0, Math.min(255, Math.round(parseFloat(n.value) || 0))))
    hex.value = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
  }
  hex.oninput = syncFromHex
  rgb.forEach(n => { n.oninput = syncFromRgb })
  const native = document.createElement('input')
  native.type = 'color'
  native.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#f5f5f4'
  native.title = 'カラーピッカー'
  native.oninput = () => { hex.value = native.value; syncFromHex() }
  const okBtn = document.createElement('button')
  okBtn.className = 'cp-mini cp-ok'
  okBtn.textContent = '適用'
  okBtn.onclick = () => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.value.trim())
    if (m) commit('#' + m[1].toLowerCase())
  }
  io.append(native, hex, ...rgb, okBtn)
  const eyeWin = window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }
  if (eyeWin.EyeDropper) {
    const eye = document.createElement('button')
    eye.className = 'cp-mini'
    eye.textContent = 'スポイト'
    eye.title = '画面上の色を拾う'
    eye.onclick = async () => {
      try {
        const r = await new eyeWin.EyeDropper!().open()
        commit(r.sRGBHex.toLowerCase())
      } catch { /* キャンセル */ }
    }
    io.appendChild(eye)
  }
  const clear = document.createElement('button')
  clear.className = 'cp-mini'
  clear.textContent = '色をクリア'
  clear.onclick = () => commit(undefined)
  io.appendChild(clear)
  pop.appendChild(io)

  document.body.appendChild(pop)
  const r = anchor.getBoundingClientRect()
  pop.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8)}px`
  pop.style.left = `${Math.max(8, r.right - pop.offsetWidth)}px`
  setTimeout(() => {
    const onDoc = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node)) { closeColorPop(); document.removeEventListener('pointerdown', onDoc) }
    }
    document.addEventListener('pointerdown', onDoc)
  })
}

/** PowerPoint 風: 現在色の小さな正方形スウォッチ付きの「色」フィールド */
function colorField(e: { color?: string }, upd: (fn: () => void) => void): HTMLElement {
  const btn = document.createElement('button')
  btn.className = 'color-swatch-btn'
  const sq = document.createElement('span')
  sq.className = 'color-swatch'
  if (e.color) sq.style.background = e.color
  else sq.classList.add('none')
  const lbl = document.createElement('span')
  lbl.textContent = e.color ?? 'なし'
  btn.append(sq, lbl)
  btn.onclick = () => openColorPop(btn, e.color, c => upd(() => { e.color = c }))
  return field('色', btn)
}
function renderProperties(): void {
  propsEl.innerHTML = ''
  const ids = [...renderer.selection]
  if (!ids.length) { propsEl.innerHTML = '<div class="empty">要素を選択してください</div>'; return }
  if (ids.length > 1) {
    propsEl.innerHTML = `<div class="empty">${ids.length} 個の要素を選択中</div>`
    // 壁を複数選択中なら厚さを一括変更できるようにする
    const walls = ids.map(id => store.byId(id)).filter(e => e?.type === 'wall')
    if (walls.length) {
      propsEl.append(field(`壁の厚さ mm (${walls.length}件)`, numInput((walls[0] as { thickness: number }).thickness, v => {
        store.commit()
        for (const w of walls) (w as { thickness: number }).thickness = v
        store.emit()
      })))
    }
    addDeleteButton()
    return
  }
  const e = store.byId(ids[0])
  if (!e) return
  const upd = (fn: () => void): void => { store.commit(); fn(); store.emit(); renderProperties() }

  const title = document.createElement('div')
  title.style.fontWeight = '600'
  propsEl.appendChild(title)

  switch (e.type) {
    case 'wall': {
      title.textContent = '壁'
      // 基準線(通り芯)からの右/左寸法。編集しても基準線は動かさず、壁本体をオフセット
      const refOff = e.refOff ?? 0
      const offR = e.thickness / 2 - refOff
      const offL = e.thickness / 2 + refOff
      const applyRL = (r: number, l: number): void => upd(() => {
        const d = { x: e.b.x - e.a.x, y: e.b.y - e.a.y }
        const len = Math.hypot(d.x, d.y) || 1
        const n = { x: -d.y / len, y: d.x / len }
        const newRefOff = (l - r) / 2
        const shift = refOff - newRefOff
        e.a = { x: e.a.x + n.x * shift, y: e.a.y + n.y * shift }
        e.b = { x: e.b.x + n.x * shift, y: e.b.y + n.y * shift }
        e.thickness = Math.max(10, r + l)
        e.refOff = newRefOff === 0 ? undefined : newRefOff
      })
      propsEl.append(
        field('厚さ mm', numInput(e.thickness, v => upd(() => {
          // 厚さ変更は基準線からの比率を保って両側へ配分
          const ratio = e.thickness > 0 ? v / e.thickness : 1
          e.thickness = Math.max(10, v)
          if (e.refOff) e.refOff *= ratio
        }))),
        linkedPair('基準線→右 mm', Math.round(offR), '基準線→左 mm', Math.round(offL), Math.abs(offR - offL) < 0.5,
          (r, l) => applyRL(r, l)),
        field('高さ mm', numInput(e.height, v => upd(() => { e.height = v }))),
        checkbox('構造壁', e.structural, v => upd(() => { e.structural = v })),
        field('長さ mm', textInput(String(Math.round(Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y))), () => {})),
        materialField(e, upd),
        colorField(e, upd)
      )
      break
    }
    case 'opening': {
      title.textContent = OPENING_LABEL[e.kind]
      const kinds = (Object.entries(OPENING_LABEL) as [OpeningKind, string][])
        .filter(([k]) => isWindow(k) === isWindow(e.kind))
      propsEl.append(
        field('種類', select(kinds, e.kind, v => upd(() => { e.kind = v }))),
        field('幅 mm', numInput(e.width, v => upd(() => { e.width = v }))),
        field('上端高 mm', numInput(e.head, v => upd(() => { e.head = v })))
      )
      if (isWindow(e.kind)) propsEl.append(field('窓台高 mm', numInput(e.sill, v => upd(() => { e.sill = v }))))
      propsEl.append(
        checkbox('内外反転 (F)', e.flip, v => upd(() => { e.flip = v })),
        checkbox('吊元反転 (G)', e.swap, v => upd(() => { e.swap = v }))
      )
      break
    }
    case 'stair':
      title.textContent = STAIR_LABEL[e.kind]
      propsEl.append(
        field('形状', select(Object.entries(STAIR_LABEL) as [StairKind, string][], e.kind, v => upd(() => { e.kind = v }))),
        field('幅 mm', numInput(e.width, v => upd(() => { e.width = v }))),
        field('段数', numInput(e.treads, v => upd(() => { e.treads = Math.max(2, Math.round(v)) }))),
        field('踏面 mm', numInput(e.tread, v => upd(() => { e.tread = v }))),
        field('蹴上げ mm', numInput(e.riser, v => upd(() => { e.riser = v }))),
        materialField(e, upd),
        colorField(e, upd)
      )
      break
    case 'furniture':
      title.textContent = FURN_DEFAULTS[e.kind]?.label ?? '家具'
      propsEl.append(
        field('幅 mm', numInput(e.w, v => upd(() => { e.w = v }))),
        field('奥行 mm', numInput(e.d, v => upd(() => { e.d = v }))),
        field('高さ mm', numInput(e.h, v => upd(() => { e.h = v }))),
        materialField(e, upd),
        colorField(e, upd)
      )
      break
    case 'equipment': {
      title.textContent = EQUIP_LABEL[e.kind]
      const s = equipSize(e)
      propsEl.append(
        field('種類', select(Object.entries(EQUIP_LABEL) as [EquipKind, string][], e.kind, v => upd(() => { e.kind = v; e.w = undefined; e.d = undefined }))),
        field('幅 mm', numInput(s.w, v => upd(() => { e.w = Math.max(100, v) }))),
        field('奥行 mm', numInput(s.d, v => upd(() => { e.d = Math.max(80, v) })))
      )
      break
    }
    case 'column':
      title.textContent = e.shape === 'round' ? '丸柱' : '角柱'
      propsEl.append(
        field('形状', select([['rect', '角柱'], ['round', '丸柱']], e.shape, v => upd(() => { e.shape = v }))),
        field('幅 mm', numInput(e.w, v => upd(() => { e.w = v }))),
        field('奥行 mm', numInput(e.d, v => upd(() => { e.d = v }))),
        field('高さ mm', numInput(e.h, v => upd(() => { e.h = v }))),
        materialField(e, upd),
        colorField(e, upd)
      )
      break
    case 'planting':
      title.textContent = PLANT_LABEL[e.kind]
      propsEl.append(
        field('種類', select(Object.entries(PLANT_LABEL) as [PlantKind, string][], e.kind, v => upd(() => { e.kind = v }))),
        field('高さ mm', numInput(e.height, v => upd(() => { e.height = v })))
      )
      break
    case 'label':
      title.textContent = '文字'
      propsEl.append(
        field('内容', textInput(e.text, v => upd(() => { e.text = v }))),
        field('文字高 mm', numInput(e.size, v => upd(() => { e.size = v })))
      )
      break
    case 'room':
      title.textContent = '部屋・エリア'
      propsEl.append(
        field('名前', textInput(e.name, v => upd(() => { e.name = v }))),
        field('用途', select(ROOM_USES.map(u => [u, u]), e.use, v => upd(() => { e.use = v }))),
        checkbox('面積を表示', e.showArea, v => upd(() => { e.showArea = v })),
        materialField(e, upd),
        colorField(e, upd)
      )
      break
    case 'dimension':
      title.textContent = '寸法'
      propsEl.append(field('オフセット', numInput(e.offset, v => upd(() => { e.offset = v }))))
      break
    case 'sketch': {
      const sub = tm.sketchSub?.id === e.id ? tm.sketchSub : null
      title.textContent = sub?.mode === 'edge' ? 'スケッチ: 辺'
        : sub?.mode === 'face' ? 'スケッチ: 面'
        : sub?.mode === 'loop' ? 'スケッチ: 閉路'
        : `スケッチ(辺 ${e.edges.length} 本)`
      if (sub?.mode === 'edge' && sub.edgeIdx !== undefined && e.edges[sub.edgeIdx]) {
        // 選択中の辺の色
        const ed = e.edges[sub.edgeIdx]
        propsEl.append(colorField(ed, upd))
      } else if ((sub?.mode === 'face' || sub?.mode === 'loop') && sub.faceIdx !== undefined) {
        // 選択中の面: 押し出し高さ + 削除
        const { sketchFaces, faceInfo } = geomApi
        const faces = sketchFaces(e)
        const f = faces[sub.faceIdx]
        if (f) {
          const info = faceInfo(e, f)
          propsEl.append(field('押し出し高さ mm', numInput(info.h ?? 0, v => upd(() => {
            tm.setFaceHeight(e.id, f, Math.max(0, v))
          }), 50, 0)))
          const eraseBtn = document.createElement('button')
          eraseBtn.textContent = 'この面を削除(貫通穴)'
          eraseBtn.className = 'danger'
          eraseBtn.onclick = () => { tm.eraseSelectedFace(); renderProperties() }
          propsEl.append(eraseBtn)
        }
      } else {
        // 全体: 全ての辺の色を一括変更
        const proxy = { color: e.edges[0]?.color }
        propsEl.append(field('辺の色(一括)', (() => {
          const btn = document.createElement('button')
          btn.className = 'color-swatch-btn'
          const sq = document.createElement('span')
          sq.className = 'color-swatch'
          if (proxy.color) sq.style.background = proxy.color
          else sq.classList.add('none')
          const lbl = document.createElement('span')
          lbl.textContent = proxy.color ?? 'なし'
          btn.append(sq, lbl)
          btn.onclick = () => openColorPop(btn, proxy.color, c => upd(() => {
            for (const ed of e.edges) ed.color = c
          }))
          return btn
        })()))
        const hint = document.createElement('div')
        hint.className = 'empty'
        hint.textContent = '再クリックで 面 → 閉路 → 辺 と選択を絞り込めます'
        propsEl.append(hint)
      }
      break
    }
    case 'custom':
      title.textContent = `部品: ${e.label || '(無題)'}`
      propsEl.append(
        field('ラベル', textInput(e.label, v => upd(() => { e.label = v }))),
        field('記号', select([['rect', '矩形'], ['round', '円']], e.symbol, v => upd(() => { e.symbol = v }))),
        field('幅 mm', numInput(e.w, v => upd(() => { e.w = Math.max(50, v) }))),
        field('奥行 mm', numInput(e.d, v => upd(() => { e.d = Math.max(50, v) }))),
        field('高さ mm', numInput(e.h, v => upd(() => { e.h = Math.max(50, v) }))),
        colorField(e, upd)
      )
      break
  }
  addDeleteButton()
}
function addDeleteButton(): void {
  const row = document.createElement('div')
  row.className = 'btn-row'
  const del = document.createElement('button')
  del.textContent = '削除 (Del)'
  del.className = 'danger'
  del.onclick = () => {
    store.commit(); store.remove(renderer.selection)
    renderer.selection.clear(); renderProperties(); renderer.requestDraw()
  }
  const dup = document.createElement('button')
  dup.textContent = '複製'
  dup.onclick = () => beginDup()
  row.append(dup, del)
  propsEl.appendChild(row)
}
/** 基準点複写: 基準点をクリック → その点を掴んだ状態でガイド付き配置 */
function beginDup(): void {
  if (!renderer.selection.size) return
  tm.beginDuplicate()
  setMsg('コピーの基準点をクリック → 配置先をクリック(距離・延長・対角ガイド付き)')
}
tm.onDupBase = base => {
  const def = makeComponent('_tmp', store, renderer.selection, base)
  tm.placeComponent(def)
}
tm.onSelectionChange = () => { renderProperties(); renderObjectList() }
// 部屋・文字のダブルクリックで名前(内容)を直接編集
tm.onRename = ent => {
  if (ent.type === 'room') {
    const v = prompt('部屋の名前', ent.name)
    if (v) { store.commit(); ent.name = v; store.emit(); renderProperties() }
  } else if (ent.type === 'label') {
    const v = prompt('テキスト', ent.text)
    if (v) { store.commit(); ent.text = v; store.emit(); renderProperties() }
  }
}

// ================= プロジェクト設定 =================
function renderProjectSettings(): void {
  const el = $('#project-settings')
  el.innerHTML = ''
  const m = store.doc.meta
  el.append(
    field('名称', textInput(m.title, v => { m.title = v })),
    field('敷地面積 m²', numInput(m.siteArea, v => { m.siteArea = v }, 1, 0)),
    field('建蔽率 %', numInput(m.bcrLimit, v => { m.bcrLimit = v }, 1, 0, 100)),
    field('容積率 %', numInput(m.farLimit, v => { m.farLimit = v }, 1, 0, 2000))
  )
  // 各階の階高(床から次の床まで)。0 = 自動(最大壁高 + スラブ厚)
  for (const l of store.doc.levels) {
    const inp = numInput(l.height ?? 0, v => {
      store.commit()
      l.height = v > 0 ? v : undefined
      store.emit()
    }, 50, 0)
    inp.placeholder = '自動'
    el.append(field(`${l.name} 階高 mm`, inp))
  }
  // 階数は階タブ(1F/2F/…)で管理するため入力欄は持たない
}

// ================= 階(フロア)タブ =================
let floorSig = ''
function renderFloors(): void {
  const sig = store.doc.levels.map(l => l.id + l.name).join('|') + '@' + store.active
  if (sig === floorSig) return
  floorSig = sig
  renderProjectSettings() // 階の増減に合わせて階高入力欄も更新
  const tabs = $('#floor-tabs')
  tabs.innerHTML = ''
  store.doc.levels.forEach((l, i) => {
    const b = document.createElement('button')
    b.textContent = l.name
    b.classList.toggle('active', i === store.active)
    b.onclick = () => {
      store.setLevel(i)
      renderer.selection.clear()
      tm.onSelectionChange()
    }
    b.ondblclick = () => {
      const name = prompt('階の名前', l.name)
      if (name) store.renameLevel(i, name)
    }
    b.oncontextmenu = ev => {
      ev.preventDefault()
      if (store.doc.levels.length <= 1) return
      if (confirm(`「${l.name}」を削除しますか?(この階の図面は失われます。⌘Z で戻せます)`)) {
        store.removeLevel(i)
        renderer.selection.clear()
        tm.onSelectionChange()
      }
    }
    tabs.appendChild(b)
  })
  // 下階関連の操作は 2 階以上でだけ意味を持つ
  const upper = store.active > 0
  ;($('#copy-below') as HTMLButtonElement).style.display = upper ? '' : 'none'
  ;($('#ghost-toggle-wrap')).style.display = store.doc.levels.length > 1 ? '' : 'none'
}
$('#floor-add').onclick = () => {
  store.addLevel()
  renderer.selection.clear()
  tm.onSelectionChange()
  setMsg(`${store.doc.levels[store.active].name} を追加しました(下階が透けて表示されます)`)
}
;($('#ghost-toggle') as HTMLInputElement).onchange = e => {
  renderer.showGhost = (e.target as HTMLInputElement).checked
  renderer.requestDraw()
}
$('#copy-below').onclick = () => {
  const n = store.copyWallsFromBelow()
  setMsg(n ? `下階から壁・柱を ${n} 件複製しました` : '下階に壁・柱がありません')
}
store.onChange(() => renderFloors())

// ================= 縮尺バー(地図スタイル) =================
function updateScaleBar(): void {
  const zoom = renderer.vp.zoom
  // バーの長さが 60〜160px に収まるキリのよい距離を選ぶ
  const candidatesM = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]
  let best = candidatesM[0]
  for (const c of candidatesM) {
    if (c * 1000 * zoom <= 160) best = c
  }
  const px = best * 1000 * zoom
  const segs = $('#scale-bar .segs')
  segs.innerHTML = ''
  segs.style.width = `${Math.max(24, px)}px`
  for (let i = 0; i < 4; i++) {
    const s = document.createElement('span')
    s.style.width = '25%'
    segs.appendChild(s)
  }
  const label = best >= 1 ? `${best} m` : `${best * 1000} mm`
  const g = renderer.gridStep
  $('#scale-bar .label').textContent = `${label} ・ 1グリッド = ${g}mm (${(g / 1000).toFixed(2)}m)`
}

// ================= グリッド幅の設定 =================
function applyGridStep(step: number): void {
  step = Math.max(10, Math.round(step))
  renderer.gridStep = step
  ;($('#st-gridstep') as HTMLInputElement).value = String(step)
  // スナップ候補もグリッドに追従(既定 = 半グリッド)
  const snapSel = $('#st-snap') as HTMLSelectElement
  const prev = tm.snapStep
  snapSel.innerHTML = ''
  const opts: [number, string][] = [
    [step / 2, `${step / 2} (半グリッド)`],
    [step, `${step} (1グリッド)`],
    [100, '100'], [10, '10'], [0, 'なし']
  ]
  for (const [v, l] of opts) {
    const o = document.createElement('option')
    o.value = String(v); o.textContent = l
    snapSel.appendChild(o)
  }
  const keep = opts.some(([v]) => v === prev) ? prev : step / 2
  snapSel.value = String(keep)
  tm.snapStep = keep
  localStorage.setItem('oarc.gridstep', String(step))
  updateScaleBar()
  renderer.requestDraw()
}
;($('#st-gridstep') as HTMLInputElement).onchange = e => {
  applyGridStep(parseFloat((e.target as HTMLInputElement).value) || 910)
}

// ================= 選択オブジェクトのアクションアイコン =================
const objActions = $('#obj-actions')
objActions.querySelector('[data-act="rotate"]')!.addEventListener('click', () => {
  const ids = [...renderer.selection]
  const single = ids.length === 1 ? store.byId(ids[0]) : undefined
  if (!$('#view3d').hidden && view3d && single && 'rot' in single) {
    // 3D: XYZ 回転リングをトグル(リングをドラッグで自由回転、45°ごとに吸着)
    view3d.rotateMode = !view3d.rotateMode
    view3d.highlightSelection()
    setMsg(view3d.rotateMode ? 'リングをドラッグして回転(緑=水平 / 赤=X傾き / 青=Z傾き)。もう一度 ⟳ で終了' : '')
  } else {
    // 壁・部屋など rot を持たない要素は 90° 回転
    tm.rotateSelection()
    if (!$('#view3d').hidden && view3d) view3d.rebuild(store)
  }
})
objActions.querySelector('[data-act="dup"]')!.addEventListener('click', () => beginDup())
// 消しゴム: スケッチの面を選択しているときだけ表示
const eraseBtn = objActions.querySelector('[data-act="erase"]') as HTMLButtonElement
eraseBtn.addEventListener('click', () => {
  tm.eraseSelectedFace()
  renderProperties()
  setMsg('面を削除しました(内側の面なら貫通穴になります)')
})
tm.onSketchSub = sub => {
  eraseBtn.hidden = !(sub && (sub.mode === 'face' || sub.mode === 'loop') && sub.faceIdx !== undefined)
  renderProperties()
}
// ホバーで名前が見えるツールチップ(title より速く・確実に表示)
objActions.querySelectorAll('button').forEach(b => { b.dataset.tip = b.title })
objActions.querySelector('[data-act="del"]')!.addEventListener('click', () => {
  store.commit(); store.remove(renderer.selection)
  renderer.selection.clear(); renderProperties(); renderer.requestDraw()
})
// グループ化 / 解除(複数選択時に表示。オブジェクト一覧からも使う)
function toggleGroup(): void {
  const ents = [...renderer.selection].map(id => store.byId(id)).filter((e): e is Entity => !!e)
  if (ents.length < 2 && !ents.some(e => e.group)) return
  store.commit()
  const allSameGroup = ents.length > 0 && ents[0].group && ents.every(e => e.group === ents[0].group)
  if (allSameGroup) {
    for (const e of ents) delete e.group
    setMsg('グループを解除しました')
  } else {
    const g = uid()
    for (const e of ents) e.group = g
    setMsg(`${ents.length} 個の要素をグループ化しました(クリックでまとめて選択されます)`)
  }
  store.emit()
}
const groupBtn = objActions.querySelector('[data-act="group"]') as HTMLButtonElement
groupBtn.addEventListener('click', toggleGroup)

// ================= オブジェクト一覧(表示 / 非表示・グループ化) =================
const objListEl = $('#object-list')
const objListGroupBtn = $('#objlist-group') as HTMLButtonElement
objListGroupBtn.onclick = toggleGroup
function entLabel(e: Entity): string {
  if (e.dispName) return e.dispName
  switch (e.type) {
    case 'wall': return `壁 (${Math.round(Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y))}mm)`
    case 'opening': return OPENING_LABEL[e.kind]
    case 'stair': return STAIR_LABEL[e.kind]
    case 'furniture': return FURN_DEFAULTS[e.kind]?.label ?? '家具'
    case 'equipment': return EQUIP_LABEL[e.kind]
    case 'column': return e.shape === 'round' ? '丸柱' : '角柱'
    case 'planting': return PLANT_LABEL[e.kind]
    case 'dimension': return '寸法'
    case 'label': return `文字「${e.text.slice(0, 8)}」`
    case 'room': return `部屋: ${e.name}`
    case 'custom': return `部品: ${e.label || '(無題)'}`
    case 'sketch': return `スケッチ(${e.edges.length}辺)`
  }
}
const EYE_ON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'
const EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 3l18 18M10.5 5.2A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.1 8.1 2.5 10.5 2 12c1 2.5 5 7 10 7 1.6 0 3.1-.5 4.4-1.2"/></svg>'
/** 折りたたみ中のグループ id */
const collapsedGroups = new Set<string>()
/** Shift+クリックの範囲選択の起点(表示順のインデックス) */
let objAnchor = -1
let objListSig = ''

function mkEye(hidden: boolean, onToggle: () => void): HTMLButtonElement {
  const eye = document.createElement('button')
  eye.className = 'obj-eye' + (hidden ? ' off' : '')
  eye.title = hidden ? '表示する' : '非表示にする'
  eye.innerHTML = hidden ? EYE_OFF : EYE_ON
  eye.onclick = ev => { ev.stopPropagation(); onToggle() }
  return eye
}
function selectAndSync(): void {
  tm.onSelectionChange()
  renderer.requestDraw()
  if (!$('#view3d').hidden) view3d?.highlightSelection()
}
function renameEntity(e: Entity): void {
  const cur = entLabel(e)
  const v = prompt('名前を変更', cur)
  if (!v || v === cur) return
  store.commit()
  if (e.type === 'room') e.name = v
  else if (e.type === 'label') e.text = v
  else if (e.type === 'custom') e.label = v
  else e.dispName = v
  store.emit()
}

function renderObjectList(): void {
  const ents = store.doc.entities
  const gNames = store.doc.meta.groupNames ?? {}
  const sig = ents.map(e => `${e.id}${e.hidden ? 'h' : ''}${e.group ?? ''}${renderer.selection.has(e.id) ? 's' : ''}${entLabel(e)}`).join('|')
    + '|' + [...collapsedGroups].join(',') + '|' + JSON.stringify(gNames)
  if (sig === objListSig) return
  objListSig = sig
  objListEl.innerHTML = ''
  objListGroupBtn.hidden = renderer.selection.size < 2
  if (!ents.length) {
    objListEl.innerHTML = '<div class="empty">要素がありません</div>'
    return
  }
  // 表示順のフラットな要素リスト(Shift 範囲選択用)
  const flat: Entity[] = []
  const rowOf = (e: Entity, indent: boolean): HTMLElement => {
    const idx = flat.length
    flat.push(e)
    const row = document.createElement('div')
    row.className = 'comp-item obj-row' + (renderer.selection.has(e.id) ? ' active' : '') + (indent ? ' obj-child' : '')
    row.appendChild(mkEye(!!e.hidden, () => {
      store.commit()
      e.hidden = !e.hidden || undefined
      if (e.hidden) renderer.selection.delete(e.id)
      store.emit()
      selectAndSync()
    }))
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = entLabel(e)
    if (e.hidden) name.style.opacity = '0.45'
    row.appendChild(name)
    row.onclick = ev => {
      if (ev.shiftKey && objAnchor >= 0) {
        // 範囲選択: 起点から今回クリックした行までを全て選択
        const [a, b] = [Math.min(objAnchor, idx), Math.max(objAnchor, idx)]
        renderer.selection.clear()
        for (let i = a; i <= b; i++) renderer.selection.add(flat[i].id)
      } else {
        renderer.selection.clear()
        renderer.selection.add(e.id)
        store.expandGroups(renderer.selection)
        objAnchor = idx
      }
      selectAndSync()
    }
    row.ondblclick = () => renameEntity(e)
    return row
  }
  // グループ → ブロック化(初出のグループ位置に、ヘッダ + インデントした子)
  const emitted = new Set<string>()
  for (const e of ents) {
    if (!e.group) { objListEl.appendChild(rowOf(e, false)); continue }
    if (emitted.has(e.group)) continue
    emitted.add(e.group)
    const gid = e.group
    const members = ents.filter(m => m.group === gid)
    const collapsed = collapsedGroups.has(gid)
    const allHidden = members.every(m => m.hidden)
    const head = document.createElement('div')
    head.className = 'comp-item obj-row obj-group' + (members.every(m => renderer.selection.has(m.id)) ? ' active' : '')
    // 折りたたみ
    const chev = document.createElement('button')
    chev.className = 'obj-chev'
    chev.textContent = collapsed ? '▸' : '▾'
    chev.title = collapsed ? '展開' : '折りたたむ'
    chev.onclick = ev => {
      ev.stopPropagation()
      if (collapsed) collapsedGroups.delete(gid); else collapsedGroups.add(gid)
      objListSig = ''
      renderObjectList()
    }
    // グループ一括の表示 / 非表示
    head.append(chev, mkEye(allHidden, () => {
      store.commit()
      const to = !allHidden
      for (const m of members) {
        m.hidden = to || undefined
        if (to) renderer.selection.delete(m.id)
      }
      store.emit()
      selectAndSync()
    }))
    const gname = document.createElement('span')
    gname.className = 'name'
    gname.textContent = `${gNames[gid] ?? 'グループ'} (${members.length})`
    head.appendChild(gname)
    // グループ解除
    const un = document.createElement('button')
    un.className = 'obj-ungroup'
    un.title = 'グループ解除'
    un.dataset.tip = 'グループ解除'
    un.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M4 20 20 4" stroke-dasharray="2.5 2"/></svg>'
    un.onclick = ev => {
      ev.stopPropagation()
      store.commit()
      for (const m of members) delete m.group
      store.emit()
      selectAndSync()
    }
    head.appendChild(un)
    head.onclick = () => {
      renderer.selection.clear()
      for (const m of members) renderer.selection.add(m.id)
      selectAndSync()
    }
    head.ondblclick = () => {
      const v = prompt('グループ名', gNames[gid] ?? 'グループ')
      if (!v) return
      store.commit()
      store.doc.meta.groupNames = { ...gNames, [gid]: v }
      store.emit()
    }
    objListEl.appendChild(head)
    if (!collapsed) for (const m of members) objListEl.appendChild(rowOf(m, true))
  }
}
store.onChange(() => renderObjectList())
function updateObjActions(): void {
  const ids = [...renderer.selection]
  if (!ids.length || renderer.elevation) { objActions.hidden = true; return }
  // 消しゴムはスケッチの面を選択中のみ(選択が変わったら隠す)
  const sub = tm.sketchSub
  eraseBtn.hidden = !(sub && (sub.mode === 'face' || sub.mode === 'loop') &&
    sub.faceIdx !== undefined && renderer.selection.has(sub.id))
  // 3D モード: 選択メッシュのバウンディングボックス上端に表示
  if (!$('#view3d').hidden) {
    const p = view3d?.projectSelection(renderer.selection)
    if (!p) { objActions.hidden = true; return }
    const selEnts3 = ids.map(id => store.byId(id)).filter((e): e is Entity => !!e)
    const inGroup3 = selEnts3.length > 0 && !!selEnts3[0].group && selEnts3.every(e => e.group === selEnts3[0].group)
    groupBtn.style.display = ids.length >= 2 ? '' : 'none'
    groupBtn.title = inGroup3 ? 'グループ解除' : 'グループ化'
    groupBtn.classList.toggle('active', inGroup3)
    objActions.hidden = false
    const aw3 = objActions.offsetWidth || 100
    const host = $('#view3d').getBoundingClientRect()
    objActions.style.left = `${Math.max(4, Math.min(p.x - aw3 / 2, host.width - aw3 - 4))}px`
    objActions.style.top = `${Math.max(46, p.y - 118)}px` // 紫のつまみと重ならないよう上に離す
    return
  }
  const walls = new Map<string, import('./model').Wall>()
  for (const e of store.doc.entities) if (e.type === 'wall') walls.set(e.id, e)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const id of ids) {
    const e = store.byId(id)
    if (!e) continue
    const b = renderer.entityBounds(e, walls)
    if (!b) continue
    minX = Math.min(minX, b.min.x); minY = Math.min(minY, b.min.y)
    maxX = Math.max(maxX, b.max.x); maxY = Math.max(maxY, b.max.y)
  }
  if (minX === Infinity) { objActions.hidden = true; return }
  // グループ化ボタン: 複数選択 or グループ選択中のみ表示
  const selEnts = ids.map(id => store.byId(id)).filter((e): e is Entity => !!e)
  const inGroup = selEnts.length > 0 && !!selEnts[0].group && selEnts.every(e => e.group === selEnts[0].group)
  groupBtn.style.display = ids.length >= 2 ? '' : 'none'
  groupBtn.title = inGroup ? 'グループ解除' : 'グループ化'
  groupBtn.classList.toggle('active', inGroup)
  const tl = renderer.vp.toScreen({ x: minX, y: minY })
  const br = renderer.vp.toScreen({ x: maxX, y: maxY })
  objActions.hidden = false
  const aw = objActions.offsetWidth || 100, ah = objActions.offsetHeight || 28
  const w = br.x - tl.x, h = br.y - tl.y
  let x: number, y: number
  if (h > w * 1.6) { // 縦長のオブジェクト → 右横に表示
    x = br.x + 8
    y = (tl.y + br.y) / 2 - ah / 2
    if (x + aw > canvas.clientWidth - 8) x = tl.x - aw - 8   // 画面右端なら左横へ
  } else {           // 通常 → 上に表示
    x = (tl.x + br.x) / 2 - aw / 2
    y = tl.y - ah - 8
    if (y < 8) y = br.y + 8                                  // 画面上端なら下へ
  }
  objActions.style.left = `${Math.max(4, Math.min(x, canvas.clientWidth - aw - 4))}px`
  objActions.style.top = `${Math.max(4, Math.min(y, canvas.clientHeight - ah - 4))}px`
}
renderer.onAfterDraw = () => { updateObjActions(); updateDimChips() }

// ================= 寸法チップ(選択オブジェクトの寸法を表示、クリックで直接入力) =================
const dimChips = $('#dim-chips')
let chipsSig = ''
type ChipDef =
  | { label: string; value: number; apply: (v: number) => void; text?: false }
  | { label: string; value: string; apply: (v: string) => void; text: true }
function chipDefs(e: import('./model').Entity): ChipDef[] {
  const upd = (fn: () => void) => { store.commit(); fn(); store.emit() }
  switch (e.type) {
    case 'wall': {
      const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y)
      return [
        { label: '長さ', value: Math.round(len), apply: v => upd(() => {
          const L = Math.max(1, len)
          e.b = { x: e.a.x + ((e.b.x - e.a.x) / L) * v, y: e.a.y + ((e.b.y - e.a.y) / L) * v }
        }) },
        { label: '厚さ', value: e.thickness, apply: v => upd(() => { e.thickness = Math.max(10, v) }) }
      ]
    }
    case 'opening': {
      const chips: ChipDef[] = [{ label: '幅', value: e.width, apply: v => upd(() => { e.width = Math.max(100, v) }) }]
      if (isWindow(e.kind)) {
        chips.push({ label: '床から', value: e.sill, apply: v => upd(() => {
          const winH = e.head - e.sill
          e.sill = Math.max(0, v)
          e.head = e.sill + winH
        }) })
      }
      return chips
    }
    case 'furniture':
      return [
        { label: '幅', value: e.w, apply: v => upd(() => { e.w = Math.max(50, v) }) },
        { label: '奥行', value: e.d, apply: v => upd(() => { e.d = Math.max(50, v) }) }
      ]
    case 'column': case 'custom':
      return [
        { label: '幅', value: e.w, apply: v => upd(() => { e.w = Math.max(50, v) }) },
        { label: '奥行', value: e.d, apply: v => upd(() => { e.d = Math.max(50, v) }) }
      ]
    case 'equipment': {
      const s = equipSize(e)
      return [
        { label: '幅', value: s.w, apply: v => upd(() => { e.w = Math.max(100, v) }) },
        { label: '奥行', value: s.d, apply: v => upd(() => { e.d = Math.max(80, v) }) }
      ]
    }
    case 'stair':
      return [{ label: '幅', value: e.width, apply: v => upd(() => { e.width = Math.max(300, v) }) }]
    case 'planting':
      return [{ label: '高さ', value: e.height, apply: v => upd(() => { e.height = Math.max(200, v) }) }]
    case 'label':
      return [
        { label: '内容', value: e.text, text: true, apply: v => upd(() => { e.text = v }) },
        { label: '文字高', value: e.size, apply: v => upd(() => { e.size = Math.max(50, v) }) }
      ]
    case 'room':
      return [{ label: '名前', value: e.name, text: true, apply: v => upd(() => { e.name = v }) }]
    default:
      return []
  }
}
function updateDimChips(): void {
  // 入力中は再構築しない(フォーカスが失われるため)
  if (dimChips.contains(document.activeElement)) return
  const ids = [...renderer.selection]
  if (ids.length !== 1 || !$('#view3d').hidden || renderer.elevation) { dimChips.hidden = true; chipsSig = ''; return }
  const e = store.byId(ids[0])
  if (!e) { dimChips.hidden = true; chipsSig = ''; return }
  const defs = chipDefs(e)
  if (!defs.length) { dimChips.hidden = true; chipsSig = ''; return }

  const sig = e.id + '|' + defs.map(d => `${d.label}:${d.value}`).join(',')
  if (sig !== chipsSig) {
    chipsSig = sig
    dimChips.innerHTML = ''
    for (const def of defs) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      const em = document.createElement('em')
      em.textContent = def.label
      const btn = document.createElement('button')
      btn.textContent = def.text ? def.value : String(Math.round(def.value * 10) / 10)
      btn.title = 'クリックして入力'
      btn.onclick = () => {
        const input = document.createElement('input')
        input.type = def.text ? 'text' : 'number'
        input.value = String(def.value)
        if (def.text) input.style.width = '90px'
        const done = (commit: boolean): void => {
          if (commit) {
            if (def.text) {
              if (input.value && input.value !== def.value) def.apply(input.value)
            } else {
              const v = parseFloat(input.value)
              if (!Number.isNaN(v) && v !== def.value) def.apply(v)
            }
          }
          chipsSig = ''  // 再構築を許可
          renderProperties()
          renderer.requestDraw()
        }
        input.onkeydown = ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); input.blur() }
          else if (ev.key === 'Escape') { input.oninput = null; input.onblur = null; done(false) }
          ev.stopPropagation()
        }
        input.onblur = () => done(true)
        btn.replaceWith(input)
        input.focus(); input.select()
      }
      chip.append(em, btn)
      dimChips.appendChild(chip)
    }
  }
  // 位置: オブジェクトの下端中央
  const walls = new Map<string, import('./model').Wall>()
  for (const en of store.doc.entities) if (en.type === 'wall') walls.set(en.id, en)
  const b = renderer.entityBounds(e, walls)
  if (!b) { dimChips.hidden = true; return }
  const tl = renderer.vp.toScreen(b.min), br = renderer.vp.toScreen(b.max)
  dimChips.hidden = false
  const cw = dimChips.offsetWidth || 120, ch = dimChips.offsetHeight || 24
  let x = (tl.x + br.x) / 2 - cw / 2
  let y = br.y + 8
  if (y + ch > canvas.clientHeight - 8) y = tl.y - ch - 8
  dimChips.style.left = `${Math.max(4, Math.min(x, canvas.clientWidth - cw - 4))}px`
  dimChips.style.top = `${Math.max(4, y)}px`
}

// ================= リーガルチェック =================
$('#legal-run').onclick = () => {
  const el = $('#legal-results')
  el.innerHTML = ''
  const results = runLegalCheck(store)
  if (!results.length) {
    el.innerHTML = '<div class="empty">チェック対象がありません(壁・部屋を作成してください)</div>'
  }
  const order = { error: 0, warn: 1, ok: 2 }
  results.sort((a, b) => order[a.level] - order[b.level])

  // 該当要素を図面上でハイライト(不適合=赤 > 注意=黄。適合したものは塗らない)
  renderer.legalHighlights.clear()
  for (const r of results) {
    if (r.level === 'ok' || !r.ids) continue
    for (const id of r.ids) {
      if (r.level === 'error' || !renderer.legalHighlights.has(id)) renderer.legalHighlights.set(id, r.level)
    }
  }
  renderer.requestDraw()

  for (const r of results) {
    const d = document.createElement('div')
    d.className = `legal-item ${r.level}`
    const badge = r.level === 'ok' ? '適合' : r.level === 'warn' ? '注意' : '不適合'
    d.innerHTML = `<div class="t"><span class="badge">${badge}</span><span>${esc(r.title)}</span></div>
      <div class="d">${esc(r.detail)}</div><div class="ref">${esc(r.ref)}</div>`
    if (r.ids?.length) {
      d.style.cursor = 'pointer'
      d.title = 'クリックで該当要素を選択(別の階なら切り替え)'
      d.onclick = () => {
        if (r.levelIndex !== undefined && r.levelIndex !== store.active) store.setLevel(r.levelIndex)
        renderer.selection = new Set(r.ids)
        renderProperties(); renderer.requestDraw()
      }
    }
    el.appendChild(d)
  }
  const note = document.createElement('div')
  note.className = 'note'
  note.textContent = '※ 簡易チェックです。実際の法適合判断は建築士・特定行政庁・指定確認検査機関にご確認ください。'
  el.appendChild(note)
}
$('#legal-clear').onclick = () => {
  renderer.legalHighlights.clear()
  $('#legal-results').innerHTML = ''
  renderer.requestDraw()
}
const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))

// ================= コンポーネント =================
let components: ComponentDef[] = loadComponents()
const compChecked = new Set<number>()
let compMenu: HTMLDivElement | null = null
function closeCompMenu(): void { compMenu?.remove(); compMenu = null }

function editComponentInStudio(i: number): void {
  const c = components[i]
  const first = c.entities[0]
  void import('./studio').then(mod => {
    let parts: unknown[] | undefined
    if (first?.type === 'custom') {
      const rec = (first as { recipe?: { parts?: unknown[] } }).recipe
      if (rec?.parts?.length) {
        parts = rec.parts
      } else {
        // レシピが無い古い部品はメッシュを「演算結果」パーツとして開く
        const f = first as { positions: number[]; w0: number; d0: number; h0: number }
        parts = [{
          kind: 'baked', op: 'add', x: 0, y: 0, z: 0,
          sx: f.w0, sy: f.h0, sz: f.d0, rot: 0,
          positions: f.positions, bx: f.w0, by: f.h0, bz: f.d0
        }]
      }
    }
    mod.openStudio((ent, name) => {
      components[i] = { name, entities: [ent] }
      saveComponents(components); renderComponents()
      setMsg(`部品「${name}」を更新しました`)
    }, first?.type === 'custom' ? {
      name: c.name,
      label: (first as { label: string }).label,
      symbol: (first as { symbol: 'rect' | 'round' }).symbol,
      parts
    } : undefined)
  })
}

function openCompMenu(anchor: HTMLElement, i: number): void {
  closeCompMenu()
  const c = components[i]
  const first = c.entities[0]
  const isStudioPart = c.entities.length === 1 && first?.type === 'custom'
  const menu = document.createElement('div')
  compMenu = menu
  menu.className = 'comp-menu'
  const item = (label: string, fn: () => void, danger = false): void => {
    const b = document.createElement('button')
    b.textContent = label
    if (danger) b.style.color = 'var(--danger)'
    b.onclick = () => { closeCompMenu(); fn() }
    menu.appendChild(b)
  }
  if (isStudioPart) item('編集(部品スタジオ)', () => editComponentInStudio(i))
  item('名前を変更', () => {
    const name = prompt('コンポーネント名', c.name)
    if (name) { c.name = name; saveComponents(components); renderComponents() }
  })
  item('キャンバスに展開(編集用)', () => {
    // 内容をそのまま図面へ配置 → 編集して「＋作成」で再登録できる
    tm.placeComponent(c)
    setMsg('クリックで展開先を指定 → 編集後に「＋作成」で再登録できます')
  })
  item('書き出し (.json)', () => download(`${c.name}.oarc-comp.json`, JSON.stringify(c, null, 1), 'application/json'))
  item('削除', () => {
    components.splice(i, 1)
    compChecked.clear()
    saveComponents(components); renderComponents()
  }, true)
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`
  setTimeout(() => {
    const onDoc = (ev: MouseEvent): void => {
      if (!menu.contains(ev.target as Node)) { closeCompMenu(); document.removeEventListener('pointerdown', onDoc) }
    }
    document.addEventListener('pointerdown', onDoc)
  })
}

function renderComponents(): void {
  const el = $('#component-list')
  el.innerHTML = ''
  if (!components.length) {
    el.innerHTML = '<div class="empty">要素を選択して「＋作成」でコンポーネント登録できます</div>'
    return
  }
  // 複数選択の一括書き出しバー
  if (compChecked.size) {
    const bar = document.createElement('div')
    bar.className = 'comp-multibar'
    const exp = document.createElement('button')
    exp.textContent = `選択した ${compChecked.size} 件を書き出し`
    exp.onclick = () => {
      const list = [...compChecked].map(i => components[i]).filter(Boolean)
      download('components.oarc-comp.json', JSON.stringify(list, null, 1), 'application/json')
    }
    const clr = document.createElement('button')
    clr.textContent = '解除'
    clr.onclick = () => { compChecked.clear(); renderComponents() }
    bar.append(exp, clr)
    el.appendChild(bar)
  }
  components.forEach((c, i) => {
    const d = document.createElement('div')
    d.className = 'comp-item'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = compChecked.has(i)
    cb.title = '書き出し対象に選択'
    cb.onclick = ev => {
      ev.stopPropagation()
      if (cb.checked) compChecked.add(i); else compChecked.delete(i)
      renderComponents()
    }
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = c.name
    const dots = document.createElement('button')
    dots.className = 'comp-dots'
    dots.title = 'メニュー'
    dots.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>'
    dots.onclick = ev => { ev.stopPropagation(); openCompMenu(dots, i) }
    d.append(cb, name, dots)
    d.onclick = () => { tm.placeComponent(c); setMsg(`「${c.name}」をクリックで配置`) }
    el.appendChild(d)
  })
}
$('#comp-make').onclick = () => {
  if (!renderer.selection.size) { setMsg('先にコンポーネント化する要素を選択してください'); return }
  const name = prompt('コンポーネント名', '新しいコンポーネント')
  if (!name) return
  try {
    components.push(makeComponent(name, store, renderer.selection))
    saveComponents(components); renderComponents()
  } catch (err) { setMsg(String(err)) }
}
$('#comp-studio').onclick = async () => {
  const mod = await import('./studio')   // 遅延ロード(CSG ライブラリはこのときだけ読み込む)
  mod.openStudio((ent, name) => {
    components.push({ name, entities: [ent] })
    saveComponents(components)
    renderComponents()
    setMsg(`部品「${name}」を作成しました。コンポーネント一覧から配置できます`)
  })
}
$('#comp-import').onclick = async () => {
  const f = await pickFile('.json')
  if (!f) return
  try {
    const parsed = JSON.parse(await f.text()) as ComponentDef | ComponentDef[]
    const defs = Array.isArray(parsed) ? parsed : [parsed]
    for (const def of defs) {
      if (!def.name || !Array.isArray(def.entities)) throw new Error('コンポーネント形式ではありません')
      components.push(def)
    }
    saveComponents(components); renderComponents()
    setMsg(`${defs.length} 件のコンポーネントを読み込みました`)
  } catch (err) { setMsg(String(err)) }
}

// ================= ファイル操作 =================
let view3d: View3D | null = null
const commands: Record<string, () => void | Promise<void>> = {
  new: () => {
    if (!confirm('現在の図面を破棄して新規作成しますか?')) return
    localStorage.removeItem('oarc.autosave')
    store.commit(); store.doc = newDoc(); store.active = 0; store.emit()
    renderer.selection.clear(); renderProperties(); renderProjectSettings()
  },
  open: async () => {
    const f = await pickFile('.json,.dxf')
    if (!f) return
    try {
      const text = await f.text()
      if (f.name.toLowerCase().endsWith('.dxf')) setMsg(importDXF(text, store))
      else { store.load(text); renderProjectSettings(); setMsg(`${f.name} を開きました`) }
    } catch (err) { setMsg(`読み込みエラー: ${err}`) }
  },
  save: () => {
    download(`${store.doc.meta.title || 'project'}.oarc.json`, store.serialize(), 'application/json')
  },
  'export-dxf': () => {
    download(`${store.doc.meta.title || 'plan'}.dxf`, exportDXF(store), 'application/dxf')
    setMsg('DXF を書き出しました(AutoCAD / JW_CAD 等で開けます)')
  },
  'export-obj': async () => {
    const v = await ensure3D()
    v.rebuild(store)
    download(`${store.doc.meta.title || 'model'}.obj`, v.exportOBJ(), 'text/plain')
    setMsg('OBJ を書き出しました(SketchUp / Blender 等で開けます)')
  },
  'export-gltf': async () => {
    const v = await ensure3D()
    v.rebuild(store)
    download(`${store.doc.meta.title || 'model'}.glb`, await v.exportGLB())
    setMsg('glTF (GLB) を書き出しました(Blender 等で開けます)')
  },
  undo: () => { store.undo(); renderProperties() },
  redo: () => { store.redo(); renderProperties() }
}
$('#file-menu').addEventListener('click', e => {
  const cmd = (e.target as HTMLElement).closest('button')?.dataset.cmd
  if (cmd && commands[cmd]) void commands[cmd]()
})

// ================= 2D / 3D タブ =================
async function ensure3D(): Promise<View3D> {
  if (!view3d) {
    setMsg('3D モジュールを読み込み中…')
    const mod = await import('./view3d')   // 遅延ロード: 2D だけ使う限り three.js は読み込まれない
    view3d = new mod.View3D($('#view3d'))
    // 3D 直接編集(選択・移動)を 2D と同期
    view3d.getSelection = () => renderer.selection
    view3d.getSnap = () => tm.snapStep
    view3d.onSelect = (id, levelIndex, mode = 'replace') => {
      if (levelIndex !== store.active) store.setLevel(levelIndex)
      if (mode === 'toggle' && id) {
        // Shift+クリック: 追加 / 除外
        if (renderer.selection.has(id)) renderer.selection.delete(id)
        else { renderer.selection.add(id); store.expandGroups(renderer.selection) }
      } else {
        renderer.selection.clear()
        if (id) {
          renderer.selection.add(id)
          if (mode !== 'drill') store.expandGroups(renderer.selection) // グループはまとめて選択
        }
      }
      renderProperties()
    }
    view3d.onMeasure = text => setMsg(text)
    view3d.onSelectSet = ids => {
      renderer.selection = new Set(ids)
      store.expandGroups(renderer.selection)
      renderProperties()
    }
    view3d.magnetize = id => tm.magnetizeById(id)
    view3d.onRendered = () => { if (!$('#view3d').hidden) updateObjActions() }
    view3d.getWallStart = () => tm.wallStartPt
    view3d.getRoomPts = () => (tm.tool === 'pencil' ? tm.pencilPoints : tm.roomPoints)
    view3d.getDimPts = () => tm.dimPoints
    view3d.getGrid = () => renderer.gridStep
    view3d.getRectStart = () => tm.rectStartPt
    view3d.getSnapInfo = p => tm.snapInfo(p)   // 2D と同じスナップ・ガイドを 3D でも使う
    view3d.getDupAwait = () => tm.awaitingDupBase
    view3d.onDupBase3D = p => tm.pickDupBase(p)
    view3d.getDrawMode = () => (tm.tool === 'room' ? params.room.mode : tm.tool === 'pencil' ? params.pencil.mode : null)
    view3d.onToggleDrawMode = () => tm.toggleDrawMode()
    view3d.getPreviewEntity = p => {
      const t = tm.tool
      switch (t) {
        case 'furniture': {
          const def = FURN_DEFAULTS[params.furniture.kind]
          return { id: '_pv', type: 'furniture', pos: p, rot: tm.placeRot, kind: params.furniture.kind, w: def.w, d: def.d, h: def.h }
        }
        case 'column': return { id: '_pv', type: 'column', pos: p, rot: tm.placeRot, ...params.column }
        case 'stair': return { id: '_pv', type: 'stair', pos: p, rot: tm.placeRot, ...params.stair }
        case 'equipment': return { id: '_pv', type: 'equipment', pos: p, rot: tm.placeRot, kind: params.equipment.kind }
        case 'planting': return { id: '_pv', type: 'planting', pos: p, kind: params.planting.kind, height: params.planting.height }
        case 'component': {
          const def = tm.placingComponent
          if (def && def.entities.length === 1) {
            const proto = JSON.parse(JSON.stringify(def.entities[0])) as Entity
            if ('pos' in proto) {
              ;(proto as { pos: { x: number; y: number } }).pos = p
              if ('rot' in proto) (proto as { rot: number }).rot += tm.placeRot
              proto.id = '_pv'
              return proto
            }
          }
          return null
        }
        default: return null
      }
    }
    view3d.getPreview = () => {
      const t = tm.tool
      if (t === 'wall') return { kind: 'wall', w: 0, d: params.wall.thickness, h: params.wall.height, rot: 0 }
      if (t === 'door') return { kind: 'opening', w: params.door.width, d: 100, h: params.door.head, rot: 0, sill: 0 }
      if (t === 'window') return { kind: 'opening', w: params.window.width, d: 100, h: params.window.head, rot: 0, sill: params.window.sill }
      if (t === 'column') return { kind: 'box', w: params.column.w, d: params.column.d, h: params.column.h, rot: tm.placeRot }
      if (t === 'furniture') {
        const def = FURN_DEFAULTS[params.furniture.kind]
        return { kind: 'box', w: def.w, d: def.d, h: def.h, rot: tm.placeRot }
      }
      if (t === 'stair') return { kind: 'box', w: params.stair.treads * params.stair.tread, d: params.stair.width, h: params.stair.riser * params.stair.treads, rot: tm.placeRot }
      if (t === 'equipment') return { kind: 'box', w: 500, d: 300, h: 900, rot: tm.placeRot }
      if (t === 'planting') return { kind: 'box', w: 600, d: 600, h: params.planting.height, rot: 0 }
      if (t === 'label' || t === 'component') return { kind: 'box', w: 400, d: 400, h: 200, rot: tm.placeRot }
      if (t === 'room' || t === 'dimension' || t === 'pencil') return { kind: 'poly', w: 0, d: 0, h: 0, rot: 0 }
      return null
    }
    view3d.onEdited = () => { store.emit() }
    view3d.getTool = () => tm.tool
    view3d.onPlace = (p, wallId, levelIndex, noSnap) => {
      if (levelIndex !== store.active) store.setLevel(levelIndex)
      tm.placeAt(p, { wallId, noSnap })
    }
    view3d.onCancel = () => {
      // 複写(基準点待ち・配置中)の右クリックは選択ツールへ戻る
      if (tm.awaitingDupBase || tm.tool === 'component') {
        tm.cancel()
        tm.setTool('select')
      } else {
        tm.cancel()
      }
    }
    setMsg('')
  }
  return view3d
}
// 3D 表示中にモデルが変わったら(プロパティ編集・削除・Undo 等)自動で再生成
let rebuild3dPending = false
store.onChange(() => {
  if ($('#view3d').hidden || !view3d) return
  if (rebuild3dPending) return
  rebuild3dPending = true
  requestAnimationFrame(() => {
    rebuild3dPending = false
    if (!$('#view3d').hidden && view3d) view3d.rebuild(store)
  })
})
// ================= 視点プルダウン(2D: 平面・立面 / 3D: アイソメ) =================
// ネイティブ select は OS によってグループが省略表示されるため、常に全項目が見えるカスタムメニュー
const VIEW_OPTS: { group: string; items: [string, string][] }[] = [
  { group: '2D ビュー', items: [['plan', '平面図'], ['elev-front', '正面図'], ['elev-back', '背面図'], ['elev-right', '右側面図'], ['elev-left', '左側面図']] },
  { group: '3D ビュー', items: [['iso-sw', '南西アイソメ'], ['iso-se', '南東アイソメ'], ['iso-nw', '北西アイソメ'], ['iso-ne', '北東アイソメ']] }
]
let curView = 'plan'
const viewBtn = $('#view-btn')
const viewLabel = (v: string): string =>
  VIEW_OPTS.flatMap(g => g.items).find(([id]) => id === v)?.[1] ?? v
function setViewBtnLabel(): void {
  viewBtn.innerHTML = `${esc(viewLabel(curView))} <span class="caret">▾</span>`
}
let viewPop: HTMLDivElement | null = null
viewBtn.onclick = () => {
  if (viewPop) { viewPop.remove(); viewPop = null; return }
  const pop = document.createElement('div')
  viewPop = pop
  pop.className = 'comp-menu view-pop'
  for (const g of VIEW_OPTS) {
    const t = document.createElement('div')
    t.className = 'cp-title'
    t.textContent = g.group
    pop.appendChild(t)
    for (const [id, label] of g.items) {
      const b = document.createElement('button')
      b.innerHTML = `<span class="check">${id === curView ? '✓' : ''}</span>${esc(label)}`
      b.onclick = () => { pop.remove(); viewPop = null; void applyViewPreset(id) }
      pop.appendChild(b)
    }
  }
  document.body.appendChild(pop)
  const r = viewBtn.getBoundingClientRect()
  pop.style.top = `${r.bottom + 4}px`
  pop.style.left = `${Math.min(r.left, innerWidth - pop.offsetWidth - 8)}px`
  setTimeout(() => {
    const onDoc = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node) && ev.target !== viewBtn) {
        pop.remove(); viewPop = null
        document.removeEventListener('pointerdown', onDoc)
      }
    }
    document.addEventListener('pointerdown', onDoc)
  })
}
async function applyViewPreset(v: string): Promise<void> {
  curView = v
  setViewBtnLabel()
  if (v === 'plan') {
    renderer.elevation = null
    renderElevationChips()
    await switchTab('2d')
    renderer.requestDraw()
    return
  }
  if (v.startsWith('elev-')) {
    // 2D の立面図(正面・背面・左右側面)。開いたとき建物を画面中央にフィット
    await switchTab('2d')
    renderer.elevation = { dir: v.slice(5) as 'front' | 'back' | 'left' | 'right', cluster: 0 }
    renderElevationChips()
    renderer.fitElevation()
    return
  }
  renderer.elevation = null
  renderElevationChips()
  await switchTab('3d')
  view3d?.setView(v as import('./view3d').ViewPreset)
}
// 立面図: どの建物か(複数棟のとき)を選ぶチップ
const elevChips = $('#elev-chips')
function renderElevationChips(): void {
  const el = renderer.elevation
  if (!el) { elevChips.hidden = true; return }
  const clusters = renderer.buildingClusters()
  elevChips.innerHTML = ''
  const dirLabel = { front: '正面図', back: '背面図', right: '右側面図', left: '左側面図' }[el.dir]
  const title = document.createElement('span')
  title.className = 'elev-title'
  title.textContent = dirLabel
  title.title = 'クリックで選択 / ドラッグで移動 / 壁の上端をドラッグで高さ変更 / 窓は上下ドラッグで窓台高'
  elevChips.appendChild(title)
  if (clusters.length > 1) {
    clusters.forEach((_, i) => {
      const b = document.createElement('button')
      b.textContent = `建物 ${i + 1}`
      b.classList.toggle('active', i === el.cluster)
      b.onclick = () => { el.cluster = i; renderElevationChips(); renderer.fitElevation() }
      elevChips.appendChild(b)
    })
  }
  elevChips.hidden = false
}
async function switchTab(t: '2d' | '3d'): Promise<void> {
  if (t === '2d' && !curView.startsWith('elev-') && curView !== 'plan') { curView = 'plan'; setViewBtnLabel() }
  const v3 = $('#view3d')
  $('#scale-bar').style.display = t === '3d' ? 'none' : ''
  if (t === '3d') {
    v3.hidden = false
    canvas.style.visibility = 'hidden'
    dimChips.hidden = true
    chipsSig = ''
    const v = await ensure3D()
    v.resize()
    v.rebuild(store)
  } else {
    v3.hidden = true
    canvas.style.visibility = 'visible'
    renderer.requestDraw()
  }
}
$('#btn-rebuild3d').onclick = () => { if (view3d) view3d.rebuild(store) }

// ================= パネルリサイズ・折りたたみ =================
// サイドメニューはキャンバスに重なる(浮いている)ため、幅を変えても図面はリサイズされない。
// 幅 0(折りたたみ)にすると ☰ アイコンが現れ、クリックか端からのドラッグで再表示できる。
function setupSide(side: 'left' | 'right', defaultW: number): void {
  const panel = $(side === 'left' ? '#left-panel' : '#right-panel')
  const sp = $(side === 'left' ? '#split-left' : '#split-right')
  const toggle = $(side === 'left' ? '#toggle-left' : '#toggle-right')
  const key = `oarc.w.${side}`
  const SNAP = 70   // これ未満までドラッグしたら折りたたむ

  const apply = (w: number): void => {
    w = Math.max(0, Math.min(480, Math.round(w)))
    if (w > 0 && w < 140) w = 140
    panel.style.width = `${w}px`
    panel.classList.toggle('collapsed', w === 0)
    sp.style[side] = `${w}px`
    ;(toggle as HTMLButtonElement).hidden = w !== 0
    localStorage.setItem(key, String(w))
    if (side === 'right') $('#scale-bar').style.right = `${w + 16}px` // 縮尺バーはパネルに隠れない位置へ
  }
  const saved = parseInt(localStorage.getItem(key) ?? '', 10)
  apply(Number.isNaN(saved) ? defaultW : saved)

  sp.addEventListener('pointerdown', (e: PointerEvent) => {
    try { sp.setPointerCapture(e.pointerId) } catch { /* 合成イベント等 */ }
    const startX = e.clientX
    const startW = panel.classList.contains('collapsed') ? 0 : panel.offsetWidth
    const dir = side === 'left' ? 1 : -1
    const move = (ev: PointerEvent): void => {
      const raw = startW + dir * (ev.clientX - startX)
      apply(raw < SNAP ? 0 : raw)
    }
    const up = (): void => {
      sp.removeEventListener('pointermove', move)
      sp.removeEventListener('pointerup', up)
    }
    sp.addEventListener('pointermove', move)
    sp.addEventListener('pointerup', up)
  })
  toggle.onclick = () => apply(defaultW)
}
setupSide('left', 216)
setupSide('right', 260)

// ================= ステータスバー =================
const setMsg = (s: string): void => { $('#st-msg').textContent = s }
tm.onCursor = p => { $('#st-coords').textContent = `x: ${Math.round(p.x)}, y: ${Math.round(p.y)} mm` }
tm.onZoom = z => {
  $('#st-zoom').textContent = `1mm = ${z.toFixed(3)}px`
  updateScaleBar()
}
;($('#st-snap') as HTMLSelectElement).onchange = e => { tm.snapStep = parseFloat((e.target as HTMLSelectElement).value) || 0 }
;($('#st-grid') as HTMLInputElement).onchange = e => {
  renderer.showGrid = (e.target as HTMLInputElement).checked
  renderer.requestDraw()
}
;($('#st-wallt') as HTMLInputElement).onchange = e => {
  renderer.showWallT = (e.target as HTMLInputElement).checked
  renderer.requestDraw()
}
// スナップガイド(端点・中点・延長など)の有効 / 無効
Object.assign(tm.snapEnabled, loadJson<Record<string, boolean>>('oarc.snapen', {}))
let guidePop: HTMLDivElement | null = null
$('#st-guides').onclick = () => {
  if (guidePop) { guidePop.remove(); guidePop = null; return }
  const pop = document.createElement('div')
  guidePop = pop
  pop.className = 'comp-menu guide-pop'
  const title = document.createElement('div')
  title.className = 'cp-title'
  title.textContent = 'スナップガイド'
  pop.appendChild(title)
  for (const k of SNAP_KINDS) {
    const lab = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = tm.snapEnabled[k] !== false
    cb.onchange = () => {
      tm.snapEnabled[k] = cb.checked
      localStorage.setItem('oarc.snapen', JSON.stringify(tm.snapEnabled))
    }
    lab.append(cb, document.createTextNode(` ${k}`))
    pop.appendChild(lab)
  }
  document.body.appendChild(pop)
  const r = $('#st-guides').getBoundingClientRect()
  pop.style.left = `${Math.max(8, r.left)}px`
  pop.style.top = `${r.top - pop.offsetHeight - 6}px`
  setTimeout(() => {
    const onDoc = (ev: MouseEvent): void => {
      if (!pop.contains(ev.target as Node) && ev.target !== $('#st-guides')) {
        pop.remove(); guidePop = null
        document.removeEventListener('pointerdown', onDoc)
      }
    }
    document.addEventListener('pointerdown', onDoc)
  })
}
tm.setHint = s => { $('#hint-bar').textContent = s }

// ================= キーボード =================
window.addEventListener('keydown', e => {
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) store.redo()
    else if (!tm.undoDraft()) store.undo() // 作図中はまず「今引いている線」を取り消す
    renderProperties()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); void commands.save()
    return
  }
  tm.key(e)
})
window.addEventListener('keyup', e => tm.key(e))

// ================= 自動保存(リロードしても消えない) =================
let autosaveTimer: number | undefined
store.onChange(() => {
  clearTimeout(autosaveTimer)
  autosaveTimer = window.setTimeout(() => {
    try { localStorage.setItem('oarc.autosave', store.serialize()) } catch { /* 容量超過など */ }
  }, 400)
})
window.addEventListener('beforeunload', () => {
  try { localStorage.setItem('oarc.autosave', store.serialize()) } catch { /* noop */ }
})
function restoreAutosave(): boolean {
  const saved = localStorage.getItem('oarc.autosave')
  if (!saved) return false
  try {
    store.load(saved)
    return true
  } catch { return false }
}

// ================= 3D モデリングツールバー =================
$('#btn3d-measure').onclick = async () => {
  const v = await ensure3D()
  v.measureOn = !v.measureOn
  $('#btn3d-measure').classList.toggle('active', v.measureOn)
  if (v.measureOn) setMsg('計測: 始点をクリックしてください')
  else { v.clearMeasure(); setMsg('') }
}
$('#btn3d-png').onclick = async () => {
  const v = await ensure3D()
  const blob = await v.exportPNG()
  if (blob) download(`${store.doc.meta.title || 'view'}.png`, blob)
  setMsg('PNG を保存しました')
}
document.querySelectorAll('#view3d-toolbar [data-view]').forEach(b => {
  ;(b as HTMLButtonElement).onclick = async () => {
    const v = await ensure3D()
    v.setView((b as HTMLElement).dataset.view as 'top' | 'front' | 'side' | 'iso')
  }
})
;($('#chk3d-upper') as HTMLInputElement).onchange = async e => {
  const v = await ensure3D()
  v.showUpper = (e.target as HTMLInputElement).checked
  v.applyFloorVisibility()
}
;($('#chk3d-lower') as HTMLInputElement).onchange = async e => {
  const v = await ensure3D()
  v.showLower = (e.target as HTMLInputElement).checked
  v.applyFloorVisibility()
}
;($('#chk3d-wire') as HTMLInputElement).onchange = async e => {
  const v = await ensure3D()
  v.setWireframe((e.target as HTMLInputElement).checked)
}
const sectionRange = $('#rng3d-section') as HTMLInputElement
;($('#chk3d-section') as HTMLInputElement).onchange = async e => {
  const on = (e.target as HTMLInputElement).checked
  sectionRange.hidden = !on
  const v = await ensure3D()
  v.setSection(on, parseInt(sectionRange.value, 10) / 100)
}
sectionRange.oninput = async () => {
  const v = await ensure3D()
  v.setSection(true, parseInt(sectionRange.value, 10) / 100)
}
;($('#chk3d-axes') as HTMLInputElement).onchange = async e => {
  const v = await ensure3D()
  v.setAxesVisible((e.target as HTMLInputElement).checked)
}
;($('#chk3d-ground') as HTMLInputElement).onchange = async e => {
  const v = await ensure3D()
  v.setGroundVisible((e.target as HTMLInputElement).checked)
}
// ================= 初期化 =================
if (restoreAutosave()) setMsg('前回の編集内容を復元しました')
renderProjectSettings()
renderComponents()
renderFloors()
applyGridStep(parseFloat(localStorage.getItem('oarc.gridstep') ?? '') || 910)
tm.setTool('select')
renderer.requestDraw()

// コンソールからのデバッグ用(バンドルサイズへの影響なし)
declare global { interface Window { __app?: unknown } }
window.__app = { store, renderer, tm, get view3d() { return view3d } }
