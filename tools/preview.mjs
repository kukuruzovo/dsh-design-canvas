/**
 * Пересборка превью демо-холста для README.
 *
 * Скриншоты снимаются с уже сгенерированного экспорта (`demo/.design/exports/`),
 * а не с живой панели: это чистая, воспроизводимая картинка без авторизации.
 * Снимок самой панели «Макеты» делает `smoke-gui.mjs` на живом DSH — ему нужен токен.
 *
 * Запуск:
 *   node demo.mjs                 # сначала пересобрать экспорт
 *   node tools/preview.mjs        # затем снять demo/preview*.png
 *
 * Playwright берётся из установленного пакета или из кеша `npx`.
 */
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exportsDir = join(root, 'demo', '.design', 'exports')

/**
 * Снимки: файл экспорта → куда положить превью и что снимать.
 *
 * Кадр считается по объединению прямоугольников `union`: доска экспорта держит
 * фреймы абсолютным позиционированием, поэтому её собственная рамка схлопнута.
 */
const SHOTS = [
  { html: 'quiz-home.html', png: 'preview.png', union: '.dc-frame', width: 900, height: 1000, pad: 24 },
  { html: 'quiz-home.components.html', png: 'preview-components.png', union: '.dc-sheet-cell', width: 1100, height: 800, pad: 28 },
]

/** Найти Playwright: обычный импорт, затем кеш npx. */
async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    const cache = join(homedir(), '.npm', '_npx')
    for (const dir of await readdir(cache).catch(() => [])) {
      const candidate = join(cache, dir, 'node_modules', 'playwright', 'index.mjs')
      try {
        return await import(candidate)
      } catch {
        // Пробуем следующий каталог кеша.
      }
    }
    throw new Error('Playwright не найден: установи его или прогрей `npx playwright --version`.')
  }
}

/** Объединить прямоугольники элементов в один кадр с полями. */
async function unionClip(page, selector, pad) {
  return page.evaluate(({ selector, pad }) => {
    const boxes = [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect())
    if (boxes.length === 0) return null
    const left = Math.min(...boxes.map((box) => box.left + window.scrollX))
    const top = Math.min(...boxes.map((box) => box.top + window.scrollY))
    const right = Math.max(...boxes.map((box) => box.right + window.scrollX))
    const bottom = Math.max(...boxes.map((box) => box.bottom + window.scrollY))
    return {
      x: Math.max(0, left - pad),
      y: Math.max(0, top - pad),
      width: Math.ceil(right - left + pad * 2),
      height: Math.ceil(bottom - top + pad * 2),
    }
  }, { selector, pad })
}

const { chromium } = await loadPlaywright()
const browser = await chromium.launch()
try {
  for (const shot of SHOTS) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 2 })
    await page.goto(pathToFileURL(join(exportsDir, shot.html)).href, { waitUntil: 'load' })
    const output = join(root, 'demo', shot.png)
    const clip = await unionClip(page, shot.union, shot.pad)
    if (clip === null) {
      await page.screenshot({ path: output, fullPage: true })
      process.stdout.write(`preview: ${shot.png} — элементов ${shot.union} нет, снят весь документ\n`)
    } else {
      await page.screenshot({ path: output, clip })
      process.stdout.write(`preview: ${shot.png} — ${clip.width}×${clip.height} по ${shot.union}\n`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}
