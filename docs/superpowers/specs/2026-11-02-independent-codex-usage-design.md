# Independent Codex usage collection

Status: approved by user on 2026-11-02; implementation not started.

## Intent

Make opencode-usage-monitor independently collect and display OpenAI/Codex usage, including available reset credits, with codex-limits absent. Preserve the current model connection and other providers. The user selected a server-owned collector with an internal RPC rather than a TUI-owned fetch with a credential-refresh helper.

## Approaches

1. **Selected: server collector and internal RPC.** OpenCode resolves credentials on the server; the collector calls Codex endpoints and returns validated, non-secret snapshots to the TUI. More integration work, but one owner for authorization, network work, and account-safe caching.
2. Minimal replacement of the external refresh RPC, retaining TUI fetches. Smaller change, but splits credential and usage ownership and requires tokens in the terminal path. Not selected.

## Scope and non-goals

- Replace the local codex-limits dependency with a supported package implementation, not another installation-only patch.
- Preserve five-hour/weekly usage, reset times, available reset count, and the locally displayed titles/expiration of available reset credits. Respect existing show_resets/show_reset_expiry options; detailed credit entries follow show_reset_expiry, with migration explicitly enabling it to preserve this installation's display.
- Do not remove or modify codex-limits, publish a release, switch the model login, implement an OAuth flow, read auth.json, scrape dashboards, or change other providers' collection paths.
- Do not introduce a second UI panel or redesign the current Usage panel.

## Credential ownership and selection

The server uses documented V2 integration.connection.active and integration.connection.resolve APIs. Resolve delegates OAuth renewal and credential persistence to OpenCode. No direct refresh endpoint or refresh-token storage is added.

Default to the active OpenAI connection. Support an optional server plugin option `usageCredentialID` to select an existing OpenAI credential for statistics only, matching this installation's current behavior. Locate that connection through integration.get, verify it belongs to OpenAI, then resolve it without activation. An explicitly configured missing/unresolvable credential must never fall back to a different account. Do not include this machine's credential ID in source or defaults.

The repository AGENTS.md describes active-only credentials, whereas this installation already selects a dedicated statistics credential. Proposed contract amendment: OpenAI may resolve an explicitly configured statistics-only credential; all other credential discovery remains active-only. Document and test that exception as part of this change, subject to design approval.

## Server collector

Replace the empty server setup with a plugin-owned, disposable Codex service and RPC registration. Reuse/extract the existing OpenAI request and normalization logic rather than copying the foreign plugin. Fetch only the existing ChatGPT usage and reset-credit endpoints. Output only canonical validated StandardUsageProvider data plus an opaque non-secret scope identifier if needed for client cache isolation; never return credentials or raw payloads.

RPC validates its input and output. It accepts only bounded collection options needed for existing display/refresh behavior; it cannot accept arbitrary URLs, tokens, or caller-selected credential IDs. Server-configured selection is authoritative. Internal RPC contract need not become a public package export; both bundled entries can import the same source contract. Preserve package exports `.` and `./tui` unless implementation reveals a documented packaging need for another export, which requires revisiting this decision.

Reuse existing canonical snapshot validation at server publication and client acceptance. Sanitize and bound credit titles and dates. Optional reset-detail failures must not discard valid primary usage data. Missing credentials, unsupported connection types, authorization failure, timeout, and unavailable server RPC produce explicit non-secret states, not a fallback to the foreign RPC or browser credentials.

## Account safety, scheduling, and lifecycle

Cache and in-flight deduplication are scoped to the resolved connection/account, with generations invalidated on credential updates, switches, selection changes, and disposal. No earlier-account snapshot may be returned or committed after an account switch, including stale fallback. Recheck scope after asynchronous work. Distinct display options cannot reuse incompatible cached data. Prefer in-memory server cache for Codex; do not persist its data under a client identity derived from an unrelated credential.

Retain the configured refresh policy, with automatic intervals never below 60 seconds. Avoid duplicate fetches from multiple terminals by server-side deduplication and freshness checking. Bound upstream requests with timeout and cancellation. A caller cancellation must not wrongly invalidate another caller's shared request; implementation may use independently owned shared requests with caller-specific waiting cancellation.

Server cleanup invalidates generations, aborts owned requests/subscriptions, clears cache, and disposes RPC registration. TUI cleanup prevents late commits. Invalid or disabled usage config must initiate no provider work; server registration itself is inert until a valid collection request arrives.

## TUI and provider integration

Route the OpenAI provider through an instance-scoped host fetch dependency, analogous to the existing host-usage dependency. Remove the process-global setOpenAIUsageReader mechanism and stop reading OpenAI secrets in the TUI for this path. OpenAI must not be gated on the unrelated TUI credential resolver before its RPC runs. Other providers retain existing credential handling. Integrate server scope/status with refresh orchestration so switches clear stale OpenAI data and pending old-scope results cannot repopulate it.

## Installation migration

After package verification and explicit approval to apply the local update, back up the exact local usage-monitor wrapper/config files that will change. Replace the wrapper importing ../codex-limits/rpc.js with the independently built implementation. Move the current statistics credential selection from sources.json to usage-monitor's own plugin options. Preserve unrelated plugin options/settings and leave codex-limits installed and configured. Do not delete old files merely because the new implementation no longer uses them.

Demonstrate independence in an isolated host fixture containing usage-monitor but no codex-limits. The user's live codex-limits installation is not disabled as part of this work. A later removal remains a separate user decision.

## Verification

- Unit tests for selection, host-owned renewal, no activation, unavailable/expired credentials, and no fallback from explicit selection.
- Collector/RPC tests for valid windows and credit details, optional-detail failure, malformed payloads, bounded inputs, sanitized errors, and secret-free responses/cache.
- Account-switch races before/during credential resolve and fetch; credential deletion/update; cache and in-flight separation; cancellation; unload; multiple TUI clients; invalid/disabled configuration.
- TUI/provider integration tests ensuring OpenAI uses RPC without TUI credential gating or a global reader, preserves other providers, and clears prior-account display/cache.
- Package gates: bun run typecheck, bun run typecheck:host, bun test, bun run build:all, bun run verify:package. Extend artifact/consumer checks to cover server and internal RPC loading with no codex-limits installed.
- Isolated host smoke for usage-monitor alone; then, if authorized, local migration and a non-secret live data check. Host smoke must use disposable wrappers, not repository-root shims.

## Builder decisions and constraints

Exact module names, schemas, internal dependency interfaces, and test fixtures are implementer decisions consistent with existing architecture. Inspect installed SDK types before implementation. AGENTS.md pins an older SDK than package.json (currently 2.2.5); reconcile that documentation explicitly against the supported/tested host version rather than silently changing dependencies or adding a dual API shape. If supported host APIs cannot satisfy account isolation or cancellation guarantees, report the limitation before implementation instead of weakening them.
