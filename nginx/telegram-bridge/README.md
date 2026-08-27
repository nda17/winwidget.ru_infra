# Telegram bridge

Зарубежный VPS по проверенному публичному адресу bridge обслуживает оба
направления Telegram-трафика WinWidget:

```text
Telegram -> tg.winwidget.ru -> https://api.winwidget.ru
Backend services -> https://tg.winwidget.ru/telegram-api -> api.telegram.org
```

Файл `tg.winwidget.ru.conf` устанавливается как
`/etc/nginx/sites-available/tg.winwidget.ru`. Он завершает TLS и открывает только
точные маршруты Auth, Info и Support, а также методы Bot API из allowlist,
используемые WinWidget. Пути запросов `/telegram-api/*` содержат токены ботов,
поэтому логирование доступа и ошибочных запросов должно оставаться отключённым.

Backend без Core закрепляет bridge для Notification Delivery, Identity API,
Support API/worker и Operations API/worker. Через этот путь проходят все
Telegram-уведомления, backup, ежедневные сводки, аутентификация и чат с
оператором.

Файл `telegram-api-stream.conf` по-прежнему устанавливается как
`/etc/nginx/modules-enabled/99-winwidget-telegram-api-stream.conf`. Публичный
`8443/tcp` намеренно доступен любому клиенту как raw TLS passthrough; он не
ограничен backend WinWidget. Resolver использует только IPv4, потому что у
bridge нет работающего исходящего IPv6-маршрута.

## Релиз

1. Атомарно установите оба файла с владельцем `root:root` и режимом `0644`.
2. Выполните `nginx -t` и перезагрузите Nginx.
3. Оставьте публичные порты `443/tcp` и `8443/tcp` открытыми.
4. Проверьте endpoint, не содержащий токенов:

```bash
curl --noproxy '*' --resolve tg.winwidget.ru:443:BRIDGE_IP \
  --connect-timeout 5 --max-time 15 \
  --dump-header - --output /dev/null \
  https://tg.winwidget.ru/telegram-api-health
```

Ответ не должен иметь статус 5xx и должен содержать
`X-WinWidget-Telegram-Proxy: active`. Отсутствие маркера, timeout или ошибка TLS
блокируют релиз backend.

Backend env использует
`TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api` и проверенный IP
bridge. После изменения проверьте одно Telegram-сообщение, один актуальный
документ backup, Daily Summary и сценарий чата с оператором Support. Не
запускайте массовый retry устаревших сообщений DLQ.

## Безопасность

Никогда не включайте логирование request line для `/telegram-api/*`: токены
Telegram-ботов являются частью URL. Proxy отдельно проверяет TLS на обоих
участках. Stream-логи содержат только метаданные соединений, без HTTP-путей и
payload.
