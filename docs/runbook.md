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
      только неиспользуемые теги семейств `winwidget-*`; image ID каждого
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
