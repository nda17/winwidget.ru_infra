# Инфраструктура WinWidget

Репозиторий `winwidget.ru_infra` содержит контроллер production-деплоя и
эксплуатационные инструкции. Исходный код приложений, Dockerfile, схемы Prisma и
production-манифест Compose остаются в `winwidget.ru_services`, а фронтенд — в
`winwidget.ru_frontends`. Канонические Nginx-конфигурации backend и frontend
хранятся соответственно в `nginx/backend-api.conf` и `nginx/frontend.conf`.

Production-секреты и файлы `.env.production` никогда не хранятся в этом
репозитории, не передаются через GitHub и не выводятся в логи. На VPS контроллер
формирует десять файлов с переменными отдельных сервисов из канонического
источника, SHA-256 которого заранее одобрен.

## Контракт production-деплоя

Единственная точка входа — reusable workflow
[`deploy-production.yml`](.github/workflows/deploy-production.yml), закреплённый
в вызывающем workflow неизменяемым 40-символьным SHA infra. Его вызывает только
release-job репозитория `nda17/winwidget.ru_services` после push точного commit
в `prod` и успешного завершения lifecycle gate и всей матрицы сервисов. Ручного
`workflow_dispatch` и ввода произвольного SHA нет.

Called workflow fail closed проверяет canonical caller, событие `push`, ветку
`refs/heads/prod` и равенство `services_revision == github.sha`. Собственный
infra controller он получает по `job.workflow_repository` и
`job.workflow_sha`, после чего по SSH с закреплённым ключом хоста запускает
[`deploy-services-production.sh`](scripts/deploy-services-production.sh).

Отдельный workflow [`Verify infrastructure`](.github/workflows/ci.yml)
запускается на каждый push и pull request. Он не использует production secrets
и SSH, не меняет внешнее состояние и проверяет shell/YAML/embedded JavaScript,
единственный steady-state CLI, read-only DB boundary preflight, точный live
Compose inventory, текущую Operations/Reporting routing projection,
legacy-negative guards и Nginx-контракты. Только его зелёный результат является
CI-доказательством exact infra SHA; production workflow не заменяет эту
проверку.

Ревизия сервисов должна совпадать с commit, полученным из `origin/prod`; SHA из
другой ветки или более старый достижимый commit отклоняется. Контроллер имеет
только steady-state deploy mode. До любых RabbitMQ mutations и миграций он fail
closed проверяет имя Operations DB, schema/role boundaries, текущие critical
tables, точный набор уже работающих Compose services и текущий набор RabbitMQ
users. После migrations и до rollout он требует единственный текущий
`operations.service_identity` с именем `operations-service` и валидным
`database_id` UUID.

Для согласованных узких релизов тот же immutable workflow поддерживает
`identity-with-operations-manifest`, `operations-runtime`,
`operations-backlog-finalize`, `gateway-remove-notes`,
`workers-bootstrap-recovery` и `operations-federation-config`. Это ранние ветки того
же controller с общими env/lock/CI gates, не отдельный SSH release path.
Они не выполняют общий provisioning и не пересоздают Widgets/CRM.
Worker recovery заменяет семь Billing/Operations/Support workers и Billing API:
его provider-readiness contract требует один revision с Billing worker.
Другие API, scheduler, DDL и restore manifests не меняются. Federation config
пересоздаёт только Operations API на прежнем image с нормализованным ND origin.
Identity сопровождается Operations manifest/security-only image и короткой
остановкой четырёх Operations процессов до additive DDL; после неоднозначного
DDL старый manifest автоматически не возобновляется. Удаление Notes разделено
на runtime + writer fence и отдельную DDL фазу после реального backup/restore
proof. Точные inputs, rollback и ограничения описаны в
[runbook](docs/runbook.md#узкие-выпуски-identity-и-operations).

CRM имеет два отдельных scope в том же controller: `crm-prepare` запечатывает
четыре immutable images и нормализованный Compose, а `crm-databases` создаёт
только четыре изолированные PostgreSQL, проверяет scoped credentials и применяет
service-owned миграции. Ни один из них не активирует CRM API, broker, Trial или
продажи и не создаёт backup-копии. Повтор этапа БД сохраняет существующие
контейнеры, данные и пароли. Ограничения и prerequisites — в
[CRM runbook](docs/runbook.md#отдельный-этап-crm-databases).

## Production-окружение GitHub

В репозитории `winwidget.ru_services` настройте следующие repository-level
Actions secrets. Release-job передаёт их reusable workflow под его внутренними
именами. Caller/event/ref/SHA gates допускают только автоматический выпуск после
зелёного push в `prod`; ручного production job и отдельного источника секретов
в infra-репозитории нет.

| Секрет                               | Назначение                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `PRODUCTION_SSH_HOST`                | Имя хоста или IPv4-адрес backend VPS                                                                              |
| `PRODUCTION_SSH_PORT`                | SSH-порт                                                                                                          |
| `PRODUCTION_SSH_USER`                | Отдельный пользователь деплоя; текущему контроллеру требуется root                                                |
| `PRODUCTION_SSH_PRIVATE_KEY`         | Незашифрованный ключ деплоя, ограниченный этим VPS                                                                |
| `BACKEND_PRODUCTION_SSH_KNOWN_HOSTS` | Заранее проверенная закреплённая строка ключа хоста; никогда не создавайте её через `ssh-keyscan` внутри workflow |
| `BACKEND_PRODUCTION_ENV_SHA256`      | SHA-256 побайтово идентичного канонического backend-файла `.env.production`                                       |

Ключ деплоя нельзя повторно использовать для доступа к GitHub-репозиторию.
Checkout на VPS использует отдельный заранее установленный read-only deploy
key.

Backend release-job не передаёт frontend SSH credentials. Поэтому reusable
workflow явно пропускает установку frontend Nginx, а frontend image и его Nginx
выпускаются собственным workflow репозитория `winwidget.ru_frontends` после push в
`prod`.

При изменении production env сначала соблюдайте правило двусторонней
синхронизации: сравните локальный файл с файлом на VPS, обновите канонический
локальный файл, атомарно установите на VPS в точности те же байты с владельцем
`root:root` и режимом `0600`, снова сравните файлы и только затем обновите
`BACKEND_PRODUCTION_ENV_SHA256`. Workflow никогда не передаёт и не отображает
env-файл. После этого при каждом деплое на VPS атомарно формируются следующие
игнорируемые файлы; каждый содержит только ключи, принадлежащие его
отслеживаемому `.env.example`:

```text
/opt/winwidget/winwidget.ru_services/apps/<service>/.env.production
```

Их владелец — `root:root`, режим — `0600`. Сначала Compose получает
канонический источник, затем все десять точных файлов сервисов; при этом в
контейнеры по-прежнему попадают только переменные из их явной секции
`environment`. До изменения runtime контроллер вычисляет hash всего набора
сформированных файлов и в конце доказывает, что он не изменился. Отсутствующие
значения и placeholder-ы приводят к безопасному отказу (fail closed); пустое
значение допускается только для явно необязательной настройки
`widgets:S3_KEY_PREFIX`.

Для recovery-контракта канонический backend env обязан содержать
`DATABASE_RESTORE_RECEIPT_HMAC_KEY_BASE64` (минимум 32 случайных байта после
Base64-декодирования) и идентификатор ротации
`DATABASE_RESTORE_RECEIPT_HMAC_KEY_ID`. Контроллер проверяет их формат без
вывода значений, а resolved Compose — что обе переменные с одинаковыми
значениями получает ровно `operations-api` и `operations-restore-worker`.
Другим контейнерам, включая Operations worker/outbox/migrate, signing key не
передаётся. Обычный deploy принимает для `DATABASE_RESTORE_ENABLED` только
literal `true` или `false` и требует exact одинаковое значение в Operations API
и restore-worker; безопасный default в `.env.example` остаётся `false`.
Значение `true` допускается только после provenance/key, PostgreSQL 18 rehearsal
и operational approval gates. Routine deploy не создаёт restore job, но `true`
разрешает worker сразу claim уже существующей approved работы, поэтому до
rollout обязательны exact read-only pending job/permit/queue inventory и
отдельное recovery change window. Контроллер fail closed проверяет нулевой
DB/Outbox/RabbitMQ inventory до provisioning/migrations и повторно прямо перед
recreate restore-worker. В job inventory `RECOVERY_REQUIRED` считается
активным только пока `recoveryResolvedAt` не установлен: уже завершённое
recovery не блокирует последующие контролируемые окна. Worker проверяет kill
switch до claim обычного restore job, не блокируя signed
recovery/reconciliation. Первичное
provisioning использует один новый
случайный ключ и новый key ID. Это не ротация: активный ключ нельзя заменять,
пока есть выполняющийся restore или незакрытый `RECOVERY_REQUIRED`. До
реализации keyring с проверкой current/previous key ID старый ключ нельзя
удалять, иначе ранее созданные immutable receipts станут непроверяемыми.

Backup provenance использует отдельную асимметричную границу. Канонический env
не содержит provenance key ID или host path: согласованные immutable
services/infra releases закрепляют literal key ID
`operations-backup-ed25519-2026-08-31` и literal path
`/opt/winwidget/deploy/backend/.database-backup-provenance-private-key.pem`
непосредственно в Compose. Поэтому ротация не меняет canonical env или его
одобренный SHA-256. Сам PKCS#8 Ed25519 private key не хранится в env, GitHub или
Git. На VPS это непустой обычный файл `root:root`, mode `0600`, без symlink и
hardlink.
Контроллер проверяет его metadata и неизменность под deploy lock, а перед
миграциями запускает непривилегированный probe, который без вывода key material
доказывает соответствие private key активному public key из tracked keyring
`apps/operations/restore-manifests/database-backup-provenance-public-keys.json`.
Private secret и его file-path environment получает только
`operations-worker`: root-only source mount
`/run/secrets/database-backup-provenance-private-key-source` копируется
проверенным image entrypoint в отдельный tmpfs runtime-файл owner UID/GID
`1001:1001`, mode `0400`: root entrypoint создаёт temporary copy `root:root`
mode `0600`, выполняет `cmp`, затем делает final chown/chmod в каталоге
`root:nodejs` mode `0710` и только после этого атомарно публикует файл. PID 1
запускается без root-прав. Bootstrap контейнера имеет `cap_drop: ALL` и только
`CHOWN`, `SETGID`, `SETUID`; `FOWNER`/`DAC_OVERRIDE` не выдаются. API,
restore-worker и остальные контейнеры используют только public keyring из
immutable image. После rollout контроллер дополнительно читает только безопасные
поля `/proc/1/status` работающего worker и fail closed подтверждает имя процесса,
все real/effective/saved/filesystem UID/GID `1001`, отсутствие supplemental
groups, `NoNewPrivs=1` и нулевые inherited, permitted, effective и ambient
capabilities, не читая private key.
Ротация выполняется по процедуре раздела Backup/restore в
[runbook](docs/runbook.md) двумя immutable services/infra releases: первый
добавляет новый public key, сохраняя старый active ID, второй переключает
Compose и infra-validator literal ID
после атомарной замены host key writer-ом, участвующим в том же deploy lock.
Старый public key сохраняется до окончания restore-retention всех подписанных
им backup; canonical env и его approved SHA-256 при ротации не меняются.

Restore artifacts разделены на два bind-каталога UID/GID `1001:1001`, mode
`0700`. `DATABASE_RESTORE_STAGING_DIR` доступен Operations API для upload и
restore-worker для атомарного claim/cleanup. `DATABASE_RESTORE_SEALED_DIR`
монтируется только в restore-worker: именно из worker-only sealed storage после
копирования через file descriptor, `fsync` и повторной SHA-256 проверки
выполняются `pg_restore` и recovery. Deploy создаёт и отдельно проверяет запись
в оба каталога, запрещает совпадение их host device+inode; API и остальные
контейнеры не получают sealed mount.
Bootstrap-admin credentials также получает только единственный restore-worker.
Они являются доверенной recovery control-plane boundary, а не application
writer: deploy запрещает их другим runtime, проверяет отсутствие других LOGIN
SUPERUSER и полагается на один global CAS lease. Перед multi-replica или remote
recovery требуется отдельная proxy/session boundary; обычный `CONNECTION LIMIT`
не считается защитой SUPERUSER.

Отдельный
[`run-isolated-restore-rehearsal.sh`](scripts/run-isolated-restore-rehearsal.sh)
проверяет семь свежих подписанных production backup в временном PostgreSQL 18,
не включая production restore и не подключаясь к Compose. Локальный controller
принимает только exact services SHA, заранее подготовленный защищённый каталог
артефактов и aggregate SHA-256. На backend VPS он удерживает production deploy
lock, разрешает только локальный Docker socket, закрепляет Operations image по
OCI revision и PostgreSQL по digest, а затем создаёт два контейнера без
published ports, capabilities, writable root filesystem, production env,
Docker socket или persistent volumes. PostgreSQL имеет `--network none`, runner
делит только его network namespace; БД и рабочие файлы находятся в tmpfs.
Успех фиксируется после Ed25519/revision/TOC/ledger/ACL/fence и всех executor
проверок, удаления точных временных контейнеров/секретов/копий и подтверждения,
что исходные Docker container/volume/network inventories не изменились.
Sanitized evidence содержит только operational IDs, revisions и hashes.

Это executor-level evidence, а не разрешение на in-place restore. Контроллер не
монтирует `.env.production`, live `restore-staging`/`restore-sealed`, Telegram
token, private signing key или receipt HMAC и не меняет
`DATABASE_RESTORE_ENABLED=false`. Dual approval, permit/Outbox/CAS, signed
receipts, restart/redelivery, retention и alerts проверяются отдельным
production control-plane сценарием до любого решения о включении restore.

RabbitMQ identity restore-worker может читать и конфигурировать только exact
restore queue family. Из write-ресурсов ей разрешён исключительно direct
exchange `winwidget.retry`: временный сбой публикуется с mandatory/confirm в
`operations.database-restore.requested.v1.retry.v1`, а retry queue через TTL и
DLX возвращает сообщение в основную очередь. Это даёт задержку без конечного
лимита попыток; events/manual-retry/dead-letter остаются недоступны для записи.

## Nginx и Telegram relay

`nginx/backend-api.conf` — конфигурация публичного API, содержащая только
маршруты приложений: Nginx направляет API-трафик в Gateway `:4100`, а ассеты
виджетов — в Widgets `:4700`. В ней нет upstream Core `:4200`. При каждом
деплое контроллер сравнивает SHA-256 отслеживаемого файла с
`/etc/nginx/sites-available/api.winwidget.ru`, при необходимости устанавливает
его атомарно, выполняет `nginx -t`, перезагружает Nginx и восстанавливает
предыдущий файл, если проверка или перезагрузка завершается ошибкой.

`nginx/frontend.conf` — единственный tracked source Nginx для `winwidget.ru`,
`www.winwidget.ru` и `crm.winwidget.ru` на одном существующем frontend VPS.
Целевая маршрутизация четырёх самостоятельных frontend-контейнеров:

| Приложение | Loopback upstream | Публичные маршруты |
| --- | --- | --- |
| Landing | `127.0.0.1:3000` | `/` и fallback, legal/metadata/public assets |
| Widgets | `127.0.0.1:3002` | кабинет, подписка, auth/OAuth/logout, заявки и `/page-*` |
| Admin | `127.0.0.1:3003` | ровно `/admin` и `/admin/**` |
| CRM | `127.0.0.1:3001` | весь отдельный host `crm.winwidget.ru` |

Widgets сохраняет `/cabinet`, `/payment`, `/login`, `/register`,
`/restore-password`, `/social-auth`, `/logout`, `/wheels`, `/quizzes`,
`/callbacks`, `/timers`, `/stop-offers`, `/calculators` и их дочерние пути;
preview — `/page-wheel`, `/page-quiz`, `/page-callback`, `/page-timer`,
`/page-stop-offer`, `/page-ai-consultant`, `/page-calculator`. Границы пути
обязательны: `/administrator` или `/payment-unrelated` не становятся admin
или Widgets. Статические `/_next/static/` обслуживает Nginx из сохраняемого
store, описанного ниже. Остальные пути префиксов
`/_frontends/{landing,widgets,admin-panel}/_next/` обслуживает только
соответствующий Next runtime, включая image optimizer; Nginx сохраняет
URI/query, app-local rewrite выполняет Next. Неизвестные
`/_frontends/` возвращают 404. Встраиваемые JS-виджеты на API-host остаются
владением backend Widgets и сюда не переносятся.

Immutable static store находится в
`/opt/winwidget/deploy/frontend/assets/{legacy,landing,widgets,admin-panel,crm}/_next/static/`.
На основном host старый `/_next/static/` читает только `legacy`, а три
`/_frontends/{landing,widgets,admin-panel}/_next/static/` — собственные
namespaces. На CRM-host `/_next/static/` читает только `crm`. Пять точных
`^~` locations используют `alias` с завершающим `/`, запрещают symlinks и
listing, задают `expires 1y`. Отсутствующий файл даёт Nginx 404 без proxy
fallback. В locations нет `add_header`: TLS/security headers наследуются
с уровня server.

Перед переключением image deploy helper добавляет проверенные static файлы
в union своего namespace. Совпавший путь допустим только при одинаковом
содержимом; все коллизии проверяются до первой записи. Не перезаписывать
старые файлы другой ревизией и не удалять старые chunks автоматически ни
при deploy, ни при rollback: они нужны открытым вкладкам. Первое переключение
требует предварительно сохранить legacy chunks из текущего image. Отдельная
retention-политика требует согласования; заполнение диска не разрешает
молчаливую очистку старых assets.

Это tracked target, не утверждение о выполненном production cutover.
До установки обязательны готовность четырёх loopback upstream, проверка
DNS и выпуск/проверка отдельного сертификата `crm.winwidget.ru` по пути
`/etc/letsencrypt/live/crm.winwidget.ru/`; его наличие не предполагается.
Существующий iframe CSP preview остаётся у Next, main-host сохраняет
`SAMEORIGIN`, CRM — `DENY`. CRM frontend не разрешает rollout CRM backend
или включение коммерческого функционала без его отдельных gates.

Текущий backend release-job передаёт только backend credentials и не меняет
frontend Nginx; эту границу сохранять при переходе на frontend-монорепозиторий.
Само существование secrets в репозитории не передаёт их reusable workflow:
нужна явная передача полной группы. Когда настроена полная группа
`FRONTEND_*`, после успешного backend-деплоя контроллер через отдельные pinned
SSH credentials сравнивает его SHA-256 с
`/etc/nginx/sites-available/winwidget.ru`, атомарно устанавливает изменение под
отдельным lock, выполняет `nginx -t`, reload с восстановлением предыдущего файла
при ошибке и публичную HTTPS-проверку. При отсутствии всей группы frontend Nginx
не изменяется и не является обязательным gate backend-релиза. Локальная копия
`deploy/frontend/nginx.conf` больше не является source of truth.

Статический routing contract без сети и Docker:
`node scripts/test-frontend-nginx-contract.mjs`. Настоящий `nginx -t` с
production-сертификатами и smoke каждого приложения остаются release gate.

Каталог `nginx/telegram-bridge/` содержит конфигурацию зарубежного VPS для
входящих Telegram webhook, исходящего трафика Bot API и намеренно публичного
raw TLS listener на `8443`. Установка и безопасная проверка без токенов описаны
в локальном README этого каталога.

## Предварительные требования к VPS

Контроллер ожидает:

- Docker Engine с Docker Compose v2, Git, `flock`, `curl`, `sha256sum` и GNU
  `stat`;
- канонический checkout в `/opt/winwidget/winwidget.ru_services`, чей `origin`
  в точности равен `nda17/winwidget.ru_services`, с игнорируемыми доступными для
  записи путями `apps/<service>/.env.production`;
- канонический env-файл `/opt/winwidget/deploy/backend/.env.production` с
  владельцем `root:root` и режимом `0600`;
- Ed25519 private key backup provenance по фиксированному пути
  `/opt/winwidget/deploy/backend/.database-backup-provenance-private-key.pem`,
  обычный непустой файл `root:root`, mode `0600`, без дополнительных hardlink;
- все внешние PostgreSQL volumes и файлы секретов с паролями, указанные в
  Compose-манифесте сервисов;
- production-lock `/opt/winwidget/deploy/backend/.production-deploy.lock`
  (если обычный файл отсутствует, контроллер безопасно создаёт его);
- при включённой синхронизации на frontend VPS — Nginx, `systemctl`, `flock`,
  `curl`, `sha256sum`, GNU `stat`, существующий обычный файл
  `/etc/nginx/sites-available/winwidget.ru` режима `0644` и точный symlink из
  `sites-enabled`.

`/opt/winwidget`, канонический checkout сервисов, его Git-конфигурация и hooks,
каждый канонический каталог приложения и корневые каталоги релизов должны быть
реальными путями с владельцем root, без права записи для группы или остальных
пользователей. Канонический checkout должен быть чистым. При получении данных и
создании неизменяемого worktree контроллер отключает Git hooks и отклоняет
директивы executable/include в конфигурации репозитория.

Checkout репозитория используется только как источник Git-объектов. Каждый
деплой создаёт или повторно использует чистый detached worktree по пути
`/opt/winwidget/releases/winwidget.ru_services/<services-revision>` и запускает
Compose-манифест из этого неизменяемого каталога.

## Обычный деплой

Отправьте выпускаемый commit в `winwidget.ru_services/prod`. После зелёных
lifecycle gate и полной матрицы сервисов release-job автоматически вызывает
закреплённый immutable SHA reusable workflow infra и передаёт ровно
`github.sha`; ручной запуск или ввод SHA не используется. Далее контроллер:

1. захватывает фиксированный production-lock;
2. до начала работы проверяет канонический env;
3. получает `origin/prod` и требует, чтобы его вершина совпадала с запрошенным
   commit;
4. отклоняет retired Core runtime-артефакты и любые неожиданные сервисы Compose;
5. без раскрытия значений формирует из одобренного канонического источника
   десять production env-файлов, принадлежащих сервисам;
6. собирает десять принадлежащих приложениям семейств образов с тегом
   `git-<revision>` и проверяет OCI label ревизии и неизменяемый ID каждого
   образа;
7. без вывода значений проверяет точный Gateway manifest без catch-all/Core
   upstream, literal и exact-match production restore gate между Operations
   API/restore-worker, изоляцию receipt signing key, единственного получателя
   backup-provenance private secret и соответствие этой Ed25519 пары tracked
   public keyring, а также усиленную защиту restore-worker;
8. запускает девять сервисов PostgreSQL и RabbitMQ, затем до изменения
   RabbitMQ users/permissions и до миграций read-only проверяет имя Operations
   DB, schema/role boundaries, текущие critical tables, точный набор работающих
   Compose services, безопасную идентичность остановленных cleanup-кандидатов
   и точный текущий RabbitMQ user inventory;
9. создаёт точные принадлежащие сервисам identities/permissions RabbitMQ и
   выполняет все девять миграций, после чего до rollout проверяет единственный
   текущий `operations.service_identity`;
10. пересоздаёт сервисы, кроме Gateway, запускает изолированный Operations
    restore worker после перехода Operations Outbox publisher в healthy и
    последним запускает Gateway;
11. проверяет health контейнеров, точные ID образов, локальную readiness,
    публичную ревизию деплоя Gateway, согласованность текущего Telegram routing
    Operations с Reporting projection и неизменность hash env;
12. до любой очистки выполняет полный недеструктивный steady-state gate:
    повторно проверяет routing, legacy queues/users, точный RabbitMQ user
    inventory, временные Core container/volume/артефакты, listener `:4200` и
    точный набор работающих сервисов. Допускаются только остановленные
    Compose-кандидаты с уже строго проверенными labels/name/state;
13. только после зелёного pre-cleanup gate удаляет остановленные контейнеры с точно
    совпавшими Compose labels/name проекта `winwidget`, сохраняя и сравнивая
    полный набор ID работающих контейнеров до/после. Затем удаляет только теги
    локальных семейств `winwidget-*`, кроме принадлежащих отдельному CRM
    controller `winwidget-crm-*`, чей image ID не привязан ни к одному
    оставшемуся контейнеру. Неиспользуемые CRM candidate/rollback tags тоже
    сохраняются. Перед и сразу после каждого `image rm --no-prune`
    повторно сравнивает running IDs, а также все container/image bindings;
14. повторяет полный steady-state gate и требует отсутствия любых retired или
    остановленных project containers, legacy routes/queues/users, временных
    Core container/volume/артефактов и listener `:4200`;
15. при настроенной полной группе `FRONTEND_*` устанавливает и проверяет tracked
    frontend Nginx на отдельном VPS и подтверждает доступность
    `https://winwidget.ru/`; без группы явно пропускает только этот шаг.

Контроллер не использует `latest`, `--remove-orphans`, `prune`, принудительное
удаление, очистку volumes/networks/build cache или восстановление канонического
production env из примеров. Контейнеры других Compose projects, любой
`running`/`restarting`/`paused` container, образы с хотя бы одним container
binding, любые `winwidget-crm-*` references и неатрибутируемые `<none>` images
не являются cleanup-target;
`--no-prune` обязателен для каждого точного удаления image reference.

## Локальная статическая проверка

Эти проверки не подключаются к production:

```bash
bash -n scripts/deploy-services-production.sh
shellcheck -x scripts/deploy-services-production.sh
sed -n "/<<'REMOTE_CONTROLLER'$/,/^REMOTE_CONTROLLER$/p" scripts/deploy-services-production.sh | sed '1d;$d' | bash -n
sed -n "/<<'FRONTEND_CONTROLLER'$/,/^FRONTEND_CONTROLLER$/p" scripts/deploy-services-production.sh | sed '1d;$d' | bash -n
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/deploy-production.yml")'
git diff --check
```

## Документация

- [Единый production runbook](docs/runbook.md)
- [Документация сервисов и технический backlog](https://github.com/nda17/winwidget.ru_services/tree/prod/docs)
