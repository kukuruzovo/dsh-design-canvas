/**
 * Клиентская половина плагина «Макеты» (design canvas) для DeepSeek Harness:
 * Figma-подобный редактор холстов прямо в веб-интерфейсе.
 *
 * Регистрирует две точки расширения под ОДНИМ id `design-canvas`:
 *  - `sidebar.panellist` — иконка в левой колонке (клик зовёт
 *    `ctx.layout.selectPanel('design-canvas')`);
 *  - `main` — сама панель под тем же ключом.
 *
 * Данные живут в файлах проекта (`<root>/.design/<id>.canvas.json`) и читаются
 * через host-маршрут `/api/dsh-design-canvas` — тот же код, что у инструментов
 * агента `design_*`. Панель не знает про файловую систему: только JSON.
 *
 * Что делает редактор: выбирает проект и холст, рисует все верхние фреймы,
 * даёт выделять/двигать/ресайзить узлы, правит инспектор, слои, токены и
 * компоненты, держит локальную историю (undo/redo), автосохраняет документ
 * через `POST /canvas` с `expectRev` и умеет экспорт и проверку.
 *
 * Разделы файла: словари → CSS → утилиты модели → подкомпоненты → панель →
 * иконка сайдбара → регистрация.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-design-canvas',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const PKG = '@local/dsh-design-canvas'
    const NS = 'design-canvas'
    const PANEL_ID = 'design-canvas'
    const API = '/api/dsh-design-canvas'

    /** Ключи localStorage: панель помнит последний проект и холст. */
    const LS_PROJECT = 'dsh.design.project'
    const LS_CANVAS = 'dsh.design.canvas'

    /** Задержка автосохранения после последней правки. */
    const SAVE_DEBOUNCE = 700
    /** Глубина локальной истории правок. */
    const HISTORY_LIMIT = 60
    /** Минимальный размер узла при ресайзе. */
    const MIN_SIZE = 1
    /** Размер новых узлов, если пользователь не тянул мышью. */
    const DEFAULT_BOX = { rect: [120, 120], ellipse: [120, 120], text: [200, 28], frame: [390, 844], group: [120, 120] }
    /** Виды диалога, которые рисует `DialogHost`; остальные — сама панель. */
    const DIALOG_KINDS = ['canvas', 'component', 'init']
    /** Типы объявленных параметров компонента — те же, что понимает схема. */
    const PROP_TYPES = ['text', 'color', 'number', 'boolean', 'token']
    /** Размер линеек вьюпорта. */
    const RULER_SIZE = 18
    /** Порог привязки к объектам и направляющим — в экранных пикселях. */
    const SNAP_THRESHOLD = 6
    /**
     * Цвета оверлеев редактора: наведение, предки, направляющие, замеры.
     *
     * Хранятся строкой в JS, а не в CSS: тема харнесса не знает про разметку
     * редактора, а подписи и линии должны читаться и на светлом, и на тёмном
     * макете, поэтому цвета не берутся из `--dsw-*`.
     */
    const OVERLAY_COLOR = {
      hover: '#0d99ff',
      ancestor: '#8a94a6',
      measure: '#f24822',
      guide: '#0d99ff',
      pad: 'rgba(13,153,255,0.14)',
    }

    // =============================================================== словари ====

    /** Русский — основной словарь панели. */
    const RU = {
      panel: 'Макеты',
      loading: 'Загрузка…',
      unknown: '—',

      toolSelect: 'Выделение (V)',
      toolFrame: 'Фрейм (F)',
      toolRect: 'Прямоугольник (R)',
      toolEllipse: 'Эллипс (O)',
      toolText: 'Текст (T)',
      tools: 'Инструменты',
      undo: 'Отменить (Ctrl+Z)',
      redo: 'Вернуть (Ctrl+Shift+Z)',
      save: 'Сохранить (Ctrl+S)',
      export: 'Экспорт',
      validate: 'Проверить',
      refresh: 'Обновить',
      zoomIn: 'Приблизить',
      zoomOut: 'Отдалить',
      zoomFit: 'Вписать в экран',
      zoomReset: 'Масштаб 100%',
      componentSearch: 'Поиск по имени или ключу',
      componentOpen: 'Открыть компонент',
      componentNotFound: 'Ничего не найдено',
      componentDescription: 'Описание',
      componentProps: 'Параметры',
      componentPropsHint: 'Параметр — это поле компонента: имя, тип, значение по умолчанию и цель (root, text, #Имя узла или путь). Клик по имени узла подставляет цель.',
      componentInstancesHint: 'Инстансов на холсте: {count}',
      componentVariants: 'Вариации',
      componentVariantsHint: 'Вариация — тот же компонент с другим шаблоном: параметры и переопределения инстанса общие.',
      variantsEmpty: 'Вариаций нет. Выделите узел на холсте и добавьте его как вариацию.',
      variantsCount: 'вариаций: {count}',
      variantAdd: 'Вариация из выделения',
      variantAddHint: 'Выделите один узел на холсте, чтобы сделать его вариацией',
      variantRemove: 'Удалить вариацию',
      instanceVariant: 'Вариация',
      componentFindShort: 'Найти',
      componentUpdated: 'Компонент «{key}» обновлён',
      componentDuplicated: 'Компонент скопирован: {key}',
      componentPushed: 'Правки инстанса вынесены в компонент',
      componentNoInstances: 'Инстансов этого компонента на холсте нет',
      propName: 'имя',
      propType: 'тип',
      propDefault: 'значение',
      propTarget: 'цель',
      propProperty: 'свойство',
      propAdd: 'Параметр',
      propsApply: 'Сохранить параметры',
      propTargetHint: 'Сделать целью узел «{name}»',
      instanceSwap: 'Компонент инстанса',
      overridden: 'переопределено',
      resetOverride: 'Сбросить переопределение',
      resetOverrides: 'Сбросить все',
      pushToComponent: 'Вынести в компонент',
      overridesRaw: 'Точечные переопределения',
      insideScope: 'Внутри',
      escapeToExit: 'Esc — выйти',
      duplicate: 'Дублировать',
      copy: 'Копировать',
      paste: 'Вставить',
      group: 'Сгруппировать',
      wrapFrame: 'Объединить в фрейм',
      ungroup: 'Разгруппировать',
      groupOneParent: 'Группировать можно только узлы одного родителя.',
      orderFront: 'На передний план',
      orderUp: 'Выше',
      orderDown: 'Ниже',
      orderBack: 'На задний план',
      sectionAlign: 'Выравнивание',
      distributeX: 'Распределить по горизонтали (минимум три узла)',
      distributeY: 'Распределить по вертикали (минимум три узла)',
      copiedNodes: 'Скопировано узлов: {count}',
      pastedNodes: 'Вставлено узлов: {count}',
      viewOptions: 'Разметка холста',
      rulers: 'Линейки',
      rulersHint: 'Показать или скрыть линейки (Shift+R)',
      guides: 'Линии',
      guidesHint: 'Показать или скрыть направляющие; тяните из линейки, чтобы поставить новую',
      guidesClear: 'Убрать все направляющие',
      snap: 'Привязка',
      snapHint: 'Привязка к объектам, направляющим и сетке (Alt отключает)',

      tabCanvases: 'Холсты',
      tabLayers: 'Слои',
      tabComponents: 'Компоненты',
      tabTokens: 'Токены',

      project: 'Проект',
      canvas: 'Холст',
      canvasEmpty: 'Холстов нет',
      canvasNew: 'Новый холст',
      canvasId: 'id холста',
      canvasName: 'Имя холста',
      canvasDevice: 'Устройство',
      canvasTemplate: 'Шаблон',
      templateDevice: 'Фрейм устройства',
      templateBlank: 'Пустой холст',
      canvasCreated: 'Холст создан: {id}',
      canvasDeleted: 'Холст в корзине: {id}',
      canvasRestored: 'Холст восстановлен: {canvas}',
      create: 'Создать',
      cancel: 'Отмена',
      overwrite: 'Перезаписать',
      open: 'Открыть',
      deleteToTrash: 'В корзину',
      nodesShort: '{count} узлов',

      trash: 'Корзина',
      trashTitle: 'Корзина холстов',
      trashEmpty: 'Корзина пуста',
      trashBack: 'К холстам',
      restore: 'Восстановить',
      deletedAt: 'удалён {date}',

      layersEmpty: 'Нет узлов',
      rename: 'Переименовать',
      visibilityShow: 'Показать',
      visibilityHide: 'Скрыть',
      lock: 'Заблокировать',
      unlock: 'Разблокировать',
      moveUp: 'Выше',
      moveDown: 'Ниже',
      nodeDelete: 'Удалить',
      deleteNodeTitle: 'Удалить узел?',
      deleteNodeBody: 'Узел «{name}» и его дети будут удалены из документа.',
      instanceMark: 'инстанс',

      inspector: 'Инспектор',
      selectNodeHint: 'Выберите узел на холсте или в дереве слоёв',
      multiHint: 'Выделено узлов: {count} — общие поля применяются ко всем',
      sectionGeometry: 'Позиция и размер',
      x: 'X',
      y: 'Y',
      w: 'Ш',
      h: 'В',
      rotation: 'Поворот',
      opacity: 'Прозрачность',

      sectionFill: 'Заливка и обводка',
      fill: 'Заливка',
      stroke: 'Обводка',
      strokeColor: 'Цвет обводки',
      strokeWidth: 'Толщина',
      radius: 'Скругление',
      sectionShadow: 'Тень',
      shadow: 'Тень',
      shadowX: 'Смещение X',
      shadowY: 'Смещение Y',
      blur: 'Размытие',
      spread: 'Разброс',
      color: 'Цвет',
      shadowOn: 'Включить тень',
      strokeOn: 'Включить обводку',

      sectionLayout: 'Раскладка',
      layoutMode: 'Режим',
      layoutNone: 'Свободно',
      layoutVertical: 'Вертикально',
      layoutHorizontal: 'Горизонтально',
      gap: 'Отступ между',
      padding: 'Внутренние отступы',
      padTop: 'Сверху',
      padRight: 'Справа',
      padBottom: 'Снизу',
      padLeft: 'Слева',
      align: 'Выравнивание',
      justify: 'Распределение',
      alignStart: 'Начало',
      alignCenter: 'Центр',
      alignEnd: 'Конец',
      alignStretch: 'Растянуть',
      justifyStart: 'Начало',
      justifyCenter: 'Центр',
      justifyEnd: 'Конец',
      justifyBetween: 'Промежутки',

      sectionText: 'Текст',
      textValue: 'Значение',
      textToken: 'Токен',
      textAlign: 'По горизонтали',
      textValign: 'По вертикали',
      alignLeft: 'Влево',
      alignRight: 'Вправо',
      alignJustify: 'По ширине',
      valignTop: 'Сверху',
      valignMiddle: 'По центру',
      valignBottom: 'Снизу',
      fontSize: 'Размер',
      fontWeight: 'Насыщенность',
      lineHeight: 'Межстрочный',
      letterSpacing: 'Трекинг',
      textNoToken: '— без токена —',

      colorLiteral: 'литерал',
      colorToken: 'токен',
      colorPick: 'Выбрать цвет',

      sectionInstance: 'Инстанс',
      instanceComponent: 'Компонент',
      instanceMissing: 'Компонент не найден — инстанс пуст',
      instanceOverrideHint: 'Это инстанс: правки внешнего вида сохраняются как переопределения компонента.',
      detach: 'Отсоединить',
      detached: 'Инстанс отсоединён',
      propsEmpty: 'Нет объявленных параметров',
      propValue: 'Значение параметра',

      componentsTitle: 'Компоненты',
      componentsEmpty: 'Компонентов нет',
      componentDefine: 'Создать компонент из выделения',
      componentKey: 'Ключ',
      componentName: 'Имя',
      componentPlace: 'Поставить инстанс',
      componentDelete: 'Удалить компонент',
      componentInstances: 'инстансов: {count}',
      componentNodes: 'узлов: {count}',
      componentDefined: 'Компонент создан: {key}',
      componentDeleted: 'Компонент удалён: {key}',
      instancePlaced: 'Инстанс поставлен в «{parent}»',
      selectFirst: 'Сначала выделите узел на холсте',
      propsCount: 'параметров: {count}',

      tokensTitle: 'Токены',
      tokensApply: 'Применить',
      tokensHint: 'Плоские токены холста: цвета, радиусы, отступы, шрифты и составные пресеты текста и теней.',
      tokensApplied: 'Токены записаны',
      tokensEmpty: 'Токенов нет',
      tokensRevert: 'Отменить правки',

      exportTitle: 'Экспорт холста',
      exportMode: 'Режим',
      exportFidelity: 'fidelity — пиксельно точно',
      exportClean: 'clean — потоковая вёрстка',
      exportFrameOnly: 'Только текущий фрейм',
      exportRun: 'Экспортировать',
      exportPreview: 'Превью в новой вкладке',
      exportFiles: 'Файлы',
      exportWarnings: 'Предупреждения',
      exportEmpty: 'Файлы не записаны',
      exportDone: 'Экспортировано файлов: {count}',

      checkTitle: 'Проверка макета',
      checkRun: 'Проверить',
      checkEmpty: 'Замечаний нет',
      checkCount: 'Замечаний: {count}',
      levelError: 'ошибка',
      levelWarn: 'внимание',
      levelInfo: 'инфо',
      close: 'Закрыть',

      statusRev: 'ревизия {rev}',
      statusNodes: 'узлов: {count}',
      statusErrors: 'ошибок: {count}',
      statusWarnings: 'предупреждений: {count}',
      statusSelected: 'выделено: {count}',
      statusZoom: 'масштаб {zoom}%',
      savedState: 'сохранено',
      dirtyState: 'есть правки',
      savingState: 'сохранение…',
      errorState: 'ошибка сохранения',
      savedAt: 'Сохранено (ревизия {rev})',
      loadFailed: 'Не удалось загрузить данные',

      conflictTitle: 'Холст изменён вне панели',
      conflictBody: 'На диске ревизия {rev}, панель ждала {expected}. Выберите, чью версию оставить.',
      takeDisk: 'Взять версию с диска',
      overwriteMine: 'Перезаписать моей',
      conflictResolved: 'Взята версия с диска',

      hostDown: 'Host-плагин не загружен',
      hostHint: 'Маршрут {api} не отвечает. Проверьте, что плагин design-canvas включён в конфигурации DSH, и перезапустите сервер.',
      retry: 'Повторить',

      noProjects: 'Проекты с макетами не найдены',
      initTitle: 'Инициализировать проект',
      initRoot: 'Путь к проекту',
      initRootPlaceholder: '/home/user/project',
      initRun: 'Инициализировать',
      initHint: 'В каталоге появится папка .design/ и проект попадёт в реестр макетов.',
      projectInitialized: 'Проект инициализирован: {id}',
      noCanvases: 'В проекте ещё нет холстов — создайте первый',
      selectCanvas: 'Выберите холст в списке слева',
      panelHint: 'Холсты лежат в .design/ проекта и версионируются вместе с кодом.',
    }

    /** Английский — фолбэк для прочих локалей. */
    const EN = {
      panel: 'Designs',
      loading: 'Loading…',
      unknown: '—',

      toolSelect: 'Select (V)',
      toolFrame: 'Frame (F)',
      toolRect: 'Rectangle (R)',
      toolEllipse: 'Ellipse (O)',
      toolText: 'Text (T)',
      tools: 'Tools',
      undo: 'Undo (Ctrl+Z)',
      redo: 'Redo (Ctrl+Shift+Z)',
      save: 'Save (Ctrl+S)',
      export: 'Export',
      validate: 'Check',
      refresh: 'Refresh',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      zoomFit: 'Fit to screen',
      zoomReset: 'Zoom 100%',
      componentSearch: 'Search by name or key',
      componentOpen: 'Open component',
      componentNotFound: 'Nothing found',
      componentDescription: 'Description',
      componentProps: 'Properties',
      componentPropsHint: 'A property is a component field: name, type, default and target (root, text, #Node name or a path). Clicking a node name sets the target.',
      componentInstancesHint: 'Instances on canvas: {count}',
      componentVariants: 'Variants',
      componentVariantsHint: 'A variant is the same component with another template: properties and instance overrides are shared.',
      variantsEmpty: 'No variants yet. Select a node on the canvas and add it as a variant.',
      variantsCount: 'variants: {count}',
      variantAdd: 'Variant from selection',
      variantAddHint: 'Select a single node on the canvas to turn it into a variant',
      variantRemove: 'Remove variant',
      instanceVariant: 'Variant',
      componentFindShort: 'Find',
      componentUpdated: 'Component “{key}” updated',
      componentDuplicated: 'Component duplicated: {key}',
      componentPushed: 'Instance changes pushed to the component',
      componentNoInstances: 'No instances of this component on the canvas',
      propName: 'name',
      propType: 'type',
      propDefault: 'value',
      propTarget: 'target',
      propProperty: 'property',
      propAdd: 'Property',
      propsApply: 'Save properties',
      propTargetHint: 'Target the “{name}” node',
      instanceSwap: 'Instance component',
      overridden: 'overridden',
      resetOverride: 'Reset override',
      resetOverrides: 'Reset all',
      pushToComponent: 'Push to component',
      overridesRaw: 'Path overrides',
      insideScope: 'Inside',
      escapeToExit: 'Esc to exit',
      duplicate: 'Duplicate',
      copy: 'Copy',
      paste: 'Paste',
      group: 'Group',
      wrapFrame: 'Wrap in frame',
      ungroup: 'Ungroup',
      groupOneParent: 'Only nodes under the same parent can be grouped.',
      orderFront: 'Bring to front',
      orderUp: 'Bring forward',
      orderDown: 'Send backward',
      orderBack: 'Send to back',
      sectionAlign: 'Align',
      distributeX: 'Distribute horizontally (three nodes minimum)',
      distributeY: 'Distribute vertically (three nodes minimum)',
      copiedNodes: 'Copied nodes: {count}',
      pastedNodes: 'Pasted nodes: {count}',
      viewOptions: 'Canvas guides',
      rulers: 'Rulers',
      rulersHint: 'Show or hide rulers (Shift+R)',
      guides: 'Guides',
      guidesHint: 'Show or hide guides; drag from a ruler to place a new one',
      guidesClear: 'Remove all guides',
      snap: 'Snap',
      snapHint: 'Snap to objects, guides and the grid (Alt disables)',

      tabCanvases: 'Canvases',
      tabLayers: 'Layers',
      tabComponents: 'Components',
      tabTokens: 'Tokens',

      project: 'Project',
      canvas: 'Canvas',
      canvasEmpty: 'No canvases',
      canvasNew: 'New canvas',
      canvasId: 'Canvas id',
      canvasName: 'Canvas name',
      canvasDevice: 'Device',
      canvasTemplate: 'Template',
      templateDevice: 'Device frame',
      templateBlank: 'Blank canvas',
      canvasCreated: 'Canvas created: {id}',
      canvasDeleted: 'Canvas moved to trash: {id}',
      canvasRestored: 'Canvas restored: {canvas}',
      create: 'Create',
      cancel: 'Cancel',
      overwrite: 'Overwrite',
      open: 'Open',
      deleteToTrash: 'Move to trash',
      nodesShort: '{count} nodes',

      trash: 'Trash',
      trashTitle: 'Canvas trash',
      trashEmpty: 'Trash is empty',
      trashBack: 'Back to canvases',
      restore: 'Restore',
      deletedAt: 'deleted {date}',

      layersEmpty: 'No nodes',
      rename: 'Rename',
      visibilityShow: 'Show',
      visibilityHide: 'Hide',
      lock: 'Lock',
      unlock: 'Unlock',
      moveUp: 'Move up',
      moveDown: 'Move down',
      nodeDelete: 'Delete',
      deleteNodeTitle: 'Delete node?',
      deleteNodeBody: 'Node “{name}” and its children will be removed from the document.',
      instanceMark: 'instance',

      inspector: 'Inspector',
      selectNodeHint: 'Pick a node on the canvas or in the layer tree',
      multiHint: '{count} nodes selected — shared fields apply to all',
      sectionGeometry: 'Position and size',
      x: 'X',
      y: 'Y',
      w: 'W',
      h: 'H',
      rotation: 'Rotation',
      opacity: 'Opacity',

      sectionFill: 'Fill and stroke',
      fill: 'Fill',
      stroke: 'Stroke',
      strokeColor: 'Stroke color',
      strokeWidth: 'Width',
      radius: 'Radius',
      sectionShadow: 'Shadow',
      shadow: 'Shadow',
      shadowX: 'Offset X',
      shadowY: 'Offset Y',
      blur: 'Blur',
      spread: 'Spread',
      color: 'Color',
      shadowOn: 'Enable shadow',
      strokeOn: 'Enable stroke',

      sectionLayout: 'Layout',
      layoutMode: 'Mode',
      layoutNone: 'Free',
      layoutVertical: 'Vertical',
      layoutHorizontal: 'Horizontal',
      gap: 'Gap',
      padding: 'Padding',
      padTop: 'Top',
      padRight: 'Right',
      padBottom: 'Bottom',
      padLeft: 'Left',
      align: 'Align',
      justify: 'Justify',
      alignStart: 'Start',
      alignCenter: 'Center',
      alignEnd: 'End',
      alignStretch: 'Stretch',
      justifyStart: 'Start',
      justifyCenter: 'Center',
      justifyEnd: 'End',
      justifyBetween: 'Space between',

      sectionText: 'Text',
      textValue: 'Value',
      textToken: 'Token',
      textAlign: 'Horizontal',
      textValign: 'Vertical',
      alignLeft: 'Left',
      alignRight: 'Right',
      alignJustify: 'Justify',
      valignTop: 'Top',
      valignMiddle: 'Middle',
      valignBottom: 'Bottom',
      fontSize: 'Size',
      fontWeight: 'Weight',
      lineHeight: 'Line height',
      letterSpacing: 'Letter spacing',
      textNoToken: '— no token —',

      colorLiteral: 'literal',
      colorToken: 'token',
      colorPick: 'Pick color',

      sectionInstance: 'Instance',
      instanceComponent: 'Component',
      instanceMissing: 'Component not found — the instance is empty',
      instanceOverrideHint: 'This is an instance: appearance edits are stored as component overrides.',
      detach: 'Detach',
      detached: 'Instance detached',
      propsEmpty: 'No declared props',
      propValue: 'Prop value',

      componentsTitle: 'Components',
      componentsEmpty: 'No components',
      componentDefine: 'Create component from selection',
      componentKey: 'Key',
      componentName: 'Name',
      componentPlace: 'Place instance',
      componentDelete: 'Delete component',
      componentInstances: 'instances: {count}',
      componentNodes: 'nodes: {count}',
      componentDefined: 'Component created: {key}',
      componentDeleted: 'Component deleted: {key}',
      instancePlaced: 'Instance placed into “{parent}”',
      selectFirst: 'Select a node on the canvas first',
      propsCount: 'props: {count}',

      tokensTitle: 'Tokens',
      tokensApply: 'Apply',
      tokensHint: 'Flat canvas tokens: colors, radii, spacing, fonts and composite text/shadow presets.',
      tokensApplied: 'Tokens written',
      tokensEmpty: 'No tokens',
      tokensRevert: 'Revert edits',

      exportTitle: 'Export canvas',
      exportMode: 'Mode',
      exportFidelity: 'fidelity — pixel exact',
      exportClean: 'clean — flow markup',
      exportFrameOnly: 'Current frame only',
      exportRun: 'Export',
      exportPreview: 'Preview in a new tab',
      exportFiles: 'Files',
      exportWarnings: 'Warnings',
      exportEmpty: 'No files written',
      exportDone: 'Exported files: {count}',

      checkTitle: 'Canvas check',
      checkRun: 'Check',
      checkEmpty: 'No findings',
      checkCount: 'Findings: {count}',
      levelError: 'error',
      levelWarn: 'warning',
      levelInfo: 'info',
      close: 'Close',

      statusRev: 'rev {rev}',
      statusNodes: 'nodes: {count}',
      statusErrors: 'errors: {count}',
      statusWarnings: 'warnings: {count}',
      statusSelected: 'selected: {count}',
      statusZoom: 'zoom {zoom}%',
      savedState: 'saved',
      dirtyState: 'unsaved changes',
      savingState: 'saving…',
      errorState: 'save failed',
      savedAt: 'Saved (rev {rev})',
      loadFailed: 'Could not load data',

      conflictTitle: 'Canvas changed outside the panel',
      conflictBody: 'Disk revision {rev}, the panel expected {expected}. Choose which version to keep.',
      takeDisk: 'Take the disk version',
      overwriteMine: 'Overwrite with mine',
      conflictResolved: 'Disk version loaded',

      hostDown: 'Host plugin is not loaded',
      hostHint: 'Route {api} does not answer. Check that the design-canvas plugin is enabled in the DSH config and restart the server.',
      retry: 'Retry',

      noProjects: 'No projects with designs found',
      initTitle: 'Initialize a project',
      initRoot: 'Project path',
      initRootPlaceholder: '/home/user/project',
      initRun: 'Initialize',
      initHint: 'A .design/ folder appears in the directory and the project joins the design registry.',
      projectInitialized: 'Project initialized: {id}',
      noCanvases: 'This project has no canvases yet — create the first one',
      selectCanvas: 'Pick a canvas in the list on the left',
      panelHint: 'Canvases live in the project .design/ folder and are versioned with the code.',
    }

    // ==================================================================== CSS ====

    const CSS = `
.dc-root { box-sizing:border-box; display:flex; flex-direction:column; width:100%; min-width:0; height:100%; min-height:0; overflow:hidden; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; }
.dc-root * { box-sizing:border-box; }
.dc-toolbar { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--dsw-alias-border-l1); flex-wrap:wrap; background:var(--dsw-alias-bg-layer-1); }
.dc-tool-group { display:flex; align-items:center; gap:2px; padding:2px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); }
.dc-toolbar-sep { width:1px; align-self:stretch; background:var(--dsw-alias-border-l1); margin:0 2px; }
.dc-btn { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-primary); border-radius:6px; padding:4px 9px; font-size:12px; line-height:1.4; cursor:pointer; text-decoration:none; white-space:nowrap; }
.dc-btn:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dc-btn:active { background:var(--dsw-alias-interactive-bg-active); }
.dc-btn[disabled] { opacity:.45; cursor:default; }
.dc-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dc-btn-active { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-interactive-bg-active); }
.dc-btn-primary { background:var(--dsw-alias-button-primary-fill); border-color:transparent; color:var(--dsw-alias-label-primary-foreground); }
.dc-btn-primary:hover { background:var(--dsw-alias-button-primary-hover); }
.dc-btn-danger { color:var(--dsw-alias-state-error-primary); }
.dc-btn-flat { border-color:transparent; padding:3px 7px; }
.dc-input { box-sizing:border-box; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:4px 7px; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; outline:none; min-width:0; }
.dc-input:focus { border-color:var(--dsw-alias-brand-primary); }
.dc-select { box-sizing:border-box; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:4px 6px; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; outline:none; min-width:0; }
.dc-select:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dc-spacer { flex:1; }
.dc-muted { color:var(--dsw-alias-label-secondary); }
.dc-error { color:var(--dsw-alias-state-error-primary); }
.dc-warn { color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 62%, var(--dsw-alias-label-primary)); }
.dc-link { color:var(--dsw-alias-link); cursor:pointer; }
.dc-body { display:flex; flex:1; min-height:0; }
.dc-left { width:280px; min-width:220px; border-right:1px solid var(--dsw-alias-border-l1); display:flex; flex-direction:column; min-height:0; background:var(--dsw-alias-bg-layer-1); }
.dc-tabs { display:flex; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dc-tab { flex:1; border:none; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; padding:7px 4px; cursor:pointer; border-bottom:2px solid transparent; }
.dc-tab:hover { background:var(--dsw-alias-interactive-bg-hover); color:var(--dsw-alias-label-primary); }
.dc-tab-active { color:var(--dsw-alias-label-primary); border-bottom-color:var(--dsw-alias-brand-primary); }
.dc-left-scroll { flex:1; min-height:0; overflow:auto; padding:8px; scrollbar-gutter:stable; }
.dc-left-tools { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
.dc-center { flex:1; min-width:0; display:flex; flex-direction:column; min-height:0; background:var(--dsw-alias-bg-base); }
.dc-right { width:280px; min-width:240px; border-left:1px solid var(--dsw-alias-border-l1); overflow:auto; padding:10px; scrollbar-gutter:stable; background:var(--dsw-alias-bg-layer-1); }
.dc-viewport { position:relative; flex:1; min-height:0; overflow:hidden; background:var(--dsw-alias-bg-base); cursor:default; user-select:none; }
.dc-viewport-create { cursor:crosshair; }
.dc-world { position:absolute; left:0; top:0; transform-origin:0 0; }
.dc-node { position:absolute; }
.dc-node-text-inner { width:100%; }
.dc-frame-label { position:absolute; color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; pointer-events:none; }
.dc-sel { position:absolute; outline:1px solid var(--dsw-alias-brand-primary); pointer-events:none; }
.dc-handle { position:absolute; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-brand-primary); pointer-events:auto; }
.dc-handle-nw { cursor:nwse-resize; } .dc-handle-n { cursor:ns-resize; } .dc-handle-ne { cursor:nesw-resize; }
.dc-handle-e { cursor:ew-resize; } .dc-handle-se { cursor:nwse-resize; } .dc-handle-s { cursor:ns-resize; }
.dc-handle-sw { cursor:nesw-resize; } .dc-handle-w { cursor:ew-resize; }
.dc-marquee { position:absolute; border:1px dashed var(--dsw-alias-brand-primary); background:var(--dsw-alias-interactive-bg-active); pointer-events:none; }
.dc-img-empty { width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:var(--dsw-alias-label-secondary); border:1px dashed var(--dsw-alias-border-l2); font-size:12px; }
.dc-status { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:5px 12px; border-top:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); font-size:11.5px; }
.dc-status-item { display:inline-flex; align-items:center; gap:4px; }
.dc-status-strong { color:var(--dsw-alias-label-primary); }
.dc-row { display:flex; align-items:center; gap:6px; padding:3px 6px; border-radius:6px; cursor:pointer; }
.dc-row:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dc-row-active { background:var(--dsw-alias-interactive-bg-active); }
.dc-row-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dc-row-sub { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dc-row-actions { display:none; gap:2px; align-items:center; }
.dc-row:hover .dc-row-actions, .dc-row-active .dc-row-actions { display:flex; }
.dc-icon-btn { border:none; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; border-radius:4px; padding:1px 4px; font-size:12px; line-height:1.3; }
.dc-icon-btn:hover { background:var(--dsw-alias-interactive-bg-active); color:var(--dsw-alias-label-primary); }
.dc-tree-row { display:flex; align-items:center; gap:5px; padding:2px 5px; border-radius:6px; cursor:pointer; }
.dc-tree-row:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dc-tree-row-active { background:var(--dsw-alias-interactive-bg-active); }
.dc-tree-glyph { width:14px; text-align:center; color:var(--dsw-alias-label-secondary); flex:none; }
.dc-tree-dim { opacity:.5; }
.dc-empty { color:var(--dsw-alias-label-secondary); padding:16px 8px; text-align:center; font-size:12px; }
.dc-banner { margin:8px 12px 0; padding:8px 10px; border-radius:8px; border:1px solid var(--dsw-alias-state-warn-primary); display:flex; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; }
.dc-banner-error { border-color:var(--dsw-alias-state-error-primary); }
.dc-banner-body { flex:1; min-width:160px; }
.dc-section { margin-bottom:12px; }
.dc-section-title { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--dsw-alias-label-secondary); margin:0 0 6px; }
.dc-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.dc-grid-4 { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
.dc-field { display:flex; flex-direction:column; gap:3px; min-width:0; }
.dc-field-label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dc-field-row { display:flex; align-items:center; gap:6px; }
.dc-color { display:grid; grid-template-columns:auto 1fr auto; gap:5px; align-items:center; }
.dc-swatch { width:24px; height:22px; padding:0; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-1); cursor:pointer; }
.dc-check { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dc-chip { border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:1px 7px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dc-chip-brand { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dc-list { display:flex; flex-direction:column; gap:4px; }
.dc-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:7px 8px; background:var(--dsw-alias-bg-base); }
.dc-card-head { display:flex; align-items:center; gap:6px; }
.dc-card-title { font-weight:600; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dc-card-meta { color:var(--dsw-alias-label-secondary); font-size:11px; margin-top:3px; display:flex; gap:8px; flex-wrap:wrap; }
.dc-token-group { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:7px 8px; margin-bottom:8px; background:var(--dsw-alias-bg-base); }
.dc-token-head { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
.dc-token-name { font-weight:600; font-size:12px; }
.dc-token-sub { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
.dc-overlay { position:fixed; inset:0; background:color-mix(in srgb, var(--dsw-alias-bg-base) 70%, transparent); display:flex; align-items:center; justify-content:center; z-index:2000; }
.dc-modal { background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border:1px solid var(--dsw-alias-border-l2); border-radius:10px; padding:16px; min-width:340px; max-width:560px; max-height:80vh; overflow:auto; }
.dc-modal h3 { margin:0 0 10px; font-size:14px; }
.dc-modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
.dc-modal-body { display:flex; flex-direction:column; gap:8px; font-size:12px; }
.dc-issues { border-top:1px solid var(--dsw-alias-border-l1); max-height:200px; overflow:auto; background:var(--dsw-alias-bg-layer-1); }
.dc-issues-head { display:flex; align-items:center; gap:8px; padding:6px 12px; position:sticky; top:0; background:var(--dsw-alias-bg-layer-1); }
.dc-issue { display:flex; gap:8px; align-items:flex-start; padding:4px 12px; cursor:pointer; font-size:12px; }
.dc-issue:hover { background:var(--dsw-alias-interactive-bg-hover); }
.dc-badge { border-radius:4px; padding:0 5px; font-size:10.5px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); flex:none; }
.dc-badge-error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.dc-badge-warn { border-color:var(--dsw-alias-state-warn-primary); color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 62%, var(--dsw-alias-label-primary)); }
.dc-file-row { display:flex; align-items:center; gap:8px; padding:4px 6px; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; font-size:11.5px; }
.dc-file-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary); }
.dc-textarea { width:100%; min-height:64px; resize:vertical; font:inherit; font-size:12px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:5px 7px; outline:none; }
.dc-textarea:focus { border-color:var(--dsw-alias-brand-primary); }

/* Разметка холста: линейки, направляющие, наведение, замеры и привязка.
   Живёт в экранных координатах, поэтому толщина линий и кегль подписей не
   зависят от масштаба; слой прозрачен для мыши, кроме зон захвата линий. */
.dc-canvas-wrap { flex:1; min-height:0; display:grid; grid-template-columns:18px 1fr; grid-template-rows:18px 1fr; }
.dc-rulers-off { grid-template-columns:0 1fr; grid-template-rows:0 1fr; }
.dc-rulers-off .dc-ruler, .dc-rulers-off .dc-ruler-corner { display:none; }
.dc-ruler-corner { background:var(--dsw-alias-bg-layer-1); border-right:1px solid var(--dsw-alias-border-l1); border-bottom:1px solid var(--dsw-alias-border-l1); }
.dc-ruler { position:relative; overflow:hidden; background:var(--dsw-alias-bg-layer-1); cursor:crosshair; }
.dc-ruler-top { border-bottom:1px solid var(--dsw-alias-border-l1); }
.dc-ruler-left { border-right:1px solid var(--dsw-alias-border-l1); }
.dc-tick { position:absolute; background:var(--dsw-alias-border-l2); }
.dc-ruler-top .dc-tick { top:0; width:1px; height:5px; }
.dc-ruler-left .dc-tick { left:0; height:1px; width:5px; }
.dc-ruler-top .dc-tick-major { height:9px; }
.dc-ruler-left .dc-tick-major { width:9px; }
.dc-tick-label { position:absolute; font-size:9px; line-height:1; color:var(--dsw-alias-label-secondary); }
.dc-ruler-top .dc-tick-label { top:9px; left:2px; }
.dc-ruler-left .dc-tick-label { left:10px; top:1px; }
.dc-ov-layer { position:absolute; inset:0; pointer-events:none; overflow:hidden; }
.dc-ov-box { position:absolute; outline:1px solid transparent; pointer-events:none; }
.dc-ov-label { position:absolute; transform:translateY(-100%); color:#fff; font-size:10px; line-height:1.6; padding:0 5px; border-radius:3px; white-space:nowrap; pointer-events:none; max-width:240px; overflow:hidden; text-overflow:ellipsis; }
.dc-ov-label-end { transform:translate(-100%,-100%); }
.dc-ov-pad { position:absolute; pointer-events:none; }
.dc-ov-line { position:absolute; pointer-events:none; }
.dc-ov-snap { opacity:.9; }
.dc-ov-pill { position:absolute; transform:translate(-50%,-50%); color:#fff; font-size:10px; line-height:1.6; padding:0 4px; border-radius:3px; white-space:nowrap; pointer-events:none; }
.dc-guide { position:absolute; pointer-events:auto; z-index:3; }
.dc-guide-x { top:0; bottom:0; width:7px; cursor:ew-resize; }
.dc-guide-y { left:0; right:0; height:7px; cursor:ns-resize; }
.dc-guide-line { position:absolute; opacity:.75; }
.dc-guide-x .dc-guide-line { left:3px; top:0; bottom:0; width:1px; }
.dc-guide-y .dc-guide-line { top:3px; left:0; right:0; height:1px; }
.dc-guide-active .dc-guide-line { opacity:1; }
.dc-guide-preview { position:absolute; pointer-events:none; }
.dc-guide-preview-x { top:0; bottom:0; width:0; border-left:1px dashed #0d99ff; }
.dc-guide-preview-y { left:0; right:0; height:0; border-top:1px dashed #0d99ff; }
/* Контекстное меню узла: те же действия, что и горячими клавишами, но видимые. */
.dc-preview { position:relative; overflow:hidden; border:1px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-base); }
.dc-preview-world { position:absolute; transform-origin:0 0; }
.dc-card-clickable { cursor:pointer; }
.dc-card-clickable:hover { border-color:var(--dsw-alias-brand-primary); }
.dc-prop-row { border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:5px 6px; margin-bottom:5px; background:var(--dsw-alias-bg-layer-1); }
.dc-chip-btn { cursor:pointer; background:transparent; font:inherit; font-size:11px; }
.dc-chip-btn:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.dc-ov-mark { opacity:.7; }
.dc-ov-enter { position:absolute; border:1px dashed var(--dsw-alias-brand-primary); pointer-events:none; }
.dc-enter-chip { position:absolute; left:8px; top:8px; padding:2px 8px; border-radius:999px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); font-size:11px; pointer-events:none; }
.dc-menu { position:fixed; z-index:2100; min-width:220px; padding:4px; display:flex; flex-direction:column; gap:1px; background:var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); border:1px solid var(--dsw-alias-border-l2); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.28); }
.dc-menu-item { display:flex; align-items:center; gap:10px; border:none; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; text-align:left; padding:4px 8px; border-radius:6px; cursor:pointer; }
.dc-menu-item:hover:not([disabled]) { background:var(--dsw-alias-interactive-bg-hover); }
.dc-menu-item[disabled] { opacity:.45; cursor:default; }
.dc-menu-item:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:-2px; }
.dc-menu-label { flex:1; }
.dc-menu-hint { color:var(--dsw-alias-label-secondary); font-size:11px; }
.dc-menu-sep { height:1px; margin:3px 4px; background:var(--dsw-alias-border-l1); }
.dc-align-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:4px; }
.dc-tree-row-hover { background:var(--dsw-alias-interactive-bg-hover); }
.dc-tree-row-ancestor { box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary); }
`

    // =============================================================== утилиты ====

    /** Число с подстановкой: NaN и мусор не должны ломать геометрию. */
    function num(value, fallback = 0) {
      const parsed = typeof value === 'string' ? Number(value) : value
      return Number.isFinite(parsed) ? parsed : fallback
    }

    /** Ограничить значение отрезком. */
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /** Глубокая копия JSON-значения. */
    function clone(value) {
      return JSON.parse(JSON.stringify(value))
    }

    /** Обычный объект (не массив, не null). */
    function isPlainObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /** Строка запроса без пустых значений. */
    function queryString(params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
      }
      const text = search.toString()
      return text === '' ? '' : `?${text}`
    }

    /**
     * Запрос к host-маршруту панели.
     *
     * Ошибка приходит объектом с `status`, `message` и разобранным телом `body`:
     * панель различает 404 «нет холста», 409 «ревизия устарела» и 0 «сеть».
     */
    async function api(path, options = {}) {
      const method = options.method ?? 'GET'
      const url = `${API}${path}${queryString(options.query ?? {})}`
      let response
      try {
        response = await fetch(url, {
          method,
          cache: 'no-store',
          headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        })
      } catch (cause) {
        const error = new Error(cause?.message ?? 'network error')
        error.status = 0
        error.body = null
        throw error
      }
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok) {
        const error = new Error(data?.error ?? `HTTP ${response.status}`)
        error.status = response.status
        error.body = data
        throw error
      }
      return data
    }

    /** id части инстанса: `<instanceId>/<childId>` → `<instanceId>`. */
    function baseId(id) {
      const text = String(id ?? '')
      const slash = text.indexOf('/')
      return slash === -1 ? text : text.slice(0, slash)
    }

    /** Значение — ссылка на токен (`token:color.bg`). */
    function isTokenRef(value) {
      return typeof value === 'string' && value.startsWith('token:')
    }

    /** Путь токена внутри ссылки. */
    function tokenPath(value) {
      return isTokenRef(value) ? value.slice('token:'.length) : ''
    }

    /** Развернуть значение-ссылку через плоскую карту токенов. */
    function tokenValue(tokens, value) {
      if (!isTokenRef(value)) return value
      const path = tokenPath(value)
      const flat = tokens ?? {}
      return Object.prototype.hasOwnProperty.call(flat, path) ? flat[path] : null
    }

    /** Цвет (литерал или токен) в CSS-строку; null — рисовать нечего. */
    function cssColor(tokens, value) {
      const resolved = tokenValue(tokens, value)
      if (resolved === null || resolved === undefined || resolved === '') return null
      return typeof resolved === 'string' ? resolved : null
    }

    /** Длина (число токена → px) в CSS-строку. */
    function cssLength(tokens, value) {
      const resolved = tokenValue(tokens, value)
      if (resolved === null || resolved === undefined || resolved === '') return undefined
      if (typeof resolved === 'number') return `${resolved}px`
      return String(resolved)
    }

    /** Тень узла в CSS-строку. */
    function shadowCss(tokens, shadow) {
      if (!isPlainObject(shadow)) return undefined
      const color = cssColor(tokens, shadow.color) ?? 'currentColor'
      return `${num(shadow.x, 0)}px ${num(shadow.y, 0)}px ${num(shadow.blur, 0)}px ${num(shadow.spread, 0)}px ${color}`
    }

    /** Любое цветовое значение в `#rrggbb` для `<input type="color">`. */
    function toHexColor(value, fallback = '#000000') {
      const text = String(value ?? '').trim()
      if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase()
      if (/^#[0-9a-f]{3}$/i.test(text)) {
        return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`.toLowerCase()
      }
      const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(text)
      if (rgb) {
        return `#${[1, 2, 3].map((index) => clamp(Number(rgb[index]), 0, 255).toString(16).padStart(2, '0')).join('')}`
      }
      return fallback
    }

    /** Размер в человекочитаемом виде. */
    function formatBytes(size) {
      const value = Number(size) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
      return `${(value / 1024 / 1024).toFixed(1)} MiB`
    }

    /** Дата и время в коротком виде. */
    function formatDate(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return `${date.toISOString().slice(0, 10)} ${date.toTimeString().slice(0, 5)}`
    }

    /** Счётчик для клиентских id узлов. */
    let idCounter = 0

    /** Короткий уникальный id нового узла. */
    function nextNodeId(prefix = 'n') {
      idCounter = (idCounter + 1) % 100000
      const rand = Math.random().toString(36).slice(2, 7)
      return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`
    }

    /** Шаг привязки к сетке: Alt отключает, Shift укрупняет до 10. */
    function snapStep(event) {
      if (event?.altKey) return 0
      if (event?.shiftKey) return 10
      return 1
    }

    /** Округлить к шагу сетки. */
    function snap(value, step) {
      return step > 0 ? Math.round(value / step) * step : value
    }

    // ======================================================= модель документа ====

    /** Типы узлов, которые понимает редактор. */
    const NODE_TYPES = ['frame', 'group', 'rect', 'ellipse', 'line', 'text', 'image', 'instance']
    /** Типы, которые могут содержать детей. */
    const CONTAINERS = ['frame', 'group', 'instance']

    /** Имена узлов по умолчанию — те же, что у host-схемы. */
    const NODE_NAMES = {
      frame: 'Frame',
      group: 'Group',
      rect: 'Rectangle',
      ellipse: 'Ellipse',
      line: 'Line',
      text: 'Text',
      image: 'Image',
      instance: 'Instance',
    }

    /** Заливка и скругление по умолчанию для каждого типа. */
    function defaultStyle(type) {
      if (type === 'text') return { fill: null, opacity: 1 }
      if (type === 'frame' || type === 'group') {
        return { fill: 'token:color.surface', stroke: null, radius: 0, opacity: 1, shadow: null }
      }
      if (type === 'line') return { fill: 'token:color.border', opacity: 1 }
      if (type === 'ellipse') return { fill: 'token:color.accent', opacity: 1 }
      return { fill: 'token:color.surfaceAlt', stroke: null, radius: 8, opacity: 1, shadow: null }
    }

    /** Раскладка по умолчанию: свободное позиционирование. */
    function defaultLayout() {
      return { mode: 'none', gap: 0, padding: { t: 0, r: 0, b: 0, l: 0 }, align: 'start', justify: 'start' }
    }

    const LAYOUT_MODES = ['none', 'vertical', 'horizontal']
    const ALIGN_VALUES = ['start', 'center', 'end', 'stretch']
    const JUSTIFY_VALUES = ['start', 'center', 'end', 'space-between']

    /**
     * Каноническая раскладка — копия правила `normalizeLayout` из `schema.js`.
     *
     * Панель сохраняет документ целиком, поэтому мусор в `layout` (отрицательный
     * `gap`, неизвестный `mode`, строка вместо числа) обязан приводиться так же,
     * как на сервере: иначе перетаскивание узла изменит документ.
     */
    function normalizeLayout(layout) {
      const raw = isPlainObject(layout) ? layout : {}
      const padding = isPlainObject(raw.padding) ? raw.padding : {}
      return {
        mode: LAYOUT_MODES.includes(raw.mode) ? raw.mode : 'none',
        gap: Math.max(0, num(raw.gap, 0)),
        padding: {
          t: Math.max(0, num(padding.t, 0)),
          r: Math.max(0, num(padding.r, 0)),
          b: Math.max(0, num(padding.b, 0)),
          l: Math.max(0, num(padding.l, 0)),
        },
        align: ALIGN_VALUES.includes(raw.align) ? raw.align : 'start',
        justify: JUSTIFY_VALUES.includes(raw.justify) ? raw.justify : 'start',
      }
    }

    /** Текстовые свойства по умолчанию. */
    function defaultText() {
      return {
        value: 'Текст',
        token: 'text.body',
        align: 'left',
        valign: 'top',
        color: 'token:color.fg',
        size: null,
        weight: null,
        lineHeight: null,
        letterSpacing: null,
      }
    }

    /**
     * Новый узел: копия правил `defaultNode` из host-схемы.
     *
     * Панель создаёт узлы локально (протяжкой по вьюпорту) и сохраняет документ
     * целиком, поэтому форма узла должна совпадать с серверной нормализацией.
     */
    function makeNode(type, init = {}) {
      const kind = NODE_TYPES.includes(type) ? type : 'rect'
      const node = {
        id: typeof init.id === 'string' && init.id !== '' ? init.id : nextNodeId(kind === 'frame' ? 'fr' : kind === 'text' ? 'tx' : 'n'),
        type: kind,
        name: init.name ?? NODE_NAMES[kind] ?? 'Node',
        x: num(init.x, 0),
        y: num(init.y, 0),
        w: num(init.w, kind === 'text' ? 200 : 120),
        h: num(init.h, kind === 'text' ? 28 : 120),
        rotation: num(init.rotation, 0),
        visible: init.visible !== false,
        locked: init.locked === true,
        style: { ...defaultStyle(kind), ...(isPlainObject(init.style) ? init.style : {}) },
        layout: defaultLayout(),
      }
      if (typeof init.autoW === 'boolean') node.autoW = init.autoW
      if (typeof init.autoH === 'boolean') node.autoH = init.autoH
      if (kind === 'text') node.text = { ...defaultText(), ...(isPlainObject(init.text) ? init.text : {}) }
      if (kind === 'image') node.image = { src: '', fit: 'cover', ...(isPlainObject(init.image) ? init.image : {}) }
      if (kind === 'instance') {
        node.component = typeof init.component === 'string' ? init.component : ''
        node.overrides = isPlainObject(init.overrides) ? { ...init.overrides } : {}
      }
      if (kind === 'line') {
        node.w = num(init.w, 120)
        node.h = num(init.h, 1)
      }
      if (CONTAINERS.includes(kind)) {
        node.clip = init.clip !== undefined ? init.clip === true : kind === 'frame'
        node.children = Array.isArray(init.children) ? init.children : []
      }
      return node
    }

    /** Обход дерева в глубину: родители раньше детей. */
    function walkTree(root, visit) {
      if (!root || typeof root !== 'object') return
      const stack = [[root, null, 0]]
      const seen = new Set()
      while (stack.length > 0) {
        const [node, parent, depth] = stack.pop()
        if (!node || typeof node !== 'object' || seen.has(node)) continue
        seen.add(node)
        visit(node, parent, depth)
        const children = Array.isArray(node.children) ? node.children : []
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push([children[index], node, depth + 1])
        }
      }
    }

    /** Найти узел по id. */
    function findNode(root, id) {
      let found = null
      walkTree(root, (node) => {
        if (found === null && node.id === id) found = node
      })
      return found
    }

    /** Найти родителя и индекс узла. */
    function findParent(root, id) {
      let found = null
      walkTree(root, (node) => {
        if (found) return
        for (const child of node.children ?? []) {
          if (child.id === id) found = { parent: node, index: (node.children ?? []).indexOf(child) }
        }
      })
      return found
    }

    /** Абсолютный прямоугольник узла: сумма смещений предков. */
    function absRect(root, id) {
      let found = null
      const step = (node, offsetX, offsetY) => {
        if (found || !node) return
        const x = offsetX + num(node.x, 0)
        const y = offsetY + num(node.y, 0)
        if (node.id === id) {
          found = { x, y, w: num(node.w, 0), h: num(node.h, 0) }
          return
        }
        for (const child of node.children ?? []) step(child, x, y)
      }
      step(root, 0, 0)
      return found
    }

    /** Сколько узлов в поддереве (сам узел тоже). */
    function countNodes(root) {
      let count = 0
      walkTree(root, () => { count += 1 })
      return count
    }

    /** Слить патч в узел: `style`/`text`/`layout`/`image` — по ключам. */
    function mergeNodePatch(node, patch) {
      if (!isPlainObject(patch)) return node
      const merged = ['style', 'text', 'layout', 'image', 'overrides']
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'type') continue
        if (merged.includes(key) && isPlainObject(value)) {
          const target = isPlainObject(node[key]) ? node[key] : {}
          for (const [inner, innerValue] of Object.entries(value)) {
            if (inner === 'padding' && isPlainObject(innerValue)) target[inner] = { ...(target[inner] ?? {}), ...innerValue }
            else target[inner] = innerValue
          }
          node[key] = target
          continue
        }
        node[key] = value
      }
      return node
    }

    /** Записать значение по пути внутри узла (`text.value`, `style.fill`). */
    function setPath(node, path, value) {
      const steps = String(path ?? '').split('.').filter(Boolean)
      if (steps.length === 0 || value === undefined) return node
      let current = node
      for (let index = 0; index < steps.length - 1; index += 1) {
        const step = steps[index]
        if (!isPlainObject(current[step])) current[step] = {}
        current = current[step]
      }
      current[steps[steps.length - 1]] = value
      return node
    }

    /** Прочитать значение по пути внутри узла. */
    function getPath(node, path) {
      let current = node
      for (const step of String(path ?? '').split('.').filter(Boolean)) {
        if (current === null || current === undefined) return undefined
        current = current[step]
      }
      return current
    }

    /** Первый текстовый узел поддерева. */
    function firstText(root) {
      let found = null
      walkTree(root, (node) => {
        if (found === null && node.type === 'text') found = node
      })
      return found
    }

    /** Узел-цель объявленного параметра компонента: `root`, `text` или `#Имя`. */
    function resolveTarget(root, target) {
      const spec = typeof target === 'string' && target !== '' ? target : 'root'
      if (spec === 'root') return root
      if (spec === 'text') return firstText(root)
      if (spec.startsWith('#')) {
        const name = spec.slice(1)
        let found = null
        walkTree(root, (node) => {
          if (found === null && node.name === name) found = node
        })
        return found
      }
      let current = root
      for (const step of spec.split('.').filter(Boolean)) {
        const indexed = /^(.*)\[(\d+)\]$/.exec(step)
        if (indexed) {
          const list = indexed[1] === '' ? current.children : current?.[indexed[1]]?.children
          current = Array.isArray(list) ? list[Number(indexed[2])] : undefined
        } else {
          current = current?.[step]
        }
        if (!current) return null
      }
      return current ?? null
    }

    /**
     * Разложить патч в плоские пути: `{ style: { fill } }` → `[['style.fill', …]]`.
     *
     * Нужно там, где правка уходит не в узел, а в переопределение инстанса:
     * `applyOverrides` принимает пути, а инспектор собирает вложенные объекты.
     */
    function flattenPatch(value, prefix = '') {
      const out = []
      for (const [key, item] of Object.entries(value ?? {})) {
        const path = prefix ? `${prefix}.${key}` : key
        if (isPlainObject(item)) out.push(...flattenPatch(item, path))
        else out.push([path, item])
      }
      return out
    }

    /**
     * Действующее значение объявленного параметра компонента.
     *
     * Приоритет: переопределение инстанса → значение узла-цели в развёрнутом
     * шаблоне → объявленное значение по умолчанию. Без второго шага инспектор
     * показывал бы «Тема» там, где на холсте нарисовано «История».
     */
    function effectivePropValue(doc, component, instance, name, spec) {
      const override = instance?.overrides?.[name]
      if (override !== undefined && override !== null) return override
      const root = instance?.type === 'instance' ? expandInstance(doc, instance) : component?.node
      if (root && isPlainObject(root)) {
        const target = resolveTarget(root, spec.target)
        if (target) {
          const current = getPath(target, spec.property ?? 'text.value')
          if (current !== undefined && current !== null) return current
        }
      }
      return spec.default
    }

    /**
     * Действующие параметры компонента с учётом вариации — копия host-правила
     * (`componentProps`): вариация переопределяет поля отдельных параметров, а
     * объявление параметра остаётся общим для всех вариаций.
     */
    function componentProps(component, variant) {
      const base = isPlainObject(component?.props) ? component.props : {}
      const patch = isPlainObject(component?.variants?.[variant]?.props) ? component.variants[variant].props : {}
      const out = {}
      for (const name of new Set([...Object.keys(base), ...Object.keys(patch)])) {
        out[name] = { ...(base[name] ?? {}), ...(patch[name] ?? {}) }
      }
      return out
    }

    /** Шаблон компонента с учётом вариации: вариация заменяет шаблон целиком. */
    function componentTemplate(component, variant) {
      const spec = component?.variants?.[variant]
      const source = isPlainObject(spec?.node) ? spec.node : component?.node
      return clone(source ?? {})
    }

    /** Переопределения инстанса поверх копии шаблона компонента. */
    function applyOverrides(root, component, overrides, variant) {
      const specs = componentProps(component, variant)
      for (const [key, value] of Object.entries(overrides ?? {})) {
        const spec = specs[key]
        if (spec) {
          const target = resolveTarget(root, spec.target)
          if (target) setPath(target, spec.property ?? 'text.value', value)
          continue
        }
        setPath(root, key, value)
      }
      return root
    }

    /** Переименовать id поддерева с префиксом владельца-инстанса. */
    function remapIds(node, ownerId) {
      node.id = `${ownerId}/${node.id}`
      for (const child of node.children ?? []) remapIds(child, ownerId)
    }

    /**
     * Развернуть инстанс в дерево компонента — копия правил host-схемы.
     *
     * Сервер уже отдаёт развёрнутое дерево (`display`), но панель правит
     * документ локально и должна перерисовываться до сохранения, поэтому те же
     * правила живут и здесь: иначе живое редактирование расходилось бы с файлом.
     */
    function expandInstance(doc, instance) {
      const component = isPlainObject(doc?.components) ? doc.components[instance.component] : null
      const base = { ...instance, type: 'frame', component: instance.component, children: [] }
      if (!component || !isPlainObject(component.node)) {
        base.name = instance.name || instance.component || 'Instance'
        base.missing = true
        return base
      }
      const template = componentTemplate(component, instance.variant)
      applyOverrides(template, component, instance.overrides ?? {}, instance.variant)
      remapIds(template, instance.id)
      return {
        ...template,
        id: instance.id,
        type: template.type,
        name: instance.name || component.name,
        variant: instance.variant,
        x: num(instance.x, 0),
        y: num(instance.y, 0),
        w: num(instance.w, num(template.w, 100)),
        h: num(instance.h, num(template.h, 100)),
        rotation: num(instance.rotation, 0),
        visible: instance.visible !== false,
        locked: instance.locked === true,
        component: instance.component,
        instanceOf: instance.id,
        children: template.children ?? [],
      }
    }

    /** Развернуть узел рекурсивно (все вложенные инстансы). */
    function expandTree(doc, node, depth = 0) {
      const base = node.type === 'instance' ? expandInstance(doc, node) : node
      const children = Array.isArray(base.children) ? base.children : []
      if (children.length === 0 || depth >= 32) return { ...base, children: [] }
      return { ...base, children: children.map((child) => expandTree(doc, child, depth + 1)) }
    }

    /** Дерево для отрисовки: корень документа с развёрнутыми верхними фреймами. */
    function expandDoc(doc) {
      if (!doc || !doc.root) return null
      return { ...doc.root, children: (doc.root.children ?? []).map((node) => expandTree(doc, node)) }
    }

    /** Смещение по поперечной оси для режима выравнивания. */
    function crossOffset(align, start, available, size) {
      if (align === 'center') return start + Math.max(0, (available - size) / 2)
      if (align === 'end') return start + Math.max(0, available - size)
      return start
    }

    /**
     * Разложить детей потокового фрейма и подогнать его размер.
     *
     * Правило обязано совпадать с host-схемой (`layoutChildren`): панель
     * сохраняет документ целиком, и расхождение здесь меняет файл при простом
     * перетаскивании узла. Поэтому и распределение свободного места
     * (`justify`, `align: 'stretch'`), и авторазмер считаются одинаково.
     */
    function layoutFrame(frame) {
      const layout = normalizeLayout(frame.layout)
      frame.layout = layout
      if (layout.mode === 'none' || !Array.isArray(frame.children)) return frame
      const visible = frame.children.filter((child) => child.visible !== false)
      const pad = layout.padding
      const horizontal = layout.mode === 'horizontal'
      const gap = layout.gap
      const mainStart = horizontal ? pad.l : pad.t
      const mainEnd = horizontal ? pad.r : pad.b
      const crossStart = horizontal ? pad.t : pad.l
      const crossEnd = horizontal ? pad.b : pad.r
      const mainOf = (child) => (horizontal ? num(child.w, 0) : num(child.h, 0))
      const crossOf = (child) => (horizontal ? num(child.h, 0) : num(child.w, 0))
      let contentMain = 0
      for (let index = 0; index < visible.length; index += 1) {
        contentMain += (index > 0 ? gap : 0) + mainOf(visible[index])
      }
      const authoredMain = Math.max(0, (horizontal ? num(frame.w, 0) : num(frame.h, 0)) - mainStart - mainEnd)
      const keepAuthored = layout.justify !== 'start' && authoredMain > 0
      if (!keepAuthored) {
        if (horizontal) {
          if (frame.autoW !== false) frame.w = contentMain + mainStart + mainEnd
        } else if (frame.autoH !== false) {
          frame.h = contentMain + mainStart + mainEnd
        }
      }
      const mainSize = Math.max(0, (horizontal ? num(frame.w, 0) : num(frame.h, 0)) - mainStart - mainEnd)
      const crossSize = Math.max(0, (horizontal ? num(frame.h, 0) : num(frame.w, 0)) - crossStart - crossEnd)
      const free = Math.max(0, mainSize - contentMain)
      const stretching = layout.align === 'stretch' && crossSize > 0
      let cursor = mainStart
      let step = gap
      if (layout.justify === 'center') cursor += free / 2
      else if (layout.justify === 'end') cursor += free
      else if (layout.justify === 'space-between' && visible.length > 1) step = gap + free / (visible.length - 1)
      for (const child of visible) {
        if (stretching) {
          if (horizontal) child.h = crossSize
          else child.w = crossSize
        }
        if (horizontal) {
          child.x = cursor
          child.y = stretching ? crossStart : crossOffset(layout.align, crossStart, crossSize, crossOf(child))
        } else {
          child.y = cursor
          child.x = stretching ? crossStart : crossOffset(layout.align, crossStart, crossSize, crossOf(child))
        }
        cursor += mainOf(child) + step
      }
      if (!stretching) {
        const contentCross = visible.reduce((max, child) => Math.max(max, crossOf(child)), 0) + crossStart + crossEnd
        if (horizontal) {
          if (frame.autoH !== false) frame.h = Math.max(num(frame.h, 0), contentCross)
        } else if (frame.autoW !== false) {
          frame.w = Math.max(num(frame.w, 0), contentCross)
        }
      }
      return frame
    }

    /** Пересчитать потоковые фреймы снизу вверх (как host `relayout`). */
    function relayoutDoc(doc) {
      const frames = []
      walkTree(doc?.root, (node, _parent, depth) => {
        if (node.type === 'frame' && node.layout?.mode && node.layout.mode !== 'none') frames.push({ node, depth })
      })
      frames.sort((a, b) => b.depth - a.depth)
      for (const item of frames) layoutFrame(item.node)
      return doc
    }

    // ======================================= геометрия оверлеев и привязки ====

    /**
     * Один обход дерева даёт всё, что нужно оверлеям: абсолютные
     * прямоугольники, родителей и порядок обхода.
     *
     * `absRect` ищет один узел полным обходом. Наведению, замерам и привязке
     * нужны десятки прямоугольников за кадр — там это были бы сотни обходов,
     * поэтому геометрия считается один раз и переиспользуется.
     */
    function flattenRects(root) {
      const rects = new Map()
      const parents = new Map()
      const nodes = new Map()
      const order = []
      const step = (node, offsetX, offsetY, parentId) => {
        if (!node || typeof node !== 'object') return
        const rect = {
          x: offsetX + num(node.x, 0),
          y: offsetY + num(node.y, 0),
          w: Math.max(0, num(node.w, 0)),
          h: Math.max(0, num(node.h, 0)),
        }
        rects.set(node.id, rect)
        parents.set(node.id, parentId)
        nodes.set(node.id, node)
        order.push(node.id)
        for (const child of node.children ?? []) step(child, rect.x, rect.y, node.id)
      }
      step(root, 0, 0, null)
      return { rects, parents, nodes, order }
    }

    /** Цепочка от узла к корню: сам узел, затем его контейнеры. */
    function ancestorChain(parents, id) {
      const chain = []
      const seen = new Set()
      let current = id
      while (current && !seen.has(current)) {
        seen.add(current)
        chain.push(current)
        current = parents.get(current) ?? null
      }
      return chain
    }

    /** Padding контейнера: у нераскладочного он ни на что не влияет. */
    function nodePadding(node) {
      const layout = isPlainObject(node?.layout) ? node.layout : {}
      const pad = isPlainObject(layout.padding) ? layout.padding : {}
      if (layout.mode !== 'vertical' && layout.mode !== 'horizontal') return { t: 0, r: 0, b: 0, l: 0 }
      return {
        t: Math.max(0, num(pad.t, 0)),
        r: Math.max(0, num(pad.r, 0)),
        b: Math.max(0, num(pad.b, 0)),
        l: Math.max(0, num(pad.l, 0)),
      }
    }

    /** Четыре подложки padding контейнера в мировых координатах. */
    function padZonesOf(rect, pad) {
      return [
        { key: 't', x: rect.x, y: rect.y, w: rect.w, h: pad.t },
        { key: 'r', x: rect.x + rect.w - pad.r, y: rect.y, w: pad.r, h: rect.h },
        { key: 'b', x: rect.x, y: rect.y + rect.h - pad.b, w: rect.w, h: pad.b },
        { key: 'l', x: rect.x, y: rect.y, w: pad.l, h: rect.h },
      ]
    }

    /**
     * Замеры узла: отступы до внутренней рамки родителя и ближайшие соседи.
     *
     * Расстояния считаются до **внешней** рамки родителя — как в Figma: число
     * показывает, сколько узел отступает от края контейнера, а сам `padding`
     * виден подложками (`padZones`). Считать до внутренней рамки тоже можно, но
     * тогда у ребёнка, стоящего по padding, все четыре числа равны нулю и
     * отступы контейнера приходится читать только по цвету.
     *
     * «Ближайший сосед» с каждой стороны — ребёнок того же родителя, не
     * перекрывающий узел по перпендикулярной оси: до перекрывающего объекта
     * расстояние отрицательно и как замер смысла не имеет.
     *
     * @param {object} ctx Результат `flattenRects`.
     * @param {string} id id узла.
     * @returns {object|null} `{ rect, parent, box, gaps, neighbors }`.
     */
    function measureNode(ctx, id) {
      const rect = ctx.rects.get(id)
      const parentId = ctx.parents.get(id)
      const parentNode = parentId ? ctx.nodes.get(parentId) : null
      const parentRect = parentId ? ctx.rects.get(parentId) : null
      if (!rect || !parentRect || !parentNode) return null
      const pad = nodePadding(parentNode)
      const box = { x: parentRect.x, y: parentRect.y, w: parentRect.w, h: parentRect.h }
      // Корень документа имеет нулевой размер: «расстояние до его краёв» было бы
      // минус собственный размер узла. У такого родителя замеряются только
      // соседи — у верхних фреймов это как раз то, что нужно.
      const solid = parentRect.w > 0 || parentRect.h > 0
      const gaps = solid
        ? {
          left: rect.x - box.x,
          top: rect.y - box.y,
          right: box.x + box.w - (rect.x + rect.w),
          bottom: box.y + box.h - (rect.y + rect.h),
        }
        : { left: 0, top: 0, right: 0, bottom: 0 }
      const neighbors = {}
      const consider = (side, gap, at, other, otherId) => {
        const current = neighbors[side]
        if (current && Math.abs(current.gap) <= Math.abs(gap)) return
        neighbors[side] = { gap, at, rect: other, id: otherId }
      }
      for (const child of parentNode.children ?? []) {
        if (child.id === id || child.visible === false) continue
        const other = ctx.rects.get(child.id)
        if (!other) continue
        const overlapsY = other.y < rect.y + rect.h && other.y + other.h > rect.y
        const overlapsX = other.x < rect.x + rect.w && other.x + other.w > rect.x
        if (overlapsY && other.x + other.w <= rect.x) {
          consider('left', rect.x - (other.x + other.w), clamp(rect.y + rect.h / 2, other.y, other.y + other.h), other, child.id)
        }
        if (overlapsY && other.x >= rect.x + rect.w) {
          consider('right', other.x - (rect.x + rect.w), clamp(rect.y + rect.h / 2, other.y, other.y + other.h), other, child.id)
        }
        if (overlapsX && other.y + other.h <= rect.y) {
          consider('top', rect.y - (other.y + other.h), clamp(rect.x + rect.w / 2, other.x, other.x + other.w), other, child.id)
        }
        if (overlapsX && other.y >= rect.y + rect.h) {
          consider('bottom', other.y - (rect.y + rect.h), clamp(rect.x + rect.w / 2, other.x, other.x + other.w), other, child.id)
        }
      }
      return { id, rect, parent: { id: parentId, rect: parentRect, pad, node: parentNode }, box, gaps, neighbors }
    }

    /**
     * Кандидаты выравнивания для перемещаемого габарита.
     *
     * Источники: родитель, соседи по родителю и другие верхние фреймы — у
     * каждого берутся две крайние линии и середина. Внутренность инстансов в
     * кандидаты не попадает: её геометрия принадлежит шаблону компонента, а id
     * транзиентны.
     *
     * @returns {{x: object[], y: object[]}} Линии `{ value, rect, kind }`.
     */
    function snapCandidates(ctx, skipIds, parentId) {
      const skip = new Set(skipIds)
      const axes = { x: [], y: [] }
      const push = (rect, kind) => {
        // Корень и пустой фрейм имеют нулевой размер: их «края» — три одинаковых
        // линии в одной точке, то есть мусор в наборе кандидатов.
        if (rect.w <= 0 && rect.h <= 0) return
        axes.x.push({ value: rect.x, rect, kind }, { value: rect.x + rect.w / 2, rect, kind }, { value: rect.x + rect.w, rect, kind })
        axes.y.push({ value: rect.y, rect, kind }, { value: rect.y + rect.h / 2, rect, kind }, { value: rect.y + rect.h, rect, kind })
      }
      const parentRect = parentId ? ctx.rects.get(parentId) : null
      if (parentRect && parentRect.w > 0 && parentRect.h > 0) push(parentRect, 'parent')
      const parentNode = parentId ? ctx.nodes.get(parentId) : null
      for (const child of parentNode?.children ?? []) {
        if (skip.has(child.id) || child.visible === false) continue
        const rect = ctx.rects.get(child.id)
        if (rect) push(rect, 'sibling')
      }
      // Верхние фреймы добавляются, только когда родитель не корень: у корня они
      // уже попали в соседей, и второй набор дал бы по две линии на каждый край.
      if (parentId !== 'root') {
        for (const id of ctx.order) {
          if (ctx.parents.get(id) !== 'root' || skip.has(id) || id === parentId) continue
          const node = ctx.nodes.get(id)
          const rect = ctx.rects.get(id)
          if (node && node.visible !== false && rect) push(rect, 'frame')
        }
      }
      return axes
    }

    /**
     * Привязать габарит к ближайшим линиям кандидатов и направляющим.
     *
     * Порог передаётся в мировых единицах (панель считает «6 экранных пикселей
     * / zoom»), поэтому «липкость» привязки не зависит от масштаба. `allowed`
     * ограничивает привязку набором краёв (`left`, `center`, `right`, `top`,
     * `middle`, `bottom`): при ресайзе двигаются только те края, которые тянет
     * ручка, а сдвигать габарит целиком нельзя.
     *
     * Возвращает сдвиг, совпавший край и только те линии, которые действительно
     * совпали: рисовать всех кандидатов в пределах порога значило бы показать
     * пользователю случайный набор.
     *
     * @returns {{dx: number, dy: number, matched: object, lines: object[]}}
     */
    function applySnap(box, candidates, guides, threshold, allowed) {
      const permit = allowed ? new Set(allowed) : null
      const plan = [
        {
          axis: 'x',
          offset: 'dx',
          edges: [
            { value: box.x, key: 'left' },
            { value: box.x + box.w / 2, key: 'center' },
            { value: box.x + box.w, key: 'right' },
          ],
        },
        {
          axis: 'y',
          offset: 'dy',
          edges: [
            { value: box.y, key: 'top' },
            { value: box.y + box.h / 2, key: 'middle' },
            { value: box.y + box.h, key: 'bottom' },
          ],
        },
      ]
      const options = { x: [...(candidates?.x ?? [])], y: [...(candidates?.y ?? [])] }
      for (const value of guides?.x ?? []) options.x.push({ value, rect: null, kind: 'guide' })
      for (const value of guides?.y ?? []) options.y.push({ value, rect: null, kind: 'guide' })

      const matched = { x: null, y: null }
      for (const item of plan) {
        for (const edge of item.edges) {
          if (permit && !permit.has(edge.key)) continue
          for (const target of options[item.axis]) {
            const distance = Math.abs(target.value - edge.value)
            if (distance > threshold) continue
            if (!matched[item.axis] || distance < matched[item.axis].distance) {
              matched[item.axis] = { key: edge.key, delta: target.value - edge.value, distance }
            }
          }
        }
      }

      const result = {
        dx: matched.x ? matched.x.delta : 0,
        dy: matched.y ? matched.y.delta : 0,
        matched,
        lines: [],
      }
      const shiftOf = (axis) => (matched[axis] ? matched[axis].delta : 0)
      const shifted = { x: box.x + result.dx, y: box.y + result.dy, w: box.w, h: box.h }
      const seen = new Set()
      for (const item of plan) {
        for (const edge of item.edges) {
          if (permit && !permit.has(edge.key)) continue
          const value = edge.value + shiftOf(item.axis)
          for (const target of options[item.axis]) {
            if (Math.abs(target.value - value) > 0.01) continue
            const other = target.rect
            const key = `${item.axis}:${target.value}:${target.kind}:${other ? `${other.x},${other.y},${other.w},${other.h}` : 'guide'}`
            if (seen.has(key)) continue
            seen.add(key)
            const line = { axis: item.axis, value: target.value, kind: target.kind, from: null, to: null }
            if (item.axis === 'x' && other) {
              line.from = Math.min(shifted.y, other.y)
              line.to = Math.max(shifted.y + shifted.h, other.y + other.h)
            } else if (item.axis === 'y' && other) {
              line.from = Math.min(shifted.x, other.x)
              line.to = Math.max(shifted.x + shifted.w, other.x + other.w)
            }
            result.lines.push(line)
          }
        }
      }
      return result
    }

    /**
     * Узлы, попавшие в рамку выделения.
     *
     * Если рамка целиком лежит внутри контейнера, спускаемся в него: иначе
     * протяжка по экрану выбирала бы только верхние фреймы и достать до их
     * содержимого было бы нельзя. Узел, который рамка лишь пересекает, попадает
     * в выделение целиком. Внутрь инстанса не заходим — его детские id
     * транзиентны, выбрать их нельзя.
     */
    function marqueeNodes(ctx, rect, scopeId = 'root') {
      const out = []
      const seen = new Set()
      const intersects = (box) => box.x < rect.x + rect.w && box.x + box.w > rect.x && box.y < rect.y + rect.h && box.y + box.h > rect.y
      const contains = (box) => rect.x >= box.x && rect.y >= box.y
        && rect.x + rect.w <= box.x + box.w && rect.y + rect.h <= box.y + box.h
      const step = (id) => {
        if (seen.has(id)) return
        seen.add(id)
        const node = ctx.nodes.get(id)
        const box = ctx.rects.get(id)
        if (!node || !box || node.visible === false) return
        if (id === scopeId || id === 'root') {
          for (const child of node.children ?? []) step(child.id)
          return
        }
        if (!intersects(box)) return
        const descend = CONTAINERS.includes(node.type) && node.type !== 'instance'
          && (node.children ?? []).length > 0 && contains(box)
        if (descend) {
          for (const child of node.children ?? []) step(child.id)
          return
        }
        out.push(id)
      }
      step(scopeId)
      return out
    }

    /**
     * Узлы выделения, которые двигаются сами.
     *
     * Потомок выделенного предка едет вместе с ним, и второй сдвиг увёл бы его
     * вдвое дальше; поэтому из выделения берутся только его «корни».
     */
    function movableRoots(parents, ids) {
      const set = new Set(ids)
      return ids.filter((id) => !ancestorChain(parents, id).slice(1).some((ancestor) => set.has(ancestor)))
    }

    /**
     * Ограничение перемещения по оси.
     *
     * `Shift` ведёт узел строго по X или по Y — по той оси, куда курсор ушёл
     * сильнее. Это и есть «движение по направляющей»: узел скользит вдоль
     * линии, не сносит в сторону.
     */
    function axisLock(dx, dy, locked) {
      if (!locked) return { dx, dy }
      return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy }
    }

    /** Габарит набора узлов в координатах их общего родителя. */
    function boundsOf(nodes) {
      const x = Math.min(...nodes.map((node) => num(node.x, 0)))
      const y = Math.min(...nodes.map((node) => num(node.y, 0)))
      return {
        x,
        y,
        w: Math.max(...nodes.map((node) => num(node.x, 0) + num(node.w, 0))) - x,
        h: Math.max(...nodes.map((node) => num(node.y, 0) + num(node.h, 0))) - y,
      }
    }

    /** Абсолютный прямоугольник → локальный относительно контейнера. */
    function localBox(box, offset) {
      return { x: box.x - offset.x, y: box.y - offset.y, w: box.w, h: box.h }
    }

    /**
     * Пересчитать узлы внутрь контейнера, вставшего по их габариту.
     *
     * Общий шаг группы и «объединить в фрейм»: правило обязано совпадать с
     * операцией `group` ядра, иначе панель и агент дают разные координаты детей.
     */
    function rebaseNodes(nodes, bounds) {
      for (const node of nodes) {
        node.x = num(node.x, 0) - bounds.x
        node.y = num(node.y, 0) - bounds.y
      }
      return nodes
    }

    /** Значение по умолчанию параметра, приведённое к его типу. */
    function coercePropDefault(type, value) {
      if (type === 'number') return num(value, 0)
      if (type === 'boolean') return value === true || value === 'true' || value === '1'
      return String(value ?? '')
    }

    /** Путь свойства по умолчанию — тот же, что у host-схемы. */
    function defaultPropProperty(type) {
      if (type === 'color' || type === 'token') return 'style.fill'
      if (type === 'number') return 'w'
      if (type === 'boolean') return 'visible'
      return 'text.value'
    }

    /** Копия поддерева с новыми id: дублирование и вставка из буфера панели. */
    function reidTree(node) {
      const copy = clone(node)
      const step = (item) => {
        item.id = nextNodeId(item.type === 'frame' ? 'fr' : item.type === 'text' ? 'tx' : 'n')
        for (const child of item.children ?? []) step(child)
      }
      step(copy)
      return copy
    }

    /** Шаг штрихов линейки: не мельче восьми экранных пикселей. */
    function rulerStep(zoom) {
      const scale = Math.max(num(zoom, 1), 0.01)
      const power = Math.pow(10, Math.floor(Math.log10(8 / scale)))
      for (const factor of [1, 2, 5, 10]) {
        if (factor * power * scale >= 8) return factor * power
      }
      return 10 * power
    }

    /** Направляющие одной оси из документа: поля может не быть вовсе. */
    function guidesOf(doc, axis) {
      const list = doc?.guides?.[axis]
      return Array.isArray(list) ? list : []
    }

    /** Отсортировать и дедуплицировать координаты направляющих. */
    function tidyGuides(list) {
      const out = []
      for (const value of list ?? []) {
        const n = Math.round(num(value, Number.NaN) * 100) / 100
        if (!Number.isFinite(n) || out.includes(n)) continue
        out.push(n)
      }
      out.sort((a, b) => a - b)
      return out.slice(0, 100)
    }

    // ==================================================== стили узлов (рендер) ====

    /** CSS-рамка узла: координаты, заливка, обводка, тень, клип. */
    function nodeBoxStyle(node, tokens) {
      const style = isPlainObject(node.style) ? node.style : {}
      const box = {
        position: 'absolute',
        left: `${num(node.x, 0)}px`,
        top: `${num(node.y, 0)}px`,
        width: `${Math.max(0, num(node.w, 0))}px`,
        height: `${Math.max(0, num(node.h, 0))}px`,
      }
      if (num(node.rotation, 0) !== 0) box.transform = `rotate(${num(node.rotation, 0)}deg)`
      if (num(style.opacity, 1) !== 1) box.opacity = String(num(style.opacity, 1))
      const fill = cssColor(tokens, style.fill)
      if (fill) box.background = fill
      const strokeColor = cssColor(tokens, style.stroke?.color)
      const strokeWidth = num(style.stroke?.width, 1)
      if (strokeColor && strokeWidth > 0) box.border = `${strokeWidth}px solid ${strokeColor}`
      const radius = cssLength(tokens, style.radius)
      if (radius) box.borderRadius = radius
      if (node.type === 'ellipse') box.borderRadius = '50%'
      const shadow = shadowCss(tokens, style.shadow)
      if (shadow) box.boxShadow = shadow
      if (node.clip) box.overflow = 'hidden'
      if (node.visible === false) box.display = 'none'
      return box
    }

    /** CSS-стиль текста узла: пресет токена + точечные переопределения. */
    function nodeTextStyle(node, tokens) {
      const text = isPlainObject(node.text) ? node.text : {}
      const preset = isPlainObject(tokens?.[text.token]) ? tokens[text.token] : {}
      const size = num(text.size, num(preset.size, 14))
      const weight = num(text.weight, num(preset.weight, 400))
      const lineHeight = num(text.lineHeight, num(preset.lineHeight, 1.4))
      const letterSpacing = num(text.letterSpacing, num(preset.letterSpacing, 0))
      const family = tokens?.['font.sans']
      return {
        width: '100%',
        color: cssColor(tokens, text.color) ?? 'inherit',
        fontFamily: typeof family === 'string' ? family : undefined,
        fontSize: `${size}px`,
        fontWeight: String(weight),
        lineHeight: String(lineHeight),
        letterSpacing: `${letterSpacing}px`,
        textAlign: text.align ?? 'left',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }
    }

    /** Выравнивание по вертикали для flex-обёртки текста. */
    function textAlignItems(node) {
      const valign = node.text?.valign ?? 'top'
      if (valign === 'middle') return 'center'
      if (valign === 'bottom') return 'flex-end'
      return 'flex-start'
    }

    // ==================================================== токены: группировка ====

    /** Плоская карта токенов → вложенные группы для `POST /tokens`. */
    function groupsFromFlat(flat) {
      const out = {}
      for (const [path, value] of Object.entries(flat ?? {})) {
        const parts = String(path).split('.')
        if (parts.length < 2 || parts.some((part) => part === '')) continue
        const group = parts[0]
        const name = parts[1]
        const bucket = out[group] ?? (out[group] = {})
        if (parts.length === 2) {
          const existing = bucket[name]
          if (isPlainObject(existing)) bucket[name] = { ...value, ...existing }
          else if (isPlainObject(value)) bucket[name] = { ...value }
          else bucket[name] = value
          continue
        }
        const composite = isPlainObject(bucket[name]) ? bucket[name] : (bucket[name] = {})
        composite[parts.slice(2).join('.')] = value
      }
      return out
    }

    /** Плоская карта токенов → дерево групп для панели токенов. */
    function tokenTree(flat) {
      const groups = new Map()
      for (const [path, value] of Object.entries(flat ?? {})) {
        const parts = String(path).split('.')
        if (parts.length < 2) continue
        const [group, name, ...rest] = parts
        if (!groups.has(group)) groups.set(group, new Map())
        const names = groups.get(group)
        if (!names.has(name)) names.set(name, { name, path: `${group}.${name}`, value: null, subs: new Map() })
        const entry = names.get(name)
        if (rest.length === 0) {
          if (!isPlainObject(value)) entry.value = value
        } else {
          entry.subs.set(rest.join('.'), value)
        }
      }
      return groups
    }

    /** Порядок групп токенов в панели. */
    const TOKEN_GROUP_ORDER = ['color', 'radius', 'space', 'font', 'text', 'shadow']

    /** Тип контрола для значения токена. */
    function tokenKind(group, key, value) {
      const name = String(key ?? '').toLowerCase()
      if (name === 'color' || name.endsWith('color') || group === 'color') return 'color'
      if (typeof value === 'number') return 'number'
      if (group === 'radius' || group === 'space') return 'number'
      if (name === 'size' || name === 'weight' || name === 'lineHeight' || name === 'letterSpacing') return 'number'
      if (name === 'x' || name === 'y' || name === 'blur' || name === 'spread') return 'number'
      return 'text'
    }

    // ============================================================ подкомпоненты ====

    /**
     * Модальное окно: заголовок, тело, две кнопки.
     *
     * Слушатель клавиш вешается один раз за жизнь модалки, а свежие колбэки
     * берутся из ref. С `onClose` в зависимостях эффект перевешивался на каждом
     * рендере панели: перерегистрация во время обработки `keydown` (её вызывает
     * соседний слушатель горячих клавиш) оставляла Escape без реакции, а
     * `ref.current.focus()` уводил фокус из поля прямо во время набора.
     */
    function Modal({ title, children, onClose, onSubmit, submitLabel, cancelLabel, danger, wide }) {
      const ref = useRef(null)
      const handlersRef = useRef({ onClose, onSubmit })
      handlersRef.current = { onClose, onSubmit }
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') handlersRef.current.onClose()
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) handlersRef.current.onSubmit?.()
        }
        window.addEventListener('keydown', onKey)
        ref.current?.focus()
        return () => window.removeEventListener('keydown', onKey)
      }, [])
      return h('div', {
        className: 'dc-overlay',
        role: 'presentation',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', {
          className: 'dc-modal',
          role: 'dialog',
          'aria-modal': true,
          'aria-label': title,
          ref,
          tabIndex: -1,
          style: wide ? { minWidth: 480 } : undefined,
        },
          h('h3', null, title),
          children,
          h('div', { className: 'dc-modal-actions' },
            h('button', { type: 'button', className: 'dc-btn', onClick: onClose }, cancelLabel),
            onSubmit ? h('button', {
              type: 'button',
              className: `dc-btn dc-btn-primary${danger ? ' dc-btn-danger' : ''}`,
              onClick: onSubmit,
            }, submitLabel) : null,
          ),
        ),
      )
    }

    /** Поле с подписью. */
    function Field({ label, children, wide }) {
      return h('label', { className: 'dc-field', style: wide ? { gridColumn: '1 / -1' } : undefined },
        h('span', { className: 'dc-field-label' }, label),
        children,
      )
    }

    /** Числовое поле. */
    function NumberField({ label, value, onChange, step = 1, min, title }) {
      return h(Field, { label },
        h('input', {
          type: 'number',
          className: 'dc-input',
          value: value === null || value === undefined ? '' : String(value),
          step,
          min,
          title,
          'aria-label': label,
          onChange: (event) => onChange(event.target.value === '' ? null : Number(event.target.value)),
        }),
      )
    }

    /** Строковое поле. */
    function TextField({ label, value, onChange, placeholder, wide, title }) {
      return h(Field, { label, wide },
        h('input', {
          type: 'text',
          className: 'dc-input',
          value: value === null || value === undefined ? '' : String(value),
          placeholder,
          title,
          'aria-label': label,
          onChange: (event) => onChange(event.target.value),
        }),
      )
    }

    /** Селект из пар «значение — подпись». */
    function SelectField({ label, value, options, onChange, wide, allowEmpty }) {
      const current = value === null || value === undefined ? '' : String(value)
      const known = options.some((option) => String(option.value) === current)
      return h(Field, { label, wide },
        h('select', {
          className: 'dc-select',
          value: current,
          'aria-label': label,
          onChange: (event) => onChange(event.target.value),
        },
          allowEmpty || !known ? h('option', { value: '' }, '—') : null,
          options.map((option) => h('option', { key: String(option.value), value: String(option.value) }, option.label)),
        ),
      )
    }

    /**
     * Цветовое поле: показывает оба режима значения — литерал и токен.
     *
     * Свотч и hex-поле работают с конкретным цветом (токен подставляется
     * разрешённым значением), а селект переключает поле на ссылку `token:…`.
     */
    function ColorField({ label, value, tokens, onChange, t }) {
      const resolved = cssColor(tokens, value)
      const hex = toHexColor(resolved ?? value, '#000000')
      const options = useMemo(
        () => Object.keys(tokens ?? {}).filter((path) => path.startsWith('color.')).sort(),
        [tokens],
      )
      const literal = isTokenRef(value) ? String(resolved ?? '') : String(value ?? '')
      return h('div', { className: 'dc-field' },
        h('span', { className: 'dc-field-label' }, label),
        h('div', { className: 'dc-color' },
          h('input', {
            type: 'color',
            className: 'dc-swatch',
            value: hex,
            title: t('colorPick'),
            'aria-label': `${label}: ${t('colorPick')}`,
            onChange: (event) => onChange(event.target.value),
          }),
          h('input', {
            type: 'text',
            className: 'dc-input',
            value: literal,
            title: isTokenRef(value) ? tokenPath(value) : hex,
            'aria-label': label,
            onChange: (event) => onChange(event.target.value),
          }),
          h('select', {
            className: 'dc-select',
            value: isTokenRef(value) ? value : '',
            title: t('colorToken'),
            'aria-label': `${label}: ${t('colorToken')}`,
            onChange: (event) => onChange(event.target.value === '' ? hex : event.target.value),
          },
            h('option', { value: '' }, t('colorLiteral')),
            options.map((path) => h('option', { key: path, value: `token:${path}` }, path)),
          ),
        ),
      )
    }

    /** Секция инспектора с заголовком. */
    function Section({ title, children }) {
      return h('div', { className: 'dc-section' },
        h('div', { className: 'dc-section-title' }, title),
        children,
      )
    }

    // ------------------------------------------------------------- Toolbar ----

    /** Верхний тулбар: инструменты, зум, действия, проект. */
    function Toolbar(props) {
      const {
        t, tool, onTool, view, onZoomIn, onZoomOut, onZoomFit, onZoomReset,
        onUndo, onRedo, canUndo, canRedo, onSave, onExport, onValidate, onRefresh,
        saveState, busy, projects, project, onProject,
        rulers, onRulers, showGuides, onShowGuides, snapEnabled, onSnap, guideCount, onGuidesClear,
      } = props
      const tools = [
        { id: 'select', glyph: '➤', label: t('toolSelect') },
        { id: 'frame', glyph: '▣', label: t('toolFrame') },
        { id: 'rect', glyph: '▢', label: t('toolRect') },
        { id: 'ellipse', glyph: '◯', label: t('toolEllipse') },
        { id: 'text', glyph: 'T', label: t('toolText') },
      ]
      const stateLabel = {
        saved: t('savedState'),
        dirty: t('dirtyState'),
        saving: t('savingState'),
        error: t('errorState'),
      }[saveState] ?? t('savedState')
      return h('div', { className: 'dc-toolbar' },
        h('span', { className: 'dc-card-title' }, t('panel')),
        h('select', {
          className: 'dc-select',
          value: project,
          title: t('project'),
          'aria-label': t('project'),
          onChange: (event) => onProject(event.target.value),
        },
          projects.length === 0 ? h('option', { value: '' }, t('noProjects')) : null,
          projects.map((item) => h('option', { key: item.id, value: item.id }, `${item.title} (${item.canvases ?? 0})`)),
        ),
        h('span', { className: 'dc-toolbar-sep' }),
        h('div', { className: 'dc-tool-group', role: 'group', 'aria-label': t('tools') },
          tools.map((item) => h('button', {
            key: item.id,
            type: 'button',
            className: `dc-btn dc-btn-flat${tool === item.id ? ' dc-btn-active' : ''}`,
            title: item.label,
            'aria-label': item.label,
            'aria-pressed': tool === item.id,
            onClick: () => onTool(item.id),
          }, item.glyph)),
        ),
        h('div', { className: 'dc-tool-group' },
          h('button', { type: 'button', className: 'dc-btn dc-btn-flat', title: t('zoomOut'), onClick: onZoomOut }, '−'),
          h('span', { className: 'dc-muted', style: { minWidth: 44, textAlign: 'center' } }, `${Math.round(view.zoom * 100)}%`),
          h('button', { type: 'button', className: 'dc-btn dc-btn-flat', title: t('zoomIn'), onClick: onZoomIn }, '＋'),
          h('button', { type: 'button', className: 'dc-btn dc-btn-flat', title: t('zoomFit'), onClick: onZoomFit }, '⤢'),
          h('button', { type: 'button', className: 'dc-btn dc-btn-flat', title: t('zoomReset'), onClick: onZoomReset }, '1:1'),
        ),
        h('div', { className: 'dc-tool-group', role: 'group', 'aria-label': t('viewOptions') },
          h('button', {
            type: 'button',
            className: `dc-btn dc-btn-flat${rulers ? ' dc-btn-active' : ''}`,
            title: t('rulersHint'),
            'aria-pressed': rulers,
            onClick: onRulers,
          }, `⊞ ${t('rulers')}`),
          h('button', {
            type: 'button',
            className: `dc-btn dc-btn-flat${showGuides ? ' dc-btn-active' : ''}`,
            title: t('guidesHint'),
            'aria-pressed': showGuides,
            onClick: onShowGuides,
          }, `‖ ${t('guides')}`),
          h('button', {
            type: 'button',
            className: `dc-btn dc-btn-flat${snapEnabled ? ' dc-btn-active' : ''}`,
            title: t('snapHint'),
            'aria-pressed': snapEnabled,
            onClick: onSnap,
          }, `⇥ ${t('snap')}`),
          guideCount > 0
            ? h('button', {
              type: 'button',
              className: 'dc-btn dc-btn-flat',
              title: `${t('guidesClear')} (${guideCount})`,
              onClick: onGuidesClear,
            }, '✕')
            : null,
        ),
        h('span', { className: 'dc-toolbar-sep' }),
        h('button', { type: 'button', className: 'dc-btn', disabled: !canUndo, title: t('undo'), onClick: onUndo }, '↶'),
        h('button', { type: 'button', className: 'dc-btn', disabled: !canRedo, title: t('redo'), onClick: onRedo }, '↷'),
        h('button', { type: 'button', className: 'dc-btn', title: t('refresh'), onClick: onRefresh }, `⟳ ${t('refresh')}`),
        h('span', { className: 'dc-spacer' }),
        h('span', { className: 'dc-muted' }, busy ? t('loading') : stateLabel),
        h('button', { type: 'button', className: 'dc-btn', title: t('validate'), onClick: onValidate }, `✓ ${t('validate')}`),
        h('button', { type: 'button', className: 'dc-btn', title: t('export'), onClick: onExport }, `⤓ ${t('export')}`),
        h('button', { type: 'button', className: 'dc-btn dc-btn-primary', title: t('save'), onClick: onSave }, t('save')),
      )
    }

    // --------------------------------------------------------- LayersTree ----

    /** Глиф типа узла в дереве слоёв. */
    function typeGlyph(node) {
      if (node.component) return '◈'
      return {
        frame: '▣',
        group: '▤',
        rect: '▢',
        ellipse: '◯',
        line: '╱',
        text: 'T',
        image: '▨',
        instance: '◈',
      }[node.type] ?? '•'
    }

    /**
     * Дерево слоёв: иерархия, переименование, видимость, замок, порядок, удаление.
     *
     * Инстанс показывается одним узлом с пометкой компонента — его внутренность
     * принадлежит компоненту, а не документу.
     */
    function LayersTree(props) {
      const {
        t, display, selection, expanded, hoverId, onHoverId, onContext,
        onToggle, onSelect, onRename, onPatch, onMove, onDelete,
      } = props
      const [editing, setEditing] = useState('')

      /**
       * Предки наведённого узла: на холсте наведение подсвечивает всю цепочку
       * контейнеров, и дерево обязано показывать то же самое, иначе структура
       * читается по двум разным картинам.
       */
      const hoverChain = useMemo(() => {
        const chain = new Set()
        if (!hoverId) return chain
        let found = false
        const walk = (node) => {
          if (found) return
          if (node.id === hoverId) {
            found = true
            return
          }
          for (const child of node.children ?? []) {
            walk(child)
            if (found) {
              chain.add(node.id)
              return
            }
          }
        }
        walk({ id: 'root', children: display?.children ?? [] })
        return chain
      }, [display, hoverId])

      const rows = useMemo(() => {
        const out = []
        const walk = (node, depth) => {
          out.push({ node, depth })
          const isInstance = Boolean(node.component) || node.type === 'instance'
          if (isInstance) return
          if (!expanded.has(node.id)) return
          for (const child of node.children ?? []) walk(child, depth + 1)
        }
        for (const child of display?.children ?? []) walk(child, 0)
        return out
      }, [display, expanded])

      if (rows.length === 0) return h('div', { className: 'dc-empty' }, t('layersEmpty'))

      return h('div', {
        className: 'dc-list',
        onMouseLeave: () => onHoverId(''),
      },
        rows.map(({ node, depth }) => {
          const isInstance = Boolean(node.component) || node.type === 'instance'
          const hasChildren = !isInstance && (node.children ?? []).length > 0
          const id = baseId(node.id)
          const active = selection.includes(id)
          const hovered = hoverId === id
          return h('div', {
            key: node.id,
            className: `dc-tree-row${active ? ' dc-tree-row-active' : ''}${hovered ? ' dc-tree-row-hover' : ''}${hoverChain.has(node.id) ? ' dc-tree-row-ancestor' : ''}${node.visible === false ? ' dc-tree-dim' : ''}`,
            style: { paddingLeft: 4 + depth * 12 },
            title: `${node.name} · ${node.type}`,
            onMouseEnter: () => onHoverId(id),
            onClick: (event) => onSelect(baseId(node.id), event.shiftKey || event.metaKey || event.ctrlKey),
            onContextMenu: (event) => onContext(event, id),
          },
            h('span', {
              className: 'dc-tree-glyph',
              onClick: (event) => {
                event.stopPropagation()
                if (hasChildren) onToggle(node.id)
              },
            }, hasChildren ? (expanded.has(node.id) ? '▾' : '▸') : ''),
            h('span', { className: 'dc-tree-glyph', title: node.type }, typeGlyph(node)),
            editing === node.id
              ? h('input', {
                className: 'dc-input',
                style: { flex: 1, minWidth: 0 },
                autoFocus: true,
                value: node.name,
                onClick: (event) => event.stopPropagation(),
                onChange: (event) => onRename(node.id, event.target.value, false),
                onBlur: () => setEditing(''),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === 'Escape') setEditing('')
                },
              })
              : h('span', {
                className: 'dc-row-name',
                onDoubleClick: (event) => { event.stopPropagation(); setEditing(node.id) },
              },
                node.name,
                isInstance ? h('span', { className: 'dc-chip dc-chip-brand', style: { marginLeft: 6 } }, node.component || t('instanceMark')) : null,
              ),
            h('span', { className: 'dc-row-actions' },
              h('button', {
                type: 'button',
                className: 'dc-icon-btn',
                title: node.visible === false ? t('visibilityShow') : t('visibilityHide'),
                onClick: (event) => { event.stopPropagation(); onPatch(node.id, { visible: node.visible === false }) },
              }, node.visible === false ? '🙈' : '👁'),
              h('button', {
                type: 'button',
                className: 'dc-icon-btn',
                title: node.locked ? t('unlock') : t('lock'),
                onClick: (event) => { event.stopPropagation(); onPatch(node.id, { locked: !node.locked }) },
              }, node.locked ? '🔒' : '🔓'),
              h('button', {
                type: 'button',
                className: 'dc-icon-btn',
                title: t('moveUp'),
                onClick: (event) => { event.stopPropagation(); onMove(node.id, -1) },
              }, '↑'),
              h('button', {
                type: 'button',
                className: 'dc-icon-btn',
                title: t('moveDown'),
                onClick: (event) => { event.stopPropagation(); onMove(node.id, 1) },
              }, '↓'),
              h('button', {
                type: 'button',
                className: 'dc-icon-btn dc-error',
                title: t('nodeDelete'),
                onClick: (event) => { event.stopPropagation(); onDelete(node.id) },
              }, '✕'),
            ),
          )
        }),
      )
    }

    // ---------------------------------------------------------- CanvasesPanel ----

    /** Список холстов проекта плюс корзина. */
    function CanvasesPanel(props) {
      const { t, fmt, canvases, current, onOpen, onCreate, onDelete, onRefresh, trash, onTrash, onRestore, busy } = props
      if (trash) {
        return h('div', null,
          h('div', { className: 'dc-left-tools' },
            h('button', { type: 'button', className: 'dc-btn', onClick: onTrash }, `← ${t('trashBack')}`),
            h('span', { className: 'dc-spacer' }),
            h('span', { className: 'dc-muted' }, t('trashTitle')),
          ),
          (trash.entries ?? []).length === 0
            ? h('div', { className: 'dc-empty' }, t('trashEmpty'))
            : h('div', { className: 'dc-list' }, (trash.entries ?? []).map((entry) => h('div', { key: entry.trashId, className: 'dc-card' },
              h('div', { className: 'dc-card-head' },
                h('span', { className: 'dc-card-title' }, entry.canvas ?? entry.trashId),
                h('span', { className: 'dc-spacer' }),
                h('button', { type: 'button', className: 'dc-btn', onClick: () => onRestore(entry.trashId) }, t('restore')),
              ),
              h('div', { className: 'dc-card-meta' },
                h('span', null, entry.project ?? '—'),
                h('span', null, fmt('deletedAt', { date: formatDate(entry.deletedAt) })),
              ),
            ))),
        )
      }
      return h('div', null,
        h('div', { className: 'dc-left-tools' },
          h('button', { type: 'button', className: 'dc-btn dc-btn-primary', disabled: busy, onClick: onCreate }, `＋ ${t('canvasNew')}`),
          h('button', { type: 'button', className: 'dc-btn', disabled: busy, onClick: onRefresh }, '⟳'),
          h('button', { type: 'button', className: 'dc-btn', disabled: busy, onClick: onTrash }, `🗑 ${t('trash')}`),
        ),
        canvases.length === 0
          ? h('div', { className: 'dc-empty' }, t('noCanvases'))
          : h('div', { className: 'dc-list' }, canvases.map((item) => h('div', {
            key: item.id,
            className: `dc-card${item.id === current ? ' dc-row-active' : ''}`,
            onClick: () => onOpen(item.id),
          },
            h('div', { className: 'dc-card-head' },
              h('span', { className: 'dc-card-title' }, item.name ?? item.id),
              h('span', { className: 'dc-spacer' }),
              h('span', { className: 'dc-chip' }, item.device ?? '—'),
              h('button', {
                type: 'button',
                className: 'dc-icon-btn dc-error',
                title: t('deleteToTrash'),
                onClick: (event) => { event.stopPropagation(); onDelete(item.id) },
              }, '🗑'),
            ),
            h('div', { className: 'dc-card-meta' },
              h('span', null, item.id),
              h('span', null, fmt('nodesShort', { count: item.nodes ?? 0 })),
              h('span', null, `rev ${item.rev ?? 0}`),
              h('span', null, formatDate(item.updatedAt)),
            ),
          ))),
        h('div', { className: 'dc-muted', style: { marginTop: 8, fontSize: 11 } }, t('panelHint')),
      )
    }

    // ------------------------------------------------------- ComponentsPanel ----

    /**
     * Миниатюра компонента.
     *
     * Рисуется тем же `NodeView`, что и холст, поэтому превью не расходится с
     * макетом: отдельная «упрощённая» отрисовка рано или поздно начала бы
     * показывать не то, что стоит на холсте. Масштаб подбирается под рамку.
     */
    function ComponentPreview({ doc, tokens, componentKey, variant, width = 248, height = 84 }) {
      const component = doc?.components?.[componentKey]
      const template = component ? componentTemplate(component, variant) : null
      const expanded = useMemo(() => {
        if (!template) return null
        try {
          return expandTree(doc, template)
        } catch {
          return template
        }
      }, [doc, template])
      if (!expanded) return h('div', { className: 'dc-preview dc-empty', style: { width, height } }, '—')
      const boxW = Math.max(1, num(expanded.w, 100))
      const boxH = Math.max(1, num(expanded.h, 100))
      const scale = Math.min((width - 12) / boxW, (height - 12) / boxH, 1)
      return h('div', { className: 'dc-preview', style: { width, height } },
        h('div', {
          className: 'dc-preview-world',
          style: {
            width: `${boxW}px`,
            height: `${boxH}px`,
            left: `${(width - boxW * scale) / 2}px`,
            top: `${(height - boxH * scale) / 2}px`,
            transform: `scale(${scale})`,
          },
        }, h(NodeView, { node: expanded, tokens, selection: [] })),
      )
    }

    /**
     * Библиотека компонентов холста: список с превью, поиск и карточка
     * подробностей.
     *
     * Раньше из панели были доступны только «поставить» и «удалить»: что за
     * компонент, как он выглядит и какие у него параметры, приходилось выяснять
     * по инстансу на холсте, а шаблон и параметры правились только батчем от
     * агента. Здесь появились превью, редактор параметров (с выбором цели по
     * именам узлов шаблона), поиск, переход к инстансам и клонирование.
     */
    function ComponentsPanel(props) {
      const {
        t, fmt, doc, tokens, components, selection, selectedInstance,
        onDefine, onInstantiate, onDelete, onDetach, onUpdate, onDuplicate, onFocus, onHoverInstances,
      } = props
      const [openKey, setOpenKey] = useState('')
      const [query, setQuery] = useState('')
      const [nameDraft, setNameDraft] = useState('')
      const [descriptionDraft, setDescriptionDraft] = useState('')
      const [rows, setRows] = useState([])
      const [busy, setBusy] = useState(false)

      const list = useMemo(() => {
        const text = query.trim().toLowerCase()
        const items = components ?? []
        if (text === '') return items
        return items.filter((item) => String(item.name ?? '').toLowerCase().includes(text)
          || String(item.key).toLowerCase().includes(text))
      }, [components, query])

      const detail = openKey ? (components ?? []).find((item) => item.key === openKey) : null
      const source = detail ? doc?.components?.[detail.key] : null
      const variantEntries = useMemo(() => Object.entries(source?.variants ?? {}), [source])

      /** Имена узлов шаблона: по ним выбирается цель параметра (`#Имя`). */
      const templateNames = useMemo(() => {
        const names = []
        if (source?.node) walkTree(source.node, (node) => { if (node.name) names.push(node.name) })
        return [...new Set(names)]
      }, [source])

      const openDetail = useCallback((key) => {
        const component = doc?.components?.[key]
        setOpenKey(key)
        setNameDraft(component?.name ?? key)
        setDescriptionDraft(component?.description ?? '')
        setRows(Object.entries(component?.props ?? {}).map(([name, spec]) => ({
          name,
          type: spec.type ?? 'text',
          default: spec.type === 'boolean' ? String(spec.default === true) : String(spec.default ?? ''),
          target: spec.target ?? 'root',
          property: spec.property ?? '',
          description: spec.description ?? '',
        })))
      }, [doc])

      /**
       * Правка строки параметра.
       *
       * Смена типа подтягивает свойство по умолчанию (`text` → `text.value`,
       * `color` → `style.fill`), но только если пользователь не задал своё:
       * иначе после переключения типа параметр писал бы текст в заливку.
       */
      const updateRow = useCallback((index, patch) => {
        setRows((current) => current.map((row, position) => {
          if (position !== index) return row
          const next = { ...row, ...patch }
          if (patch.type !== undefined && patch.type !== row.type) {
            const current = String(row.property ?? '').trim()
            if (current === '' || current === defaultPropProperty(row.type)) {
              next.property = defaultPropProperty(patch.type)
            }
          }
          return next
        }))
      }, [])

      const addRow = useCallback(() => {
        setRows((current) => [...current, {
          name: `param${current.length + 1}`,
          type: 'text',
          default: '',
          target: 'root',
          property: 'text.value',
          description: '',
        }])
      }, [])

      const removeRow = useCallback((index) => {
        setRows((current) => current.filter((_row, position) => position !== index))
      }, [])

      const saveMeta = useCallback(async () => {
        if (!detail) return
        setBusy(true)
        try {
          await onUpdate(detail.key, { name: nameDraft, description: descriptionDraft })
        } finally {
          setBusy(false)
        }
      }, [descriptionDraft, detail, nameDraft, onUpdate])

      /**
       * Сохранить параметры целиком.
       *
       * Схема сливает параметры по полям и не удаляет пропавшие: чтобы убрать
       * параметр, его имя отправляется со значением `null`. Поэтому редактор
       * сравнивает список с исходным, а не просто отправляет строки.
       */
      const saveProps = useCallback(async () => {
        if (!detail) return
        const original = doc?.components?.[detail.key]?.props ?? {}
        const next = {}
        for (const row of rows) {
          const name = String(row.name ?? '').trim()
          if (name === '') continue
          next[name] = {
            type: PROP_TYPES.includes(row.type) ? row.type : 'text',
            default: coercePropDefault(row.type, row.default),
            description: String(row.description ?? ''),
            target: String(row.target ?? '').trim() === '' ? 'root' : String(row.target).trim(),
            property: String(row.property ?? '').trim() === '' ? defaultPropProperty(row.type) : String(row.property).trim(),
          }
        }
        for (const name of Object.keys(original)) {
          if (!(name in next)) next[name] = null
        }
        setBusy(true)
        try {
          await onUpdate(detail.key, { props: next })
        } finally {
          setBusy(false)
        }
      }, [detail, doc, onUpdate, rows])

      /**
       * Добавить вариацию из выделенного узла холста.
       *
       * Имя вариации выводится из имени узла и приводится к допустимым символам:
       * ключ вариации попадает в файл и в `design_apply`, поэтому кириллица и
       * пробелы в нём недопустимы.
       */
      const addVariantFromSelection = useCallback(async () => {
        if (!detail || !doc || selection.length !== 1) return
        const node = findNode(doc.root, selection[0])
        if (!node) return
        const taken = new Set(Object.keys(doc.components?.[detail.key]?.variants ?? {}))
        const base = String(node.name ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'variant'
        let name = base
        let index = 2
        while (taken.has(name)) {
          name = `${base}-${index}`
          index += 1
        }
        const template = clone(node)
        template.x = 0
        template.y = 0
        setBusy(true)
        try {
          await onUpdate(detail.key, { variants: { [name]: { name: node.name, node: template } } })
        } finally {
          setBusy(false)
        }
      }, [detail, doc, onUpdate, selection])

      const removeVariant = useCallback(async (name) => {
        if (!detail) return
        setBusy(true)
        try {
          await onUpdate(detail.key, { variants: { [name]: null } })
        } finally {
          setBusy(false)
        }
      }, [detail, onUpdate])

      if (detail) {
        return h('div', null,
          h('div', { className: 'dc-left-tools' },
            h('button', { type: 'button', className: 'dc-btn', onClick: () => setOpenKey('') }, `← ${t('tabComponents')}`),
            h('span', { className: 'dc-spacer' }),
            h('span', { className: 'dc-muted' }, detail.key),
          ),
          h(ComponentPreview, { doc, tokens, componentKey: detail.key, width: 246, height: 140 }),
          h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 } },
            h(TextField, { label: t('componentName'), value: nameDraft, onChange: setNameDraft, wide: true }),
            h(TextField, { label: t('componentDescription'), value: descriptionDraft, onChange: setDescriptionDraft, wide: true }),
            h('div', { className: 'dc-left-tools' },
              h('button', { type: 'button', className: 'dc-btn dc-btn-primary', disabled: busy, onClick: () => { saveMeta().catch(() => {}) } }, t('save')),
              h('button', { type: 'button', className: 'dc-btn', onClick: () => onInstantiate(detail.key) }, t('componentPlace')),
              h('button', { type: 'button', className: 'dc-btn', onClick: () => { onDuplicate(detail.key).catch(() => {}) } }, t('duplicate')),
            ),
          ),
          h(Section, { title: t('componentProps') },
            h('div', { className: 'dc-muted', style: { fontSize: 11, marginBottom: 6 } }, t('componentPropsHint')),
            rows.length === 0 ? h('div', { className: 'dc-muted', style: { fontSize: 11, marginBottom: 6 } }, t('propsEmpty')) : null,
            rows.map((row, index) => h('div', { key: `row-${index}`, className: 'dc-prop-row' },
              h('div', { className: 'dc-field-row' },
                h('input', {
                  className: 'dc-input',
                  style: { flex: 1 },
                  value: row.name,
                  placeholder: t('propName'),
                  'aria-label': t('propName'),
                  onChange: (event) => updateRow(index, { name: event.target.value }),
                }),
                h('select', {
                  className: 'dc-select',
                  value: row.type,
                  'aria-label': t('propType'),
                  onChange: (event) => updateRow(index, { type: event.target.value }),
                }, PROP_TYPES.map((type) => h('option', { key: type, value: type }, type))),
                h('button', { type: 'button', className: 'dc-icon-btn dc-error', title: t('nodeDelete'), onClick: () => removeRow(index) }, '✕'),
              ),
              h('div', { className: 'dc-field-row', style: { marginTop: 4 } },
                h('input', { className: 'dc-input', style: { flex: 1 }, value: row.default, placeholder: t('propDefault'), 'aria-label': t('propDefault'), onChange: (event) => updateRow(index, { default: event.target.value }) }),
                h('input', { className: 'dc-input', style: { flex: 1 }, value: row.target, placeholder: t('propTarget'), 'aria-label': t('propTarget'), onChange: (event) => updateRow(index, { target: event.target.value }) }),
                h('input', { className: 'dc-input', style: { flex: 1 }, value: row.property, placeholder: t('propProperty'), 'aria-label': t('propProperty'), onChange: (event) => updateRow(index, { property: event.target.value }) }),
              ),
              templateNames.length > 0
                ? h('div', { className: 'dc-card-meta' }, templateNames.slice(0, 8).map((name) => h('button', {
                  key: name,
                  type: 'button',
                  className: 'dc-chip dc-chip-btn',
                  title: fmt('propTargetHint', { name }),
                  onClick: () => updateRow(index, { target: `#${name}` }),
                }, `#${name}`)))
                : null,
            )),
            h('div', { className: 'dc-left-tools', style: { marginTop: 6 } },
              h('button', { type: 'button', className: 'dc-btn', onClick: addRow }, `＋ ${t('propAdd')}`),
              h('button', { type: 'button', className: 'dc-btn dc-btn-primary', disabled: busy, onClick: () => { saveProps().catch(() => {}) } }, t('propsApply')),
            ),
          ),
          h(Section, { title: t('componentVariants') },
            h('div', { className: 'dc-muted', style: { fontSize: 11, marginBottom: 6 } }, t('componentVariantsHint')),
            variantEntries.length === 0
              ? h('div', { className: 'dc-muted', style: { fontSize: 11, marginBottom: 6 } }, t('variantsEmpty'))
              : null,
            variantEntries.map(([name, spec]) => h('div', { key: name, className: 'dc-prop-row' },
              h(ComponentPreview, { doc, tokens, componentKey: detail.key, variant: name, width: 120, height: 56 }),
              h('div', { className: 'dc-field-row', style: { marginTop: 4 } },
                h('span', { className: 'dc-card-title' }, spec.name ?? name),
                h('span', { className: 'dc-chip' }, name),
                h('span', { className: 'dc-spacer' }),
                h('button', {
                  type: 'button',
                  className: 'dc-icon-btn dc-error',
                  title: t('variantRemove'),
                  onClick: () => { removeVariant(name).catch(() => {}) },
                }, '✕'),
              ),
            )),
            h('div', { className: 'dc-left-tools', style: { marginTop: 6 } },
              h('button', {
                type: 'button',
                className: 'dc-btn',
                disabled: busy || selection.length !== 1,
                title: selection.length !== 1 ? t('variantAddHint') : t('variantAdd'),
                onClick: () => { addVariantFromSelection().catch(() => {}) },
              }, `＋ ${t('variantAdd')}`),
            ),
          ),
          h(Section, { title: t('componentInstances') },
            h('div', { className: 'dc-muted', style: { fontSize: 11 } }, fmt('componentInstancesHint', { count: detail.instances ?? 0 })),
            h('div', { className: 'dc-left-tools', style: { marginTop: 6 } },
              h('button', { type: 'button', className: 'dc-btn', onClick: () => onFocus(detail.key) }, t('componentFindShort')),
              h('button', { type: 'button', className: 'dc-btn dc-btn-danger', onClick: () => onDelete(detail.key) }, t('componentDelete')),
            ),
          ),
        )
      }

      return h('div', null,
        h('div', { className: 'dc-left-tools' },
          h('button', {
            type: 'button',
            className: 'dc-btn dc-btn-primary',
            disabled: selection.length === 0,
            title: selection.length === 0 ? t('selectFirst') : t('componentDefine'),
            onClick: onDefine,
          }, `＋ ${t('componentDefine')}`),
        ),
        h('input', {
          className: 'dc-input',
          style: { width: '100%', marginBottom: 8 },
          value: query,
          placeholder: t('componentSearch'),
          'aria-label': t('componentSearch'),
          onChange: (event) => setQuery(event.target.value),
        }),
        selectedInstance
          ? h('div', { className: 'dc-left-tools' },
            h('span', { className: 'dc-muted' }, `${t('instanceComponent')}: ${selectedInstance.component}`),
            h('button', { type: 'button', className: 'dc-btn', onClick: () => onDetach(selectedInstance.id) }, t('detach')),
          )
          : null,
        list.length === 0
          ? h('div', { className: 'dc-empty' }, components.length === 0 ? t('componentsEmpty') : t('componentNotFound'))
          : h('div', { className: 'dc-list' }, list.map((component) => h('div', {
            key: component.key,
            className: 'dc-card dc-card-clickable',
            title: t('componentOpen'),
            onMouseEnter: () => onHoverInstances(component.key),
            onMouseLeave: () => onHoverInstances(''),
            onClick: () => openDetail(component.key),
          },
            h(ComponentPreview, { doc, tokens, componentKey: component.key, width: 248, height: 84 }),
            h('div', { className: 'dc-card-head', style: { marginTop: 6 } },
              h('span', { className: 'dc-card-title', title: component.key }, component.name ?? component.key),
              h('span', { className: 'dc-spacer' }),
              h('span', { className: 'dc-chip' }, `${Math.round(num(component.w, 0))}×${Math.round(num(component.h, 0))}`),
            ),
            h('div', { className: 'dc-card-meta' },
              h('span', null, component.key),
              h('span', null, fmt('componentInstances', { count: component.instances ?? 0 })),
              h('span', null, fmt('propsCount', { count: Object.keys(component.props ?? {}).length })),
              (component.variants ?? 0) > 0 ? h('span', null, fmt('variantsCount', { count: component.variants })) : null,
            ),
            h('div', { className: 'dc-card-meta' },
              h('button', { type: 'button', className: 'dc-btn', onClick: (event) => { event.stopPropagation(); onInstantiate(component.key) } }, t('componentPlace')),
              h('button', { type: 'button', className: 'dc-btn', onClick: (event) => { event.stopPropagation(); onFocus(component.key) } }, t('componentFindShort')),
              h('button', { type: 'button', className: 'dc-btn dc-btn-danger', onClick: (event) => { event.stopPropagation(); onDelete(component.key) } }, t('componentDelete')),
            ),
          ))),
      )
    }

    // ----------------------------------------------------------- TokensPanel ----

    /** Редактор плоских токенов холста. */
    function TokensPanel(props) {
      const { t, draft, baseline, onEdit, onApply, onRevert, busy } = props
      const groups = useMemo(() => tokenTree(draft), [draft])
      const changed = useMemo(() => {
        const keys = new Set([...Object.keys(draft ?? {}), ...Object.keys(baseline ?? {})])
        for (const key of keys) {
          if (String(draft?.[key]) !== String(baseline?.[key])) return true
        }
        return false
      }, [draft, baseline])
      const order = useMemo(() => {
        const names = [...groups.keys()]
        names.sort((a, b) => {
          const indexA = TOKEN_GROUP_ORDER.indexOf(a)
          const indexB = TOKEN_GROUP_ORDER.indexOf(b)
          if (indexA === -1 && indexB === -1) return a.localeCompare(b)
          if (indexA === -1) return 1
          if (indexB === -1) return -1
          return indexA - indexB
        })
        return names
      }, [groups])

      if (order.length === 0) return h('div', { className: 'dc-empty' }, t('tokensEmpty'))

      return h('div', null,
        h('div', { className: 'dc-left-tools' },
          h('button', { type: 'button', className: 'dc-btn dc-btn-primary', disabled: busy || !changed, onClick: onApply }, t('tokensApply')),
          h('button', { type: 'button', className: 'dc-btn', disabled: !changed, onClick: onRevert }, t('tokensRevert')),
        ),
        h('div', { className: 'dc-muted', style: { fontSize: 11, marginBottom: 8 } }, t('tokensHint')),
        order.map((group) => h('div', { key: group, className: 'dc-token-group' },
          h('div', { className: 'dc-token-head' },
            h('span', { className: 'dc-token-name' }, group),
            h('span', { className: 'dc-chip' }, String(groups.get(group).size)),
          ),
          [...groups.get(group).values()].map((entry) => {
            const subs = [...entry.subs.entries()]
            if (subs.length === 0) {
              const kind = tokenKind(group, entry.name, entry.value)
              if (kind === 'color') {
                return h(ColorField, {
                  key: entry.path,
                  label: entry.name,
                  value: entry.value,
                  tokens: draft,
                  t,
                  onChange: (next) => onEdit(entry.path, next),
                })
              }
              if (kind === 'number') {
                return h(NumberField, {
                  key: entry.path,
                  label: entry.name,
                  value: entry.value,
                  onChange: (next) => onEdit(entry.path, next),
                })
              }
              return h(TextField, {
                key: entry.path,
                label: entry.name,
                value: entry.value,
                onChange: (next) => onEdit(entry.path, next),
              })
            }
            return h('div', { key: entry.path, style: { marginBottom: 6 } },
              h('div', { className: 'dc-field-label', style: { marginBottom: 3 } }, entry.name),
              h('div', { className: 'dc-token-sub' }, subs.map(([sub, value]) => {
                const path = `${entry.path}.${sub}`
                const kind = tokenKind(group, sub, value)
                if (kind === 'color') {
                  return h(ColorField, {
                    key: path,
                    label: sub,
                    value,
                    tokens: draft,
                    t,
                    onChange: (next) => onEdit(path, next),
                  })
                }
                if (kind === 'number') {
                  return h(NumberField, { key: path, label: sub, value, onChange: (next) => onEdit(path, next) })
                }
                return h(TextField, { key: path, label: sub, value, onChange: (next) => onEdit(path, next) })
              })),
            )
          }),
        )),
      )
    }

    // ----------------------------------------------------------- Inspector ----

    /** Общее значение поля у нескольких узлов. */
    function commonValue(nodes, path) {
      if (nodes.length === 0) return undefined
      const first = getPath(nodes[0], path)
      for (const node of nodes) {
        const value = getPath(node, path)
        if (isPlainObject(value) || isPlainObject(first)) {
          if (JSON.stringify(value) !== JSON.stringify(first)) return undefined
          continue
        }
        if (value !== first) return undefined
      }
      return first
    }

    /**
     * Инспектор выделения: геометрия, заливка/обводка/тень, раскладка, текст,
     * параметры инстанса. Для нескольких узлов общие поля применяются ко всем.
     */
    function Inspector(props) {
      const {
        t, fmt, doc, tokens, components, selection, onPatch, onDetach, onOverride, onSelect,
        onAlign, onDistribute, onResetOverride, onResetAll, onPush, onSwap, onVariant,
      } = props
      const nodes = useMemo(
        () => selection.map((id) => findNode(doc?.root, id)).filter(Boolean),
        [selection, doc],
      )
      if (nodes.length === 0) {
        return h('div', null,
          h('div', { className: 'dc-section-title' }, t('inspector')),
          h('div', { className: 'dc-empty' }, t('selectNodeHint')),
        )
      }

      const ids = nodes.map((node) => node.id)
      const one = nodes[0]
      const many = nodes.length > 1
      const tokenPaths = Object.keys(tokens ?? {})
      const textTokens = tokenPaths.filter((path) => path.startsWith('text.') && isPlainObject(tokens[path])).sort()
      const patch = (value) => onPatch(ids, value)
      const patchLayout = (value) => (isInstance ? styleWrite(value) : onPatch(ids, value, { relayout: true }))

      // У инстанса собственные `style`, `layout` и `text` ничего не значат:
      // внешний вид и раскладка приходят из шаблона компонента. Инспектор
      // читает развёрнутый корень, а правки пишет переопределениями-путями —
      // их одинаково применяют `applyOverrides` на клиенте и на сервере.
      const isInstance = !many && one.type === 'instance'
      const styleSource = isInstance ? (expandInstance(doc, one) ?? one) : one
      const styleNodes = isInstance ? [styleSource] : nodes
      const styleWrite = (value) => {
        if (!isInstance) {
          patch(value)
          return
        }
        for (const [path, item] of flattenPatch(value)) onOverride(one.id, path, item)
      }

      const fillValue = commonValue(styleNodes, 'style.fill')
      const stroke = commonValue(styleNodes, 'style.stroke')
      const shadow = commonValue(styleNodes, 'style.shadow')
      const padding = commonValue(styleNodes, 'layout.padding') ?? { t: 0, r: 0, b: 0, l: 0 }

      // `style.stroke` и `style.shadow` — вложенные объекты, а патч сливается по
      // ключам верхнего уровня: собираем объект целиком, иначе поля потеряются.
      const patchStroke = (delta) => styleWrite({
        style: { stroke: { color: stroke?.color ?? null, width: num(stroke?.width, 1), ...delta } },
      })
      const patchShadow = (delta) => styleWrite({
        style: {
          shadow: {
            x: num(shadow?.x, 0),
            y: num(shadow?.y, 0),
            blur: num(shadow?.blur, 0),
            spread: num(shadow?.spread, 0),
            color: shadow?.color ?? null,
            ...delta,
          },
        },
      })

      return h('div', null,
        h('div', { className: 'dc-section-title' }, t('inspector')),
        many ? h('div', { className: 'dc-muted', style: { marginBottom: 8, fontSize: 11 } }, fmt('multiHint', { count: nodes.length })) : null,
        many ? h(AlignSection, { t, count: nodes.length, onAlign, onDistribute }) : null,

        h(Section, { title: t('sectionGeometry') },
          h('div', { className: 'dc-grid' },
            h(NumberField, { label: t('x'), value: commonValue(nodes, 'x'), onChange: (value) => patch({ x: num(value, 0) }) }),
            h(NumberField, { label: t('y'), value: commonValue(nodes, 'y'), onChange: (value) => patch({ y: num(value, 0) }) }),
            h(NumberField, { label: t('w'), value: commonValue(nodes, 'w'), min: 0, onChange: (value) => patch({ w: Math.max(MIN_SIZE, num(value, MIN_SIZE)) }) }),
            h(NumberField, { label: t('h'), value: commonValue(nodes, 'h'), min: 0, onChange: (value) => patch({ h: Math.max(MIN_SIZE, num(value, MIN_SIZE)) }) }),
            h(NumberField, { label: t('rotation'), value: commonValue(nodes, 'rotation'), onChange: (value) => patch({ rotation: num(value, 0) }) }),
            h(NumberField, {
              label: t('opacity'),
              value: commonValue(styleNodes, 'style.opacity'),
              step: 0.05,
              min: 0,
              onChange: (value) => styleWrite({ style: { opacity: clamp(num(value, 1), 0, 1) } }),
            }),
          ),
        ),

        isInstance
          ? h('div', { className: 'dc-muted', style: { marginBottom: 8, fontSize: 11 } }, t('instanceOverrideHint'))
          : null,

        h(Section, { title: t('sectionFill') },
          h(ColorField, { label: t('fill'), value: fillValue, tokens, t, onChange: (value) => styleWrite({ style: { fill: value } }) }),
          h('label', { className: 'dc-check', style: { margin: '6px 0 4px' } },
            h('input', {
              type: 'checkbox',
              checked: Boolean(stroke),
              onChange: (event) => styleWrite({
                style: { stroke: event.target.checked ? { color: '#8a94a6', width: 1 } : null },
              }),
            }),
            t('strokeOn'),
          ),
          stroke ? h('div', null,
            h(ColorField, {
              label: t('strokeColor'),
              value: stroke.color,
              tokens,
              t,
              onChange: (value) => patchStroke({ color: value }),
            }),
            h('div', { style: { marginTop: 6 } },
              h(NumberField, {
                label: t('strokeWidth'),
                value: stroke.width,
                min: 0,
                step: 0.5,
                onChange: (value) => patchStroke({ width: Math.max(0, num(value, 1)) }),
              }),
            ),
          ) : null,
          h('div', { style: { marginTop: 6 } },
            h(NumberField, {
              label: t('radius'),
              value: commonValue(styleNodes, 'style.radius'),
              min: 0,
              onChange: (value) => styleWrite({ style: { radius: Math.max(0, num(value, 0)) } }),
            }),
          ),
        ),

        h(Section, { title: t('sectionShadow') },
          h('label', { className: 'dc-check', style: { marginBottom: 4 } },
            h('input', {
              type: 'checkbox',
              checked: Boolean(shadow),
              onChange: (event) => styleWrite({
                style: { shadow: event.target.checked ? { x: 0, y: 8, blur: 24, spread: 0, color: 'rgba(0,0,0,0.45)' } : null },
              }),
            }),
            t('shadowOn'),
          ),
          shadow ? h('div', null,
            h('div', { className: 'dc-grid' },
              h(NumberField, { label: t('shadowX'), value: shadow.x, onChange: (value) => patchShadow({ x: num(value, 0) }) }),
              h(NumberField, { label: t('shadowY'), value: shadow.y, onChange: (value) => patchShadow({ y: num(value, 0) }) }),
              h(NumberField, { label: t('blur'), value: shadow.blur, min: 0, onChange: (value) => patchShadow({ blur: Math.max(0, num(value, 0)) }) }),
              h(NumberField, { label: t('spread'), value: shadow.spread, onChange: (value) => patchShadow({ spread: num(value, 0) }) }),
            ),
            h('div', { style: { marginTop: 6 } },
              h(ColorField, {
                label: t('color'),
                value: shadow.color,
                tokens,
                t,
                onChange: (value) => patchShadow({ color: value }),
              }),
            ),
          ) : null,
        ),

        h(Section, { title: t('sectionLayout') },
          h(SelectField, {
            label: t('layoutMode'),
            value: commonValue(styleNodes, 'layout.mode') ?? 'none',
            options: [
              { value: 'none', label: t('layoutNone') },
              { value: 'vertical', label: t('layoutVertical') },
              { value: 'horizontal', label: t('layoutHorizontal') },
            ],
            onChange: (value) => patchLayout({ layout: { mode: value } }),
          }),
          h('div', { style: { marginTop: 6 } },
            h(NumberField, {
              label: t('gap'),
              value: commonValue(styleNodes, 'layout.gap'),
              min: 0,
              onChange: (value) => patchLayout({ layout: { gap: Math.max(0, num(value, 0)) } }),
            }),
          ),
          h('div', { style: { marginTop: 6 } },
            h('div', { className: 'dc-field-label', style: { marginBottom: 3 } }, t('padding')),
            h('div', { className: 'dc-grid-4' },
              h(NumberField, { label: t('padTop'), value: padding.t, min: 0, onChange: (value) => patchLayout({ layout: { padding: { t: Math.max(0, num(value, 0)) } } }) }),
              h(NumberField, { label: t('padRight'), value: padding.r, min: 0, onChange: (value) => patchLayout({ layout: { padding: { r: Math.max(0, num(value, 0)) } } }) }),
              h(NumberField, { label: t('padBottom'), value: padding.b, min: 0, onChange: (value) => patchLayout({ layout: { padding: { b: Math.max(0, num(value, 0)) } } }) }),
              h(NumberField, { label: t('padLeft'), value: padding.l, min: 0, onChange: (value) => patchLayout({ layout: { padding: { l: Math.max(0, num(value, 0)) } } }) }),
            ),
          ),
          h('div', { style: { marginTop: 6 } },
            h(SelectField, {
              label: t('align'),
              value: commonValue(styleNodes, 'layout.align') ?? 'start',
              options: [
                { value: 'start', label: t('alignStart') },
                { value: 'center', label: t('alignCenter') },
                { value: 'end', label: t('alignEnd') },
                { value: 'stretch', label: t('alignStretch') },
              ],
              onChange: (value) => patchLayout({ layout: { align: value } }),
            }),
          ),
          h('div', { style: { marginTop: 6 } },
            h(SelectField, {
              label: t('justify'),
              value: commonValue(styleNodes, 'layout.justify') ?? 'start',
              options: [
                { value: 'start', label: t('justifyStart') },
                { value: 'center', label: t('justifyCenter') },
                { value: 'end', label: t('justifyEnd') },
                { value: 'space-between', label: t('justifyBetween') },
              ],
              onChange: (value) => patchLayout({ layout: { justify: value } }),
            }),
          ),
        ),

        styleNodes.some((node) => node.type === 'text')
          ? h(Section, { title: t('sectionText') },
            h('div', { className: 'dc-field' },
              h('span', { className: 'dc-field-label' }, t('textValue')),
              h('textarea', {
                className: 'dc-textarea',
                value: String(commonValue(styleNodes.filter((node) => node.type === 'text'), 'text.value') ?? ''),
                onChange: (event) => styleWrite({ text: { value: event.target.value } }),
              }),
            ),
            h('div', { style: { marginTop: 6 } },
              h(SelectField, {
                label: t('textToken'),
                value: commonValue(styleNodes, 'text.token') ?? '',
                allowEmpty: true,
                options: textTokens.map((path) => ({ value: path, label: path })),
                onChange: (value) => styleWrite({ text: { token: value === '' ? null : value } }),
              }),
            ),
            h('div', { className: 'dc-grid', style: { marginTop: 6 } },
              h(SelectField, {
                label: t('textAlign'),
                value: commonValue(styleNodes, 'text.align') ?? 'left',
                options: [
                  { value: 'left', label: t('alignLeft') },
                  { value: 'center', label: t('alignCenter') },
                  { value: 'right', label: t('alignRight') },
                  { value: 'justify', label: t('alignJustify') },
                ],
                onChange: (value) => styleWrite({ text: { align: value } }),
              }),
              h(SelectField, {
                label: t('textValign'),
                value: commonValue(styleNodes, 'text.valign') ?? 'top',
                options: [
                  { value: 'top', label: t('valignTop') },
                  { value: 'middle', label: t('valignMiddle') },
                  { value: 'bottom', label: t('valignBottom') },
                ],
                onChange: (value) => styleWrite({ text: { valign: value } }),
              }),
            ),
            h('div', { style: { marginTop: 6 } },
              h(ColorField, {
                label: t('color'),
                value: commonValue(styleNodes, 'text.color'),
                tokens,
                t,
                onChange: (value) => styleWrite({ text: { color: value } }),
              }),
            ),
            h('div', { className: 'dc-grid', style: { marginTop: 6 } },
              h(NumberField, { label: t('fontSize'), value: commonValue(styleNodes, 'text.size'), min: 1, onChange: (value) => styleWrite({ text: { size: value === null ? null : Math.max(1, num(value, 14)) } }) }),
              h(NumberField, { label: t('fontWeight'), value: commonValue(styleNodes, 'text.weight'), step: 50, min: 100, onChange: (value) => styleWrite({ text: { weight: value === null ? null : num(value, 400) } }) }),
              h(NumberField, { label: t('lineHeight'), value: commonValue(styleNodes, 'text.lineHeight'), step: 0.05, onChange: (value) => styleWrite({ text: { lineHeight: value } }) }),
              h(NumberField, { label: t('letterSpacing'), value: commonValue(styleNodes, 'text.letterSpacing'), step: 0.1, onChange: (value) => styleWrite({ text: { letterSpacing: value } }) }),
            ),
          )
          : null,

        one.type === 'instance' || one.component
          ? h(InstanceSection, {
            t,
            fmt,
            doc,
            tokens,
            instance: one,
            components,
            onDetach,
            onOverride,
            onResetOverride,
            onResetAll,
            onPush,
            onSwap,
            onVariant,
            onSelect,
          })
          : null,
      )
    }

    /**
     * Секция инспектора для инстанса: компонент, объявленные параметры,
     * переопределения и действия над ними.
     *
     * Переопределение помечается и сбрасывается по одному: раньше было видно
     * только действующее значение, и отличить правку инстанса от значения
     * шаблона было нельзя — а «сбросить всё» приходилось правкой файла.
     */
    function InstanceSection(props) {
      const {
        t, fmt, doc, tokens, instance, components,
        onDetach, onOverride, onResetOverride, onResetAll, onPush, onSwap, onSelect, onVariant,
      } = props
      const component = (components ?? []).find((item) => item.key === instance.component)
      const specs = componentProps(component, instance.variant)
      // Вариации берутся из документа: сводка библиотеки несёт только их число.
      const variants = Object.entries(doc?.components?.[instance.component]?.variants ?? {})
      const overrides = isPlainObject(instance.overrides) ? instance.overrides : {}
      const declared = Object.keys(specs)
      const extra = Object.keys(overrides).filter((name) => !declared.includes(name))

      const fieldFor = (name, spec) => {
        const value = effectivePropValue(doc, component, instance, name, spec)
        const label = spec.description ? `${name} — ${spec.description}` : name
        if (spec.type === 'boolean') {
          return h('label', { className: 'dc-check' },
            h('input', {
              type: 'checkbox',
              checked: value === true,
              onChange: (event) => onOverride(instance.id, name, event.target.checked),
            }),
            label)
        }
        if (spec.type === 'number') {
          return h(NumberField, { label, value, onChange: (next) => onOverride(instance.id, name, num(next, 0)) })
        }
        if (spec.type === 'color') {
          return h(ColorField, { label, value, tokens, t, onChange: (next) => onOverride(instance.id, name, next) })
        }
        return h(TextField, {
          label,
          value,
          onChange: (next) => onOverride(instance.id, name, spec.type === 'token'
            ? (String(next).startsWith('token:') ? next : `token:${next}`)
            : next),
        })
      }

      return h(Section, { title: t('sectionInstance') },
        h('div', { className: 'dc-field' },
          h('span', { className: 'dc-field-label' }, t('instanceComponent')),
          h('div', { className: 'dc-field-row' },
            h('span', { className: 'dc-link', onClick: () => onSelect(instance.component) }, instance.component || '—'),
            h('span', { className: 'dc-spacer' }),
            h('button', { type: 'button', className: 'dc-btn', onClick: () => onDetach(instance.id) }, t('detach')),
          ),
        ),
        variants.length > 0
          ? h('div', { style: { marginTop: 6 } },
            h(SelectField, {
              label: t('instanceVariant'),
              value: instance.variant ?? '',
              allowEmpty: true,
              options: variants.map(([name, spec]) => ({ value: name, label: spec.name ?? name })),
              onChange: (value) => onVariant(instance.id, value),
            }))
          : null,
        (components ?? []).length > 1
          ? h('div', { style: { marginTop: 6 } },
            h(SelectField, {
              label: t('instanceSwap'),
              value: instance.component,
              options: (components ?? []).map((item) => ({ value: item.key, label: item.name ?? item.key })),
              onChange: (value) => onSwap(instance.id, value),
            }))
          : null,
        component ? null : h('div', { className: 'dc-warn', style: { marginTop: 6, fontSize: 11 } }, t('instanceMissing')),
        declared.length === 0 && extra.length === 0
          ? h('div', { className: 'dc-muted', style: { marginTop: 6, fontSize: 11 } }, t('propsEmpty'))
          : h('div', { style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 } },
            declared.map((name) => {
              const spec = specs[name]
              const changed = overrides[name] !== undefined
              return h('div', { key: name, className: 'dc-prop-row' },
                fieldFor(name, spec),
                changed
                  ? h('div', { className: 'dc-field-row', style: { marginTop: 2 } },
                    h('span', { className: 'dc-chip dc-chip-brand' }, t('overridden')),
                    h('span', { className: 'dc-spacer' }),
                    h('button', {
                      type: 'button',
                      className: 'dc-icon-btn',
                      title: t('resetOverride'),
                      onClick: () => onResetOverride(instance.id, name),
                    }, '↺'),
                  )
                  : null,
              )
            }),
            extra.length > 0
              ? h('div', null,
                h('div', { className: 'dc-field-label', style: { marginBottom: 3 } }, t('overridesRaw')),
                h('div', { className: 'dc-card-meta' }, extra.map((name) => h('span', { key: name, className: 'dc-chip' },
                  `${name}: ${JSON.stringify(overrides[name])}`))),
              )
              : null,
          ),
        h('div', { className: 'dc-left-tools', style: { marginTop: 6 } },
          Object.keys(overrides).length > 0
            ? h('button', { type: 'button', className: 'dc-btn', onClick: () => onResetAll(instance.id) }, t('resetOverrides'))
            : null,
          h('button', { type: 'button', className: 'dc-btn', onClick: () => onPush(instance.id) }, t('pushToComponent')),
        ),
      )
    }

    // ---------------------------------------------------------- ContextMenu ----

    /**
     * Контекстное меню: те же действия, что и горячими клавишами, но видимые —
     * иначе их пришлось бы искать в дереве слоёв и инспекторе.
     *
     * Закрывается по любому нажатию вне себя, по Escape (слушатель панели) и по
     * выбору пункта. Позиция ограничивается окном, чтобы меню не уезжало за край.
     */
    function ContextMenu({ menu, onClose }) {
      useEffect(() => {
        if (!menu) return undefined
        const close = () => onClose()
        window.addEventListener('mousedown', close)
        window.addEventListener('blur', close)
        return () => {
          window.removeEventListener('mousedown', close)
          window.removeEventListener('blur', close)
        }
      }, [menu, onClose])
      if (!menu) return null
      return h('div', {
        className: 'dc-menu',
        style: { left: `${menu.x}px`, top: `${menu.y}px` },
        role: 'menu',
        onMouseDown: (event) => event.stopPropagation(),
        onContextMenu: (event) => event.preventDefault(),
      }, menu.items.map((item, index) => (item.separator
        ? h('div', { key: `sep-${index}`, className: 'dc-menu-sep' })
        : h('button', {
          key: item.id,
          type: 'button',
          className: 'dc-menu-item',
          role: 'menuitem',
          disabled: item.disabled === true,
          onClick: () => { onClose(); item.run() },
        },
          h('span', { className: 'dc-menu-label' }, item.label),
          item.hint ? h('span', { className: 'dc-menu-hint' }, item.hint) : null,
        ))))
    }

    // ----------------------------------------------------------- AlignSection ----

    /**
     * Выравнивание и распределение выделения.
     *
     * Те же шесть режимов и две оси, что у операций `align` / `distribute`.
     * Арифметика повторена в панели сознательно: она правит документ локально,
     * поэтому выравнивание мгновенно и попадает в историю undo — round-trip
     * через `/apply` стоил бы и задержки, и всей истории правок.
     */
    function AlignSection({ t, count, onAlign, onDistribute }) {
      const axes = [
        { id: 'left', glyph: '←' },
        { id: 'center', glyph: '↔' },
        { id: 'right', glyph: '→' },
        { id: 'top', glyph: '↑' },
        { id: 'middle', glyph: '↕' },
        { id: 'bottom', glyph: '↓' },
      ]
      const titles = {
        left: t('alignLeft'),
        center: t('alignCenter'),
        right: t('alignRight'),
        top: t('valignTop'),
        middle: t('valignMiddle'),
        bottom: t('valignBottom'),
      }
      return h(Section, { title: t('sectionAlign') },
        h('div', { className: 'dc-align-grid' }, axes.map((item) => h('button', {
          key: item.id,
          type: 'button',
          className: 'dc-btn dc-btn-flat',
          title: `${titles[item.id]} (${count})`,
          'aria-label': titles[item.id],
          onClick: () => onAlign(item.id),
        }, item.glyph))),
        h('div', { className: 'dc-align-grid', style: { marginTop: 4 } },
          h('button', {
            type: 'button',
            className: 'dc-btn dc-btn-flat',
            title: t('distributeX'),
            disabled: count < 3,
            onClick: () => onDistribute('x'),
          }, '≡ ↔'),
          h('button', {
            type: 'button',
            className: 'dc-btn dc-btn-flat',
            title: t('distributeY'),
            disabled: count < 3,
            onClick: () => onDistribute('y'),
          }, '≡ ↕'),
        ),
      )
    }

    // ------------------------------------------------------------- NodeView ----

    /**
     * Узел документа как вложенные absolute-дивы.
     *
     * Геометрия — из `x/y/w/h` относительно родителя, заливка/обводка/тень — из
     * токенов холста. Каждый узел помечен `data-node-id`: по нему вьюпорт делает
     * hit-test кликов и перетаскиваний.
     */
    function NodeView({ node, tokens, selection }) {
      if (node.visible === false) return null
      const box = nodeBoxStyle(node, tokens)
      const selected = selection.includes(baseId(node.id))
      const className = `dc-node${selected ? ' dc-node-selected' : ''}`
      const common = { key: node.id, className, 'data-node-id': node.id, style: box, title: node.name }

      if (node.type === 'text') {
        return h('div', { ...common, style: { ...box, display: 'flex', alignItems: textAlignItems(node) } },
          h('div', { className: 'dc-node-text-inner', style: nodeTextStyle(node, tokens) }, String(node.text?.value ?? '')),
        )
      }

      if (node.type === 'image') {
        const src = typeof node.image?.src === 'string' ? node.image.src : ''
        return h('div', common,
          src === ''
            ? h('div', { className: 'dc-img-empty' }, 'image')
            : h('img', {
              src,
              alt: node.name,
              draggable: false,
              style: { width: '100%', height: '100%', objectFit: node.image?.fit ?? 'cover', display: 'block' },
            }),
        )
      }

      const children = Array.isArray(node.children) ? node.children : []
      return h('div', common,
        children.map((child) => h(NodeView, { key: child.id, node: child, tokens, selection })),
      )
    }

    // ------------------------------------------------------------ Rulers ----

    /**
     * Линейки вьюпорта: штрихи в мировых координатах и подписи через каждые
     * десять штрихов.
     *
     * Тянуть из линейки — создать направляющую: из верхней горизонтальную
     * (`y`), из левой вертикальную (`x`). Шаг штрихов выбирается так, чтобы на
     * экране между ними было не меньше восьми пикселей, поэтому число штрихов
     * не растёт вместе с масштабом.
     */
    function Rulers({ t, view, size, onStartGuide }) {
      const zoom = num(view?.zoom, 1)
      const step = rulerStep(zoom)
      /** Штрихи одной оси: `length` — размер вьюпорта, `offset` — сдвиг вида. */
      const ticks = (length, offset, axis) => {
        const out = []
        const start = Math.floor((-offset / zoom) / step) * step
        const end = (length - offset) / zoom
        for (let value = start; value <= end; value += step) {
          const screen = offset + value * zoom
          const major = Math.abs(value % (step * 10)) < 1e-6
          out.push(h('div', {
            key: `${axis}-${Math.round(value * 100)}`,
            className: `dc-tick${major ? ' dc-tick-major' : ''}`,
            style: axis === 'x' ? { left: `${screen}px` } : { top: `${screen}px` },
          }, major ? h('span', { className: 'dc-tick-label' }, String(Math.round(value))) : null))
        }
        return out
      }
      return [
        h('div', { key: 'corner', className: 'dc-ruler-corner', style: { width: RULER_SIZE, height: RULER_SIZE } }),
        h('div', {
          key: 'top',
          className: 'dc-ruler dc-ruler-top',
          'data-ruler': 'y',
          title: t('guidesHint'),
          onMouseDown: (event) => { event.preventDefault(); onStartGuide('y') },
        }, ticks(size.w, num(view?.x, 0), 'x')),
        h('div', {
          key: 'left',
          className: 'dc-ruler dc-ruler-left',
          'data-ruler': 'x',
          onMouseDown: (event) => { event.preventDefault(); onStartGuide('x') },
        }, ticks(size.h, num(view?.y, 0), 'y')),
      ]
    }

    // ------------------------------------------------------------ OverlayLayer ----

    /**
     * Экранный слой разметки: наведение с цепочкой предков, замеры отступов,
     * динамичные направляющие привязки и статичные линии пользователя.
     *
     * Рисуется вне `.dc-world`, поэтому толщина линий и кегль подписей не
     * зависят от масштаба, а текст не мылится. Слой прозрачен для мыши, кроме
     * зон захвата самих направляющих: иначе он перехватывал бы выбор узлов.
     */
    function OverlayLayer(props) {
      const { view, ctx, hover, measure, padZones, snap, guides, guideDrag, onGuideStart, onGuideRemove, marks } = props
      const zoom = num(view?.zoom, 1)
      const sx = (value) => num(view?.x, 0) + value * zoom
      const sy = (value) => num(view?.y, 0) + value * zoom
      const nodes = []

      // --- направляющие пользователя: линия 1px внутри зоны захвата 7px
      for (const axis of ['x', 'y']) {
        for (const value of guides?.[axis] ?? []) {
          const active = guideDrag?.axis === axis && guideDrag?.value === value
          const base = axis === 'x' ? sx(value) : sy(value)
          nodes.push(h('div', {
            key: `guide-${axis}-${value}`,
            className: `dc-guide dc-guide-${axis}${active ? ' dc-guide-active' : ''}`,
            style: axis === 'x' ? { left: `${base - 3}px` } : { top: `${base - 3}px` },
            title: `${Math.round(value)}`,
            onMouseDown: (event) => { event.stopPropagation(); onGuideStart(axis, value) },
            onDoubleClick: (event) => { event.stopPropagation(); onGuideRemove(axis, value) },
          }, h('div', { className: 'dc-guide-line', style: { background: OVERLAY_COLOR.guide } })))
        }
      }

      // --- наведение: обводка узла под курсором и приглушённые обводки предков
      if (hover && Array.isArray(hover.chain)) {
        hover.chain.forEach((id, depth) => {
          const rect = ctx.rects.get(id)
          const node = ctx.nodes.get(id)
          if (!rect || !node || id === 'root' || (rect.w <= 0 && rect.h <= 0)) return
          const tone = depth === 0 ? OVERLAY_COLOR.hover : OVERLAY_COLOR.ancestor
          nodes.push(h('div', {
            key: `hover-${id}`,
            className: 'dc-ov-box',
            style: {
              left: `${sx(rect.x)}px`,
              top: `${sy(rect.y)}px`,
              width: `${Math.max(0, rect.w * zoom)}px`,
              height: `${Math.max(0, rect.h * zoom)}px`,
              outlineColor: tone,
              opacity: depth === 0 ? 1 : Math.max(0.3, 0.75 - depth * 0.12),
            },
          }))
          // Подпись наведённого узла выравнивается по его правому верхнему углу,
          // подписи предков — по левому нижнему. Так они не накладываются ни друг
          // на друга (у вложенных узлов верхние углы стоят вплотную из-за
          // padding), ни на `.dc-frame-label` верхнего фрейма, которая стоит
          // слева над своим фреймом. У самих верхних фреймов подписи нет.
          const topFrame = ctx.parents.get(id) === 'root'
          if (depth === 0 || !topFrame) {
            nodes.push(h('div', {
              key: `hover-label-${id}`,
              className: `dc-ov-label${depth === 0 ? ' dc-ov-label-end' : ''}`,
              style: depth === 0
                ? { left: `${sx(rect.x + rect.w)}px`, top: `${sy(rect.y)}px`, background: tone }
                : { left: `${sx(rect.x)}px`, top: `${sy(rect.y + rect.h)}px`, background: tone },
            }, depth === 0
              ? `${node.name} · ${Math.round(rect.w)}×${Math.round(rect.h)}`
              : node.name))
          }
        })
      }

      // --- контейнер, в который «вошли»: пунктирная рамка на весь экран
      const entered = props.enteredId ? ctx.rects.get(props.enteredId) : null
      if (entered) {
        nodes.push(h('div', {
          key: 'entered',
          className: 'dc-ov-enter',
          style: {
            left: `${sx(entered.x)}px`,
            top: `${sy(entered.y)}px`,
            width: `${Math.max(0, entered.w * zoom)}px`,
            height: `${Math.max(0, entered.h * zoom)}px`,
          },
        }))
      }

      // --- подсветка узлов из панели компонентов: все инстансы компонента
      for (const id of marks ?? []) {
        if (hover && hover.id === id) continue
        const rect = ctx.rects.get(id)
        if (!rect) continue
        nodes.push(h('div', {
          key: `mark-${id}`,
          className: 'dc-ov-box dc-ov-mark',
          style: {
            left: `${sx(rect.x)}px`,
            top: `${sy(rect.y)}px`,
            width: `${Math.max(0, rect.w * zoom)}px`,
            height: `${Math.max(0, rect.h * zoom)}px`,
            outlineColor: OVERLAY_COLOR.measure,
          },
        }))
      }

      // --- padding контейнера: четыре подложки вокруг его содержимого
      for (const zone of padZones ?? []) {
        if (zone.w <= 0 || zone.h <= 0) continue
        nodes.push(h('div', {
          key: `pad-${zone.key ?? `${zone.x},${zone.y}`}`,
          className: 'dc-ov-pad',
          style: {
            left: `${sx(zone.x)}px`,
            top: `${sy(zone.y)}px`,
            width: `${zone.w * zoom}px`,
            height: `${zone.h * zoom}px`,
            background: OVERLAY_COLOR.pad,
          },
        }))
      }

      // --- замеры: отступы до рамки родителя и до соседей
      if (measure) {
        const rect = measure.rect
        const box = measure.box
        const line = (axis, at, from, to, key) => {
          const length = `${Math.max(1, Math.abs(to - from) * zoom)}px`
          return axis === 'x'
            ? h('div', { key, className: 'dc-ov-line', style: { left: `${sx(Math.min(from, to))}px`, top: `${sy(at)}px`, width: length, background: OVERLAY_COLOR.measure } })
            : h('div', { key, className: 'dc-ov-line', style: { left: `${sx(at)}px`, top: `${sy(Math.min(from, to))}px`, height: length, background: OVERLAY_COLOR.measure } })
        }
        const pill = (key, x, y, text, tone = OVERLAY_COLOR.measure) => h('div', {
          key,
          className: 'dc-ov-pill',
          style: { left: `${sx(x)}px`, top: `${sy(y)}px`, background: tone },
        }, text)
        const show = (value) => Math.abs(value) >= 0.5
        const round = (value) => String(Math.round(value))
        if (show(measure.gaps.left)) {
          const at = rect.y + rect.h / 2
          nodes.push(line('x', at, box.x, rect.x, 'gap-l'))
          nodes.push(pill('gap-l-p', (box.x + rect.x) / 2, at, round(measure.gaps.left)))
        }
        if (show(measure.gaps.right)) {
          const at = rect.y + rect.h / 2
          nodes.push(line('x', at, rect.x + rect.w, box.x + box.w, 'gap-r'))
          nodes.push(pill('gap-r-p', (rect.x + rect.w + box.x + box.w) / 2, at, round(measure.gaps.right)))
        }
        if (show(measure.gaps.top)) {
          const at = rect.x + rect.w / 2
          nodes.push(line('y', at, box.y, rect.y, 'gap-t'))
          nodes.push(pill('gap-t-p', at, (box.y + rect.y) / 2, round(measure.gaps.top)))
        }
        if (show(measure.gaps.bottom)) {
          const at = rect.x + rect.w / 2
          nodes.push(line('y', at, rect.y + rect.h, box.y + box.h, 'gap-b'))
          nodes.push(pill('gap-b-p', at, (rect.y + rect.h + box.y + box.h) / 2, round(measure.gaps.bottom)))
        }
        for (const side of ['left', 'right', 'top', 'bottom']) {
          const neighbor = measure.neighbors[side]
          if (!neighbor || !show(neighbor.gap)) continue
          const other = neighbor.rect
          if (side === 'left') {
            nodes.push(line('x', neighbor.at, other.x + other.w, rect.x, `n-${side}`))
            nodes.push(pill(`n-${side}-p`, (other.x + other.w + rect.x) / 2, neighbor.at, round(neighbor.gap)))
          } else if (side === 'right') {
            nodes.push(line('x', neighbor.at, rect.x + rect.w, other.x, `n-${side}`))
            nodes.push(pill(`n-${side}-p`, (rect.x + rect.w + other.x) / 2, neighbor.at, round(neighbor.gap)))
          } else if (side === 'top') {
            nodes.push(line('y', neighbor.at, other.y + other.h, rect.y, `n-${side}`))
            nodes.push(pill(`n-${side}-p`, neighbor.at, (other.y + other.h + rect.y) / 2, round(neighbor.gap)))
          } else {
            nodes.push(line('y', neighbor.at, rect.y + rect.h, other.y, `n-${side}`))
            nodes.push(pill(`n-${side}-p`, neighbor.at, (rect.y + rect.h + other.y) / 2, round(neighbor.gap)))
          }
        }
      }

      // --- линии привязки: совпавшие края, центры и направляющие
      // Две соседки могут дать линии с одной координатой и видом, поэтому в ключе
      // есть порядковый номер: иначе React ругается на повтор ключа и теряет узел.
      for (const [index, item] of (snap?.lines ?? []).entries()) {
        const tone = item.kind === 'guide' ? OVERLAY_COLOR.guide : OVERLAY_COLOR.measure
        const full = item.from === null || item.to === null
        const key = `snap-${index}-${item.axis}-${item.value}-${item.kind}`
        if (item.axis === 'x') {
          nodes.push(h('div', {
            key,
            className: 'dc-ov-line dc-ov-snap',
            style: {
              left: `${sx(item.value)}px`,
              top: full ? 0 : `${sy(item.from)}px`,
              height: full ? '100%' : `${Math.max(1, (item.to - item.from) * zoom)}px`,
              background: tone,
            },
          }))
        } else {
          nodes.push(h('div', {
            key,
            className: 'dc-ov-line dc-ov-snap',
            style: {
              top: `${sy(item.value)}px`,
              left: full ? 0 : `${sx(item.from)}px`,
              width: full ? '100%' : `${Math.max(1, (item.to - item.from) * zoom)}px`,
              background: tone,
            },
          }))
        }
      }

      // --- превью направляющей, которую сейчас тянут (ещё не в документе)
      if (guideDrag && !(guides?.[guideDrag.axis] ?? []).includes(guideDrag.value)) {
        const base = guideDrag.axis === 'x' ? sx(guideDrag.value) : sy(guideDrag.value)
        nodes.push(h('div', {
          key: 'guide-preview',
          className: `dc-guide-preview dc-guide-preview-${guideDrag.axis}`,
          style: guideDrag.axis === 'x' ? { left: `${base}px` } : { top: `${base}px` },
        }))
      }

      return h('div', { className: 'dc-ov-layer' }, nodes)
    }

    // --------------------------------------------------------- CanvasStage ----

    /**
     * Мир холста: все верхние фреймы подряд, подписи имени и размера, рамка
     * выделения с восемью ручками и превью нового узла при протяжке.
     *
     * Вид применяется здесь же: `.dc-world` сдвигается и масштабируется
     * `transform`, поэтому экранные координаты совпадают с математикой
     * `canvasPoint` (она вычитает `view.x/y` и делит на `zoom`). Размеры
     * оверлеев делятся на `zoom` — ручки и рамки остаются одного размера.
     */
    function CanvasStage(props) {
      const { display, tokens, selection, selectionRects, view, preview } = props
      const zoom = num(view?.zoom, 1)
      const frames = display?.children ?? []
      const content = []
      for (const frame of frames) {
        content.push(h('div', {
          key: `${frame.id}-label`,
          className: 'dc-frame-label',
          style: { left: `${num(frame.x, 0)}px`, top: `${num(frame.y, 0) - 22}px` },
        }, `${frame.name} · ${Math.round(num(frame.w, 0))}×${Math.round(num(frame.h, 0))}`))
        content.push(h(NodeView, { key: frame.id, node: frame, tokens, selection }))
      }
      const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
      const primary = selectionRects.length > 0 ? selectionRects[selectionRects.length - 1] : null
      const handleSize = 8 / zoom
      const outline = 1 / zoom
      return h('div', {
        className: 'dc-world',
        style: { transform: `translate(${num(view?.x, 0)}px, ${num(view?.y, 0)}px) scale(${zoom})` },
      },
        content,
        selectionRects.map((item) => h('div', {
          key: `sel-${item.id}`,
          className: 'dc-sel',
          'data-sel-id': item.id,
          style: {
            left: `${item.rect.x}px`,
            top: `${item.rect.y}px`,
            width: `${item.rect.w}px`,
            height: `${item.rect.h}px`,
            outlineWidth: `${outline}px`,
          },
        })),
        primary
          ? handles.map((handle) => {
            const rect = primary.rect
            const left = handle.includes('w') ? rect.x : handle.includes('e') ? rect.x + rect.w : rect.x + rect.w / 2
            const top = handle.includes('n') ? rect.y : handle.includes('s') ? rect.y + rect.h : rect.y + rect.h / 2
            return h('div', {
              key: `handle-${handle}`,
              className: `dc-handle dc-handle-${handle}`,
              'data-handle': handle,
              style: {
                left: `${left - handleSize / 2}px`,
                top: `${top - handleSize / 2}px`,
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                borderWidth: `${outline}px`,
              },
            })
          })
          : null,
        preview
          ? h('div', {
            className: 'dc-marquee',
            style: {
              left: `${preview.x}px`,
              top: `${preview.y}px`,
              width: `${preview.w}px`,
              height: `${preview.h}px`,
              borderWidth: `${outline}px`,
            },
          })
          : null,
      )
    }

    // ------------------------------------------------------------- Viewport ----

    /**
     * Вьюпорт: pan (средняя кнопка, пробел+мышь или пустое место левой),
     * zoom колесом с Ctrl и кнопками, hit-test узлов, перетаскивание, ресайз
     * восемью ручками, создание узла протяжкой, направляющие пользователя и
     * разметка (наведение, замеры, привязка).
     *
     * Макет рисуется в мировых координатах (`CanvasStage`), разметка — в
     * экранных (`OverlayLayer`): толщина линий и кегль подписей не зависят от
     * масштаба. Оба слоя читают один `view`, поэтому обводка не разъезжается
     * с узлом при pan/zoom.
     */
    function Viewport(props) {
      const {
        t, rootRef, doc, display, tokens, selection, tool, view, onView, onSelect, onGeometry,
        onGeometryStart, onCreate, spaceRef, hoverId, onHoverId, rulers, showGuides, snapEnabled,
        onGuides, onContext, enteredId, onEnter, marks,
      } = props
      const dragRef = useRef(null)
      const viewRef = useRef(view)
      const guidesRef = useRef({ x: [], y: [] })
      const [preview, setPreview] = useState(null)
      const [hovering, setHovering] = useState(false)
      const [snapLines, setSnapLines] = useState([])
      const [guideDrag, setGuideDrag] = useState(null)
      const [altDown, setAltDown] = useState(false)
      const [size, setSize] = useState({ w: 900, h: 600 })
      viewRef.current = view
      guidesRef.current = { x: guidesOf(doc, 'x'), y: guidesOf(doc, 'y') }

      /** Плоская геометрия макета: наведение, замеры и привязка берут её одну. */
      const ctx = useMemo(() => flattenRects(display), [display])

      const selectionRects = useMemo(() => selection
        .map((id) => ({ id, rect: absRect(doc?.root, id) }))
        .filter((item) => item.rect), [selection, doc])

      // --- размер области холста: нужен линейкам и штрихам ---

      useEffect(() => {
        const element = rootRef.current
        if (!element) return undefined
        const update = () => setSize({ w: element.clientWidth, h: element.clientHeight })
        update()
        if (typeof ResizeObserver !== 'function') {
          window.addEventListener('resize', update)
          return () => window.removeEventListener('resize', update)
        }
        const observer = new ResizeObserver(update)
        observer.observe(element)
        return () => observer.disconnect()
      }, [rootRef])

      /** Alt включает замеры при наведении: без него разметка мешала бы выбору. */
      useEffect(() => {
        const down = (event) => { if (event.key === 'Alt') setAltDown(true) }
        const up = (event) => { if (event.key === 'Alt') setAltDown(false) }
        window.addEventListener('keydown', down)
        window.addEventListener('keyup', up)
        return () => {
          window.removeEventListener('keydown', down)
          window.removeEventListener('keyup', up)
        }
      }, [])

      /** Точка курсора в координатах холста. */
      const canvasPoint = useCallback((event) => {
        const rect = rootRef.current?.getBoundingClientRect()
        const current = viewRef.current
        if (!rect) return { x: 0, y: 0 }
        return {
          x: (event.clientX - rect.left - current.x) / current.zoom,
          y: (event.clientY - rect.top - current.y) / current.zoom,
        }
      }, [])

      /** Родитель для нового узла: контейнер под курсором или корень документа. */
      const parentAt = useCallback((element) => {
        const holder = element?.closest?.('[data-node-id]')
        if (!holder) return 'root'
        const id = baseId(holder.getAttribute('data-node-id'))
        const node = findNode(doc?.root, id)
        if (node && CONTAINERS.includes(node.type)) return node.id
        return 'root'
      }, [doc])

      // --- слушатели жеста: снимаем ровно те, что повесили ---

      const listenersRef = useRef({ move: null, up: null })

      const unbindDrag = useCallback(() => {
        const listeners = listenersRef.current
        if (listeners.move) window.removeEventListener('mousemove', listeners.move)
        if (listeners.up) window.removeEventListener('mouseup', listeners.up)
        listenersRef.current = { move: null, up: null }
      }, [])

      const bindDrag = useCallback((move, up) => {
        unbindDrag()
        listenersRef.current = { move, up }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }, [unbindDrag])

      /** Прямоугольник ресайза с учётом ручки, пропорций и шага сетки. */
      const resizeBox = useCallback((drag, point, event) => {
        const start = drag.rect
        const step = event.altKey ? 0 : (event.shiftKey && drag.handle.length === 1 ? 10 : 1)
        let left = start.x
        let top = start.y
        let right = start.x + start.w
        let bottom = start.y + start.h
        if (drag.handle.includes('w')) left = snap(point.x, step)
        if (drag.handle.includes('e')) right = snap(point.x, step)
        if (drag.handle.includes('n')) top = snap(point.y, step)
        if (drag.handle.includes('s')) bottom = snap(point.y, step)
        if (event.shiftKey && drag.handle.length === 2) {
          const ratio = start.w / (start.h || 1)
          let width = Math.abs(right - left)
          let height = Math.abs(bottom - top)
          if (width / (height || 1) > ratio) height = width / ratio
          else width = height * ratio
          if (drag.handle.includes('w')) left = right - width
          else right = left + width
          if (drag.handle.includes('n')) top = bottom - height
          else bottom = top + height
        }
        return {
          x: Math.min(left, right),
          y: Math.min(top, bottom),
          w: Math.max(MIN_SIZE, Math.abs(right - left)),
          h: Math.max(MIN_SIZE, Math.abs(bottom - top)),
        }
      }, [])

      /** Кандидаты привязки для узлов: соседи их родителя и соседние фреймы. */
      const candidatesFor = useCallback((ids, parentId) => (
        snapEnabled ? snapCandidates(ctx, ids, parentId) : null
      ), [ctx, snapEnabled])

      /**
       * Привязать края габарита: ресайз и протяжка двигают не узел целиком, а
       * конкретные края, поэтому сдвиг применяется к тому краю, который совпал.
       * Линии собираются вторым проходом с нулевым порогом — они должны совпасть
       * с итоговым прямоугольником, а не с промежуточным.
       */
      const snapEdges = useCallback((box, candidates, allowed, event) => {
        if (!snapEnabled || event.altKey || !candidates || allowed.length === 0) return { box, lines: [] }
        const guides = guidesRef.current
        const threshold = SNAP_THRESHOLD / Math.max(num(viewRef.current.zoom, 1), 0.01)
        const snapped = applySnap(box, candidates, guides, threshold, allowed)
        const next = { ...box }
        if (snapped.matched.x) {
          if (allowed.includes('left')) {
            next.x += snapped.dx
            next.w -= snapped.dx
          } else {
            next.w += snapped.dx
          }
        }
        if (snapped.matched.y) {
          if (allowed.includes('top')) {
            next.y += snapped.dy
            next.h -= snapped.dy
          } else {
            next.h += snapped.dy
          }
        }
        next.w = Math.max(MIN_SIZE, next.w)
        next.h = Math.max(MIN_SIZE, next.h)
        return { box: next, lines: applySnap(next, candidates, guides, 0.01, allowed).lines }
      }, [snapEnabled])

      const handleMove = useCallback((event) => {
        const drag = dragRef.current
        if (!drag) return
        if (drag.kind === 'pan') {
          onView({ ...drag.view, x: drag.view.x + (event.clientX - drag.startX), y: drag.view.y + (event.clientY - drag.startY) })
          return
        }
        const point = canvasPoint(event)
        drag.last = point
        if (drag.kind === 'guide') {
          drag.value = drag.axis === 'x' ? point.x : point.y
          setGuideDrag({ axis: drag.axis, value: drag.value })
          return
        }
        if (drag.kind === 'marquee') {
          drag.preview = {
            x: Math.min(drag.start.x, point.x),
            y: Math.min(drag.start.y, point.y),
            w: Math.abs(point.x - drag.start.x),
            h: Math.abs(point.y - drag.start.y),
          }
          setPreview(drag.preview)
          return
        }
        const step = snapStep(event)
        if (drag.kind === 'move') {
          const start = drag.startBox
          const locked = event.shiftKey
          const axis = axisLock(point.x - drag.start.x, point.y - drag.start.y, locked)
          let dx = axis.dx
          let dy = axis.dy
          // Сетка выравнивает грубо, объекты — точно: привязка к соседям важнее
          // пиксельной сетки, иначе узел «залипал» бы на сетке в двух пикселях
          // от края соседа и выровнять его было бы нельзя. С Shift шаг 10px
          // снимается (ось важнее шага), но координаты остаются целыми.
          const moveStep = step === 10 ? 1 : step
          if (moveStep > 0) {
            dx = snap(dx, moveStep)
            dy = snap(dy, moveStep)
          }
          // Привязка двигает только те оси, по которым узел реально сдвинулся:
          // иначе на старте жеста ближайший край уводил бы объект в сторону.
          const allowed = []
          if (dx !== 0) allowed.push('left', 'center', 'right')
          if (dy !== 0) allowed.push('top', 'middle', 'bottom')
          let lines = []
          if (snapEnabled && !event.altKey && drag.candidates && start && allowed.length > 0) {
            const snapped = applySnap(
              { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h },
              drag.candidates,
              guidesRef.current,
              SNAP_THRESHOLD / Math.max(num(viewRef.current.zoom, 1), 0.01),
              allowed,
            )
            dx += snapped.dx
            dy += snapped.dy
            lines = snapped.lines
          }
          if (!drag.moved && dx === 0 && dy === 0) return
          if (!drag.moved) {
            drag.moved = true
            onGeometryStart()
          }
          setSnapLines(lines)
          // В узлы пишутся координаты их родителя, а не абсолютные: иначе
          // вложенный узел уезжал бы на смещение контейнера.
          const map = {}
          for (const id of drag.movable ?? []) {
            const local = drag.startLocal?.[id]
            if (!local) continue
            map[id] = { x: local.x + dx, y: local.y + dy, w: local.w, h: local.h }
          }
          onGeometry(map)
          return
        }
        if (drag.kind === 'resize') {
          if (!drag.moved) {
            drag.moved = true
            onGeometryStart()
          }
          const allowed = []
          if (drag.handle.includes('w')) allowed.push('left')
          if (drag.handle.includes('e')) allowed.push('right')
          if (drag.handle.includes('n')) allowed.push('top')
          if (drag.handle.includes('s')) allowed.push('bottom')
          const applied = snapEdges(resizeBox(drag, point, event), drag.candidates, allowed, event)
          setSnapLines(applied.lines)
          onGeometry({ [drag.id]: localBox(applied.box, drag.offset ?? { x: 0, y: 0 }) })
          return
        }
        if (drag.kind === 'create') {
          drag.moved = true
          let box = {
            x: snap(Math.min(drag.start.x, point.x), step),
            y: snap(Math.min(drag.start.y, point.y), step),
            w: Math.max(MIN_SIZE, snap(Math.abs(point.x - drag.start.x), step)),
            h: Math.max(MIN_SIZE, snap(Math.abs(point.y - drag.start.y), step)),
          }
          // Из двух углов курсор тянет только один: второй — точка начала, её
          // привязка двигать не должна.
          const allowed = [
            point.x < drag.start.x ? 'left' : 'right',
            point.y < drag.start.y ? 'top' : 'bottom',
          ]
          const applied = snapEdges(box, drag.candidates, allowed, event)
          box = applied.box
          setSnapLines(applied.lines)
          drag.preview = box
          setPreview(box)
        }
      }, [canvasPoint, onGeometry, onGeometryStart, onView, resizeBox, snapEdges, snapEnabled])

      /**
       * Завершить жест. Для создания узла финальный прямоугольник берётся из
       * последнего превью, а при простом клике — размер по умолчанию для типа.
       * Направляющая, брошенная на линейку, удаляется: это жест удаления в Figma.
       */
      const finishDrag = useCallback(() => {
        const drag = dragRef.current
        dragRef.current = null
        unbindDrag()
        setPreview(null)
        setSnapLines([])
        setGuideDrag(null)
        if (!drag) return
        if (drag.kind === 'guide') {
          const value = Math.round(num(drag.value, Number.NaN) * 100) / 100
          if (drag.from === undefined) {
            if (Number.isFinite(value) && value > -1) onGuides({ type: 'add', axis: drag.axis, value })
          } else if (!Number.isFinite(value) || value < -2) {
            onGuides({ type: 'remove', axis: drag.axis, value: drag.from })
          } else if (value !== drag.from) {
            onGuides({ type: 'move', axis: drag.axis, from: drag.from, to: value })
          }
          return
        }
        if (drag.kind === 'marquee') {
          const box = drag.preview
          const minimal = 3 / Math.max(num(viewRef.current.zoom, 1), 0.01)
          if (!box || (box.w < minimal && box.h < minimal)) {
            // Клик без протяжки: по пустому месту снимает выделение (Shift/Ctrl
            // его сохраняет), по фону контейнера — выделяет сам контейнер.
            if (drag.clickId) {
              onSelect(drag.additive
                ? Array.from(new Set([...selection, drag.clickId]))
                : [drag.clickId])
            } else if (!drag.additive) onSelect([])
            return
          }
          const ids = marqueeNodes(ctx, box, drag.scope ?? (enteredId || 'root'))
          onSelect(drag.additive ? Array.from(new Set([...selection, ...ids])) : ids)
          return
        }
        if (drag.kind === 'move') {
          // Shift/Ctrl-клик по уже выделенному узлу снимает его с выделения —
          // но только если это был клик: протяжка с Shift двигает по оси.
          if (drag.toggleId && !drag.moved) {
            onSelect(selection.filter((item) => item !== drag.toggleId))
          }
          return
        }
        if (drag.kind !== 'create') return
        const size = DEFAULT_BOX[tool] ?? DEFAULT_BOX.rect
        const box = drag.preview ?? {
          x: snap(drag.last.x, 1),
          y: snap(drag.last.y, 1),
          w: size[0],
          h: size[1],
        }
        onCreate(box, drag.parentId)
      }, [ctx, enteredId, onGuides, onCreate, onSelect, selection, tool, unbindDrag])

      /** Начать жест: запомнить состояние и повесить слушатели окна. */
      const startDrag = useCallback((drag) => {
        dragRef.current = drag
        onHoverId('')
        bindDrag(handleMove, finishDrag)
      }, [bindDrag, finishDrag, handleMove, onHoverId])

      const onMouseDown = useCallback((event) => {
        const root = rootRef.current
        if (!root) return
        const target = event.target
        if (event.button === 1 || spaceRef.current) {
          event.preventDefault()
          startDrag({ kind: 'pan', startX: event.clientX, startY: event.clientY, view: { ...viewRef.current } })
          return
        }
        if (event.button !== 0) return
        const handleElement = target?.closest?.('[data-handle]')
        const nodeElement = target?.closest?.('[data-node-id]')
        if (handleElement && selectionRects.length > 0) {
          const item = selectionRects[selectionRects.length - 1]
          const parentId = ctx.parents.get(item.id) ?? null
          const parentRect = parentId ? ctx.rects.get(parentId) : null
          startDrag({
            kind: 'resize',
            handle: handleElement.getAttribute('data-handle'),
            id: item.id,
            rect: item.rect,
            offset: parentRect ? { x: parentRect.x, y: parentRect.y } : { x: 0, y: 0 },
            candidates: candidatesFor([item.id], parentId),
            moved: false,
          })
          return
        }
        if (tool !== 'select') {
          const point = canvasPoint(event)
          const parentId = parentAt(nodeElement)
          startDrag({
            kind: 'create',
            start: point,
            last: point,
            parentId,
            candidates: candidatesFor([], parentId),
            moved: false,
          })
          return
        }
        if (nodeElement) {
          const id = baseId(nodeElement.getAttribute('data-node-id'))
          const node = findNode(doc?.root, id)
          const additive = event.shiftKey || event.metaKey || event.ctrlKey
          const inside = Boolean(enteredId) && id === enteredId
          // Протяжка по фону контейнера выделяет его детей, а клик по нему —
          // сам контейнер: без этого рамку можно было начать только по пустому
          // месту холста или после входа в контейнер двойным кликом. Уже
          // выделенный контейнер тянется как обычно — иначе фрейм не сдвинуть.
          const containerBackground = Boolean(node)
            && CONTAINERS.includes(node.type)
            && node.type !== 'instance'
            && target === nodeElement
            && !selection.includes(id)
          if (inside || containerBackground) {
            const origin = canvasPoint(event)
            startDrag({
              kind: 'marquee',
              start: origin,
              last: origin,
              additive,
              scope: inside ? enteredId : id,
              clickId: inside ? '' : id,
              moved: false,
            })
            return
          }
          const already = selection.includes(id)
          // Снятие Shift/Ctrl-кликом откладывается до отпускания: иначе
          // протяжка с Shift по уже выделенному узлу не начиналась бы вовсе,
          // а Shift во время движения — это ограничение по оси, а не снятие.
          const toggleId = additive && already ? id : ''
          const next = additive
            ? (already ? selection : [...selection, id])
            : (already ? selection : [id])
          onSelect(next)
          if (node && node.locked !== true && next.includes(id)) {
            // Абсолютные прямоугольники нужны габариту и привязке, локальные —
            // тому, что пишется в узлы: у вложенного узла это разные числа.
            const targets = []
            const startLocal = {}
            let minX = Infinity
            let minY = Infinity
            let maxX = -Infinity
            let maxY = -Infinity
            for (const selectedId of next) {
              const rect = absRect(doc.root, selectedId)
              const selected = findNode(doc.root, selectedId)
              if (!rect || !selected) continue
              targets.push(selectedId)
              startLocal[selectedId] = {
                x: num(selected.x, 0),
                y: num(selected.y, 0),
                w: num(selected.w, 0),
                h: num(selected.h, 0),
              }
              minX = Math.min(minX, rect.x)
              minY = Math.min(minY, rect.y)
              maxX = Math.max(maxX, rect.x + rect.w)
              maxY = Math.max(maxY, rect.y + rect.h)
            }
            const startBox = Number.isFinite(minX)
              ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
              : null
            startDrag({
              kind: 'move',
              start: canvasPoint(event),
              startLocal,
              movable: movableRoots(ctx.parents, targets),
              startBox,
              toggleId,
              candidates: candidatesFor(next, ctx.parents.get(id) ?? null),
              moved: false,
            })
          } else if (toggleId) {
            // У заблокированного узла (и у исчезнувшего из документа) жест
            // движения не начинается, поэтому снятие происходит сразу.
            onSelect(selection.filter((item) => item !== toggleId))
          }
          return
        }
        // Пустое место левой кнопкой — рамка выделения, как в Figma: панорама
        // остаётся на средней кнопке и на пробеле, иначе рамку негде начать.
        const origin = canvasPoint(event)
        startDrag({
          kind: 'marquee',
          start: origin,
          last: origin,
          additive: event.shiftKey || event.metaKey || event.ctrlKey,
          scope: enteredId || 'root',
          clickId: '',
          moved: false,
        })
      }, [canvasPoint, candidatesFor, ctx, doc, enteredId, onSelect, parentAt, rootRef, selection, selectionRects, spaceRef, startDrag, tool])

      /**
       * Двойной клик входит в контейнер.
       *
       * Пока панель «находится» в контейнере, перетаскивание его фона делает
       * рамку выделения по его детям, а не двигает сам контейнер — иначе
       * выбрать детей внутри фрейма было бы нельзя, ведь фон фрейма всегда
       * перехватывает нажатие. Выход — Escape.
       */
      const onDoubleClick = useCallback((event) => {
        if (tool !== 'select') return
        const holder = event.target?.closest?.('[data-node-id]')
        if (!holder) return
        const id = baseId(holder.getAttribute('data-node-id'))
        const node = findNode(doc?.root, id)
        if (!node || node.type === 'instance' || !CONTAINERS.includes(node.type)) return
        if ((node.children ?? []).length === 0) return
        onEnter(id)
      }, [doc, onEnter, tool])

      /** Наведение: сообщаем наверх только когда узел под курсором сменился. */
      const onMouseMove = useCallback((event) => {
        if (dragRef.current) return
        const holder = event.target?.closest?.('[data-node-id]')
        const id = holder ? baseId(holder.getAttribute('data-node-id')) : ''
        if (id !== hoverId) onHoverId(id)
      }, [hoverId, onHoverId])

      /** Тянуть направляющую: из линейки — новая, по линии — перенос. */
      const startGuideDrag = useCallback((axis, value) => {
        if (typeof value === 'number') startDrag({ kind: 'guide', axis, from: value, value })
        else startDrag({ kind: 'guide', axis })
      }, [startDrag])

      useEffect(() => unbindDrag, [unbindDrag])

      /**
       * Колесо: с Ctrl — зум к курсору, без Ctrl — прокрутка вида.
       *
       * Слушатель нативный и не passive: React вешает делегированный `wheel`
       * passive-слушателем, поэтому `preventDefault` из `onWheel` не действует —
       * Ctrl+колесо масштабирует страницу, а в консоль падает ошибка браузера.
       */
      const onWheel = useCallback((event) => {
        const rect = rootRef.current?.getBoundingClientRect()
        if (!rect) return
        const current = viewRef.current
        if (!(event.ctrlKey || event.metaKey)) {
          onView({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY })
          return
        }
        event.preventDefault()
        const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
        const zoom = clamp(current.zoom * factor, 0.05, 8)
        const pointX = event.clientX - rect.left
        const pointY = event.clientY - rect.top
        onView({
          zoom,
          x: pointX - ((pointX - current.x) / current.zoom) * zoom,
          y: pointY - ((pointY - current.y) / current.zoom) * zoom,
        })
      }, [onView])

      useEffect(() => {
        const element = rootRef.current
        if (!element) return undefined
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [onWheel, rootRef])

      // --- разметка: что рисовать поверх макета ---

      const hover = useMemo(() => {
        if (!hoverId || !ctx.rects.has(hoverId)) return null
        return { id: hoverId, chain: ancestorChain(ctx.parents, hoverId) }
      }, [ctx, hoverId])

      /** Замеры: наведение с Alt важнее выделения, иначе — одиночное выделение. */
      const measure = useMemo(() => {
        const target = altDown && hoverId ? hoverId : (selection.length === 1 ? selection[0] : '')
        return target ? measureNode(ctx, target) : null
      }, [altDown, ctx, hoverId, selection])

      const padZones = useMemo(() => {
        const zones = []
        const seen = new Set()
        const push = (id, pad, rect) => {
          if (!rect || seen.has(id) || !pad) return
          if (pad.t <= 0 && pad.r <= 0 && pad.b <= 0 && pad.l <= 0) return
          seen.add(id)
          zones.push(...padZonesOf(rect, pad))
        }
        if (measure) push(measure.parent.id, measure.parent.pad, measure.parent.rect)
        if (hover) push(hover.id, nodePadding(ctx.nodes.get(hover.id)), ctx.rects.get(hover.id))
        return zones
      }, [ctx, hover, measure])

      const className = `dc-viewport${spaceRef.current || tool !== 'select' ? ' dc-viewport-create' : ''}`

      return h('div', { className: `dc-canvas-wrap${rulers ? '' : ' dc-rulers-off'}` },
        h(Rulers, { key: 'rulers', t, view, size, onStartGuide: startGuideDrag }),
        h('div', {
          ref: rootRef,
          className,
          onMouseDown,
          onMouseUp: finishDrag,
          onDoubleClick,
          onMouseMove,
          onMouseLeave: () => { setHovering(false); onHoverId('') },
          onMouseEnter: () => setHovering(true),
          onContextMenu: (event) => {
            const holder = event.target?.closest?.('[data-node-id]')
            onContext(event, holder ? baseId(holder.getAttribute('data-node-id')) : '')
          },
          'aria-label': t('canvas'),
          role: 'application',
        },
          h(CanvasStage, { display, tokens, selection, selectionRects, view, preview }),
          h(OverlayLayer, {
            view,
            ctx,
            hover,
            measure,
            padZones,
            snap: { lines: snapLines },
            guides: showGuides ? { x: guidesOf(doc, 'x'), y: guidesOf(doc, 'y') } : null,
            guideDrag,
            enteredId,
            marks,
            onGuideStart: startGuideDrag,
            onGuideRemove: (axis, value) => onGuides({ type: 'remove', axis, value }),
          }),
          enteredId && ctx.nodes.get(enteredId)
            ? h('div', { className: 'dc-enter-chip' },
              `${t('insideScope')}: ${ctx.nodes.get(enteredId).name}`,
              h('span', { className: 'dc-muted' }, ` · ${t('escapeToExit')}`),
            )
            : null,
          hovering && selection.length === 0
            ? h('div', { className: 'dc-frame-label', style: { left: 10, top: 8 } }, t('selectNodeHint'))
            : null,
        ),
      )
    }

    // ---------------------------------------------------------- ExportDialog ----

    /** Диалог экспорта: режим, «только текущий фрейм», список файлов и превью. */
    function ExportDialog({ t, fmt, onClose, onRun, frameName }) {
      const [mode, setMode] = useState('fidelity')
      const [onlyFrame, setOnlyFrame] = useState(false)
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [error, setError] = useState('')

      const run = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          setResult(await onRun({ mode, onlyFrame }))
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setBusy(false)
        }
      }, [mode, onRun, onlyFrame])

      const openPreview = useCallback(() => {
        if (!result?.preview) return
        const blob = new Blob([result.preview], { type: 'text/html;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        window.open(url, '_blank', 'noopener')
        window.setTimeout(() => URL.revokeObjectURL(url), 60000)
      }, [result])

      return h(Modal, {
        title: t('exportTitle'),
        cancelLabel: t('close'),
        submitLabel: t('exportRun'),
        onClose,
        onSubmit: busy ? undefined : run,
        wide: true,
      },
        h('div', { className: 'dc-modal-body' },
          h('div', { className: 'dc-field-row' },
            h('span', { className: 'dc-field-label' }, t('exportMode')),
            h('select', {
              className: 'dc-select',
              value: mode,
              onChange: (event) => setMode(event.target.value),
            },
              h('option', { value: 'fidelity' }, t('exportFidelity')),
              h('option', { value: 'clean' }, t('exportClean')),
            ),
          ),
          h('label', { className: 'dc-check' },
            h('input', {
              type: 'checkbox',
              checked: onlyFrame,
              onChange: (event) => setOnlyFrame(event.target.checked),
            }),
            `${t('exportFrameOnly')}${frameName ? ` (${frameName})` : ''}`,
          ),
          busy ? h('div', { className: 'dc-muted' }, t('loading')) : null,
          error ? h('div', { className: 'dc-error' }, error) : null,
          result
            ? h('div', null,
              h('div', { className: 'dc-section-title', style: { marginTop: 6 } }, t('exportFiles')),
              (result.files ?? []).length === 0
                ? h('div', { className: 'dc-muted' }, t('exportEmpty'))
                : h('div', { className: 'dc-list' }, (result.files ?? []).map((file) => h('div', { key: file.name, className: 'dc-file-row' },
                  h('span', { className: 'dc-card-title' }, file.name),
                  h('span', { className: 'dc-file-path', title: file.path ?? '' }, file.path ?? '—'),
                  h('span', { className: 'dc-muted' }, formatBytes(file.bytes)),
                ))),
              (result.warnings ?? []).length > 0
                ? h('div', null,
                  h('div', { className: 'dc-section-title', style: { marginTop: 8 } }, t('exportWarnings')),
                  h('div', { className: 'dc-warn' }, result.warnings.join(' · ')),
                )
                : null,
              h('div', { style: { marginTop: 8 } },
                h('button', {
                  type: 'button',
                  className: 'dc-btn',
                  disabled: !result.preview,
                  onClick: openPreview,
                }, t('exportPreview')),
              ),
            )
            : null,
        ),
      )
    }

    // ----------------------------------------------------------- StatusBar ----

    /** Нижний статус-бар: ревизия, состояние сохранения, узлы, замечания. */
    function StatusBar({ t, fmt, rev, saveState, stats, issues, selection, view, message }) {
      const stateLabel = {
        saved: t('savedState'),
        dirty: t('dirtyState'),
        saving: t('savingState'),
        error: t('errorState'),
      }[saveState] ?? t('savedState')
      const stateClass = saveState === 'error' ? 'dc-error' : saveState === 'saved' ? 'dc-muted' : 'dc-warn'
      const errors = (issues ?? []).filter((issue) => issue.level === 'error').length
      const warnings = (issues ?? []).filter((issue) => issue.level === 'warn').length
      return h('div', { className: 'dc-status' },
        h('span', { className: 'dc-status-item' }, h('span', { className: 'dc-status-strong' }, t('canvas')), h('span', null, stats?.topFrames?.[0]?.name ?? '—')),
        h('span', { className: 'dc-status-item' }, fmt('statusRev', { rev: rev ?? 0 })),
        h('span', { className: `dc-status-item ${stateClass}` }, stateLabel),
        h('span', { className: 'dc-status-item' }, fmt('statusNodes', { count: stats?.nodes ?? 0 })),
        h('span', { className: 'dc-status-item' }, fmt('statusSelected', { count: selection.length })),
        h('span', { className: 'dc-status-item' }, fmt('statusZoom', { zoom: Math.round((view?.zoom ?? 1) * 100) })),
        issues
          ? h('span', { className: 'dc-status-item' },
            errors > 0 ? h('span', { className: 'dc-error' }, fmt('statusErrors', { count: errors })) : null,
            warnings > 0 ? h('span', { className: 'dc-warn', style: { marginLeft: 6 } }, fmt('statusWarnings', { count: warnings })) : null,
          )
          : null,
        h('span', { className: 'dc-spacer' }),
        message ? h('span', { className: message.kind === 'error' ? 'dc-error' : 'dc-muted' }, message.text) : null,
      )
    }

    // ---------------------------------------------------------- IssuesPanel ----

    /** Панель замечаний проверки: клик по замечанию выделяет узел. */
    function IssuesPanel({ t, fmt, issues, onPick, onClose, busy, onRun }) {
      const levels = { error: t('levelError'), warn: t('levelWarn'), info: t('levelInfo') }
      return h('div', { className: 'dc-issues' },
        h('div', { className: 'dc-issues-head' },
          h('span', { className: 'dc-card-title' }, t('checkTitle')),
          h('span', { className: 'dc-muted' }, fmt('checkCount', { count: (issues ?? []).length })),
          h('span', { className: 'dc-spacer' }),
          h('button', { type: 'button', className: 'dc-btn', disabled: busy, onClick: onRun }, t('checkRun')),
          h('button', { type: 'button', className: 'dc-btn', onClick: onClose }, t('close')),
        ),
        (issues ?? []).length === 0
          ? h('div', { className: 'dc-empty' }, t('checkEmpty'))
          : (issues ?? []).map((issue, index) => h('div', {
            key: `${issue.code}-${index}`,
            className: 'dc-issue',
            onClick: () => onPick(issue),
          },
            h('span', {
              className: `dc-badge${issue.level === 'error' ? ' dc-badge-error' : issue.level === 'warn' ? ' dc-badge-warn' : ''}`,
            }, levels[issue.level] ?? issue.level),
            h('span', { className: 'dc-muted' }, issue.code),
            h('span', null, issue.message),
          )),
      )
    }

    // --------------------------------------------------------- DialogHost ----

    /**
     * Диалоги панели: новый холст, компонент из выделения, инициализация проекта.
     *
     * Чужие виды диалога (`export`, `delete-node`) рисует сама панель: без
     * явной проверки `init` они получали бы модалку инициализации проекта.
     */
    function DialogHost({ dialog, t, devices, onClose, onNewCanvas, onDefineComponent, onInitProject }) {
      const [canvasId, setCanvasId] = useState('')
      const [canvasName, setCanvasName] = useState('')
      const [device, setDevice] = useState(dialog.device ?? 'mobile')
      const [template, setTemplate] = useState('device')
      const [overwrite, setOverwrite] = useState(false)
      const [key, setKey] = useState('')
      const [componentName, setComponentName] = useState('')
      const [root, setRoot] = useState('')
      const [title, setTitle] = useState('')

      if (dialog.kind === 'canvas') {
        const submit = () => {
          const id = canvasId.trim()
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return
          onNewCanvas({ canvas: id, name: canvasName.trim() || id, device, template, overwrite })
        }
        return h(Modal, {
          title: t('canvasNew'),
          submitLabel: t('create'),
          cancelLabel: t('cancel'),
          onClose,
          onSubmit: submit,
        },
          h('div', { className: 'dc-modal-body' },
            h('input', {
              className: 'dc-input',
              autoFocus: true,
              placeholder: t('canvasId'),
              value: canvasId,
              onChange: (event) => setCanvasId(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') submit() },
            }),
            h('input', {
              className: 'dc-input',
              placeholder: t('canvasName'),
              value: canvasName,
              onChange: (event) => setCanvasName(event.target.value),
            }),
            h('div', { className: 'dc-field-row' },
              h('span', { className: 'dc-field-label' }, t('canvasDevice')),
              h('select', { className: 'dc-select', value: device, onChange: (event) => setDevice(event.target.value) },
                (devices ?? []).map((item) => h('option', { key: item, value: item }, item)),
              ),
            ),
            h('div', { className: 'dc-field-row' },
              h('span', { className: 'dc-field-label' }, t('canvasTemplate')),
              h('select', { className: 'dc-select', value: template, onChange: (event) => setTemplate(event.target.value) },
                h('option', { value: 'device' }, t('templateDevice')),
                h('option', { value: 'blank' }, t('templateBlank')),
              ),
            ),
            h('label', { className: 'dc-check' },
              h('input', { type: 'checkbox', checked: overwrite, onChange: (event) => setOverwrite(event.target.checked) }),
              t('overwrite'),
            ),
          ),
        )
      }

      if (dialog.kind === 'component') {
        const submit = () => {
          const clean = key.trim()
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(clean)) return
          onDefineComponent({ key: clean, name: componentName.trim() || clean, from: dialog.from })
        }
        return h(Modal, {
          title: t('componentDefine'),
          submitLabel: t('create'),
          cancelLabel: t('cancel'),
          onClose,
          onSubmit: submit,
        },
          h('div', { className: 'dc-modal-body' },
            h('input', {
              className: 'dc-input',
              autoFocus: true,
              placeholder: t('componentKey'),
              value: key,
              onChange: (event) => setKey(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') submit() },
            }),
            h('input', {
              className: 'dc-input',
              placeholder: t('componentName'),
              value: componentName,
              onChange: (event) => setComponentName(event.target.value),
            }),
          ),
        )
      }

      if (dialog.kind !== 'init') return null
      const submitInit = () => {
        const path = root.trim()
        if (path === '') return
        onInitProject({ root: path, title: title.trim() || undefined })
      }
      return h(Modal, {
        title: t('initTitle'),
        submitLabel: t('initRun'),
        cancelLabel: t('cancel'),
        onClose,
        onSubmit: submitInit,
      },
        h('div', { className: 'dc-modal-body' },
          h('div', { className: 'dc-muted' }, t('initHint')),
          h('input', {
            className: 'dc-input',
            autoFocus: true,
            placeholder: t('initRootPlaceholder'),
            value: root,
            onChange: (event) => setRoot(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') submitInit() },
          }),
          h('input', {
            className: 'dc-input',
            placeholder: t('canvasName'),
            value: title,
            onChange: (event) => setTitle(event.target.value),
          }),
        ),
      )
    }

    // =============================================================== панель ====

    /** Прочитать значение из localStorage (приватный режим не должен падать). */
    function readStored(key) {
      try {
        return window.localStorage.getItem(key) ?? ''
      } catch {
        return ''
      }
    }

    /** Записать значение в localStorage; пустое — удаляет ключ. */
    function writeStored(key, value) {
      try {
        if (value) window.localStorage.setItem(key, value)
        else window.localStorage.removeItem(key)
      } catch {
        /* приватный режим: панель просто не помнит выбор */
      }
    }

    /**
     * Главная панель редактора.
     *
     * Держит весь стейт: проекты и холсты, локальный документ с историей,
     * выделение, вид вьюпорта, вкладки, диалоги и состояние сохранения.
     * Документ правится локально и уезжает на сервер целиком (`POST /canvas`)
     * с `expectRev` — так параллельная правка агента не затирается молча.
     */
    function DesignPanel(props) {
      const t = props.t
      const fmt = props.fmt

      // ------------------------------------------------------- состояние ----
      const [projects, setProjects] = useState([])
      const [devices, setDevices] = useState(['mobile', 'tablet', 'desktop', 'component'])
      const [project, setProject] = useState('')
      const [canvases, setCanvases] = useState([])
      const [canvas, setCanvas] = useState('')
      const [doc, setDoc] = useState(null)
      const [serverDisplay, setServerDisplay] = useState(null)
      const [tokens, setTokens] = useState({})
      const [tokenDraft, setTokenDraft] = useState(null)
      const [components, setComponents] = useState([])
      const [stats, setStats] = useState(null)
      const [rev, setRev] = useState(0)
      const [dirty, setDirty] = useState(false)
      const [saveState, setSaveState] = useState('saved')
      const [conflict, setConflict] = useState(null)
      const [hostError, setHostError] = useState('')
      const [message, setMessage] = useState(null)
      const [selection, setSelection] = useState([])
      const [tool, setTool] = useState('select')
      const [view, setView] = useState({ x: 60, y: 60, zoom: 1 })
      const [tab, setTab] = useState('canvases')
      const [expanded, setExpanded] = useState(() => new Set())
      const [issues, setIssues] = useState(null)
      const [dialog, setDialog] = useState(null)
      const [trash, setTrash] = useState(null)
      const [busy, setBusy] = useState(false)
      const [booted, setBooted] = useState(false)
      const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 })
      const [hoverId, setHoverId] = useState('')
      const [rulers, setRulers] = useState(true)
      const [showGuides, setShowGuides] = useState(true)
      const [snapEnabled, setSnapEnabled] = useState(true)
      const [clipboard, setClipboard] = useState(null)
      const [menu, setMenu] = useState(null)
      const [enteredId, setEnteredId] = useState('')
      const [marks, setMarks] = useState([])

      const docRef = useRef(null)
      const revRef = useRef(0)
      const pastRef = useRef([])
      const futureRef = useRef([])
      const spaceRef = useRef(false)
      const viewportRef = useRef(null)
      const fitKeyRef = useRef('')
      const saveInFlightRef = useRef(false)
      const savePendingRef = useRef(false)
      const savePromiseRef = useRef(null)
      const saveRef = useRef(null)
      const pasteRef = useRef(0)

      // ------------------------------------------------------- сообщения ----

      const showError = useCallback((error) => {
        setMessage({ kind: 'error', text: error?.message ?? String(error) })
      }, [])

      const showInfo = useCallback((text) => {
        setMessage({ kind: 'info', text })
      }, [])

      useEffect(() => {
        if (!message) return undefined
        const timer = window.setTimeout(() => setMessage(null), 6000)
        return () => window.clearTimeout(timer)
      }, [message])

      // ------------------------------------------------------- история ----

      const syncHistory = useCallback(() => {
        setHistoryDepth({ past: pastRef.current.length, future: futureRef.current.length })
      }, [])

      const pushHistory = useCallback((snapshot) => {
        if (!snapshot) return
        pastRef.current.push(snapshot)
        if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift()
        futureRef.current = []
        syncHistory()
      }, [syncHistory])

      /**
       * Изменить локальный документ.
       *
       * `options.history === false` — правка внутри жеста (перетаскивание,
       * переименование): снимок для undo кладётся один раз в начале жеста.
       */
      const editDoc = useCallback((mutator, options = {}) => {
        const current = docRef.current
        if (!current) return
        const next = clone(current)
        mutator(next)
        next.updatedAt = new Date().toISOString()
        if (options.history !== false) pushHistory(current)
        docRef.current = next
        setDoc(next)
        setDirty(true)
        setSaveState('dirty')
      }, [pushHistory])

      /** Снимок перед жестом: одна запись истории на всё перетаскивание. */
      const beginGeometry = useCallback(() => {
        pushHistory(docRef.current)
      }, [pushHistory])

      const undo = useCallback(() => {
        if (pastRef.current.length === 0) return
        const previous = pastRef.current.pop()
        futureRef.current.push(docRef.current)
        docRef.current = previous
        setDoc(previous)
        setDirty(true)
        setSaveState('dirty')
        syncHistory()
      }, [syncHistory])

      const redo = useCallback(() => {
        if (futureRef.current.length === 0) return
        const next = futureRef.current.pop()
        pastRef.current.push(docRef.current)
        docRef.current = next
        setDoc(next)
        setDirty(true)
        setSaveState('dirty')
        syncHistory()
      }, [syncHistory])

      // --------------------------------------------------- загрузка данных ----

      const loadProjects = useCallback(async () => {
        setBusy(true)
        try {
          const data = await api('/projects', { query: { canvases: 1 } })
          const list = data.projects ?? []
          setProjects(list)
          if (Array.isArray(data.devices) && data.devices.length > 0) setDevices(data.devices)
          setHostError('')
          return list
        } catch (error) {
          // Сеть или 404: маршрут host-плагина не поднят — панель показывает баннер.
          setHostError(error?.message ?? String(error))
          setProjects([])
          return []
        } finally {
          setBusy(false)
        }
      }, [])

      const loadCanvases = useCallback(async (projectId) => {
        if (!projectId) {
          setCanvases([])
          return []
        }
        const data = await api('/canvases', { query: { project: projectId } })
        const list = data.canvases ?? []
        setCanvases(list)
        return list
      }, [])

      /** Вписать все верхние фреймы в окно вьюпорта. */
      const fitView = useCallback((display) => {
        const element = viewportRef.current
        const width = element?.clientWidth ?? 900
        const height = element?.clientHeight ?? 600
        const frames = display?.children ?? []
        if (frames.length === 0) {
          setView({ x: 40, y: 40, zoom: 1 })
          return
        }
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (const frame of frames) {
          minX = Math.min(minX, num(frame.x, 0))
          minY = Math.min(minY, num(frame.y, 0))
          maxX = Math.max(maxX, num(frame.x, 0) + num(frame.w, 0))
          maxY = Math.max(maxY, num(frame.y, 0) + num(frame.h, 0))
        }
        const boxW = Math.max(1, maxX - minX)
        const boxH = Math.max(1, maxY - minY)
        const zoom = clamp(Math.min((width - 80) / boxW, (height - 80) / boxH), 0.05, 2)
        setView({ zoom, x: 40 - minX * zoom, y: 40 - minY * zoom })
      }, [])

      /** Открыть холст: `GET /display` — документ, развёрнутое дерево, токены. */
      const openCanvas = useCallback(async (projectId, canvasId) => {
        if (!projectId || !canvasId) return
        setBusy(true)
        try {
          const data = await api('/display', { query: { project: projectId, id: canvasId } })
          docRef.current = data.doc ?? null
          revRef.current = data.rev ?? 0
          setDoc(data.doc ?? null)
          setServerDisplay(data.display ?? null)
          setTokens(data.tokens ?? {})
          setTokenDraft(null)
          setComponents(data.components ?? [])
          setStats(data.stats ?? null)
          setRev(data.rev ?? 0)
          setSelection([])
          setEnteredId('')
          setIssues(null)
          setConflict(null)
          setDirty(false)
          setSaveState('saved')
          pastRef.current = []
          futureRef.current = []
          syncHistory()
          setProject(projectId)
          setCanvas(canvasId)
          setExpanded(new Set((data.display?.children ?? []).map((node) => node.id)))
          fitKeyRef.current = ''
          writeStored(LS_PROJECT, projectId)
          writeStored(LS_CANVAS, canvasId)
        } catch (error) {
          if (error.status === 0 || error.status === 404) setHostError(error.message)
          else showError(error)
        } finally {
          setBusy(false)
        }
      }, [showError, syncHistory])

      const reloadCanvas = useCallback(async () => {
        if (!project || !canvas) return
        await openCanvas(project, canvas)
      }, [canvas, openCanvas, project])

      // ----------------------------------------------------------- старт ----

      useEffect(() => {
        let alive = true
        const boot = async () => {
          const list = await loadProjects()
          if (!alive) return
          setBooted(true)
          if (list.length === 0) return
          const storedProject = readStored(LS_PROJECT)
          const chosen = list.some((item) => item.id === storedProject)
            ? storedProject
            : (list.find((item) => item.initialized)?.id ?? list[0].id)
          setProject(chosen)
          let items = []
          try {
            items = await loadCanvases(chosen)
          } catch (error) {
            if (alive) showError(error)
          }
          if (!alive || items.length === 0) return
          const storedCanvas = readStored(LS_CANVAS)
          const pick = items.some((item) => item.id === storedCanvas) ? storedCanvas : items[0].id
          await openCanvas(chosen, pick)
        }
        boot().catch((error) => showError(error))
        return () => { alive = false }
      }, [loadCanvases, loadProjects, openCanvas, showError])

      /** Первый рендер холста: вьюпорт уже измерен, можно вписать макет. */
      useEffect(() => {
        if (!doc || !canvas) return
        const key = `${project}/${canvas}`
        if (fitKeyRef.current === key) return
        fitKeyRef.current = key
        fitView(expandDoc(doc))
      }, [canvas, doc, fitView, project])

      // -------------------------------------------------------- сохранение ----

      /**
       * Сохранить документ целиком.
       *
       * `expectRev` защищает от затирания: при расхождении сервер отвечает 409,
       * панель показывает баннер с выбором версии. `force` перезаписывает файл.
       *
       * Второй запрос с той же `expectRev`, пока первый в полёте, вернул бы ложный
       * 409 (панель показала бы конфликт собственного автосохранения). Автосейв
       * при занятости просто просит повтор, а явный вызов с `options.wait`
       * дожидается текущего запроса и сохраняет свежие правки сам.
       */
      const save = useCallback((force = false, options = {}) => {
        const current = docRef.current
        if (!current || !project || !canvas) return Promise.resolve(null)
        if (saveInFlightRef.current) {
          if (options.wait !== true) {
            savePendingRef.current = true
            return Promise.resolve(null)
          }
          const running = savePromiseRef.current ?? Promise.resolve(null)
          return running.then(() => (saveRef.current ? saveRef.current(force, options) : null))
        }
        const run = (async () => {
          saveInFlightRef.current = true
          setSaveState('saving')
          try {
            const data = await api('/canvas', {
              method: 'POST',
              body: {
                project,
                canvas,
                doc: current,
                expectRev: force ? undefined : revRef.current,
                force,
              },
            })
            revRef.current = data.rev ?? revRef.current
            setRev(data.rev ?? 0)
            if (data.stats) setStats(data.stats)
            // Список холстов показывает ревизию: без этой правки он оставался бы
            // со старым номером до перезагрузки и путал бы с расхождением версий.
            setCanvases((items) => items.map((item) => (
              item.id === canvas
                ? { ...item, rev: data.rev ?? item.rev, updatedAt: new Date().toISOString() }
                : item
            )))
            setDirty(false)
            setSaveState('saved')
            setConflict(null)
            return data
          } catch (error) {
            if (error.status === 409) {
              setConflict(error.body ?? { rev: revRef.current, expected: revRef.current })
              setSaveState('error')
              showError(error)
              return null
            }
            setSaveState('error')
            showError(error)
            return null
          } finally {
            saveInFlightRef.current = false
            if (savePendingRef.current) {
              savePendingRef.current = false
              // Документ изменился, пока запрос был в полёте: помечаем правку
              // снова, и автосохранение отправит её уже с новой ревизией.
              if (docRef.current !== current) setDirty(true)
            }
          }
        })()
        savePromiseRef.current = run
        return run
      }, [canvas, project, showError])
      saveRef.current = save

      /** Автосохранение с debounce после последней правки. */
      useEffect(() => {
        if (!dirty || !doc || conflict) return undefined
        const timer = window.setTimeout(() => { save(false).catch(() => {}) }, SAVE_DEBOUNCE)
        return () => window.clearTimeout(timer)
      }, [conflict, dirty, doc, save])

      // -------------------------------------------------- правки документа ----

      const patchNodes = useCallback((ids, patch, options = {}) => {
        editDoc((draft) => {
          for (const id of ids) {
            const node = findNode(draft.root, id)
            if (node) mergeNodePatch(node, patch)
          }
          if (options.relayout) relayoutDoc(draft)
        })
      }, [editDoc])

      /**
       * Правка направляющих холста.
       *
       * Направляющие живут в документе (`guides`), а не в localStorage: линейка —
       * часть макета, её видно в другом сеансе и в чужой копии холста. Пустой
       * набор убирает поле вовсе, иначе холст без разметки обрастал бы
       * `guides: {x: [], y: []}` при каждом сохранении.
       */
      const editGuides = useCallback((action) => {
        editDoc((draft) => {
          if (action?.type === 'clear') {
            delete draft.guides
            return
          }
          const axis = action?.axis === 'x' ? 'x' : 'y'
          const current = { x: guidesOf(draft, 'x'), y: guidesOf(draft, 'y') }
          if (action?.type === 'add') current[axis] = tidyGuides([...current[axis], action.value])
          else if (action?.type === 'remove') current[axis] = current[axis].filter((value) => value !== action.value)
          else if (action?.type === 'move') {
            current[axis] = tidyGuides(current[axis].map((value) => (value === action.from ? action.to : value)))
          }
          if (current.x.length === 0 && current.y.length === 0) delete draft.guides
          else draft.guides = current
        })
      }, [editDoc])

      /**
       * Дублировать узлы: копия поддерева с новыми id встаёт рядом с оригиналом.
       *
       * Арифметика повторяет операцию `duplicate` — она идёт через движок
       * операций и не попадает в локальную историю панели, поэтому действие
       * продублировано здесь.
       */
      const duplicateSelected = useCallback((ids = selection, offset = 24) => {
        if (ids.length === 0) return
        const fresh = []
        editDoc((draft) => {
          for (const id of ids) {
            const found = findParent(draft.root, id)
            if (!found) continue
            const source = found.parent.children[found.index]
            const copy = reidTree(source)
            copy.name = `${source.name} copy`
            copy.x = num(copy.x, 0) + offset
            copy.y = num(copy.y, 0) + offset
            found.parent.children.splice(found.index + 1, 0, copy)
            fresh.push(copy.id)
          }
          relayoutDoc(draft)
        })
        if (fresh.length > 0) setSelection(fresh)
      }, [editDoc, selection])

      /** Скопировать выделение в буфер панели: узлы и их абсолютные позиции. */
      const copySelected = useCallback((ids = selection) => {
        const root = docRef.current?.root
        if (!root) return
        const items = ids
          .map((id) => ({ node: findNode(root, id), abs: absRect(root, id) }))
          .filter((item) => item.node && item.abs)
          .map((item) => ({ node: clone(item.node), abs: item.abs }))
        if (items.length === 0) return
        pasteRef.current = 0
        setClipboard({ items, parentId: findParent(root, items[0].node.id)?.parent.id ?? null })
        showInfo(fmt('copiedNodes', { count: items.length }))
      }, [fmt, selection, showInfo])

      /**
       * Обернуть выделение в контейнер — арифметика операции `group`.
       *
       * `as: 'frame'` даёт обычный фрейм по габаритам выделения (без
       * авто-раскладки): «объединить в фрейм» из контекстного меню.
       */
      const groupSelection = useCallback((ids = selection, as = 'group') => {
        const root = docRef.current?.root
        if (!root || ids.length === 0) return
        const found = ids.map((id) => findParent(root, id)).filter(Boolean)
        if (found.length !== ids.length) return
        const parentId = found[0].parent.id
        if (found.some((item) => item.parent.id !== parentId)) {
          showError(new Error(t('groupOneParent')))
          return
        }
        const kind = as === 'frame' ? 'frame' : 'group'
        let groupId = ''
        editDoc((draft) => {
          const parent = findNode(draft.root, parentId)
          if (!parent) return
          const nodes = ids.map((id) => findNode(draft.root, id)).filter(Boolean)
          const bounds = boundsOf(nodes)
          const group = makeNode(kind, {
            name: kind === 'frame' ? 'Frame' : 'Group',
            x: bounds.x,
            y: bounds.y,
            w: bounds.w,
            h: bounds.h,
          })
          const order = parent.children.map((child) => child.id)
          const index = Math.min(...ids.map((id) => order.indexOf(id)).filter((value) => value >= 0))
          parent.children = parent.children.filter((child) => !ids.includes(child.id))
          group.children.push(...rebaseNodes(nodes, bounds))
          parent.children.splice(Math.max(0, index), 0, group)
          groupId = group.id
          relayoutDoc(draft)
        })
        if (groupId) setSelection([groupId])
      }, [editDoc, selection, showError, t])

      /** Разгруппировать выделение — арифметика операции `ungroup`. */
      const ungroupSelection = useCallback((ids = selection) => {
        const root = docRef.current?.root
        if (!root) return
        const movable = ids.filter((id) => {
          const node = findNode(root, id)
          return Boolean(node) && node.type !== 'instance' && Array.isArray(node.children)
        })
        if (movable.length === 0) return
        const fresh = []
        editDoc((draft) => {
          for (const id of movable) {
            const found = findParent(draft.root, id)
            if (!found) continue
            const node = found.parent.children[found.index]
            if (node.children.length === 0) {
              found.parent.children.splice(found.index, 1)
              continue
            }
            for (const child of node.children) {
              child.x = num(child.x, 0) + num(node.x, 0)
              child.y = num(child.y, 0) + num(node.y, 0)
              fresh.push(child.id)
            }
            found.parent.children.splice(found.index, 1, ...node.children)
          }
          relayoutDoc(draft)
        })
        if (fresh.length > 0) setSelection(fresh)
      }, [editDoc, selection])

      /**
       * Порядок слоёв. Узлы обрабатываются от края к началу, иначе один сдвиг
       * менял бы индекс следующего узла и часть выделения оставалась на месте.
       */
      const reorderSelection = useCallback((direction, ids = selection) => {
        if (ids.length === 0) return
        editDoc((draft) => {
          const entries = ids
            .map((id) => ({ id, found: findParent(draft.root, id) }))
            .filter((item) => item.found)
          entries.sort((a, b) => (
            direction === 'down' || direction === 'back'
              ? a.found.index - b.found.index
              : b.found.index - a.found.index
          ))
          for (const entry of entries) {
            const list = entry.found.parent.children
            const index = list.findIndex((child) => child.id === entry.id)
            if (index < 0) continue
            const [node] = list.splice(index, 1)
            if (direction === 'front') list.push(node)
            else if (direction === 'back') list.unshift(node)
            else {
              const target = direction === 'up' ? index + 1 : index - 1
              if (target < 0 || target >= list.length) {
                list.splice(index, 0, node)
                continue
              }
              list.splice(target, 0, node)
            }
          }
          relayoutDoc(draft)
        })
      }, [editDoc, selection])

      /** Выровнять выделение — арифметика операции `align`. */
      const alignSelection = useCallback((mode) => {
        if (selection.length < 2) return
        editDoc((draft) => {
          const bounds = selection
            .map((id) => ({ id, rect: absRect(draft.root, id) }))
            .filter((item) => item.rect)
          if (bounds.length < 2) return
          const horizontal = mode === 'left' || mode === 'center' || mode === 'right'
          const start = Math.min(...bounds.map((item) => (horizontal ? item.rect.x : item.rect.y)))
          const end = Math.max(...bounds.map((item) => (horizontal ? item.rect.x + item.rect.w : item.rect.y + item.rect.h)))
          for (const item of bounds) {
            const node = findNode(draft.root, item.id)
            if (!node) continue
            const value = horizontal ? item.rect.x : item.rect.y
            const size = horizontal ? item.rect.w : item.rect.h
            let delta = (start + end) / 2 - (value + size / 2)
            if (mode === 'left' || mode === 'top') delta = start - value
            else if (mode === 'right' || mode === 'bottom') delta = end - (value + size)
            if (horizontal) node.x = num(node.x, 0) + delta
            else node.y = num(node.y, 0) + delta
          }
          relayoutDoc(draft)
        })
      }, [editDoc, selection])

      /** Распределить с равными промежутками — арифметика операции `distribute`. */
      const distributeSelection = useCallback((axis = 'x') => {
        if (selection.length < 3) return
        editDoc((draft) => {
          const horizontal = axis !== 'y'
          const entries = selection
            .map((id) => ({ id, node: findNode(draft.root, id), rect: absRect(draft.root, id) }))
            .filter((item) => item.node && item.rect)
          if (entries.length < 3) return
          entries.sort((a, b) => (horizontal ? a.rect.x - b.rect.x : a.rect.y - b.rect.y))
          const first = entries[0].rect
          const last = entries[entries.length - 1].rect
          const span = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y
          const total = entries.reduce((sum, item) => sum + (horizontal ? item.rect.w : item.rect.h), 0)
          const gap = (span - total) / (entries.length - 1)
          let cursor = horizontal ? first.x : first.y
          for (const item of entries) {
            const current = horizontal ? item.rect.x : item.rect.y
            if (horizontal) item.node.x = num(item.node.x, 0) + (cursor - current)
            else item.node.y = num(item.node.y, 0) + (cursor - current)
            cursor += (horizontal ? item.rect.w : item.rect.h) + gap
          }
          relayoutDoc(draft)
        })
      }, [editDoc, selection])

      /** Сдвинуть выделение стрелками: 1px, с Shift — 10px. */
      const nudgeSelection = useCallback((dx, dy) => {
        if (selection.length === 0 || (dx === 0 && dy === 0)) return
        editDoc((draft) => {
          for (const id of selection) {
            const node = findNode(draft.root, id)
            if (!node || node.locked === true) continue
            node.x = num(node.x, 0) + dx
            node.y = num(node.y, 0) + dy
          }
          relayoutDoc(draft)
        })
      }, [editDoc, selection])

      /**
       * Геометрия из жеста: прямоугольники узлов в координатах их родителей.
       *
       * Абсолютные координаты здесь были бы ошибкой: узел внутри смещённого
       * контейнера «улётал» бы на смещение родителя при первом же движении.
       */
      const applyGeometry = useCallback((map) => {
        editDoc((draft) => {
          for (const [id, rect] of Object.entries(map)) {
            const node = findNode(draft.root, id)
            if (!node) continue
            node.x = num(rect.x, node.x)
            node.y = num(rect.y, node.y)
            node.w = Math.max(MIN_SIZE, num(rect.w, node.w))
            node.h = Math.max(MIN_SIZE, num(rect.h, node.h))
          }
          relayoutDoc(draft)
        }, { history: false })
      }, [editDoc])

      const renameNode = useCallback((id, name) => {
        editDoc((draft) => {
          const node = findNode(draft.root, id)
          if (node) node.name = name
        }, { history: false })
      }, [editDoc])

      const moveNode = useCallback((id, delta) => {
        editDoc((draft) => {
          const found = findParent(draft.root, id)
          if (!found) return
          const list = found.parent.children
          const target = found.index + delta
          if (target < 0 || target >= list.length) return
          const [node] = list.splice(found.index, 1)
          list.splice(target, 0, node)
          relayoutDoc(draft)
        })
      }, [editDoc])

      const deleteNodes = useCallback((ids) => {
        if (!ids || ids.length === 0) return
        editDoc((draft) => {
          for (const id of ids) {
            const found = findParent(draft.root, id)
            if (found) found.parent.children.splice(found.index, 1)
          }
          relayoutDoc(draft)
        })
        setSelection((current) => current.filter((id) => !ids.includes(id)))
      }, [editDoc])

      const deleteSelected = useCallback(() => {
        if (selection.length === 0) return
        deleteNodes(selection)
      }, [deleteNodes, selection])

      const toggleSelection = useCallback((id, additive) => {
        setSelection((current) => {
          if (!additive) return current.length === 1 && current[0] === id ? current : [id]
          return current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
        })
      }, [])

      /**
       * Выделить всё в текущей области: дети «вошедшего» контейнера, иначе
       * верхние фреймы холста. Скрытые узлы пропускаются — их не видно.
       */
      const selectAll = useCallback(() => {
        const root = docRef.current?.root
        if (!root) return
        const scope = enteredId ? findNode(root, enteredId) : root
        const ids = (scope?.children ?? [])
          .filter((node) => node.visible !== false)
          .map((node) => node.id)
        if (ids.length > 0) setSelection(ids)
      }, [enteredId])

      const toggleExpanded = useCallback((id) => {
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }, [])

      /** Фрейм-приёмник для новых узлов: выделенный контейнер или первый фрейм. */
      const currentFrameId = useCallback((draft) => {
        const selected = selection
          .map((id) => findNode(draft.root, id))
          .find((node) => node && CONTAINERS.includes(node.type))
        if (selected) return selected.id
        const first = (draft.root.children ?? []).find((node) => CONTAINERS.includes(node.type))
        return first?.id ?? draft.root.id
      }, [selection])

      /** Создать узел протяжкой и сразу его выделить. */
      const createNode = useCallback((box, parentId) => {
        const type = tool === 'select' ? 'rect' : tool
        const id = nextNodeId(type === 'frame' ? 'fr' : type === 'text' ? 'tx' : 'n')
        editDoc((draft) => {
          const target = findNode(draft.root, parentId)
          const parent = target && CONTAINERS.includes(target.type)
            ? target
            : (findNode(draft.root, currentFrameId(draft)) ?? draft.root)
          const offset = absRect(draft.root, parent.id) ?? { x: 0, y: 0 }
          const node = makeNode(type, {
            id,
            x: box.x - offset.x,
            y: box.y - offset.y,
            w: box.w,
            h: box.h,
          })
          if (!Array.isArray(parent.children)) parent.children = []
          parent.children.push(node)
          relayoutDoc(draft)
        })
        setSelection([id])
        setTool('select')
      }, [currentFrameId, editDoc, tool])

      // ------------------------------------------------------- компоненты ----

      /**
       * Действие над компонентами через `POST /components`.
       *
       * Сервер работает с файлом, поэтому сначала досохраняем локальные правки:
       * иначе ответ перезапишет документ и несохранённое потеряется.
       */
      const runComponentAction = useCallback(async (body) => {
        if (!project || !canvas) return null
        setBusy(true)
        try {
          if (dirty) {
            const saved = await save(false, { wait: true })
            if (!saved) return null
          }
          const data = await api('/components', { method: 'POST', body: { project, canvas, ...body } })
          if (data.rev !== undefined) {
            revRef.current = data.rev
            setRev(data.rev)
          }
          await openCanvas(project, canvas)
          return data
        } catch (error) {
          showError(error)
          return null
        } finally {
          setBusy(false)
        }
      }, [canvas, dirty, openCanvas, project, save, showError])

      const defineComponent = useCallback(async ({ key, name, from }) => {
        setDialog(null)
        const data = await runComponentAction({ action: 'define', key, name, from })
        if (data) showInfo(fmt('componentDefined', { key }))
      }, [fmt, runComponentAction, showInfo])

      const instantiateComponent = useCallback(async (key) => {
        const draft = docRef.current
        if (!draft) return
        const parent = currentFrameId(draft)
        const data = await runComponentAction({ action: 'instantiate', key, parent, x: 24, y: 24 })
        if (data) showInfo(fmt('instancePlaced', { parent }))
      }, [currentFrameId, fmt, runComponentAction, showInfo])

      const deleteComponent = useCallback(async (key) => {
        const data = await runComponentAction({ action: 'delete', key, detach: true })
        if (data) showInfo(fmt('componentDeleted', { key }))
      }, [fmt, runComponentAction, showInfo])

      const detachInstance = useCallback(async (id) => {
        const data = await runComponentAction({ action: 'detach', from: id })
        if (data) showInfo(t('detached'))
      }, [runComponentAction, showInfo, t])

      /** Инстансы компонента на холсте: узлы документа, а не шаблоны. */
      const instancesOf = useCallback((key) => {
        const out = []
        walkTree(docRef.current?.root, (node) => {
          if (node.type === 'instance' && node.component === key) out.push(node.id)
        })
        return out
      }, [])

      /** Показать узлы в окне вьюпорта: выделение ставит вызывающий. */
      const focusNodes = useCallback((ids) => {
        const draft = docRef.current
        if (!draft || !ids || ids.length === 0) return
        const rects = ids.map((id) => absRect(draft.root, id)).filter(Boolean)
        if (rects.length === 0) return
        const minX = Math.min(...rects.map((rect) => rect.x))
        const minY = Math.min(...rects.map((rect) => rect.y))
        const maxX = Math.max(...rects.map((rect) => rect.x + rect.w))
        const maxY = Math.max(...rects.map((rect) => rect.y + rect.h))
        const element = viewportRef.current
        const width = element?.clientWidth ?? 900
        const height = element?.clientHeight ?? 600
        const boxW = Math.max(1, maxX - minX)
        const boxH = Math.max(1, maxY - minY)
        const zoom = clamp(Math.min((width - 120) / boxW, (height - 120) / boxH), 0.05, 4)
        setView({
          zoom,
          x: (width - boxW * zoom) / 2 - minX * zoom,
          y: (height - boxH * zoom) / 2 - minY * zoom,
        })
      }, [])

      /** Выделить и показать все инстансы компонента. */
      const focusComponent = useCallback((key) => {
        const ids = instancesOf(key)
        if (ids.length === 0) {
          showInfo(t('componentNoInstances'))
          return
        }
        setSelection(ids)
        focusNodes(ids)
      }, [focusNodes, instancesOf, showInfo, t])

      const updateComponent = useCallback(async (key, patch) => {
        const data = await runComponentAction({ action: 'update', key, ...patch })
        if (data) showInfo(fmt('componentUpdated', { key }))
        return data
      }, [fmt, runComponentAction, showInfo])

      /**
       * Клонировать компонент.
       *
       * Шаблон передаётся прямо в `define-component` (`node`): ставить копию на
       * холст, чтобы потом объявить её компонентом, значило бы оставить мусорный
       * узел в макете.
       */
      const duplicateComponent = useCallback(async (key) => {
        const source = docRef.current?.components?.[key]
        if (!source) return null
        const taken = new Set(Object.keys(docRef.current?.components ?? {}))
        let next = `${key}-copy`
        let index = 2
        while (taken.has(next)) {
          next = `${key}-copy-${index}`
          index += 1
        }
        const data = await runComponentAction({
          action: 'define',
          key: next,
          name: `${source.name} copy`,
          description: source.description,
          node: source.node,
          props: source.props,
          convert: false,
        })
        if (data) showInfo(fmt('componentDuplicated', { key: next }))
        return data
      }, [fmt, runComponentAction, showInfo])

      /**
       * Вынести правки инстанса в компонент: шаблон становится тем, что нарисовано
       * на этом инстансе, поэтому его вид получают и остальные инстансы.
       */
      const pushToComponent = useCallback(async (id) => {
        const draft = docRef.current
        const node = draft ? findNode(draft.root, id) : null
        if (!draft || !node || !node.component) return
        const template = clone(expandInstance(draft, node))
        template.x = 0
        template.y = 0
        delete template.instanceOf
        delete template.component
        delete template.missing
        const data = await runComponentAction({ action: 'update', key: node.component, node: template })
        if (data) showInfo(t('componentPushed'))
      }, [runComponentAction, showInfo, t])

      /** Переключить вариацию инстанса: пустое значение снимает её. */
      const setVariant = useCallback((id, name) => {
        editDoc((draft) => {
          const node = findNode(draft.root, id)
          if (!node) return
          if (typeof name === 'string' && name !== '') node.variant = name
          else delete node.variant
        })
      }, [editDoc])

      /** Сбросить переопределение: одно по имени или все сразу. */
      const resetOverride = useCallback((id, name) => {
        editDoc((draft) => {
          const node = findNode(draft.root, id)
          if (!node || !isPlainObject(node.overrides)) return
          const next = { ...node.overrides }
          delete next[name]
          node.overrides = next
        })
      }, [editDoc])

      const resetOverrides = useCallback((id) => {
        editDoc((draft) => {
          const node = findNode(draft.root, id)
          if (node) node.overrides = {}
        })
      }, [editDoc])

      /**
       * Заменить компонент у инстанса.
       *
       * Совпадающие объявленные параметры и переопределения-пути переносятся,
       * остальные отбрасываются: иначе инстанс ссылался бы на параметры, которых
       * у нового компонента нет, и они бы молча ничего не делали.
       */
      const swapComponent = useCallback((id, key) => {
        editDoc((draft) => {
          const node = findNode(draft.root, id)
          const target = draft.components?.[key]
          if (!node || !target || node.component === key) return
          const known = new Set(Object.keys(target.props ?? {}))
          const next = {}
          for (const [name, value] of Object.entries(node.overrides ?? {})) {
            if (known.has(name) || name.includes('.') || name.includes('[')) next[name] = value
          }
          node.component = key
          node.overrides = next
          node.name = target.name ?? node.name
        })
      }, [editDoc])

      /**
       * Вставить из буфера в текущий контейнер.
       *
       * Позиция считается от абсолютных координат копии, поэтому взаимное
       * расположение узлов сохраняется при вставке в другой контейнер, а каждая
       * следующая вставка сдвигается на шаг — иначе копии легли бы стопкой.
       */
      const pasteClipboard = useCallback(() => {
        const items = clipboard?.items ?? []
        const draft = docRef.current
        if (items.length === 0 || !draft) return
        // Вставка идёт туда, где стоит выделение (или где лежал скопированный
        // узел): иначе копия уезжала бы в первый фрейм холста, а не рядом с
        // оригиналом, и её пришлось бы искать.
        const selectedParent = selection.map((id) => findParent(draft.root, id)).find(Boolean)
        const parentId = selectedParent ? selectedParent.parent.id : (clipboard.parentId ?? currentFrameId(draft))
        const parentNode = findNode(draft.root, parentId)
        const parent = parentNode && CONTAINERS.includes(parentNode.type) ? parentNode : draft.root
        const base = absRect(draft.root, parent.id) ?? { x: 0, y: 0 }
        const offset = 16 * (pasteRef.current + 1)
        pasteRef.current += 1
        const fresh = []
        editDoc((next) => {
          const target = findNode(next.root, parent.id)
          if (!target) return
          if (!Array.isArray(target.children)) target.children = []
          for (const item of items) {
            const copy = reidTree(item.node)
            copy.x = Math.round((item.abs.x - base.x + offset) * 100) / 100
            copy.y = Math.round((item.abs.y - base.y + offset) * 100) / 100
            target.children.push(copy)
            fresh.push(copy.id)
          }
          relayoutDoc(next)
        })
        if (fresh.length > 0) {
          setSelection(fresh)
          showInfo(fmt('pastedNodes', { count: fresh.length }))
        }
      }, [clipboard, currentFrameId, editDoc, fmt, selection, showInfo])

      const cutSelected = useCallback((ids = selection) => {
        if (ids.length === 0) return
        copySelected(ids)
        deleteNodes(ids)
      }, [copySelected, deleteNodes, selection])

      /**
       * Контекстное меню узла: те же действия, что и горячими клавишами.
       *
       * Правый клик по узлу вне выделения сначала выделяет его одного — иначе
       * меню действовало бы не на тот объект, по которому щёлкнули.
       */
      const openNodeMenu = useCallback((event, targetId = '') => {
        event.preventDefault()
        const root = docRef.current?.root
        const target = targetId && root && findNode(root, targetId) ? targetId : ''
        const next = target ? (selection.includes(target) ? selection : [target]) : selection
        if (target && !selection.includes(target)) setSelection([target])
        const single = next.length === 1 && root ? findNode(root, next[0]) : null
        const isInstance = Boolean(single && (single.type === 'instance' || single.component))
        const canUngroup = Boolean(single && !isInstance && Array.isArray(single.children) && single.children.length > 0)
        const empty = next.length === 0
        const items = [
          { id: 'duplicate', label: t('duplicate'), hint: 'Ctrl+D', disabled: empty, run: () => duplicateSelected(next) },
          { id: 'copy', label: t('copy'), hint: 'Ctrl+C', disabled: empty, run: () => copySelected(next) },
          { id: 'paste', label: t('paste'), hint: 'Ctrl+V', disabled: (clipboard?.items ?? []).length === 0, run: () => pasteClipboard() },
          { separator: true },
          { id: 'group', label: t('group'), hint: 'Ctrl+G', disabled: next.length < 2, run: () => groupSelection(next) },
          { id: 'wrap-frame', label: t('wrapFrame'), hint: 'Ctrl+Alt+G', disabled: empty, run: () => groupSelection(next, 'frame') },
          { id: 'ungroup', label: t('ungroup'), hint: 'Ctrl+Shift+G', disabled: !canUngroup, run: () => ungroupSelection(next) },
          { separator: true },
          { id: 'front', label: t('orderFront'), hint: 'Ctrl+Shift+]', disabled: empty, run: () => reorderSelection('front', next) },
          { id: 'up', label: t('orderUp'), hint: 'Ctrl+]', disabled: empty, run: () => reorderSelection('up', next) },
          { id: 'down', label: t('orderDown'), hint: 'Ctrl+[', disabled: empty, run: () => reorderSelection('down', next) },
          { id: 'back', label: t('orderBack'), hint: 'Ctrl+Shift+[', disabled: empty, run: () => reorderSelection('back', next) },
          { separator: true },
          { id: 'lock', label: single && single.locked === true ? t('unlock') : t('lock'), disabled: !single, run: () => patchNodes(next, { locked: !(single && single.locked === true) }) },
          { id: 'hide', label: single && single.visible === false ? t('visibilityShow') : t('visibilityHide'), disabled: !single, run: () => patchNodes(next, { visible: single ? single.visible === false : true }) },
          { separator: true },
          { id: 'detach', label: t('detach'), disabled: !isInstance, run: () => detachInstance(next[0]) },
          { id: 'component', label: t('componentDefine'), disabled: next.length !== 1 || isInstance, run: () => setDialog({ kind: 'component', from: next[0] }) },
          { separator: true },
          { id: 'delete', label: t('nodeDelete'), hint: 'Del', disabled: empty, run: () => deleteNodes(next) },
        ]
        const width = 232
        const height = items.length * 26 + 20
        setMenu({
          x: clamp(event.clientX, 4, Math.max(4, window.innerWidth - width - 8)),
          y: clamp(event.clientY, 4, Math.max(4, window.innerHeight - height - 8)),
          items,
        })
      }, [clipboard, copySelected, deleteNodes, detachInstance, duplicateSelected, groupSelection, pasteClipboard, patchNodes, reorderSelection, selection, t, ungroupSelection])

      /** Переопределение объявленного параметра инстанса. */
      const setOverride = useCallback((id, name, value) => {
        editDoc((draft) => {
          const node = findNode(draft.root, id)
          if (!node) return
          node.overrides = { ...(isPlainObject(node.overrides) ? node.overrides : {}), [name]: value }
        })
      }, [editDoc])

      // ---------------------------------------------------------- токены ----

      const editToken = useCallback((path, value) => {
        setTokenDraft((current) => ({ ...(current ?? tokens), [path]: value }))
      }, [tokens])

      const applyTokens = useCallback(async () => {
        if (!tokenDraft || !project || !canvas) return
        setBusy(true)
        try {
          if (dirty) {
            const saved = await save(false, { wait: true })
            if (!saved) return
          }
          const data = await api('/tokens', {
            method: 'POST',
            body: {
              project,
              canvas,
              tokens: groupsFromFlat(tokenDraft),
              expectRev: revRef.current,
            },
          })
          revRef.current = data.rev ?? revRef.current
          setRev(data.rev ?? 0)
          setTokens(data.flat ?? {})
          setTokenDraft(null)
          if (docRef.current) {
            // Сервер уже записал токены: локальный документ синхронизируем без пометки «есть правки».
            const next = clone(docRef.current)
            next.tokens = data.tokens ?? next.tokens
            docRef.current = next
            setDoc(next)
          }
          showInfo(t('tokensApplied'))
        } catch (error) {
          if (error.status === 409) setConflict(error.body ?? { rev: revRef.current, expected: revRef.current })
          showError(error)
        } finally {
          setBusy(false)
        }
      }, [canvas, dirty, project, save, showError, showInfo, t, tokenDraft])

      // --------------------------------------------------- холсты, корзина ----

      const chooseProject = useCallback(async (projectId) => {
        setProject(projectId)
        writeStored(LS_PROJECT, projectId)
        setSelection([])
        try {
          const items = await loadCanvases(projectId)
          if (items.length > 0) {
            await openCanvas(projectId, items[0].id)
            return
          }
          docRef.current = null
          setDoc(null)
          setCanvas('')
          writeStored(LS_CANVAS, '')
        } catch (error) {
          showError(error)
        }
      }, [loadCanvases, openCanvas, showError])

      const createCanvas = useCallback(async ({ canvas: id, name, device, template, overwrite }) => {
        setDialog(null)
        setBusy(true)
        try {
          await api('/create', { method: 'POST', body: { project, canvas: id, name, device, template, overwrite } })
          await loadCanvases(project)
          await openCanvas(project, id)
          showInfo(fmt('canvasCreated', { id }))
        } catch (error) {
          showError(error)
        } finally {
          setBusy(false)
        }
      }, [fmt, loadCanvases, openCanvas, project, showError, showInfo])

      const deleteCanvas = useCallback(async (id) => {
        setBusy(true)
        try {
          await api('/delete', { method: 'POST', body: { project, canvas: id } })
          const items = await loadCanvases(project)
          if (id === canvas) {
            docRef.current = null
            setDoc(null)
            setCanvas('')
            writeStored(LS_CANVAS, '')
            if (items.length > 0) await openCanvas(project, items[0].id)
          }
          showInfo(fmt('canvasDeleted', { id }))
        } catch (error) {
          showError(error)
        } finally {
          setBusy(false)
        }
      }, [canvas, fmt, loadCanvases, openCanvas, project, showError, showInfo])

      const toggleTrash = useCallback(async () => {
        if (trash) {
          setTrash(null)
          return
        }
        setBusy(true)
        try {
          setTrash(await api('/trash'))
        } catch (error) {
          showError(error)
        } finally {
          setBusy(false)
        }
      }, [showError, trash])

      const restoreTrash = useCallback(async (trashId) => {
        setBusy(true)
        try {
          const data = await api('/restore', { method: 'POST', body: { trashId } })
          await loadCanvases(project)
          setTrash(await api('/trash'))
          showInfo(fmt('canvasRestored', { canvas: data.canvas ?? trashId }))
        } catch (error) {
          showError(error)
        } finally {
          setBusy(false)
        }
      }, [fmt, loadCanvases, project, showError, showInfo])

      const initProject = useCallback(async ({ root, title }) => {
        setDialog(null)
        setBusy(true)
        try {
          const data = await api('/init', { method: 'POST', body: { root, title } })
          const list = await loadProjects()
          const chosen = data.project?.id ?? list[0]?.id ?? ''
          if (chosen) {
            showInfo(fmt('projectInitialized', { id: chosen }))
            await chooseProject(chosen)
          }
        } catch (error) {
          showError(error)
        } finally {
          setBusy(false)
        }
      }, [chooseProject, fmt, loadProjects, showError, showInfo])

      // -------------------------------------------------- проверка, экспорт ----

      const runValidate = useCallback(async () => {
        if (!project || !canvas) return
        setBusy(true)
        try {
          const data = await api('/validate', { query: { project, id: canvas } })
          setIssues(data.issues ?? [])
          if (data.stats) setStats((current) => ({ ...(current ?? {}), ...data.stats }))
        } catch (error) {
          showError(error)
        } finally {
          setBusy(false)
        }
      }, [canvas, project, showError])

      const runExport = useCallback(async ({ mode, onlyFrame }) => {
        const draft = docRef.current
        const frame = onlyFrame ? ((draft?.root?.children ?? [])[0]?.id ?? undefined) : undefined
        const data = await api('/export', {
          method: 'POST',
          body: { project, canvas, mode, preview: true, frame },
        })
        showInfo(fmt('exportDone', { count: (data.files ?? []).length }))
        return data
      }, [canvas, fmt, project, showInfo])

      const takeDiskVersion = useCallback(async () => {
        await reloadCanvas()
        setConflict(null)
        showInfo(t('conflictResolved'))
      }, [reloadCanvas, showInfo, t])

      // -------------------------------------------------------- вьюпорт ----

      const zoomBy = useCallback((factor) => {
        setView((current) => {
          const element = viewportRef.current
          const centerX = (element?.clientWidth ?? 900) / 2
          const centerY = (element?.clientHeight ?? 600) / 2
          const zoom = clamp(current.zoom * factor, 0.05, 8)
          return {
            zoom,
            x: centerX - ((centerX - current.x) / current.zoom) * zoom,
            y: centerY - ((centerY - current.y) / current.zoom) * zoom,
          }
        })
      }, [])

      const zoomReset = useCallback(() => {
        setView((current) => ({ ...current, zoom: 1 }))
      }, [])

      const display = useMemo(() => {
        if (!doc) return serverDisplay
        try {
          return expandDoc(doc)
        } catch {
          return serverDisplay
        }
      }, [doc, serverDisplay])

      const zoomFit = useCallback(() => fitView(display), [display, fitView])

      /**
       * «Вошедший» контейнер исчез (удалён, отменён) — выходим из него.
       *
       * Без этого панель оставалась «внутри» узла, которого нет: рамка по
       * пустому месту и `Ctrl+A` молча не выделяли ничего.
       */
      useEffect(() => {
        if (enteredId && doc && !findNode(doc.root, enteredId)) setEnteredId('')
      }, [doc, enteredId])

      /** Сколько направляющих стоит на холсте: от этого зависит кнопка сброса. */
      const guideCount = useMemo(() => guidesOf(doc, 'x').length + guidesOf(doc, 'y').length, [doc])

      // ------------------------------------------------------- горячие клавиши ----

      useEffect(() => {
        const isTyping = (element) => {
          if (!element) return false
          const tag = element.tagName
          return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true
        }
        const onKeyDown = (event) => {
          if (event.code === 'Space' && !isTyping(event.target)) {
            spaceRef.current = true
            if (viewportRef.current?.contains(event.target)) event.preventDefault()
          }
          if (isTyping(event.target)) return
          const key = String(event.key ?? '').toLowerCase()
          if (event.metaKey || event.ctrlKey) {
            if (key === 's') {
              event.preventDefault()
              save(false, { wait: true }).catch(() => {})
            } else if (key === 'z') {
              event.preventDefault()
              if (event.shiftKey) redo()
              else undo()
            } else if (key === 'd') {
              event.preventDefault()
              duplicateSelected()
            } else if (key === 'c') {
              event.preventDefault()
              copySelected()
            } else if (key === 'x') {
              event.preventDefault()
              cutSelected()
            } else if (key === 'v') {
              event.preventDefault()
              pasteClipboard()
            } else if (key === 'a') {
              event.preventDefault()
              selectAll()
            } else if (key === 'g') {
              event.preventDefault()
              if (event.shiftKey) ungroupSelection()
              else if (event.altKey) groupSelection(selection, 'frame')
              else groupSelection()
            } else if (key === ']') {
              event.preventDefault()
              reorderSelection(event.shiftKey ? 'front' : 'up')
            } else if (key === '[') {
              event.preventDefault()
              reorderSelection(event.shiftKey ? 'back' : 'down')
            }
            return
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            if (selection.length > 0) {
              event.preventDefault()
              const size = event.shiftKey ? 10 : 1
              const dx = event.key === 'ArrowLeft' ? -size : event.key === 'ArrowRight' ? size : 0
              const dy = event.key === 'ArrowUp' ? -size : event.key === 'ArrowDown' ? size : 0
              nudgeSelection(dx, dy)
            }
            return
          }
          if (event.shiftKey && key === 'r') {
            event.preventDefault()
            setRulers((value) => !value)
            return
          }
          if (key === 'v') setTool('select')
          else if (key === 'f') setTool('frame')
          else if (key === 'r') setTool('rect')
          else if (key === 'o') setTool('ellipse')
          else if (key === 't') setTool('text')
          else if (event.key === 'Escape') {
            setTool('select')
            setSelection([])
            setMenu(null)
            setEnteredId('')
          } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault()
            deleteSelected()
          }
        }
        const onKeyUp = (event) => {
          if (event.code === 'Space') spaceRef.current = false
        }
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        return () => {
          window.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('keyup', onKeyUp)
        }
      }, [copySelected, cutSelected, deleteSelected, duplicateSelected, groupSelection, nudgeSelection, pasteClipboard, redo, reorderSelection, save, selectAll, selection, undo, ungroupSelection])

      // ------------------------------------------------------------ рендер ----

      const tabs = [
        { id: 'canvases', label: t('tabCanvases') },
        { id: 'layers', label: t('tabLayers') },
        { id: 'components', label: t('tabComponents') },
        { id: 'tokens', label: t('tabTokens') },
      ]

      const selectedInstance = useMemo(() => {
        if (selection.length !== 1) return null
        const node = findNode(doc?.root, selection[0])
        return node && (node.type === 'instance' || node.component) ? node : null
      }, [doc, selection])

      const renderLeft = () => {
        if (tab === 'layers') {
          return h(LayersTree, {
            t,
            display,
            selection,
            hoverId,
            onHoverId: setHoverId,
            onContext: openNodeMenu,
            expanded,
            onToggle: toggleExpanded,
            onSelect: toggleSelection,
            onRename: renameNode,
            onPatch: (id, patch) => patchNodes([id], patch, { relayout: true }),
            onMove: moveNode,
            onDelete: (id) => {
              const node = findNode(doc?.root, id)
              setDialog({ kind: 'delete-node', id, name: node?.name ?? id })
            },
          })
        }
        if (tab === 'components') {
          return h(ComponentsPanel, {
            t,
            fmt,
            doc,
            tokens,
            components,
            selection,
            selectedInstance,
            onDefine: () => {
              if (selection.length === 0) {
                showError(new Error(t('selectFirst')))
                return
              }
              setDialog({ kind: 'component', from: selection[0] })
            },
            onInstantiate: instantiateComponent,
            onDelete: deleteComponent,
            onDetach: detachInstance,
            onUpdate: updateComponent,
            onDuplicate: duplicateComponent,
            onFocus: focusComponent,
            onHoverInstances: (key) => setMarks(key ? instancesOf(key) : []),
          })
        }
        if (tab === 'tokens') {
          return h(TokensPanel, {
            t,
            draft: tokenDraft ?? tokens,
            baseline: tokens,
            busy,
            onEdit: editToken,
            onApply: applyTokens,
            onRevert: () => setTokenDraft(null),
          })
        }
        return h(CanvasesPanel, {
          t,
          fmt,
          canvases,
          current: canvas,
          busy,
          trash,
          onOpen: (id) => { openCanvas(project, id).catch(() => {}) },
          onCreate: () => setDialog({ kind: 'canvas', device: devices[0] ?? 'mobile' }),
          onDelete: deleteCanvas,
          onRefresh: () => { loadCanvases(project).catch((error) => showError(error)) },
          onTrash: toggleTrash,
          onRestore: restoreTrash,
        })
      }

      const hostBanner = hostError
        ? h('div', { className: 'dc-banner dc-banner-error', key: 'host' },
          h('div', { className: 'dc-banner-body' },
            h('div', { className: 'dc-status-strong' }, t('hostDown')),
            h('div', { className: 'dc-muted' }, fmt('hostHint', { api: API })),
            h('div', { className: 'dc-error' }, hostError),
          ),
          h('button', {
            type: 'button',
            className: 'dc-btn',
            onClick: () => { loadProjects().catch(() => {}) },
          }, t('retry')),
        )
        : null

      const initBanner = booted && !hostError && projects.length === 0
        ? h('div', { className: 'dc-banner', key: 'init' },
          h('div', { className: 'dc-banner-body' },
            h('div', { className: 'dc-status-strong' }, t('noProjects')),
            h('div', { className: 'dc-muted' }, t('initHint')),
          ),
          h('button', {
            type: 'button',
            className: 'dc-btn dc-btn-primary',
            onClick: () => setDialog({ kind: 'init' }),
          }, t('initTitle')),
        )
        : null

      const conflictBanner = conflict
        ? h('div', { className: 'dc-banner dc-banner-error', key: 'conflict' },
          h('div', { className: 'dc-banner-body' },
            h('div', { className: 'dc-status-strong' }, t('conflictTitle')),
            h('div', { className: 'dc-muted' }, fmt('conflictBody', {
              rev: conflict.rev ?? '—',
              expected: conflict.expected ?? '—',
            })),
          ),
          h('button', { type: 'button', className: 'dc-btn', onClick: () => { takeDiskVersion().catch(() => {}) } }, t('takeDisk')),
          h('button', { type: 'button', className: 'dc-btn dc-btn-primary dc-btn-danger', onClick: () => { save(true, { wait: true }).catch(() => {}) } }, t('overwriteMine')),
        )
        : null

      const deleteNodeDialog = dialog?.kind === 'delete-node'
        ? h(Modal, {
          key: 'delete-node',
          title: t('deleteNodeTitle'),
          submitLabel: t('nodeDelete'),
          cancelLabel: t('cancel'),
          danger: true,
          onClose: () => setDialog(null),
          onSubmit: () => {
            deleteNodes([dialog.id])
            setDialog(null)
          },
        }, h('div', null, fmt('deleteNodeBody', { name: dialog.name })))
        : null

      return h('div', { className: 'dc-root' },
        h(Toolbar, {
          key: 'toolbar',
          t,
          tool,
          onTool: setTool,
          view,
          onZoomIn: () => zoomBy(1.25),
          onZoomOut: () => zoomBy(1 / 1.25),
          onZoomFit: zoomFit,
          onZoomReset: zoomReset,
          onUndo: undo,
          onRedo: redo,
          canUndo: historyDepth.past > 0,
          canRedo: historyDepth.future > 0,
          onSave: () => { save(false, { wait: true }).catch(() => {}) },
          onExport: () => setDialog({ kind: 'export' }),
          onValidate: () => { runValidate().catch(() => {}) },
          onRefresh: () => { reloadCanvas().catch(() => {}) },
          saveState,
          busy,
          projects,
          project,
          onProject: (id) => { chooseProject(id).catch(() => {}) },
          rulers,
          onRulers: () => setRulers((value) => !value),
          showGuides,
          onShowGuides: () => setShowGuides((value) => !value),
          snapEnabled,
          onSnap: () => setSnapEnabled((value) => !value),
          guideCount,
          onGuidesClear: () => editGuides({ type: 'clear' }),
        }),
        hostBanner,
        initBanner,
        h('div', { className: 'dc-body', key: 'body' },
          h('aside', { className: 'dc-left' },
            h('div', { className: 'dc-tabs' }, tabs.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: `dc-tab${tab === item.id ? ' dc-tab-active' : ''}`,
              onClick: () => setTab(item.id),
            }, item.label))),
            h('div', { className: 'dc-left-scroll' }, renderLeft()),
          ),
          h('main', { className: 'dc-center' },
            conflictBanner,
            doc
              ? h(Viewport, {
                key: 'viewport',
                t,
                rootRef: viewportRef,
                doc,
                display,
                tokens,
                selection,
                tool,
                view,
                onView: setView,
                onSelect: setSelection,
                onGeometry: applyGeometry,
                onGeometryStart: beginGeometry,
                onCreate: createNode,
                spaceRef,
                hoverId,
                onHoverId: setHoverId,
                rulers,
                showGuides,
                snapEnabled,
                onGuides: editGuides,
                onContext: openNodeMenu,
                enteredId,
                onEnter: setEnteredId,
                marks,
              })
              : h('div', { className: 'dc-empty' }, t('selectCanvas')),
            issues ? h(IssuesPanel, {
              key: 'issues',
              t,
              fmt,
              issues,
              busy,
              onRun: () => { runValidate().catch(() => {}) },
              onClose: () => setIssues(null),
              onPick: (issue) => {
                if (issue.node) setSelection([baseId(issue.node)])
              },
            }) : null,
          ),
          h('aside', { className: 'dc-right' },
            h(Inspector, {
              key: 'inspector',
              t,
              fmt,
              doc,
              tokens,
              components,
              selection,
              onPatch: patchNodes,
              onDetach: detachInstance,
              onOverride: setOverride,
              onAlign: alignSelection,
              onDistribute: distributeSelection,
              onResetOverride: resetOverride,
              onResetAll: resetOverrides,
              onPush: pushToComponent,
              onSwap: swapComponent,
              onVariant: setVariant,
              onSelect: () => setTab('components'),
            }),
          ),
        ),
        h(StatusBar, {
          key: 'status',
          t,
          fmt,
          rev,
          saveState,
          stats,
          issues,
          selection,
          view,
          message,
        }),
        DIALOG_KINDS.includes(dialog?.kind)
          ? h(DialogHost, {
            key: 'dialog',
            dialog,
            t,
            devices,
            onClose: () => setDialog(null),
            onNewCanvas: createCanvas,
            onDefineComponent: defineComponent,
            onInitProject: initProject,
          })
          : null,
        h(ContextMenu, { key: 'menu', menu, onClose: () => setMenu(null) }),
        deleteNodeDialog,
        dialog?.kind === 'export'
          ? h(ExportDialog, {
            key: 'export',
            t,
            fmt,
            frameName: (display?.children ?? [])[0]?.name ?? '',
            onClose: () => setDialog(null),
            onRun: runExport,
          })
          : null,
      )
    }

    // ====================================================== иконка сайдбара ====

    /**
     * Глиф панели в левой колонке. Сайдбар сам оборачивает `<svg>` в кнопку,
     * поэтому компонент возвращает голую иконку.
     */
    function PanelIcon({ size = 16, active = false }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 2 : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' },
      },
        h('rect', { x: 3, y: 4, width: 18, height: 14, rx: 2 }),
        h('path', { d: 'M3 9h18M9 9v9' }),
        h('path', { d: 'M7 18.5h10' }),
      )
    }

    // =========================================================== регистрация ====

    /**
     * Точка входа клиентской половины: стили, словари и две регистрации.
     *
     * Обе регистрации делят один id: кнопка сайдбара зовёт
     * `ctx.layout.selectPanel(id)`, который бросает без панели `main` с этим ключом.
     */
    function apply(ctx) {
      // Стили помечены `data-plugin`, иначе module-system присвоит их
      // следующему материализованному плагину и удалит при его выгрузке.
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PKG)
      style.setAttribute('data-plugin-css', `${PKG}/client.css`)
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => { style.remove() }, 'design-canvas: panel styles')

      ctx.effect(() => ctx.locale.register(NS, { ru: RU, en: EN, zh: EN }), 'design-canvas: dictionaries')
      const t = ctx.locale.bind(NS)
      /** Подстановка `{param}` без зависимости от синтаксиса форматирования хоста. */
      const fmt = (key, params) => {
        let text = t(key)
        for (const [name, value] of Object.entries(params ?? {})) {
          text = text.split(`{${name}}`).join(String(value))
        }
        return text
      }

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, (panelProps) => h(DesignPanel, { ...panelProps, t, fmt })))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 30,
        label: () => t('panel'),
        locale: NS,
      }, PanelIcon))
    }

    return { name: PKG, inject: ['slots', 'locale'], apply }
  },
})
