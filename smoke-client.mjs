/**
 * Статические проверки клиентской половины плагина (client.js).
 *
 * Браузерный модуль нельзя просто импортировать в Node — он ждёт
 * `window.__ModuleLoader__`. Поэтому проверяется контракт: способ загрузки,
 * регистрация слотов, наличие словарей локализации, отсутствие JSX и
 * `import`/`export`, а также что каждый вызов API указывает на известный
 * маршрут host-половины.
 *
 * Запуск: `node smoke-client.mjs`.
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ✓ ${label}`)
}

const source = await readFile(join(here, 'client.js'), 'utf8')
const lines = source.split('\n').length

// ------------------------------------------------------------ контракт ESM ----
assert.ok(!/^\s*import\s/m.test(source), 'в браузерном модуле не должно быть import')
assert.ok(!/^\s*export\s/m.test(source), 'в браузерном модуле не должно быть export')
ok('нет import/export — модуль грузится через загрузчик клиента')

assert.ok(source.includes('window.__ModuleLoader__.load('), 'нужен вызов window.__ModuleLoader__.load')
assert.match(source, /id:\s*'@local\/dsh-design-canvas'/)
ok('модуль зарегистрирован под id @local/dsh-design-canvas')

assert.ok(source.includes("require('react')"), 'React берётся из require')
assert.ok(!/<[A-Z][A-Za-z]*[\s/>]/.test(source.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '')), 'JSX не обнаружен')
ok('React через require, JSX отсутствует')

// -------------------------------------------------------------------- слоты ----
assert.ok(source.includes("'main'"), 'слот main')
assert.ok(source.includes("'sidebar.panellist'"), 'слот sidebar.panellist')
assert.match(source, /key:\s*PANEL_ID/)
assert.match(source, /id:\s*PANEL_ID/)
assert.match(source, /ctx\.locale\.register\(NS/)
assert.ok(source.includes('ctx.slots.inject'), 'слоты регистрируются через inject')
ok('оба слота и словари локализации на месте')

// -------------------------------------------------------------------- стили ----
assert.match(source, /setAttribute\('data-plugin'/, 'стиль помечается data-plugin')
assert.match(source, /--dsw-alias-/, 'стили используют токены темы')
const hardcoded = [...source.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0])
const inPalette = hardcoded.filter((color) => !source.includes(`'${color}'`) && !source.includes(`"${color}"`))
assert.equal(inPalette.length, 0, `хардкод-цвета вне данных: ${inPalette.slice(0, 5).join(', ')}`)
ok(`стили на токенах темы (${hardcoded.length} литеральных цветов — только палитра макета)`)

// --------------------------------------------------------------------- API ----
const routeCalls = [...source.matchAll(/\bapi\(\s*'([^']+)'/g)].map((m) => m[1])
assert.ok(routeCalls.length >= 12, `вызовов API всего ${routeCalls.length} — панель слишком пассивна`)
const known = new Set([
  '/projects', '/canvases', '/canvas', '/display', '/outline', '/tokens', '/components',
  '/validate', '/export', '/trash', '/config', '/create', '/init', '/apply', '/delete', '/restore',
])
const unknown = routeCalls.filter((route) => !known.has(route))
assert.equal(unknown.length, 0, `неизвестные маршруты: ${unknown.join(', ')}`)
ok(`маршруты API известны host-половине: ${[...new Set(routeCalls)].join(', ')}`)

// Панель держит документ в памяти и сохраняет его целиком (`POST /canvas`),
// а не батчами операций: так перетаскивание не ждёт round-trip на каждый шаг.
// Движок операций остаётся интерфейсом агента и маршрута `/apply`.
for (const required of ['/display', '/canvas', '/create', '/components', '/tokens', '/export', '/validate', '/projects', '/trash']) {
  assert.ok(routeCalls.includes(required), `панель должна обращаться к ${required}`)
}
assert.ok(routeCalls.includes('/restore'), 'панель должна уметь восстанавливать холст из корзины')
ok('панель использует все ключевые операции API')

const posts = [...source.matchAll(/api\(\s*'([^']+)'\s*,\s*\{[^}]*method:\s*'POST'/g)].map((m) => m[1])
assert.ok(posts.length >= 6, `POST-вызовов: ${posts.length}`)
ok(`запись идёт через POST: ${[...new Set(posts)].join(', ')}`)

// ------------------------------------------------------------ локализация ----
const ruBlock = /RU\s*=\s*\{([\s\S]*?)\n\s*\}/.exec(source)
assert.ok(ruBlock, 'словарь RU найден')
const ruKeys = [...ruBlock[1].matchAll(/^\s{6}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1])
assert.ok(ruKeys.length >= 40, `в словаре RU ${ruKeys.length} ключей — маловато для полноценной панели`)
const enBlock = /EN\s*=\s*\{([\s\S]*?)\n\s*\}/.exec(source)
assert.ok(enBlock, 'словарь EN найден')
ok(`словари локализации: RU ${ruKeys.length} ключей, EN ${[...enBlock[1].matchAll(/^\s{6}([A-Za-z][A-Za-z0-9_]*):/gm)].length}`)

for (const key of ['rulers', 'rulersHint', 'guides', 'guidesHint', 'guidesClear', 'snap', 'snapHint', 'viewOptions']) {
  assert.match(ruBlock[1], new RegExp(`\\n\\s{6}${key}: `), `в словаре RU нет ключа ${key}`)
  assert.match(enBlock[1], new RegExp(`\\n\\s{6}${key}: `), `в словаре EN нет ключа ${key}`)
}
ok('ключи разметки холста переведены в обоих словарях')

// --------------------------------------------------------------- разделы UI ----
const sections = [
  ['слои', /LayersTree|LayersPanel/],
  ['инспектор', /Inspector/],
  ['вьюпорт', /Viewport|CanvasStage/],
  ['компоненты', /ComponentsPanel|ComponentsTab/],
  ['токены', /TokensPanel|TokensTab/],
  ['тулбар', /Toolbar/],
  ['экспорт', /Export/],
  ['проверка', /validate|Validation/],
  ['undo/redo', /undo|redo/i],
  ['горячие клавиши', /keydown|onKeyDown/],
  ['ресайз', /resize|handle/i],
  ['зум/пан', /zoom|pan/i],
  ['наведение', /OverlayLayer/],
  ['линейки', /Rulers/],
  ['направляющие', /guideDrag|dc-guide/],
  ['привязка', /applySnap|snapEnabled/],
  ['замеры', /measureNode|padZonesOf/],
  ['рамка выделения', /marqueeNodes/],
  ['контекстное меню', /ContextMenu/],
  ['выравнивание', /AlignSection/],
  ['буфер обмена', /pasteClipboard|clipboard/],
  ['вход в контейнер', /enteredId/],
  ['превью компонента', /ComponentPreview/],
  ['параметры компонента', /componentProps|propTarget/],
  ['переопределения инстанса', /resetOverride|overridden/],
  ['подсветка инстансов', /dc-ov-mark|marks/],
]
for (const [label, pattern] of sections) {
  assert.match(source, pattern, `секция «${label}» не найдена`)
}
ok(`реализованы разделы: ${sections.map(([label]) => label).join(', ')}`)

assert.ok(!/TODO|FIXME|заглушка/i.test(source), 'в файле не должно остаться TODO-заглушек')
ok('TODO-заглушек нет')

// ------------------------------------------------------ вид холста (pan/zoom) ----
// Вид участвует и в математике курсора, и в отрисовке: если `transform` пропадёт,
// холст перестанет двигаться, а создание узла уедет от курсора при `zoom ≠ 1`.
// Обе половины обязаны читать один и тот же `view`, поэтому проверяются вместе.
const worldAt = source.indexOf("className: 'dc-world'")
assert.ok(worldAt > 0, 'мир холста `.dc-world` не найден')
const worldStyle = source.slice(worldAt, worldAt + 300)
assert.match(worldStyle, /transform:/, '`.dc-world` должен получать transform — иначе pan/zoom не виден')
const worldTransform = worldStyle.match(/translate\((.*?)\)\s*scale\((.*?)\)/)
assert.ok(worldTransform, 'сдвиг вида применяется через translate, масштаб — через scale')
const worldTranslate = worldTransform[1]
const zoomName = worldTransform[2].trim().replace(/^\$\{/, '').replace(/\}$/, '')
// Имя переменной, а не выражение: иначе `scale(${zoom || 1})` разошёлся бы с курсором.
assert.match(zoomName, /^[A-Za-z_$][A-Za-z0-9_$]*$/, `масштаб в transform должен быть именем переменной, а не «${zoomName}»`)
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
assert.match(worldTranslate, /view\?\.x/, 'сдвиг берёт `view.x`')
assert.match(worldTranslate, /view\?\.y/, 'сдвиг берёт `view.y`')
assert.match(source, new RegExp(`const ${escapeRe(zoomName)} = num\\(view\\?\\.zoom, 1\\)`), `масштаб \`${zoomName}\` берётся из view.zoom`)
assert.match(source, /viewRef\.current = view/, 'курсор читает тот же (живой) вид')
assert.match(source, new RegExp(`\\(event\\.clientX - rect\\.left - current\\.x\\) / current\\.${escapeRe(zoomName)}`), 'курсор делит на тот же масштаб, что и transform')
assert.match(source, new RegExp(`\\(event\\.clientY - rect\\.top - current\\.y\\) / current\\.${escapeRe(zoomName)}`), 'вертикаль считается той же формулой')
ok(`вид (pan/zoom) применяется к \`.dc-world\` и совпадает с математикой курсора (${zoomName})`)

// ------------------------------------------------------- виды диалогов панели ----
const dialogKindsAt = source.indexOf('DIALOG_KINDS = [')
assert.ok(dialogKindsAt > 0, 'список видов диалога `DIALOG_KINDS` не найден')
const dialogKinds = source.slice(dialogKindsAt, source.indexOf(']', dialogKindsAt))
assert.match(dialogKinds, /'init'/, 'инициализация проекта — вид `DialogHost`')
assert.ok(!dialogKinds.includes("'export'"), 'экспорт не вид `DialogHost` — у него свой компонент')
assert.match(source, /DIALOG_KINDS\.includes\(dialog\?\.kind\)/, 'DialogHost рисуется только для своих видов диалога')
const dialogHostAt = source.indexOf('function DialogHost(')
assert.ok(dialogHostAt > 0, 'компонент `DialogHost` не найден')
assert.match(source.slice(dialogHostAt), /if \(dialog\.kind !== 'init'\) return null/, 'ветка инициализации проекта не должна ловить чужие виды диалога')
ok('модалка «Инициализировать проект» не подменяет диалог экспорта')

// ------------------------------------------------- раскладка: паритет с host ----
// Панель сохраняет документ целиком, поэтому её `layoutFrame` обязан повторять
// `layoutChildren` из `schema.js` — и по значениям, и по арифметике. Расхождение
// меняет файл при простом перетаскивании узла, а заметить это в браузере почти
// нельзя. Функции вырезаются из исходника и выполняются в Node: правило раскладки
// — чистые функции без DOM, поэтому его можно прогнать по матрице случаев.
const {
  layoutChildren,
  defaultPropProperty: hostPropProperty,
  componentProps: hostComponentProps,
  componentTemplate: hostComponentTemplate,
} = await import('./schema.js')
const bodyOf = (text, name) => {
  const start = text.indexOf(`function ${name}(`)
  if (start < 0) return null
  const open = text.indexOf('{', text.indexOf(')', start))
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
const constOf = (text, name) => {
  const match = new RegExp(`const ${name} = \\[[^\\]]*\\]`).exec(text)
  assert.ok(match, `константа \`${name}\` не найдена в client.js`)
  return match[0]
}
const pieces = ['LAYOUT_MODES', 'ALIGN_VALUES', 'JUSTIFY_VALUES'].map((name) => constOf(source, name))
for (const name of ['num', 'isPlainObject', 'defaultLayout', 'normalizeLayout', 'crossOffset', 'layoutFrame']) {
  const body = bodyOf(source, name)
  assert.ok(body, `функция \`${name}\` не найдена в client.js`)
  pieces.push(body)
}
const panelLayoutFrame = new Function(`${pieces.join('\n')}\nreturn layoutFrame`)()

const kids = (count, w = 50, h = 30) => Array.from({ length: count }, (_, index) => ({ id: `c${index}`, type: 'rect', w, h }))
const flowCase = (init) => ({
  id: 'flow',
  type: 'frame',
  name: 'Flow',
  x: 12,
  y: 34,
  w: 300,
  h: 200,
  autoW: false,
  autoH: false,
  layout: { mode: 'horizontal', gap: 10, padding: { t: 5, r: 7, b: 9, l: 11 }, align: 'start', justify: 'start' },
  children: kids(2),
  ...init,
})
const flowCases = []
for (const mode of ['horizontal', 'vertical']) {
  for (const justify of ['start', 'center', 'end', 'space-between']) {
    for (const align of ['start', 'center', 'end', 'stretch']) {
      for (const count of [0, 1, 2, 3, 5]) {
        flowCases.push(flowCase({ layout: { mode, gap: 10, padding: { t: 5, r: 7, b: 9, l: 11 }, justify, align }, children: kids(count) }))
      }
    }
  }
}
// Мусор в `layout` и авторазмер: сервер нормализует вход, панель обязана так же.
flowCases.push(flowCase({ layout: { mode: 'horizontal', gap: -10, padding: { l: -5 }, justify: 'нет', align: 'нет' } }))
flowCases.push(flowCase({ layout: { mode: 'чужой', gap: '10', padding: null }, children: kids(3) }))
flowCases.push(flowCase({ layout: { mode: 'horizontal', gap: 10, align: 'start', justify: 'start' }, autoW: true, autoH: true, children: kids(3) }))
flowCases.push(flowCase({ layout: { mode: 'vertical', gap: 4, align: 'stretch', justify: 'center' }, autoW: true, autoH: true, children: kids(3, 40, 25) }))
flowCases.push(flowCase({ layout: { mode: 'horizontal', gap: 4, align: 'stretch', justify: 'space-between' }, children: [{ id: 'hidden', type: 'rect', w: 20, h: 20, visible: false }, ...kids(2)] }))
for (const item of flowCases) {
  const panel = panelLayoutFrame(JSON.parse(JSON.stringify(item)))
  const host = layoutChildren(JSON.parse(JSON.stringify(item)))
  assert.deepEqual(panel, host, `панель и host разошлись на ${JSON.stringify(item.layout)} (${item.children.length} детей)`)
}
ok(`раскладка панели совпадает с host на ${flowCases.length} случаях (значения и арифметика)`)

// --------------------------------------- геометрия разметки: поведение ----
// Те же чистые функции, что крутят наведение, замеры и привязку, прогоняются в
// Node: расхождение здесь не видно в браузере (обводка просто «чуть мимо»), а
// стоит оно неправильных координат при перетаскивании.
const geometryPieces = []
for (const name of ['num', 'isPlainObject', 'clamp', 'flattenRects', 'ancestorChain', 'nodePadding', 'padZonesOf', 'measureNode', 'applySnap', 'tidyGuides', 'rulerStep', 'guidesOf']) {
  const body = bodyOf(source, name)
  assert.ok(body, `функция \`${name}\` не найдена в client.js`)
  geometryPieces.push(body)
}
const geometry = new Function(`${geometryPieces.join('\n')}\nreturn { flattenRects, ancestorChain, measureNode, applySnap, tidyGuides, rulerStep, guidesOf, padZonesOf }`)()

const tree = {
  id: 'root',
  type: 'frame',
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  children: [{
    id: 'page',
    type: 'frame',
    x: 10,
    y: 20,
    w: 300,
    h: 400,
    layout: { mode: 'vertical', gap: 8, padding: { t: 12, r: 16, b: 12, l: 16 }, align: 'start', justify: 'start' },
    children: [
      { id: 'a', type: 'rect', x: 16, y: 12, w: 40, h: 20 },
      { id: 'b', type: 'rect', x: 16, y: 40, w: 60, h: 20 },
      { id: 'hidden', type: 'rect', x: 16, y: 68, w: 10, h: 10, visible: false },
    ],
  }],
}
const ctx = geometry.flattenRects(tree)
assert.deepEqual(ctx.rects.get('b'), { x: 26, y: 60, w: 60, h: 20 }, 'абсолютные координаты складываются по предкам')
assert.deepEqual(geometry.ancestorChain(ctx.parents, 'b'), ['b', 'page', 'root'], 'цепочка предков идёт от узла к корню')
ok('плоская геометрия: прямоугольники и цепочка предков за один обход')

const measured = geometry.measureNode(ctx, 'a')
assert.deepEqual(measured.gaps, { left: 16, top: 12, right: 244, bottom: 368 }, 'отступы считаются до внешней рамки родителя')
assert.equal(measured.neighbors.bottom?.gap, 8, 'ближайший сосед снизу найден')
assert.equal(measured.neighbors.top, undefined, 'соседа сверху нет')
assert.equal(measured.neighbors.bottom?.id, 'b', 'скрытый сосед в замеры не попадает')
assert.deepEqual(geometry.measureNode(ctx, 'page').gaps, { left: 0, top: 0, right: 0, bottom: 0 },
  'у родителя нулевого размера (корень документа) отступы не выдумываются')
const zones = geometry.padZonesOf(measured.parent.rect, measured.parent.pad)
assert.equal(zones.length, 4, 'padding разложен на четыре подложки')
assert.deepEqual(zones[3], { key: 'l', x: 10, y: 20, w: 16, h: 400 }, 'левая подложка padding совпадает с рамкой родителя')
ok(`замеры узла: отступы ${Object.values(measured.gaps).join('/')} и сосед снизу ${measured.neighbors.bottom.gap}`)

const snapBox = { x: 100, y: 50, w: 40, h: 20 }
const near = { x: [{ value: 104, rect: { x: 104, y: 0, w: 10, h: 10 }, kind: 'sibling' }], y: [{ value: 50, rect: { x: 0, y: 50, w: 10, h: 10 }, kind: 'parent' }] }
const snapped = geometry.applySnap(snapBox, near, { x: [], y: [] }, 6)
assert.equal(snapped.dx, 4, 'ближайший край подтягивается к линии в пределах порога')
assert.equal(snapped.dy, 0, 'уже совпавшая ось не сдвигается')
assert.equal(snapped.lines.length, 2, 'совпавшие линии возвращаются для отрисовки')
assert.equal(geometry.applySnap(snapBox, { x: [{ value: 200, rect: null, kind: 'sibling' }], y: [] }, { x: [], y: [] }, 6).dx, 0, 'линия за порогом не притягивает')
assert.equal(geometry.applySnap(snapBox, near, { x: [], y: [] }, 6, ['right']).dx, 0, 'запрещённый край не двигается при ресайзе')
assert.equal(geometry.applySnap(snapBox, near, { x: [], y: [] }, 6, ['left']).dx, 4, 'разрешённый край двигается')
const byGuide = geometry.applySnap(snapBox, { x: [], y: [] }, { x: [103], y: [] }, 6)
assert.equal(byGuide.dx, 3, 'направляющая участвует в привязке')
assert.equal(byGuide.lines[0].from, null, 'линия привязки к направляющей идёт через весь холст')
ok('привязка: порог, ближайший край, ограничение краёв и направляющие')

assert.deepEqual(geometry.tidyGuides([5, 'abc', 5, 3.14159, null, 200, -1]), [-1, 3.14, 5, 200], 'направляющие сортируются, дедуплицируются и чинятся от мусора')
assert.deepEqual(geometry.guidesOf({}, 'x'), [], 'документ без поля направляющих читается как пустой набор')
assert.deepEqual(geometry.guidesOf({ guides: { y: [3] } }, 'x'), [], 'чужая ось не подставляется')
for (const zoom of [0.05, 0.1, 0.5, 1, 2, 4, 8]) {
  assert.ok(geometry.rulerStep(zoom) * zoom >= 8, `штрих линейки на zoom ${zoom} не мельче восьми пикселей`)
}
ok('направляющие и шаг линеек: чистка значений, пустое поле, шаг штрихов')

// ------------------------------------ правки панели: выделение и копии ----
// Рамка выделения и копирование поддерева — тоже чистые функции, поэтому их
// поведение проверяется в Node, а не только живым прогоном.
const containers = constOf(source, 'CONTAINERS')
const marqueeSource = `${containers}\n${bodyOf(source, 'marqueeNodes')}\nreturn marqueeNodes`
const marquee = new Function(marqueeSource)()
const mTree = {
  id: 'root',
  type: 'frame',
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  children: [
    {
      id: 'frameA',
      type: 'frame',
      x: 0,
      y: 0,
      w: 200,
      h: 200,
      children: [
        { id: 'a1', type: 'rect', x: 10, y: 10, w: 40, h: 40 },
        { id: 'a2', type: 'rect', x: 100, y: 100, w: 40, h: 40 },
        { id: 'hidden', type: 'rect', x: 10, y: 100, w: 10, h: 10, visible: false },
      ],
    },
    { id: 'frameB', type: 'frame', x: 400, y: 0, w: 100, h: 100 },
  ],
}
const mCtx = geometry.flattenRects(mTree)
assert.deepEqual(marquee(mCtx, { x: 0, y: 0, w: 500, h: 300 }, 'root'), ['frameA', 'frameB'],
  'рамка по всему холсту выбирает верхние фреймы')
assert.deepEqual(marquee(mCtx, { x: 5, y: 5, w: 60, h: 60 }, 'frameA'), ['a1'],
  'рамка внутри контейнера выбирает его детей')
assert.deepEqual(marquee(mCtx, { x: 5, y: 5, w: 60, h: 120 }, 'frameA'), ['a1'],
  'скрытый узел в выделение не попадает')
assert.deepEqual(marquee(mCtx, { x: 30, y: 30, w: 200, h: 200 }, 'root'), ['frameA'],
  'рамка, которая лишь пересекает фрейм, выбирает фрейм, а не его детей')
ok('рамка выделения: верхний уровень, вход в контейнер и скрытые узлы')

const reidSource = `let idCounter = 0\n${bodyOf(source, 'clone')}\n${bodyOf(source, 'nextNodeId')}\n${bodyOf(source, 'reidTree')}\nreturn reidTree`
const reidTree = new Function(reidSource)()
const original = { id: 'card', type: 'frame', x: 5, y: 6, name: 'Card', children: [{ id: 'label', type: 'text', x: 1, y: 1 }] }
const copy = reidTree(original)
assert.notEqual(copy.id, 'card', 'копия получает новый id')
assert.notEqual(copy.children[0].id, 'label', 'дети копии тоже переименованы')
assert.notEqual(reidTree(original).id, copy.id, 'два копирования дают разные id')
assert.equal(copy.x, 5, 'геометрия копии сохраняется')
assert.equal(copy.children.length, 1, 'поддерево копируется целиком')
assert.equal(original.id, 'card', 'исходный узел не меняется')
ok('копия поддерева: новые id во всей ветке, оригинал не тронут')

// -------------------------------------------------------- жест: геометрия ----
// Жест пишет в узел координаты его родителя, а абсолютные прямоугольники нужны
// только габариту выделения и кандидатам привязки. Расхождение здесь — «улёт»
// вложенного узла на смещение контейнера при первом же движении, а увидеть это
// в браузере можно только случайно: на верхнем фрейме оба числа совпадают.
const gestureSource = [
  bodyOf(source, 'num'),
  bodyOf(source, 'ancestorChain'),
  bodyOf(source, 'movableRoots'),
  bodyOf(source, 'axisLock'),
  bodyOf(source, 'boundsOf'),
  bodyOf(source, 'rebaseNodes'),
  bodyOf(source, 'localBox'),
].join('\n')
const gesture = new Function(`${gestureSource}\nreturn { movableRoots, axisLock, boundsOf, rebaseNodes, localBox }`)()

const parents = new Map([['page', 'root'], ['card', 'page'], ['label', 'card'], ['btn', 'page'], ['root', null]])
assert.deepEqual(gesture.movableRoots(parents, ['card', 'label']), ['card'],
  'потомок выделенного предка не двигается второй раз')
assert.deepEqual(gesture.movableRoots(parents, ['card', 'btn']), ['card', 'btn'],
  'узлы разных веток двигаются оба')
assert.deepEqual(gesture.movableRoots(parents, ['orphan']), ['orphan'],
  'узел вне дерева не теряется')
assert.deepEqual(gesture.axisLock(12, 3, true), { dx: 12, dy: 0 }, 'Shift держит X, когда курсор ушёл по X')
assert.deepEqual(gesture.axisLock(3, -12, true), { dx: 0, dy: -12 }, 'Shift держит Y, когда курсор ушёл по Y')
assert.deepEqual(gesture.axisLock(3, -12, false), { dx: 3, dy: -12 }, 'без Shift обе оси свободны')
assert.deepEqual(gesture.axisLock(0, 0, true), { dx: 0, dy: 0 }, 'нулевой сдвиг остаётся нулевым')
assert.deepEqual(gesture.localBox({ x: 50, y: 310, w: 20, h: 20 }, { x: 40, y: 300 }),
  { x: 10, y: 10, w: 20, h: 20 }, 'абсолютный прямоугольник переводится в координаты родителя')
assert.deepEqual(gesture.boundsOf([{ x: 10, y: 20, w: 30, h: 40 }, { x: 60, y: 100, w: 10, h: 10 }]),
  { x: 10, y: 20, w: 60, h: 90 }, 'габарит набора считается по крайним точкам')
ok('жест: локальные координаты, ограничение по оси, корни выделения и габарит')

// ------------------------------------------- группа и фрейм: паритет с host ----
// Панель оборачивает выделение своей арифметикой (`groupSelection`), ядро — своей
// (`group`). Паритет проверяется на одном документе: расхождение даст разный
// результат у человека и у агента при одинаковом выделении.
const { applyOps } = await import('./ops.js')
const { defaultDocument } = await import('./schema.js')
const wrapBase = defaultDocument('wrap', 'Wrap')
const hostWrap = applyOps(wrapBase, [
  { op: 'add', parent: 'page', node: { id: 'wrap-a', type: 'rect', x: 10, y: 20, w: 30, h: 40 } },
  { op: 'add', parent: 'page', node: { id: 'wrap-b', type: 'rect', x: 60, y: 100, w: 10, h: 10 } },
  { op: 'group', ids: ['wrap-a', 'wrap-b'], as: 'frame' },
]).doc.root.children[0].children.find((node) => node.name === 'Frame')
const panelBounds = gesture.boundsOf([{ x: 10, y: 20, w: 30, h: 40 }, { x: 60, y: 100, w: 10, h: 10 }])
assert.deepEqual({ x: hostWrap.x, y: hostWrap.y, w: hostWrap.w, h: hostWrap.h }, panelBounds,
  'габарит панели совпадает с габаритом фрейма из ядра')
assert.deepEqual(hostWrap.children.map((node) => ({ id: node.id, x: node.x, y: node.y })),
  [{ id: 'wrap-a', x: 0, y: 0 }, { id: 'wrap-b', x: 50, y: 80 }],
  'ядро пересчитывает детей внутрь фрейма так же, как панель')
// Та же арифметика, которой оборачивает панель: габарит плюс пересчёт детей.
const panelChildren = gesture.rebaseNodes(
  [{ id: 'wrap-a', x: 10, y: 20 }, { id: 'wrap-b', x: 60, y: 100 }],
  panelBounds,
)
assert.deepEqual(panelChildren.map((node) => ({ id: node.id, x: node.x, y: node.y })),
  hostWrap.children.map((node) => ({ id: node.id, x: node.x, y: node.y })),
  'пересчёт детей панелью совпадает с ядром узел в узел')
assert.equal(gesture.boundsOf([{ x: 7, y: 9, w: 20, h: 20 }]).x, 7,
  'габарит одного узла — его собственный прямоугольник (объединение одного разрешено)')
ok('объединение в фрейм: габарит и пересчёт детей совпадают с операцией `group`')

// ------------------------------------- параметры компонента: паритет ----
// Редактор параметров панели повторяет правила host-схемы: тип значения и путь
// свойства по умолчанию. Расхождение здесь пишет параметр, который на сервере
// чинится в другое поле, — то есть правка из панели молча уезжает не туда.
const propHelpers = new Function(`${bodyOf(source, 'num')}\n${bodyOf(source, 'coercePropDefault')}\n${bodyOf(source, 'defaultPropProperty')}\nreturn { coercePropDefault, defaultPropProperty }`)()
for (const type of ['text', 'color', 'number', 'boolean', 'token']) {
  assert.equal(propHelpers.defaultPropProperty(type), hostPropProperty(type), `свойство по умолчанию для типа ${type} совпадает с host-схемой`)
}
assert.equal(propHelpers.coercePropDefault('number', '42'), 42, 'число приводится к числу')
assert.equal(propHelpers.coercePropDefault('boolean', 'true'), true, 'булево приводится к true')
assert.equal(propHelpers.coercePropDefault('boolean', 'нет'), false, 'остальное — false')
assert.equal(propHelpers.coercePropDefault('text', 5), '5', 'текстовое значение становится строкой')
ok('параметры компонента: путь свойства и приведение значения совпадают с host')

// --------------------------------------- вариации компонента: паритет ----
// Панель разворачивает инстанс сама (до сохранения), поэтому правила вариации —
// выбор шаблона и слияние параметров — обязаны совпадать с host-схемой.
const variantHelpers = new Function(`${bodyOf(source, 'isPlainObject')}\n${bodyOf(source, 'clone')}\n${bodyOf(source, 'componentProps')}\n${bodyOf(source, 'componentTemplate')}\nreturn { componentProps, componentTemplate }`)()
const variantFixture = {
  node: { type: 'frame', w: 120, h: 40 },
  props: { label: { type: 'text', default: 'A', target: '#Label', property: 'text.value' } },
  variants: {
    ghost: { name: 'Ghost', node: { type: 'rect', w: 80, h: 32 }, props: { label: { default: 'B' } } },
    small: { name: 'Small' },
  },
}
for (const variant of [undefined, 'ghost', 'small', 'нет-такой']) {
  assert.deepEqual(variantHelpers.componentProps(variantFixture, variant), hostComponentProps(variantFixture, variant),
    `действующие параметры вариации «${variant}» совпадают с host`)
  assert.deepEqual(variantHelpers.componentTemplate(variantFixture, variant), hostComponentTemplate(variantFixture, variant),
    `шаблон вариации «${variant}» совпадает с host`)
}
assert.equal(variantHelpers.componentProps(variantFixture, 'ghost').label.target, '#Label', 'патч вариации не теряет цель параметра')
ok('вариации компонента: выбор шаблона и слияние параметров совпадают с host')

console.log(`\nКлиентская половина: ${checks} проверок, ${lines} строк.\n`)
