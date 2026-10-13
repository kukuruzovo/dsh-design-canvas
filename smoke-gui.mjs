/**
 * Проверка панели «Макеты» в реальном веб-интерфейсе через Playwright.
 *
 * Скрипт открывает живой экземпляр DSH, авторизуется по токену из адреса,
 * открывает панель и прогоняет сценарий редактора: холст отрисован, узел
 * выделяется, инспектор показывает действующие значения, вкладки работают,
 * правка уходит в автосохранение и поднимает ревизию. Параллельно собираются
 * ошибки консоли и необработанные исключения страницы — именно они обычно и
 * ломают клиентский плагин.
 *
 * Запуск:
 *   DSH_WEB_TOKEN=<токен> node smoke-gui.mjs http://127.0.0.1:3099 .gui-shot.png
 *
 * Playwright берётся из установленного пакета или из кеша `npx`.
 */
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const base = (process.argv[2] ?? 'http://127.0.0.1:3099').replace(/\/$/, '')
const shot = process.argv[3] ?? '.gui-shot.png'

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

const { chromium } = await loadPlaywright()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })

const consoleErrors = []
const pageErrors = []
// 409 — не сбой, а рабочий протокол: так панель узнаёт о внешней правке.
const EXPECTED = /409 \(Conflict\)/
page.on('console', (message) => {
  if (message.type() === 'error' && !EXPECTED.test(message.text())) consoleErrors.push(message.text())
})
page.on('pageerror', (error) => pageErrors.push(String(error)))

let checks = 0
const ok = (label) => {
  checks += 1
  console.log(`  ✓ ${label}`)
}

const token = process.env.DSH_WEB_TOKEN
await page.goto(token ? `${base}/?token=${token}` : `${base}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3500)

// ------------------------------------------------------- клиентский модуль ----
const modules = await page.evaluate(() => {
  const links = [...document.querySelectorAll('link[href*="plugins/"]')].map((el) => el.getAttribute('href'))
  return links.join(',').match(/@local\/[^,&]+/g) ?? []
})
assert.ok(modules.includes('@local/dsh-design-canvas/client.js'), `модуль плагина не загружен: ${modules.join(', ')}`)
ok(`клиентский модуль загружен: ${modules.join(', ')}`)

// ---------------------------------------------------------------- панель ----
const icon = page.getByRole('button', { name: 'Макеты', exact: false }).first()
assert.ok(await icon.count() > 0, 'иконка панели «Макеты» не найдена в левой колонке')
await icon.click()
await page.waitForTimeout(2500)
ok('панель «Макеты» открыта из левой колонки')

const panel = page.locator('.dc-viewport')
assert.ok(await panel.count() > 0, 'вьюпорт редактора не отрисован')
const nodes = await page.locator('[data-node-id]').count()
assert.ok(nodes >= 20, `узлов на холсте: ${nodes}`)
ok(`холст отрисован: ${nodes} узлов с data-node-id`)

const status = await page.locator('text=/ревизия/').first().innerText().catch(() => '')
assert.match(status, /ревизия/, 'статус-бар не показывает ревизию')
ok(`статус-бар: ${status.replace(/\s+/g, ' ').trim()}`)

// -------------------------------------------------------------- выделение ----
await page.locator('.dc-viewport').getByText('История', { exact: true }).click()
await page.waitForTimeout(800)
const selected = await page.locator('.dc-node-selected').count()
assert.ok(selected > 0, 'узел не подсветился как выделенный')
ok('клик по узлу выделяет его на холсте')

// Инспектор должен показывать ДЕЙСТВУЮЩЕЕ значение параметра компонента,
// а не объявленное по умолчанию: на холсте нарисовано «История».
const inputs = await page.evaluate(() => [...document.querySelectorAll('input,textarea')].map((el) => el.value))
assert.ok(inputs.includes('История'), `инспектор не показал действующее значение label (есть: ${inputs.slice(0, 12).join(' | ')})`)
ok('инспектор показывает действующее значение параметра компонента')
assert.ok(inputs.some((value) => String(value).includes('вопроса')), 'инспектор не показал второй параметр инстанса')
ok('второй объявленный параметр тоже на месте')

// ----------------------------------------------------------------- вкладки ----
const tabText = async (name) => {
  await page.getByRole('button', { name, exact: true }).first().click()
  await page.waitForTimeout(700)
  return page.evaluate(() => document.body.innerText)
}
assert.match(await tabText('Слои'), /TopicCard/, 'дерево слоёв не показывает узлы')
ok('вкладка «Слои»: дерево построено')
assert.match(await tabText('Компоненты'), /topic-card/, 'библиотека компонентов пуста')
ok('вкладка «Компоненты»: библиотека на месте')
assert.match(await tabText('Токены'), /color\.bg/, 'редактор токенов пуст')
ok('вкладка «Токены»: токены на месте')
await tabText('Холсты')

// ------------------------------------------------------------- автосохранение ----
const revBefore = Number((await page.locator('text=/ревизия \\d+/').first().innerText().catch(() => '')).match(/ревизия (\d+)/)?.[1] ?? 0)
const xField = page.locator('input[type="number"]').first()
// Значение меняется на единицу от текущего: тест идемпотентен и не зависит
// от того, что осталось на диске после прошлого прогона.
const xCurrent = Number(await xField.inputValue()) || 0
await xField.fill(String(xCurrent + 1))
await xField.press('Enter')
await page.waitForTimeout(2500)
const revAfter = Number((await page.locator('text=/ревизия \\d+/').first().innerText().catch(() => '')).match(/ревизия (\d+)/)?.[1] ?? 0)
assert.ok(revAfter > revBefore, `ревизия не выросла: было ${revBefore}, стало ${revAfter}`)
ok(`правка сохранена автосохранением: ревизия ${revBefore} → ${revAfter}`)

// ----------------------------------------------------------------- проверка ----
await page.getByRole('button', { name: 'Проверить', exact: false }).first().click()
await page.waitForTimeout(1800)
const afterValidate = await page.evaluate(() => document.body.innerText)
assert.match(afterValidate, /Ошибок|ошиб|замечан/i, 'панель проверки не открылась')
ok('кнопка «Проверить» показала результат')

// ------------------------------------------- конфликт с внешней правкой ----
// Пока панель держит холст открытым, «агент» пишет в тот же файл. Панель
// обязана это заметить (409), а не затереть чужую правку молча.
const conflictRev = revAfter
const external = await fetch(`${base}/api/dsh-design-canvas/apply`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: await page.evaluate(() => document.cookie) },
  body: JSON.stringify({
    project: 'demo',
    canvas: 'quiz-home',
    expectRev: conflictRev,
    ops: [{ op: 'set-canvas', name: 'QuizForge — Home' }],
  }),
})
assert.equal(external.status, 200, `внешняя правка не прошла: ${external.status}`)
const externalBody = await external.json()
ok(`внешняя правка (как от агента) подняла ревизию до ${externalBody.rev}`)

const xAgain = page.locator('input[type="number"]').first()
await xAgain.fill(String(Number(await xAgain.inputValue()) + 1))
await xAgain.press('Enter')
await page.waitForTimeout(2500)
const conflictText = await page.evaluate(() => document.body.innerText)
assert.match(conflictText, /верси|диск|Перезаписать/i, 'панель не показала баннер конфликта ревизий')
ok('конфликт ревизий показан баннером с выбором версии')

await page.screenshot({ path: shot })
console.log(`\nСкриншот: ${shot}`)

// ------------------------------------------------------------------ ошибки ----
if (pageErrors.length > 0) {
  console.log('\nИсключения страницы:')
  for (const error of pageErrors) console.log(`  ${error}`)
}
if (consoleErrors.length > 0) {
  console.log('\nОшибки консоли:')
  for (const error of consoleErrors.slice(0, 20)) console.log(`  ${error}`)
}
await browser.close()

console.log(`\nПанель в порядке: ${checks} проверок.`)
if (pageErrors.length > 0 || consoleErrors.length > 0) {
  console.log('Есть ошибки в консоли — см. выше.')
  process.exitCode = 1
}
