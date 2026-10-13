/**
 * Дымовой тест ядра плагина макетов: схема → хранилище → операции → экспорт.
 *
 * Запуск: `node smoke.mjs` из каталога плагина. Тест работает во временном
 * каталоге и не трогает проекты пользователя.
 */
import { mkdtemp, rm, readFile, readdir, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// Изолированный DSH_HOME: тест не должен трогать реестр и корзину пользователя.
const home = await mkdtemp(join(tmpdir(), 'dsh-design-home-'))
process.env.DSH_HOME = home
await mkdir(home, { recursive: true })

const { defaultDocument, normalizeDoc, validateDoc, expandInstance, flattenTokens } = await import('./schema.js')
const { ensureProject, createCanvas, readCanvas, writeCanvas, listCanvases, deleteCanvas, listTrash, restoreTrash, listProjects, DESIGN_DIR } = await import('./store.js')
const { applyOps, outline } = await import('./ops.js')
const { renderDocument } = await import('./export.js')

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ✓ ${label}`)
}

const root = await mkdtemp(join(tmpdir(), 'dsh-design-smoke-'))
try {
  // ---------------------------------------------------------------- store ----
  const project = await ensureProject(root, 'Smoke')
  assert.equal(project.root, root)
  ok(`проект создан: ${project.designPath.replace(root, '<tmp>')}`)

  const created = await createCanvas(project.id, 'home', { name: 'Home', device: 'mobile', create: true })
  assert.equal(created.doc.id, 'home')
  assert.equal(created.rev, 1)
  ok('холст создан, ревизия 1')

  const projects = await listProjects()
  assert.ok(projects.some((entry) => entry.id === project.id), 'проект попал в реестр')
  ok(`проект зарегистрирован в реестре как «${project.id}»`)

  const listed = await listCanvases(project.id)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'Home')
  ok(`список холстов: ${listed.map((c) => c.id).join(', ')}`)

  // ------------------------------------------------------------ документ ----
  const doc = defaultDocument('demo', 'Demo', { device: 'mobile' })
  assert.equal(doc.format, 'dsh-design-canvas')
  assert.equal(flattenTokens(doc)['color.bg'], '#0b0d10')
  ok('документ по умолчанию: формат и токены на месте')

  const normalized = normalizeDoc({ root: { children: [{ type: 'text' }] } }, 'x')
  assert.equal(normalized.root.id, 'root')
  assert.equal(normalized.root.children[0].type, 'text')
  assert.equal(normalized.root.locked, true)
  ok('нормализация чужого документа: корень и типы восстановлены')

  // ------------------------------------------------------------ операции ----
  const batch = applyOps(doc, [
    { op: 'set-tokens', tokens: { color: { brand: '#ff7a1a' } } },
    { op: 'add', parent: 'page', node: { id: 'hero', type: 'frame', name: 'Hero', x: 0, y: 0, w: 390, h: 220, style: { fill: 'token:color.surface', radius: 'token:radius.lg' } } },
    { op: 'add', parent: 'hero', node: { id: 'title', type: 'text', name: 'Title', x: 20, y: 24, w: 320, h: 40, text: { value: 'Заголовок', token: 'text.h1' } } },
    { op: 'add', parent: 'hero', node: { id: 'btn', type: 'frame', name: 'Button', x: 20, y: 100, w: 160, h: 48, style: { fill: 'token:color.accent', radius: 'token:radius.pill' }, layout: { mode: 'horizontal', padding: { t: 12, r: 20, b: 12, l: 20 }, align: 'center', gap: 8 } } },
    { op: 'add', parent: 'btn', node: { id: 'btnLabel', type: 'text', name: 'Label', x: 0, y: 0, w: 120, h: 24, text: { value: 'Войти', color: 'token:color.accentFg', align: 'center' } } },
    { op: 'define-component', key: 'button-primary', from: 'btn', name: 'Button / Primary' },
    { op: 'instantiate', component: 'button-primary', parent: 'hero', x: 200, y: 100, overrides: { label: 'Регистрация' } },
    { op: 'duplicate', id: 'title', offsetX: 0, offsetY: 60 },
    { op: 'align', ids: ['btn', 'title'], mode: 'left' },
    { op: 'add', parent: 'page', node: { type: 'ellipse', name: 'Dot', x: 300, y: 400, w: 40, h: 40 } },
  ])
  const draft = batch.doc
  assert.equal(batch.results.length, 10)
  ok(`батч из ${batch.results.length} операций применён`)

  assert.ok(draft.components['button-primary'], 'компонент объявлен')
  const hero = draft.root.children[0].children.find((n) => n.id === 'hero')
  const btn = hero.children.find((n) => n.id === 'btn')
  assert.equal(btn.type, 'instance', 'исходный узел стал инстансом')
  const instance = hero.children.find((n) => n.type === 'instance' && n.id !== 'btn')
  assert.ok(instance, 'второй инстанс добавлен')
  ok('компонент: исходный узел → инстанс, второй инстанс поставлен')

  const expanded = expandInstance(draft, instance)
  const expandedLabel = expanded.children.find((c) => c.name === 'Label')
  assert.equal(expandedLabel.text.value, 'Регистрация', 'переопределение label применено')
  assert.equal(expanded.id, instance.id, 'корень развёрнутого инстанса сохраняет id инстанса')
  assert.ok(expanded.children[0].id.startsWith(`${instance.id}/`), 'id детей неймспейснуты инстансом')
  ok('инстанс разворачивается и переопределяет подпись')

  const btnLayout = draft.root.children[0].children.find((n) => n.id === 'hero').children.find((n) => n.id === 'btn')
  assert.equal(btnLayout.type, 'instance')
  const outlineList = outline(draft)
  assert.ok(outlineList.length > 5)
  ok(`дерево слоёв: ${outlineList.length} узлов`)

  // ------------------------------------------------------------ валидация ----
  const { issues, stats } = validateDoc(draft)
  assert.equal(stats.errors, 0, `ошибок валидации: ${issues.map((i) => i.message).join('; ')}`)
  assert.ok(stats.components === 1)
  assert.ok(stats.instances === 2)
  ok(`валидация: ошибок ${stats.errors}, предупреждений ${stats.warnings}, узлов ${stats.nodes}`)

  const bad = applyOps(draft, [{ op: 'add', parent: 'page', node: { type: 'text' } }]).doc
  bad.root.children[0].children.push({ ...bad.root.children[0].children[0] })
  const badReport = validateDoc(bad)
  assert.ok(badReport.issues.some((i) => i.code === 'duplicate-id'))
  ok('валидация ловит дубли id')

  const brokenDoc = normalizeDoc({ root: { children: [
    { id: 'ghost', type: 'instance', component: 'нет-такого', w: 10, h: 10 },
    { id: 'tinted', type: 'rect', w: 10, h: 10, style: { fill: 'token:color.нет' } },
  ] } }, 'broken')
  const brokenCodes = validateDoc(brokenDoc).issues.map((issue) => issue.code)
  assert.ok(brokenCodes.includes('broken-instance'), `битый инстанс не пойман: ${brokenCodes.join(', ')}`)
  assert.ok(brokenCodes.includes('missing-token'), `ссылка на несуществующий токен не поймана: ${brokenCodes.join(', ')}`)
  ok(`валидация ловит битый инстанс и пропавший токен (${brokenCodes.join(', ')})`)

  const withGhost = normalizeDoc({ ...defaultDocument('ghost', 'Ghost'), root: { id: 'root', type: 'frame', locked: true, clip: false, children: [
    { id: 'card', type: 'instance', component: 'card', w: 100, h: 40, children: [{ id: 'ghostChild', type: 'text', w: 10, h: 10 }] },
  ] }, components: { card: { key: 'card', name: 'Card', template: { id: 'tpl', type: 'frame', w: 100, h: 40, children: [] } } } }, 'ghost')
  const ghostIssues = validateDoc(withGhost).issues.filter((issue) => issue.code === 'instance-children')
  assert.equal(ghostIssues.length, 1, 'авторские дети инстанса должны попадать в замечания, а не молчать')
  ok('валидация сообщает об авторских детях инстанса')

  const contrastDoc = (fg, fill, size) => normalizeDoc({ ...defaultDocument('contrast', 'Contrast'), root: { id: 'root', type: 'frame', locked: true, clip: false, children: [
    { id: 'plate', type: 'frame', x: 0, y: 0, w: 100, h: 100, style: { fill }, children: [
      { id: 'label', type: 'text', x: 0, y: 0, w: 50, h: 10, text: { value: 'T', color: fg, size } },
    ] },
  ] } }, 'contrast')
  const lowContrast = (doc) => validateDoc(doc).issues.filter((issue) => issue.code === 'low-contrast')
  assert.equal(lowContrast(contrastDoc('#777777', '#ffffff', 12)).length, 1, 'мелкий текст 4.48:1 — ниже порога AA 4.5:1')
  assert.equal(lowContrast(contrastDoc('#777777', '#ffffff', 32)).length, 0, 'тот же цвет крупным текстом проходит порог 3:1')
  assert.equal(lowContrast(contrastDoc('token:color.bg', 'token:color.bg', 12)).length, 1, 'токены разрешаются, а не пропускаются')
  assert.equal(lowContrast(contrastDoc('rgba(0,0,0,0.5)', '#ffffff', 12)).length, 1, 'полупрозрачный текст смешивается с фоном')
  assert.equal(lowContrast(contrastDoc('rgba(0,0,0,1)', '#ffffff', 12)).length, 0, 'непрозрачный rgba считается как есть')
  ok('контраст: порог зависит от размера, токены и rgba считаются')

  // -------------------------------------------------------- транзакция ----
  let rolledBack = false
  try {
    applyOps(draft, [
      { op: 'add', parent: 'page', node: { type: 'rect', id: 'temp' } },
      { op: 'update', id: 'nope', patch: { x: 1 } },
    ])
  } catch (error) {
    rolledBack = true
    assert.match(error.message, /не найден/)
    assert.equal(error.opIndex, 1)
  }
  assert.ok(rolledBack, 'ошибочный батч бросил исключение')
  assert.equal(draft.root.children[0].children.some((n) => n.id === 'temp'), false, 'батч откатился целиком')
  ok('транзакционность: ошибка на втором шаге откатила первый')

  // ------------------------------------------------------------- экспорт ----
  const { html, css, files, warnings } = renderDocument(draft, { mode: 'clean' })
  assert.match(html, /<!doctype html>/)
  assert.match(html, /data-node="hero"/)
  assert.match(html, /var\(--color-accent/)
  assert.match(css, /:root \{/)
  assert.match(css, /--color-brand: #ff7a1a/)
  assert.match(html, /dc-layout-horizontal/)
  assert.equal(files.length, 3, `файлов: ${files.map((f) => f.name).join(', ')}`)
  assert.equal(warnings.length, 0, `предупреждений: ${warnings.join('; ')}`)
  ok(`экспорт: ${files.map((f) => f.name).join(', ')} (${html.length} байт HTML, ${css.length} байт CSS)`)

  assert.ok(!/[a-z]font-family/.test(html), 'части инлайн-стиля склеены через «;»')
  assert.ok(!/;;/.test(html), 'нет двойных точек с запятой')
  assert.ok(!/dc-frame dc-frame/.test(html), 'классы узла не дублируются')
  assert.match(css, /--radius-md: 12px/, 'токены-длины получают px')
  assert.match(css, /--space-md: 16px/)
  assert.match(css, /--text-h1-size: 32px/)
  assert.match(css, /--text-h1-weight: 700;/)
  assert.match(css, /--text-h1-lineHeight: 1.15;/)
  assert.match(css, /--text-h1-letterSpacing: -0.5px/)
  assert.match(html, /font-size:var\(--text-h1-size, 32px\)/, 'типографика ссылается на токен')
  assert.match(html, /border-radius:var\(--radius-lg, 20px\)/, 'радиус ссылается на токен с px')
  ok('экспорт: единицы, ссылки на токены, отсутствие дублей классов')
  const shadowDoc = applyOps(doc, [
    { op: 'add', parent: 'page', node: { id: 'shadowed', type: 'rect', name: 'S', x: 0, y: 0, w: 100, h: 100, style: { shadow: 'token:shadow.card' } } },
  ]).doc
  const shadowHtml = renderDocument(shadowDoc, { mode: 'fidelity' }).html
  assert.match(shadowHtml, /box-shadow:0px 8px 24px 0px rgba\(0,0,0,0\.45\)/, 'тень-ссылка на токен разворачивается')
  ok('экспорт: тень по ссылке на токен разворачивается с единицами')

  const flowDoc = applyOps(doc, [
    { op: 'add', parent: 'page', node: { id: 'bar', type: 'frame', name: 'Bar', x: 10, y: 500, w: 200, h: 60, layout: { mode: 'horizontal', align: 'center', justify: 'center', padding: { t: 0, r: 10, b: 0, l: 10 } } } },
    { op: 'add', parent: 'bar', node: { id: 'barLabel', type: 'text', name: 'L', x: 0, y: 0, w: 80, h: 20, text: { value: 'ok' } } },
  ]).doc
  const flowHtml = renderDocument(flowDoc, { mode: 'clean' }).html
  assert.match(flowHtml, /data-node="bar"[^>]*position:absolute;left:10px;top:500px/, 'потоковый фрейм сохраняет свои координаты')
  assert.match(flowHtml, /data-node="barLabel"[^>]*position:static/, 'ребёнок потокового фрейма позицию не задаёт')
  const fidelityFlow = renderDocument(flowDoc, { mode: 'fidelity' }).html
  assert.ok(!/position:static/.test(fidelityFlow), 'режим fidelity не использует поток')
  ok('экспорт: поток только в clean, координаты фрейма не теряются')
  const sheet = files.find((file) => file.name.endsWith('.components.html'))
  assert.ok(sheet, 'лист компонентов сгенерирован')
  assert.match(sheet.content, /dc-sheet-cell[^>]*position:relative;width:\d/, 'ячейка листа держит свою систему координат и размер')
  assert.match(sheet.content, /dc-sheet-holder[^>]*position:relative;width:\d+px;height:\d+px/, 'держатель ячейки имеет явный размер')
  ok('экспорт: лист компонентов не схлопывает ячейки')

  const twoScreens = normalizeDoc({ ...defaultDocument('two', 'Two'), root: { id: 'root', type: 'frame', locked: true, clip: false, children: [
    { id: 'screen1', type: 'frame', name: 'Screen 1', x: 0, y: 0, w: 100, h: 100, children: [{ id: 'screenLabel', type: 'text', x: 5, y: 5, w: 20, h: 10 }] },
    { id: 'screen2', type: 'frame', name: 'Screen 2', x: 0, y: 0, w: 100, h: 100, children: [] },
  ] } }, 'two')
  for (const mode of ['fidelity', 'clean']) {
    const screenHtml = renderDocument(twoScreens, { mode }).html
    assert.ok(!/data-node="screen1"[^>]*position:absolute/.test(screenHtml), `${mode}: верхний фрейм не должен позиционироваться абсолютно`)
    assert.ok(!/data-node="screen2"[^>]*position:absolute/.test(screenHtml), `${mode}: второй верхний фрейм тоже встаёт в поток`)
    assert.match(screenHtml, /data-node="screen1"[^>]*position:relative;width:100px/, `${mode}: потоковый фрейм остаётся системой координат детей`)
    assert.match(screenHtml, /data-node="screenLabel"[^>]*position:absolute;left:5px;top:5px/, `${mode}: ребёнок верхнего фрейма остаётся абсолютным`)
  }
  assert.match(renderDocument(twoScreens, { mode: 'fidelity' }).css, /\.dc-board \{[^}]*display:flex/, 'доска раскладывает верхние фреймы потоком')
  ok('экспорт: верхние фреймы встают в поток доски и не накладываются')



  const fidelity = renderDocument(draft, { mode: 'fidelity' })
  assert.match(fidelity.html, /left:0px/)
  ok('режим fidelity: абсолютное позиционирование')

  // ------------------------------------------------------- запись/ревизии ----
  await writeCanvas(project.id, 'home', draft, { create: true })
  const reread = await readCanvas(project.id, 'home')
  assert.equal(reread.rev, 2, 'запись поверх созданного холста подняла ревизию до 2')
  assert.equal(reread.doc.components['button-primary'].key, 'button-primary')
  ok('запись и чтение холста через store')

  await writeCanvas(project.id, 'home', draft, { expectRev: reread.rev })
  const after = await readCanvas(project.id, 'home')
  assert.equal(after.rev, 3)
  ok('ревизия растёт при записи')

  let conflicted = false
  try {
    await writeCanvas(project.id, 'home', draft, { expectRev: 1 })
  } catch (error) {
    conflicted = error.status === 409
  }
  assert.ok(conflicted, 'устаревшая ревизия отклонена')
  ok('оптимистическая блокировка: устаревшая ревизия → 409')

  // ------------------------------------------------------ защита путей ----
  for (const bad of ['..', '.', '../../etc', 'a/b']) {
    let rejected = false
    try {
      await restoreTrash(bad)
    } catch (error) {
      rejected = error.status === 400 || error.status === 404
    }
    assert.ok(rejected, `метка корзины «${bad}» должна быть отклонена`)
  }
  ok('метки корзины с обходом каталога отклоняются')

  // ---------------------------------------------------- токены и корень ----
  const tokenDoc = defaultDocument('tok', 'Tok')
  const nested = applyOps(tokenDoc, [
    { op: 'set-tokens', tokens: { text: { h1: { size: 40, weight: 800 } } } },
  ]).doc
  assert.equal(nested.tokens.text.h1.size, 40)
  ok('вложенные токены типографики переопределяются')

  const replaced = applyOps(tokenDoc, [
    { op: 'set-tokens', tokens: { color: { fg: '#ffffff' } }, replace: true, remove: ['color.bg'] },
  ]).doc
  assert.equal(replaced.tokens.color.fg, '#ffffff', 'новый токен попал в набор')
  assert.equal('bg' in replaced.tokens.color, false, 'удаление применяется к итоговому набору')
  ok('set-tokens: «заменить набор» и «удалить токены» работают вместе')

  let emptied = false
  try {
    applyOps(tokenDoc, [{ op: 'set-tokens', replace: true, remove: ['color'] }])
  } catch (error) {
    emptied = /не может стать пустым/.test(error.message)
  }
  assert.ok(emptied, 'опустошение набора токенов должно объясняться, а не падать на «Нужен объект tokens»')
  ok('set-tokens: пустой набор отклоняется с объяснением')

  const autoDoc = applyOps(defaultDocument('auto', 'Auto'), [
    { op: 'add', parent: 'page', node: { id: 'stack', type: 'frame', w: 200, h: 10, layout: { mode: 'vertical', gap: 10 } } },
    { op: 'add', parent: 'stack', node: { id: 'row1', type: 'rect', w: 50, h: 30 } },
    { op: 'add', parent: 'stack', node: { id: 'row2', type: 'rect', w: 50, h: 40 } },
    { op: 'update', id: 'stack', patch: { autoH: false, h: 25 } },
  ]).doc
  assert.equal(autoDoc.root.children[0].children[0].autoH, false)
  assert.equal(autoDoc.root.children[0].children[0].h, 25, 'внутри батча авторазмер выключен и высота удержана')
  const stackRenormalized = normalizeDoc(autoDoc, 'auto').root.children[0].children[0]
  assert.equal(stackRenormalized.autoH, false, 'autoH переживает нормализацию')
  assert.equal(stackRenormalized.h, 25, 'нормализация не пересчитывает удержанную высоту')
  const legacyNode = normalizeDoc({ root: { children: [{ type: 'frame' }] } }, 'legacy').root.children[0]
  assert.equal('autoH' in legacyNode, false, 'старый документ не обрастает новыми полями')
  ok('раскладка: autoW/autoH переживают нормализацию, старый документ не меняется')

  let badDevice = false
  try {
    applyOps(tokenDoc, [{ op: 'set-canvas', device: 'watch' }])
  } catch (error) {
    badDevice = /mobile \| tablet \| desktop \| component/.test(error.message)
  }
  assert.ok(badDevice, 'неизвестное устройство должно отклоняться, а не молча становиться mobile')
  assert.equal(applyOps(tokenDoc, [{ op: 'set-canvas', device: 'tablet' }]).doc.device, 'tablet')
  ok('set-canvas: неизвестное устройство отклоняется, известное применяется')

  let instanceUngroup = false
  try {
    applyOps(draft, [{ op: 'ungroup', id: instance.id }])
  } catch (error) {
    instanceUngroup = /инстанс/.test(error.message)
  }
  assert.ok(instanceUngroup, 'ungroup инстанса не должен молча удалять узел')
  ok('ungroup инстанса отклоняется с подсказкой про detach')

  const twoNodes = applyOps(doc, [
    { op: 'add', parent: 'page', node: { id: 'plain', type: 'rect', x: 0, y: 0, w: 10, h: 10 } },
    { op: 'add', parent: 'page', node: { id: 'caption', type: 'text', x: 0, y: 20, w: 10, h: 10 } },
  ]).doc
  for (const op of [
    { op: 'add', parent: 'plain', node: { type: 'text' } },
    { op: 'move', id: 'caption', parent: 'plain' },
  ]) {
    let rejected = false
    try {
      applyOps(twoNodes, [op])
    } catch (error) {
      rejected = /не может содержать детей/.test(error.message)
    }
    assert.ok(rejected, `«${op.op}» в не-контейнер должен отклоняться, а не терять узел`)
  }
  const movedIntoPage = applyOps(twoNodes, [{ op: 'move', id: 'caption', parent: 'page' }]).doc
  assert.ok(movedIntoPage.root.children[0].children.some((n) => n.id === 'caption'), 'move в контейнер по-прежнему работает')
  ok('add и move в не-контейнер отклоняются, move в контейнер работает')

  const clippedFrame = applyOps(doc, [
    { op: 'add', parent: 'page', node: { id: 'clipped', type: 'frame', w: 100, h: 100 } },
    { op: 'add', parent: 'clipped', node: { id: 'outside', type: 'rect', x: 200, y: 200, w: 10, h: 10 } },
  ]).doc
  const clippedNode = clippedFrame.root.children[0].children.find((node) => node.id === 'clipped')
  assert.equal(clippedNode.clip, true, 'фрейм, добавленный операцией, обрезает детей по умолчанию')
  assert.equal(clippedNode.children[0].id, 'outside', 'ребёнок добавленного фрейма остался в дереве')
  ok('add: фрейм обрезает детей по умолчанию, как фрейм документа')

  let rootComponent = false
  try {
    applyOps(tokenDoc, [{ op: 'define-component', key: 'root-comp', from: 'root' }])
  } catch (error) {
    rootComponent = /Корень холста/.test(error.message)
  }
  assert.ok(rootComponent, 'корень нельзя сделать компонентом')
  ok('корень холста защищён от превращения в компонент')

  // -------------------------------------------------------------- корзина ----
  const trashed = await deleteCanvas(project.id, 'home')
  assert.equal((await listCanvases(project.id)).length, 0)
  const trash = await listTrash()
  assert.ok(trash.some((entry) => entry.trashId === trashed.trashId))
  ok('удаление холста в корзину')

  await restoreTrash(trashed.trashId)
  assert.equal((await listCanvases(project.id)).length, 1)
  ok('восстановление холста из корзины')

  // ------------------------------------------------- раскладка на диске ----
  await createCanvas(project.id, 'auto', { name: 'Auto', create: true })
  await writeCanvas(project.id, 'auto', autoDoc, { create: true })
  const autoBack = await readCanvas(project.id, 'auto')
  assert.equal(autoBack.doc.root.children[0].children[0].autoH, false, 'autoH вернулся из store')
  assert.equal(autoBack.doc.root.children[0].children[0].h, 25, 'удержанная высота не пересчитана при записи')
  const autoRaw = JSON.parse(await readFile(join(root, DESIGN_DIR, 'auto.canvas.json'), 'utf8'))
  assert.equal(autoRaw.root.children[0].children[0].autoH, false, 'autoH записан в canvas.json')
  ok(`раскладка: autoH доезжает до canvas.json и читается назад (rev ${autoBack.rev})`)

  // ------------------------------------- раскладка: выравнивание и поток ----
  const justifyDoc = applyOps(defaultDocument('flow', 'Flow'), [
    { op: 'add', parent: 'page', node: { id: 'row', type: 'frame', w: 300, h: 80, layout: { mode: 'horizontal', gap: 10, justify: 'center', align: 'center' } } },
    { op: 'add', parent: 'row', node: { id: 'one', type: 'rect', w: 60, h: 20 } },
    { op: 'add', parent: 'row', node: { id: 'two', type: 'rect', w: 40, h: 40 } },
  ]).doc
  const justifyRow = justifyDoc.root.children[0].children.find((node) => node.id === 'row')
  assert.equal(justifyRow.w, 300, 'justify: center сохраняет авторскую ширину фрейма')
  assert.equal(justifyRow.children[0].x, 95, 'свободное место делится по главной оси')
  assert.equal(justifyRow.children[1].x, 165, 'промежуток между детьми остаётся')
  assert.equal(justifyRow.children[0].y, 30, 'align: center центрирует по поперечной оси')
  assert.equal(justifyRow.children[1].y, 20, 'высокий ребёнок центрируется по своей высоте')
  ok('раскладка: justify и align распределяют свободное место, а не молчат')

  const spreadDoc = applyOps(defaultDocument('spread', 'Spread'), [
    { op: 'add', parent: 'page', node: { id: 'bar', type: 'frame', w: 300, h: 60, layout: { mode: 'horizontal', gap: 10, justify: 'space-between', align: 'stretch' } } },
    { op: 'add', parent: 'bar', node: { id: 'left', type: 'rect', w: 40, h: 20 } },
    { op: 'add', parent: 'bar', node: { id: 'right', type: 'rect', w: 40, h: 20 } },
  ]).doc
  const spreadBar = spreadDoc.root.children[0].children.find((node) => node.id === 'bar')
  assert.equal(spreadBar.children[0].x, 0, 'первый ребёнок у левого края')
  assert.equal(spreadBar.children[1].x, 260, 'последний ребёнок у правого края')
  assert.equal(spreadBar.children[0].h, 60, 'align: stretch растягивает детей по поперечной оси')
  ok('раскладка: space-between разводит детей, stretch растягивает')

  const autoFlowDoc = applyOps(defaultDocument('autoflow', 'Autoflow'), [
    { op: 'add', parent: 'page', node: { id: 'strip', type: 'frame', w: 0, h: 40, layout: { mode: 'horizontal', gap: 10 } } },
    { op: 'add', parent: 'strip', node: { id: 's1', type: 'rect', w: 50, h: 10 } },
    { op: 'add', parent: 'strip', node: { id: 's2', type: 'rect', w: 50, h: 10 } },
    { op: 'add', parent: 'strip', node: { id: 's3', type: 'rect', w: 50, h: 10 } },
  ]).doc
  const autoStrip = autoFlowDoc.root.children[0].children.find((node) => node.id === 'strip')
  assert.equal(autoStrip.w, 170, 'авторазмер главной оси считает промежутки без лишнего gap')
  const soloDoc = applyOps(defaultDocument('solo', 'Solo'), [
    { op: 'add', parent: 'page', node: { id: 'solo', type: 'frame', w: 0, h: 40, layout: { mode: 'horizontal', gap: 10 } } },
    { op: 'add', parent: 'solo', node: { id: 'only', type: 'rect', w: 50, h: 10 } },
  ]).doc
  assert.equal(soloDoc.root.children[0].children.find((node) => node.id === 'solo').w, 50, 'единственный ребёнок не добавляет промежуток')
  ok('раскладка: авторазмер по содержимому не искажает промежутки')

  const fixedCross = applyOps(defaultDocument('cross', 'Cross'), [
    { op: 'add', parent: 'page', node: { id: 'bar', type: 'frame', w: 200, h: 100, autoH: false, layout: { mode: 'horizontal', gap: 0 } } },
    { op: 'add', parent: 'bar', node: { id: 'tall', type: 'rect', w: 20, h: 300 } },
  ]).doc
  const fixedBar = fixedCross.root.children[0].children.find((node) => node.id === 'bar')
  assert.equal(fixedBar.h, 100, 'autoH: false удерживает высоту и по поперечной оси')
  const fixedWide = applyOps(defaultDocument('wide', 'Wide'), [
    { op: 'add', parent: 'page', node: { id: 'col', type: 'frame', w: 100, h: 200, autoW: false, layout: { mode: 'vertical', gap: 0 } } },
    { op: 'add', parent: 'col', node: { id: 'wide', type: 'rect', w: 300, h: 20 } },
  ]).doc
  const fixedCol = fixedWide.root.children[0].children.find((node) => node.id === 'col')
  assert.equal(fixedCol.w, 100, 'autoW: false удерживает ширину и по поперечной оси')
  ok('раскладка: autoW/autoH удерживают размер и по поперечной оси')

  let badDistribute = false
  const threeNodes = applyOps(doc, [
    { op: 'add', parent: 'page', node: { id: 'd1', type: 'rect', x: 0, y: 0, w: 10, h: 10 } },
    { op: 'add', parent: 'page', node: { id: 'd2', type: 'rect', x: 40, y: 0, w: 10, h: 10 } },
    { op: 'add', parent: 'page', node: { id: 'd3', type: 'rect', x: 90, y: 0, w: 10, h: 10 } },
  ]).doc
  try {
    applyOps(threeNodes, [{ op: 'distribute', ids: ['d1', 'd2', 'd3'], axis: 'z' }])
  } catch (error) {
    badDistribute = /«axis»: x \| y/.test(error.message)
  }
  assert.ok(badDistribute, 'неизвестная ось distribute должна отклоняться')
  assert.equal(applyOps(threeNodes, [{ op: 'distribute', ids: ['d1', 'd2', 'd3'], axis: 'y' }]).doc.root.children[0].children.length, 3, 'известная ось применяется')
  ok('distribute: неизвестная ось отклоняется, известная работает')

  const axisDoc = applyOps(defaultDocument('axis', 'Axis'), [
    { op: 'add', parent: 'page', node: { id: 'a1', type: 'rect', x: 0, y: 0, w: 20, h: 10 } },
    { op: 'add', parent: 'page', node: { id: 'a2', type: 'rect', x: 0, y: 40, w: 60, h: 10 } },
  ]).doc
  let axisConflict = false
  try {
    applyOps(axisDoc, [{ op: 'align', ids: ['a1', 'a2'], mode: 'left', axis: 'y' }])
  } catch (error) {
    axisConflict = /противоречит/.test(error.message)
  }
  assert.ok(axisConflict, 'противоречие axis и mode должно отклоняться, а не выравнивать наугад')
  const rightAligned = applyOps(axisDoc, [{ op: 'align', ids: ['a1', 'a2'], mode: 'right', axis: 'x' }]).doc
  const alignedNodes = rightAligned.root.children[0].children
  assert.equal(alignedNodes.find((node) => node.id === 'a1').x, 40, 'согласованный axis выравнивает по правому краю')
  ok('align: противоречие axis и mode отклоняется, согласованный axis работает')

  const dupAdd = applyOps(doc, [
    { op: 'add', parent: 'page', node: { id: 'dup', type: 'rect', w: 10, h: 10 } },
    { op: 'add', parent: 'page', node: { id: 'dup', type: 'rect', w: 10, h: 10 } },
  ])
  const dupIds = dupAdd.doc.root.children[0].children.map((node) => node.id)
  assert.notEqual(dupAdd.results[1].id, 'dup', 'занятый id заменяется новым')
  assert.equal(dupIds.filter((id) => id === 'dup').length, 1, 'старый узел не перезаписан')
  assert.equal(dupIds.length, 2, 'второй узел добавлен под новым id')
  ok('add: занятый id заменяется новым и возвращается в ответе')

  // -------------------------------- проект, найденный по каталогу, без реестра ----
  const cloneRoot = await mkdtemp(join(tmpdir(), 'dsh-design-clone-'))
  try {
    await mkdir(join(cloneRoot, DESIGN_DIR), { recursive: true })
    const adopted = await createCanvas(cloneRoot, 'clone-home', { create: true })
    assert.ok(adopted.project.id, 'у найденного по каталогу проекта появился id')
    assert.ok((await listProjects()).some((entry) => entry.id === adopted.project.id), 'проект попал в реестр')
    const cloneBack = await readCanvas(adopted.project.id, 'clone-home')
    assert.equal(cloneBack.doc.id, 'clone-home', 'холст читается по id проекта')
    const rewritten = await writeCanvas(adopted.project.id, 'clone-home', cloneBack.doc, {})
    assert.equal(rewritten.rev, cloneBack.rev + 1, 'запись по id проекта работает')
    assert.equal((await listCanvases(adopted.project.id)).length, 1, 'список холстов доступен по id')
    ok(`проект с .design/ без записи в реестре адресуется по id «${adopted.project.id}»`)
  } finally {
    await rm(cloneRoot, { recursive: true, force: true })
  }

  // ------------------------------------------------ предел размера холста ----
  const revBeforeBig = (await readCanvas(project.id, 'home')).rev
  const bigDoc = defaultDocument('home', 'Home')
  bigDoc.root.children[0].children.push({
    id: 'huge',
    type: 'image',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    image: { src: `data:image/png;base64,${'A'.repeat(9 * 1024 * 1024)}` },
  })
  let tooBig = 0
  try {
    await writeCanvas(project.id, 'home', bigDoc, { create: true, force: true })
  } catch (error) {
    tooBig = error.status
  }
  assert.equal(tooBig, 413, 'запись холста больше лимита чтения отклоняется')
  assert.equal((await readCanvas(project.id, 'home')).rev, revBeforeBig, 'отклонённая запись не тронула файл')
  ok('запись: холст больше 8 МБ отклоняется, не становясь нечитаемым')

  // ------------------------------------------- параллельная запись одного пути ----
  const parallel = await Promise.allSettled([
    writeCanvas(project.id, 'home', defaultDocument('home', 'Home'), { force: true }),
    writeCanvas(project.id, 'home', defaultDocument('home', 'Home'), { force: true }),
    writeCanvas(project.id, 'home', defaultDocument('home', 'Home'), { force: true }),
    writeCanvas(project.id, 'home', defaultDocument('home', 'Home'), { force: true }),
  ])
  const rawFailures = parallel
    .filter((item) => item.status === 'rejected')
    .map((item) => item.reason)
    .filter((error) => typeof error?.status !== 'number')
  assert.deepEqual(rawFailures, [], `параллельная запись упала сырой ошибкой: ${rawFailures.map((e) => e.message).join('; ')}`)
  assert.ok(parallel.some((item) => item.status === 'fulfilled'), 'хотя бы одна запись должна пройти')
  assert.ok((await readCanvas(project.id, 'home')).doc, 'холст читается после параллельной записи')
  ok(`параллельная запись одного холста: без сырых ошибок (${parallel.filter((i) => i.status === 'fulfilled').length} из 4)`)

  // ---------------------------------------------------------- на диске ----
  const entries = await readdir(join(root, DESIGN_DIR))
  assert.ok(entries.includes('home.canvas.json'))
  assert.ok(entries.includes('project.json'))
  const raw = JSON.parse(await readFile(join(root, DESIGN_DIR, 'home.canvas.json'), 'utf8'))
  assert.equal(raw.format, 'dsh-design-canvas')
  assert.ok(raw.rev >= 1)
  ok(`на диске: ${entries.join(', ')}`)

  console.log(`\nЯдро в порядке: ${checks} проверок.\n`)
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
}
