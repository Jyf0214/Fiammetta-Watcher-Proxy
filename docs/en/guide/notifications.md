# Alert Notifications

Push critical proxy events to your own receivers instead of watching the dashboard.

## Entry

Admin → **System Settings → Alert Notifications**.

## Channels

Notifications are sent as **Webhook (POST JSON)** with a unified body:

```json
{ "event": "key_banned", "title": "...", "body": "...", "timestamp": 1756000000 }
```

Common push services work out of the box — just paste the service's webhook URL as a channel:

| Service | URL example |
|---------|-------------|
| Telegram Bot | `https://api.telegram.org/bot<token>/sendMessage` |
| Bark | `https://api.day.app/<your-key>` |
| ServerChan | `https://sctapi.ftqq.com/<sendkey>.send` |

Multiple channels fire concurrently; one failing channel never affects others or the request itself.

## Subscribable Events

| Event | Default | Trigger |
|-------|---------|---------|
| API Key banned | On | Repeated upstream errors trigger an automatic key ban (notification carries only a fingerprint, never the plaintext) |
| Platform circuit breaker | On | Platform hits the consecutive-failure threshold, or a half-open probe fails and it re-opens |
| Platform degraded | Off | Platform shows failures below the breaker threshold, entering degraded state |
| All platforms unavailable | On | A request finds no usable platform/key at all — service effectively down |
| Key quota at 80% | On | A key reaches 80% of its token or call quota (reminded once per key) |

## Anti-spam

Same-type events share a cooldown window (default 10 minutes, adjustable 1–1440): repeated triggers inside the window are not re-sent. A platform flapping between open/closed produces notifications at most once per cooldown period.

## Security Notes

- Notification settings live in the database behind a protected-key list; they can only be changed from this settings page
- Sending is fully side-effect-free for the proxy path: missing config or network failures never break requests
