/**
 * Экспорт документа макета в HTML и CSS.
 *
 * Задача экспортёра — не «нарисовать картинку», а отдать разработчику и агенту
 * код, который можно положить в приложение:
 *  - значения-токены превращаются в `var(--color-bg)`, а сами токены — в
 *    `:root { … }`, поэтому палитра остаётся редактируемой в CSS;
 *  - каждый узел несёт `data-node="<id>"`, так что элемент DOM можно связать с
 *    узлом макета и вернуться к правке;
 *  - `mode: 'fidelity'` даёт пиксельно точный абсолютный макет (превью,
 *    handoff), `mode: 'clean'` — потоковые фреймы через flex там, где у фрейма
 *    задан `layout.mode` (ближе к настоящей вёрстке приложения).
 *
 * Единицы измерения выводятся из пути токена: `radius.*`, `space.*` и размеры
 * типографики получают `px`, веса и множители строки остаются безразмерными.
 *
 * Модуль чистый: ни файловой системы, ни HTTP. Запись артефактов — в store.js.
 */
import { childrenOf, expandInstance, flattenTokens, isPlainObject, num, resolveToken } from './schema.js'

/** Режимы экспорта. */
export const EXPORT_MODES = ['fidelity', 'clean']

/** Группы токенов, значения которых — длины и требуют единицы. */
const LENGTH_GROUPS = new Set(['radius', 'space'])

/** Подключи шрифта, если в документе не объявлено иного. */
const FONT_FALLBACK = 'system-ui, sans-serif'

/**
 * Единица измерения для значения токена по его пути.
 *
 * @param {string} path Путь вида `radius.md` или `text.h1.size`.
 * @returns {'px'|''} Суффикс единицы.
 */
export function tokenUnit(path) {
  const [group, , sub] = String(path).split('.')
  if (LENGTH_GROUPS.has(group)) return 'px'
  if (group === 'text' && (sub === 'size' || sub === 'letterSpacing')) return 'px'
  if (group === 'shadow' && sub && sub !== 'color') return 'px'
  return ''
}

/**
 * Отрисовать документ в HTML/CSS.
 *
 * Верхние фреймы — экраны: их укладывает в поток доски `.dc-board`, поэтому
 * координаты внутри `root` на страницу не переносятся. Внутренние узлы
 * остаются абсолютными относительно своего родителя.
 *
 * @param {object} doc Документ макета.
 * @param {object} [opts] `{ mode, frame, title, inlineCss, components }`.
 * @returns {{html: string, css: string, files: Array<{name: string, content: string}>, warnings: string[]}}
 */
export function renderDocument(doc, opts = {}) {
  const mode = EXPORT_MODES.includes(opts.mode) ? opts.mode : 'fidelity'
  const warnings = []
  const ctx = { doc, mode, warnings }
  const frames = opts.frame
    ? (doc.root.children ?? []).filter((node) => node.id === opts.frame)
    : (doc.root.children ?? [])
  if (opts.frame && frames.length === 0) warnings.push(`Фрейм «${opts.frame}» не найден — экспортирован пустой холст.`)

  const body = frames.map((frame) => renderNode(ctx, frame, 0, true)).join('\n')
  const css = renderCss(ctx)
  const title = opts.title ?? doc.name ?? doc.id
  const head = opts.inlineCss
    ? `<style>\n${css}\n</style>`
    : `<link rel="stylesheet" href="${escapeAttr(doc.id)}.css">`
  const html = pageHtml(title, head, body)

  const files = [
    { name: `${doc.id}.html`, content: html },
    { name: `${doc.id}.css`, content: css },
  ]
  const componentsHtml = opts.components === false ? '' : renderComponentSheet(ctx)
  if (componentsHtml) {
    files.push({ name: `${doc.id}.components.html`, content: pageHtml(`${title} — компоненты`, head, componentsHtml) })
  }
  return { html, css, files, warnings }
}

/** Полная HTML-страница вокруг отрисованного тела. */
function pageHtml(title, head, body) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="generator" content="dsh-design-canvas">
${head}
</head>
<body class="dc-page">
<div class="dc-board">
${body}
</div>
</body>
</html>
`
}

/**
 * Отрисовать один узел в HTML.
 *
 * @param {object} ctx Контекст отрисовки (документ, режим, предупреждения).
 * @param {object} node Узел (инстанс разворачивается на месте).
 * @param {number} depth Глубина для отступов в разметке.
 * @param {boolean} parentFlow Родитель раскладывает детей потоком (flex).
 * @returns {string}
 */
function renderNode(ctx, node, depth, parentFlow = false) {
  const pad = '  '.repeat(depth + 1)
  if (node.visible === false) return `${pad}<!-- ${escapeHtml(node.name)} скрыт -->`
  const resolved = node.type === 'instance' ? expandInstance(ctx.doc, node) : node
  const attrs = [
    `class="${nodeClasses(ctx, resolved, node)}"`,
    `data-node="${escapeAttr(node.id)}"`,
    `data-name="${escapeAttr(node.name)}"`,
  ].join(' ')
  const tag = resolved.type === 'image' ? 'img' : 'div'
  const extra = tag === 'img' ? imageAttrs(ctx, resolved) : ''

  if (resolved.type === 'text') {
    const style = joinStyle(nodeStyle(ctx, resolved, node, parentFlow), textStyleOf(ctx, resolved))
    return `${pad}<${tag} ${attrs}${extra} style="${style}">${escapeHtml(String(resolved.text?.value ?? ''))}</${tag}>`
  }

  const children = childrenOf(ctx.doc, node)
  const style = nodeStyle(ctx, resolved, node, parentFlow)
  if (children.length === 0) return `${pad}<${tag} ${attrs}${extra} style="${style}"></${tag}>`
  const childFlow = flowsChildren(ctx, resolved)
  const inner = children.map((child) => renderNode(ctx, child, depth + 1, childFlow)).join('\n')
  return `${pad}<${tag} ${attrs}${extra} style="${style}">\n${inner}\n${pad}</${tag}>`
}

/** Склеить части инлайн-стиля, не теряя точки с запятой. */
function joinStyle(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part !== '')
    .map((part) => part.replace(/;+$/, ''))
    .join(';')
}

/** Классы узла: базовый, ролевой и режим раскладки, без повторов. */
function nodeClasses(ctx, node, original) {
  const classes = ['dc-node', `dc-${node.type}`]
  if (original.type === 'instance') classes.push('dc-instance')
  if (node.type === 'frame' && node !== ctx.doc.root) classes.push('dc-frame')
  if (node.type === 'frame' && node.layout?.mode && node.layout.mode !== 'none') {
    classes.push('dc-layout', `dc-layout-${node.layout.mode}`)
    if (flowsChildren(ctx, node)) classes.push('dc-flow')
  }
  return [...new Set(classes)].join(' ')
}

/** Раскладывает ли узел детей потоком (только в режиме clean). */
function flowsChildren(ctx, node) {
  return ctx.mode === 'clean'
    && (node.type === 'frame' || node.type === 'instance')
    && node.layout?.mode
    && node.layout.mode !== 'none'
}

/**
 * Есть ли у узла дети, которых он позиционирует абсолютно.
 *
 * Такому узлу нужен `position:relative`, даже если сам он лежит в потоке
 * родителя: иначе его дети отсчитываются от чужой системы координат.
 *
 * @param {object} ctx Контекст отрисовки.
 * @param {object} node Развёрнутый узел.
 * @returns {boolean}
 */
function hasAbsoluteChildren(ctx, node) {
  return !flowsChildren(ctx, node) && Array.isArray(node.children) && node.children.length > 0
}

/**
 * Инлайн-стиль узла: геометрия, заливка, обводка, скругление, тень.
 *
 * Позиционирование подчиняется одному правилу: узел абсолютен относительно
 * родителя, если родитель не раскладывает детей потоком. Ребёнок потокового
 * фрейма позицию не задаёт — её вычисляет flex, как в настоящей вёрстке, — но
 * сохраняет систему координат для своих absolute-детей.
 * Собственный `layout.mode` фрейма управляет только его детьми.
 *
 * @param {object} ctx Контекст отрисовки.
 * @param {object} node Развёрнутый узел.
 * @param {object} original Исходный узел (для `clip`).
 * @param {boolean} parentFlow Родитель раскладывает детей потоком.
 * @returns {string}
 */
function nodeStyle(ctx, node, original, parentFlow = false) {
  const style = node.style ?? {}
  const parts = []
  const flow = flowsChildren(ctx, node)

  if (parentFlow) {
    // Потоковый ребёнок не задаёт позицию сам, но обязан стать containing block
    // для своих absolute-детей: иначе они уедут к первому positioned предку.
    parts.push(hasAbsoluteChildren(ctx, node) ? 'position:relative' : 'position:static')
  } else {
    parts.push('position:absolute', `left:${px(num(node.x, 0))}`, `top:${px(num(node.y, 0))}`)
  }
  parts.push(`width:${px(num(node.w, 0))}`, `height:${px(num(node.h, 0))}`)

  if (flow) {
    const layout = node.layout
    const p = layout.padding ?? {}
    parts.push('display:flex')
    parts.push(`flex-direction:${layout.mode === 'horizontal' ? 'row' : 'column'}`)
    if (num(layout.gap, 0) > 0) parts.push(`gap:${px(num(layout.gap, 0))}`)
    if (p.t || p.r || p.b || p.l) {
      parts.push(`padding:${px(num(p.t, 0))} ${px(num(p.r, 0))} ${px(num(p.b, 0))} ${px(num(p.l, 0))}`)
    }
    parts.push(`align-items:${ALIGN_CSS[layout.align] ?? 'flex-start'}`)
    parts.push(`justify-content:${JUSTIFY_CSS[layout.justify] ?? 'flex-start'}`)
  }

  if (num(node.rotation, 0) !== 0) parts.push(`transform:rotate(${num(node.rotation, 0)}deg)`)

  if (node.type !== 'group') {
    const fill = cssValue(ctx, style.fill)
    if (fill) parts.push(`background:${fill}`)
  }

  if (isPlainObject(style.stroke) && num(style.stroke.width, 0) > 0) {
    const color = cssValue(ctx, style.stroke.color) ?? 'currentColor'
    parts.push(`border:${px(num(style.stroke.width, 1))} solid ${color}`)
  }

  if (node.type === 'ellipse') parts.push('border-radius:50%')
  else if (style.radius !== undefined && style.radius !== null) parts.push(`border-radius:${radiusValue(ctx, style.radius)}`)

  if (style.shadow !== undefined && style.shadow !== null) parts.push(`box-shadow:${shadowValue(ctx, style.shadow)}`)
  if (style.opacity !== undefined && num(style.opacity, 1) !== 1) parts.push(`opacity:${num(style.opacity, 1)}`)
  if ((node.type === 'frame' || node.type === 'instance') && original.clip !== false && node !== ctx.doc.root) {
    parts.push('overflow:hidden')
  }
  return parts.join(';')
}

const ALIGN_CSS = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }
const JUSTIFY_CSS = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between' }

/**
 * Стиль текстового узла: свойства берутся из составного токена `text.*`, если
 * узел их не переопределяет, и остаются ссылками на CSS-переменные.
 */
function textStyleOf(ctx, node) {
  const text = node.text ?? {}
  // `text.token` хранит путь токена типографики (`text.h1`) без префикса `token:`.
  const tokenPath = typeof text.token === 'string' && text.token !== ''
    ? text.token.replace(/^token:/, '')
    : null
  const spec = tokenPath && isPlainObject(resolveToken(ctx.doc, `token:${tokenPath}`, null))
    ? resolveToken(ctx.doc, `token:${tokenPath}`, null)
    : {}
  const parts = []
  const fontToken = resolveToken(ctx.doc, 'token:font.sans', null)
  const family = typeof fontToken === 'string' ? fontToken : FONT_FALLBACK
  parts.push(`font-family:var(--font-sans, ${family})`)

  const fromToken = (key, unit) => {
    if (text[key] !== undefined && text[key] !== null) return unit === 'px' ? px(num(text[key], 0)) : String(num(text[key], 0))
    if (spec[key] === undefined || spec[key] === null || !tokenPath) return null
    const literal = unit === 'px' ? px(num(spec[key], 0)) : String(num(spec[key], 0))
    return `var(--${(tokenPath + '.' + key).replace(/\./g, '-')}, ${literal})`
  }

  const size = fromToken('size', 'px')
  if (size) parts.push(`font-size:${size}`)
  const weight = fromToken('weight', '')
  if (weight) parts.push(`font-weight:${weight}`)
  const lineHeight = fromToken('lineHeight', '')
  if (lineHeight) parts.push(`line-height:${lineHeight}`)
  const letterSpacing = fromToken('letterSpacing', 'px')
  if (letterSpacing) parts.push(`letter-spacing:${letterSpacing}`)

  const color = cssValue(ctx, text.color)
  if (color) parts.push(`color:${color}`)
  parts.push(`text-align:${['left', 'center', 'right', 'justify'].includes(text.align) ? text.align : 'left'}`)
  parts.push('display:flex', `align-items:${VALIGN_CSS[text.valign] ?? 'flex-start'}`)
  parts.push('white-space:pre-wrap', 'word-break:break-word', 'overflow:hidden')
  return parts.join(';')
}

const VALIGN_CSS = { top: 'flex-start', middle: 'center', bottom: 'flex-end' }

/** Атрибуты изображения. */
function imageAttrs(ctx, node) {
  const image = node.image ?? {}
  const src = typeof image.src === 'string' ? image.src : ''
  const fit = ['cover', 'contain', 'fill', 'none'].includes(image.fit) ? image.fit : 'cover'
  if (!src) ctx.warnings.push(`Изображение «${node.name}» без источника — экспортировано пустым.`)
  return ` src="${escapeAttr(src)}" alt="${escapeAttr(node.name)}" style="object-fit:${fit}"`
}

/** Секция `:root` с токенами и базовые классы. */
function renderCss(ctx) {
  const flat = flattenTokens(ctx.doc)
  const lines = [
    '/* Сгенерировано dsh-design-canvas. Токены — единственный источник значений. */',
    ':root {',
  ]
  for (const [path, value] of Object.entries(flat)) {
    if (isPlainObject(value)) continue
    lines.push(`  --${path.replace(/\./g, '-')}: ${declarationValue(path, value)};`)
  }
  lines.push('}', '')
  lines.push(
    '.dc-page { margin:0; padding:0; background: var(--color-bg, #0b0d10); color: var(--color-fg, #e8eaed); }',
    '.dc-board { display:flex; flex-wrap:wrap; align-items:flex-start; gap:48px; padding:48px; }',
    '.dc-node { box-sizing:border-box; }',
    '.dc-frame { position:relative; }',
    '.dc-layout { position:relative; }',
    '.dc-text { min-width:0; }',
    '.dc-image { display:block; }',
    '',
  )
  const components = Object.values(ctx.doc.components ?? {})
  if (components.length > 0) {
    lines.push('/* --- компоненты --- */')
    for (const component of components) {
      lines.push(`/* .dc-c-${component.key} — ${component.name}${component.description ? `: ${component.description}` : ''} */`)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Отдельная страница-библиотека: каждый компонент один раз.
 *
 * Ячейка держит собственную систему координат (`position:relative`) и явный
 * размер: узлы макета абсолютны, а абсолютные дети не дают размер родителю —
 * без этого компоненты наложились бы друг на друга в одной точке.
 */
function renderComponentSheet(ctx) {
  const components = Object.values(ctx.doc.components ?? {})
  if (components.length === 0) return ''
  const parts = ['<div class="dc-sheet" style="display:flex;flex-wrap:wrap;gap:40px;align-items:flex-start">']
  for (const component of components) {
    const w = num(component.node.w, 100)
    const h = num(component.node.h, 100)
    const instance = {
      id: `sheet-${component.key}`,
      type: 'instance',
      name: component.name,
      x: 0,
      y: 0,
      w,
      h,
      rotation: 0,
      visible: true,
      locked: false,
      component: component.key,
      overrides: {},
      style: {},
    }
    parts.push(`  <figure class="dc-sheet-cell" style="margin:0;position:relative;width:${px(w)}">`)
    parts.push(`    <div class="dc-sheet-holder" style="position:relative;width:${px(w)};height:${px(h)}">`)
    parts.push(renderNode(ctx, instance, 3, false))
    parts.push('    </div>')
    parts.push(`    <figcaption style="font:12px/1.4 var(--font-sans, ${FONT_FALLBACK});color:var(--color-fgMuted, #9aa4b2);margin-top:10px">${escapeHtml(component.name)} <code style="opacity:.7">${escapeHtml(component.key)}</code></figcaption>`)
    parts.push('  </figure>')
  }
  parts.push('</div>')
  return parts.join('\n')
}

/**
 * Значение CSS из значения макета.
 *
 * Ссылка на токен становится `var(--…)` — палитра остаётся в CSS, а не
 * размазывается литералами по разметке.
 *
 * @param {object} ctx Контекст отрисовки.
 * @param {unknown} value Значение или `token:…`.
 * @param {'length'|''} [hint] Ожидается ли длина (тогда число получает `px`).
 * @returns {string|null}
 */
function cssValue(ctx, value, hint = '') {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.startsWith('token:')) {
    const path = value.slice('token:'.length)
    const resolved = resolveToken(ctx.doc, value, undefined)
    if (resolved === undefined) {
      ctx.warnings.push(`Токен «${path}» не найден — подставлено прозрачное значение.`)
      return 'transparent'
    }
    if (isPlainObject(resolved)) return null
    const literal = declarationValue(path, resolved)
    return `var(--${path.replace(/\./g, '-')}, ${literal})`
  }
  if (typeof value === 'number') return hint === 'length' ? px(value) : String(value)
  if (typeof value === 'string') return value
  return null
}

/** Литерал значения с учётом единицы, которую подсказывает путь токена. */
function declarationValue(path, value) {
  if (typeof value === 'number' && tokenUnit(path) === 'px') return px(value)
  return cssLiteral(value)
}

/** Радиус: число, ссылка на токен или строка CSS. */
function radiusValue(ctx, radius) {
  if (typeof radius === 'number') return px(radius)
  return cssValue(ctx, radius, 'length') ?? '0'
}

/** Тень: объект или ссылка на токен-объект. */
function shadowValue(ctx, shadow) {
  const resolved = isPlainObject(shadow) ? shadow : resolveToken(ctx.doc, shadow, null)
  if (!isPlainObject(resolved)) return 'none'
  const color = cssValue(ctx, resolved.color) ?? 'rgba(0,0,0,0.4)'
  const parts = ['x', 'y', 'blur', 'spread'].map((key) => {
    const value = resolved[key]
    return typeof value === 'string' && value.startsWith('token:') ? cssValue(ctx, value, 'length') : px(num(value, 0))
  })
  return `${parts.join(' ')} ${color}`
}

/** Число в пикселях. */
function px(value) {
  return `${Math.round(num(value, 0) * 100) / 100}px`
}

/** Примитив токена как литерал CSS. */
function cssLiteral(value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** Экранирование текста для HTML. */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Экранирование значения атрибута. */
export function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;')
}
