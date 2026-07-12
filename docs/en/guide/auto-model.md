# Auto Routing

## What is Auto Routing

Auto routing is an advanced FWP feature that automatically selects the best model and platform based on request characteristics.

## How it Works

```
Client Request → Analyze Request → Select Best Platform/Model → Forward Request
```

## Routing Strategies

### Priority-based

Lower priority number = higher priority:

```
Platform A (priority=1) > Platform B (priority=2) > Platform C (priority=3)
```

### Weight-based

Distribute requests by weight ratio:

```
Platform A (weight=3) : Platform B (weight=2) : Platform C (weight=1)
= 50% : 33% : 17%
```

### Health-based

- Prefer healthy platforms
- Reduce usage of degraded platforms
- Skip down platforms completely

## Platform Model Discovery

FWP automatically discovers models supported by each platform:

1. Understand platform capabilities
2. Configure model mappings
3. Monitor model availability

## Next Steps

