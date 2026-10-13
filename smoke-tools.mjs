/**
 * Интеграционный тест host-половины: регистрация инструментов и HTTP-маршрут.
 *
 * Поднимает фальшивый контекст Cordis, собирает зарегистрированные инструменты
 * и прогоняет полный цикл работы агента. Затем дёргает обработчик маршрута
 * поддельными `req`/`res` — так проверяется и панельная половина API.
 *
 * Запуск: `node smoke-tools.mjs`.
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = await mkdtemp(join(tmpdir(), 'dsh-design-tools-home-'))
const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-design-tools-proj-'))
process.env.DSH_HOME = home
await mkdir(home, { recursive: true })

const { apply } = await import('./index.js')
const { DESIGN_ROUTE, createDesignHandler } = await import('./route.js')

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ✓ ${label}`)
}

// ------------------------------------------------------------ фальшивый ctx ----
const tools = new Map()
const effects = []
const ctx = {
  tools: { register: (tool) => tools.set(tool.name, tool) },
  get: () => undefined,
  inject: (names, callback) => callback({ effect: (fn) => effects.push(fn), webServer: undefined }),
  effect: (fn) => effects.push(fn),
}
apply(ctx, {})

assert.equal(tools.size, 9, `инструментов: ${tools.size}`)
assert.deepEqual(
  [...tools.keys()].sort(),
  ['design_apply', 'design_components', 'design_create', 'design_delete', 'design_export', 'design_projects', 'design_read', 'design_tokens', 'design_validate'],
)
ok(`зарегистрировано 9 инструментов: ${[...tools.keys()].join(', ')}`)

for (const tool of tools.values()) {
  assert.equal(typeof tool.execute, 'function', `${tool.name}: execute`)
  assert.ok(tool.description.length > 40, `${tool.name}: описание`)
  assert.ok(tool.parameters?.type === 'object', `${tool.name}: схема параметров`)
  assert.equal(typeof tool.output?.render, 'function', `${tool.name}: render`)
}
ok('у каждого инструмента есть описание, схема и рендер результата')

// Потокобезопасность объявляется по факту записи: `design_export` пишет файлы,
// поэтому безопасен только в режиме превью.
assert.equal(tools.get('design_export').isConcurrencySafe({ write: true }), false, 'экспорт с записью файлов не потокобезопасен')
assert.equal(tools.get('design_export').isConcurrencySafe({ write: false }), true, 'экспорт-превью файлы не пишет')
assert.equal(tools.get('design_apply').isConcurrencySafe({}), false, 'запись через apply не потокобезопасна')
assert.equal(tools.get('design_read').isConcurrencySafe({}), true, 'чтение потокобезопасно')
ok('потокобезопасность инструментов объявлена по факту записи')

// Путь регистрации маршрута: `ctx.inject(['webServer'])` + `scope.effect`. Первый
// контекст подставляет `webServer: undefined`, поэтому тело эффекта в нём не
// выполняется — регистрацию и снятие проверяем отдельным контекстом со шпионом.
const registeredRoutes = []
const routeDisposers = []
const webCtx = {
  tools: { register: () => () => {} },
  get: () => undefined,
  inject: (_names, callback) => callback({
    effect: (fn) => { routeDisposers.push(fn()) },
    webServer: {
      register: (route) => {
        registeredRoutes.push(route)
        return () => { registeredRoutes.length = 0 }
      },
    },
  }),
  effect: (fn) => { routeDisposers.push(fn()) },
}
apply(webCtx, {})
assert.equal(registeredRoutes.length, 1, 'маршрут зарегистрирован на webServer')
assert.equal(registeredRoutes[0].path, DESIGN_ROUTE, 'маршрут встал на ожидаемый путь')
assert.equal(registeredRoutes[0].kind, 'prefix', 'маршрут регистрируется префиксом')
assert.equal(typeof registeredRoutes[0].handler, 'function', 'у маршрута есть обработчик')
for (const dispose of routeDisposers) dispose()
assert.equal(registeredRoutes.length, 0, 'выгрузка плагина снимает маршрут')
ok('маршрут регистрируется через ctx.inject и снимается при выгрузке')

// ------------------------------------------------------------------ сценарий ----
const run = (toolName, args) => tools.get(toolName).execute(args)

const init = await run('design_projects', { init: projectRoot, title: 'Тестовый проект' })
assert.equal(init.initialized, true)
ok(`проект инициализирован: ${init.project.id}`)

const created = await run('design_create', { project: init.project.id, canvas: 'home', name: 'Home', device: 'mobile' })
assert.equal(created.canvas, 'home')
assert.equal(created.rev, 1)
ok(`холст создан: ${created.path.replace(projectRoot, '<tmp>')}`)

const applied = await run('design_apply', {
  project: init.project.id,
  canvas: 'home',
  ops: [
    { op: 'add', parent: 'page', node: { id: 'card', type: 'frame', name: 'Card', x: 16, y: 24, w: 358, h: 160, style: { fill: 'token:color.surface', radius: 'token:radius.md', shadow: 'token:shadow.card' } } },
    { op: 'add', parent: 'card', node: { id: 'cardTitle', type: 'text', name: 'CardTitle', x: 20, y: 20, w: 300, h: 30, text: { value: 'Заголовок карточки', token: 'text.h2' } } },
    { op: 'add', parent: 'card', node: { id: 'cardBody', type: 'text', name: 'CardBody', x: 20, y: 60, w: 300, h: 60, text: { value: 'Описание в две строки', token: 'text.body', color: 'token:color.fgMuted' } } },
    { op: 'define-component', key: 'card-basic', from: 'card', name: 'Card / Basic' },
    { op: 'instantiate', component: 'card-basic', parent: 'page', x: 16, y: 200, overrides: { label: 'Вторая карточка' } },
    { op: 'set-tokens', tokens: { color: { brand: '#ff7a1a' } } },
  ],
})
assert.equal(applied.applied.length, 6)
assert.equal(applied.rev, 2)
assert.equal(applied.stats.errors, 0)
ok(`батч применён: rev ${applied.rev}, узлов ${applied.stats.nodes}, компонентов ${applied.stats.components}`)

const conflict = await run('design_apply', {
  project: init.project.id,
  canvas: 'home',
  ops: [{ op: 'set-canvas', name: 'Nope' }],
  expectRev: 1,
}).then(() => null, (error) => error)
assert.ok(conflict, 'устаревшая ревизия отклонена')
assert.equal(conflict.status, 409)
ok('design_apply уважает expectRev (409)')

const read = await run('design_read', { project: init.project.id, canvas: 'home', mode: 'outline' })
assert.ok(read.outline.length >= 3, `узлов в дереве: ${read.outline.length}`)
assert.equal(read.stats.instances, 2)
ok(`дерево прочитано: ${read.outline.length} узлов, инстансов ${read.stats.instances}`)

const components = await run('design_components', { project: init.project.id, canvas: 'home', action: 'list' })
assert.equal(components.components.length, 1)
assert.equal(components.components[0].key, 'card-basic')
assert.ok(components.components[0].props.label, 'label выведен автоматически')
ok(`компонент: ${components.components[0].key}, инстансов ${components.components[0].instances}, параметров ${Object.keys(components.components[0].props).length}`)

const instanceRead = await run('design_read', { project: init.project.id, canvas: 'home', mode: 'node', node: 'card' })
assert.equal(instanceRead.resolved, true)
assert.ok(instanceRead.node.children.length > 0, 'инстанс развернулся в детей')
ok('mode=node разворачивает инстанс')

const tokens = await run('design_tokens', { project: init.project.id, canvas: 'home' })
assert.equal(tokens.flat['color.brand'], '#ff7a1a')
assert.equal(tokens.flat['text.h2.size'], 24)
ok(`токены: ${Object.keys(tokens.flat).length} значений, brand=${tokens.flat['color.brand']}`)

const validation = await run('design_validate', { project: init.project.id, canvas: 'home' })
assert.equal(validation.stats.errors, 0)
ok(`валидация: ошибок ${validation.stats.errors}, предупреждений ${validation.stats.warnings}, замечаний ${validation.issues.length}`)

const exported = await run('design_export', { project: init.project.id, canvas: 'home', mode: 'clean', preview: true })
assert.equal(exported.files.length, 3)
assert.ok(exported.preview.includes('<!doctype html>'))
assert.ok(exported.preview.includes('var(--color-surface'))
assert.ok(exported.preview.includes('data-node="card"'), 'инстанс присутствует в разметке')
assert.match(exported.preview, /data-node="card\//, 'дети инстанса неймспейснуты его id')
ok(`экспорт: ${exported.files.map((f) => f.name).join(', ')}, предупреждений ${exported.warnings.length}`)

const preview = await run('design_read', { project: init.project.id, canvas: 'home', mode: 'full' })
assert.equal(preview.doc.components['card-basic'].key, 'card-basic')
ok('mode=full отдаёт документ целиком')

// --------------------------------------------------------------------- маршрут ----
const handler = createDesignHandler()

/** Дёрнуть обработчик с поддельным req/res. */
async function request(method, path, body) {
  const req = {
    method,
    url: `${DESIGN_ROUTE}${path}`,
    on(event, callback) {
      if (event === 'data' && body !== undefined) callback(Buffer.from(JSON.stringify(body)))
      if (event === 'end') callback()
      return this
    },
    destroy() {},
  }
  const res = {
    status: 0,
    headers: null,
    payload: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.payload = payload
    },
  }
  await handler(req, res)
  return { status: res.status, body: res.payload ? JSON.parse(res.payload) : null }
}

const routeProjects = await request('GET', '/projects?canvases=1')
assert.equal(routeProjects.status, 200)
assert.ok(routeProjects.body.projects.some((entry) => entry.id === init.project.id))
ok('GET /projects отдаёт реестр')

const routeCanvas = await request('GET', `/canvas?project=${init.project.id}&id=home&mode=full`)
assert.equal(routeCanvas.status, 200)
assert.equal(routeCanvas.body.doc.id, 'home')
assert.equal(routeCanvas.body.rev, 2)
ok(`GET /canvas отдаёт документ и ревизию ${routeCanvas.body.rev}`)

const routeApply = await request('POST', '/apply', {
  project: init.project.id,
  canvas: 'home',
  ops: [{ op: 'add', parent: 'page', node: { type: 'rect', name: 'Из маршрута', x: 0, y: 800, w: 40, h: 40 } }],
  expectRev: 2,
})
assert.equal(routeApply.status, 200)
assert.equal(routeApply.body.rev, 3)
ok('POST /apply пишет через маршрут')

const routeConflict = await request('POST', '/apply', {
  project: init.project.id,
  canvas: 'home',
  ops: [{ op: 'set-canvas', name: 'Stale' }],
  expectRev: 2,
})
assert.equal(routeConflict.status, 409)
assert.equal(routeConflict.body.rev, 3)
ok('POST /apply возвращает 409 с актуальной ревизией')

const routeDisplay = await request('GET', `/display?project=${init.project.id}&id=home`)
assert.equal(routeDisplay.status, 200)
assert.equal(routeDisplay.body.display.children.length, 1, 'верхний фрейм один')
const displayCard = routeDisplay.body.display.children[0].children.find((node) => node.id === 'card')
assert.ok(displayCard, 'инстанс присутствует в дереве отрисовки')
assert.ok(displayCard.children.length >= 2, 'дети инстанса развёрнуты сервером')
assert.match(displayCard.children[0].id, /^card\//, 'дети неймспейснуты id инстанса')
ok(`GET /display отдаёт развёрнутое дерево (${displayCard.children.length} детей у инстанса)`)

const routeExport = await request('GET', `/export?project=${init.project.id}&id=home`)
assert.equal(routeExport.status, 200)
assert.ok(routeExport.body.preview.includes('<!doctype html>'))
ok('GET /export отдаёт превью с встроенным CSS')

const routeBadOp = await request('POST', '/apply', {
  project: init.project.id,
  canvas: 'home',
  ops: [{ op: 'teleport', id: 'card' }],
})
assert.equal(routeBadOp.status, 400)
assert.match(routeBadOp.body.error, /teleport/)
ok('неизвестная операция → 400 с понятной ошибкой')

const routeMissing = await request('GET', `/canvas?project=${init.project.id}&id=nope`)
assert.equal(routeMissing.status, 404)
ok('несуществующий холст → 404')

const routeTokens = await request('POST', '/tokens', {
  project: init.project.id,
  canvas: 'home',
  tokens: { color: { accent: '#7aa2ff' } },
})
assert.equal(routeTokens.status, 200)
assert.equal(routeTokens.body.flat['color.accent'], '#7aa2ff')
ok('POST /tokens меняет палитру')

const routeSaveBefore = await request('GET', `/canvas?project=${init.project.id}&id=home&mode=full`)
const routeSave = await request('POST', '/canvas', {
  project: init.project.id,
  canvas: 'home',
  doc: routeSaveBefore.body.doc,
  expectRev: routeSaveBefore.body.rev,
})
assert.equal(routeSave.status, 200, routeSave.body?.error ?? '')
assert.equal(routeSave.body.rev, routeSaveBefore.body.rev + 1)
assert.equal(routeSave.body.issues.length, 0, `сохранение вернуло ошибки: ${JSON.stringify(routeSave.body.issues)}`)
const routeSaveAfter = await request('GET', `/canvas?project=${init.project.id}&id=home&mode=full`)
assert.equal(routeSaveAfter.body.doc.root.children.length, routeSaveBefore.body.doc.root.children.length, 'документ сохранён целиком, а не подменён пустым')
assert.ok(JSON.stringify(routeSaveAfter.body.doc).includes('"card"'), 'инстанс компонента пережил сохранение панели')
ok(`POST /canvas — путь сохранения панели поднимает ревизию до ${routeSave.body.rev}`)

const routeSaveConflict = await request('POST', '/canvas', {
  project: init.project.id,
  canvas: 'home',
  doc: routeSaveBefore.body.doc,
  expectRev: routeSaveBefore.body.rev,
})
assert.equal(routeSaveConflict.status, 409)
ok('POST /canvas уважает expectRev (409)')

const routeSaveNoDoc = await request('POST', '/canvas', { project: init.project.id, canvas: 'home' })
assert.equal(routeSaveNoDoc.status, 400)
assert.match(routeSaveNoDoc.body.error, /doc/)
ok('POST /canvas без документа → 400 с объяснением')

const routeComponents = await request('POST', '/components', {
  project: init.project.id,
  canvas: 'home',
  action: 'instantiate',
  key: 'card-basic',
  parent: 'page',
  x: 16,
  y: 380,
})
assert.equal(routeComponents.status, 200)
ok('POST /components ставит инстанс')

const routeDelete = await request('POST', '/delete', { project: init.project.id, canvas: 'home' })
assert.equal(routeDelete.status, 200)
const routeTrash = await request('GET', '/trash')
assert.ok(routeTrash.body.entries.length === 1)
const routeRestore = await request('POST', '/restore', { trashId: routeDelete.body.trashId })
assert.equal(routeRestore.status, 200)
ok('корзина: delete → list → restore через маршрут')

const routeTokensReplace = await request('POST', '/tokens', {
  project: init.project.id,
  canvas: 'home',
  replace: true,
  remove: ['color.bg'],
  tokens: { color: { fg: '#ffffff' } },
})
assert.equal(routeTokensReplace.status, 200, routeTokensReplace.body?.error ?? '')
assert.equal(routeTokensReplace.body.flat['color.fg'], '#ffffff', 'новый набор записан')
assert.equal('color.bg' in routeTokensReplace.body.flat, false, 'удаление применилось к итоговому набору')
ok('POST /tokens: replace + remove не падает и не теряет новые токены')

const routeTokensEmptied = await request('POST', '/tokens', {
  project: init.project.id,
  canvas: 'home',
  replace: true,
  remove: ['color'],
})
assert.equal(routeTokensEmptied.status, 400)
assert.match(routeTokensEmptied.body.error, /не может стать пустым/)
ok('POST /tokens: опустошение набора → 400 с объяснением')

console.log(`\nHost-половина в порядке: ${checks} проверок.\n`)

await rm(home, { recursive: true, force: true })
await rm(projectRoot, { recursive: true, force: true })
