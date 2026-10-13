/**
 * Плагин визуальных макетов (design canvas) для DeepSeek Harness.
 *
 * Даёт две половины одной системы:
 *  - инструменты агента `design_*` — агент собирает и правит макеты как код;
 *  - панель «Макеты» в веб-интерфейсе — Figma-подобный редактор тех же файлов.
 *
 * Холсты каждого проекта живут в его репозитории (`<root>/.design/`), поэтому
 * дизайн версионируется вместе с кодом и виден и агенту, и человеку.
 *
 * Логика разложена по слоям: `schema.js` (модель), `store.js` (файлы),
 * `ops.js` (операции), `export.js` (HTML/CSS), `service.js` (сценарии),
 * `tools.js` (инструменты агента), `route.js` (HTTP), `client.js` (редактор).
 */
import { registerTools } from './tools.js'
import { DESIGN_ROUTE, createDesignHandler } from './route.js'

const name = 'design-canvas'
const inject = ['tools']

/**
 * Точка входа плагина Cordis.
 *
 * @param {object} ctx Контекст плагина.
 * @param {object} [config] `{ project }` — проект по умолчанию, когда агент не назвал его.
 */
export function apply(ctx, config = {}) {
  registerTools(ctx, config)

  // Маршрут живёт на сервисе `webServer`, который есть только в web-композициях:
  // жёсткая зависимость (`inject = ['webServer']`) выключила бы плагин в headless.
  // `ctx.inject` — мягкий путь: если сервис уже есть, тело выполняется сразу, а
  // при его замене маршрут снимается и регистрируется на новом сервере. Быстрый
  // путь через `ctx.get` этого не даёт: маршрут остался бы на выгруженном
  // сервере, а новый отвечал бы 404.
  const handler = createDesignHandler()
  const install = (scope, server) => scope.effect(
    () => server.register({ kind: 'prefix', path: DESIGN_ROUTE, handler }),
    'design-canvas: http route',
  )
  ctx.inject(['webServer'], (scope) => install(scope, scope.webServer))
}

export { name, inject, DESIGN_ROUTE }
