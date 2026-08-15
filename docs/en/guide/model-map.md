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

## Wildcard Mapping

An `alias` ending with `*` matches by prefix: e.g. `gpt-4*` matches every model name starting with `gpt-4`, and the matched suffix is appended to `targetModel`.

## Platform Model Discovery

FWP automatically discovers the model list of each platform (scheduled every 6 hours by default); results are visible on the "Auto Model" page. Discovery calls the OpenAI-compatible `/models` endpoint:

- OpenAI-compatible platforms (`openai` / `azure` / `custom`) discover normally
- **Anthropic-type platforms do not support auto-discovery** (no `/models` endpoint in the native protocol) — add models manually or use presets

## Next Steps

- [Auto Routing](/en/guide/auto-model) — automatically pick the best platform and model
- [API Reference](/en/api/) — endpoint usage
- [Data Management](/en/guide/usage) — maintain mappings via import/export

