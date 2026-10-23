/**
 * Живая проверка автономного редактора: окно открывается отдельно от харнесса
 * и работает как панель «Макеты».
 *
 * Скрипт запускает `standalone.js` на свободном порту с временным `DSH_HOME`,
 * открывает его Playwright'ом и повторяет сценарий редактора: холст отрисован,
 * узел выделяется, вкладки живут, правка уходит в автосохранение и поднимает
 * ревизию, тема переключается. Ошибки консоли и исключения страницы собираются:
 * без харнесса рядом нет его логов, и это единственный способ их увидеть.
 *
 * Запуск:
 *   node smoke-editor.mjs [.editor-shot.png] [--tailscale]
 *
 * `--tailscale` поднимает окно на адресе этого узла в tailnet и открывает его
 * тем же адресом — так проверяется сценарий «открыть редактор с другого
 * устройства» (без Tailscale шаг не имеет смысла).
 *
 * Playwright берётся из установленного пакета или из кеша `npx`.
 */
import { mkdtemp, rm, mkdir, cp, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'

const shot = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '.editor-shot.png'
const viaTailscale = process.argv.includes('--tailscale')

/** Найти Playwright: обычный импорт, затем кеш npx. */
async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    const cache = join(homedir(), '.npm', '_npx')
    const dirs = await readdir(cache).catch(() => [])
    for (const dir of dirs) {
      const candidate = join(cache, dir, 'node_modules', 'playwright', 'index.mjs')
      try {
        return await import(candidate)
      } catch {
        // Пробуем следующий каталог кеша.
      }
    }
    throw new Error('Playwright не найден: установи его или прогрел `npx playwright --version`.')
  }
}

const home = await mkdtemp(join(tmpdir(), 'dsh-design-editor-home-'))
const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-design-editor-proj-'))
await mkdir(home, { recursive: true })
await cp(join(import.meta.dirname, 'demo', '.design'), join(projectRoot, '.design'), { recursive: true })

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ✓ ${label}`)
}

/** Запустить автономный сервер и дождаться адреса и id проекта. */
function startServer() {
  const args = [join(import.meta.dirname, 'standalone.js'), '--port', '0', '--project', projectRoot]
  if (viaTailscale) args.push('--tailscale')
  const child = spawn(process.execPath, args, {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let output = ''
    let errors = ''
    const timer = setTimeout(() => reject(new Error(`сервер не поднялся:\n${output}\n${errors}`)), 15000)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      // Первый напечатанный адрес — тот, по которому слушает сервер: с
      // `--tailscale` это адрес tailnet, а не петлевой.
      const url = output.match(/http:\/\/[0-9a-fA-F.:[\]]+:\d+\//)
      const project = output.match(/проект (\S+) →/)
      if (!url || !project) return
      clearTimeout(timer)
      // С `--tailscale` окно закрыто токеном: адрес из вывода несёт его в query,
      // и браузер должен открыть адрес вместе с токеном, иначе API ответит 401.
      const token = output.match(/token=([a-f0-9]{32})/)?.[1] ?? null
      resolve({ child, base: url[0].replace(/\/$/, ''), project: project[1], token })
    })
    child.stderr.on('data', (chunk) => { errors += String(chunk) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`сервер завершился с кодом ${code}:\n${output}\n${errors}`))
    })
  })
}

const { child, base, project, token } = await startServer()
const { chromium } = await loadPlaywright()
const browser = await chromium.launch()

try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const consoleErrors = []
  const pageErrors = []
  const EXPECTED = /409 \(Conflict\)/
  page.on('console', (message) => {
    if (message.type() === 'error' && !EXPECTED.test(message.text())) consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // Панель помнит последний проект в localStorage; в свежем профиле браузера
  // выбирать нечего, поэтому временный проект называем явно.
  await page.addInitScript(([projectId, canvasId]) => {
    window.localStorage.setItem('dsh.design.project', projectId)
    window.localStorage.setItem('dsh.design.canvas', canvasId)
  }, [project, 'quiz-home'])

  await page.goto(`${base}/${token ? `?token=${token}` : ''}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dc-viewport', { timeout: 20000 })

  // -------------------------------------------------------- окно и оболочка ----
  const title = await page.title()
  assert.match(title, /Макеты/, `заголовок окна: ${title}`)
  const shellBar = await page.locator('.shell-bar').innerText()
  assert.match(shellBar, /автономный редактор/, 'шапка оболочки не отрисована')
  const failure = await page.locator('.shell-error').count()
  assert.equal(failure, 0, 'оболочка показала ошибку запуска')
  if (viaTailscale) assert.match(base, /^http:\/\/100\./, `ожидался адрес tailnet, получен ${base}`)
  ok(`окно открылось отдельно от харнесса: ${base} — «${title}»${viaTailscale ? ' (адрес tailnet)' : ''}`)

  // ------------------------------------------------------------------ холст ----
  const nodes = await page.locator('[data-node-id]').count()
  assert.ok(nodes >= 20, `узлов на холсте: ${nodes}`)
  ok(`холст отрисован: ${nodes} узлов с data-node-id`)

  const status = await page.locator('text=/ревизия/').first().innerText().catch(() => '')
  assert.match(status, /ревизия/, 'статус-бар не показывает ревизию')
  ok(`статус-бар: ${status.replace(/\s+/g, ' ').trim()}`)

  // Тема: переключатель оболочки меняет атрибут и переменные панели.
  const before = await page.evaluate(() => document.documentElement.dataset.theme)
  await page.locator('#shell-theme').click()
  const after = await page.evaluate(() => document.documentElement.dataset.theme)
  assert.notEqual(after, before, 'переключатель темы не сменил тему')
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  assert.ok(bg.startsWith('rgb'), `фон окна не разрешился из токена: ${bg}`)
  ok(`тема переключается в самом окне: ${before} → ${after}`)

  // -------------------------------------------------------------- выделение ----
  await page.locator('.dc-viewport').getByText('История', { exact: true }).click()
  await page.waitForTimeout(800)
  assert.ok(await page.locator('.dc-node-selected').count() > 0, 'узел не подсветился как выделенный')
  const inputs = await page.evaluate(() => [...document.querySelectorAll('input,textarea')].map((el) => el.value))
  assert.ok(inputs.includes('История'), `инспектор не показал действующее значение (есть: ${inputs.slice(0, 12).join(' | ')})`)
  ok('клик по узлу выделяет его, инспектор показывает действующие значения')

  // ----------------------------------------------------------------- вкладки ----
  const tabText = async (name) => {
    await page.getByRole('button', { name, exact: true }).first().click()
    await page.waitForTimeout(700)
    return page.evaluate(() => document.body.innerText)
  }
  assert.match(await tabText('Слои'), /TopicCard/, 'дерево слоёв не показывает узлы')
  assert.match(await tabText('Компоненты'), /topic-card/, 'библиотека компонентов пуста')
  assert.match(await tabText('Токены'), /color\.bg/, 'редактор токенов пуст')
  await tabText('Холсты')
  ok('вкладки «Слои», «Компоненты» и «Токены» работают в автономном окне')

  // ------------------------------------------------------------- автосохранение ----
  const revOf = async () => Number((await page.locator('text=/ревизия \\d+/').first().innerText().catch(() => '')).match(/ревизия (\d+)/)?.[1] ?? 0)
  const revBefore = await revOf()
  const xField = page.locator('input[type="number"]').first()
  await xField.fill(String((Number(await xField.inputValue()) || 0) + 1))
  await xField.press('Enter')
  await page.waitForTimeout(2500)
  const revAfter = await revOf()
  assert.ok(revAfter > revBefore, `ревизия не выросла: было ${revBefore}, стало ${revAfter}`)
  ok(`правка сохранена автосохранением: ревизия ${revBefore} → ${revAfter}`)

  // Внешняя правка «как от агента»: то же API, без браузера.
  const external = await fetch(`${base}/api/dsh-design-canvas/apply${token ? `?token=${token}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: projectRoot, canvas: 'quiz-home', expectRev: revAfter, ops: [{ op: 'set-canvas', name: 'Автономный холст' }] }),
  })
  assert.equal(external.status, 200, `внешняя правка не прошла: ${external.status}`)
  ok('агент правит тот же холст, что открыт в автономном окне')

  // --------------------------------------------- жест по вложенному узлу ----
  // Панель пишет в узел координаты его родителя, а не абсолютные: иначе узел
  // внутри смещённого контейнера «улетает» на смещение контейнера при первом
  // движении. В демо-холсте такого узла нет — вложенные лежат в авто-раскладке,
  // которая всё равно пересчитывает координаты, — поэтому фикстура дополняется
  // баг-репро через тот же API, что у агента.
  const canvasFile = join(projectRoot, '.design', 'quiz-home.canvas.json')
  const probeRev = JSON.parse(await readFile(canvasFile, 'utf8')).rev
  const probeAdd = await fetch(`${base}/api/dsh-design-canvas/apply${token ? `?token=${token}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project: projectRoot,
      canvas: 'quiz-home',
      expectRev: probeRev,
      ops: [
        { op: 'add', parent: 'page', node: { id: 'probe-wrap', type: 'frame', name: 'ProbeWrap', x: 250, y: 560, w: 100, h: 60, layout: { mode: 'none' } } },
        { op: 'add', parent: 'probe-wrap', node: { id: 'probe-child', type: 'rect', name: 'ProbeChild', x: 10, y: 10, w: 30, h: 20 } },
      ],
    }),
  })
  assert.equal(probeAdd.status, 200, `баг-репро не добавлен: ${probeAdd.status}`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.dc-viewport', { timeout: 20000 })
  await page.waitForTimeout(1500)

  const fitZoom = await page.evaluate(() => {
    const parts = /matrix\(([^)]+)\)/.exec(getComputedStyle(document.querySelector('.dc-world')).transform)
    return parts ? Number(parts[1].split(',')[0]) : 1
  })
  const childBox = await page.locator('[data-node-id="probe-child"]').boundingBox()
  assert.ok(childBox, 'баг-репро не отрисован на холсте')
  const childStart = { x: childBox.x + childBox.width / 2, y: childBox.y + childBox.height / 2 }
  await page.mouse.move(childStart.x, childStart.y)
  await page.mouse.down()
  await page.mouse.move(childStart.x + 30, childStart.y + 20, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(2500)

  const afterDoc = JSON.parse(await readFile(canvasFile, 'utf8'))
  const findById = (node, id) => (node.id === id ? node : (node.children ?? []).map((child) => findById(child, id)).find(Boolean))
  const dragged = findById(afterDoc.root, 'probe-child')
  const expectX = 10 + 30 / fitZoom
  const expectY = 10 + 20 / fitZoom
  assert.ok(dragged && Math.abs(dragged.x - expectX) <= 7 && Math.abs(dragged.y - expectY) <= 7,
    `вложенный узел сдвинулся на смещение курсора: ${dragged?.x},${dragged?.y} против ~${expectX.toFixed(1)},${expectY.toFixed(1)}`)
  assert.ok(dragged.x < 60, `вложенный узел улетел на смещение контейнера (x=${dragged.x})`)
  ok(`перетаскивание вложенного узла пишет координаты родителя (${dragged.x},${dragged.y})`)

  // ----------------------------------------------------------------- проверка ----
  await page.getByRole('button', { name: 'Проверить', exact: false }).first().click()
  await page.waitForTimeout(1800)
  assert.match(await page.evaluate(() => document.body.innerText), /Ошибок|ошиб|замечан/i, 'панель проверки не открылась')
  ok('кнопка «Проверить» показала результат')

  await page.screenshot({ path: shot })
  console.log(`\nСкриншот: ${shot}`)

  if (pageErrors.length > 0) {
    console.log('\nИсключения страницы:')
    for (const error of pageErrors) console.log(`  ${error}`)
  }
  if (consoleErrors.length > 0) {
    console.log('\nОшибки консоли:')
    for (const error of consoleErrors.slice(0, 20)) console.log(`  ${error}`)
  }
  assert.deepEqual(pageErrors, [], 'страница бросила исключение')
  assert.deepEqual(consoleErrors, [], 'консоль редактора в ошибках')
  ok('консоль и страница чисты: без харнесса панель работает сама')
} finally {
  await browser.close()
  child.kill('SIGTERM')
  await rm(home, { recursive: true, force: true })
  await rm(projectRoot, { recursive: true, force: true })
}

console.log(`\nАвтономное окно редактора в порядке: ${checks} проверок.`)
