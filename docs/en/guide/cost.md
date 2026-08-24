# Cost Tracking

Track per-request spending on top of token statistics — answer "how much did this month cost?"

## How Pricing Works (Two Channels)

| Channel | Priority | Description |
|---------|----------|-------------|
| Upstream-reported cost | **Trusted first** | Some upstreams (e.g. OpenRouter) return the request cost directly in the response usage; it is recorded as-is |
| Price table estimation | Fallback | When no cost is reported, spend is computed from the model price table times actual tokens |

If neither channel yields data the request costs 0 — **no default price is ever guessed**; add missing models to the price table explicitly.

## Maintaining the Price Table

Admin → **System Settings → Model Pricing**:

- Unit is **USD per million tokens**, split into input and output prices
- **Import from LiteLLM** pulls the community-maintained full price list and merges it (same-name entries are overwritten by imported values) — ideal for initial setup
- Add/edit/delete any entry manually; saving validates every row and rejects the whole batch on any invalid entry

## Where to See Costs

| Location | Content |
|----------|---------|
| Dashboard | Total-cost card |
| Usage page | Window cost summary, per-Key / per-platform cost columns |
| Request logs | Cost column in both detail and archive lists |

Costs persist into daily statistics after archiving — historical totals survive log expiry.

::: tip Disclaimer
Costs are derived from upstream-reported usage or price-table estimation — **for reference only; actual billing is determined by your provider**. Every cost display carries this notice.
:::
