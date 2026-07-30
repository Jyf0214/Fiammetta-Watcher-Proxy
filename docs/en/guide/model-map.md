# Model Mapping

## What is Model Mapping

Model mapping allows you to map one model name to another. For example:

- Client requests `gpt-4` → Actually calls `gpt-4o`
- Client requests `claude-3` → Actually calls `claude-3-5-sonnet`

## Configuration

Go to "Model Mapping" in the admin panel:

| Field | Description |
|-------|-------------|
| Alias | Model name requested by client |
| Target Model | Actual model to call |
| Platform | Limit to specific platform (optional) |

## Use Cases

1. **Model Upgrade**: Map old model names to new ones
2. **Cost Optimization**: Map expensive models to cost-effective ones
3. **Multi-platform**: Same alias maps to different targets per platform

## Platform Model Discovery

FWP automatically discovers models supported by each platform.

## Next Steps

