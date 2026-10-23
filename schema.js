/**
 * Модель документа макета (design canvas) для DeepSeek Harness.
 *
 * Документ — обычный JSON, который читают и пишут две стороны:
 *  - агент через инструменты `design_*`;
 *  - визуальный редактор в веб-панели через HTTP-маршрут.
 *
 * Модуль не знает ни про файловую систему, ни про HTTP, ни про React: только
 * структура, нормализация, обход дерева, валидация и резолв токенов. Это делает
 * его единственным источником правды о форме данных — и для `ops.js`, и для
 * `export.js`, и для клиента.
 *
 * Система координат — Figma-подобная: у каждого узла абсолютные `x`/`y`
 * относительно родителя и собственные `w`/`h`. `layout.mode` переключает
 * фрейм в поток (vertical/horizontal), и тогда позиции детей пересчитывает
 * `layoutChildren` — так макет остаётся и свободным, и экспортируемым в CSS.
 */

/** Версия формата документа; растёт только при несовместимом изменении. */
export const DOC_FORMAT = 'dsh-design-canvas'
export const DOC_VERSION = 1

/** Типы узлов, которые понимает редактор и экспортёр. */
export const NODE_TYPES = ['frame', 'group', 'rect', 'ellipse', 'line', 'text', 'image', 'instance']

/** Типы, которые могут содержать детей. */
export const CONTAINER_TYPES = new Set(['frame', 'group', 'instance'])

/** Режимы раскладки фрейма. */
export const LAYOUT_MODES = ['none', 'vertical', 'horizontal']

/** Выравнивание по поперечной оси и распределение по главной. */
export const ALIGN_VALUES = ['start', 'center', 'end', 'stretch']
export const JUSTIFY_VALUES = ['start', 'center', 'end', 'space-between']

/** Пределы, за которыми документ считается испорченным, а не смелым. */
const MAX_DEPTH = 64
const MAX_NODES = 20000
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

let idCounter = 0

/**
 * Короткий уникальный id узла. Не криптографический: документ живёт в файле,
 * а коллизии внутри одного документа исключает проверка в `ops.js`.
 *
 * @param {string} [prefix] Префикс для читаемости (`n`, `c`, `frame`).
 * @returns {string}
 */
export function newId(prefix = 'n') {
  idCounter = (idCounter + 1) % 100000
  const rand = Math.random().toString(36).slice(2, 7)
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`
}

/** Проверка, что значение — ссылка на токен (`token:color.bg`). */
export function isTokenRef(value) {
  return typeof value === 'string' && value.startsWith('token:')
}

/**
 * Собрать ссылку на токен.
 *
 * @param {string} path Путь вида `color.bg`.
 * @returns {string}
 */
export function tokenRef(path) {
  return `token:${path}`
}

/**
 * Разобрать ссылку на токен.
 *
 * @param {string} value Строка `token:color.bg`.
 * @returns {string|null} Путь `color.bg` или null.
 */
export function parseTokenRef(value) {
  return isTokenRef(value) ? value.slice('token:'.length) : null
}

/** Наборы токенов по умолчанию: тёмная нейтральная тема приложения. */
export function defaultTokens() {
  return {
    color: {
      bg: '#0b0d10',
      surface: '#151920',
      surfaceAlt: '#1d222b',
      border: '#2a313d',
      fg: '#e8eaed',
      fgMuted: '#9aa4b2',
      accent: '#4f8cff',
      accentFg: '#ffffff',
      danger: '#ff5f56',
      success: '#3fb950',
    },
    radius: { sm: 6, md: 12, lg: 20, pill: 999 },
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 },
    font: {
      sans: 'Inter, "Segoe UI", system-ui, sans-serif',
      mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    text: {
      h1: { size: 32, weight: 700, lineHeight: 1.15, letterSpacing: -0.5 },
      h2: { size: 24, weight: 650, lineHeight: 1.2, letterSpacing: -0.3 },
      body: { size: 15, weight: 400, lineHeight: 1.5, letterSpacing: 0 },
      caption: { size: 12, weight: 500, lineHeight: 1.4, letterSpacing: 0.2 },
    },
    shadow: {
      card: { x: 0, y: 8, blur: 24, spread: 0, color: 'rgba(0,0,0,0.45)' },
      pop: { x: 0, y: 16, blur: 48, spread: -8, color: 'rgba(0,0,0,0.6)' },
    },
  }
}

/** Размеры фрейма по умолчанию для каждого типа устройства. */
export const DEVICE_PRESETS = {
  mobile: { w: 390, h: 844, name: 'Mobile' },
  tablet: { w: 834, h: 1112, name: 'Tablet' },
  desktop: { w: 1440, h: 900, name: 'Desktop' },
  component: { w: 240, h: 56, name: 'Component' },
}

/**
 * Узел со значениями по умолчанию для своего типа.
 *
 * @param {string} type Тип из {@link NODE_TYPES}.
 * @param {object} [init] Переопределения (плоские поля узла).
 * @returns {object} Новый узел.
 */
export function defaultNode(type = 'rect', init = {}) {
  const kind = NODE_TYPES.includes(type) ? type : 'rect'
  const base = {
    id: typeof init.id === 'string' && ID_RE.test(init.id) ? init.id : newId(kind === 'frame' ? 'fr' : kind === 'text' ? 'tx' : 'n'),
    type: kind,
    name: init.name ?? defaultName(kind),
    x: num(init.x, 0),
    y: num(init.y, 0),
    w: num(init.w, kind === 'text' ? 200 : 120),
    h: num(init.h, kind === 'text' ? 28 : 120),
    rotation: num(init.rotation, 0),
    visible: init.visible !== false,
    locked: init.locked === true,
    style: { ...defaultStyle(kind), ...(init.style ?? {}) },
    layout: { ...defaultLayout(), ...(init.layout ?? {}) },
  }
  if (typeof init.autoW === 'boolean') base.autoW = init.autoW
  if (typeof init.autoH === 'boolean') base.autoH = init.autoH
  if (kind === 'text') base.text = { ...defaultText(), ...(init.text ?? {}) }
  if (kind === 'instance') {
    base.component = init.component ?? ''
    base.overrides = { ...(init.overrides ?? {}) }
  }
  if (kind === 'image') base.image = { ...defaultImage(), ...(init.image ?? {}) }
  if (kind === 'line') {
    base.w = num(init.w, 120)
    base.h = num(init.h, 1)
  }
  if (CONTAINER_TYPES.has(kind)) {
    base.clip = init.clip !== undefined ? init.clip === true : kind === 'frame'
    base.children = Array.isArray(init.children) ? init.children.map((child) => normalizeNode(child)) : []
  }
  // Явные поля поверх дефолтов: init может нести `clip`, `image`, `text` и т. п.
  for (const key of ['clip', 'text', 'image', 'component', 'overrides', 'variant']) {
    if (init[key] !== undefined) base[key] = init[key]
  }
  return base
}

/** Имя узла по умолчанию для каждого типа (видно в дереве слоёв). */
function defaultName(type) {
  return {
    frame: 'Frame',
    group: 'Group',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    line: 'Line',
    text: 'Text',
    image: 'Image',
    instance: 'Instance',
  }[type] ?? 'Node'
}

/** Стиль по умолчанию: заливка-заглушка, скругление, без обводки. */
function defaultStyle(type) {
  if (type === 'text') return { fill: null, opacity: 1 }
  if (type === 'frame' || type === 'group') {
    return { fill: 'token:color.surface', stroke: null, radius: 0, opacity: 1, shadow: null }
  }
  if (type === 'line') return { fill: 'token:color.border', opacity: 1 }
  if (type === 'ellipse') return { fill: 'token:color.accent', opacity: 1 }
  return { fill: 'token:color.surfaceAlt', stroke: null, radius: 8, opacity: 1, shadow: null }
}

/** Раскладка по умолчанию: свободное позиционирование. */
function defaultLayout() {
  return {
    mode: 'none',
    gap: 0,
    padding: { t: 0, r: 0, b: 0, l: 0 },
    align: 'start',
    justify: 'start',
  }
}

/** Текстовые свойства по умолчанию. */
function defaultText() {
  return {
    value: 'Текст',
    token: 'text.body',
    align: 'left',
    valign: 'top',
    color: 'token:color.fg',
    size: null,
    weight: null,
    lineHeight: null,
    letterSpacing: null,
  }
}

/** Свойства изображения по умолчанию. */
function defaultImage() {
  return { src: '', fit: 'cover' }
}

/** Пустой документ с одним фреймом-страницей. */
export function defaultDocument(id, name, opts = {}) {
  const device = DEVICE_PRESETS[opts.device] ? opts.device : 'mobile'
  const preset = DEVICE_PRESETS[device]
  const doc = {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    id,
    name: name ?? id,
    device,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tokens: defaultTokens(),
    components: {},
    root: {
      id: 'root',
      type: 'frame',
      name: 'Canvas',
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      rotation: 0,
      visible: true,
      locked: true,
      clip: false,
      style: { fill: null, stroke: null, radius: 0, opacity: 1, shadow: null },
      layout: defaultLayout(),
      children: [
        defaultNode('frame', {
          id: 'page',
          name: preset.name,
          x: 0,
          y: 0,
          w: preset.w,
          h: preset.h,
          style: { fill: 'token:color.bg', radius: 0 },
        }),
      ],
    },
  }
  return doc
}

/** Число или подстановка по умолчанию. */
export function num(value, fallback) {
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? n : fallback
}

/**
 * Привести произвольный узел к канонической форме.
 *
 * Терпимость к чужим данным — сознательная: документы пишут и агент, и
 * редактор, и частично сломанный узел лучше потерять полем, чем целиком.
 *
 * @param {object} node Сырой узел.
 * @param {number} [depth] Текущая глубина (защита от переполнения стека).
 * @returns {object} Канонический узел.
 */
export function normalizeNode(node, depth = 0) {
  const raw = node && typeof node === 'object' ? node : {}
  const type = NODE_TYPES.includes(raw.type) ? raw.type : 'rect'
  const out = {
    id: typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : newId('n'),
    type,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : defaultName(type),
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    w: Math.max(0, num(raw.w, 100)),
    h: Math.max(0, num(raw.h, 100)),
    rotation: num(raw.rotation, 0),
    visible: raw.visible !== false,
    locked: raw.locked === true,
    style: { ...defaultStyle(type), ...(isPlainObject(raw.style) ? raw.style : {}) },
    layout: normalizeLayout(raw.layout),
  }
  // Авторазмер — часть раскладки, но живёт полем узла: `layoutChildren` читает
  // `frame.autoW`. Сохраняется только явное значение, иначе нормализация
  // добавляла бы поля в каждый старый `canvas.json`.
  if (typeof raw.autoW === 'boolean') out.autoW = raw.autoW
  if (typeof raw.autoH === 'boolean') out.autoH = raw.autoH
  if (type === 'text') out.text = { ...defaultText(), ...(isPlainObject(raw.text) ? raw.text : {}) }
  if (type === 'image') out.image = { ...defaultImage(), ...(isPlainObject(raw.image) ? raw.image : {}) }
  if (type === 'instance') {
    out.component = typeof raw.component === 'string' ? raw.component : ''
    out.overrides = isPlainObject(raw.overrides) ? { ...raw.overrides } : {}
    // Вариация — тоже поле инстанса, как и ключ компонента: пустая не пишется,
    // чтобы старый документ не обрастал полем при каждой записи.
    if (typeof raw.variant === 'string' && raw.variant !== '') out.variant = raw.variant
  }
  if (CONTAINER_TYPES.has(type)) {
    out.clip = raw.clip === true
    const children = Array.isArray(raw.children) ? raw.children : []
    out.children = depth >= MAX_DEPTH ? [] : children.map((child) => normalizeNode(child, depth + 1))
  }
  return out
}

/** Каноническая раскладка: числа и перечисления проверяются. */
function normalizeLayout(layout) {
  const raw = isPlainObject(layout) ? layout : {}
  const padding = isPlainObject(raw.padding) ? raw.padding : {}
  return {
    mode: LAYOUT_MODES.includes(raw.mode) ? raw.mode : 'none',
    gap: Math.max(0, num(raw.gap, 0)),
    padding: {
      t: Math.max(0, num(padding.t, 0)),
      r: Math.max(0, num(padding.r, 0)),
      b: Math.max(0, num(padding.b, 0)),
      l: Math.max(0, num(padding.l, 0)),
    },
    align: ALIGN_VALUES.includes(raw.align) ? raw.align : 'start',
    justify: JUSTIFY_VALUES.includes(raw.justify) ? raw.justify : 'start',
  }
}

/** Проверка на «обычный объект» (не массив, не null, не класс). */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Сколько направляющих хранит одна ось: больше — уже не разметка, а мусор. */
export const GUIDE_LIMIT = 100

/**
 * Направляющие редактора: вертикальные (`x`) и горизонтальные (`y`).
 *
 * Живут в документе, а не в localStorage: линейка — часть макета, её хочется
 * увидеть в другом сеансе и закоммитить рядом с холстом. Мусор отбрасывается
 * молча (как и в узле): координата обязана быть конечным числом, значения
 * сортируются и дедуплицируются, лишние обрезаются по `GUIDE_LIMIT`.
 *
 * Пустой набор остаётся пустым объектом, а не парой массивов: холст без
 * направляющих не должен обрастать полями при каждой записи (то же правило,
 * что у `autoW`/`autoH`).
 *
 * @param {object} raw Сырое поле `guides`.
 * @returns {{x: number[], y: number[]}}
 */
export function normalizeGuides(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const axis = (value) => {
    const list = Array.isArray(value) ? value : []
    const out = []
    for (const item of list) {
      const n = num(item, null)
      if (n === null) continue
      const rounded = Math.round(n * 100) / 100
      if (!out.includes(rounded)) out.push(rounded)
    }
    out.sort((a, b) => a - b)
    return out.slice(0, GUIDE_LIMIT)
  }
  return { x: axis(source.x), y: axis(source.y) }
}

/** Есть ли в документе хоть одна направляющая. */
export function hasGuides(guides) {
  const normalized = normalizeGuides(guides)
  return normalized.x.length > 0 || normalized.y.length > 0
}

/**
 * Канонический документ: формат, версия, токены, компоненты, направляющие, корень.
 *
 * @param {object} doc Сырой документ.
 * @param {string} fallbackId id, если в документе его нет.
 * @returns {object}
 */
export function normalizeDoc(doc, fallbackId = 'canvas') {
  const raw = isPlainObject(doc) ? doc : {}
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : fallbackId
  const root = raw.root && typeof raw.root === 'object'
    ? normalizeNode({ ...raw.root, id: 'root', type: 'frame', locked: true })
    : defaultDocument(id, id).root
  root.id = 'root'
  root.type = 'frame'
  root.locked = true
  if (!Array.isArray(root.children)) root.children = []
  const components = {}
  if (isPlainObject(raw.components)) {
    for (const [key, value] of Object.entries(raw.components)) {
      if (!ID_RE.test(key) || !isPlainObject(value)) continue
      components[key] = normalizeComponent(key, value)
    }
  }
  const normalized = {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    id,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
    device: DEVICE_PRESETS[raw.device] ? raw.device : 'mobile',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    tokens: normalizeTokens(raw.tokens),
    components,
    root,
  }
  const guides = normalizeGuides(raw.guides)
  if (hasGuides(guides)) normalized.guides = guides
  return normalized
}

/**
 * Канонический патч параметров вариации: сохраняются только названные поля.
 *
 * `normalizeProps` дополняет пропущенное значениями по умолчанию — для
 * объявления это верно, а для патча вариации разрушительно: `{ label: { default:
 * 'Основная' } }` получило бы `target: 'root'` и перебило бы цель, объявленную у
 * компонента.
 */
function normalizePropsPatch(raw) {
  const props = {}
  if (!isPlainObject(raw)) return props
  for (const [name, spec] of Object.entries(raw)) {
    if (!ID_RE.test(name) || !isPlainObject(spec)) continue
    const patch = {}
    if (PROP_TYPES.includes(spec.type)) patch.type = spec.type
    if (spec.default !== undefined) patch.default = spec.default
    if (typeof spec.description === 'string') patch.description = spec.description
    if (typeof spec.target === 'string' && spec.target !== '') patch.target = spec.target
    if (typeof spec.property === 'string' && spec.property !== '') patch.property = spec.property
    props[name] = patch
  }
  return props
}

/** Типы объявленных параметров — те же, что понимает панель. */
export const PROP_TYPES = ['text', 'color', 'number', 'boolean', 'token']

/** Канонические объявленные параметры: тип, значение, цель и свойство. */
function normalizeProps(raw) {
  const props = {}
  if (!isPlainObject(raw)) return props
  for (const [name, spec] of Object.entries(raw)) {
    if (!ID_RE.test(name)) continue
    const s = isPlainObject(spec) ? spec : {}
    props[name] = {
      type: PROP_TYPES.includes(s.type) ? s.type : 'text',
      default: s.default ?? (s.type === 'number' ? 0 : s.type === 'boolean' ? false : ''),
      description: typeof s.description === 'string' ? s.description : '',
      target: typeof s.target === 'string' && s.target !== '' ? s.target : 'root',
      property: typeof s.property === 'string' && s.property !== '' ? s.property : defaultPropProperty(s.type),
    }
  }
  return props
}

/**
 * Канонический компонент: ключ, имя, шаблон-узел, описанные свойства, вариации.
 *
 * Вариация (`variants[name]`) наследует шаблон и параметры компонента и может
 * заменить шаблон целиком (`node`) или поля отдельных параметров (`props`).
 * Так «primary» и «secondary» остаются одним компонентом с общим списком
 * параметров, а не двумя независимыми: инстанс при переключении вариации не
 * теряет переопределения.
 */
export function normalizeComponent(key, value) {
  const raw = isPlainObject(value) ? value : {}
  const node = normalizeNode({ ...(isPlainObject(raw.node) ? raw.node : {}), x: 0, y: 0 })
  const variants = {}
  if (isPlainObject(raw.variants)) {
    for (const [name, spec] of Object.entries(raw.variants)) {
      if (!ID_RE.test(name) || !isPlainObject(spec)) continue
      const variant = {}
      if (typeof spec.name === 'string' && spec.name !== '') variant.name = spec.name
      if (typeof spec.description === 'string' && spec.description !== '') variant.description = spec.description
      if (isPlainObject(spec.node)) variant.node = normalizeNode({ ...spec.node, x: 0, y: 0 })
      if (isPlainObject(spec.props)) variant.props = normalizePropsPatch(spec.props)
      variants[name] = variant
    }
  }
  return {
    key,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : key,
    description: typeof raw.description === 'string' ? raw.description : '',
    node,
    props: normalizeProps(raw.props),
    variants,
  }
}

/**
 * Действующие параметры компонента с учётом вариации: объявление компонента
 * плюс поля, переопределённые вариацией.
 */
export function componentProps(component, variant) {
  const base = isPlainObject(component?.props) ? component.props : {}
  const spec = component?.variants?.[variant]
  const patch = isPlainObject(spec?.props) ? spec.props : {}
  const out = {}
  for (const name of new Set([...Object.keys(base), ...Object.keys(patch)])) {
    out[name] = { ...(base[name] ?? {}), ...(patch[name] ?? {}) }
  }
  return out
}

/** Шаблон компонента с учётом вариации: вариация заменяет шаблон целиком. */
export function componentTemplate(component, variant) {
  const spec = component?.variants?.[variant]
  const source = isPlainObject(spec?.node) ? spec.node : component?.node
  return JSON.parse(JSON.stringify(source ?? {}))
}

/** Имя вариации для подписи: `name` из объявления, иначе сам ключ. */
export function variantName(component, variant) {
  const spec = component?.variants?.[variant]
  if (isPlainObject(spec) && typeof spec.name === 'string' && spec.name !== '') return spec.name
  return typeof variant === 'string' ? variant : ''
}

/** Свойство узла, которым управляет объявленный параметр компонента. */
export function defaultPropProperty(type) {
  return { text: 'text.value', color: 'style.fill', token: 'style.fill', number: 'w', boolean: 'visible' }[type] ?? 'text.value'
}

/** Токены: только плоские группы «примитив → значение». */
export function normalizeTokens(tokens) {
  const base = defaultTokens()
  if (!isPlainObject(tokens)) return base
  const out = {}
  for (const [group, values] of Object.entries(tokens)) {
    if (!ID_RE.test(group)) continue
    if (!isPlainObject(values)) continue
    const clean = {}
    for (const [name, value] of Object.entries(values)) {
      if (!ID_RE.test(name)) continue
      if (isPlainObject(value)) {
        const nested = {}
        for (const [k, v] of Object.entries(value)) {
          if (ID_RE.test(k) && isPrimitive(v)) nested[k] = v
        }
        clean[name] = nested
      } else if (isPrimitive(value)) {
        clean[name] = value
      }
    }
    out[group] = clean
  }
  return Object.keys(out).length > 0 ? out : base
}

/** Примитив, допустимый как значение токена. */
function isPrimitive(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * Плоская карта токенов: `{ 'color.bg': '#0b0d10', 'text.h1': {...} }`.
 *
 * @param {object} doc Документ.
 * @returns {Record<string, unknown>}
 */
export function flattenTokens(doc) {
  const out = {}
  const tokens = isPlainObject(doc?.tokens) ? doc.tokens : {}
  for (const [group, values] of Object.entries(tokens)) {
    if (!isPlainObject(values)) continue
    for (const [name, value] of Object.entries(values)) {
      out[`${group}.${name}`] = value
      if (isPlainObject(value)) {
        for (const [k, v] of Object.entries(value)) out[`${group}.${name}.${k}`] = v
      }
    }
  }
  return out
}

/**
 * Развернуть значение-ссылку в конкретное значение токена.
 *
 * @param {object} doc Документ.
 * @param {unknown} value Значение или `token:…`.
 * @param {unknown} [fallback] Что вернуть, если токен не найден.
 * @returns {unknown}
 */
export function resolveToken(doc, value, fallback = null) {
  const path = parseTokenRef(value)
  if (path === null) return value
  const flat = flattenTokens(doc)
  return Object.prototype.hasOwnProperty.call(flat, path) ? flat[path] : fallback
}

/**
 * Обойти дерево в глубину (родители раньше детей).
 *
 * @param {object} root Корень обхода.
 * @param {(node: object, parent: object|null, depth: number) => void} visit
 */
export function walk(root, visit) {
  const seen = new Set()
  const stack = [[root, null, 0]]
  while (stack.length > 0) {
    const [node, parent, depth] = stack.pop()
    if (!node || typeof node !== 'object' || seen.has(node)) continue
    seen.add(node)
    visit(node, parent, depth)
    const children = Array.isArray(node.children) ? node.children : []
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push([children[i], node, depth + 1])
  }
}

/**
 * Найти узел по id.
 *
 * @param {object} root Корень.
 * @param {string} id Искомый id.
 * @returns {object|null}
 */
export function findNode(root, id) {
  let found = null
  walk(root, (node) => {
    if (found === null && node.id === id) found = node
  })
  return found
}

/**
 * Найти родителя узла.
 *
 * @param {object} root Корень.
 * @param {string} id Искомый id.
 * @returns {object|null} Родитель или null для корня и ненайденных.
 */
export function findParent(root, id) {
  let parent = null
  walk(root, (node, nodeParent) => {
    if (parent === null && node.id === id) parent = nodeParent
  })
  return parent
}

/**
 * Путь от корня до узла (включая сам узел).
 *
 * @param {object} root Корень.
 * @param {string} id Искомый id.
 * @returns {object[]}
 */
export function pathTo(root, id) {
  const chain = []
  const search = (node, trail) => {
    const next = [...trail, node]
    if (node.id === id) {
      chain.push(...next)
      return true
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      if (search(child, next)) return true
    }
    return false
  }
  search(root, [])
  return chain
}

/** Глубокая копия документа (документ — чистый JSON). */
export function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc))
}

/**
 * Абсолютная рамка узла в координатах корня (учитывает вложенность и поворот
 * не учитывает — для hit-test и направляющих этого достаточно).
 *
 * @param {object} root Корень.
 * @param {string} id Искомый id.
 * @returns {{x: number, y: number, w: number, h: number}|null}
 */
export function absoluteRect(root, id) {
  const chain = pathTo(root, id)
  if (chain.length === 0) return null
  let x = 0
  let y = 0
  for (const node of chain) {
    x += num(node.x, 0)
    y += num(node.y, 0)
  }
  const last = chain[chain.length - 1]
  return { x, y, w: num(last.w, 0), h: num(last.h, 0) }
}

/** Сколько узлов в дереве (без корня). */
export function countNodes(root) {
  let count = 0
  walk(root, (node) => {
    if (node !== root) count += 1
  })
  return count
}

/**
 * Пересчитать позиции детей фрейма в режиме потока.
 *
 * Свободная модель остаётся основной: если `layout.mode === 'none'`, дети
 * сохраняют свои `x`/`y`. В потоке позиции выводятся из порядка, `gap`,
 * `padding` и выравнивания, а размер фрейма подгоняется по содержимому, если
 * он не задан явно (`autoW`/`autoH`).
 *
 * `justify` распределяет свободное место по главной оси (`start`, `center`,
 * `end`, `space-between`), `align: 'stretch'` растягивает детей по поперечной.
 * Свободное место появляется только у фрейма с авторским размером по этой оси,
 * поэтому распределяющие значения сохраняют размер, а не подгоняют его по
 * содержимому. Панель повторяет ту же арифметику (`layoutFrame` в `client.js`).
 *
 * @param {object} frame Фрейм (мутируется вместе с детьми).
 * @param {object} [opts] `{ autoSize: boolean }`.
 * @returns {object} Тот же фрейм.
 */
export function layoutChildren(frame, opts = {}) {
  const layout = normalizeLayout(frame.layout)
  frame.layout = layout
  if (layout.mode === 'none' || !Array.isArray(frame.children)) return frame
  const visible = frame.children.filter((child) => child.visible !== false)
  const pad = layout.padding
  const horizontal = layout.mode === 'horizontal'
  const gap = layout.gap
  const mainStart = horizontal ? pad.l : pad.t
  const mainEnd = horizontal ? pad.r : pad.b
  const crossStart = horizontal ? pad.t : pad.l
  const crossEnd = horizontal ? pad.b : pad.r
  const mainOf = (child) => (horizontal ? num(child.w, 0) : num(child.h, 0))
  const crossOf = (child) => (horizontal ? num(child.h, 0) : num(child.w, 0))
  let contentMain = 0
  for (let index = 0; index < visible.length; index += 1) {
    contentMain += (index > 0 ? gap : 0) + mainOf(visible[index])
  }
  const authoredMain = Math.max(0, (horizontal ? num(frame.w, 0) : num(frame.h, 0)) - mainStart - mainEnd)
  const keepAuthored = layout.justify !== 'start' && authoredMain > 0
  if (opts.autoSize !== false && !keepAuthored) {
    if (horizontal) {
      if (frame.autoW !== false) frame.w = contentMain + mainStart + mainEnd
    } else if (frame.autoH !== false) {
      frame.h = contentMain + mainStart + mainEnd
    }
  }
  const mainSize = Math.max(0, (horizontal ? num(frame.w, 0) : num(frame.h, 0)) - mainStart - mainEnd)
  const crossSize = Math.max(0, (horizontal ? num(frame.h, 0) : num(frame.w, 0)) - crossStart - crossEnd)
  const free = Math.max(0, mainSize - contentMain)
  const stretching = layout.align === 'stretch' && crossSize > 0
  let cursor = mainStart
  let step = gap
  if (layout.justify === 'center') cursor += free / 2
  else if (layout.justify === 'end') cursor += free
  else if (layout.justify === 'space-between' && visible.length > 1) step = gap + free / (visible.length - 1)
  for (const child of visible) {
    if (stretching) {
      if (horizontal) child.h = crossSize
      else child.w = crossSize
    }
    if (horizontal) {
      child.x = cursor
      child.y = stretching ? crossStart : crossOffset(layout.align, crossStart, crossSize, crossOf(child))
    } else {
      child.y = cursor
      child.x = stretching ? crossStart : crossOffset(layout.align, crossStart, crossSize, crossOf(child))
    }
    cursor += mainOf(child) + step
  }
  if (opts.autoSize !== false && !stretching) {
    const contentCross = visible.reduce((max, child) => Math.max(max, crossOf(child)), 0) + crossStart + crossEnd
    if (horizontal) {
      if (frame.autoH !== false) frame.h = Math.max(num(frame.h, 0), contentCross)
    } else if (frame.autoW !== false) {
      frame.w = Math.max(num(frame.w, 0), contentCross)
    }
  }
  return frame
}

/** Смещение по поперечной оси для режима выравнивания. */
function crossOffset(align, start, available, size) {
  if (align === 'center') return start + Math.max(0, (available - size) / 2)
  if (align === 'end') return start + Math.max(0, available - size)
  return start
}

/**
 * Проверить документ и вернуть список замечаний.
 *
 * Проверки намеренно «дизайнерские», а не только структурные: агент должен
 * получать ответ на вопрос «макет готов к использованию?», а не «JSON валиден?».
 *
 * @param {object} doc Документ.
 * @param {object} [opts] `{ contrast: boolean }`.
 * @returns {{issues: Array<object>, stats: object}}
 */
export function validateDoc(doc, opts = {}) {
  const issues = []
  const flat = flattenTokens(doc)
  const ids = new Map()
  const components = isPlainObject(doc.components) ? doc.components : {}
  let total = 0

  walk(doc.root, (node, parent, depth) => {
    if (node !== doc.root) total += 1
    if (ids.has(node.id)) {
      issues.push({ level: 'error', code: 'duplicate-id', node: node.id, message: `id «${node.id}» встречается дважды.` })
    } else {
      ids.set(node.id, node)
    }
    if (depth > 12) {
      issues.push({ level: 'warn', code: 'deep-nesting', node: node.id, message: `Узел «${node.name}» вложен глубже 12 уровней.` })
    }
    if (node.type === 'instance') {
      if (!node.component || !components[node.component]) {
        issues.push({
          level: 'error',
          code: 'broken-instance',
          node: node.id,
          message: `Инстанс «${node.name}» ссылается на несуществующий компонент «${node.component || '—'}».`,
        })
      }
      if (node.component && components[node.component] && node.variant
        && !isPlainObject(components[node.component].variants?.[node.variant])) {
        issues.push({
          level: 'warn',
          code: 'missing-variant',
          node: node.id,
          message: `Инстанс «${node.name}» ссылается на вариацию «${node.variant}», которой у компонента «${node.component}» нет.`,
        })
      }
      if (Array.isArray(node.children) && node.children.length > 0) {
        issues.push({
          level: 'warn',
          code: 'instance-children',
          node: node.id,
          message: `У инстанса «${node.name}» авторские дети (${node.children.length}): содержимое берётся из компонента, эти узлы не отрисуются и не экспортируются.`,
        })
      }
    }
    for (const [field, value] of styleRefs(node)) {
      const path = parseTokenRef(value)
      if (path !== null && !Object.prototype.hasOwnProperty.call(flat, path)) {
        issues.push({
          level: 'warn',
          code: 'missing-token',
          node: node.id,
          message: `Поле ${field} ссылается на отсутствующий токен «${path}».`,
        })
      }
    }
    if (node.type === 'text' && typeof node.text?.value !== 'string') {
      issues.push({ level: 'warn', code: 'empty-text', node: node.id, message: `Текст «${node.name}» без значения.` })
    }
    if (node.type === 'image' && !node.image?.src) {
      issues.push({ level: 'info', code: 'image-without-src', node: node.id, message: `Изображение «${node.name}» без источника.` })
    }
    if (parent && parent.type === 'frame') {
      const rect = { x: node.x, y: node.y, w: node.w, h: node.h }
      const out = rect.x < -1 || rect.y < -1
        || rect.x + rect.w > num(parent.w, 0) + 1
        || rect.y + rect.h > num(parent.h, 0) + 1
      if (out && parent.clip !== false) {
        issues.push({
          level: 'info',
          code: 'clipped-child',
          node: node.id,
          message: `«${node.name}» выходит за границы фрейма «${parent.name}» и будет обрезан.`,
        })
      }
    }
  })

  if (total > MAX_NODES) {
    issues.push({ level: 'error', code: 'too-many-nodes', message: `Узлов ${total}, предел ${MAX_NODES}.` })
  }

  const emptyFrames = []
  walk(doc.root, (node) => {
    if (node.type === 'frame' && node !== doc.root && (node.children ?? []).length === 0) emptyFrames.push(node.name)
  })
  if (emptyFrames.length > 0) {
    issues.push({
      level: 'info',
      code: 'empty-frames',
      message: `Пустые фреймы: ${emptyFrames.slice(0, 8).join(', ')}${emptyFrames.length > 8 ? ` и ещё ${emptyFrames.length - 8}` : ''}.`,
    })
  }

  if (opts.contrast !== false) issues.push(...contrastIssues(doc, flat))

  const errors = issues.filter((issue) => issue.level === 'error').length
  const warnings = issues.filter((issue) => issue.level === 'warn').length
  return {
    issues,
    stats: {
      nodes: total,
      frames: countType(doc.root, 'frame'),
      texts: countType(doc.root, 'text'),
      instances: countType(doc.root, 'instance'),
      components: Object.keys(components).length,
      tokens: Object.keys(flat).length,
      errors,
      warnings,
      ok: errors === 0,
    },
  }
}

/** Пары «поле → значение» в стиле узла, где допустимы ссылки на токены. */
function styleRefs(node) {
  const pairs = []
  const style = node.style ?? {}
  if (style.fill !== undefined) pairs.push(['fill', style.fill])
  if (style.stroke && style.stroke.color !== undefined) pairs.push(['stroke.color', style.stroke.color])
  if (style.shadow && style.shadow.color !== undefined) pairs.push(['shadow.color', style.shadow.color])
  if (style.radius !== undefined) pairs.push(['radius', style.radius])
  if (node.text?.color !== undefined) pairs.push(['text.color', node.text.color])
  if (node.text?.token !== undefined) pairs.push(['text.token', node.text.token])
  return pairs
}

/** Сколько узлов заданного типа в дереве. */
function countType(root, type) {
  let count = 0
  walk(root, (node) => {
    if (node.type === type) count += 1
  })
  return count
}

/**
 * Проверка контраста текста и фона.
 *
 * Порог зависит от размера: 3:1 для крупного текста (24px и больше, либо
 * полужирный от 18.66px) и 4.5:1 для мелкого — как в WCAG AA. Цвета читаются из
 * hex, `rgb()`/`rgba()` и ссылок на токены; полупрозрачный текст смешивается с
 * фоном. Цвет, который не задан, проверить нечем: панель и экспорт отдают его
 * темой, поэтому такой узел пропускается.
 *
 * @param {object} doc Документ.
 * @param {object} flat Плоские токены (`flattenTokens`).
 * @returns {Array<object>} Замечания уровня `warn`.
 */
function contrastIssues(doc, flat) {
  const issues = []
  walk(doc.root, (node, parent) => {
    if (node.type !== 'text') return
    const fg = parseColor(resolveToken(doc, node.text?.color, null))
    if (fg === null) return
    const bg = parseColor(findFill(doc, parent))
    if (bg === null) return
    const ratio = contrastRatio(blendOver(fg, bg.rgb), bg.rgb)
    const size = textMetric(node, flat, 'size', 16)
    const weight = textMetric(node, flat, 'weight', 400)
    const large = size >= 24 || (weight >= 700 && size >= 18.66)
    const threshold = large ? 3 : 4.5
    if (ratio < threshold) {
      issues.push({
        level: 'warn',
        code: 'low-contrast',
        node: node.id,
        message: `Контраст текста «${node.name}» к фону ${ratio.toFixed(2)}:1 — ниже ${threshold}:1 для ${large ? 'крупного' : 'мелкого'} текста (${Math.round(size)}px).`,
      })
    }
  })
  return issues
}

/** Размер или насыщенность текста: явное значение узла, затем токен типографики. */
function textMetric(node, flat, field, fallback) {
  const explicit = node.text?.[field]
  if (Number.isFinite(explicit)) return Number(explicit)
  const token = typeof node.text?.token === 'string' ? flat[`${node.text.token}.${field}`] : undefined
  return Number.isFinite(token) ? Number(token) : fallback
}

/**
 * Разобрать цвет в `{ rgb, alpha }`: hex (`#rgb`, `#rrggbb`, `#rrggbbaa`),
 * `rgb(...)`, `rgba(...)`.
 *
 * @param {unknown} value Значение из стиля или токена.
 * @returns {{rgb: number[], alpha: number}|null}
 */
function parseColor(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const hexMatch = /^#([0-9a-f]{3,8})$/i.exec(text)
  if (hexMatch) {
    let hex = hexMatch[1]
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((char) => char + char).join('')
    if (hex.length !== 6 && hex.length !== 8) return null
    return {
      rgb: [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16)),
      alpha: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    }
  }
  const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(text)
  if (!rgbMatch) return null
  const parts = rgbMatch[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null
  const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? Math.max(0, Math.min(1, parts[3])) : 1
  return {
    rgb: parts.slice(0, 3).map((part) => Math.max(0, Math.min(255, Math.round(part)))),
    alpha,
  }
}

/** Наложить полупрозрачный цвет на фон: контраст считается по видимому цвету. */
function blendOver(color, background) {
  if (color.alpha >= 1) return color.rgb
  return color.rgb.map((channel, index) => Math.round(channel * color.alpha + background[index] * (1 - color.alpha)))
}

/** Ближайшая заливка среди предков (для расчёта контраста). */
function findFill(doc, node) {
  let current = node
  while (current) {
    const fill = resolveToken(doc, current.style?.fill, null)
    const hex = toHex(fill)
    if (hex !== null && current.style?.opacity !== 0) return fill
    current = findParent(doc.root, current.id)
  }
  return null
}

/** Разбор `#rgb`, `#rrggbb`, `#rrggbbaa` в `[r, g, b]`. */
export function toHex(value) {
  if (typeof value !== 'string') return null
  const match = /^#([0-9a-f]{3,8})$/i.exec(value.trim())
  if (!match) return null
  let hex = match[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  if (hex.length === 4) hex = hex.split('').map((c) => c + c).join('')
  if (hex.length !== 6 && hex.length !== 8) return null
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

/** Относительная яркость по WCAG. */
export function luminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Коэффициент контраста двух цветов по WCAG. */
export function contrastRatio(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

// ------------------------------------------------------------ components ----

/**
 * Развернуть инстанс в дерево компонента.
 *
 * Инстанс — живая ссылка, а не копия: в документе у него нет `children`, а
 * геометрия, имя и переопределения лежат на самом узле. Шаблон разворачивается
 * при отрисовке и экспорте, поэтому правка компонента обновляет все инстансы
 * сразу — как в Figma.
 *
 * Идентификаторы развёрнутых узлов получают префикс инстанса
 * (`<instanceId>/<templateId>`), чтобы DOM и hit-test оставались уникальными.
 *
 * @param {object} doc Документ (нужен для доступа к `components`).
 * @param {object} instance Узел типа `instance`.
 * @returns {object} Развёрнутый узел с детьми.
 */
export function expandInstance(doc, instance) {
  const component = isPlainObject(doc?.components) ? doc.components[instance.component] : null
  const base = {
    ...instance,
    type: 'frame',
    component: instance.component,
    children: [],
  }
  if (!component) {
    base.name = instance.name || instance.component || 'Instance'
    base.missing = true
    return base
  }
  const template = componentTemplate(component, instance.variant)
  applyOverrides(template, component, instance.overrides ?? {}, instance.variant)
  remapIds(template, instance.id)
  const expanded = {
    ...template,
    id: instance.id,
    type: template.type,
    name: instance.name || component.name,
    variant: instance.variant,
    x: num(instance.x, 0),
    y: num(instance.y, 0),
    w: num(instance.w, num(template.w, 100)),
    h: num(instance.h, num(template.h, 100)),
    rotation: num(instance.rotation, 0),
    visible: instance.visible !== false,
    locked: instance.locked === true,
    component: instance.component,
    instanceOf: instance.id,
    children: template.children ?? [],
  }
  return expanded
}

/**
 * Рекурсивно развернуть дерево: все инстансы, включая вложенные, заменяются
 * содержимым своих компонентов.
 *
 * Именно это дерево получает редактор и экспортёр: правила разворачивания и
 * переопределений живут в одном месте и не дублируются на клиенте.
 *
 * @param {object} doc Документ.
 * @param {object} node Узел.
 * @param {number} [depth] Текущая глубина (защита от рекурсии в битых данных).
 * @returns {object} Развёрнутая копия узла.
 */
export function expandTree(doc, node, depth = 0) {
  const base = node.type === 'instance' ? expandInstance(doc, node) : node
  const children = Array.isArray(base.children) ? base.children : []
  if (children.length === 0 || depth >= 32) return { ...base, children: [] }
  return { ...base, children: children.map((child) => expandTree(doc, child, depth + 1)) }
}

/**
 * Дети инстанса (развёрнутые) либо собственные дети обычного узла.
 *
 * @param {object} doc Документ.
 * @param {object} node Узел.
 * @returns {object[]}
 */
export function childrenOf(doc, node) {
  if (node.type === 'instance') return expandInstance(doc, node).children ?? []
  return Array.isArray(node.children) ? node.children : []
}

/** Переименовать id узлов поддерева с префиксом владельца. */
function remapIds(node, ownerId) {
  node.id = `${ownerId}/${node.id}`
  for (const child of node.children ?? []) remapIds(child, ownerId)
}

/**
 * Применить переопределения инстанса к копии шаблона.
 *
 * Два вида ключей:
 *  - объявленный параметр компонента (`label`, `tone`) — значение ложится в
 *    `property`-путь узла-цели (`target`): `root`, `#Имя` или `text`;
 *  - произвольный путь узла (`style.fill`, `text.value`, `w`) — escape hatch
 *    для точечной правки без объявления параметра.
 *
 * @param {object} root Копия шаблона (мутируется).
 * @param {object} component Определение компонента.
 * @param {Record<string, unknown>} overrides Переопределения.
 * @returns {object} Тот же корень.
 */
export function applyOverrides(root, component, overrides, variant) {
  const specs = componentProps(component, variant)
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const spec = specs[key]
    if (spec) {
      const target = resolveTarget(root, spec.target)
      if (target) setPath(target, spec.property ?? defaultPropProperty(spec.type), value)
      continue
    }
    setPath(root, key, value)
  }
  return root
}

/** Найти узел-цель параметра: `root`, `#Имя` или `text` (первый текстовый). */
export function resolveTarget(root, target) {
  const spec = typeof target === 'string' && target !== '' ? target : 'root'
  if (spec === 'root') return root
  if (spec === 'text') return firstText(root)
  if (spec.startsWith('#')) {
    const name = spec.slice(1)
    let found = null
    walk(root, (node) => {
      if (found === null && node.name === name) found = node
    })
    return found
  }
  const path = spec.split('.').filter(Boolean)
  let current = root
  for (const step of path) {
    const indexMatch = /^(.*)\[(\d+)\]$/.exec(step)
    if (indexMatch) {
      const [, field, index] = indexMatch
      const list = field === '' ? current.children : current[field]?.children
      current = Array.isArray(list) ? list[Number(index)] : undefined
    } else {
      current = current?.[step]
    }
    if (!current) return null
  }
  return current ?? null
}

/** Первый текстовый узел поддерева. */
export function firstText(root) {
  let found = null
  walk(root, (node) => {
    if (found === null && node.type === 'text') found = node
  })
  return found
}

/**
 * Записать значение по пути внутри узла (`text.value`, `style.fill`, `w`).
 *
 * `null` удаляет ключ, `undefined` игнорируется — так патч выражает и
 * «поставь», и «убери».
 *
 * @param {object} node Узел (мутируется).
 * @param {string} path Путь через точку.
 * @param {unknown} value Новое значение.
 * @returns {object} Тот же узел.
 */
export function setPath(node, path, value) {
  const steps = String(path).split('.').filter(Boolean)
  if (steps.length === 0 || value === undefined) return node
  let current = node
  for (let i = 0; i < steps.length - 1; i += 1) {
    const step = steps[i]
    if (!isPlainObject(current[step])) current[step] = {}
    current = current[step]
  }
  const last = steps[steps.length - 1]
  if (value === null) delete current[last]
  else current[last] = value
  return node
}

/** Прочитать значение по пути внутри узла. */
export function getPath(node, path) {
  const steps = String(path).split('.').filter(Boolean)
  let current = node
  for (const step of steps) {
    if (current === null || current === undefined) return undefined
    current = current[step]
  }
  return current
}

/**
 * Глубокое слияние патча в узел: `style`, `text`, `layout`, `image`, `overrides`
 * сливаются по ключам, остальное заменяется.
 *
 * @param {object} node Узел (мутируется).
 * @param {object} patch Патч.
 * @returns {object} Тот же узел.
 */
export function mergeNodePatch(node, patch) {
  if (!isPlainObject(patch)) return node
  const merged = ['style', 'text', 'layout', 'image', 'overrides']
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'type') continue
    if (merged.includes(key) && isPlainObject(value)) {
      const target = isPlainObject(node[key]) ? node[key] : {}
      for (const [k, v] of Object.entries(value)) {
        if (v === null) delete target[k]
        else if (k === 'padding' && isPlainObject(v)) target[k] = { ...(target[k] ?? {}), ...v }
        else target[k] = v
      }
      node[key] = target
    } else if (value === null) {
      delete node[key]
    } else {
      node[key] = value
    }
  }
  return node
}
