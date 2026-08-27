# Request Templates

Request templates **customize the upstream request format**: they auto-inject extra fields into matching requests without changing the client.

## Use Cases

- Attach common parameters to a model (e.g. `reasoning_effort`, `response_format`)
- Force JSON output, control temperature
- Templates apply before protocol conversion, so OpenAI-only fields are stripped for Anthropic upstreams

## Creating a Template

In the admin panel, go to "Request Templates" and click "New Template":

| Field | Description |
|-------|-------------|
| Template name | Required, custom identifier |
| Description | Optional |
| Template type | Required: `Chat Completions` (normal `v1/chat/completions`) or `Responses API` (next-gen `v1/responses`, unlocks advanced reasoning chain `reasoning`). Legacy templates without type default to `Chat` |
| Applicable models | Model ID wildcard list (e.g. `gpt-*`), press Enter to add; default `*` (all models) |
| Request body | Required; JSON fields to inject (see whitelist below), deep-merged into the upstream request body |
| Enabled | On by default; off = template does not apply |

The page offers 8 quick-fill examples: 4 for `Chat` (Enable Deep Thinking, Model Reasoning Effort, Force JSON Output, Temperature Control) and 4 for `Responses` (High Reasoning, Instructions + Reasoning, Tool Calling, Long Context Truncation).

## Injectible Fields (Whitelist)

Templates use a **type-specific whitelist**; **anything else is silently dropped**:

**Chat Completions** (`type=chat`, normal `v1/chat` proxy):

`system`, `temperature`, `top_p`, `top_k`, `max_tokens`, `max_completion_tokens`, `frequency_penalty`, `presence_penalty`, `stop`, `stream`, `stream_options`, `n`, `logprobs`, `top_logprobs`, `response_format`, `seed`, `reasoning_effort`, `chat_template_kwargs`, `extra_body`, `thinking`, `reasoning_split`

**Responses API** (`type=responses`, `v1/responses` proxy, unlocks advanced reasoning chain):

`instructions`, `reasoning` (`{ effort: "high"|"medium"|"low", summary: "detailed"|"auto" }` unlocks thinking chain), `max_output_tokens`, `truncation`, `text`, `tools`, `tool_choice`, `parallel_tool_calls`, `store`, `include`, `metadata`, `service_tier`, `prompt_cache_key`, `safety_identifier`, `background`, `previous_response_id`, `temperature`, `top_p`, `top_logprobs`, `stream`, `seed`, `frequency_penalty`, `presence_penalty`, `stop`, `n`, `logprobs`, `response_format`, `reasoning_effort`, `chat_template_kwargs`, `extra_body`

## Matching & Merging Rules

- Filtering is **by template type first, then model ID**: `Chat` templates only apply on normal `v1/chat/completions` proxy path, `Responses` templates only on `v1/responses`. When downstream requests via `v1/responses`, upstream is also via `v1/responses` with matched type. Legacy templates without type are treated as `Chat` for backward compatibility
- Then matching is done against the client-requested **model ID** with wildcards (`*`, case-insensitive); only enabled templates apply
- Multiple matching templates merge **in stored order**; later ones override same-named keys; arrays are replaced wholesale (not merged)
- Templates apply to every upstream attempt and take effect immediately after save (30s cache + change detection)
- `Chat` and `Responses` templates are in separate pools and do not interfere: the same model can have both types configured

## Interaction with Anthropic Platforms

Templates apply **before** protocol conversion: fields are injected into the OpenAI-format body, then the request is converted to the native Anthropic protocol. OpenAI-only fields (`stream_options`, `n`, `response_format`, etc.) are stripped during conversion to avoid 422 from strict Anthropic backends; `system`, `temperature`, `top_p`, `top_k`, `max_tokens`, `stop` etc. pass through normally.

Vendor-specific top-level fields (e.g. `thinking`, `reasoning_split`) are also stripped by the conversion layer and **only take effect on OpenAI-protocol upstreams**. If a template injects these fields but the platform `protocol=anthropic`, they are silently dropped at request time with no log hint—bind such templates to OpenAI-compatible platforms instead.

## Next Steps

- [Platform Configuration](/en/guide/platform) — configure upstream AI service providers
- [API Key Management](/en/guide/api-key) — create and manage API keys
- [API Reference](/en/api/) — request template management endpoints
