# Production-деплой WinWidget

Это канонический steady-state runbook apps-only production. Исполняемым
источником истины является репозиторий `winwidget.ru_infra`:

- `README.md` — краткий обзор инфраструктуры;
- `docs/runbook.md` — текущие эксплуатационные контракты и checklist;
- `.github/workflows/deploy-production.yml` — production workflow;
- `scripts/deploy-services-production.sh` — routine backend deploy;
- `winwidget.ru_services/deploy/docker-compose.prod.yml` — канонический
  production Compose manifest;
- `nginx/` — канонические backend/frontend Nginx и Telegram bridge
  конфигурации.

Backend-код расположен в `winwidget.ru_services`, frontend — в
`winwidget.ru_frontends` (переименованный репозиторий `winwidget.ru_client`).

## Топология

```text
Frontend VPS
  -> Nginx
  -> Landing, Widgets, Admin и WinCRM в четырёх frontend-контейнерах

Backend VPS
  -> system Nginx
  -> API Gateway
  -> Identity, Billing, Campaigns, Reporting, Widgets
  -> Platform, Support, Operations, Notification Delivery
  -> service-specific workers, publishers и schedulers
  -> RabbitMQ
  -> отдельная PostgreSQL 18 database каждого доменного сервиса

Telegram bridge VPS
  -> inbound webhook reverse proxy
  -> HTTPS reverse proxy https://tg.winwidget.ru/telegram-api для backend
  -> отдельный публичный TLS passthrough :8443 к api.telegram.org
```

Внутренние API, PostgreSQL и RabbitMQ слушают только loopback/private network.
Публичными являются frontend, system Nginx API и согласованный Telegram relay.

### WinCRM: рабочее приложение и оплата в production

На 08.09.2026 `BILLING_WINCRM_PAYMENTS_ENABLED`,
`BILLING_WINCRM_RECONCILIATION_ENABLED` и `CRM_ACCESS_BILLING_ENABLED`
включены согласованной commerce-активацией. Widgets billing не менялся.
Это не доказательство реального списания, автопродления или фискализации:
денежные тестовые платежи агент не выполнял. Ниже указана история первоначального
закрытого запуска; её значения `false` не являются текущими настройками.

07.09.2026 рабочее приложение открыто на `https://crm.winwidget.ru`.
Авторизованный browser smoke подтвердил явный запуск Trial на 5 дней
с двумя местами, установку шаблона «Универсальные продажи@1», ручную заявку,
создание контакта/сделки/задачи, переход стадии с результатом и следующей
задачей, компанию, отдел и обновление аналитики. Цены и лимиты читаются из
редактора ADMIN `/admin/crm`; тарифы в этом smoke не изменялись.

Native Widgets проверен на собственном тестовом колесе: явное подключение,
доставка одной новой заявки в Inbox, затем явное отключение. История не
переносилась; полученная заявка сохранилась после отключения. Тестовые записи
помечены в названиях и оставлены в рабочем пространстве, реальных рассылок,
приглашений и платежей не выполнялось. Это не доказательство всех ролей,
остальных типов виджетов, платных сценариев или мобильной адаптивности.
Оставшиеся проверки находятся в service backlog; в этом первоначальном smoke
все три paid gates ещё были закрыты.

В `winwidget.ru_services/deploy/docker-compose.crm.yml` описан отдельный
Compose project `winwidget-crm`. Он не объединяется через `-f` с действующим
`docker-compose.prod.yml`. Первичный закрытый запуск выполняет отдельный scope
`crm-runtime` существующего pinned release controller, не routine scope `all`.
Само наличие конфигурации, зелёный shape test или запущенный CRM frontend
не разрешают запуск backend, открытие Gateway routes, Trial или продаж.

Первичная подготовка БД выполнена 07.09.2026 через services CI/CD
`34067866115` для `774db6490808cbaff4ff96033c589205cb3935f7`
с controller `6ab9828d9e8fdc058780514a5b434855c9924b07`.
Четыре owner PostgreSQL healthy, migration ledgers содержат соответственно
Access 6, Intake 8, Customers 4 и Sales 6 записей; точные checksums,
object grants и аутентификацию ролей проверил этап `crm-databases`.
Приложения, broker principals, Trial, платежи и публичные CRM routes этим
первичным выпуском не включены. Read-only замер после этапа: 4.83 GiB `MemAvailable`,
15.97 GiB свободного диска; это не доказательство полного runtime capacity.
При следующем запуске использовать свежую проверку состояния, а не этот снимок.

Отдельно 07.09.2026 выполнен broker bootstrap кодом infra
`3da542b4e9c0465307e7bb52d4db9b77c5b59a3a` после зелёного CI `34068864085`:
9 новых principals прошли реальную AMQP-аутентификацию, созданы 7 exchanges,
14 очередей и 18 bindings; прежние 16 пользователей и их права сохранены.
Операция выполнялась под общим production lock с проверкой env/image и всех
35 соседних контейнеров перед каждой мутацией. Canonical env переведён в
`CRM_RABBITMQ_CONTRACT=mvp-v1`, локальные/серверные байты и CI env hash сверены.
Это не включает приложения или бизнес-производителей: расширение точных
Identity/Billing/Widgets publisher ACL и invitation reader остаётся отдельным
шагом перед запуском соответствующих функций.

`scripts/crm-companion-env.mjs` готовит узкое дополнение canonical и четырёх
owner env (Identity, Billing, Widgets, Notification Delivery), сохраняя остальные
байты и текущие APP_REVISION. Пары берутся из существующего CRM env, уже созданный
Billing broker password повторно используется, несовпадение существующей пары
не вызывает автоматическую ротацию. Подготовка не включает продажи, native
connector или email producer/reader; provider drain настраивается вместе с
reconciliation, но начинает работать только при последующем runtime rollout.
Функция сама не пишет production-файлы: вызывающая операция обязана сверить
полные локальные/серверные файлы, установить их атомарно под общим lock,
повторно скачать, проверить совпадение и обновить CI hash.

Первое применение этой подготовки выполнено 07.09.2026 после CI `34070156108`
для infra `81b4dd0ee9e03f8a311c9e590fc375009eb60c2b`. Пять полных файлов
(canonical и четыре owner env) установлены под общим lock и повторно скачаны;
локальные/серверные байты совпадают, CI hash обновлён. Повторная read-only
подготовка не возвращает изменений. `validateCrmCompanionCompose` прошёл
на нормализованном Compose с этими private inputs; это проверка конфигурации,
не запущенных процессов. Последующий runtime cutover описан ниже.

Для этого cutover на VPS также подготовлены образы Identity, Billing, Widgets
и Notification Delivery из того же зелёного services SHA `774db649`.
Их полные OCI revisions сверены, текущие контейнеры не пересоздавались.
У Identity/Billing дополнительно проверяется owner title; существующие
Dockerfile Widgets/Notification Delivery содержат revision, но не title —
их отсутствие не является ошибкой сборки. После подготовки свободно 14.17 GiB
диска. Сборка выполнялась последовательно под общим deploy lock, без dump
и изменений существующих БД.

07.09.2026 companion cutover завершён: Identity, Billing, Widgets и
Notification Delivery работают на `774db6490808cbaff4ff96033c589205cb3935f7`
(девять процессов). Применены две миграции Identity, пять Billing и по одной
Widgets/Notification Delivery; проверены полные успешные ledgers и checksums.
Все девять runtime image IDs, env и конфигурации совпали с выбранным Compose,
health — healthy, restarts — 0, OOM — false. Четыре owner env повторно скачаны
и побайтово совпадают с локальными. Остальные 26 контейнеров не изменены.
На этом этапе продажи, native connector, invitation producer/reader и публичный
CRM оставались закрыты; последующее открытие маршрутов и producers описано ниже.

Полный закрытый CRM runtime запущен 07.09.2026 через зелёный production CI
`34074371923`: все 12 application containers используют
`837113b9f9f303bd6c043c2a2e37b0791369d7a3`, controller
`15c4a6b34334457542a2cbed8e0af453894e81a1`. Проверка после CI подтвердила
healthy, 0 restarts и отсутствие OOM; прежние 35 контейнеров не изменены.
Замер 01:59 UTC: 4.44 GiB MemAvailable, 14.94 GiB диска, memory PSI 0.
Это стартовый/idle замер, не доказательство capacity под рабочей нагрузкой.

В предыдущей закрытой попытке `2131c7c` специализированный Intake worker
не стартовал из-за обязательного `CRM_INTAKE_WIDGETS_ENABLED=true`.
Manifest теперь включает обработку отдельно для специализированных consumers,
сохраняя public API flags false. Девять application containers незавершённой
попытки пересозданы; базы, volumes, очереди и данные не удалялись.
Image CI проверяет фактический compiled role parser, не только shape Compose.

Публичный API cutover 07.09.2026 выполнен через `crm-public-release.mjs`: ровно восемь новых
Gateway prefixes, `crm-source` только для ingest; старые routes не изменяются.
Origin CRM добавляется Gateway/Identity/Billing/Widgets API, а origin общей
админки — четырём CRM API. Это не включает платежи, invitation email или
native widget producer. Восемь целевых API healthy, Gateway обновлён до
`837113b9f9f303bd6c043c2a2e37b0791369d7a3`, остальные 39 контейнеров не изменены.
Сверены полные owner env, process configs и image IDs. Семь защищённых prefixes
возвращают 401 без JWT, разрешают только согласованные browser origins;
ingest без source key возвращает 401. Это не заменяет авторизованный UI smoke.

Затем по зелёному infra `e1e3c2e2c90cc3414cd6c05e4b21e67044d3503a`
выполнена отдельная активация native Widgets и приглашений. Сначала расширены
точные resource/topic ACL трёх publishers и Notification Delivery; остальные
21 principal сохранены. Затем последовательно переключены семь процессов:
Notification Delivery reader, Billing eligibility API, обычные Intake
worker/publisher/API, Widgets producer и Identity invitation producer.
Каждый этап проверялся под общим lock; все семь healthy, остальные 40 контейнеров
не изменены. Новый invitation main/DLQ reader подключён, CRM main/DLQ очереди
не имеют накопленных сообщений. Доставка бизнес-сообщений проверяется отдельно.

Шесть полных env-файлов повторно скачаны и побайтово совпадают с локальными;
canonical SHA-256 — `7686a0459809851044ed96d69c44006c226c31354502b925771144640701e325`,
CRM env — `667977d5260de85dcfbc17ccac618446168773f67af5735ab7003bdbe36b4be1`.
CI canonical hash обновлён. На этом этапе `BILLING_WINCRM_PAYMENTS_ENABLED` и
`CRM_ACCESS_BILLING_ENABLED` оставались false. Активация не подключает виджеты
клиентов автоматически и не импортирует историю.

Первичная цепочка `crm-prepare -> crm-databases -> crm-runtime` уже не подходит
для следующего production push: её закрытые baseline/env и Gateway revision
устарели. Для следующего code rollout предназначен scope `crm-upgrade` ниже;
не обходить этот отказ через `all`, сброс env или удаление работающих приложений/БД.

### Обычное обновление WinCRM: `crm-upgrade`

Это отдельный code-only scope существующего pinned controller, не повтор
первоначального provisioning. Наличие кода scope в Git не означает его выпуск
в production. Сначала получить зелёный immutable infra SHA, затем отдельно
обновить pin reusable workflow в Services и дождаться всех обязательных gates
именно Services SHA, который совпадает с fetched `origin/prod`. Старый одноразовый
`billing-crm-commerce-acl` pin не является разрешением на этот rollout.

Обновляются только следующие группы в указанном порядке:

| Порядок | Владелец | Процессы |
| --- | --- | --- |
| 1 | Identity | Только `identity-api`; workers/publisher остаются прежними |
| 2 | Billing | worker, outbox-publisher, scheduler, API |
| 3 | CRM Access | worker, outbox-publisher, API |
| 4 | CRM Customers | API |
| 5 | Notification Delivery | Только worker; прежние разрешённые виды уведомлений |
| 6 | CRM Sales | API |
| 7 | CRM Intake | 3 workers, 3 publishers, API |

Всего 18 runtime-процессов. Перед стартом нового процесса останавливается вся
старая группа владельца; остановка соседних групп, БД, Gateway,
Widgets и остальных приложений запрещена. Новый Sales reminders-процесс этим
code-only scope не создаётся, отправка напоминаний не включается. Identity API — companion
для согласованного каталога сотрудников: его `schema.prisma` и весь каталог
Prisma migrations должны побайтово совпадать со старым работающим image.

После отдельной активации напоминаний marker
`CRM_REMINDERS_RABBITMQ_CONTRACT=task-reminders-v1` меняет только состав
code-only upgrade: 19 процессов, оба Sales входят в одну owner-группу.
Сначала останавливаются оба, затем запускаются reminders → API; ND по-прежнему
обновляется раньше Sales. Baseline формируется явным четвёртым аргументом
`crmUpgradeBaseline(live, gatewayRevision, envHashes, 'task-reminders-v1')` и
содержит этот marker. Controller сверяет его с canonical env, сохраняет оба
Services overlays и точную effective-конфигурацию уже работающих процессов.
Наличие контейнера не заменяет marker; лишние/отсутствующие процессы и любые
изменения env/ACL блокируют upgrade. При `disabled` сохраняются прежние
18 процессов и формат baseline без нового поля. Этот вариант не выполняет
первоначальное включение напоминаний и не создаёт нового broker principal.

08.09.2026 config-only активация reminders на Services `2d8f219a03df6ad02489e95ca3a091ac21f44c2b`
(CI `34219743600`, deploy `34220404277`) остановилась после admission при
финальном сравнении broker snapshot. RabbitMQ материализовал `x-queue-type: classic`
в десяти ND-очередях; остальные аргументы совпали. Read-only проверка подтвердила
26 principals, 12 новых очередей и ожидаемые ND ACL; `broker.json` и `start-*.json`
не созданы, прежние CRM-процессы остались healthy. Исходный journal сохранять:
не удалять admission/очереди, не сбрасывать credentials и не повторять старый SHA
после исправления verifier. Совместимый forward-выпуск требует нового зелёного
pin, прежнего точного runtime/env baseline и проверки существующей topology;
само добавление явного значения `classic` не разрешает другие типы/аргументы.

Совместимый forward-выпуск завершён на Services `1a26d7d8f9fa67593391c7bbdbbfc92bb659696a`,
Infra `1a3cd1dd276f249a415c90f51c4084e69257e6da`: Services CI `34228898582`
и production `34229448464` — SUCCESS. ND worker, новый Sales reminders и
Sales API healthy; исходные immutable images сохранены, правила пользователей
не включались. Это подтверждение инфраструктурной готовности, не реальной доставки.

Следующий code-only выпуск Services `e68a42553592d7a14cca8c80be935918465917bb`
(CI `34230784453` — SUCCESS, production `34231245624` — FAILURE) остановился
до plan/SQL/остановки runtime: прежний Intake source gate запрещал изменение
schema/ACL даже для внесённой в allowlist SLA migration. Исправление допускает
только точную forward-пару schema, ACL и `20260908150000_add_intake_sla`;
старые SQL и migration lock остаются неизменными. Восемь focused tests и
сверка исходников `6bce89bb -> e68a4255` прошли. Продолжение требует нового
green Infra/Services SHA и повторной сверки прежнего runtime/env baseline;
повтор старого failed SHA с изменённым кодом не допускается.

Продолжение завершено: Infra `c3882a99f3f3fdc1822246e77882e9774533001c`
(CI `34233836633` — SUCCESS), Services
`6eab2581089a90ccb88ca08ba9bae0481d483d1e` (CI `34235625042`, production
`34235994499` — SUCCESS). Повторная сверка 19-role baseline сохранила hash
`4f9c5072a49d3b9d0099fc151237533dcdecb5d26e7a760a6671fad432e07273`.
Для reminders/SLA envelope применяется gzip level 9 вместо 6; прежние
ограничения размера, hashes и decompression checks сохранены. Локально
прошли 19 activation tests; внешние сообщения и платежи этим не проверяются.

### Отдельная активация Intake SLA

`crm-intake-sla-activate` — второй закрытый вариант того же activation controller,
не общий rollout. Перед ним выполнить code-only `crm-upgrade`: readers Access,
Intake и Notification Delivery должны уже содержать SLA-контракты. У Intake
требуется применённая `20260908150000_add_intake_sla` и exact runtime grants.
При pending этой миграции controller останавливает старую Intake owner-группу
до SQL/grants, чтобы acceptance-trigger не получил окно `42501`; retry использует
тот же forward switching marker. Sales task-trigger migrations имеют тот же gate.

Базовые reminders должны уже работать. SLA не включает правила пользователей,
не импортирует историю и не отправляет provider smoke автоматически. Подготовить
полные двусторонне синхронизированные canonical/CRM/ND env:

- canonical marker `CRM_INTAKE_SLA_RABBITMQ_CONTRACT=intake-sla-v1` при прежних
  `CRM_RABBITMQ_CONTRACT=mvp-v1` и `CRM_REMINDERS_RABBITMQ_CONTRACT=task-reminders-v1`;
- CRM `CRM_INTAKE_SLA_ENABLED=true`, отдельные
  `CRM_INTAKE_SLA_WORKER_DATABASE_URL` (pool 2) и
  `CRM_INTAKE_SLA_PUBLISHER_DATABASE_URL` (pool 1), тот же собственный Intake DB
  principal/schema/password, без чужих таблиц;
- отдельные `CRM_INTAKE_SLA_WORKER_RABBITMQ_URL` и
  `CRM_INTAKE_SLA_PUBLISHER_RABBITMQ_URL` с различными credentials;
- парные `CRM_INTAKE_NOTIFICATION_DELIVERY_TOKEN` и
  `NOTIFICATION_DELIVERY_CRM_INTAKE_TOKEN` в соответствующих трёх env,
  ND `CRM_INTAKE_INTERNAL_BASE_URL=http://127.0.0.1:5310` и прежние 14 kinds
  плюс `wincrm-intake-sla-email,wincrm-intake-sla-telegram` (ровно 16).

После подготовки вызвать `crmRemindersBaseline(live, gatewayRevision, hashes,
'winwidget.crm.intake-sla-activation.v1')`. Fresh root-owned `0600` baseline:
`/opt/winwidget/deploy/backend/crm/intake-sla-activation-baseline.json`.
Он фиксирует два новых процесса как absent, текущие ND worker и Intake API,
все неизменные соседние runtime и три полных env hash. Workflow scope —
`crm-intake-sla-activate`; hash передаётся в существующий
`expected_crm_reminders_baseline_sha256`. Kind, scope и отдельный journal
`crm/intake-sla-activations/<services-SHA>/` не допускают повторного использования
baseline обычных reminders.

Под глобальным lock выполняются read-only DB/ledger/ACL preflight, durable admission,
additive exact broker provisioning (2 direct exchanges, 12 queues, 18 bindings,
2 новых principals), затем только ND worker → SLA worker `5317` → SLA publisher
`5318` → Intake API. Worker только читает свою очередь, publisher пишет только
свои exchanges и два ND topics; прежние credentials, очереди, содержимое и
consumers не удаляются. Готовность 16-kind ND проверяется приватным GET до producer.
Unknown create outcome сохраняет start receipt и допускает только наблюдение,
не повторный create/rollback. Контроллер не делает HTTP provider sends.

Следующий `crm-upgrade` сохраняет marker и оба overlay, обновляет ровно 21 процесс.
Baseline требует пятый аргумент `'intake-sla-v1'` после `'task-reminders-v1'`.
Два SLA процесса входят в существующую Intake owner-группу, выключенный путь
по-прежнему содержит 18 процессов (19 только с reminders). Нельзя убрать marker,
overlays или credentials ради прохождения upgrade. Реальные доставка/отмена и
доступность мобильного UI проверяются отдельно на согласованных пользователях.

Перед запуском нужны свежие read-only свидетельства, не ревизии из исторического
раздела этого документа:

1. Убедиться, что текущие контейнеры здоровы, не перезапускаются, PostgreSQL
   service identities/ledger/ACL согласованы, хватает диска и не менее 2.5 GiB
   `MemAvailable` для последовательной сборки/старта. Во время rollout остаётся
   минимум 2 GiB; дополнительное потребление runtime ограничено 3 GiB.
2. Через экспорт `crmUpgradeBaseline()` из проверенного `crm-release.mjs`
   сформировать baseline из полного свежего `docker inspect` inventory
   (включая остановленные контейнеры) и SHA-256 пяти **полных** env-файлов:
   canonical backend, CRM, Billing owner, Identity owner, Notification Delivery
   owner. После конфигурационной активации нужен новый baseline. Сам JSON baseline
   содержит только IDs/image IDs/revisions/configuration hashes и общий hash
   нетронутых соседей; значения env туда не попадают. Исходный inspect с env
   нельзя выводить в логи. CLI `upgrade-baseline` принимает inspect через stdin,
   `CRM_GATEWAY_REVISION` и `CRM_UPGRADE_ENV_HASHES` — только эти public hashes.
3. После проверки exact target map и соседей зафиксировать approved baseline
   как root-owned mode `0600`
   `/opt/winwidget/deploy/backend/crm/upgrade-baseline.json`. Передать его SHA
   отдельным input `expected_crm_upgrade_baseline_sha256`; Gateway revision —
   `expected_live_revision`, CRM env SHA — `expected_service_env_sha256`.
   Canonical env SHA передаётся существующим secret reusable workflow.
   Счётчика «всегда 31/47 контейнеров» нет: проверяется точная свежая карта,
   все нетронутые контейнеры и четыре существующие CRM БД.
4. Запускать только pinned reusable workflow с `release_scope=crm-upgrade`.
   Нельзя подменять scope, SHA, baseline или owner env ради прохождения gate.
   Общий production lock и неизменность исходников/env повторно проверяются
   перед SQL и переключениями. Ни env, ни paid flags, ни broker credentials,
   permissions, topology, volume/DB bootstrap данный scope не меняет.

Controller сначала собирает и проверяет семь immutable owner images, их OCI
revision/title/архитектуру; сравнивает старые Prisma-файлы со source candidate;
запечатывает desired Compose только для 18 targets и шести migration jobs.
Runtime допускает только новые image/APP_REVISION: остальные env, isolation,
healthchecks, ресурсы и конфигурация должны совпадать с approved live snapshot.
Все семь owner DB проходят read-only preflight **до первой мутации**.

У Notification Delivery исторически нет `service_identity`. Вместо создания
фиктивного UUID проверяется отдельный continuity contract: точный endpoint,
database/schema, PostgreSQL database OID и первая завершённая запись migration
ledger. Старые записи ledger, роли, memberships и ACL обязаны сохраниться.
OID берётся из свежего preflight, а не зашивается в код. Изменения ролей и
bootstrap этот контракт не разрешает. ND image проверяется по immutable image
ID, точному порядку владельцев и revision; у него нет title label, runtime user
остаётся `node`. Отдельные source/database probes работают как `1000:1000`;
для остальных владельцев сохраняется `1001:1001`. Migration URL ND читается
только из `NOTIFICATION_DELIVERY_MIGRATION_URL_PRODUCTION` его owner env.

Для Identity/Billing membership preflight допускает только два проверенных
существующих ребра: собственные `_migration` и `_runtime` выданы собственному
`_admin` (он же grantor), с `admin_option=false`, `inherit_option=true`,
`set_option=true`. Этот `_admin` обязан оставаться LOGIN/SUPERUSER и владельцем
своей БД. Обратные, дополнительные и чужие memberships запрещены; сами
migration/runtime не получают членство в admin или других ролях. У четырёх
CRM и у Notification Delivery membership остаётся нулевым в обоих направлениях. Полный граф, затрагивающий
migration/runtime, сохраняется в DB evidence и обязан совпадать до/после
миграций. Проверка не выполняет GRANT/REVOKE/ALTER ROLE и не ослабляет отдельный
restore gate: historical admin edges не нужно удалять ради обычного upgrade.

Сравнение companions учитывает только эквивалентные представления Compose:
`extra_hosts` как object или массив с `=` / `:` должен точно совпадать с live
host/address map, включая существующий Telegram proxy Identity. Добавление,
удаление или изменение записи блокирует release. Составные длительности
(`1m30s` и `90s`) сравниваются в точных наносекундах; невалидное значение,
округление долей наносекунды и изменение healthcheck/stop timeout запрещены.
Это нормализация формы, а не разрешение изменять approved конфигурацию.

Проверка старого и нового image не требует расширения Linux capabilities:

- `upgrade-source` работает как `1001:1001`, `network=none`, читает только
  image-owned `/app/prisma`; из хоста получает лишь hash-verified публичный
  verifier mode `0444`. Это поддерживает исторические Prisma-файлы `0600`
  и каталоги `0700` после checkout с `umask 077` без изменения их прав.
- `upgrade-database-input` работает как root без сети и читает только выбранный
  существующий owner env и approved `live.json` через read-only file mounts.
  Он проверяет единственный нужный runtime и формирует ограниченный handoff:
  `owner`, один migration URL, runtime host/port/principal/database/schema.
  Runtime password и остальные значения env в handoff не попадают.
- Только после успешного завершения preparer handoff передаётся через stdin
  в `upgrade-database` под `1001:1001`. Краткоживущая shell-переменная не
  экспортируется; файловых копий, credential argv/Docker env и private mounts
  у DB verifier нет. Он повторно проверяет весь binding перед прежними
  read-only PostgreSQL identity/ledger/ACL probes; сеть `host` остаётся только
  у этой проверки существующей owner DB. Ошибка preparer не запускает DB probe.

Во всех режимах остаются `cap-drop ALL`, `no-new-privileges`, read-only rootfs
и default seccomp; `DAC_READ_SEARCH`, `DAC_OVERRIDE` и privileged не добавляются.
Другие режимы, включая CRM `upgrade-grants`, сохраняют прежнюю root/no-cap
изоляцию. Не запускать `upgrade-database-input` напрямую в терминал, CI log,
файл или artifact: его вывод содержит migration credential и предназначен
только для внутреннего stdin handoff. Настройки и права runtime не меняются.

Миграции — только расширяющие, явно reviewed checksum allowlist в
`CRM_UPGRADE_MIGRATIONS`: Billing manual days, Access employee profiles/branding,
Sales workday/reminders, Customers requisites/call preferences и расширение
allowlist видов Notification Delivery. Старый Billing ACL release уже должен быть успешно завершён;
единственная reviewed rolled-back попытка остаётся историей, не повторяется и
не разрешает `migrate resolve`. Для Sales `add_task_in_progress` и следующий
`expand_workday_tasks` остаются разными migration-файлами: Prisma завершает
первую транзакцию с enum **до** использования значения следующей миграцией.
Identity/Intake не допускают новых миграций в этом release scope. Для Customers
разрешены только последовательные парные экспансии. `20260907210000_add_company_requisites`:
SHA-256 SQL `2906853950f496d481dc831af21d824418ecd7281f105ad3b3356e98c90fbfc1`
и переход SHA-256 `schema.prisma` с
`be7b6d591352f4dbd77310df08f3d27971a49ede45cb653a8ff6ac6ea2823b12` на
`7d17e1d8b4cdc31cea0e342427aa84d1b388d3f22515b2e5cfcacde1afe79b42`.
Затем `20260907223000_add_contact_call_preferences`:
SHA-256 SQL `6ec838976adc8aa583b29a7732fe9cbddabb60d63ab7efd3b67c7d78968e0fec`,
переход последней схемы на
`4ceda3fabb6a6923f5a75c540ff01b89926ea0d8c27c1f40e6e57e8fa40c51d2`.
Для ещё не обновлённой схемы допускается применение обеих точных пар подряд.
Одна половина этой пары без другой, новые/изменённые прежние SQL и изменение
`database-access.json` запрещены; уже применённая неизменная пара допускается.

В каждом owner: при наличии pending применяется только `prisma migrate deploy`
от migration-role, затем для CRM исполняется service-owned точный runtime grants
contract (без bootstrap/смены паролей), проверяются ledger, database identity,
неизменность прежних ACL/ролей и Billing append-only/retention guards. Затем
переключается группа и проверяется каждый image/config/health/zero-restart.
SQL rollback/restore БД в автоматической recovery не выполняется.

При обрыве запечатанный private план и исходные DB proofs сохраняются в
`deploy/backend/crm/upgrades/<services-SHA>/` (root `0700`, файлы `0600`). Это
временные release/recovery artifacts с приватной конфигурацией, **не backup**;
их нельзя публиковать как CI artifacts, выводить или удалять до завершения
recovery. Повторить можно только тот же Services/infra SHA, baseline и env:
готовые группы не перезапускаются; остановленная/частичная активная группа
завершается на том же новом image. Допустимы только готовый префикс групп,
одна записанная активная группа и нетронутый суффикс. Потерянный исходный DB
proof, неизвестный контейнер/image, changed neighbor, unfinished migration или
ACL drift останавливают retry. После новых enum/standalone task записей старый
Sales writer возвращать нельзя. Исправление — reviewed forward release после
анализа, не откат БД или ослабление проверок.

Перед объявлением MVP выпущенным отдельно проверить RabbitMQ consumer counts,
main/retry/DLQ и текущие bindings/permissions без мутации broker; private/public
HTTP contracts, employee directory/assignment, manual days + cancel receipts,
существующий Widgets сценарий и авторизованный адаптивный browser smoke.
Health-check controller не заменяет эти проверки и не открывает платёжные
флаги. Новый Workday UI/writers включать только после совместимого backend и
его собственных release gates; реальный платёж остаётся отдельной проверкой.

Локальные infra тесты используют command doubles для порядка/partial retry
и pure checks для exact map/source/ledger/ACL. Отдельный CI Services проверяет
реальные owner migrations/grants, enum split и business contracts. Перед
production нужно получить зелёные оба immutable SHA; локальный mock-прогон
не объявлять проверкой production PostgreSQL или успешным деплоем.

### Отдельная активация оплаты WinCRM: `crm-commerce-activate`

Это **config-only** scope после успешного code-only rollout совместимых readers.
Наличие контроллера или зелёного CI не означает, что оплата уже включена.
Существующие image IDs и APP_REVISION сохраняются; сборок, миграций, изменения
ролей/ACL, broker, Nginx, frontend, Widgets-оплат и вызовов платёжного провайдера
в этом scope нет. Последовательно пересоздаются ровно семь процессов:

1. `winwidget-crm/crm-customers-api`;
2. `winwidget-crm/crm-access-worker`;
3. `winwidget-crm/crm-access-outbox-publisher`;
4. `winwidget-crm/crm-access-api`;
5. `winwidget/billing-worker`;
6. `winwidget/billing-scheduler`;
7. `winwidget/billing-api`.

До запуска отдельно согласованно синхронизировать три **полных** env-файла:
canonical `deploy/backend/.env.production`, Billing owner
`winwidget.ru_services/apps/billing/.env.production` и CRM owner
`deploy/backend/crm/.env.production`. Для каждого сначала скачать серверную
копию и сравнить с локальной, затем атомарно установить под общим deploy lock,
повторно скачать и доказать побайтовое совпадение. Controller сам env не меняет.
Допустимы только `BILLING_WINCRM_PAYMENTS_ENABLED=false→true` в трёх Billing
процессах и `CRM_ACCESS_BILLING_ENABLED=false→true` в трёх Access-процессах;
reconciliation worker/scheduler должен стать или остаться `true`.
`CRM_CUSTOMERS_DADATA_API_KEY` допускается только Customers API: отдельно
одобренный ключ либо пустое optional значение, без передачи другим ролям.
Все прочие effective env, credentials, ресурсы и isolation должны совпасть.

После синхронизации создать свежий baseline через `crmCommerceBaseline()` из
проверенного `scripts/crm-commerce-activation.mjs`: полный inventory обоих
Compose projects, актуальная Gateway revision и hashes `{canonical,billing,crm}`
подготовленных полных файлов. Сохранить `JSON.stringify(baseline) + '\n'` как
root-owned `0600` файл
`/opt/winwidget/deploy/backend/crm/commerce-activation-baseline.json`.
Baseline содержит IDs/revisions и hashes, но не значения env; исходный inspect
с приватной конфигурацией нельзя выводить или публиковать.
Pinned reusable workflow получает `release_scope=crm-commerce-activate`,
`expected_crm_commerce_baseline_sha256`, `expected_live_revision` (Gateway)
и `expected_service_env_sha256` (CRM owner). Canonical hash передаётся через
`BACKEND_PRODUCTION_ENV_SHA256`; Billing hash закреплён внутри baseline.
У другого scope этот activation input должен быть пустым.

Под общим production lock выполняется READ ONLY preflight существующих Billing,
Access и Customers БД: PostgreSQL 18, точные UUID/schema/principal, image source,
завершённый ledger и неизменные роли/ACL. До первого admission требуется свежий
снимок без CRM orders, renewals, provider operations, paid periods, due renewals,
недоставленных provider deliveries/outbox и Access billing operations/capacity
fences. При ненулевом счётчике не удалять данные и не обходить gate: остановиться
для отдельной оценки уже существующей коммерческой активности. Проверка не
создаёт платёж и не подтверждает внешнюю фискализацию; реальные первоначальный
и рекуррентный платежи остаются отдельной проверкой с участием пользователя.

Private plan, binding и recovery receipts сохраняются в
`/opt/winwidget/deploy/backend/crm/commerce-activations/<services-SHA>/`
(`0700`, файлы `0600`). Это приватные release artifacts, не backup и не публичные
CI artifacts. Durable `admission.json` появляется **до первой остановки**;
после него разрешено только продолжение того же Services/Infra SHA, baseline,
env и запечатанного плана. Новый коммерческий спрос после admission допустим,
но повторный preflight по-прежнему проверяет DB identity/ledger/ACL.
Готовый префикс не перезапускается, соседи сохраняют IDs/config/StartedAt.

Перед каждой единственной попыткой Compose сохраняется `start-N.json`, затем
`observed-N.json` привязывает фактически увиденный новый ID/StartedAt; завершение
шага требует exact config и healthy без restart. При timeout/обрыве ответа
**не повторять создание автоматически**: повторный запуск только наблюдает
исходную попытку и продолжает подтверждённый префикс. Если новый контейнер не
появился или утрачен receipt, требуется отдельно reviewed forward recovery.
Нельзя удалять marker, готовить новый plan, возвращать старые readers или
объявлять отсутствие контейнера доказательством, что предыдущий запуск не
состоялся. Health-check не заменяет авторизованный billing/browser smoke.

07.09.2026 успешно выполнен scope `billing-crm-commerce-acl`:
одна immutable migration `20260909110000_restrict_wincrm_commerce_runtime_acl`,
без новых images, restart, env/broker изменений и включения платежей. Inputs —
фактическая ревизия Billing и SHA его полного owner env. Preflight сверяет
старые Prisma-файлы с текущим image, service identity, ledger и текущий ACL;
postflight требует тот же database UUID и hash всех нетронутых ACL. Все
контейнеры (включая 12 CRM-процессов и их БД) входят в общий fingerprint.
Migration выполняется отдельным процессом с Billing migration-role; секретный
временный файл удаляется при завершении. Это не общий rollout остальных сервисов.
После ошибки не повторять автоматически: проверить ledger и фактический ACL,
не выполнять `migrate resolve` или расширение прав ради зелёного деплоя.

Попытка CI `34080713661` остановлена guard исторической Billing runtime-роли:
`INHERIT=true`, хотя memberships отсутствуют. Транзакция SQL откатилась,
девять ACL не изменились; Prisma сохранил одну unfinished запись с нулём
applied steps и `logs=null`. Для неё подготовлена отдельная reviewed recovery:
ID `412a6ec9-35c7-4c1a-ad94-b11dbae1e889`, started
`2026-09-07T03:47:48.537639Z`, прежний immutable migration checksum.
Перед любым изменением проверяются exact ledger, прежние ACL, отсутствие
активных migration connections и memberships runtime-роли. Только после
этого Billing admin выставляет ей `NOINHERIT` (эффективные права при нулевых
memberships не меняются), а Billing migration-role выполняет штатный
`migrate resolve --rolled-back` исключительно для этой попытки. Исходная
запись сохраняется; SQL не переписывается и не помечается applied без запуска.
Это не автоматический recovery неизвестных ошибок и не разрешение удалить
ledger, расширить права или включить оплату.

Recovery и миграция завершены production CI `34081704073` для services
`bb86a0c2e1d4feb21171f8b6562dbf80fe783b8c`, pinned infra
`d7186926fae0133ce4fa90a4ab4acc554df1ed6e`. Повторная read-only проверка:
11 успешных миграций, одна сохранённая rolled-back попытка, незавершённых нет;
у всех девяти таблиц DELETE/TRUNCATE false, consent UPDATE false,
защитная routine EXECUTE false. Runtime-роли выставлен NOINHERIT,
memberships по-прежнему 0. Прежние таблицы/default ACL, env и все 47
контейнеров сохранены; healthy, 0 restarts, без OOM.
Замер 04:07 UTC: 4.19 GiB MemAvailable, 14.97 GiB диска. Платные gates
не менялись. Повторять этот одноразовый recovery после успеха нельзя:
его admission требует исходную конкретную unfinished запись.

При первой попытке дочерняя Compose-команда прочитала остаток SSH-сценария
из stdin после миграций Identity. Три Identity-процесса были восстановлены
на новой совместимой версии, без отката БД/старого writer; затем завершено
переключение остальных владельцев. Для операторского shell использовать
`companionShellInput`: весь сценарий разбирается до запуска дочерних команд,
stdin закрыт. Миграции запускаются с `--interactive=false -T`; успех требует
не только exit 0, но и `finished:0:complete` после финальной проверки runtime.
Оба случая покрыты regression-тестами.

Состав профилей:

| Профиль          | Состав                                   | Назначение                                             |
| ---------------- | ---------------------------------------- | ------------------------------------------------------ |
| `crm-runtime`    | Access 3, Intake 7, Customers 1, Sales 1 | 12 раздельных API/worker/publisher процессов           |
| `crm-databases`  | 4 PostgreSQL 18                          | Собственные БД, сети, volumes и admin password files   |
| `crm-migrations` | 4 однократных процесса                   | Тот же immutable image, отдельная migration credential |

Без явно выбранного профиля ни один сервис не активен. Не задавать
`COMPOSE_PROFILES` глобально и не запускать все миграции параллельно:
ресурсный отчёт предусматривает только одно последовательное migration job.
Нет дополнительных RabbitMQ, Identity, Billing, Gateway или общего CRM API.

Этот вариант предназначен только для одного проверенного backend VPS:
процессы работают через host network и слушают `127.0.0.1:5300–5330`;
PostgreSQL публикуют только собственные `127.0.0.1:55442–55445`.
Отдельные обычные bridge networks сохраняют текущий проверенный контракт
loopback port publishing; они не объединяют базы и не заменяют DB grants.
При переносе CRM на другой VPS требуется отдельная проверенная private
topology/HTTPS ingress. Подстановка удалённого адреса в этот same-VPS
контракт не поддерживается валидатором.

`deploy/crm/.env.example` в services — только список структурных входов.
Пустые images/revisions/credentials/resource caps намеренно блокируют даже
`compose config`; не копировать пример в production и не принимать
синтетические значения из тестов за бюджет размещения. Будущий controller
должен побайтово синхронизировать canonical production env и материализовать
отдельные service-owned файлы тем же атомарным способом, что основной контур.
Runtime получает только явно перечисленные переменные своего сервиса;
migration не получает HTTP/RabbitMQ credentials, API не получает broker URL.
Секрет администратора каждой БД хранится отдельно в
`/opt/winwidget/deploy/backend/secrets/crm-<service>-postgres-admin-password`
с проверенными `root:root 0600`, без symlinks; runtime его не монтирует.
Shape validator проверяет только точный путь, не наличие/owner/mode файла.

Восемь background roles используют восемь разных broker principals вида
`winwidget-crm-<service>-<role>` в существующем vhost `winwidget`.
Наличие URL не доказывает ACL, durable bindings, delivery или восстановление.
Пары HTTP-токенов проверяются на совпадение внутри CRM; согласованность
с Identity/Billing/Widgets также проверяется companion controller.
Commerce и оба native Widgets flags в исходном шаблоне выключены;
фактическая активация native в production описана выше отдельно.

Shape-проверка выполняется без Docker daemon, контейнеров и чтения production:

```bash
# Из корня winwidget.ru_services
node --test .github/scripts/validate-crm-compose.test.mjs
```

Исполняемый validator `.github/scripts/validate-crm-compose.mjs` получает
нормализованный Compose JSON только по stdin и возвращает безопасный отчёт
без environment/credentials. Даже при корректной форме отчёт содержит
`capacityVerified:false`, `credentialsProvisioned:false`,
`releaseApproved:false`. Не выводить исходный `compose config` в CI/SSH logs.
Пулы ограничены 40 runtime connections: Access 10, Intake 20, Customers 5,
Sales 5; migration pool 1. Memory/CPU caps обязательны, но не имеют
idle-derived значений по умолчанию. Сумма caps не доказывает реальный пик.

`crm-runtime` запускается только после подготовки четырёх owner БД и broker
principals. Он проверяет исходный sealed receipt, неизменённый CRM env, четыре
image IDs/OCI revisions, аутентификацию runtime DB roles и полные migration
ledgers. Соседние сервисы и четыре CRM PostgreSQL входят в неизменяемый
fingerprint на протяжении запуска. Создание БД, миграции, broker ACL, env,
Gateway и feature flags этот scope не изменяет.

Закрытость продукта проверяется по API/producer gates, а не выключением
специализированных consumers. `widget-control-*` получают
`CRM_INTAKE_WIDGETS_ENABLED=true`; `widget-transfer-*` дополнительно получают
`CRM_INTAKE_WIDGET_TRANSFERS_ENABLED=true`. Эти process-local overrides
позволяют подготовить обработчики до включения API и producer Widgets.
Сам Intake API сохраняет оба false из CRM env. Старый manifest с одинаковыми
false во всех ролях несовместим с защитой bootstrap специализированных workers.

12 приложений запускаются последовательно с явным `--no-deps --no-build
--pull never --no-recreate`; каждый фактический контейнер проходит проверку
image/env, прав, mounts, health и ресурсных ограничений. Повторный запуск
принимает только точно совпадающие здоровые процессы: это не контроллер
обновления на другую ревизию. Остановленные, чужие или несовпадающие процессы
требуют отдельного восстановления; автоматический rollback БД запрещён.
Перед каждым стартом требуется запас 2.5 GiB, после — минимум 2 GiB, рост
потребления памяти во время запуска не должен превышать 3 GiB. Эти проверки
не заменяют нагрузочную проверку CPU/pools/очередей и не открывают продажи.

Перед следующими обновлениями нужны свежая сверка owner DB/image/migration
evidence, broker ACL/bindings, runtime и запас ресурсов. До открытия платных
продаж остаются business/payment/browser проверки из service backlog.

Подготовительный scope `crm-prepare` проходит через тот же pinned reusable
workflow и `deploy-services-production.sh`, общий root-owned deploy lock и
точный fetched `origin/prod`. Он использует отдельные hash-pinned payloads
`deploy-crm-scoped.sh` и `crm-release.mjs`; остальные scopes и запрет обходить
Notes finalization через `all` сохраняются. Для него:

- `EXPECTED_LIVE_REVISION` — фактическая ревизия текущего Gateway;
- `EXPECTED_PRODUCTION_ENV_SHA256` — согласованный hash canonical backend env;
- `EXPECTED_SERVICE_ENV_SHA256` — hash отдельного подготовленного
  `/opt/winwidget/deploy/backend/crm/.env.production`, root:root 0600;
- локальную копию CRM env хранить в `deploy/backend/crm/.env.production`,
  синхронизировать с VPS по тем же двусторонним правилам, без значений из
  `.env.example`. Сам scope ни один production env не изменяет;
- не передавать Operations/destructive/Support authorization или frontend
  companion secrets. Все четыре CRM services revisions совпадают с выбранным
  точным source commit.

Scope последовательно собирает четыре owner images или повторно проверяет
уже существующие `winwidget-crm-*:git-<SHA>` без перезаписи их tags.
Для Node-проверок используются неизменяемые Docker images; Node.js на VPS
не требуется. Между этапами проверяются env/source/lock и fingerprint всех
текущих соседних running containers, включая их конфигурацию, mounts, restart
count и состояние health. Оба этапа одинаково исключают из этого fingerprint
только четыре собственные CRM PostgreSQL; их точную конфигурацию отдельно
проверяет этап БД. Поэтому новая подготовка после первого создания БД не
меняет смысл fingerprint. Любой CRM runtime или неизвестный CRM container
по-прежнему блокирует эти начальные этапы. Compose получает только подготовленный CRM env и фактические
image IDs, без ambient shell overrides. Сервисный shape validator и проверка
OCI owner/revision/architecture выполняются до сохранения артефактов.

Результат — root-owned 0600 `desired.json` и `receipt.json` в
`deploy/backend/crm/releases/<SHA>/`; повтор допускает только те же bytes.
Временные данные удаляются. Это входы следующего release stage, не резервная
копия БД и не доказательство успешной активации. Receipt всегда содержит
`capacityVerified:false`, `credentialsProvisioned:false`,
`migrationsApplied:false`, `runtimeDeployed:false`, `releaseApproved:false`.
Scope не вызывает runtime `up/stop`, migration, broker provisioning, смену
Gateway routes или flags. Не использовать появившиеся файлы вместо свежих
проверок после прерванной подготовки. До запуска scope на production нужен
обычный resource preflight для последовательных image builds; подготовка не
доказывает CRM capacity.

#### Отдельный этап `crm-databases`

Scope использует тот же root controller, lock, transport и три одобренных
baseline/hash inputs. Он требует уже запечатанную подготовку **того же**
services/infra SHA, env, images и состояния соседних контейнеров. Смена
inputs не разрешает перезаписать прежний receipt: нужен новый согласованный
release candidate и новая подготовка. Routine `all` этот этап не запускает.
При подключении в services workflow оба reusable jobs должны идти последовательно
для одного `github.sha`: сначала `crm-prepare`, затем `crm-databases`. Отдельный
commit для смены scope между этапами изменит source SHA и не совпадёт с sealed
подготовкой. Между ними нельзя менять соседний runtime или canonical env.

Перед применением отдельно подготовить и побайтово сверить локальные и
серверные admin/backup password files всех четырёх владельцев:
`deploy/backend/secrets/crm-<service>-postgres-{admin,backup}-password`.
На VPS — `/opt/winwidget/` перед этим путём, root:root 0600, без symlinks.
Каждый пароль — независимые 48–128 lowercase hex символов, допустим один
финальный LF. Runtime/migration passwords остаются только в соответствующих
URL приватного CRM env. Сам scope не генерирует, не переносит и не ротирует
production secrets; существующие роли должны успешно пройти TCP-проверку
пароля **до** повторного bootstrap. Backup role здесь только ограниченная
роль PostgreSQL: dump, backup job, копии данных и расписания не создаются.

До первого `up` проверяются все owner manifests и credentials, выключенные
product flags, точный digest PostgreSQL 18 и доступная RAM: сумма четырёх
DB caps + наибольший последовательный migration cap + 128 MiB verifier +
2 GiB резерва хоста. Это консервативный gate этапа БД, а не измерение пика
12 runtime-процессов. Обычный disk/CPU preflight всё ещё обязателен.

Создаются только отсутствующие четыре owner PostgreSQL containers. Существующие
должны быть единственными, healthy и соответствовать sealed image/config,
лимитам, loopback ports, owner volumes/networks и приватным secret mounts;
неизвестные CRM containers, в том числе остановленные jobs, блокируют этап.
Для каждого владельца последовательно выполняются service-owned role bootstrap,
реальная аутентификация трёх ролей, migration job из того же immutable image и
проверка точных migration checksums/object ownership/runtime grants.
SQL с паролями идёт только по приватному stdin pipeline; verifier использует
`--log-driver none`, чтобы не сохранять этот поток в Docker logs.

Повтор не пересоздаёт БД и не меняет пароли. При отказе сохраняются все созданные
БД/volumes и применённые миграции; автоматические down/reset, удаление данных и
откат DDL запрещены. Перед повтором устранить причину и восстановить те же
проверяемые inputs. Удаляются только временные verification files.
Успех этапа не меняет preparation receipt на `releaseApproved:true` и не
включает приложения, RabbitMQ, payments, Trial или Gateway routes.
Broker provisioning и rollout companion/runtime выполняются отдельными
этапами, не внутри database scope; их production evidence описан выше.
Полный runtime load proof остаётся отдельной проверкой перед ростом нагрузки.

До первого CRM provisioning выпустить совместимый routine controller.
Его canonical backend env принимает `CRM_RABBITMQ_CONTRACT=disabled`
(также значение по умолчанию при отсутствии переменной) или `mvp-v1`.
Другие значения, включая пустое, блокируют выпуск. `disabled` сохраняет
прежние 16 пользователей; `mvp-v1` требует ровно прежние 16 плюс восемь
process-scoped CRM principals из Compose и отдельного
`winwidget-billing-wincrm-provider-worker` — всего 25. Это consumer внутри
существующего Billing worker, не пятый CRM-сервис. Любой лишний или отсутствующий
пользователь блокирует preflight и steady-state; discovery/wildcard нет.
Routine controller не создаёт и не меняет CRM credentials/ACL/queues.
В `mvp-v1` controller сохраняет точные дополнительные producer permissions:

- Widgets: `widgets.wincrm.lead-transfer.requested.v1`;
- Identity: `identity.wincrm.invitation-accepted.v1` и
  `notification.wincrm.invitation.email.requested.v1`;
- Billing publisher: `billing.wincrm.provider-operation.requested.v1` и write
  на отдельный direct exchange `winwidget.billing.wincrm-provider.dead-letter`.

Read/configure grants этих producers не расширяются. Для Notification Delivery
обязателен opt-in reader `wincrm-invitation-email` в её topology contract;
без него provisioning блокируется до изменения RabbitMQ. Старые consumer kinds
сохраняются. Это не включает product flags, Trial или продажи.
Предварительный `native-v1`, не включавший приглашения и платёжный consumer,
не является release contract и отклоняется.

Первый CRM controller должен под общим deploy lock provision все девять
principals, их ACL и durable bindings, подтвердить их и согласованно перевести
canonical env в `mvp-v1` с обязательной двусторонней синхронизацией.
Неполный bootstrap нельзя обходить routine deploy: сначала завершить или
восстановить точное состояние под тем же lock, без purge. Не переключать
контракт обратно в `disabled` при остановке CRM runtime, пока остаются его
principals или события. Подготовка кода не доказывает, что этот контракт
уже включён на VPS; production env этой подготовкой не изменяется.
Поведенческий тест исполняет фактический shell preflight и определения
provisioner на synthetic данных, проверяя неизменность остальных grants.

Напоминания задач добавляют отдельный контракт
`CRM_REMINDERS_RABBITMQ_CONTRACT=task-reminders-v1`, только совместно с
`CRM_RABBITMQ_CONTRACT=mvp-v1`. Значение по умолчанию — `disabled`; пустое и
неизвестное значения запрещены. Старый `mvp-v1` не переписывается. Новый
контракт требует ровно 26 principals: прежние 25 и
`winwidget-crm-sales-reminders`. Его configure — `^$`, read — только
`winwidget.crm.sales.reminders`, write — только exchange `winwidget.events`
с тремя точными topic keys: `crm.sales.reminder.tick.v1`,
`notification.wincrm.task-reminder.email.requested.v1` и
`notification.wincrm.task-reminder.telegram.requested.v1`.

Отдельный locked bootstrap запускает `node crm-broker-bootstrap.mjs
provision-reminders` из проверенного immutable payload вместе с
`crm-broker-topology.mjs` и `crm-reminders-broker-topology.mjs`. Он требует
прежние root/Linux/revision/`stdio-v1` fence guards и read-only файлы
`/run/wincrm/canonical.env`, `/run/wincrm/crm.env`,
`/run/wincrm/notification-topology.json` с соответствующими
`CRM_BOOTSTRAP_CANONICAL_SHA256`, `CRM_BOOTSTRAP_CRM_SHA256`,
`CRM_BOOTSTRAP_NOTIFICATION_SHA256`. Последний файл — exact 14-kind topology
из candidate Notification Delivery, а не секрет или runtime feature flag.
Требования uid/gid `0:0`, mode `0600` и `/run/wincrm/deploy.lock` сохраняются;
секрет нового principal читается только из CRM owner env
`CRM_SALES_REMINDERS_RABBITMQ_URL`, не из argv.

Bootstrap добавляет 12 durable queues и 18 bindings: Sales main/DLQ плюс
две группы ND main/DLQ/три retry. Sales DLX — `winwidget.dead-letter`, ключ
`crm-sales-reminders.dead-letter`. ND получает два новых kinds,
`wincrm-task-reminder-email` и `wincrm-task-reminder-telegram`, сохраняя
предыдущие 12, включая приглашения. Точные ND ACL используют сжатие
prefix/suffix trie, укладываются в 1024 bytes и не разрешают wildcard.
Routine controller сохраняет эти grants, но не создаёт и не ротирует
новый CRM principal. До provisioning новые consumers должны отсутствовать;
старые CRM/ND consumers могут продолжать работу. Неизвестная статистика
consumers не считается нулём.

После неполного bootstrap повторяется тот же контракт под общим lock:
совместимые очереди и выданные grants сохраняются, пароли существующих
пользователей не заменяются, purge/delete запрещены. После добавления
principal нельзя возвращать marker в `disabled`; сначала завершить
provisioning и согласованную whole-file env-синхронизацию. Этот этап ничего
не публикует и не доказывает provider delivery или включение напоминаний.

Billing provider user получает read только на
`winwidget.billing.wincrm-provider.v1`, без configure/write; отдельная DLQ
`winwidget.billing.wincrm-provider.v1.dead-letter` связана с его direct exchange.
Его credential передаётся только Billing worker через
`BILLING_WINCRM_PROVIDER_RABBITMQ_URL`, не API/scheduler/publisher. Сохранять URL
и совместимый Billing publisher до полного drain даже после отключения оплат.
Identity invitation email flag включается только после готовности reader и
согласованного Notify/Identity private token; обычный Billing/Identity rollout
должен явно передавать новые CRM variables только нужным process roles.

Companion Compose передаёт provider URL и reverse commerce token только
Billing worker. Scheduler получает `BILLING_WINCRM_RECONCILIATION_ENABLED`,
без брокерного секрета: этот флаг сохраняется после закрытия продаж до
завершения durable операций и активации уже оплаченных отложенных периодов.
`validateCrmCompanionCompose` запускается и в CI, и в routine controller
до migrations/restarts; он сверяет canonical env с нормализованным Compose,
проверяет process-scoped ключи и запрещает producer без reader/eligibility,
платёжный drain без scheduler и runtime topology provisioning.
Canonical env должен содержать все документированные CRM companion keys,
включая явно пустые optional значения при выключенных flags. Materializer
разрешает их только при отключении соответствующего feature; обязательные
Identity/Billing inbound CRM credentials остаются обязательными. Перед первым
применением выполнить обычную двустороннюю env-синхронизацию. Новый controller
требует services revision с companion validator; старую ревизию без него
нельзя выпускать этим controller. Проверка production wiring и её точные
ревизии описаны в разделе companion cutover выше.

`scripts/crm-broker-topology.mjs` — AMQP-компонент первичного CRM provisioning,
не самостоятельная команда деплоя. Он содержит точные 9 ACL-профилей,
создаёт только 7 собственных exchanges, 14 durable classic queues и 18 bindings.
Три общих exchanges должны уже существовать с правильным типом; компонент
не переобъявляет их. Нет TTL/DLX retry, purge, удаления или бизнес-публикаций.
Неизвестные CRM resources/bindings, несовместимые arguments/policies и
работающие consumers блокируют действия. `x-queue-type=classic` задаётся явно;
отсутствующий счётчик consumers в первом Management sample не считается нулём.
Повторная совместимая декларация сохраняет сообщения.

`provisionCrmBrokerPrincipals` поверх того же компонента создаёт только
отсутствующие CRM users и недостающие точные grants. Он сверяет весь inventory,
отклоняет лишние права и сохраняет прежние 16 identities/ACL без изменений.
Пароли уже существующих пользователей не перезаписываются. При наличии vhost
grant неверный пароль останавливает preflight до деклараций; если предыдущий
запуск прерван до выдачи grant, аутентификация проверяется после его добавления.
Каждый из девяти пользователей проходит настоящее AMQP-подключение с закрытием
проверочного канала, без consume/publish. Повторный запуск не меняет password
hashes и не удаляет сообщения. Частичная ошибка не вызывает destructive rollback.

Caller обязан передать проверку актуального lock/env/image fence перед каждой
мутацией и финальным чтением. Эти проверки, приватный transport, исходные
credentials и включение контракта обеспечивает вызывающий CRM controller;
сам модуль их не подменяет и не открывает продукт. Metadata-only вызов
возвращает `credentialsProvisioned:false`, полный bootstrap — `true` только
после проверки всех девяти подключений. Оба возвращают `releaseApproved:false`.
Локальный/CI integration driver использует отдельный pinned RabbitMQ,
синтетические сообщения и свои временные credentials, без production/провайдеров.
Проверка 07.09.2026 на RabbitMQ 4.2.9 подтвердила полный bootstrap, сохранность
16 прежних пользователей, отсутствие смены password hashes при повторе,
возобновление после потери одного grant и отказ при неверном credential.
Она также подтвердила повторную декларацию с
сохранением 14 сообщений, подключение 9 scoped principals, 7 push consumers,
доставку 5 confirmed/mandatory публикаций и запрет постороннего configure
для всех 9 principals. Контракт topology SHA-256:
`ecaa3836f87e98dc8a74f1b93f5621214e6bffcbdfb851899c4471d71b1173f8`.
Это тест AMQP-компонента, а не production-прогон Billing/CRM runtimes или
доказательство платежей. Собственный локальный broker/anonymous volumes,
images/cache удалены, Colima остановлена.

Container inventory ограничен project `winwidget` и не отклоняет отдельный
CRM project сам по себе; cleanup защищает глобальные running IDs/image bindings
и исключает все `winwidget-crm-*` references, в том числе не привязанные к
контейнерам candidate/rollback tags. Их удалением владеет только отдельный
CRM controller; общий `winwidget-*` prefix не даёт routine release такого права.
Поведенческий shell-тест с Docker double проверяет running/stopped CRM,
теги четырёх сервисов, включая неиспользуемые, общий image ID с routine tag
и отказ до image deletion при изменении CRM image binding. Это не production
rehearsal. При первом rollout проверить сохранность CRM в целевой среде и
сериализовать оба релиза общим deploy lock. Не ослаблять точные проверки до
wildcard. Подготовить
сосуществование обоих проектов, serial migrations, health/queue monitoring
и rollback без удаления БД/очередей и без отката несовместимых publishers.
Никакие новые dumps, downloads или backup jobs этой конфигурацией не создаются.

## Workflow разработки и релизов

Репозитории разделены по ответственности:

- `winwidget.ru_frontends` — монорепозиторий четырёх Next.js приложений;
- `winwidget.ru_services` — API Gateway, независимые backend services и
  production Compose manifest;
- `winwidget.ru_infra` — Nginx, workflows и deploy scripts.

Новый backend-код размещается только в соответствующем `apps/<service>`; общий
код допустим для стабильных wire/tooling contracts, но не как скрытая общая
доменная модель.

Базовый цикл изменения:

1. Определить владельца данных, API и событий.
2. Прочитать README сервиса и
   [технический backlog](https://github.com/nda17/winwidget.ru_services/blob/prod/docs/backlog.md).
3. Зафиксировать узкий scope и требования совместимости.
4. Внести минимальные изменения в owner service.
5. Обновить unit/integration/contract tests.
6. Выполнить service-specific проверки и общий contract gate, если изменены
   API, events, Gateway, RabbitMQ, migrations или infra.
7. Обновить `.env.example`, README и backlog, если изменился контракт или
   остался важный риск.
8. Создать commit, дождаться green CI exact SHA и только затем выпускать.

Backend production выпускается только цепочкой `push` exact commit в
`winwidget.ru_services/prod` → зелёные lifecycle gate и полная service matrix →
release-job, вызывающий `winwidget.ru_infra/.github/workflows/deploy-production.yml`
по заранее проверенному immutable infra SHA. `workflow_dispatch`, ручной ввод
services SHA и прямой запуск controller с рабочей машины не являются release
path.

Минимальный набор проверок выбирается пропорционально риску:

- форматирование и lint изменённых файлов;
- TypeScript typecheck;
- unit tests изменённого домена;
- integration/contract tests для HTTP, RabbitMQ и Prisma boundaries;
- build приложения и image;
- migration/clean PostgreSQL check при изменении schema;
- public/browser smoke при изменении пользовательского сценария.

Изменение shared lockfile, event contract, Gateway manifest, Compose, env или
workflow требует проверок всех затронутых services. Локальный `200` одного API
не доказывает работу workers, RabbitMQ, backups или public route.

Границы backend-сервисов:

- один service владеет записываемыми таблицами своего домена;
- один глобальный PrismaModule/PrismaClient создаётся на root application
  context;
- синхронные критичные транзакции остаются в owner PostgreSQL;
- зависимые события создаются через transactional Outbox;
- consumer использует atomic receipt claim, CAS lease, idempotency,
  подтверждает сообщение после commit и имеет независимые retry/DLQ;
- internal calls используют scoped credentials и fail closed;
- публичный route добавляется только через Gateway manifest; catch-all и Core
  fallback запрещены.

Infra изменяется вместе с кодом, когда затронуты container/process topology,
port/health/deployment endpoint, Gateway route, Nginx или Telegram bridge,
RabbitMQ topology, production env/secret mount, database/migration/backup/
restore target, resource limits, workflow или deploy order. Временная
production-правка не завершена, пока эквивалент не зафиксирован в infra и не
прошёл routine deploy.

Frontend использует `/api/v1` и стабильные public widget URLs. React Query
cache invalidation обновляется вместе с mutation contract; пользовательское
действие сопровождается `react-hot-toast`, когда это соответствует UX. Новая
значимая admin mutation логируется в Operations audit, изменение контента
главной поддерживается во вкладке «Контент», стили следуют существующему
SCSS/Tailwind `@apply` pattern.

## Источники релиза

Production backend release задаётся двумя immutable SHA:

- services revision из `winwidget.ru_services`;
- infra revision из `winwidget.ru_infra`.

Перед deploy обязательны green required CI для exact revisions и отсутствие
неучтённых локальных изменений в выпускаемых репозиториях. Нельзя повторно
выпускать старый failed SHA после изменения кода.

## Быстрый production-deploy

### Backend services

1. Проверить CI exact services/infra revisions.
2. Отправить exact services commit в `winwidget.ru_services/prod`.
3. Дождаться lifecycle gate, полной service matrix и автоматически вызванного
   reusable infra workflow.
4. Дождаться migrations и rollout exact application revisions.
5. Выполнить полный checklist ниже.

Исполняемая реализация —
`winwidget.ru_infra/scripts/deploy-services-production.sh`, но её запускает
только закреплённый reusable workflow после зелёного push в `prod`. При
недоступности GitHub Actions выпуск ожидает восстановления CI/CD: прямой запуск
controller с рабочей машины и ad hoc Compose поверх production запрещены.

Обычный deploy не удаляет и не пересоздаёт внешние PostgreSQL volumes.
PostgreSQL-контейнеры и RabbitMQ обычно остаются запущенными, но Compose может
декларативно пересоздать инфраструктурный контейнер при изменении его
конфигурации. Данные при этом сохраняются во внешних volumes. Database
bootstrap/restore — отдельные административные операции.

### Узкие выпуски Identity и Operations

`release_scope` reusable workflow по умолчанию равен `all`. Для согласованного
узкого выпуска caller закрепляет scope вместе с green services/infra SHA;
ручной SSH или локальный запуск скрипта не заменяет CI. Контроллер сохраняет
immutable `origin/prod`, canonical env hash, root-owned files и общий deploy
lock. Два дополнительных tracked payload проходят SHA-256 проверку до SSH и
после передачи; scoped branch выполняется до общего provisioning/migrations.
После проверки SHA только несекретный `verifier.mjs` получает `0444`, чтобы
non-root migration image мог прочитать его через точечный read-only bind.
Родительская папка остаётся `0700`, shell controller, env и snapshots — `0600`;
процессы проверки БД не переводятся на root.

В Identity companion preflight список и SHA-256 миграций читает владелец
immutable Identity image (`1001:1001`): `network none`, read-only rootfs,
`cap-drop ALL`, только публичный verifier bind и timeout 30 секунд. Процесс не
получает production env или snapshots. Root сохраняет результат в новый файл
`0:0/0600`; root verifier проверяет его размер, тип, владельца, единственную
ссылку и точный контракт, затем прежнюю additive manifest chain до остановки
сервисов. Права каталогов/SQL внутри image не расширяются.

Общие дополнительные inputs: `expected_live_revision` (40 hex) и
`expected_service_env_sha256` (64 hex) выбранного owner. Отдельные service env
должны быть заранее согласованы и двусторонне синхронизированы: scoped release
их не пересоздаёт. Все соседние container IDs/images и hashes env проверяются
до и после; `--no-deps` запрещает косвенное пересоздание соседних сервисов.

- `workers-bootstrap-recovery`: только `billing-api`, `billing-worker`,
  `billing-outbox-publisher`, `operations-worker`,
  `operations-outbox-publisher`, `operations-restore-worker`, `support-worker`,
  `support-outbox-publisher`. `expected_service_env_sha256` относится к Billing;
  дополнительно нужны `expected_operations_env_sha256`,
  `expected_support_env_sha256` и `expected_operations_revision`, равный общему
  `expected_live_revision` всех восьми процессов. Billing API — обязательный
  companion: его provider-readiness contract требует тот же revision, что у
  Billing worker. Проверка revision не ослабляется, `APP_REVISION` не подменяется.
  Выпуск разрешает только изменения
  трёх `src/main.ts`, `src/runtime/bootstrap-failure.ts` и их unit tests; восемь
  ранее согласованных qs-only lockfiles сверяются по точным old/new SHA-256.
  Billing dependencies, Prisma/schema/migrations, Dockerfiles, package manifests,
  API/domain source и Operations restore catalog неизменны. Три immutable image
  собираются и проверяются до замены. Initial state семи workers допускает только
  running healthy/unhealthy, Billing API обязательно running healthy; после
  выпуска все восемь обязаны стать healthy на
  проверенных новых image IDs. Health-правило остальных scopes не ослабляется.
  Metadata probes трёх owner DB до и после используют существующую migration
  роль только для SELECT: проверяют database UUID и полностью применённый ledger
  с точными checksums. `*-migrate` в таком probe — Compose entrypoint, явно
  переопределённый на Node verifier, **не** запуск Prisma migration runner.
  Operations restore jobs/permits/leases должны быть idle,
  `DATABASE_RESTORE_ENABLED=false`; старый/новый bundled restore catalog побайтово
  совпадает. Нет DDL, других API/scheduler/Gateway/CRM rollout, очистки очередей
  или leases. Mixed revisions не разрешают включать restore: для него по-прежнему
  нужны отдельные согласованные revision/manifest gates всех restore targets.
  Новые backup sidecars нового Operations worker содержат его revision и не
  authorizable старым Operations API. Restore остаётся выключенным до отдельно
  согласованного API/worker/provenance rollout; idle guards не отменяются.
  До замены нужны два quiet samples с интервалом и повтор непосредственно перед
  SIGTERM: ноль RabbitMQ unacked/unconfirmed, активных Billing ProviderOperations,
  Operations jobs/restore и processing receipts/Outbox трёх owners. Каждая DB quiet
  probe ограничена 15 секундами. Проверяются точные container IDs, затем только
  мягкий TERM (Billing API первым) и не более 45 секунд ожидания
  `Running=false`, `Pid=0`; SIGKILL и
  `docker stop` с принудительным timeout не используются. После выхода — ещё
  quiet sample и неизменность соседей. Это **не атомарный drain**: обычные
  at-least-once риски сохраняются, известный Operations busy-lease ACK риск не
  объявляется исправленным. Busy/неизвестное состояние или неполный выход
  запрещает replacement и автоматический рестарт остановленных старых workers.
  Короткая пауза Billing API входит в scope; Billing scheduler не останавливается.
  До завершения релиза отдельно проверить read-only provider-readiness через
  настоящий compiled consumer, не инициируя платежи или запросы провайдеру.
  Ошибка или сигнал после замены возвращает только восемь сохранённых image/config,
  также после quiet + graceful-stop проверки; иначе выдаётся CRITICAL без kill.
  Если старые образы снова unhealthy, rollback не объявляется успешным: нужны
  сохранённые recovery snapshots и операторская проверка.
  **Следующий backend release:** после worker-only cutover Operations
  имеет разные per-role revisions: API остаётся на старом image, три workers
  получают bootstrap fix. Прежние OTP/Notes candidates без этого исправления
  несовместимы: OTP candidate нужно собрать от фактически выпущенного worker
  SHA, сохранив три bootstrap helpers, main/tests и security patch. Следующий
  Notes candidate строится уже от выпущенного OTP SHA. Нельзя возвращать старые
  worker images ради прохождения gate. Mixed baseline поддерживает только
  следующий явно закреплённый Identity scope, описанный ниже; новый controller
  pin также требует green CI и отдельного review caller.
- `operations-federation-config`: только `operations-api`, на **точном текущем
  live image** и прежнем `APP_REVISION`, без build, DB probes/migrations и workers.
  Prepared canonical/Operations env hashes должны быть заранее двусторонне
  синхронизированы. Единственное допустимое изменение runtime env —
  `NOTIFICATION_DELIVERY_INTERNAL_URL` с legacy loopback URL с путём
  `/internal/notification-delivery` на тот же точный HTTP origin порта 4401.
  Другие hosts/ports/paths, credentials, query, HTTPS и любые сопутствующие env
  изменения отклоняются. `DATABASE_RESTORE_ENABLED=false` сохраняется.
  Текущий Compose передаёт этот ключ только API, не трём Operations workers;
  worker recovery сохраняет строгую побайтовую проверку своего env.
  Rollback возвращает только сохранённый API runtime config; синхронизированные
  env-файлы автоматически не переписываются. После успешного выпуска отдельно
  проверить ND overview/failures и отображение источника в админке без вывода
  токенов или содержимого сообщений.
  Для одного candidate push в `prod` caller может выполнить config job, затем
  worker job с `needs` на его успех, закрепив один services SHA и green infra pin.
  Если config job уже успешен, он не должен повторяться через rerun-all: guard
  намеренно принимает только legacy-to-origin переход. После failed worker job
  сначала проверить/recover exact live baselines, затем переисполнить только
  неуспешную job. Частично обновлённые worker revisions нельзя скрывать заменой
  expected baseline или повторным общим rollout.
- `identity-with-operations-manifest`: три Identity и четыре Operations
  runtime; дополнительно `expected_operations_revision` и
  `expected_operations_env_sha256`. Это не Identity-only rollout: Operations
  подписывает backup manifests, поэтому обновление bundled Identity ledger
  требует согласованного companion image. В Operations разрешены только JSON
  restore manifest и точный, проверенный whole-file hashes, security patch
  `qs 6.15.3 -> 6.16.0`; остальной source/package manifest/Dockerfile неизменен.
  Для mixed baseline после worker recovery дополнительно закрепляется
  `expected_operations_api_revision`: точный live revision Operations API.
  `expected_operations_revision` остаётся точным revision трёх workers и базой
  source diff. Этот optional input запрещён у других scopes; без него действует
  прежний homogeneous контракт. В mixed варианте все Billing/Support files
  побайтово совпадают с worker baseline, в Operations отличается только restore
  JSON; наличие baseline bootstrap helpers обязательно. Проверяются реальные
  IDs/images всех четырёх ролей и побайтовое совпадение их старых manifests,
  а не SHA checkout. Rollback snapshots сохраняют исходный image каждой роли.
  Build/probe обоих images и проверка только additive OTP migration выполняются
  до остановки. Затем quiet samples и мягкий TERM с ограниченным ожиданием
  останавливают все четыре Operations процесса без SIGKILL; проверяются
  отсутствие processing jobs/receipts/Outbox, idle restore и RabbitMQ
  unacked/unconfirmed. Это не атомарный drain. Дополнительно проверяются
  `Running=false`, `Pid=0`, отсутствие PostgreSQL сессий runtime
  роли, `SHARE` barrier, ноль `PROCESSING` scheduled jobs (включая expired) и
  незавершённых restore jobs/permits/leases. Только после этого допускается
  Identity DDL и запуск семи runtime. Это короткая пауза admin control plane и
  audit projection; durable queues не очищаются, Widgets/Billing не
  останавливаются. `DATABASE_RESTORE_ENABLED=false` обязателен до и после.
  Если DDL уже начат, даже неоднозначный результат запрещает автоматический
  возврат старого Operations manifest: `RECOVERY_REQUIRED`, Operations остаётся
  остановлен. Возобновление требует доказанного ledger/manifest match. До DDL
  можно возобновить только исходные остановленные container IDs после повторной
  quiet проверки; неполная graceful остановка требует recovery без auto-restart.
- `operations-api-runtime` — узкий image-only ремонт read-фильтров ошибок
  доставки **до** финализации Notes, независимо от дополнительного backup и
  restore rehearsal. Меняется только `operations-api`; три Operations worker
  и остальные 27 контейнеров не останавливаются и не пересоздаются. Обязательны
  обычные immutable CI/source, root deploy-lock и exact canonical/owner env
  gates; `operations_runtime_revision`, restore evidence и companion inputs
  запрещены. `expected_live_revision` указывает исходный Notes-free N, не
  checkout HEAD. Root600 phase-A receipt проверяется по закреплённому SHA256
  `445bb6da333f2c1fd8cbc7b63ed131989a60d88c4505d49a3985dd7468822914`:
  application tree, database UUID, source maintenance-worker ID/image остаются
  исходными. Global/per-N finalized marker, в том числе dangling symlink,
  блокирует этот PRE-B scope.
  Допустимый runtime diff — только согласованные `FAILED`/`RESOLVED`/`CLOSED`
  predicates в `messaging-admin.service.ts` и три exact test paths; соседние
  правки, CRM, зависимости, schema/migrations и restore catalog запрещены.
  Инвентаризация старого и нового образов исполняется UID1001 без сети и
  credentials: все compiled JS кроме filter module, обе Prisma schemas,
  generated models, 14 migration files и семь restore targets побайтово
  неизменны; старый образ действительно имеет legacy filter, новый — fixed.
  Read-only RepeatableRead probe с существующим migration principal требует
  ровно 13 applied migrations и exact pending Notes SQL, таблицу Notes и
  уже установленный table/column/effective DML fence. Он не применяет REVOKE,
  LOCK, migration или DELETE. Counts и SHA256 Notes и retired BACKLOG audits
  вычисляются внутри PostgreSQL и сравниваются до/после; строки не выгружаются.
  Restore должен быть выключен в API и restore-worker; активные jobs, permits,
  recovery/outbox и execution lease блокируют переключение. Все 43 Gateway
  routes, соседние container/env/image/mount/restart fingerprints неизменны.
  API получает только TERM с bounded ожиданием физического выхода, без KILL.
  После пересоздания проверяются OCI/APP revision и реальные
  `/health/live`, `/health/ready`, `/api/v1/health/deployment`.
  **Rollback не безусловен:** ошибка/сигнал после начала остановки, но до
  успешного post-stop admission оставляет старый API для ручного recovery.
  После начала replacement автоматический rollback допустим только к
  сохранённому Notes-free N и лишь при повторном успешном admission, неизменных
  данных/соседях и доказанном graceful exit; иначе fail-closed, без force-kill.
  Этот scope не читает, не создаёт и не удаляет dump/acquisition/restore
  evidence и не меняет штатный backup. После успеха API revision отличается
  от трёх workers: прежние Notes backup/finalize gates должны отклонять mixed
  runtime. Для возвращения к Notes B нужен отдельно согласованный протокол;
  исходная phase-A квитанция не доказывает четыре процесса старой ревизии.
- `platform-marketing-runtime` — совместимое расширение CMS перед выпуском
  главной экосистемы и `/products/crm`. Меняется только `platform-api`;
  `platform-outbox-publisher` и остальные 29 контейнеров сохраняют свои
  ID/image/revision, настройки, mounts и счётчики перезапусков. Порядок
  перечисления mounts Docker незначим, но все их свойства проверяются.
  Обязательны immutable green services/infra SHA, canonical root lock,
  неизменные canonical/Platform env SHA и точная live Platform revision.
  Operations/restore/companion authority запрещена; этот scope не читает
  dump, не запускает backup, DDL, GRANT, auth-команды или платёжные операции.
  Source gate допускает только два закреплённых CMS модуля, их новый spec,
  CI/audit metadata и точную пару package/lock для security patch qs.
  Остальные app trees закреплены отдельно от старого live Platform image.
  UID1001-инвентаризация образов без сети и credentials проверяет реальный
  старый/новый validator, восемь migrations, обе Prisma schemas, семь models,
  весь compiled JS и единственную dependency-разницу `qs 6.15.3 -> 6.16.0`.
  База не изменяется: bounded RepeatableRead/READ ONLY probe существующей
  migration-ролью проверяет UUID, semantic fingerprint, applied ledger,
  content hash/aggregate version/source sequence и owner ACL. Контент и
  credentials в отчёт не выводятся. До/после замены доступны три настоящих
  GET: live, ready и публичный `home-page-content`.
  API останавливается только TERM с доказанным `Running=false/Pid=0`;
  после остановки повторяются DB и neighbor checks. Неполный stop или
  неизвестное состояние оставляет snapshots для recovery, без KILL.
  **Откат старого validator разрешён только при неизменном контенте:**
  сначала остановить новый writer, затем повторно проверить версию/hash,
  ledger/ACL и соседей. После успешной записи расширенного CMS-документа
  автоматический откат запрещён — нужен совместимый fix-forward, не
  восстановление БД или потеря новых полей. Поэтому frontend с новым
  редактором выпускается только после успешного Platform rollout.
- `operations-backup-runtime` — отдельный runtime-only выпуск четырёх процессов
  Operations для четырёх новых backup-only целей CRM. Это **не** Notes scope:
  bootstrap, migration runner, writer fence, restore activation, изменения
  CRM runtime и соседних сервисов не выполняются. Требуются exact green SHA,
  обычные root deploy-lock/immutable payload gates, byte-identical canonical
  и Operations owner env, `expected_live_revision` текущего Operations API и
  отдельный `expected_operations_backup_baseline_sha256`. Последний — свежий
  SHA256 функции `operationsBackupFingerprint` из закреплённого verifier по
  private Docker inspect всех running containers проектов `winwidget` и
  `winwidget-crm`. Он фиксирует точные IDs/images/config, в том числе разные
  ревизии четырёх Operations ролей, StartedAt/RestartCount и соседей. В workflow
  передаётся только digest, не содержимое inspect/env.
  Разрешённый env diff — `APP_REVISION` и только четыре новых worker-only ключа
  `CRM_ACCESS_BACKUP_URL`, `CRM_INTAKE_BACKUP_URL`, `CRM_CUSTOMERS_BACKUP_URL`,
  `CRM_SALES_BACKUP_URL`: `127.0.0.1:55442..55445`, собственные БД/schema и
  `_backup` principals, ровно query `schema` + `sslmode=disable`. Они запрещены
  в inherited image ENV, API, publisher и restore worker. Остальная runtime
  конфигурация, включая root→gosu bootstrap maintenance-worker и его caps,
  сохраняется. Существующие семь restore targets/keyring, Operations schema,
  generated schema и миграционные файлы должны совпадать до/после. Для restore
  JSON разрешён только точный reviewed переход `50bd4c57…` → `7060c972…`:
  две миграции Identity (workspace/приглашения), одна Widgets (CRM connector),
  две Notification Delivery (приглашения/reminders); четыре других записи
  неизменны. Новый backup manifest подписывает 11 целей, его прежние семь
  записей совпадают с актуальным restore manifest. Это не новые restore права.
  До первой остановки Operations требуется свежий (не старше 60 секунд)
  READ ONLY proof трёх owner ledgers через уже существующие worker-only
  `IDENTITY_BACKUP_URL`, `WIDGETS_BACKUP_URL`, `NOTIFICATION_DELIVERY_BACKUP_URL`.
  Проверяются точные backup principals, БД/schema, завершённые миграции и ACL;
  Identity/Widgets связаны service UUID, ND без service_identity — OID БД и
  immutable first ledger receipt, без выдуманного UUID. Credentials передаются
  только bounded private stdin, не нужны новые owner env или права. Proof
  повторяется после остановки и после запуска, identity/ledger/ACL должны
  совпасть; admission повторно проверяет свежесть и сохраняет proof.
  Один Operations image строится до остановки. Image inventories читаются
  UID1001 без сети/private mounts/capabilities. Root/no-network input probe
  выбирает только Operations migration URL и четыре backup URL; bounded
  private stdin передаёт их UID1001 read-only probe без Docker ENV, argv,
  signing key или полного owner env. PostgreSQL 18 identity/ledger/schema и
  least-privilege CRM backup ACL проверяются до/после; SQL только read-only.
  После повторного exact baseline и quiet проверки четыре старых процесса
  мягко останавливаются, без SIGKILL. **Перед первым новым API** сохраняется
  durable `.../scoped-releases/operations-backup-runtime/<sha>/admission.json`:
  API тоже может создать ручное CRM backup-задание. Затем запускаются API,
  publisher и restore worker; только после их health — maintenance-worker
  с планировщиком. До admission можно возобновить лишь exact original stopped
  IDs после проверки config/DB/соседей. После admission любая ошибка/тайм-аут —
  `RECOVERY_REQUIRED`, исключительно совместимый fix-forward: старый runtime
  автоматически не возвращается, protected snapshots/marker не удаляются.
  Повторный запуск того же scope при existing admission требует отдельного
  разбора, не удаления marker. Успешный postflight сохраняет `completed.json`.
  Этот runtime health/ACL gate не доказывает реальные dump и Telegram delivery:
  четыре успешных артефакта и доставки проверяются отдельно после activation.
- `operations-runtime` — фаза A удаления административного Backlog. Только
  четыре Operations runtime, без вызова migration runner. Pending migration
  должна быть ровно `20260910110000_remove_admin_backlog`, предыдущий ledger —
  с точными checksums. Новый runtime не содержит Notes API; таблица сохраняется.
  До замены четырёх процессов применяются те же Operations quiet samples и
  graceful-stop проверки; при rollback до fence они также обязательны. Отдельный
  read-only `operations-quiet` допускает pending Notes лишь для проверки покоя,
  не заменяя обязательный exact pre-migration ledger gate. `worker-quiet` и
  `worker-ledger` по-прежнему запрещают любую pending migration.
  После health проверок устанавливается PostgreSQL writer fence (REVOKE Notes
  DML у runtime, drain lock и проверка всех table/column write grants).
  Root-only receipt сохраняется в
  `/opt/winwidget/deploy/backend/scoped-releases/operations-backlog/<runtime-sha>/phase-a.json`.
  После начала fence старый Notes-capable runtime автоматически не возвращается.
- `operations-backlog-backup` — отдельный file-only этап после фазы A. Передаются
  точные live `expected_live_revision=operations_runtime_revision`, owner env SHA
  и тот же immutable services source. Существующий deploy lock, env/neighbor
  inventory, phase-A application tree и четыре healthy Operations процесса
  обязательны. Source maintenance-worker ID/image записаны в phase-A receipt;
  его подмена или пересоздание требует отдельного согласования, не нового dump.
  Этот scope не выполняет build, Compose up, DDL, API/provider calls или повтор
  фазы A. Live worker не исполняет capture: отдельный disposable executor на том
  же image ID получает только `OPERATIONS_BACKUP_URL` в RO0400-файле, UID1001,
  read-only rootfs, dropped capabilities, no-new-privileges и лимиты ресурсов.
  Ни JWT, Rabbit, Telegram, admin/migration URL, ни signing key в него не входят.
  URL допускает только собственную backup-роль, Operations DB/schema и приватный
  loopback endpoint. `pg_dump` 18 сохраняет owners и ACL; Notes должны оставаться
  read-only для runtime. До/после проверяются UUID, ledger и schema ACL, не PII.
  После exit0/root hash+size verification атомарно устанавливается root0700
  `backup/` с `operations.dump` и `acquisition.json` (оба root0600) рядом с
  `phase-a.json`. Receipt связывает source worker и отдельный executor, image,
  phase-A hash, UUID/ledger, время capture после fence, dump SHA/size и ACL SHA.
  Размер ограничен 1 GiB, capture — 210 секундами, начальный free disk — 3 GiB.
  Повтор scope только read-only проверяет уже sealed pair, не перезаписывает его.
  При ошибке секрет удаляется, собственный executor убирается; частичные private
  файлы сохраняются для проверки, receipt не подделывается. Этот artifact не
  объявляется обычным signed Telegram backup. Обычный maintenance flow неизменён.
- `operations-backlog-finalize` — фаза B, без пересоздания runtime.
  `operations_runtime_revision` должен совпасть с live phase-A revision;
  `operations_evidence_sha256` закрепляет файл `restore-evidence.json` рядом с
  receipt. Обязательны свежий service-owned safety backup после fence,
  проверенный hash артефакта, реальный isolated restore, совпадение database UUID,
  phase-A/application tree, migration checksum/ledger и повторный writer fence.
  Controller сам повторно проверяет root-sealed acquisition и байты dump;
  restore evidence обязано совпасть с их SHA/size и восстановленным schema ACL.
  Старые receipts без acquisition/source-worker binding не принимаются.
  Только затем запускается Operations migration. Она атомарно удаляет
  `operations.notes` и точные старые Backlog audit rows, не остальные журналы.
  После проверки создаётся `finalized.json`. При прерывании после DDL требуется
  проверка ledger и восстановление receipt chain; `prisma resolve`, скрытие
  миграций и повторный старый writer запрещены. Обычный `all` fail closed
  запрещён при наличии этой миграции в source, пока её применение, отсутствие
  Notes и matching finalized receipt не доказаны. Этот read-only ledger probe
  использует существующую migration роль; доступ runtime к Prisma ledger не
  расширяется. Неожиданные migration directories или symlinks отвергаются,
  а не исключаются из проверки фильтром имени.
- `gateway-remove-notes` — отдельный config-only шаг на точном live Gateway
  image, без build/migrations. Разрешено только удалить `operations-notes` из
  43 routes; остальные 42 ordered records должны совпадать. Identity и фаза A
  могут завершиться, пока старая запись ещё существует. Общий `all` contract
  остаётся на 42 маршрутах; этот scoped шаг не ослабляет его.
- `gateway-tilda-upgrade` — отдельный code-only выпуск только `api-gateway`.
  Не использовать `gateway-remove-notes`, `all` или повтор CRM/SLA activation.
  Прежний source Bearer endpoint сохраняется; новый exact POST
  `/api/v1/crm/intake/ingest/:UUIDv4/tilda` использует один raw
  `X-WinCRM-Source-Token`, без JWT/Bearer fallback, OPTIONS или query credentials.
  Маршрут уже покрыт существующим `crm-source` prefix: route JSON, CORS,
  private ingress, env-файлы, broker и SQL не изменяются.
  Controller ограничивает Gateway source точной reviewed hash-парой
  `server.ts`, остальные runtime source/build files неизменны. Образы сравниваются
  по всем шести compiled JS: меняется только exact `server.js`.
  Отдельный `gateway-tilda-release.mjs` упаковывается только для этого scope
  вместе с прежним scoped-validator: exact двухфайловый hash envelope, 256 KiB
  decoded, helper ≤32 KiB, общий validator ≤144 KiB, прежние 90000 bytes SSH.
  Это не меняет состав, decoder или budgets reminders/SLA activation payloads.
  Сначала зафиксировать свежие live Gateway revision/image и полные env hashes,
  healthy inventory всех Docker projects, диск/RAM. Параметры pinned reusable
  workflow: `release_scope=gateway-tilda-upgrade`, immutable green
  `services_revision`, `expected_live_revision` работающего Gateway и
  `expected_service_env_sha256`, равный canonical `BACKEND_PRODUCTION_ENV_SHA256`.
  Gateway использует `/opt/winwidget/deploy/backend/.env.production`; отдельный
  `apps/api-gateway/.env.production` не нужен и не читается. Все дополнительные
  CRM/Operations baseline/companion/destructive inputs оставить пустыми.
  Под существующим global lock controller сверяет неизменность canonical,
  всех owner env и полного CRM env, exact 21 CRM/companion role с четырьмя БД,
  reminders/SLA markers и всех остальных контейнеров. Только Gateway получает
  новый image/APP_REVISION; sealed rollback сохраняет его старые image/env.
  Остановка — TERM с bounded ожиданием, без force-kill; read-only HTTP smoke
  использует только health и отрицательные auth/path запросы без source token,
  user JWT, business body или реального обращения. При ошибке автоматический
  rollback разрешён лишь на точные сохранённые Gateway image/config при
  подтверждённой неизменности env/соседей и завершённом graceful stop; иначе
  `RECOVERY_REQUIRED`, protected snapshots сохраняются. После Gateway выпуска
  сформировать новый 21-role `crmUpgradeBaseline` с новой Gateway revision для
  отдельного `crm-upgrade`. Публичный успешный Tilda form/replay smoke и
  авторизованный browser-сценарий не заменяются отрицательной проверкой ingress.

  Первый выпуск Services `760ab06e8abb6e1c83f982fae6682ab03e86e87e`
  (production CI `34258239203`) остановился до сборки и остановки Gateway:
  Alpine BusyBox не поддерживает GNU-опции `timeout --signal/--kill-after`.
  Read-only проверка подтвердила прежний healthy Gateway `837113b9f9f303bd6c043c2a2e37b0791369d7a3`.
  Использовать совместимые `-s TERM -k 5 35` с теми же ограничениями времени;
  продолжать только новым green Infra/Services SHA, не повторять старый run.

  Forward-выпуск завершён на Infra `8393b7bcf5cafb5cf36a590ebf77e20760df2025`
  (CI `34258888210`) и Gateway `fc3669057a748c6cd2a6cfe89b0d6ccd9a23c681`
  (Services CI `34259242574`, production `34259606795`) — SUCCESS.
  Новый 21-role baseline с сохранёнными reminders/SLA markers:
  `81a9319aa9da4953cd59ea824fa0087b30fc36e8e74fbe4c9f0fcc401f186b02`.
  Следующий `crm-upgrade` Services `c4189c74e04a53c4d818aaa1bb1d334daf5038ee`
  завершён: CI `34260229592` и production `34260848762` — SUCCESS.
  В первом CI только failed jobs повторены без изменения SHA после Docker Hub
  HTTP 500 при pull; release gates не отключались. Canonical/owner env не менялись.
  Публичный Tilda probe со случайным несуществующим source ID и синтетическим
  ключом вернул 401 без создания заявки. Реальная форма сайта Tilda и доставка
  её заявки этим не проверялись; локальные HTTP/form/replay tests и CI не заменяют
  настройку формы владельцем сайта.

Локальный proof producer не принимает production URL и не восстанавливает
Operations поверх неё самой. Для проверенной копии backup, receipt и точной
SQL migration используется существующий immutable PostgreSQL 18 image:

```sh
node scripts/verify-operations-backlog-backup.mjs \
  --artifact /absolute/private/operations-safety.dump \
  --artifact-sha256 APPROVED_64_HEX \
  --acquisition /absolute/private/acquisition.json \
  --acquisition-sha256 APPROVED_64_HEX \
  --phase-a /absolute/private/phase-a.json \
  --migration /absolute/release/apps/operations/prisma/migrations/20260910110000_remove_admin_backlog/migration.sql \
  --image sha256:APPROVED_64_HEX \
  --output /absolute/private/restore-evidence.json
```

Producer принимает только локальный Unix-socket Docker context, создаёт
уникальный network-isolated PostgreSQL 18 с tmpfs, восстанавливает dump с owners
и ACL (без `--no-owner`/`--no-privileges`), сравнивает fingerprint schema,
relations/columns/routines/types/default ACL с acquisition,
проверяет fence/ledger/database UUID, выполняет именно данный SQL и доказывает
сохранение остальных audit rows. Повторный restore исходного dump доказывает
восстановимость удаляемых данных. После exact cleanup выводится только hash
evidence; synthetic CI proof не заменяет этот прогон production backup.
Выгрузка production artifact и isolated restore остаются отдельными действиями:
сохраняются существующие privacy/capacity gates, включая 6 GiB MemAvailable для
production restore rehearsal. File-only capture на backend этот gate не отменяет.
Backup copies сохраняются до обычного retention; удаление активного Backlog
не означает мгновенное уничтожение всех архивных копий.

`node scripts/test-scoped-service-deploy-contract.mjs` проверяет реальные Bash
ветки с fake Docker/Git/SSH и fail-closed/rollback/signal scenarios. Они не
заменяют проверки PostgreSQL или final production smoke. Новые CRM services
не входят ни в один из этих scope.

### Frontend

08.09.2026 четыре frontend-приложения выпущены на
`73a797a295199b1503d56a823b21286c7ec56db2`: feature CI `34193823444`,
production deploy `34207115542` — SUCCESS. Выпуск выполнен после Operations
`3c09cc535256d54519997514e693f0b43c8de143`, который возвращает новые поля
расписания и 13 backup-целей. Подготовлены UI административных дней/цен CRM,
`/planner` с переходом со старого `/my-day`, реквизиты/поиск ИНН и часы звонков
контакта. Авторизованная desktop/mobile проверка именно этой версии,
формы расписания и lookup выполняется отдельно от зелёного deploy.
08.09.2026 авторизованный Chrome smoke подтвердил `/planner`, мобильную
шапку/вертикальную доску на 390×844, mobile company lookup по публичному ИНН
и явное заполнение реквизитов DaData без сохранения лишней компании.
Мобильная форма контакта проверена в тёмной теме: выбор Владивостока из списка,
раздельные часы звонка, доступные footer-кнопки; тема и viewport затем возвращены.
`/admin/crm` показал редактор цен/двух мест и ручное начисление дней собственной
CRM; подписки и цены не менялись. `/admin/databases` вернул 13 целей и
расписание четырёх CRM-баз 05:00/05:15/05:30/05:45 МСК; новые копии не запускались.
`/payment` показал переключатель Widgets/CRM и актуальные месячные/годовые
карточки. В CRM `/billing` серверный расчёт 990 ₽ за месяц и два места
начинался 12.09.2026 после текущего Trial, завершался 12.10.2026;
согласие на автопродление не включалось, заказ и платёж не создавались.
Дополнительно `/admin/crm` проверен на фактической ширине 390 px: ширина
документа 390 px, элементы main не выходят за экран; screenshot просмотрен.
Тарифы, подписки и настройки при проверке не изменялись. Это не полная
мобильная проверка остальных административных разделов.
Это не проверка сохранения реквизитов/часов, всех ролей или денежных операций.

08.09.2026 отдельный payment-only hotfix `a9043ac949aa468536d8a0279d734ac35c099d63`
выпущен после CI `34228490869`, production `34229173529` — SUCCESS.
Изменены только общие карточки Widgets/CRM и их тесты; новые фоновые CRM UI
в этот hotfix не входили. Публичные health landing/CRM вернули точный SHA.
Подписки, условия и команды оплаты не менялись; надпись «Отдельный продукт» удалена.
Публичный browser smoke: на 1470 px все четыре карточки имеют 448×800 px;
на 390 px — одна колонка шириной 342 px, без overflow документа. Скриншоты
обоих продуктов просмотрены; переключатель работает, pageerror/HTTP-ошибок нет.
Использован новый изолированный Chrome-профиль без входа: цены CRM после
авторизации этим smoke не проверяются, пользовательский профиль не читался.

После совместимого backend `6eab2581` выпущен frontend
`c193d5bf6d03225c463e6b170617dc9015cb68bf`: CI `34229334897`, production
`34237253888` — SUCCESS. Публичные health CRM/landing подтвердили этот SHA.
Версия включает серии задач и центр уведомлений; SLA сохраняет отключённое
состояние до отдельной серверной активации. Новые авторизованные browser-сценарии
не объявляются проверенными: доступный native Chrome открыт на посторонней
вкладке, чтение которой остановлено. Подменять эту проверку JWT или чтением
пользовательского профиля браузера нельзя.

Ранее 07.09.2026 была выпущена production-ревизия:
`d010a3aa67f7290776c2783d82d86e3d0a0ed8ea`, CI `34082138618`, успешный
deploy `34082579545` от 07.09.2026. Выпуск уточняет только подпись закрытой
оплаты CRM: «Оплата скоро», отдельно от уже работающего приложения.
Повторная browser-проверка подтвердила две карточки с актуальными ценами
и выключенными платёжными кнопками; новых платежей не создавалось.
Read-only замер 04:27 UTC: четыре контейнера используют этот SHA,
свободно около 38 GiB диска и 2807 MiB MemAvailable. Env и paid gates
не менялись; рабочий WinCRM и лендинг сохранены.

07.09.2026 четыре frontend-контейнера обновлены до
`9d1880fc841ff09f525c684c6f79c0b193193894`: CI `34078656417`, production
deploy `34079166307` (успешная попытка 2). Сохранены прежний лендинг Widgets,
активная ссылка CRM и работающий WinCRM. Основные блоки 18 разделов админки
получили общий полноширинный layout; из оплаты убрана релизная «Внешняя
проверка», без подмены неизвестного статуса успехом. Реальные настройки,
ошибки провайдера и backend/DEV-права сохранены.

Авторизованный production browser на 1470×867 подтвердил страницы CRM,
платежей, контента, рассылок, пользователей и системы. У платежей и рассылок
ширина формы 1446 px с границами 12 px, таблица пользователей имеет свой
`overflow:auto`; горизонтального переполнения страницы нет. Фактическая
мобильная проверка остаётся в backlog: команда viewport текущего browser
bridge не изменяет реальный размер страницы. Дополнительно проверены
плашка Trial WinCRM в кабинете (прежний Hard Widgets сохранён), переключение
продукта оплаты с клавиатуры и реальные месячная/годовая карточки CRM
с двумя включёнными местами. Платёж не создавался.

В `/admin/messaging` проверены пять вариантов статуса и фильтры категории/
обработчика. `RESOLVED` вернул 4 строки, `CLOSED` — 12 строк с явной
пометкой «Закрыто без повтора», без подмены на «Доставлено»; RETRYING — пустой
список. Ошибки недоступности Notification Delivery нет. Retry/закрытие/внешние
отправки не выполнялись; фильтры возвращены в исходное состояние.

Первая попытка этого же immutable frontend SHA остановилась на disk gate
до переключения traffic. Под общим frontend lock удалён только неиспользуемый
BuildKit cache старше двух часов: освобождено 35.27 GB. Контейнеры, образы,
volumes и данные сохранены; cache восстанавливается следующей сборкой.
Повторный deploy успешно завершён. Read-only замер 03:46 UTC:
все четыре контейнера используют `9d1880fc`, свободно около 40 GiB диска
и 2818 MiB MemAvailable. Это снимок после выпуска, не нагрузочный тест.

Frontend выпускается из exact green SHA собственного репозитория через его
workflow; при переходе `winwidget.ru_client` → `winwidget.ru_frontends`
четыре приложения получают независимые image/deploy/rollback. Tracked
`nginx/frontend.conf` описывает Landing `:3000`, CRM `:3001`, Widgets `:3002`,
Admin `:3003` только на loopback одного текущего frontend VPS.

#### Локальная уборка после первого запуска WinCRM

07.09.2026 штатным `git worktree remove` без `--force` удалены восемь
временных рабочих копий из корня workspace:

- `winwidget.ru_infra_identity_manifest`;
- `winwidget.ru_infra_operations_api`;
- `winwidget.ru_services_notes_rollout`;
- `winwidget.ru_services_operations_api`;
- `winwidget.ru_services_operations_release`;
- `winwidget.ru_services_otp_release`;
- `winwidget.ru_services_otp_rollout`;
- `winwidget.ru_services_worker_recovery`.

Перед удалением проверены чистый Git status, untracked/ignored файлы,
точные HEAD на GitHub и отсутствие процессов с этими cwd/путями.
Все локальные/удалённые ветки и коммиты сохранены; копии можно восстановить
через Git. Основные три репозитория, `deploy`, `DOCUMENTATION` и пользовательские
файлы не удалялись. Новые backup/dump-копии для уборки не создавались.

#### Первичное переключение маршрутов

Перед первым переключением маршрутов:

1. Проверить текущую конфигурацию/слушающие порты и неизменённый backend
   caller: он не передаёт группу `FRONTEND_*`. Не включать существующий
   optional frontend-шаг backend-deploy для выпуска монорепозитория;
   обновление frontend не требует запуска backend rollout.
2. Проверить DNS `crm.winwidget.ru` и наличие/валидность отдельного TLS
   сертификата по указанному в конфигурации пути. До этого новый файл
   нельзя устанавливать: `nginx -t` не пройдёт с отсутствующим сертификатом.
3. Собрать и проверить независимые frontend images, их фактические revisions,
   production env и все четыре loopback upstream. Согласовать точный cutover
   существующего процесса на `:3000`, не останавливать его заранее без
   готовой замены и возможности rollback.
   До первого cutover сохранить `.next/static` действующего дорефакторингового
   image в namespace `legacy`, затем
   наполнить независимые namespaces новых приложений в
   `/opt/winwidget/deploy/frontend/assets/{legacy,landing,widgets,admin-panel,crm}/_next/static/`.
   Deploy helper должен проверить все коллизии путей и содержимого до первой
   записи, затем добавить union: одинаковые файлы оставить, новые добавить,
   изменившийся файл по старому пути отклонить. Store и его родители не должны
   быть symlinks; Nginx использует `disable_symlinks on` и не обходит их.
4. Устанавливать только согласованный immutable Nginx artifact атомарно под
   frontend lock, с сохранением предыдущего файла, `nginx -t` и reload.
   При ошибке вернуть прежнюю согласованную пару image/config. Сохранить
   доступность старых hashed assets и проверить уже открытую вкладку при
   переходе между зонами; одной проверки новой главной страницы недостаточно.
   Deploy/rollback не удаляет старые chunks автоматически. Retention и
   контроль диска согласуются отдельно; нельзя освобождать место слепой
   очисткой assets и ломать ещё открытые вкладки.
5. Выполнить проверки ниже. Контейнер CRM может быть опубликован до CRM
   backend только с действующим frontend release gate; это не разрешение
   развёртывать новые CRM сервисы или включать платежи.

После релиза проверить:

- deployment revision;
- загрузку главной, кабинета и админки;
- host `crm.winwidget.ru`, включая frontend billing/invitation routes;
- CSS/JS/fonts/image optimizer каждого `/_frontends/*/_next/` и отсутствие
  переписывания URI/query; неизвестные namespaces возвращают 404;
- static chunks берутся из своего store: main `/_next/static/` → `legacy`,
  три prefixed static пути → `landing|widgets|admin-panel`, CRM `/_next/static/`
  → `crm`; старый известный chunk работает после переключения image;
- отсутствующий static файл даёт Nginx 404 без Next/backend fallback,
  listing и symlinks недоступны; cache max-age соответствует `expires 1y`,
  security headers сохраняются на static ответах, включая ошибки;
- login/refresh/logout;
- OAuth `/social-auth`, переходы между зонами и iframe всех preview;
- API requests только через `/api/v1`;
- отсутствие обращений к retired upstream;
- iframe CSP main/preview и CRM DENY; порты `3000–3003` не опубликованы
  напрямую во внешнюю сеть;
- основные пользовательские сценарии изменённой области.

## Production env

Этот раздел задаёт структуру и правила, но не является шаблоном со значениями.
Канонический список переменных приложения находится в его `.env.example`.

```text
winwidget.ru_services/apps/<service>/.env.example
winwidget.ru_services/apps/<service>/.env.production   # ignored

winwidget.ru_frontends/.env.example
winwidget.ru_frontends/.env.production                  # ignored

deploy/backend/.env.production                         # ignored, canonical backend source
deploy/frontend/.env.production                        # ignored, canonical frontend source
deploy/.env.vps                                        # ignored, только доступы к VPS
```

На VPS у каждого сервиса лежит собственный `.env.production` рядом с его
deployment files. Infra controller атомарно формирует эти service-specific
файлы из защищённого канонического backend source и подключает только их
владельцам. Общего application env нет; container не получает переменные чужого
домена «на всякий случай».

Каждый `.env.example` содержит только относящиеся к приложению категории:

- runtime mode, port и deployment revision;
- URL собственной PostgreSQL для runtime/migration/backup process role;
- RabbitMQ URL, exchange/queue names и scoped credentials;
- Identity verifier/introspection URL и scoped service credential;
- URL/credential точных внутренних upstream;
- provider credentials только для owner service;
- scheduler, retry, lease, timeout и observability настройки;
- storage/SMTP/SMS/Telegram/YooKassa настройки только у владельца интеграции.

Admin DB credentials не передаются API, publishers или обычным workers.
`database-restore-worker` получает их отдельными secret mounts; `pg_dump`
выполняет только `maintenance-worker` read-only backup role.

Правила `.env.example`:

- файл попадает в Git и содержит все обязательные имена;
- значения пустые либо безопасные placeholders, никогда production secret;
- для boolean/enum/URL допустимые форматы описаны комментариями;
- удаление или переименование переменной выполняется вместе с кодом, Compose,
  validation, README и production env;
- Retired Core aliases не сохраняются ради совместимости.

Правила `.env.production`:

- файл игнорируется Git и имеет безопасные owner/mode;
- один файл обслуживает один service/deployment boundary;
- секреты не копируются в issue, chat, command arguments или CI logs и не
  передаются через Docker build args, image layer либо RabbitMQ;
- internal credentials различны по scope;
- Identity private signing key доступен только Identity runtime;
- URL PostgreSQL/RabbitMQ использует собственную роль, а не broad admin
  credential.

При любом изменении production env:

1. Скачать текущий серверный файл без печати содержимого.
2. Сравнить его SHA-256 с локальным.
3. При необъяснимом расхождении остановить mutation и определить источник
   истины.
4. Изменить локальный канонический файл.
5. Проверить только имена переменных, дубликаты, формат и обязательность.
6. Атомарно перенести exact файл на правильный VPS.
7. Восстановить безопасные owner/mode.
8. Снова скачать серверный файл и подтвердить побайтовое совпадение/SHA-256.
9. Одновременно обновить `.env.example` без production values.

Частичное слепое слияние, сборка production env из `.env.example` и изменение
только одной копии запрещены.

Безопасная диагностика может выводить только имена переменных, present/missing,
неразглашающую длину/тип, SHA-256 полного файла и результат parser/validation
без значений. Нельзя печатать `.env`, PEM, password files, Bot API URL с token,
database URL или provider credentials. При случайном раскрытии вывод
прекращается, источник называется без повторения значения, secret ротируется.

Перед rollout проверяются уникальность required variables, согласованность
revision/image identity, собственная database role, отсутствие private URLs в
Gateway, отсутствие Core/catch-all upstream, разные scoped credentials,
TLS/SNI Telegram relay и неизменность env SHA до/после deploy.

`POST /api/v1/payments/webhook` допускается только с опубликованных адресов
ЮKassa по `$remote_addr`; forwarded headers не являются источником доверия. При
любом изменении allowlist его целиком сверяют с
[официальной документацией входящих уведомлений](https://yookassa.ru/developers/using-api/webhooks),
а не дополняют по данным запроса или логов. Варианты пути с другим регистром,
trailing slash или дополнительным suffix отклоняются до Gateway.

## Миграции PostgreSQL

- Каждая БД принадлежит одному сервису.
- Добавляется новая immutable migration; уже применённые migrations не
  переписываются.
- DDL выполняет только migration role до rollout runtime.
- Runtime role не владеет schema, не имеет DDL и доступа к чужой БД.
- Migration tree и `_prisma_migrations` проверяются fail closed.
- Проверяется чистая PostgreSQL production major и текущая upgrade path, когда
  изменение зависит от истории.
- Изменения выполняются expand/contract; несовместимый rollback без совместимой
  schema запрещён.
- Перед destructive change доказываются отсутствие readers/writers и точный
  target; общий recursive cleanup запрещён.
- Restore и data recovery не смешиваются с application deploy.
- PrismaService регистрируется один раз в глобальном PrismaModule каждого root
  application context.

## Backup и restore

08.09.2026 scope `operations-backup-runtime` завершён на Services
`3c09cc535256d54519997514e693f0b43c8de143`, Infra
`b96e9acd876087edf2a4a37aa1bcf2efdfe77d99`: feature CI `34206229917`,
production deploy `34206570376` — SUCCESS. Четыре Operations process roles
обновлены без изменения соседних сервисов и без активации restore.
Registry содержит 13 backup-целей, 11 подписываемых целей и только семь
прежних restore-целей; четыре CRM-цели остаются backup-only.

После CRM schema upgrade повторный runtime-выпуск Services `72e1b425`
(CI `34237415802` — SUCCESS, production `34238336722` — FAILURE) остановлен
до admission и остановки процессов: initial-only guard запрещал уже
настроенные CRM backup URL. Контроллер дополнен точным steady-state режимом:
все четыре URL сохраняются неизменными только у worker; частичная настройка,
rotation и передача другим ролям отвергаются. Три focused tests, два packaging
tests и read-only replay полного prepare на сохранённом production snapshot
прошли. Четыре исходных Operations-процесса остались healthy; продолжение —
только новым green Infra/Services SHA, без повторного запуска старого failed SHA.

Совместимый forward-выпуск `operations-backup-runtime` завершён 08.09.2026:
Services `3113f4175aa5912c68fd9d9a7e02206003bafab9`, Infra
`992e85c562dc1e65d383ff295b350ccd5e982849`, production `34240193173` — SUCCESS.
Обновлены четыре Operations-процесса и CRM backup migration manifests после
успешного `crm-upgrade` Services `6eab2581089a90ccb88ca08ba9bae0481d483d1e`
(production `34235994499`) и frontend
`c193d5bf6d03225c463e6b170617dc9015cb68bf` (production `34237253888`).
Этот runtime-выпуск не расширяет restore registry и не доказывает внешнюю доставку новых
CRM-уведомлений или новые авторизованные browser-сценарии.

Отдельная конфигурационная активация `crm-intake-sla-activate` завершена
08.09.2026 на Services `779da5dfb5e8f421f9d317f5f97531e31428ba4e`,
pinned Infra `992e85c562dc1e65d383ff295b350ccd5e982849`:
feature CI `34241736825`, production `34247514494` — SUCCESS.
Последовательно обновлены ND worker, Intake SLA worker/publisher и Intake API;
runtime images сохранили revision `6eab2581089a90ccb88ca08ba9bae0481d483d1e`.
Post-deploy проверка подтвердила healthy CRM-процессы; соседние сервисы,
платёжные настройки и базовые task reminders сохранены. Правила клиентов
автоматически не включались, реальная внешняя доставка этим не доказана.

Полные canonical/CRM/ND env синхронизированы локально и на VPS с обратным
скачиванием и побайтовой проверкой. SHA-256 соответственно:
`2dbb73cd420be18899a350c6375bac07857c245a48b0937267a7ccdcd4bcff73`,
`a3c3b245a2fe17bb8f59d4e3baea72cb624d3a7ec838abffff72289b25704f51`,
`bc8f2e90eaade1120dfe54a4fbb95de9faa83aa4645923a365890616b25ec808`.
GitHub `BACKEND_PRODUCTION_ENV_SHA256` обновлён на canonical hash.
Write-once `crm/intake-sla-activation-baseline.json` имеет SHA-256
`623e94de4212b876017b388f43a7af71c4ca8c97950edde5154823fd41f4fe04`;
его нельзя перезаписывать или использовать для повторного initial provisioning.
Следующий code-only CRM upgrade должен сохранять все 21 CRM/companion role,
включая активные task reminders и Intake SLA.

Локальный frontend checkout переименован в `winwidget.ru_frontends` без
нового клона, копии или изменения production paths. HEAD/upstream/origin prod
совпали с `c193d5bf6d03225c463e6b170617dc9015cb68bf`, worktree clean;
три старых localhost smoke-сервера завершены до перемещения. GitHub API
08.09.2026 вернул 404 для старого repository ID `1351670384` и обоих
исторических frontend-имён; в списке доступных репозиториев владельца остались
только Frontends, Services и Infra. Это проверка отсутствия старого репозитория,
а не утверждение об успешности ранее отклонённого DELETE.

Первые четыре задания созданы штатным расписанием в 08:52 UTC, не вручную.
Read-only проверка durable результатов Operations подтвердила `SUCCEEDED`
для Sales (86 213 bytes), Customers (31 452), Intake (113 412) и Access
(68 433). У каждой записи `archiveDelivered`, `signatureCreated` и
`signatureDelivered` — `true`: архив и отдельный Ed25519 sidecar отправлены
в существующий Telegram-канал. Дополнительные dumps или локальные копии
для этой проверки не создавались. Это доказательство штатной доставки,
а не destructive restore, crash-recovery или достаточности PITR.

- Плановые backup jobs и policy принадлежат Operations.
- `maintenance-worker` запускает `pg_dump` read-only backup role.
- Telegram-копия — временный off-VPS logical backup, не PITR.
- Для 11 подписываемых целей (семь restore-targets и четыре CRM backup-only)
  `maintenance-worker` отправляет рядом с dump
  отдельный `.provenance.json`: exact evidence содержит backup job ID, target,
  имя/размер/SHA-256 artifact, services revision и trusted migration manifest,
  а envelope подписан Ed25519. Старый unsigned dump не является разрешённым
  source для нового permit. API проверяет подпись и exact binding при создании
  permit, restore-worker повторяет проверку перед fence и mutation; браузерная
  проверка sidecar является только ранней диагностикой и не trust boundary.
- Ed25519 private key существует только как непустой обычный файл
  `/opt/winwidget/deploy/backend/.database-backup-provenance-private-key.pem`
  с owner `root:root`, mode `0600`, link count `1` и без symlink. Root
  `.env.example` и production env не содержат provenance key ID/path:
  согласованные immutable services/infra releases закрепляют literal key ID
  `operations-backup-ed25519-2026-08-31` и literal host path непосредственно в
  Compose. Compose монтирует secret только в `operations-worker` как root-only
  source `/run/secrets/database-backup-provenance-private-key-source`. Image
  entrypoint
  проверяет тип/link/owner/mode source, создаёт и сверяет temporary copy как
  `root:root/0600`, затем переводит final-файл в `1001:1001/0400` внутри
  tmpfs-каталога `root:nodejs/0710` и атомарно публикует его по пути
  `/run/winwidget-operations-secrets/database-backup-provenance-private-key.pem`
  и только затем запускает PID 1 через `gosu` без root-прав. Bootstrap имеет
  `cap_drop: ALL` и exact `CHOWN`, `SETGID`, `SETUID`; `FOWNER` и
  `DAC_OVERRIDE` отсутствуют. API, restore-worker, migrate/outbox
  и остальные runtime не получают private key, source mount или runtime path.
  Public keys хранятся в tracked immutable keyring
  `apps/operations/restore-manifests/database-backup-provenance-public-keys.json`.
  Deploy до миграций проверяет tracked-файл, exact source/tmpfs/runtime scope,
  PID UID/GID 1001, runtime mode `0400` и соответствие active private/public
  Ed25519 пары без вывода содержимого или fingerprint. После rollout и в обеих
  steady-state фазах контроллер отдельно проверяет `/proc/1/status` фактически
  работающего worker: PID 1 — `node`, а все real/effective/saved/filesystem
  UID/GID равны `1001`, supplemental groups отсутствуют,
  `NoNewPrivs=1`, а inherited/permitted/effective/ambient capabilities нулевые;
  runtime-файл доступен, root-only source остаётся недоступным этому UID.
- `DATABASE_RESTORE_ENABLED` принимает только literal `true` или `false`, а
  resolved Compose обязан передавать exact одинаковое значение DEV API и
  restore-worker. Безопасный default `.env.example` — `false`. Production
  `true` разрешается только после зелёных provenance/private-key gates,
  повторяемой PostgreSQL 18 rehearsal-матрицы, exact read-only inventory
  pending job/permit/queue и отдельного recovery change window/approval.
  Routine deploy не создаёт restore job, но `true` разрешает worker исполнить
  уже существующую approved работу, поэтому включение нельзя считать
  недеструктивным application deploy. Deploy controller при `true` требует
  нулевые non-terminal restore jobs/permits/recovery actions/execution lease,
  pending restore Outbox и ready/unacknowledged main/retry RabbitMQ messages:
  первый раз до provisioning/migrations, второй — непосредственно перед
  recreate restore-worker. `RECOVERY_REQUIRED` входит в pending inventory
  только при `recoveryResolvedAt IS NULL`; завершённое recovery не блокирует
  следующее окно. Это snapshot-gate, поэтому recovery change window также
  запрещает параллельный enqueue. При `false` worker проверяет kill switch
  до claim обычного restore job; signed recovery и terminal reconciliation
  остаются доступны.
- До допуска к production обязательна повторяемая rehearsal-матрица в
  изолированном PostgreSQL 18 без production credentials и сетевого доступа к
  production target. Она должна покрывать все семь разрешённых targets,
  совместимый и несовместимый dump, нехватку диска, cancel/restart race,
  checkpoint resume, ACL drift и доказательство отсутствия cross-target
  доступа.
- Первый DEV запрашивает короткоживущий exact one-shot permit, привязанный к
  server-side job ID, source backup job ID, target, имени, размеру и SHA-256
  source dump, hash/key ID подписанного provenance envelope, точному
  40-символьному services SHA и SHA-256 доверенного migration manifest.
  Разрешение становится действующим только после подтверждения другим DEV и
  атомарно потребляется вместе с созданием job; повторное использование
  запрещено.
- Перед первым применением recovery migration таблица `database_restore_jobs`
  должна быть пустой. Migration блокирует её и fail closed отклоняет legacy
  jobs; автоматически удалять или переносить такие строки в deploy нельзя.
- В разрешённом rehearsal job выполняется изолированным
  `database-restore-worker` с admin credential ровно одной целевой БД. Job
  использует единственный active lease и durable phase checkpoints; повторная
  доставка не запускает destructive execution заново.
- Restore требует source SHA/TOC/migration/exact ACL checks, safety dump и
  post-restore verification. Ошибка после начала mutation сохраняет source и
  safety artifacts и переводит job в `RECOVERY_REQUIRED`, а не в обычный retry.
- API пишет upload только в staging. Restore-worker атомарно копирует exact
  approved SHA через file descriptor в worker-only sealed storage, выполняет
  `fsync` файла и каталога, повторно проверяет SHA/TOC/ledger и запускает
  `pg_restore` только по sealed path. Deploy дополнительно отклоняет разные
  пути, которые через bind mount указывают на одинаковые host device+inode.
  Sealed bind отсутствует у API и всех остальных runtime.
- Каждый terminal transition атомарно закрывает permit и создаёт immutable
  receipt только с hash/operational identifiers. Receipt подписывается HMAC
  SHA-256 ключом `DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64` и содержит
  `DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID`; signing key хранится только в env,
  передаётся ровно Operations API и restore-worker и не выводится в логи или
  БД. При первичном provisioning создаётся один новый случайный ключ; до
  появления current/previous keyring его запрещено заменять при выполняющемся
  restore или незакрытом `RECOVERY_REQUIRED`, а старые receipts должны
  оставаться проверяемыми по своему key ID.
- Для `RECOVERY_REQUIRED` первый DEV выбирает `VERIFY_AS_IS`,
  `ROLL_BACK_SAFETY` или `ROLL_FORWARD_SOURCE`, а второй DEV подтверждает
  действие, привязанное к hash immutable receipt. Recovery executor принимает
  только это exact approved action и перед любой проверкой или mutation
  переводит runtime, migration и backup roles целевой БД в `NOLOGIN`, завершает
  их активные sessions и сохраняет writer-fence evidence. Rollback и
  roll-forward предварительно повторяют SHA-256, TOC и migration-ledger
  проверки выбранного артефакта. Writer fence снимается только после повторной
  exact ACL/ledger проверки; итог закрепляется отдельным immutable signed
  recovery receipt. Сбой либо истечение lease оставляет или восстанавливает
  fence и требует нового dual-approved action.
- Writer fence физически закрывает application runtime/migration/backup roles.
  Единственный LOGIN SUPERUSER каждой цели — доверенный bootstrap-admin
  recovery control plane: его password-file монтируется только в один
  restore-worker, доступ API и обычным workers запрещён, а global CAS lease не
  допускает параллельное выполнение. Контракт запрещает другие LOGIN
  SUPERUSER, memberships этих ролей и неожиданные admin sessions. Fence не
  заявляет защиту при компрометации restore-worker либо admin secret; до
  multi-replica/remote recovery для этого нужна отдельная recovery proxy/session
  boundary.
- Временная ошибка restore consumer не возвращается tight-loop в main queue.
  Worker публикует исходный `Buffer` с `mandatory` и publisher confirm только в
  `winwidget.retry` по exact routing key
  `operations.database-restore.requested.v1.retry.v1`; исходное сообщение
  подтверждается лишь после обеих проверок публикации. Retry queue держит его
  30 секунд и через DLX возвращает в main queue. Счётчик попыток только
  диагностический: transport retries не имеют terminal cap, а malformed
  contract уходит в DLQ.
- Retired Core отсутствует среди backup/restore targets.
- Operations не является restore target: job, lease и recovery evidence сейчас
  принадлежат той же БД и не переживут self-restore. Возврат target допустим
  только после выноса control ledger в отдельную невосстанавливаемую границу.
- Billing временно не является restore target: его backup остаётся активным, а
  restore/ACL rehearsal выполняются только в отдельном платёжном scope.
- Restore registry содержит семь прежних service-owned targets. Четыре CRM
  backup-only цели не добавляются в permit/restore registry автоматически.
- Размер dump контролируется до 20 МБ: официальный
  [Telegram Bot API](https://core.telegram.org/bots/api#getfile) может отправить
  до 50 МБ, но стандартный `getFile` автоматически возвращает не более 20 МБ.
  Поэтому application upload limit 49 МиБ не считается recoverability gate;
  alert и переход на object storage должны сработать до 20 МБ.
- Source/safety artifacts нельзя удалять, пока открыто recovery-решение; после
  его закрытия действует закреплённый retention и контролируемая очистка.
  Production enqueue не включается без отдельной approved procedure и exact-SHA
  rehearsal. Зашифрованное versioned object storage становится обязательным,
  когда dump приближается к лимиту Telegram, измеренный RPO/RTO требует PITR
  либо текущий off-VPS канал перестаёт укладываться в SLA; до этого Telegram
  остаётся принятым временным off-VPS logical backup.

Незавершённые ограничения restore и перехода к object storage/PITR находятся в
[`backlog.md`](https://github.com/nda17/winwidget.ru_services/blob/prod/docs/backlog.md).

### Изолированный прогон свежих production artifacts

Этот шаг выполняется только после зелёных exact services/infra SHA и создания
семи свежих пар dump/sidecar на том же services SHA. Он не меняет production
env, не включает restore и не использует production PostgreSQL credentials.

1. В отдельном одобренном recovery window получить семь dump и семь sidecar из
   принятого off-VPS канала. Production DB artifacts могут содержать
   персональные данные: выгрузка требует отдельного явного разрешения. На VPS
   создать ровно
   `/var/lib/winwidget-operations/rehearsal-sources/<services-sha>/<set-sha>`
   как `root:root/0700`; 14 файлов должны быть regular, без symlink/hardlink,
   `root:root/0600`. Не использовать live `restore-staging` и `restore-sealed`.
2. Aggregate SHA-256 вычисляется по отсортированным file records
   `name\0size\0sha256\n`. Зафиксировать только итоговый hash; не выводить
   file IDs, Telegram token, строки БД или содержимое dump/sidecar.
3. Из чистого exact infra checkout запустить:

   ```bash
   INFRA_REVISION=<infra-sha> \
     scripts/run-isolated-restore-rehearsal.sh \
     <services-sha> \
     /var/lib/winwidget-operations/rehearsal-sources/<services-sha>/<set-sha> \
     <set-sha>
   ```

   SSH-переменные берутся из обычного защищённого local deploy boundary; script
   не читает и не передаёт `.env.production`.

4. Controller удерживает canonical production deploy lock и отдельный
   rehearsal lock. Operations image ID обязан иметь exact revision label, а
   pinned PostgreSQL 18 image — exact digest, `PGDATA` и volume contract.
   Отсутствующий pinned image заранее загружается как отдельная проверяемая
   подготовительная операция; сам rehearsal не делает network pull.
5. PostgreSQL запускается без сети, ports и persistent volume; runner имеет
   только `container:<postgres-id>` network namespace. Оба rootfs read-only,
   database/work — tmpfs, capabilities dropped, `no-new-privileges`; runner не
   получает Docker socket, Compose, production env или secrets. Master switch
   обязан оставаться literal `false`.
6. `SUCCEEDED` требует ровно семь Ed25519 sidecar с exact SHA/revision/manifest
   и PostgreSQL tool versions, успешные normal restore + `VERIFY_AS_IS` +
   `ROLL_BACK_SAFETY` + `ROLL_FORWARD_SOURCE`, exact checkpoints и финальные
   ACL/ledger/writer-fence проверки. Cleanup failure отменяет успех.
7. Проверить два sanitized evidence файла и их SHA-256 в
   `/var/lib/winwidget-operations/rehearsal-evidence/<run-id>`. После доказанного
   cleanup удалить исходный защищённый artifact set отдельной exact-path
   операцией; при ошибке оставить его закрытым для расследования/повтора.
8. Результат не покрывает dual approval, permit/Outbox/worker CAS, signed
   terminal/recovery receipts, restart/redelivery, retention и alerts. Эти
   пункты остаются release gates, а `DATABASE_RESTORE_ENABLED` — `false` до
   отдельного принятого решения.

### Ротация Ed25519 backup provenance

1. Вне репозиториев и логов создайте новую Ed25519 пару: PKCS#8 PEM private key
   и SPKI DER public key. Назначьте новый уникальный key ID и офлайн проверьте
   пару до изменения production. Private bytes, fingerprint и команды с ними
   не помещайте в CI output или тикет.
2. Подготовьте immutable release A: добавьте новый public key в tracked keyring
   services рядом со старым, но оставьте Compose literal active key ID старым.
   Получите green tests/CI exact SHA и выпустите release A со старым host
   private key. Старый public key не удаляйте: он нужен для всех ещё допустимых
   к restore sidecar, permit и job.
3. Подготовьте и проверьте согласованные immutable services/infra release B:
   keyring содержит старый и новый public keys, а Compose literal active key ID
   и exact infra-validator меняются на новый. Root `.env.production`,
   `.env.example` и `BACKEND_PRODUCTION_ENV_SHA256` при этой ротации не меняются
   и не должны содержать provenance key ID/path.
4. Остановите автоматические deploy/recreate, убедитесь, что backup job не
   находится в `PROCESSING`, и в отдельном change window получите exclusive
   flock ровно на
   `/opt/winwidget/deploy/backend/.production-deploy.lock`. Сохраните старый
   private key только в защищённом offline rollback-контуре на ограниченный
   срок; на VPS одновременно активен один private key.
5. Удерживая этот lock, установите новый private key через temporary file в том
   же root-owned каталоге: owner `root:root`, mode `0600`, `fsync`, затем atomic
   rename ровно в
   `/opt/winwidget/deploy/backend/.database-backup-provenance-private-key.pem`.
   Не изменяйте байты текущего inode на месте. Уже запущенный worker продолжает
   видеть старый bind-mounted inode; до освобождения lock для release B
   запрещены ручной restart, recreate и параллельный deploy.
6. Освободите lock только для немедленного запуска exact release B controller.
   Любой промежуточный старый release обязан fail closed на несовпадении пары
   до production mutation. Release B deploy до миграций проверяет source,
   создаёт runtime directory `root:nodejs/0710` и exact file `1001:1001/0400`,
   подтверждает нулевые capabilities PID 1 UID/GID 1001 и совпадение derived
   public key с новым literal key ID. Source/runtime private key отсутствует у
   остальных containers, а host inode/hash не меняется внутри deploy.
7. После rollout создайте новый недеструктивный backup каждого активного
   restore-target и проверьте sidecar/permit verification без запуска restore.
   Rollback выполняется только как exact возврат согласованной тройки release
   B/A + literal active key ID/keyring + private key; смешивать поколения
   запрещено.
8. Старый public key удаляется только после доказанного окончания retention и
   restore eligibility всех подписанных им artifacts и отсутствия ссылок из
   permits/jobs. Старый private key после rollback-window уничтожается; его
   наличие не требуется для проверки старых подписей.

## Telegram

Все исходящие вызовы Telegram backend выполняет через HTTPS reverse proxy
`https://tg.winwidget.ru/telegram-api`, закреплённый на bridge
`185.184.122.62`. Через этот runtime-маршрут идут сообщения, чат оператора,
сводки и backup files. Отдельный публичный listener `185.184.122.62:8443`
остаётся fixed-upstream raw TLS relay к `api.telegram.org`, но backend services
его не используют. Входящие webhook проходят через `tg.winwidget.ru` к точным
Identity и Support routes.

После изменения bridge обязательны `nginx -t`, проверка listener/firewall,
TLS smoke и реальные Auth/Info/Support webhook checks. Bot token и URL с token
не должны попадать в команды, логи или документацию.

Routine workflow этого репозитория разворачивает backend Nginx и опционально
frontend Nginx, но не устанавливает bridge-конфигурацию. Изменение файлов
`nginx/telegram-bridge/` остаётся внешним release gate: нужен отдельно
проверенный SSH-доступ к bridge VPS, атомарная установка exact tracked files,
`nginx -t`, reload и сравнение SHA-256. Отсутствующие credentials нельзя
подменять выдуманными secrets или обходом host-key verification.

## Чеклист production-деплоя

### До запуска

- [ ] Exact services revision является `github.sha` push-события в `prod`, вся
      service matrix зелёная, а reusable infra workflow закреплён по exact
      revision с зелёным required CI.
- [ ] Выпускаемые рабочие деревья чистые.
- [ ] Изменения DB имеют service-owned migration и при необходимости проверены
      на чистой PostgreSQL 18.
- [ ] Изменения env отражены в `.env.example` без секретов; локальный и VPS
      production env совпадают по SHA-256.
- [ ] Известны точный owner service и изменяемые routes; остальные сервисы не
      включаются в rollout без необходимости.
- [ ] Для schema-compatible runtime rollback известен проверенный previous
      image/digest.

### Production preflight

- [ ] Deploy lock свободен и затем захвачен каноническим script.
- [ ] Docker context и SSH target указывают на нужный production VPS.
- [ ] Диск, RAM и Docker daemon исправны.
- [ ] Все девять PostgreSQL service databases и RabbitMQ healthy; broker alarm
      и необъяснимый backlog отсутствуют.
- [ ] Зафиксирована current Gateway/public revision.
- [ ] До любых RabbitMQ mutations и миграций read-only preflight подтвердил
      имя Operations DB, schema/role boundaries, текущие critical tables,
      точный набор running Compose services, идентичность остановленных
      project cleanup-кандидатов и текущий RabbitMQ user inventory.
- [ ] Остановленные containers других Compose projects не включены в target;
      `paused`, `restarting`, `removing` и неоднозначные labels/name блокируют
      cleanup fail closed.

### Выполнение backend deploy

- [ ] Release-job после зелёной service matrix вызвал только закреплённый по SHA
      reusable infra workflow; canonical caller/event/ref/input gates зелёные,
      services checkout соответствует exact `github.sha`.
- [ ] Migration jobs используют отдельные migration credentials; runtime не
      получает admin/backup credentials.
- [ ] После migrations и до rollout подтверждён единственный
      `operations.service_identity`: `operations-service` и валидный
      `database_id` UUID.
- [ ] External PostgreSQL volumes не удаляются и не пересоздаются. При
      декларативном пересоздании PostgreSQL/RabbitMQ container из-за Compose
      config drift данные остаются во внешнем volume.
- [ ] Nginx configuration проходит syntax check до reload.
- [ ] RabbitMQ topology создаётся только из текущих service-owned contracts.
- [ ] После health/public revision, Telegram proxy и env-integrity gates, но до
      cleanup полностью прошёл недеструктивный steady-state gate: routing,
      legacy queues/users, exact RabbitMQ users, временные Core
      container/volume/артефакты, listener `:4200` и exact running services.
      Остановленные project containers уже прошли строгую проверку
      labels/name/state.
- [ ] Удалены только stopped containers точного Compose project `winwidget` и
      только неиспользуемые теги семейств `winwidget-*`, исключая
      `winwidget-crm-*` даже без container binding; image ID каждого
      оставшегося container не изменился. Перед и сразу после каждого
      `docker image rm --no-prune` running ID set совпал с baseline.
- [ ] Volumes, networks, BuildKit/build cache, images других семейств и
      `<none>` images не очищались; `prune`, `--force` и `--remove-orphans` не
      использовались.

### Проверка после backend deploy

- [ ] Local Gateway readiness возвращает `200`.
- [ ] Public deployment endpoint возвращает `200` и exact services revision.
- [ ] Каждый ожидаемый container healthy и использует exact image/revision;
      лишних runtime и остановленных project containers нет.
- [ ] После cleanup повторно полностью прошёл steady-state gate; отсутствуют
      retired/stopped project containers и все проверяемые legacy/Core
      invariants остаются истинными.
- [ ] Текущее значение Telegram operational alerts в Operations совпадает с
      Reporting projection, а активный RabbitMQ binding единственный.
- [ ] Negative invariants про `:4200`, legacy users/queues и fallback routes
      остаются истинными.
- [ ] `Outbox PENDING`, ready и unacknowledged не имеют необъяснимого роста;
      retry/DLQ соответствуют owner topology.
- [ ] Identity JWKS и fail-closed introspection работают.
- [ ] Required route без Bearer возвращает `401`, неизвестный route — `404`.
- [ ] Platform content read/save работает через Platform API.
- [ ] Support webhook и operator chat идут через Support.
- [ ] Operations отображает audit/queues/backup state без fallback.
- [ ] Widgets runtime URL и public request работают.
- [ ] Reporting read model и scheduler state доступны.
- [ ] Billing technical health/route smoke зелёный; реальная оплата не считается
      проверенной без отдельного платежа с участием пользователя.
- [ ] Production env повторно скачан и совпадает с локальным SHA-256.
- [ ] Lock освобождён, временные controller/staging files отсутствуют.

### Frontend deploy

- [ ] Exact client revision имеет green CI.
- [ ] Frontend production env синхронизирован по тем же правилам.
- [ ] Next.js runtime использует production API origin.
- [ ] Главная, кабинет, админка и login/refresh/logout работают.
- [ ] Изменённый пользовательский сценарий проверен в browser Network/Console.
- [ ] Запросов к retired upstream или внутренним портам нет.

### Backup, restore и Telegram

- [ ] Operations registry содержит ровно семь разрешённых service-owned
      targets; Operations self-restore и Billing отсутствуют, у каждой активной
      БД есть актуальный успешный scheduled backup.
- [ ] Dump не приблизился к лимиту Telegram; retention/deletion и backup
      freshness/failure alerts имеют проверенное evidence.
- [ ] Изолированная PostgreSQL 18 rehearsal-матрица зелёная для каждого target
      и обязательных failure/cancel/restart/ACL сценариев.
- [ ] Exact target, source SHA-256, services SHA и trusted migration manifest
      SHA-256 совпадают с short-lived one-shot permit; request и approval
      выполнили разные DEV.
- [ ] Lease/checkpoints, exact ACL, safety dump, immutable signed terminal
      receipt и approved recovery procedure имеют сохранённое evidence без
      секретов.
- [ ] `DATABASE_RESTORE_ENABLED` — literal `true|false` и одинаков в API/worker;
      для `true` отдельно сохранены green provenance/key gate, PostgreSQL 18
      rehearsal, нулевые DB/Outbox/RabbitMQ pending-work inventories перед
      mutations и worker rollout, recovery change window и operational
      approval. Recovery executor запускает действие только после exact receipt
      binding и подтверждения вторым DEV, а writer fence остаётся fail-closed
      при любой незавершённой фиксации результата.
- [ ] `RECOVERY_REQUIRED` job сохраняет source/safety artifacts; действие
      привязано к receipt hash и подтверждено вторым DEV; SHA/TOC/ledger
      проверяются до mutation, а signed recovery receipt создан до признания
      incident закрытым.
- [ ] `:8443`, TLS/SNI, Nginx, listener, firewall и upstream smoke зелёные.
- [ ] Auth, Info и Support webhook status корректен; сообщение, чат оператора,
      сводка и backup используют relay.
- [ ] Bot token, URL с token и payload отсутствуют в логах проверки.

## Действия при ошибке

1. Остановить повторные mutation и сохранить первый failing gate; старый failed
   SHA после изменения кода не запускать.
2. Зафиксировать exact revision, container/image IDs, health и migration state
   без секретов.
3. Определить, затронуты только runtime image/config либо schema/data.
4. При совместимой schema вернуть только затронутый service на проверенный
   previous digest, остальные приложения не перезапускать.
5. При DB fence использовать только Operations recovery procedure.
6. Временную production-правку перенести в Git, создать новый commit, получить
   green CI и повторить routine deploy с полным post-deploy checklist.

### Configuration-only подключение DaData после выпуска Customers

08.09.2026 scope завершён на Services
`db1620642d24252f71f94c9f216149b4d1d1dc1d`, pinned Infra
`b96e9acd876087edf2a4a37aa1bcf2efdfe77d99`: feature CI `34207420064`,
production deploy `34210156045` — SUCCESS. Customers API сохранил image
revision `6bce89bbb202be91cbb94915b4b396ae257c2926`; read-only runtime proof
вернул только `keyConfigured: true`, без значения ключа. Базовый snapshot
`crm/customers-provider-baseline.json` имеет SHA-256
`929843c3776d0d5f02e2f6ac7d139c10416be93525513317b578bf4d13b08086`.
Повторная первичная активация и перезапись baseline не нужны. Последующий
авторизованный browser smoke подтвердил поиск ПАО СБЕРБАНК по ИНН 7707083893
и явное заполнение полей формы; новую компанию не сохраняли.
Сам config-only deploy не выполнял provider HTTP или бизнес-команды.

Scope `crm-customers-provider-config` применяется только после успешного
`crm-upgrade` с реализованным server-side adapter. Это не повторный запуск
`crm-commerce-activate` и не изменение правил code-only upgrade. Единственная
разрешённая effective Env-дельта — `CRM_CUSTOMERS_DADATA_API_KEY` из явно
пустого значения в 40-hex ключ только у `winwidget-crm/crm-customers-api`.
Ротация уже непустого ключа, новые flags, изменение image/revision, URL БД,
mounts, ports, limits, security, команд или соседних контейнеров не разрешены.
Ручной ввод компаний остаётся доступным; авторизацию и квоты lookup по-прежнему
проверяет Customers API. Контроллер не делает запросов к DaData и не меняет SQL.

Закрытые JSON bundles `crm-commerce-activate`, `crm-reminders-activate` и
`crm-customers-provider-config` ограничены 144 KiB на public-code файл,
512 KiB на полный decoded envelope и 112000 bytes на encoded SSH payload.
Закрытый `crm-intake-sla-activate` добавляет один exact topology module: decoded
лимит прежний, encoded лимит только этого scope — 116000 bytes. Дополнительно
проверяется полный SSH command с Nginx payload и всеми hashes: меньше 131072 bytes.
Лимиты остальных scopes не меняются.
Точные имена файлов, их SHA-256, pinned Infra/Services SHA и scope-specific
approval обязательны. Приватные env-файлы, shell и остальные одиночные Node
payloads ограничены прежними 128 KiB. Только точный общий
`scoped-service-release.mjs`, включающий проверенные owner-ledger proofs,
допускает 144 KiB также в standalone transport. Ограничение совпадает у
source guard и remote decoder для всех существующих scopes, выбирающих этот
модуль. Их encoded SSH budget остаётся 90000 bytes; это не расширяет scope,
авторизацию или допустимые production-изменения.

Порядок оператора:

1. Завершить текущие CRM/Operations rollout; baseline брать **после** них.
   Под глобальным `.production-deploy.lock` сверить полные canonical и CRM env
   с локальными файлами по принятой двусторонней процедуре. Ключ из локального
   игнорируемого файла перенести только в полную CRM `.env.production`,
   атомарно установить её root:root/0600 и скачать обратно для byte/hash proof.
   Не передавать ключ через workflow input, CLI аргумент или отдельный mount.
2. Снять `docker inspect` всех контейнеров Compose projects `winwidget` и
   `winwidget-crm` непосредственно в root-private файл (не stdout). В isolated
   Node-контейнере с public modules из exact green Infra SHA вызвать
   `customersProviderBaseline(live, gatewayRevision, {canonical, crm})` из
   `scripts/crm-customers-provider-config.mjs`. Значения `canonical`/`crm` —
   SHA-256 уже подготовленных полных env. Функция проверит healthy baseline,
   всё ещё пустой runtime ключ и соседей. Результат содержит только IDs/hashes.
3. Сериализовать результат как `JSON.stringify(result) + '\n'` и атомарно
   установить root:root/0600 в
   `/opt/winwidget/deploy/backend/crm/customers-provider-baseline.json`.
   Не переставлять JSON-ключи вручную: контроллер сравнивает канонические bytes.
   Зафиксировать SHA-256 результата, gateway revision, SHA-256 CRM env и
   согласованный canonical hash в соответствующем GitHub secret.
4. В новом Services commit вызвать reusable production workflow, pinned на
   exact green Infra SHA, с `release_scope: crm-customers-provider-config`,
   `expected_live_revision`, `expected_service_env_sha256` и
   `expected_crm_customers_provider_baseline_sha256`. Перед prod push получить
   green CI для этого точного Services SHA. Другие scope-specific baseline
   inputs должны быть пустыми. Новые runtime images этот scope не собирает.
5. Контроллер под тем же lock сверяет baseline/полные файлы/payload, создаёт
   root-private plan и runtime config в
   `crm/customers-provider-activations/<Services SHA>/`, пишет отдельные
   durable `admission.json`, `switching.json`, `started.json`,
   `observed.json`, `completed.json`. Останавливает исходный ID и создаёт
   только Customers API с `--no-build --pull never --no-deps` на прежнем image.
   `completed.json` допускается только при healthy exact replacement и
   неизменном fingerprint всех соседей, включая Gateway и PostgreSQL.
6. При неопределённом stop/create не удалять receipts и не вызывать Compose
   вручную: повторный запуск того же неизменённого контроллера наблюдает
   существующий результат без второго stop/create. Старый ещё running после
   unknown stop или отсутствующий результат create требуют проверки оператора,
   не автоматического повтора. Любая правка кода требует нового green SHA,
   а уже начатый переход — явного forward recovery, не rollback.
7. После успешного runtime proof отдельно проверить поиск ИНН через обычный
   авторизованный UI: просмотр результата и подтверждение заполнения формы.
   Реальный provider HTTP и бизнес-данные не входят в работу deploy controller.

Ручные ad hoc изменения production Compose/Nginx/env должны быть немедленно
возвращены в `winwidget.ru_infra`; временный VPS-файл не является источником
истины.

## Чат поддержки CRM: scoped release и отдельное включение

`support-chat` и `support-chat-activate` выполняются только существующим
immutable Services production workflow через pinned Infra controller и общий
`.production-deploy.lock`. Они не используют `all`, не синхронизируют env и не
отправляют тестовые email/Telegram. Перед каждым этапом синхронизировать полные
canonical/owner env в обе стороны по правилам проекта и получить новый baseline.

`scripts/support-chat-release.mjs` экспортирует `supportChatBaseline` и
`supportChatBaselineSha256`; CLI `baseline`/`baseline-sha256` принимает приватный
JSON stdin `{containers, envHashes, gatewayRevision}`. `containers` — полный
`docker inspect` running inventory; наружу helper возвращает только SHA256 и
безопасные OCI/container identities. `envHashes` содержит ровно `canonical`,
`identity`, `notificationDelivery`, `operations`, `support`, `crm`. Canonical —
`/opt/winwidget/deploy/backend/.env.production`, CRM —
`/opt/winwidget/deploy/backend/crm/.env.production`, остальные четыре —
`/opt/winwidget/winwidget.ru_services/apps/<owner>/.env.production`.
Workflow inputs: `expected_live_revision` — Gateway revision,
`expected_service_env_sha256` — полный CRM env hash,
`expected_support_chat_baseline_sha256` — результат helper; canonical hash
передаётся существующим `BACKEND_PRODUCTION_ENV_SHA256`.

Первый этап обновляет только Identity API, CRM Access API, четыре Operations
процесса, единый `notification-delivery-worker`, три Support процесса и Gateway.
Каждый процесс сохраняет чужие env/configuration; остальные контейнеры и базы
не перезапускаются. Разрешены только миграции
`20260909010000_add_support_notifications` и
`20260909160000_add_web_support_chat`. Неисполненная Operations migration
`20260910110000_remove_admin_backlog` остаётся отложенной. Backup и restore
manifests допускают только две новые service-owned миграции. Operations backup
и restore workers останавливаются на время изменения схем после проверки idle,
затем запускаются с совместимым manifest. API/publisher роли не запускают dump.

На первом этапе `SUPPORT_WEB_CHAT_ENABLED=false`, три новых ND kinds отсутствуют.
Контроллер добавляет только `/api/v1/support` с `authPolicy=required`, upstream
`http://127.0.0.1:5100`, timeout 30000; существующий `/api/v1/support/admin` и
Telegram webhook сохраняются. Support → CRM Access использует порт 5300,
`SUPPORT_CRM_ACCESS_TOKEN` / `CRM_ACCESS_SUPPORT_TOKEN`; ND → Support — отдельный
`SUPPORT_NOTIFICATION_DELIVERY_TOKEN`. S3 credentials есть только в Support API.
Support bot в ND служит только outbound transport через прежний relay.

Broker provisioning расширяет конечные exact ACL только трёх существующих
principals: ND, Support worker и Support publisher. Добавляет 20 durable classic
queues: четыре независимых main/retry1–3/DLQ семейства. ND очереди используют
`retry-v2`, outcome очередь `winwidget.support.notification-outcomes.v1` —
`retry-v1`. TTL 30s/5min/30min, dead-letter destination `winwidget.manual-retry`.
Никакие сообщения, очереди, users или чужие permissions не удаляются.

Для второго этапа сначала синхронизировать env с `SUPPORT_WEB_CHAT_ENABLED=true`
и добавить к прежнему ND списку ровно
`support-team-email,support-team-telegram,support-client-email`; сохранить все
старые kinds. `support-chat-activate` проверяет прежние image IDs и отсутствие
изменений apps относительно live revision, затем обновляет только ND worker,
Support worker, publisher и API, в таком порядке. Broker на этом этапе только
проверяется. Настройки получателей/каналов включаются авторизованным оператором
в админке после готовности runtime; delivery smoke выполняется отдельно.

При остановке этапа приватные baseline/desired/rollback/state файлы остаются в
root-only `.support-chat[-activate]-release-<SHA>.*` под backend deploy directory.
Для повтора нужен свежий baseline фактических процессов и env. Не откатывать
применённые миграции, не удалять retained события и не возвращать старые ND или
Operations readers поверх новых контрактов. При recovery изменения production
env проходят ту же полную двустороннюю синхронизацию; runtime-only env overrides
не являются способом выключения чата. Исторические CRM activation scopes не
использовать после расширения ACL: их прежние exact contracts намеренно не
принимают новый Support topology. Следующий несвязанный rollout должен сохранить
этот дополнительный контракт, а не повторно provision старой ACL-конфигурации.
