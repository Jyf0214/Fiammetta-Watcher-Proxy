# Outbound Proxy

When an upstream platform restricts your region or egress IP, proxy requests can be forwarded through HTTP/SOCKS outbound proxies. Supports bulk-pulling proxy lists from subscription links, group management, and scheduled health checks.

## Entry

Admin sidebar → **Outbound Proxy**:

- **List page**: proxies grouped with overall health overview
- Click any group to open its configuration detail

## Core Concepts

| Concept | Description |
|---------|-------------|
| Proxy group | One pull source maps to one group; proxies in a group come from the same subscription |
| Group binding | A platform can bind to a proxy group so its requests only use proxies in that group |
| Default group | Platforms without an explicit binding fall back to the default group |

## Configuration

Each group holds three kinds of settings:

| Category | Content |
|----------|---------|
| Proxy pool | Manually added proxy addresses; supports `http://`, `socks4://`, `socks5://` (credentials are masked in the UI) |
| Pull source | Subscription URL returning a plain-text proxy list (one per line); pulling runs immediately on save and can run on a schedule |
| Health check | When enabled, periodic probes mark unreachable nodes |

## Platform Binding

Select an outbound proxy group in **Platform Management → Edit Platform**. Granularity extends down to a **single API Key**: individual keys on the same platform can use different groups (useful when keys have different IP requirements).

## Scheduled Tasks

| Task | Behavior |
|------|----------|
| Proxy pull | Syncs each group's subscription on its own schedule; removed proxies are cleaned up |
| Proxy health check | Every 5 minutes by default (self-hosted Docker deployments only, unless disabled) |

## Device-level Disable

Self-hosted environments can disable everything via `UPSTREAM_PROXY_DISABLED`:

- `all` — all outbound proxy logic off (requests go direct)
- `health` — only health checks are disabled; forwarding keeps working

## Tips

- Subscription sources should return a **plain-text** list, one proxy per line, preferably with a scheme prefix; missing prefixes are treated as HTTP
- With many proxies, enable health checks with a longer interval to limit probe traffic
- Binding changes take effect immediately — no restart needed
