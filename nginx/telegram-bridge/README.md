# Telegram bridge

The foreign VPS at the reviewed public bridge address carries both WinWidget
Telegram directions:

```text
Telegram -> tg.winwidget.ru -> https://api.winwidget.ru
Backend services -> https://tg.winwidget.ru/telegram-api -> api.telegram.org
```

`tg.winwidget.ru.conf` is installed as
`/etc/nginx/sites-available/tg.winwidget.ru`. It terminates TLS and exposes
only the exact Auth, Info, Support and webhook-health routes plus the allowlisted
Bot API methods used by WinWidget. Request paths under `/telegram-api/*`
contain bot tokens, so access and error request logging must remain disabled.

The apps-only backend pins the bridge for Notification Delivery, Identity API,
Support API/worker and Operations API/worker. All Telegram notifications,
backups, daily summaries, authentication and operator chat use this path.

`telegram-api-stream.conf` remains installed as
`/etc/nginx/modules-enabled/99-winwidget-telegram-api-stream.conf`. Public
`8443/tcp` is intentionally available to any client as a raw TLS passthrough;
it is not restricted to the WinWidget backend. The resolver is IPv4-only
because the bridge has no working outbound IPv6 route.

## Release

1. Install both files atomically with owner `root:root`, mode `0644`.
2. Run `nginx -t` and reload Nginx.
3. Keep public `443/tcp` and `8443/tcp` open.
4. Verify the token-free endpoint:

```bash
curl --noproxy '*' --resolve tg.winwidget.ru:443:BRIDGE_IP \
  --connect-timeout 5 --max-time 15 \
  --dump-header - --output /dev/null \
  https://tg.winwidget.ru/telegram-api-health
```

The response must be non-5xx and include
`X-WinWidget-Telegram-Proxy: active`. Missing marker, timeout or TLS failure
blocks the backend release.

The backend env uses
`TELEGRAM_API_BASE_URL=https://tg.winwidget.ru/telegram-api` and the reviewed
bridge IP. After a change, verify one Telegram message, one current backup
document, Daily Summary and the Support operator-chat flow. Do not mass-retry
stale DLQ messages.

## Security

Never enable request-line logging for `/telegram-api/*`; Telegram bot tokens
are part of the URL. The proxy validates TLS separately on both legs. Stream
logs contain only connection metadata, not HTTP paths or payloads.
