# OpenCode Go Host Usage Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Display the active OpenCode Go workspace's 5-hour, weekly, and monthly limits using the host's typed usage-limits API, without requiring a Go API key.

**Architecture:** Upgrade the V2 plugin/client SDK to a compatible published release exposing `client.experimental.usage.limits()`. Thread that typed host-client capability through the refresh pipeline and let OpenCode Go use it without resolving a credential; normalize `data.go` into the existing provider snapshot and presentation path.

**Tech Stack:** TypeScript, OpenCode V2 Plugin/Client SDK, Bun tests and build.

**Spec:** `docs/superpowers/specs/2026-10-31-opencode-go-host-usage-design.md`

## Global Constraints

- Use the typed SDK method `client.experimental.usage.limits()`; do not call the local HTTP endpoint directly.
- Do not require or transmit a separate OpenCode Go credential for host-reported limits.
- Do not make model requests to obtain usage.
- Preserve existing quota formatting, 60-second minimum automatic refresh, validation, caching, and secret-sanitization guarantees.
- If an SDK or host compatibility gate fails, stop and report it; do not switch to HTTP or dashboard scraping.

## Review Focus

- Host API returns `data: null` or omits `go`: show a clear unavailable/unsupported provider status, never zero usage. Test in Task 3.
- A quota window is missing or has invalid `percent`/`resetsAt`: retain valid windows as partial data and reject invalid values. Test in Task 3.
- Host SDK call rejects or is cancelled: render a sanitized provider error and preserve refresh cancellation semantics. Test in Task 2.
- Go credential is missing, stale, or expired: still query host limits without reading or transmitting it. Test in Task 2.
- Switching workspaces must not show a cached quota from the previous workspace. Test that host-backed Go usage bypasses provider cache reads/writes in Task 2.

---

### Task 1: Upgrade to the typed host usage-limits SDK

**Files:**
- Modify: `package.json`
- Modify: `bun.lockb`
- Test: `src/__tests__/tui-lifecycle.test.ts` and package typecheck

**Interfaces:**
- Produces: `Plugin.Context.client.experimental.usage.limits(input?, requestOptions?)`, returning generated `ExperimentalUsageLimitsOutput` with `{ location, data }`; `data` contains `workspace`, optional `go`, and `budgets`.

- [x] **Step 1: Add a focused type assertion** for the SDK method and output fields (`data.go.rolling`, `weekly`, `monthly`).
- [x] **Step 2: Run the focused typecheck and confirm it fails** because pinned SDK 2.0.32 lacks this method.
- [x] **Step 3: Upgrade the OpenCode SDK family to 2.2.5** (`@opencode/plugin`, client transitively, and `@opencode/theme`); align OpenTUI dev/peer versions to the plugin's supported floor (0.8.0), regenerate `bun.lockb`, and make only compatibility changes required by that upgrade.
- [x] **Step 4: Run the focused typecheck and test**; require typed method/output assertions to pass. Stop if runtime plugin compatibility cannot be verified.

### Task 2: Thread host usage access through refresh without credentials

**Files:**
- Modify: `src/providers/contracts.ts`
- Modify: `src/refresh-contracts.ts`
- Modify: `src/refresh.ts`
- Modify: `src/tui.ts`
- Test: `src/__tests__/refresh.test.ts`
- Test: `src/__tests__/tui-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 typed SDK method.
- Produces: optional typed `fetchHostUsageLimits: () => Promise<ExperimentalUsageLimitsOutput>` on provider execution context and explicit credential mode (`required` or `none`) on provider registration. OpenCode Go uses `none`; other providers retain current behavior. Host-backed Go snapshots bypass the provider cache because workspace identity is learned from the API response.

- [x] **Step 1: Add failing refresh tests** proving a no-credential provider fetches without invoking credential resolution, receives the injected host method, and continues to honor abort/error behavior; assert host-backed Go skips provider cache reads/writes.
- [x] **Step 2: Run those tests and confirm they fail** on current mandatory-credential flow.
- [x] **Step 3: Implement the smallest contract and coordinator changes** to skip credential resolution only for `credentialMode: "none"`, pass the typed host method to provider execution, and bypass persistent/provider-cache reads and writes for that host-backed provider. Keep normal credential/provider flows unchanged.
- [x] **Step 4: Wire `context.client.experimental.usage.limits()` from `src/tui.ts`** into the coordinator; make the TUI lifecycle test assert the injected method is invoked and disposed refreshes do not call it.
- [x] **Step 5: Run refresh and TUI lifecycle tests** and require them to pass.

### Task 3: Normalize Go host limits and preserve the existing panel

**Files:**
- Modify: `src/providers/opencode-go.ts`
- Test: `src/__tests__/opencode-go.test.ts`

**Interfaces:**
- Consumes: Task 2 `hostUsageLimits` and `credentialMode: "none"`.
- Produces: `normalizeOpenCodeGoUsage(raw: ExperimentalUsageLimitsOutput, nowMs?)` mapping `raw.data.go` meters to existing `rolling`, `weekly`, and `monthly` windows.

- [x] **Step 1: Update/add tests** for real host result shape, percentages `0/0/6`, reset timestamps, `limited` flags, absent `go`, null data, partial windows, and invalid percent/time values; assert existing labels and presentation output.
- [x] **Step 2: Run `bun test src/__tests__/opencode-go.test.ts` and confirm the host-result cases fail.**
- [x] **Step 3: Replace the direct credentialed HTTP fetch** with the injected typed host method; normalize its `{ location, data }` response. Do not read or transmit a Go credential.
- [x] **Step 4: Run the focused tests** and require they pass, including the 0%, 0%, 6% live-shape fixture.

### Task 4: Verify package and full regression suite

**Files:**
- No additional changes expected; if needed, update `CHANGELOG.md`.

- [x] **Step 1: Run** `bun run typecheck` and `bun run typecheck:host`; require both to pass.
- [ ] **Step 2: Run** `bun test`; require no new failures versus the documented baseline. (Attempted: 274 pass, 15 pre-existing Windows cache-test failures; see ledger.)
- [x] **Step 3: Run** `bun run build:all` and `bun run verify:package`; require both to pass.
- [ ] **Step 4: Run a live read-only smoke check** through the plugin's typed SDK method and confirm Go window values render; do not invoke a model or expose credentials. (Unavailable: no live TUI host client is exposed to this worktree session; typed client behavior is covered by lifecycle tests.)
