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
const { layoutChildren } = await import('./schema.js')
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

console.log(`\nКлиентская половина: ${checks} проверок, ${lines} строк.\n`)
