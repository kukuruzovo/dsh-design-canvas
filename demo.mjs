/**
 * Демонстрационный холст: экран приложения, собранный инструментами агента.
 *
 * Скрипт показывает типовой рабочий цикл и одновременно служит фикстурой для
 * проверки панели в браузере: токены, компонент с параметрами, три его
 * инстанса, потоковый фрейм нижней навигации.
 *
 * Запуск: `node demo.mjs` — создаёт `demo/.design/quiz-home.canvas.json`.
 */
import { mkdir, rm, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, 'demo')

const { ensureProject, DESIGN_DIR } = await import('./store.js')
const { createView, applyBatch, exportView, validateView } = await import('./service.js')

// Пересобирается только `.design/`: превью `demo/preview*.png`, на которые
// ссылается README, собираются отдельно (`npm run preview`) и должны уцелеть.
await rm(join(root, DESIGN_DIR), { recursive: true, force: true })
await mkdir(root, { recursive: true })
const project = await ensureProject(root, 'Design canvas — демо')

await createView(project.id, 'quiz-home', { name: 'QuizForge — Home', device: 'mobile', overwrite: true })

const ops = [
  // ---------------------------------------------------------------- токены ----
  { op: 'set-tokens', tokens: { color: { surface: '#141a24', surfaceAlt: '#1b2230', accent: '#5b8cff', accentFg: '#0b0d10' } } },

  // ---------------------------------------------------------------- шапка ----
  { op: 'add', parent: 'page', node: {
    id: 'header', type: 'frame', name: 'Header', x: 0, y: 0, w: 390, h: 140,
    style: { fill: 'token:color.bg', radius: 0, clip: false },
  } },
  { op: 'add', parent: 'header', node: {
    id: 'headerTitle', type: 'text', name: 'HeaderTitle', x: 24, y: 56, w: 300, h: 44,
    text: { value: 'Викторины', token: 'text.h1', color: 'token:color.fg' },
  } },
  { op: 'add', parent: 'header', node: {
    id: 'headerSub', type: 'text', name: 'HeaderSub', x: 24, y: 100, w: 320, h: 24,
    text: { value: 'Выбери тему и начни', token: 'text.body', color: 'token:color.fgMuted' },
  } },

  // ------------------------------------------------------- карточка темы ----
  { op: 'add', parent: 'page', node: {
    id: 'card', type: 'frame', name: 'TopicCard', x: 20, y: 160, w: 350, h: 92,
    style: { fill: 'token:color.surface', radius: 'token:radius.md', shadow: 'token:shadow.card', clip: false },
  } },
  { op: 'add', parent: 'card', node: {
    id: 'cardIcon', type: 'rect', name: 'CardIcon', x: 20, y: 24, w: 44, h: 44,
    style: { fill: 'token:color.accent', radius: 'token:radius.sm' },
  } },
  { op: 'add', parent: 'card', node: {
    id: 'cardTitle', type: 'text', name: 'CardTitle', x: 80, y: 22, w: 240, h: 28,
    text: { value: 'История', token: 'text.h2', color: 'token:color.fg' },
  } },
  { op: 'add', parent: 'card', node: {
    id: 'cardMeta', type: 'text', name: 'CardMeta', x: 80, y: 52, w: 240, h: 22,
    text: { value: '24 вопроса · 12 мин', token: 'text.caption', color: 'token:color.fgMuted' },
  } },
  { op: 'define-component', key: 'topic-card', from: 'card', name: 'TopicCard', description: 'Карточка темы викторины', props: {
    label: { type: 'text', default: 'Тема', description: 'Название темы', target: '#CardTitle', property: 'text.value' },
    meta: { type: 'text', default: '0 вопросов', description: 'Подпись под названием', target: '#CardMeta', property: 'text.value' },
    tone: { type: 'color', default: 'token:color.accent', description: 'Цвет иконки', target: '#CardIcon', property: 'style.fill' },
  } },

  // -------------------------------------------------------- кнопка (CTA) ----
  { op: 'add', parent: 'page', node: {
    id: 'cta', type: 'frame', name: 'ButtonPrimary', x: 20, y: 470, w: 350, h: 52,
    style: { fill: 'token:color.accent', radius: 'token:radius.pill', clip: true },
    layout: { mode: 'horizontal', align: 'center', justify: 'center', padding: { t: 0, r: 20, b: 0, l: 20 } },
  } },
  { op: 'add', parent: 'cta', node: {
    id: 'ctaLabel', type: 'text', name: 'Label', x: 0, y: 0, w: 200, h: 24,
    text: { value: 'Начать викторину', token: 'text.body', color: 'token:color.accentFg', align: 'center', valign: 'middle' },
  } },
  { op: 'define-component', key: 'button-primary', from: 'cta', name: 'Button / Primary', description: 'Основное действие экрана' },

  // -------------------------------------------------------------- нижнее ----
  { op: 'add', parent: 'page', node: {
    id: 'tabbar', type: 'frame', name: 'TabBar', x: 0, y: 760, w: 390, h: 84,
    style: { fill: 'token:color.surface', radius: 0, clip: true },
    layout: { mode: 'horizontal', align: 'center', justify: 'space-between', gap: 0, padding: { t: 0, r: 32, b: 0, l: 32 } },
  } },

  // ------------------------------------------------------------- инстансы ----
  { op: 'instantiate', component: 'topic-card', parent: 'page', x: 20, y: 268, overrides: { label: 'Наука', meta: '18 вопросов · 9 мин', tone: 'token:color.success' } },
  { op: 'instantiate', component: 'topic-card', parent: 'page', x: 20, y: 376, overrides: { label: 'Кино', meta: '31 вопрос · 15 мин', tone: 'token:color.danger' } },
  { op: 'instantiate', component: 'button-primary', parent: 'page', x: 20, y: 690, overrides: { label: 'Случайная тема' } },
]

const applied = await applyBatch(project.id, 'quiz-home', ops, { force: true })

// Вкладки нижней навигации: четыре подписи в потоковом фрейме.
const tabs = ['Главная', 'Темы', 'Рейтинг', 'Профиль']
const tabOps = []
tabs.forEach((label, index) => {
  tabOps.push({ op: 'add', parent: 'tabbar', node: {
    id: `tab${index}`, type: 'frame', name: `Tab ${index + 1}`, x: 0, y: 0, w: 80, h: 44,
    style: { fill: null, radius: 0, clip: false },
    layout: { mode: 'vertical', align: 'center', justify: 'center', gap: 4 },
  } })
  tabOps.push({ op: 'add', parent: `tab${index}`, node: {
    id: `tab${index}Icon`, type: 'ellipse', name: 'Icon', x: 0, y: 0, w: 20, h: 20,
    style: { fill: index === 0 ? 'token:color.accent' : 'token:color.border' },
  } })
  tabOps.push({ op: 'add', parent: `tab${index}`, node: {
    id: `tab${index}Label`, type: 'text', name: 'Label', x: 0, y: 0, w: 80, h: 16,
    text: { value: label, token: 'text.caption', color: index === 0 ? 'token:color.fg' : 'token:color.fgMuted', align: 'center' },
  } })
})
const withTabs = await applyBatch(project.id, 'quiz-home', tabOps, { force: true })

const validation = await validateView(project.id, 'quiz-home', { contrast: true })
const exported = await exportView(project.id, 'quiz-home', { mode: 'clean', write: true })

console.log(`Демо-холст: ${withTabs.path}`)
console.log(`  узлов ${validation.stats.nodes}, компонентов ${validation.stats.components}, инстансов ${validation.stats.instances}`)
console.log(`  ревизия ${withTabs.rev}, ошибок ${validation.stats.errors}, предупреждений ${validation.stats.warnings}`)
for (const file of exported.files) console.log(`  ${file.name} — ${file.bytes} байт → ${file.path}`)
if (validation.issues.length > 0) {
  console.log('  замечания:')
  for (const issue of validation.issues.slice(0, 10)) console.log(`    [${issue.level}] ${issue.message}`)
}

// Фикстура — это контракт для `smoke-gui.mjs`: панельный прогон открывает проект
// с id «demo», холст «quiz-home», кликает по узлу «История» и ищет компонент
// `topic-card` с токеном `color.bg`. Расхождение здесь ломает браузерную проверку
// далеко от причины, поэтому контракт проверяется сразу после сборки.
const fixture = JSON.parse(await readFile(join(root, DESIGN_DIR, 'quiz-home.canvas.json'), 'utf8'))
const flat = JSON.stringify(fixture)
assert.equal(project.id, 'demo', 'панельный прогон открывает проект по id «demo»')
assert.equal(fixture.id, 'quiz-home', 'панельный прогон открывает холст «quiz-home»')
assert.ok(validation.stats.nodes >= 20, `узлов на холсте: ${validation.stats.nodes} — smoke-gui ждёт не меньше 20`)
assert.ok(fixture.components['topic-card'], 'компонент topic-card нужен вкладке «Компоненты»')
assert.ok(fixture.tokens.color.bg, 'токен color.bg нужен вкладке «Токены»')
assert.ok(flat.includes('История'), 'smoke-gui кликает по узлу «История»')
assert.ok(flat.includes('вопроса'), 'smoke-gui читает действующее значение второго параметра')
assert.equal(validation.stats.errors, 0, `ошибок валидации: ${validation.issues.map((issue) => issue.message).join('; ')}`)
assert.equal(exported.files.length, 3, `файлов экспорта: ${exported.files.map((file) => file.name).join(', ')}`)
console.log(`  фикстура панели проверена: проект ${project.id}, холст ${fixture.id}, ${validation.stats.nodes} узлов, ${exported.files.length} файла экспорта`)
