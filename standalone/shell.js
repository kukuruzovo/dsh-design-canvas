/**
 * Оболочка автономного редактора макетов: поднимает ту же клиентскую половину
 * плагина (`client.js`), что и веб-интерфейс DSH, но без харнесса.
 *
 * Внутри DSH `client.js` получает из хоста две вещи, которых в отдельном окне
 * нет: загрузчик модулей (`window.__ModuleLoader__`) и контекст плагина с
 * сервисами `slots` и `locale`. Здесь их заменяет тонкий шим — ровно те вызовы,
 * которые панель действительно делает: `effect`, `locale.register/bind` и
 * `slots.inject/register`. Логика редактора не дублируется: `client.js`
 * подключается как есть, а данные приходят с того же маршрута
 * `/api/dsh-design-canvas`, который поднимает `standalone.js`.
 *
 * Порядок загрузки (см. `index.html`): React → этот файл → `client.js`.
 * Оболочка стартует на `DOMContentLoaded`, когда модуль уже зарегистрирован.
 */
;(function () {
  'use strict'

  /** id панели: под ним модуль регистрирует слот `main`. */
  const PANEL_ID = 'design-canvas'
  /** Язык автономного окна: словари панели приходят из `client.js`. */
  const LOCALE = 'ru'
  /** Ключ localStorage, в котором оболочка помнит выбранную тему. */
  const LS_THEME = 'dsh.design.theme'

  /** Зарегистрированный модуль панели: заполняется вызовом `load`. */
  let registered = null

  /**
   * Шим загрузчика клиентских модулей DSH.
   *
   * Настоящий загрузчик собирает модули в очередь, разрешает зависимости и
   * следит за выгрузкой. Автономной оболочке достаточно запомнить фабрику:
   * других модулей на странице нет.
   */
  window.__ModuleLoader__ = {
    /**
     * Принять модуль от бандла плагина.
     *
     * @param {{id: string, factory: (require: (name: string) => unknown) => object}} spec
     */
    load(spec) {
      registered = spec
    },
  }

  /**
   * Разрешение зависимостей клиентского модуля.
   *
   * `client.js` просит только React — он приходит из вендорного UMD-бандла,
   * положенного на страницу до оболочки.
   *
   * @param {string} name Имя модуля.
   * @returns {unknown}
   */
  function requireModule(name) {
    if (name === 'react') return window.React
    throw new Error(`Автономная оболочка не знает модуль «${name}».`)
  }

  /**
   * Контекст плагина в объёме, который использует панель.
   *
   * @param {object} options `{ locale, onMain }` — язык и получатель слота `main`.
   * @returns {object} Объект с сервисами `effect`, `locale`, `slots` и `dispose`.
   */
  function createContext({ locale, onMain }) {
    /** Словари, зарегистрированные панелью: `{ ru, en, zh }`. */
    const tables = new Map()
    /** Уборщики, возвращённые эффектами и регистрациями. */
    const disposers = []

    return {
      /**
       * Выполнить эффект и запомнить его уборщик — как `ctx.effect` в DSH.
       *
       * @param {() => (void | (() => void))} fn Тело эффекта.
       * @returns {() => void} Уборщик.
       */
      effect(fn) {
        const dispose = fn()
        const run = typeof dispose === 'function' ? dispose : () => {}
        disposers.push(run)
        return run
      },

      locale: {
        /**
         * Зарегистрировать словари панели.
         *
         * @param {string} ns Пространство имён.
         * @param {object} table Словари по языкам.
         * @returns {() => void} Уборщик регистрации.
         */
        register(ns, table) {
          tables.set(ns, table)
          return () => tables.delete(ns)
        },

        /**
         * Привязать перевод к пространству имён.
         *
         * Подстановка `{param}` остаётся панели: она форматирует строки сама,
         * чтобы не зависеть от синтаксиса харнесса.
         *
         * @param {string} ns Пространство имён.
         * @returns {(key: string, params?: object) => string} Функция перевода.
         */
        bind(ns) {
          return (key, params) => {
            const table = tables.get(ns) ?? {}
            const dict = table[locale] ?? table.ru ?? {}
            let text = dict[key] ?? table.ru?.[key] ?? key
            for (const [name, value] of Object.entries(params ?? {})) {
              text = text.split(`{${name}}`).join(String(value))
            }
            return text
          }
        },
      },

      slots: {
        /**
         * Выполнить тело, когда слот доступен. Автономная оболочка владеет
         * страницей целиком, поэтому слоты есть всегда.
         *
         * @param {string} _name Имя слота.
         * @param {() => unknown} fn Тело регистрации.
         * @returns {unknown}
         */
        inject(_name, fn) {
          return fn()
        },

        /**
         * Принять компонент слота.
         *
         * Слот `main` с ключом панели становится содержимым окна; остальные
         * (`sidebar.panellist`) в автономном окне не нужны — сайдбара нет.
         *
         * @param {{name: string, key?: string, id?: string}} desc Описание слота.
         * @param {Function} component Компонент слота.
         * @returns {() => void} Уборщик.
         */
        register(desc, component) {
          if (desc?.name === 'main' && (desc.key ?? desc.id) === PANEL_ID) onMain(component)
          return () => {}
        },
      },

      /** Снять эффекты — пригодится, если оболочку когда-нибудь перезапустят. */
      dispose() {
        for (const dispose of disposers.splice(0)) dispose()
      },
    }
  }

  /**
   * Показать ошибку запуска прямо в окне: консоль в отдельном окне смотрят
   * редко, а пустая страница не говорит ничего.
   *
   * @param {string} message Что случилось.
   * @param {Error} [cause] Исключение, если оно было.
   */
  function showFailure(message, cause) {
    const app = document.getElementById('shell-app')
    if (!app) return
    app.textContent = ''
    const box = document.createElement('div')
    box.className = 'shell-error'
    const title = document.createElement('div')
    title.textContent = `Редактор не запустился: ${message}`
    box.appendChild(title)
    if (cause) {
      const details = document.createElement('pre')
      details.textContent = String(cause.stack ?? cause.message ?? cause)
      box.appendChild(details)
    }
    app.appendChild(box)
  }

  /** Текущая тема окна: из localStorage, иначе — из системных настроек. */
  function initialTheme() {
    try {
      const stored = window.localStorage.getItem(LS_THEME)
      if (stored === 'light' || stored === 'dark') return stored
    } catch {
      // Приватный режим: тема берётся из системных настроек.
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  /**
   * Поставить тему и запомнить выбор.
   *
   * @param {'light'|'dark'} theme Тема окна.
   */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem(LS_THEME, theme)
    } catch {
      // Приватный режим: тема живёт до перезагрузки.
    }
  }

  /** Подключить переключатель темы в шапке оболочки. */
  function wireTheme() {
    applyTheme(initialTheme())
    const button = document.getElementById('shell-theme')
    if (!button) return
    button.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
    })
  }

  /** Поднять панель: собрать контекст, вызвать модуль и отрисовать слот `main`. */
  function boot() {
    wireTheme()
    const app = document.getElementById('shell-app')
    const React = window.React
    const ReactDOM = window.ReactDOM

    if (!React?.createElement || !ReactDOM?.createRoot) {
      showFailure('не загрузился React (проверь vendor/react.js и vendor/react-dom.js)')
      return
    }
    if (!registered || typeof registered.factory !== 'function') {
      showFailure('клиентский модуль панели не зарегистрировался (проверь client.js)')
      return
    }

    let main = null
    const ctx = createContext({ locale: LOCALE, onMain: (component) => { main = component } })
    try {
      const module = registered.factory(requireModule)
      module.apply(ctx)
    } catch (error) {
      showFailure('модуль панели упал на старте', error)
      return
    }
    if (!main) {
      showFailure('модуль панели не зарегистрировал слот main')
      return
    }
    ReactDOM.createRoot(app).render(React.createElement(main, {}))
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
