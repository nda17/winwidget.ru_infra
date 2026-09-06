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

### WinCRM: отдельная opt-in конфигурация, ещё не production runtime

В `winwidget.ru_services/deploy/docker-compose.crm.yml` описан отдельный
Compose project `winwidget-crm`. Он не объединяется через `-f` с действующим
`docker-compose.prod.yml` и не подключён к routine release controller.
Само наличие конфигурации, зелёный shape test или запущенный CRM frontend
не разрешают запуск backend, открытие Gateway routes, Trial или продаж.

Состав профилей:

| Профиль | Состав | Назначение |
| --- | --- | --- |
| `crm-runtime` | Access 3, Intake 7, Customers 1, Sales 1 | 12 раздельных API/worker/publisher процессов |
| `crm-databases` | 4 PostgreSQL 18 | Собственные БД, сети, volumes и admin password files |
| `crm-migrations` | 4 однократных процесса | Тот же immutable image, отдельная migration credential |

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
с существующими Identity/Billing/Widgets ещё должна быть доказана controller.
Commerce и оба native Widgets flags по умолчанию выключены.

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

До первого запуска нужны capacity/business/browser gates из service backlog,
DB provisioning/grants, actual image/migration evidence, broker ACL/bindings,
согласованный Identity/Billing cutover и отдельный CRM-only controller.
До первого CRM provisioning выпустить совместимый routine controller.
Его canonical backend env принимает `CRM_RABBITMQ_CONTRACT=disabled`
(также значение по умолчанию при отсутствии переменной) или `native-v1`.
Другие значения, включая пустое, блокируют выпуск. `disabled` сохраняет
прежние 16 пользователей; `native-v1` требует ровно прежние 16 плюс восемь
process-scoped CRM principals из Compose. Любой лишний или отсутствующий
пользователь блокирует preflight и steady-state; discovery/wildcard нет.
Routine controller не создаёт и не меняет CRM credentials/ACL/queues.
В `native-v1` он сохраняет в topic write ACL Widgets ровно дополнительное
событие `widgets.wincrm.lead-transfer.requested.v1`, не расширяя остальные
resource/read grants. Это не включает product flags, Trial или продажи.

Первый CRM controller должен под общим deploy lock provision все восемь
principals, их ACL и durable bindings, подтвердить их и согласованно перевести
canonical env в `native-v1` с обязательной двусторонней синхронизацией.
Неполный bootstrap нельзя обходить routine deploy: сначала завершить или
восстановить точное состояние под тем же lock, без purge. Не переключать
контракт обратно в `disabled` при остановке CRM runtime, пока остаются его
principals или события. Подготовка кода не доказывает, что этот контракт
уже включён на VPS; production env этой подготовкой не изменяется.
Поведенческий тест исполняет фактический shell preflight и определения
provisioner на synthetic данных, проверяя неизменность остальных grants.
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

Frontend выпускается из exact green SHA собственного репозитория через его
workflow; при переходе `winwidget.ru_client` → `winwidget.ru_frontends`
четыре приложения получают независимые image/deploy/rollback. Tracked
`nginx/frontend.conf` описывает Landing `:3000`, CRM `:3001`, Widgets `:3002`,
Admin `:3003` только на loopback одного текущего frontend VPS.

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

- Плановые backup jobs и policy принадлежат Operations.
- `maintenance-worker` запускает `pg_dump` read-only backup role.
- Telegram-копия — временный off-VPS logical backup, не PITR.
- Для семи restore-targets `maintenance-worker` отправляет рядом с dump
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
- Registry содержит семь остальных active service-owned targets, а каждый
  target имеет актуальный успешный плановый backup job.
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

Ручные ad hoc изменения production Compose/Nginx/env должны быть немедленно
возвращены в `winwidget.ru_infra`; временный VPS-файл не является источником
истины.
