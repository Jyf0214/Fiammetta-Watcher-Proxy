# Model Mapping

## What is Model Mapping

Model mapping allows you to map one model name to another. For example:

- Client requests `gpt-4` → Actually calls `gpt-4o`
- Client requests `claude-3` → Actually calls `claude-3-5-sonnet`

## Configuration

There is **no dedicated management page** for model mappings in the current version. Maintain them through **Export/Import** in the "Data Manager" page:

1. In "Data Manager", click **Export** and choose **System Config** — you get a JSON file containing a `modelMaps` array
2. Add or edit mapping records in the `modelMaps` array:

```json
{
  "alias": "gpt-4",
  "targetModel": "gpt-4o",
  "platformId": null
}
```

| Field | Description |
|-------|-------------|
| `alias` | Model name requested by client (required) |
| `targetModel` | Actual model to call; defaults to `alias` when omitted |
| `platformId` | Limit to a specific platform (`null` = all platforms), optional |

3. Back in "Data Manager", click **Import** and upload the modified JSON file

::: warning
Mappings whose `alias` already exists are skipped on import (existing records are not updated). To modify an existing mapping, rename its `alias` or delete the original record first.
:::

## Use Cases

1. **Model Upgrade**: Map old model names to new ones
2. **Cost Optimization**: Map expensive models to cost-effective ones
3. **Multi-platform**: Same alias maps to different targets per platform

## Platform Model Discovery

FWP automatically discovers models supported by each platform.

## Next Steps

