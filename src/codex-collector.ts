import type { Plugin } from "@opencode/plugin";
import { resolveCodexAccount, type CodexAccount, type CodexServerOptions } from "./codex-account.js";
import {
	encodeCodexReply,
	type CodexReadInput,
	type CodexReply,
} from "./codex-contract.js";
import { validateAndCloneUsageSnapshot } from "./snapshot-validation.js";
import type { OpenAIOptions } from "./providers/openai.js";
import type { StandardUsageProvider } from "./providers/types.js";

const FRESH_MS = 60_000;
const STALE_MS = 60_000;
const FAILURE_COOLDOWN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;

type CodexFetchSnapshot = (
	account: CodexAccount,
	options: OpenAIOptions,
	signal: AbortSignal,
) => Promise<StandardUsageProvider>;

type CacheEntry = {
	key: string;
	revision: string;
	snapshot: StandardUsageProvider;
	updatedAt: number;
	failureUntil?: number;
};

type InFlight = {
	key: string;
	generation: number;
	controller: AbortController;
	promise: Promise<CodexReply>;
};

export function createCodexCollector(input: {
	host: Pick<Plugin.Context, "integration">;
	options: CodexServerOptions;
	fetchSnapshot: CodexFetchSnapshot;
	now?: () => number;
}): {
	read(input: CodexReadInput, signal: AbortSignal): Promise<CodexReply>;
	invalidate(): void;
	dispose(): void;
} {
	const now = input.now ?? Date.now;
	const instanceID = crypto.randomUUID();
	let generation = 0;
	let sequence = 0;
	let disposed = false;
	let cache: CacheEntry | undefined;
	const inFlight = new Map<string, InFlight>();

	const revision = () => `${instanceID}:${++sequence}`;
	const status = (
		status: "missing-auth" | "forbidden" | "error" | "unsupported",
		message: string,
		revisionID = revision(),
	): CodexReply => Object.freeze({ status, revision: revisionID, message });

	function invalidate(): void {
		generation += 1;
		cache = undefined;
		for (const pending of inFlight.values()) pending.controller.abort("invalidated");
		inFlight.clear();
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		invalidate();
	}

	async function read(readInput: CodexReadInput, signal: AbortSignal): Promise<CodexReply> {
		if (disposed) return status("error", "Codex collector disposed");
		if (signal.aborted) return status("error", "cancelled");
		let resolveGeneration = generation;
		let account = await resolveCodexAccount(input.host, input.options);
		if (generation !== resolveGeneration && !disposed) {
			resolveGeneration = generation;
			account = await resolveCodexAccount(input.host, input.options);
		}
		if (disposed) return status("error", "Codex collector disposed");
		if (signal.aborted) return status("error", "cancelled");
		if (!account) return status("missing-auth", "Codex login unavailable");

		const generationAtStart = resolveGeneration;
		const opts: OpenAIOptions = {
			show_resets: readInput.show_resets,
			show_reset_expiry: readInput.show_reset_expiry,
		};
		const key = `${account.connectionID}\u0000${account.accountID}\u0000${Number(opts.show_resets)}\u0000${Number(opts.show_reset_expiry)}`;
		const cached = cache?.key === key ? cache : undefined;
		if (cached && now() - cached.updatedAt < FRESH_MS) {
			return ok(cached.revision, cached.snapshot);
		}
		if (cached?.failureUntil && now() < cached.failureUntil) {
			return staleOrError(cached);
		}

		let pending = inFlight.get(key);
		if (!pending || pending.generation !== generationAtStart) {
			const controller = new AbortController();
			const requestedTimeout = Number.isSafeInteger(readInput.timeout_ms)
				? readInput.timeout_ms
				: DEFAULT_TIMEOUT_MS;
			const timeoutMs = Math.min(
				DEFAULT_TIMEOUT_MS,
				Math.max(1_000, requestedTimeout),
			);
			const timer = setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
			let promise!: Promise<CodexReply>;
			promise = (async (): Promise<CodexReply> => {
				try {
					const fetched = await input.fetchSnapshot(account, opts, controller.signal);
					if (disposed || generation !== generationAtStart || controller.signal.aborted) {
						return status("error", "cancelled");
					}
					const currentAccount = await resolveCodexAccount(input.host, input.options);
					if (
						!currentAccount ||
						currentAccount.connectionID !== account.connectionID ||
						currentAccount.accountID !== account.accountID ||
						disposed ||
						generation !== generationAtStart
					) {
						invalidate();
						return status("error", "Codex account changed");
					}
					if (fetched.status !== "ready" && fetched.status !== "partial") {
						const statusName =
							fetched.status === "forbidden" || fetched.status === "missing-auth"
								? fetched.status
								: "error";
						const failed = status(statusName, safeMessage(fetched.statusText ?? fetched.errorMessage));
						if (cached && now() - cached.updatedAt <= FRESH_MS + STALE_MS) {
						cached.failureUntil = now() + FAILURE_COOLDOWN_MS;
						return staleOrError(cached);
					}
					return failed;
					}
					const validation = validateAndCloneUsageSnapshot(fetched, "openai", {
						credential: account.access,
					});
					if (!validation.ok) return status("error", "Codex response was invalid");
					const entry: CacheEntry = {
						key,
						revision: revision(),
						snapshot: validation.snapshot,
						updatedAt: now(),
					};
					cache = entry;
					return ok(entry.revision, entry.snapshot);
				} catch {
					if (disposed || generation !== generationAtStart || controller.signal.aborted) {
						return status("error", "cancelled");
					}
					if (cached && now() - cached.updatedAt <= FRESH_MS + STALE_MS) {
						cached.failureUntil = now() + FAILURE_COOLDOWN_MS;
						return staleOrError(cached);
					}
					return status("error", "Codex request failed");
				} finally {
					clearTimeout(timer);
					if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
				}
			})();
			pending = { key, generation: generationAtStart, controller, promise };
			inFlight.set(key, pending);
		}
		return await waitForCaller(pending.promise, signal, status);
	}

	function staleOrError(entry: CacheEntry): CodexReply {
		if (now() - entry.updatedAt > FRESH_MS + STALE_MS) {
			return status("error", "Codex request failed", entry.revision);
		}
		const snapshot = { ...entry.snapshot, staleAt: now() };
		return ok(entry.revision, snapshot);
	}

	return { read, invalidate, dispose };
}

function ok(revision: string, snapshot: StandardUsageProvider): CodexReply {
	return Object.freeze({ status: "ok", revision, snapshot });
}

function safeMessage(value: string | undefined): string {
	const message = value?.split("\n")[0]?.slice(0, 1_024) ?? "Codex request failed";
	return /token|bearer|secret|authorization|credential/i.test(message)
		? "Codex request failed"
		: message;
}

function waitForCaller(
	promise: Promise<CodexReply>,
	signal: AbortSignal,
	status: (status: "missing-auth" | "forbidden" | "error" | "unsupported", message: string) => CodexReply,
): Promise<CodexReply> {
	if (signal.aborted) return Promise.resolve(status("error", "cancelled"));
	return new Promise((resolve) => {
		const onAbort = () => resolve(status("error", "cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, () => resolve(status("error", "Codex request failed"))).finally(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});
}
