# Инфраструктура WinWidget

Репозиторий `winwidget.ru_infra` содержит контроллер production-деплоя и
эксплуатационные инструкции. Исходный код приложений, Dockerfile, схемы Prisma и
production-манифест Compose остаются в `winwidget.ru_services`, а фронтенд — в
`winwidget.ru_client`. Канонические Nginx-конфигурации backend и frontend
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
выпускаются собственным workflow репозитория `winwidget.ru_client` после push в
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
передаётся. Обычный deploy требует `DATABASE_RESTORE_ENABLED=false` и не
открывает production restore. Первичное provisioning использует один новый
случайный ключ и новый key ID. Это не ротация: активный ключ нельзя заменять,
пока есть выполняющийся restore или незакрытый `RECOVERY_REQUIRED`. До
реализации keyring с проверкой current/previous key ID старый ключ нельзя
удалять, иначе ранее созданные immutable receipts станут непроверяемыми.

Restore artifacts разделены на два bind-каталога UID/GID `1001:1001`, mode
`0700`. `DATABASE_RESTORE_STAGING_DIR` доступен Operations API для upload и
restore-worker для атомарного claim/cleanup. `DATABASE_RESTORE_SEALED_DIR`
монтируется только в restore-worker: именно из worker-only sealed storage после
копирования через file descriptor, `fsync` и повторной SHA-256 проверки
выполняются `pg_restore` и recovery. Deploy создаёт и отдельно проверяет запись
в оба каталога; API и остальные контейнеры не получают sealed mount.
Bootstrap-admin credentials также получает только единственный restore-worker.
Они являются доверенной recovery control-plane boundary, а не application
writer: deploy запрещает их другим runtime, проверяет отсутствие других LOGIN
SUPERUSER и полагается на один global CAS lease. Перед multi-replica или remote
recovery требуется отдельная proxy/session boundary; обычный `CONNECTION LIMIT`
не считается защитой SUPERUSER.

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

`nginx/frontend.conf` — единственный tracked source Nginx для `winwidget.ru` и
`www.winwidget.ru` на отдельном frontend VPS. Когда настроена полная группа
`FRONTEND_*`, после успешного backend-деплоя контроллер через отдельные pinned
SSH credentials сравнивает его SHA-256 с
`/etc/nginx/sites-available/winwidget.ru`, атомарно устанавливает изменение под
отдельным lock, выполняет `nginx -t`, reload с восстановлением предыдущего файла
при ошибке и публичную HTTPS-проверку. При отсутствии всей группы frontend Nginx
не изменяется и не является обязательным gate backend-релиза. Локальная копия
`deploy/frontend/nginx.conf` больше не является source of truth.

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
   upstream, выключенный production restore, изоляцию signing key между
   Operations API/restore-worker и остальными контейнерами, а также усиленную
   защиту restore-worker;
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
    локальных семейств `winwidget-*`, чей image ID не привязан ни к одному
    оставшемуся контейнеру. Перед и сразу после каждого `image rm --no-prune`
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
binding и неатрибутируемые `<none>` images не являются cleanup-target;
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
