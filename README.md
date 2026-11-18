# Exchange EWS Calendar — аддон для Mozilla Thunderbird

MailExtension (WebExtension + Thunderbird Experiment), который подключает
корпоративный календарь **Outlook / Microsoft Exchange (EWS)** к календарю
Thunderbird (Lightning). Не требует сторонних сервисов — общается напрямую с
EWS через SOAP.

Поддерживается Thunderbird **128+** (разработано и проверено на 160).
Устаревший bootstrap-вариант (0.1.x, install.rdf) не устанавливается на
TB 128+ — поддержка legacy-аддонов удалена.

## Возможности

- Просмотр событий Exchange-календаря в обычном календаре Thunderbird.
- События хранятся в SQLite (`calendar-data/local.sqlite`) — доступны
  офлайн, переживают перезапуск.
- Авто-синхронизация: `FindItem`+`CalendarView` по окну (−180 дней / +400
  дней; если сервер обрезает выдачу — окно делится пополам рекурсивно),
  апсерт по ItemId + удаление исчезнувших из окна. По встроенному таймеру
  менеджера календарей (интервал настраивается, по умолчанию 30 минут).
  (`SyncFolderItems` на некоторых EWS-шлюзах возвращает пустой Changes —
  поэтому FindItem.)
- Создание / изменение / удаление событий прямо из Thunderbird
  (записываются на сервер: CreateItem / UpdateItem / SoftDelete).
- Встречи: участники, статусы ответов, организатор, «онлайн-встреча».
- Ответ на приглашение: **Принять / Под вопросом / Отклонить**
  (AcceptItem / TentativelyAcceptItem / DeclineItem) — кнопка на unified
  toolbar.
- Аутентификация: **NTLMv2-хендшейк с явными кредами** (email+пароль),
  выполняется самим аддоном (type1/type2/type3, крипто-примитивы
  сверены с OpenSSL). Подходит для серверов, где Basic отключён, а
  SSO-сессия Windows без доменных прав. При auth=auto и неудаче NTLM —
  один повтор без заголовка (necko Negotiate/NTLM от учётки Windows).
  Режим «Basic» — для серверов, где Basic ещё включён. Пароль хранится
  зашифрованным (SDR, как пароли почты TB).

## Состав

| Путь | Назначение |
|------|-----------|
| `manifest.json` | MV2-манифест: experiment_apis, кнопка (action), страница настроек |
| `lib/*.js` | EWS-слой: клиент (SOAP builders/parsers), xml/datetime-хелперы, синк с пагинацией, транспорт (Basic + SSO) |
| `experiments/ews/api.js` | Реализация experiment API `browser.ews.*` |
| `experiments/ews/ews-calendar.js` | Провайдер календаря `EwsCalendar extends CalStorageCalendar` |
| `experiments/ews/ews-startup.js` | Регистрация провайдера в менеджере календарей |
| `experiments/ews/ews-config.js` | Конфиг в свойствах календаря + шифрование пароля |
| `experiments/ews/ews-migration.js` | Перенос настроек из 0.1.x prefs |
| `experiments/ews/loader.js` | Загрузчик lib/модулей в parent process |
| `options/` | Страница настроек (список календарей, форма, статус) |
| `popup/` | Попап кнопки: «Синхронизировать», ответы на приглашения |
| `_locales/{en,ru}` | Локализация UI |
| `build/build.mjs` | Сборка `.xpi` |
| `test/` | Офлайн-тесты EWS XML + live-тест |

## Сборка

```
node build/build.mjs   # -> dist/exchange-ews-calendar-0.4.9.xpi
node test/ews.parser.test.mjs
```

> Сборка использует PowerShell + .NET `ZipArchive` (Windows), чтобы имена
> записей в архиве были с прямыми слэшами. На Linux/macOS достаточно
> стандартного zip с файлами в корне архива.

## Установка (неподписанный .xpi)

Thunderbird **не требует подписи** для установки из файла, а Thunderbird
Experiments включены по умолчанию (`extensions.experiments.enabled=true`).
Поэтому достаточно:

**Вариант 1 — постоянная установка:**
`about:addons` → ⚙ → «Установить дополнение из файла…» → выбрать
`dist/exchange-ews-calendar-0.4.9.xpi` → перезапустить Thunderbird.

**Вариант 2 — временная (для разработки):**
`about:debugging#/runtime/this-thunderbird` → «Временно установить
дополнение…». Временная установка также обходит suppression experiments.

Если в будущих версиях Thunderbird включат подавление экспериментов
(`extensions.experiments.suppressed=true`), добавьте id аддона в
`extensions.experiments.allowed` (через enterprise-policies или Config
Editor):
`{9f2c4e7a-3b6d-4c1e-8a5f-7d2b9e0c1a34}`.

## Настройка

Кнопка аддона появляется в unified toolbar (при необходимости добавьте её
через настройку панели инструментов). **Правой кнопкой → «Настройки»**
(или `about:addons` → Exchange EWS Calendar → Настройки) открывает страницу
настроек:

- **EWS URL** — например `https://owa.example.com/ews/exchange.asmx`
- **Email** — корпоративный адрес
- **Аутентификация** — «Windows / диалог» (рекомендуется; при первом синке
  Thunderbird покажет диалог логина — введите доменной логин (можно UPN
  `user@example.com`) и пароль, отметьте «запомнить») или «Basic» (пароль из
  настроек; только если сервер разрешает Basic)
- **Интервал синхронизации**, **Только чтение**

Календарь появляется в списке календарей сразу и синхронизируется немедленно.

Кнопка на панели: **«Синхронизировать все календари»** + ответы
Принять/Под вопросом/Отклонить для события, выделенного на вкладке
календаря (если это приглашение).

## Проверка

1. Консоль ошибок: `Ctrl+Shift+J` (Error console) — строки с префиксом `ews:`.
2. В Error console выполните `cal.manager.hasCalendarProvider("ews")` —
   должно быть `true` после старта.
3. Настройки → создать календарь → он появляется в панели календарей и
   синхронизируется.
4. Перезапуск TB: календарь восстанавливается из `calendar.registry.*`
   (события остаются в SQLite).

Типовые проблемы:

- **«Провайдер не зарегистрирован» / dummy-календарь** — эксперимент не
  запустился. Проверьте консоль на ошибки загрузки `api.js`/`schema.json`.
- **`sync failed: auth failed (HTTP 401)`** — неверный пароль, или сервер
  не даёт Basic. Переключите на auth=auto (SSO) или наоборот.
- **SSO (Kerberos)**: по умолчанию Thunderbird не пробует Kerberos ни для
  одного хоста (`network.negotiate-auth.trusted-uris` пустой). Для
  Kerberos добавьте хост в этот pref (Config Editor):
  `owa.example.com`. NTLM через SSPI (учётка Windows) работает без настройки.
- **События есть на сервере, но пусто в TB** — проверьте окно синхронизации
  (`SyncFolderItems` без ограничения окна тянет весь календарь; если
  календарь огромен, первый синк может идти несколькими раундами).

## Миграция с 0.1.x (legacy bootstrap)

Если стояла старая версия и в профиле остались prefs
`extensions.tb-ews-calendar.*`, при первом старте новой версии календари
переносятся автоматически: тот же id календаря, настройки и syncState
сохраняются, старая ветка prefs очищается.

## Тесты

```
node test/ews.parser.test.mjs   # офлайн: сборка/парсинг EWS XML (~40 проверок)
node test/ews.test.mjs          # live: реальные запросы к EWS (нужна сеть/VPN)
```

Live-тест читает `EWS_URL`/`EWS_EMAIL`/`EWS_PASSWORD` из окружения
(или из `test/.env`).

## Замечания и ограничения

- Провайдер наследует `CalStorageCalendar` — приватные интерфейсы
  Thunderbird; в manifest стоит `strict_max_version` (проверено до 160).
  При обновлении TB на сломанный хранилище проверяйте первым делом
  `applySync`/`getItem`.
- `SyncFolderItems` ограничен 512 записями на раунд — синк ходит циклами
  (до 20 раундов) до `IncludesLastItemInRange`.
- Пароль хранится в prefs календаря, зашифрованный SDR (Master Password
  защищает его так же, как сохранённые пароли почты).
- Удаление календаря из настроек удаляет его и из Thunderbird; записи в
  общей SQLite-базе (`local.sqlite`) при этом не вычищаются — так работает
  штатный менеджер календарей Thunderbird.
