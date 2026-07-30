# Proxy Pool

## What is a Proxy Pool

A proxy pool is a collection of HTTP proxies used to access AI platforms. When direct access is restricted, requests can be forwarded through proxies.

## Configuration

Go to "Proxy Pool" to create pools, then "Proxy Management" to add proxies.

### Pool Configuration

| Field | Description |
|-------|-------------|
| Name | Pool identifier |
| Enable | Whether to enable the pool |

### Proxy Configuration

| Field | Description |
|-------|-------------|
| Address | Proxy address: `http://user:pass@host:port` |
| Pool | Which pool to bind to |
| Enable | Whether to enable the proxy |

## Health Check

FWP automatically monitors proxy health:

- **healthy** — Fully available
- **degraded** — Performance reduced, used less frequently
- **down** — Unavailable, enters cooldown period

## Routing Strategy

- Prefers healthy proxies
- Degraded proxies have 50% skip probability
- Down proxies are completely skipped, auto-probed after cooldown

## Next Steps

