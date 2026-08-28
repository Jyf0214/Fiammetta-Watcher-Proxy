# Auto Routing

## What is Auto Routing

Auto routing is an advanced FWP feature that automatically selects the best model and platform based on request characteristics.

## How it Works

```
Client Request → Analyze Request → Select Best Platform/Model → Forward Request
```

## Routing Strategies

### Priority-based

Higher priority number = higher priority:

```
Platform A (priority=3) > Platform B (priority=2) > Platform C (priority=1)
```

### Weight-based

Distribute requests by weight ratio:

```
Platform A (weight=3) : Platform B (weight=2) : Platform C (weight=1)
= 50% : 33% : 17%
```

### Health-based

- Healthy and degraded platforms both participate normally (degraded only means failure counts are accumulated, closer to the breaker threshold — it does not lower selection weight)
- Skip down platforms completely (circuit breaker)

## Auto Model ID

On the "Auto Model" page you can generate an auto-model ID (format `fwp-auto-model-xxxxxxxxxxxxxxxx`), copy it, or regenerate. Set the client's `model` to this ID and FWP automatically picks the best platform and a non-frozen model:

- Discovery results are deduplicated by model ID with source tags (`manual` added manually / `auto` discovered)
- Each model has a switch to join or leave the auto-routing pool
- Failed models are frozen for 3 minutes to prevent repeated failures

## Platform Model Discovery

FWP periodically (every 6 hours by default) discovers models supported by each platform:

1. Understand platform capabilities
2. Monitor model availability

Discovery calls the OpenAI-compatible `/models` endpoint: OpenAI-compatible platforms (`openai` / `azure` / `custom`) discover normally; **Anthropic-type platforms do not support auto-discovery** (no `/models` endpoint in the native protocol).

See the [Admin Panel Usage Guide](/en/guide/usage) for data-management maintenance, and the [Deployment Guide](/en/deployment/) / [Cron Tasks](/en/api/cron) for scheduling.

## Next Steps

- [Admin Panel Usage Guide](/en/guide/usage) — Auto Model page operations
- [API Reference](/en/api/) — endpoint usage
- [Cron Tasks](/en/api/cron) — scheduled task endpoints

