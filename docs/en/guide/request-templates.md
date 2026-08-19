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
| Applicable models | Model ID wildcard list (e.g. `gpt-*`), press Enter to add; default `*` (all models) |
| Request body | Required; JSON fields to inject (see whitelist below), deep-merged into the upstream request body |
| Enabled | On by default; off = template does not apply |

The page offers 4 quick-fill examples: Enable Deep Thinking, Model Reasoning Effort, Force JSON Output, Temperature Control.

## Injectible Fields (Whitelist)

Only the fields below may be set; **anything else is silently dropped**:

`system`, `temperature`, `top_p`, `top_k`, `max_tokens`, `max_completion_tokens`, `frequency_penalty`, `presence_penalty`, `stop`, `stream`, `stream_options`, `n`, `logprobs`, `top_logprobs`, `response_format`, `seed`, `reasoning_effort`, `chat_template_kwargs`, `extra_body`

## Matching & Merging Rules

- Matching is done against the client-requested **model ID** with wildcards (`*`, case-insensitive); only enabled templates apply
- Multiple matching templates merge **in stored order**; later ones override same-named keys; arrays are replaced wholesale (not merged)
- Templates apply to every upstream attempt and take effect immediately after save (30s cache + change detection)

## Interaction with Anthropic Platforms

Templates apply **before** protocol conversion: fields are injected into the OpenAI-format body, then the request is converted to the native Anthropic protocol. OpenAI-only fields (`stream_options`, `n`, `response_format`, etc.) are stripped during conversion to avoid 422 from strict Anthropic backends; `system`, `temperature`, `top_p`, `top_k`, `max_tokens`, `stop` etc. pass through normally.

## Next Steps

- [Platform Configuration](/en/guide/platform) — configure upstream AI service providers
- [API Key Management](/en/guide/api-key) — create and manage API keys
- [API Reference](/en/api/) — request template management endpoints
