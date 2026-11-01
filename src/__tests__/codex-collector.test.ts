import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import { createCodexCollector } from "../codex-collector.js";
import type { CodexAccount } from "../codex-account.js";
import type { CodexReadInput } from "../codex-contract.js";
import type { StandardUsageProvider } from "../providers/types.js";

const input: CodexReadInput = {
	show_resets: true,
	show_reset_expiry: false,
	timeout_ms: 8_000,
};

function readySnapshot(fetchedAt: number): StandardUsageProvider {
	return {
		id: "openai",
		displayName: "openai",
		status: "ready",
		windows: [{
			id: "openai-primary",
			label: "5h",
			kind: "rolling",
			period: { kind: "rolling", durationMs: 18_000_000 },
			usage: { kind: "percent", usedPercent: 30 },
			percentage: 30,
		}],
		fetchedAt,
	};
}

function hostFixture(options: {
	connectionID?: string;
	accountID?: string;
	onResolve?: (connectionID: string) => void | Promise<void>;
} = {}) {
	let activeConnectionID = options.connectionID ?? "cred-a";
	let accountID = options.accountID ?? "account-a";
	const calls: string[] = [];
	const host = {
		integration: {
			get: async ({ integrationID }: { integrationID: string }) => ({
				data: {
					id: integrationID,
					name: "OpenAI",
					methods: [],
					connections: [{ type: "credential", id: activeConnectionID, label: "OpenAI", method: "oauth" }],
				},
			}),
			connection: {
				active: async (integrationID: string) => {
					calls.push(`active:${integrationID}`);
					return { type: "credential", id: activeConnectionID, label: "OpenAI", method: "oauth" };
				},
				resolve: async (connection: { id: string }) => {
					calls.push(`resolve:${connection.id}`);
					await options.onResolve?.(connection.id);
					return {
						type: "oauth",
						methodID: "oauth",
						refresh: "never-export-refresh",
						access: `access-${connection.id}`,
						expires: Date.now() + 60_000,
						metadata: { accountID },
					};
				},
			},
		},
	};
	return {
		host: host as unknown as Pick<Plugin.Context, "integration">,
		calls,
		setActive(connectionID: string, nextAccountID: string) {
			activeConnectionID = connectionID;
			accountID = nextAccountID;
		},
	};
}

describe("Codex collector lifecycle and scope", () => {
	test("collector setup performs no credential resolution or network work", () => {
		const { host, calls } = hostFixture();
		const collector = createCodexCollector({
			host,
			options: {},
			fetchSnapshot: async () => readySnapshot(Date.now()),
		});

		expect(calls).toEqual([]);
		collector.dispose();
	});

	test("returns missing-auth without fetching when OpenCode cannot resolve the connection", async () => {
		const { host } = hostFixture({ onResolve: () => { throw new Error("no login"); } });
		let fetches = 0;
		const collector = createCodexCollector({
			host,
			options: {},
			fetchSnapshot: async () => { fetches += 1; return readySnapshot(Date.now()); },
		});

		expect(await collector.read(input, new AbortController().signal)).toMatchObject({
			status: "missing-auth",
			message: "Codex login unavailable",
		});
		expect(fetches).toBe(0);
		collector.dispose();
	});

	test("coalesces concurrent reads for one account and keeps replies secret-free", async () => {
		const { host } = hostFixture();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<StandardUsageProvider>();
		let fetches = 0;
		const collector = createCodexCollector({
			host,
			options: {},
			fetchSnapshot: async () => {
				fetches += 1;
				started.resolve();
				return finish.promise;
			},
		});

		const first = collector.read(input, new AbortController().signal);
		const second = collector.read(input, new AbortController().signal);
		await started.promise;
		expect(fetches).toBe(1);
		finish.resolve(readySnapshot(Date.now()));
		const replies = await Promise.all([first, second]);
		expect(replies[0]).toMatchObject({ status: "ok", snapshot: { id: "openai" } });
		expect(JSON.stringify(replies)).not.toContain("never-export-refresh");
		collector.dispose();
	});

	test("partitions cache and in-flight data by reset display options", async () => {
		const { host } = hostFixture();
		const optionsSeen: boolean[] = [];
		const collector = createCodexCollector({
			host,
			options: {},
			fetchSnapshot: async (_account, readOptions) => {
				optionsSeen.push(readOptions.show_reset_expiry);
				return readySnapshot(Date.now());
			},
		});

		await Promise.all([
			collector.read(input, new AbortController().signal),
			collector.read({ ...input, show_reset_expiry: true }, new AbortController().signal),
		]);
		expect(optionsSeen.sort()).toEqual([false, true]);
		collector.dispose();
	});

	test("drops a result completed after account invalidation", async () => {
		const { host } = hostFixture();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<StandardUsageProvider>();
		const collector = createCodexCollector({
			host,
			options: {},
			fetchSnapshot: async () => {
				started.resolve();
				return finish.promise;
			},
		});
		const request = collector.read(input, new AbortController().signal);
		await started.promise;
		collector.invalidate();
		finish.resolve(readySnapshot(Date.now()));
		const reply = await request;

		expect(reply.status).not.toBe("ok");
		collector.dispose();
	});

	test("re-resolves after invalidation during credential resolution without looping", async () => {
		let collector: ReturnType<typeof createCodexCollector>;
		let resolves = 0;
		const { host } = hostFixture({
			onResolve: () => {
				resolves += 1;
				if (resolves === 1) collector.invalidate();
			},
		});
		let fetches = 0;
		collector = createCodexCollector({
			host,
			options: {},
			fetchSnapshot: async () => { fetches += 1; return readySnapshot(Date.now()); },
		});

		const reply = await collector.read(input, new AbortController().signal);
		expect(reply.status).toBe("ok");
		expect(resolves).toBe(3);
		expect(fetches).toBe(1);
		collector.dispose();
	});

	test("caller abort does not cancel a shared request still awaited by another caller", async () => {
		const { host } = hostFixture();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<StandardUsageProvider>();
		let fetchSignal: AbortSignal | undefined;
		const collector = createCodexCollector({
			host,
			options: {},
			fetchSnapshot: async (_account, _options, signal) => {
				fetchSignal = signal;
				started.resolve();
				return finish.promise;
			},
		});
		const cancelled = new AbortController();
		const first = collector.read(input, cancelled.signal);
		const second = collector.read(input, new AbortController().signal);
		await started.promise;
		cancelled.abort();
		expect(fetchSignal?.aborted).toBe(false);
		finish.resolve(readySnapshot(Date.now()));
		const [firstReply, secondReply] = await Promise.all([first, second]);
		expect(firstReply.status).not.toBe("ok");
		expect(secondReply.status).toBe("ok");
		collector.dispose();
	});

	test("uses stale data only for the same account and never after a switch", async () => {
		const clock = { value: 1_800_000_000_000 };
		const fixture = hostFixture();
		let fetches = 0;
		const collector = createCodexCollector({
			host: fixture.host,
			options: {},
			now: () => clock.value,
			fetchSnapshot: async () => {
				fetches += 1;
				return fetches === 1
					? readySnapshot(clock.value)
					: { ...readySnapshot(clock.value), status: "error", statusText: "api 503", windows: [] };
			},
		});
		const first = await collector.read(input, new AbortController().signal);
		clock.value += 60_001;
		const stale = await collector.read(input, new AbortController().signal);
		expect(first.status).toBe("ok");
		expect(stale).toMatchObject({ status: "ok", snapshot: { status: "ready", staleAt: clock.value } });

		fixture.setActive("cred-b", "account-b");
		const switched = await collector.read(input, new AbortController().signal);
		expect(switched.status).not.toBe("ok");
		expect(JSON.stringify(switched)).not.toContain("account-a");
		collector.dispose();
	});

	test("rechecks the active connection instead of serving fresh cache blindly", async () => {
		const fixture = hostFixture();
		let fetches = 0;
		const collector = createCodexCollector({
			host: fixture.host,
			options: {},
			fetchSnapshot: async () => { fetches += 1; return readySnapshot(Date.now()); },
		});
		const first = await collector.read(input, new AbortController().signal);
		fixture.setActive("cred-b", "account-b");
		const second = await collector.read(input, new AbortController().signal);

		expect(first.status).toBe("ok");
		expect(second.status).toBe("ok");
		if (first.status === "ok" && second.status === "ok") {
			expect(first.revision).not.toBe(second.revision);
		}
		expect(fetches).toBe(2);
		collector.dispose();
	});

	test("does not publish a fetch result if the account changed while it was in flight", async () => {
		const fixture = hostFixture();
		const collector = createCodexCollector({
			host: fixture.host,
			options: {},
			fetchSnapshot: async () => {
				fixture.setActive("cred-new", "account-new");
				return readySnapshot(Date.now());
			},
		});

		const reply = await collector.read(input, new AbortController().signal);
		expect(reply.status).not.toBe("ok");
		expect(JSON.stringify(reply)).not.toContain("account-a");
		collector.dispose();
	});

	test("disposal prevents a pending fetch from publishing a snapshot", async () => {
		const { host } = hostFixture();
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<StandardUsageProvider>();
		const collector = createCodexCollector({
			host,
			options: {},
			fetchSnapshot: async () => { started.resolve(); return finish.promise; },
		});
		const pending = collector.read(input, new AbortController().signal);
		await started.promise;
		collector.dispose();
		finish.resolve(readySnapshot(Date.now()));
		expect((await pending).status).not.toBe("ok");
	});
});
