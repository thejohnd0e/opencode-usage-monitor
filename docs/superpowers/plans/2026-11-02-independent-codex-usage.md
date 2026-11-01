# Independent Codex Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenAI/Codex monitoring work with no codex-limits plugin installed, preserving account selection and reset-credit information.

**Architecture:** A disposable server collector resolves OpenCode-owned credentials, fetches and validates Codex data, and serves an internal RPC. The OpenAI provider uses an instance-scoped host dependency instead of reading secrets in the TUI. Server generations and TUI refresh generations prevent prior-account results from being published.

**Tech Stack:** TypeScript, Bun tests/build, OpenCode V2 plugin and RPC APIs, existing canonical snapshot validator and refresh coordinator.

**Spec:** `docs/superpowers/specs/2026-11-02-independent-codex-usage-design.md`

## Global Constraints

- Preserve exports `.` and `./tui` and IDs `usage-monitor`, `usage-monitor.tui`; use no root shims or dual API shapes.
- No direct OAuth refresh, auth.json reads, dashboard scraping, refresh-token storage, or model-account activation.
- Default to active OpenAI; optional server option `usageCredentialID` selects a statistics-only connection with no fallback.
- Automatic intervals never below 60000 ms. Bound requests and cancel owned work on disposal.
- No secrets/raw credential records/raw upstream payloads in RPC, render state, logs, or persistent cache.
- Invalid/disabled config starts no provider work. Do not modify other providers' credential paths.
- Do not remove codex-limits, publish, or change the live installation without separate authorization.

## Review Focus

1. OAuth resolution itself can emit credential.updated: avoid self-triggering refresh loops (Task 3).
2. Two terminals with different detail options must not share an incompatible snapshot (Task 3).
3. Server reload or an RPC outage must not resurrect stale prior-account data (Task 4).
4. A caller cancelling shared work must not break another terminal's request (Task 3).
5. Credit titles/dates can be hostile, oversized, expired, or duplicated; keep output safe and bounded (Task 2).

## File Structure and Interfaces

- `src/codex-contract.ts`: internal RPC definition `CodexUsage`, request/reply types, runtime reply validation. No public RPC package export.
- `src/codex-account.ts`: server option parsing and OpenAI connection resolution/projection.
- `src/codex-fetch.ts`: upstream fetching and normalization, extracted from `src/providers/openai.ts`.
- `src/codex-collector.ts`: request/cache/generation ownership, subscription invalidation, disposal.
- `src/index.ts`: server setup and RPC wiring, no network work during registration.
- `src/providers/openai.ts`: host-backed adapter and options; no global reader or direct TUI network path.
- `src/providers/contracts.ts`, `src/refresh-contracts.ts`, `src/refresh.ts`: instance-scoped Codex dependency propagation.
- `src/tui.ts`: RPC client, invalidation subscription and cleanup.
- `src/__tests__/codex-{account,fetch,collector,rpc}.test.ts`: isolated server-side contracts and races.
- Existing OpenAI, refresh, TUI lifecycle and package checks: adapt tests to new host-backed contract.
- `scripts/verify-package.mjs`: packed consumer and isolated host checks without foreign plugin.
- `AGENTS.md`, `README.md`: selected-credential exception, supported SDK, configuration and migration instructions.

Shared TypeScript interfaces (define in `codex-contract.ts`):

```ts
type CodexReadInput = Readonly<{
  show_resets: boolean;
  show_reset_expiry: boolean;
  timeout_ms: number;
}>;
type CodexReply =
  | Readonly<{ status: 'ok'; revision: string; snapshot: StandardUsageProvider }>
  | Readonly<{ status: 'missing-auth' | 'forbidden' | 'error' | 'unsupported'; revision: string; message: string }>;
type CodexUsageFetcher = (input: CodexReadInput, signal: AbortSignal) => Promise<CodexReply>;
```

`revision` is an opaque server-instance/generation identifier, not a token/account ID. It changes on account invalidation and server reload. Codex snapshots stay in server memory only; the client must not persist them under the no-credential sentinel.

---

### Task 1: Pin host compatibility and credential selection

**Files:** Create `src/codex-account.ts`, `src/__tests__/codex-account.test.ts`; modify `AGENTS.md`; inspect `.test-types/host-api/package.json` and installed SDK declarations.

**Interfaces:** Export `parseCodexServerOptions(input: unknown): { usageCredentialID?: string }` and `resolveCodexAccount(host: Pick<Plugin.Context, 'integration'>, options: { usageCredentialID?: string }): Promise<CodexAccount | undefined>`. `CodexAccount` contains only transient `connectionID`, `accountID`, `access`, `expires`; never refresh tokens or raw host records.

- [x] Write failing tests `defaults to active connection`, `explicit selection never activates or falls back`, `rejects non-OpenAI/non-OAuth/missing metadata`, and `copies only required credential fields`. Assert resolve called with selected connection and activate never called. Invalid/blank server options fail closed.
- [x] Run `bun test src/__tests__/codex-account.test.ts`; verify failures expose missing implementation.
- [x] Inspect Promise plugin and RPC declarations for both installed SDK 2.2.5 and fixture SDK 2.0.32. Confirm integration resolve/selection/subscription types. Retain 2.0.32 support if APIs permit; if not, stop and request approval of a new floor before dependency changes. Do not silently align the fixture to 2.2.5.
- [x] Implement parser/resolver using host APIs with no activation and no direct renewal. Reject expired/unusable resolved results rather than using an unrelated credential.
- [x] Run account tests and `bun run typecheck:host`; add a compile fixture for actual integration/RPC capabilities used. Record compatibility evidence and amend AGENTS.md with the approved statistics-only credential exception.
- [x] Commit only Task 1 files after checking staged diff: `git commit -m "feat: resolve Codex statistics credentials through OpenCode"`.

### Task 2: Own Codex API parsing and reset details

**Files:** Create `src/codex-fetch.ts`, `src/__tests__/codex-fetch.test.ts`; modify `src/providers/openai.ts`, `src/__tests__/openai-resets.test.ts` as necessary for extracted parsing.

**Interfaces:** Export `fetchCodexSnapshot(account: CodexAccount, options: OpenAIOptions, signal: AbortSignal): Promise<StandardUsageProvider>`; preserve/export `normalizeWhamUsage` through its existing import path for existing tests until final adapter cleanup. The collector supplies a bounded signal. Use existing GET endpoints only.

- [x] Add failing tests for five-hour/weekly values and reset timestamps; count zero; optional details disabled; detail endpoint failure with valid primary usage; 401/403; malformed usage; timeout/abort; secret-bearing errors.
- [x] Add table-driven tests `sanitizes reset credits`: available credits only, maximum 100 entries, title maximum 200 characters with control characters removed, finite valid dates only, stable index-based keys for duplicate titles, expired credits excluded. Respect show_resets=false (no count/details) and show_reset_expiry=false (count only).
- [x] Run `bun test src/__tests__/codex-fetch.test.ts src/__tests__/openai-resets.test.ts`; confirm RED.
- [x] Extract/reuse native parsing and HTTP headers; add bounded credit-detail normalization. Apply `validateAndCloneUsageSnapshot(snapshot, 'openai', { credential: account.access })` before success. Map failures to explicit safe status providers; do not send raw HTTP bodies or error objects onward.
- [x] Run the same tests plus `bun test src/__tests__/snapshot-validation.test.ts`; confirm PASS and inspect serialized results for the fixture access secret.
- [x] Commit targeted files: `git commit -m "feat: collect Codex usage and reset details on the server"` (c7fd82e).

### Task 3: Disposable account-safe collector and RPC

**Files:** Create `src/codex-contract.ts`, `src/codex-collector.ts`, `src/__tests__/codex-collector.test.ts`, `src/__tests__/codex-rpc.test.ts`; modify `src/index.ts`.

**Interfaces:** Export `createCodexCollector({ host, options, fetchSnapshot, now? }): { read(input: CodexReadInput, signal: AbortSignal): Promise<CodexReply>; invalidate(): void; dispose(): void }`. `fetchSnapshot` uses Task 2 signature. Define `CodexUsage` RPC ID `usage-monitor.codex`, method `read`, event `invalidated` with `{ revision: string }`. Input/output runtime validation rejects extra fields; timeout_ms integer range 1000..30000. Internal fetch timeout defaults/caps at 8000 ms, bounded further by requested timeout. Cache freshness 60000 ms; failures have a 60000 ms upstream retry cooldown.

- [x] Write tests for lazy setup (zero network calls), selection failures, response validation, secret-free reply, same-account coalescing, detail-option partitioning, account invalidation during resolve/fetch, stale fallback only within same scope, dispose during pending work, and rejecting invalid RPC input before credential resolution.
- [x] Add tests `caller abort does not abort another waiter`, bounded retry after invalidation during resolution, and cached reads detecting a changed active connection; deferred promises/fake clocks are used.
- [x] Run `bun test src/__tests__/codex-collector.test.ts src/__tests__/codex-rpc.test.ts`; confirm RED against absent contract/collector modules.
- [x] Implement server-owned shared requests with waiter-specific cancellation, account+options cache keys, invalidation generations, and pre-publication identity rechecks. Invalidation clears last-good cache and aborts superseded work. Never serve an old-scope result after resolution, even to a waiter already attached to an old request.
- [x] Register RPC in server setup; subscribe to credential.updated/switched using an owned abort controller; emit non-secret invalidated events with revision. Avoid emitting events from read itself. Retry after invalidation is bounded to one additional resolution; cleanup invalidates before abort/disposal.
- [x] Run focused tests and both typecheck gates; RPC schema plus canonical validator reject malformed and secret-bearing output.
- [x] Commit targeted files: `git commit -m "feat: expose independent account-safe Codex usage RPC"` (36ac9dc).

### Task 4: Route OpenAI through host RPC and isolate TUI state

**Files:** Modify `src/providers/openai.ts`, `src/providers/contracts.ts`, `src/refresh-contracts.ts`, `src/refresh.ts`, `src/tui.ts`; extend `src/__tests__/native-providers.test.ts`, `src/__tests__/refresh.test.ts`, `src/__tests__/tui-lifecycle.test.ts`, `src/__tests__/auth-v2.test.ts` and other affected OpenAI tests.

**Interfaces:** Add `fetchCodexUsage?: CodexUsageFetcher` to provider execution and refresh inputs. OpenAI registration uses `credentialMode: 'none'`, empty credential candidates, no persistent cache scope. TUI creates a per-setup RPC client and passes it through coordinator construction; remove setOpenAIUsageReader and OpenAI-specific refreshSelected/selectedOpenAICredentialID hooks from auth-v2 when no longer used. Existing credential readers still serve other providers.

- [x] Write failing tests asserting `openaiProviderDefinition.registration.credentialMode === 'none'`, OpenAI refresh with a resolver that throws still calls host RPC, and two TUI instances never share readers/results. No RPC dependency yields unsupported, never direct fetch or foreign RPC fallback.
- [x] Add tests for synchronous generation invalidation, stale replies rejected by coordinator generation gates, duplicate/out-of-order events, and unmount unsubscribing/aborting. Invalid/empty config makes zero Codex RPC reads. Keep Z.AI/DeepSeek/Go assertions unchanged.
- [x] Run focused tests; confirmed RED on required credential mode and missing per-setup RPC client.
- [x] Implement dependency propagation analogous to fetchHostUsageLimits. Validate every reply and convert safe error statuses into existing runtime states. Subscribe before initial fetch; invalidation advances coordinator generation before refresh. Delayed results from prior generations cannot commit.
- [x] Ensure no client persistent Codex cache reads/writes and no previous-good OpenAI snapshot survives invalidation. Remove global reader exports and OpenAI-only credential refresh/selection hooks; retain credential readers for other providers.
- [x] Run focused tests and whole suite. 307 tests pass; 15 pre-existing Windows/Bun persistent-cache tests still fail on `O_NOFOLLOW`. Both typecheck gates pass.
- [ ] Commit targeted files: `git commit -m "refactor: consume Codex statistics through instance-scoped host RPC"`.

### Task 5: Packed independence proof and migration instructions

**Files:** Modify `scripts/verify-package.mjs`, `README.md`, `AGENTS.md`; create `scripts/smoke-independent-codex.mjs`; adjust build/declaration pruning only if required by the internal contract.

**Interfaces:** `bun scripts/smoke-independent-codex.mjs <consumer-directory>` exercises the installed packed package in a disposable isolated host context, with mocked upstream/credential resolution and no codex-limits package. It exits nonzero on contract failures; it never accesses live credentials/config.

- [x] Extend clean-consumer checks to fail on codex-limits imports/package presence, old global reader export, missing server RPC registration, and TUI requesting a different RPC contract. The fixture has no `credential.list` permission for OpenAI and an expired OAuth credential refreshed by the host stub.
- [x] Run the new check before fixture support; confirmed it fails at the first required Codex RPC read (not on missing executables/imports).
- [x] Implement the isolated host fixture using installed exports and RPC serialization/schema. Verified 5h/week/reset details, host refresh, account switch, cleanup and unchanged model connection. This is a mocked packed-package integration smoke, not a live-host test.
- [x] Document server `usageCredentialID`, active default/no-fallback behavior, detail options, SDK compatibility evidence, failure states, removal of the runtime foreign dependency, and backup-first local migration. No live installation edit was made.
- [x] Run typechecks, targeted tests, build, package verification, and diff checks. Full suite result remains 307 pass / 15 known Windows/Bun persistent-cache failures (`O_NOFOLLOW`); this unchanged baseline is documented. Packed package verifier and independent Codex smoke both exit successfully.
- [ ] Commit targeted files: `git commit -m "test: verify packed Codex monitoring without external plugins"`.

## Deferred Local Installation Migration (requires authorization)

After gates/review, ask permission to update the local installation; implementation approval alone is not permission to edit the running global configuration. Back up exact wrapper/config files to the approved OpenCode temp directory, copy the verified artifact, replace the external RPC wrapper, move statistics selection from sources.json into usage-monitor's plugin options, enable show_reset_expiry to preserve current detail display, and retain codex-limits unchanged. Use config hot reload or `/reload`; do not restart the service just for config changes. Confirm only non-secret live status/counts and that model-account selection is unchanged. Do not delete old local files or backups.

## Execution and Completion Gates

- [ ] At execution start load the chosen execution skill, create an isolated worktree through using-git-worktrees, and bring these approved documents into it without losing current files.
- [ ] Execute each task RED → GREEN → targeted commit; track checkboxes here with real verification outcomes.
- [ ] Request whole-branch review, address actionable feedback, rerun affected gates, and report limitations honestly.
- [ ] Use verification-before-completion before any completion claim and finishing-a-development-branch for integration choices. Do not publish/merge/remove the external plugin implicitly.

## Plan Self-Review

Spec coverage: selection/compatibility Task 1; native collection/details Task 2; RPC/cache/cancellation Task 3; host-backed TUI/account isolation Task 4; packed independence/documentation Task 5; installation explicitly deferred. All five Review Focus inputs have owned tests. Types/signatures are shared through codex-contract.ts; output validation distinguishes successful canonical snapshots from safe error envelopes. SDK floor mismatch is a blocking compatibility decision, not an assumed dependency upgrade.
