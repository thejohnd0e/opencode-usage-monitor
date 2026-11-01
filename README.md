# opencode-usage-monitor

> Personal fork of [Mark1708/opencode-usage-monitor](https://github.com/Mark1708/opencode-usage-monitor) `v3.1.0` (MIT).
> Changes on top of upstream include minute-level countdowns, OpenRouter, and an independent server-owned Codex usage collector. See [Fork changes](#fork-changes).

> OpenCode TUI sidebar plugin that shows OpenAI, Z.AI / GLM, DeepSeek, and OpenCode Go quota/balance usage without exposing provider credentials in the UI.

[![Package](https://img.shields.io/badge/npm-opencode--usage--monitor-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)](https://www.npmjs.com/package/opencode-usage-monitor)
![Runtime](https://img.shields.io/badge/runtime-Bun-111827?style=for-the-badge&logo=bun&logoColor=5b5ef4)
![Host](https://img.shields.io/badge/host-OpenCode-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)
![License](https://img.shields.io/badge/license-MIT-111827?style=for-the-badge&labelColor=111827&color=5b5ef4)

| Field | Value |
|---|---|
| Status | Actively maintained personal OpenCode tool/plugin |
| Type | OpenCode TUI plugin / host extension |
| Host app | OpenCode V2 APIs; compile compatibility fixture pinned at `2.0.32` |
| Package | `opencode-usage-monitor` `3.1.0` |
| Runtime | Bun `>= 1.3.0` for local development |
| Maintainer checks | `bun install --frozen-lockfile && bun run typecheck && bun run typecheck:host && bun test && bun run build:all && bun run verify:package` |

## Screenshots

The plugin renders inside the OpenCode terminal UI sidebar.

![Collapsed sidebar view](assets/sidebar-collapsed.png)

![Provider expanded view](assets/provider-expanded.png)

![Fully expanded view](assets/fully-expanded.png)

## Summary

- Displays OpenAI ChatGPT usage windows, available Codex reset credits, and optional nearest reset-credit expiry.
- Displays Z.AI and GLM 5h/week/month quota windows with reset timing and optional plan details. Supports enterprise/org coding plans via organization and project scoping.
- Displays DeepSeek account balance (CNY) with an optional granted/topped-up breakdown.
- Displays OpenCode Go 5h/week/month usage windows with reset timing.
- Displays OpenRouter key budget usage (day/week/month) with a reset countdown plus `spent` and `credits` USD rows (fork addition).
- Standardizes provider output as explicit usage windows plus typed provider-owned details; DeepSeek balance is displayed as a balance detail rather than a reset window.
- Uses OpenCode-owned active credentials for providers that need client-side credential projection; Codex statistics resolve on the server through OpenCode's integration API.
- Redacts secrets from error messages before rendering them in the TUI.
- Rejects raw provider attribute dumps in runtime snapshots; providers must map safe attributes into ordered details.
- Uses stale-data indicators and guarded refreshes to avoid overlapping API calls.
- Supports two-level collapse/expand behavior: the full panel and per-provider detail views.

## Fork changes

Everything below is added on top of upstream `v3.1.0`; the panel layout, providers and configuration format are otherwise unchanged.

- **Reset countdowns reach minutes.** `formatReset` renders `reset 38m`, `reset 4h 12m`, `reset 5d 3h 12m`, `reset now`, using the provider's existing `resetAt` — no extra request. Zero subunits are dropped (`reset 4h`, not `reset 4h 0m`).
- **Narrow rows degrade by unit, not by character.** When the countdown does not fit the configured `width`, the smallest unit is dropped (`reset 5d 18h`) instead of cutting a number mid-token (`reset 5d 18h 1…`). Only `reset …` suffixes change; other suffixes keep upstream behavior.
- **OpenRouter provider.** Reads `GET https://openrouter.ai/api/v1/key` and maps the key's `effective_budget` (`limit_usd`, `spend_usd`, `reset_interval`, `resets_at`) to a `day`/`week`/`month` window with a percentage and countdown, plus `spent` and `credits` (best effort from `GET /api/v1/credits`) USD rows. Request counts are not part of the public payload, so the percentage is budget spend. 401/403 map to `forbidden`.
- **Tests.** `src/__tests__/openrouter.test.ts` and the countdown cases in `src/__tests__/layout.test.ts`; the provider-catalog order test now includes OpenRouter.

OpenAI/Codex usage runs through this package's `usage-monitor.codex` host RPC. The server resolves the OpenAI OAuth credential through OpenCode, fetches the official usage endpoints, and returns a validated secret-free snapshot to the TUI. No sibling `codex-limits` plugin or client-side credential enumeration is required.

Provider setup for the new adapter:

```json
"providers": { "openrouter": {} }
```

The credential comes from the stored OpenCode `openrouter` login; for an environment fallback set `OPENROUTER_API_KEY`. OpenRouter answers `403 Access denied by security policy` to sanctioned regions, so the OpenCode process needs the egress your setup already uses (for example a Proxifier rule); the plugin itself has no proxy option.

## Quick start

```sh
opencode plugin add opencode-usage-monitor@3.1.0
```

## Installation

### OpenCode v2

Install the release with the v2 plugin manager:

```sh
opencode plugin add opencode-usage-monitor@3.1.0
```

The equivalent manual configuration is:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-usage-monitor@3.1.0"]
}
```

The command installs the package and adds its npm spec to `plugins` in the
global `~/.config/opencode/opencode.json`. For project-scoped installation, add
the same entry to `opencode.json(c)` in the project root. The package exports
separate v2 server and TUI definitions.

This major does not support OpenCode v1. V1 users must pin
`opencode-usage-monitor@2.0.1`; there is no dual-runtime compatibility shim.

### Package install for local development

```sh
bun add opencode-usage-monitor@3.1.0
```

### Local checkout

```sh
git clone https://github.com/Mark1708/opencode-usage-monitor.git
cd opencode-usage-monitor
bun install --frozen-lockfile
bun run build:all
bun run verify:package
```

The build emits the server definition and TUI bundle into `dist/`; the package
verifier writes the release candidate to `.artifacts/package.tgz`. Repository
root shims are intentionally absent.

## Compatibility

| Component | Supported version | Source |
|---|---|---|
| Host app | OpenCode V2; integration/RPC APIs compile against `2.0.32` | `.test-types/host-api` fixture; packed smoke is mocked, not a live host |
| Plugin API | `@opencode/plugin 2.2.5` | `package.json` dependency |
| Theme API | `@opencode/theme 2.2.5` | `package.json` peer dependency |
| TUI runtime | `@opentui/core >=0.5.17`, `@opentui/solid >=0.5.17`, `solid-js 1.9.12` | `package.json` peer dependencies |
| Local runtime | Bun `>=1.3.0` | `package.json` engine |
| TypeScript | `^5.5.0` | `package.json` dev dependency |


## Configuration

Version 2.0 uses the versioned configuration contract only. Legacy flat fields such as `show_openai`, `show_zai`, `show_deepseek`, and `refresh_ms` are rejected with an actionable configuration error in the TUI instead of being interpreted as fallback settings.

The plugin first reads a dedicated config file:

```text
~/.config/opencode/usage-monitor.json
```

Smallest useful configuration:

```json
{
  "version": 2,
  "providers": {
    "openai": {},
    "zai": {},
    "deepseek": {},
    "opencode-go": {}
  }
}
```

Full documented shape:

```json
{
  "version": 2,
  "enabled": true,
  "keybindings": {
    "refresh_all": "<leader>q",
    "refresh_provider": null
  },
  "ui": {
    "width": 34,
    "symbols": "unicode",
    "panel_initial_state": "expanded",
    "provider_initial_state": "collapsed"
  },
  "refresh": {
    "mode": "automatic",
    "interval_ms": 300000,
    "timeout_ms": 15000,
    "stale_after_ms": 600000
  },
  "diagnostics": {
    "debug": false
  },
  "providers": {
    "openai": {
      "options": {
        "show_resets": true,
        "show_reset_expiry": false
      }
    },
    "zai": {
      "credential": { "source": "opencode", "entry": "zai-coding-plan" },
      "options": { "plan": "personal" }
    },
    "deepseek": {
      "credential": { "source": "opencode", "entry": "deepseek" }
    },
    "opencode-go": {
      "credential": { "source": "opencode", "entry": "opencode-go" }
    }
  }
}
```

The `providers` object controls provider activation. Presence enables a provider; omission disables it and prevents credential, cache, and network work for that provider. The OpenAI provider is host-backed: it does not take a `credential` reference and does not use the TUI's persistent provider cache. Provider-specific refresh policies are intentionally unsupported.

Alternatively, add a `usage_monitor` section to `oh-my-openagent.json`. Dedicated `usage-monitor.json` values take precedence.

## Credentials

### OpenAI

OpenAI displays ChatGPT/Codex subscription quota windows from an OpenCode OAuth
credential, not from OpenAI Platform API keys. A server-side collector uses
`integration.connection.active("openai")` by default, then resolves that
connection through OpenCode. OAuth refresh is performed by OpenCode itself.

For a separate statistics-only OpenAI connection, pass the server plugin option
`usageCredentialID` with that existing OpenAI credential's ID. The collector
verifies that the ID belongs to the OpenAI integration, then resolves it
without activating it or changing the model connection. If the selected ID is
missing or cannot be resolved, usage reports an authorization error; it never
falls back to another OpenAI credential. Do not put this ID under
`providers.openai.credential` or commit a machine-specific ID to shared config.

The server never reads `auth.json`, never activates or switches a connection,
and only passes the transient access token/account ID to its fetcher. Refresh
tokens, labels, arbitrary metadata, and raw credential records are not
returned to the TUI or persisted. `OPENAI_API_KEY` and `OPENAI_ADMIN_KEY` are
not used for subscription quota. The TUI does not call `credential.list` for
OpenAI and never makes a direct ChatGPT usage request.

Available Codex reset credits are shown by default from the primary usage
response. Set `providers.openai.options.show_resets` to `false` to hide them.
Set `show_reset_expiry` to `true` to make a conditional supplemental request
and show the nearest available credit expiry. The supplemental request runs
only when resets are visible and at least one credit is available; a failure
omits the expiry without hiding the usage windows or reset count.

### Moving from a `codex-limits` wrapper

The package now owns the Codex RPC and fetch path. A migration can therefore
remove the TUI's runtime dependency on `codex-limits`; it does **not** require
uninstalling or deleting that plugin. Before changing a live setup, make a
backup of the exact plugin wrapper and configuration files, move any
statistics-only credential ID into the `usageCredentialID` server plugin
option, and keep `providers.openai.options.show_reset_expiry` enabled if the
expiry row is desired. Build and verify the packed artifact first, then reload
the configuration and confirm the displayed usage while checking that the
model account remains unchanged. This repository's package checks use a
disposable mocked host/upstream fixture; they are not a live-host or live
credential migration test. No local installation is changed by these steps.

### Z.AI and GLM

The plugin supports Z.AI and Zhipu / GLM credentials from OpenCode auth storage or environment variables:

```sh
export ZAI_API_KEY="your-zai-key"
export ZAI_CODING_PLAN_API_KEY="your-coding-plan-key"
export ZHIPU_API_KEY="your-zhipu-key"
export ZHIPUAI_API_KEY="your-zhipuai-key"
```

#### Enterprise / organization coding plan

Enterprise (organization-scoped) GLM coding plans require both an organization id and a project id. When both are provided the plugin queries `{baseUrl}/api/monitor/usage/quota/limit?type=2` with `Bigmodel-Organization` and `Bigmodel-Project` headers; otherwise it uses the personal plan endpoint.

Configure them in `usage-monitor.json`:

```json
{
  "version": 2,
  "providers": {
    "zai": {
      "options": {
        "plan": "enterprise",
        "organization_id": "your-org-id",
        "project_id": "your-project-id"
      }
    }
  }
}
```

Or via environment variables when provider options are not set:

```sh
export ZHIPU_ORGANIZATION_ID="your-org-id"
export ZHIPU_PROJECT_ID="your-project-id"
```

### DeepSeek

The plugin displays the DeepSeek account balance (CNY) from the balance endpoint. Configure an API key via OpenCode auth storage or:

```sh
export DEEPSEEK_API_KEY="your-deepseek-key"
```

The balance row shows the total CNY amount; expanding the provider reveals the granted (promotional) and topped-up (paid) breakdown.

### OpenCode Go

OpenCode Go displays rolling 5h, weekly, and monthly usage from `GET https://opencode.ai/zen/go/v1/usage`. The stored OpenCode credential named `opencode-go` is preferred. For an explicit environment fallback, set:

```sh
export OPENCODE_GO_API_KEY="your-opencode-go-key"
```

The endpoint is read-only and currently used by OpenCode Go clients, but it is not documented as a stable public API. Future response changes may require a plugin update.

### OpenRouter

OpenRouter displays the current key's budget as a `day`, `week` or `month` window from `GET https://openrouter.ai/api/v1/key`: the percentage is `effective_budget.spend_usd / limit_usd` and the countdown uses `effective_budget.resets_at`. `spent` shows key usage in USD and `credits` shows `total_credits - total_usage` from `GET https://openrouter.ai/api/v1/credits` (best effort). A key without a budget keeps the money rows and drops the window.

The stored OpenCode `openrouter` credential is preferred; for an environment fallback set:

```sh
export OPENROUTER_API_KEY="your-openrouter-key"
```

The API reports budget spend, not request counts, so no requests-per-day percentage is shown.


## Usage

- Click the main usage header to collapse or expand the full panel.
- Click provider rows to toggle provider details independently.
- Use `/usage-refresh` or the configured refresh keybind, default `<leader>q`, to refresh manually.
- Runtime refreshes use the account-safe provider cache under `/tmp/opencode-usage-monitor-v2/`.
- Render errors are caught and displayed inside an error boundary.

## Project structure

```text
.
├── assets/                    # Local screenshots used by this README
├── dist/                      # Built package output
├── src/
│   ├── auth.ts                # OpenCode auth and environment credential discovery
│   ├── provider-cache.ts      # Account-safe provider cache
│   ├── runtime-config.ts      # Versioned runtime config parsing and validation
│   ├── credentials.ts         # Credential resolver for provider registrations
│   ├── index.ts               # OpenCode plugin entry
│   ├── refresh*.ts            # Runtime refresh coordinator modules
│   ├── sanitize.ts            # Secret redaction helpers
│   ├── snapshot-validation.ts # Snapshot validation before publication/cache
│   ├── tui.ts                 # TUI plugin module
│   ├── providers/             # OpenAI, Z.AI / GLM, DeepSeek, and OpenCode Go clients
│   └── views/                 # TUI view rendering helpers
├── package.json               # Package metadata, scripts, peer dependencies
├── tsconfig.json              # Strict TypeScript config
└── LICENSE
```

## Troubleshooting

- If OpenAI shows `missing-auth`, reauthorize the selected OpenAI connection in OpenCode. For an explicit `usageCredentialID`, confirm it still exists under the OpenAI integration; the collector intentionally does not fall back to another account.
- If Z.AI shows `auth missing`, configure a supported Z.AI or Zhipu environment variable or OpenCode auth entry.
- If Z.AI shows `partial` on an enterprise/org account, set `providers.zai.options.organization_id` and `providers.zai.options.project_id` (or `ZHIPU_ORGANIZATION_ID` / `ZHIPU_PROJECT_ID`) so the `?type=2` endpoint is used.
- If DeepSeek shows `auth missing`, set `DEEPSEEK_API_KEY` or activate a DeepSeek credential in OpenCode.
- If OpenCode Go shows `auth missing`, run `/connect`, select OpenCode Go, and enter its API key, or set `OPENCODE_GO_API_KEY`.
- If the panel shows a `config` error, migrate `usage-monitor.json` to the `version: 2` shape and define at least one provider under `providers`.
- If the panel is too wide or narrow, adjust `ui.width` in `usage-monitor.json`.
- If refreshes appear stale, lower `refresh.interval_ms` or check provider API connectivity.
- If build output is missing, run `bun run build:all` and verify `dist/index.js` and `dist/tui.js` exist.
- If cached data appears stale, check `/tmp/opencode-usage-monitor-v2/`.

## Limitations / Security

- The server resolves only the selected/active OpenAI connection through OpenCode; the TUI credential-list permission is not required for Codex usage.
- Secrets are redacted from rendered error messages before they reach the TUI.
- Provider data depends on external OpenAI, Z.AI, Zhipu, DeepSeek, and OpenCode Go API availability and credential permissions. The package smoke uses mocked host/upstream behavior and does not replace a live deployment test.
- The package is a host extension; runtime behavior depends on compatible OpenCode and OpenTUI APIs.

## Status

Actively maintained personal OpenCode tool/plugin. Public issues and improvements are welcome, but the project is primarily maintained around the author's own workflow.

## Links / License

- Package: <https://www.npmjs.com/package/opencode-usage-monitor>
- Repository: <https://github.com/Mark1708/opencode-usage-monitor>
- Host app: <https://opencode.ai/>
- Listed under Plugins in the curated [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode) directory.
- License: MIT, see [`LICENSE`](LICENSE)
