# OpenCode Go host usage integration

## Intent

Show the active Go subscription's 5-hour, weekly, and monthly usage in usage-monitor, using the same OpenCode host API that already returns the signed-in workspace's limits. The user confirmed the subscription is active and the host API currently reports 0%, 0%, and 6%.

## Goals and constraints

- Read quota data through a supported, typed OpenCode client method and the current host session; do not require a separate Go API key.
- Preserve the existing provider row, quota formatting, refresh cadence, validation, caching, and failure states where practical.
- Never expose credentials or make a model request to obtain quota data.
- The usage-limits route is experimental. If no compatible published SDK method exists, stop and report the blocker; do not silently switch to raw local HTTP or dashboard scraping.

## Non-goals

- Add OpenCode free-model quota estimates, Console balance tracking, or subscription management.
- Change OpenCode authentication or create/revoke API keys.

## Approaches

1. **Use a typed host SDK method (chosen):** verify an available SDK release exposes the host usage-limits route, then wire that method into the Go provider. This reuses OpenCode's authenticated client and avoids key handling.
2. **Call the host's local HTTP endpoint directly:** rejected for this change because URL discovery and service authentication would couple the plugin to host internals.
3. **Keep the direct Go endpoint and saved key:** rejected because it is not the data path proven to return the active workspace's current limits and has previously returned `api_key_expired`.

## Acceptance

- With the current Go subscription, the panel shows rolling 5-hour, weekly, and monthly percentages and reset times from the host API (currently 0%, 0%, and 6%).
- Tests cover successful normalization, incomplete data, and host/API errors without leaking credentials.
- If the SDK does not expose a compatible method, no implementation workaround is made without renewed approval.
