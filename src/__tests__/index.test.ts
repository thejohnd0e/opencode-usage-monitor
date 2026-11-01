import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import plugin from "../index.js";
import { decodeCodexReply } from "../codex-contract.js";

function contextFixture() {
	const calls: string[] = [];
	let handlers: { read: (input: unknown, context: { signal: AbortSignal }) => Promise<unknown> } | undefined;
	let eventSignal: AbortSignal | undefined;
	const context = {
		options: {},
		integration: {
			connection: {
				active: async (integrationID: string) => {
					calls.push(`active:${integrationID}`);
					return undefined;
				},
				resolve: async () => undefined,
			},
			get: async () => ({ data: { id: "openai", connections: [] } }),
		},
		rpc: {
			register: async (_definition: unknown, registered: typeof handlers) => {
				handlers = registered;
				return {
					events: { emit: async () => undefined },
					dispose: () => undefined,
				};
			},
		},
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => {
				eventSignal = signal;
				return {
					async *[Symbol.asyncIterator]() {
						await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
					},
				};
			},
		},
	};
	return {
		context: context as unknown as Plugin.Context,
		calls,
		get handlers() { return handlers; },
		get eventSignal() { return eventSignal; },
	};
}

describe("server RPC setup", () => {
	test("rejects malformed RPC input before resolving an OpenAI credential", async () => {
		const fixture = contextFixture();
		const cleanup = await plugin.setup(fixture.context);
		expect(fixture.handlers).toBeDefined();
		const reply = await fixture.handlers?.read(
			{ show_resets: true, show_reset_expiry: false, timeout_ms: 1_000, extra: "no" },
			{ signal: new AbortController().signal },
		);

		expect(decodeCodexReply(reply)).toMatchObject({ status: "unsupported" });
		expect(fixture.calls).toEqual([]);
		await cleanup?.();
		expect(fixture.eventSignal?.aborted).toBe(true);
	});

	test("returns missing-auth through the registered RPC without leaking host data", async () => {
		const fixture = contextFixture();
		const cleanup = await plugin.setup(fixture.context);
		const reply = await fixture.handlers?.read(
			{ show_resets: true, show_reset_expiry: false, timeout_ms: 1_000 },
			{ signal: new AbortController().signal },
		);

		expect(decodeCodexReply(reply)).toMatchObject({ status: "missing-auth" });
		expect(fixture.calls).toEqual(["active:openai"]);
		await cleanup?.();
	});
});
