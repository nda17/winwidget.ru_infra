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
`winwidget.ru_client`.

## Топология

```text
Frontend VPS
  -> Next.js + Nginx

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

- `winwidget.ru_client` — Next.js frontend;
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
2. Проверить production deploy lock и отсутствие другого активного rollout.
3. Сравнить локальный и VPS production env без вывода значений секретов.
4. Запустить только канонический infra workflow/script.
5. Дождаться migrations и rollout exact application revisions.
6. Выполнить полный checklist ниже.

Исполняемая реализация —
`winwidget.ru_infra/scripts/deploy-services-production.sh`. Если GitHub Actions
временно недоступен, ручной fallback выполняется тем же каноническим script с
теми же exact revisions, production lock, env checks и post-deploy gates. Ad
hoc Compose поверх production запрещён. После восстановления Actions состояние
обязательно сверяется новым routine deploy.

Обычный deploy не удаляет и не пересоздаёт внешние PostgreSQL volumes.
PostgreSQL-контейнеры и RabbitMQ обычно остаются запущенными, но Compose может
декларативно пересоздать инфраструктурный контейнер при изменении его
конфигурации. Данные при этом сохраняются во внешних volumes. Database
bootstrap/restore — отдельные административные операции.

### Frontend

Frontend выпускается из exact green SHA `winwidget.ru_client` через его
workflow. После релиза проверить:

- deployment revision;
- загрузку главной, кабинета и админки;
- login/refresh/logout;
- API requests только через `/api/v1`;
- отсутствие обращений к retired upstream;
- основные пользовательские сценарии изменённой области.

## Production env

Этот раздел задаёт структуру и правила, но не является шаблоном со значениями.
Канонический список переменных приложения находится в его `.env.example`.

```text
winwidget.ru_services/apps/<service>/.env.example
winwidget.ru_services/apps/<service>/.env.production   # ignored

winwidget.ru_client/.env.example
winwidget.ru_client/.env.production                    # ignored

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
- Restore инициируется только DEV control plane и выполняется изолированным
  `database-restore-worker` с admin credential целевой БД.
- Restore требует manifest/SHA/TOC/migration/ACL checks, fence, safety dump и
  post-restore verification.
- Retired Core отсутствует среди backup/restore targets.
- Registry содержит только активные service-owned targets, а каждый активный
  target имеет актуальный успешный плановый job.
- Размер dump контролируется до приближения к лимиту Telegram.
- Реальный restore требует exact target, permit и approved recovery procedure;
  он не запускается через обычный API runtime или RabbitMQ consumer.

Незавершённые ограничения restore и перехода к object storage/PITR находятся в
[`backlog.md`](https://github.com/nda17/winwidget.ru_services/blob/prod/docs/backlog.md).

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

- [ ] Выбраны exact services и infra revisions с зелёным required CI.
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
      точный live Compose inventory и текущий RabbitMQ user inventory.
- [ ] Negative invariants verifier подтверждает отсутствие legacy Core
      containers, listener `:4200`, users, queues и fallback routes.

### Выполнение backend deploy

- [ ] Используется только канонический infra workflow/script, services checkout
      соответствует exact revision.
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

### Проверка после backend deploy

- [ ] Local Gateway readiness возвращает `200`.
- [ ] Public deployment endpoint возвращает `200` и exact services revision.
- [ ] Каждый ожидаемый container healthy и использует exact image/revision;
      лишних runtime containers нет.
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

- [ ] Operations registry содержит только активные service-owned targets, у
      каждой активной БД есть актуальный успешный scheduled backup.
- [ ] Dump не приблизился к лимиту Telegram.
- [ ] Для реального restore определены exact target, manifest, SHA, permit,
      fence, safety dump и approved recovery procedure.
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
