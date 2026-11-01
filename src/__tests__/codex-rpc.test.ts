import { describe, expect, test } from "bun:test";

import {
	decodeCodexReply,
	encodeCodexReply,
	parseCodexReadInput,
	type CodexReply,
} from "../codex-contract.js";

const success: CodexReply = {
	status: "ok",
	revision: "server-instance:1",
	snapshot: {
		id: "openai",
		displayName: "openai",
		status: "ready",
		windows: [{
			id: "openai-primary",
			label: "5h",
			kind: "rolling",
			period: { kind: "rolling", durationMs: 18_000_000 },
			usage: { kind: "percent", usedPercent: 42 },
			percentage: 42,
		}],
		fetchedAt: 1_800_000_000_000,
	},
};

describe("Codex RPC boundary", () => {
	test("accepts only bounded read options", () => {
		expect(parseCodexReadInput({
			show_resets: true,
			show_reset_expiry: false,
			timeout_ms: 1_000,
		})).toEqual({
			show_resets: true,
			show_reset_expiry: false,
			timeout_ms: 1_000,
		});
		expect(parseCodexReadInput({ show_resets: true, show_reset_expiry: false, timeout_ms: 30_000 })).not.toBeUndefined();
		expect(parseCodexReadInput({ show_resets: true, show_reset_expiry: false, timeout_ms: 999 })).toBeUndefined();
		expect(parseCodexReadInput({ show_resets: true, show_reset_expiry: false, timeout_ms: 30_001 })).toBeUndefined();
		expect(parseCodexReadInput({ show_resets: true, show_reset_expiry: false, timeout_ms: 1_000, url: "https://attacker.test" })).toBeUndefined();
		expect(parseCodexReadInput([])).toBeUndefined();
	});

	test("round-trips only validated canonical Codex replies", () => {
		const encoded = encodeCodexReply(success);
		expect(encoded).toBeDefined();
		expect(decodeCodexReply(encoded)).toEqual(success);
		expect(decodeCodexReply({ encoded: "not-json" })).toBeUndefined();
	});

	test("rejects unsupported providers, raw payloads, and invalid statuses", () => {
		expect(encodeCodexReply({
			...success,
			snapshot: { ...success.snapshot, id: "zai" },
		} as CodexReply)).toBeUndefined();
		expect(encodeCodexReply({
			status: "ok",
		revision: "server-instance:1",
		snapshot: { ...success.snapshot, raw: { authorization: "Bearer secret" } },
		} as unknown as CodexReply)).toBeUndefined();
		expect(decodeCodexReply({ encoded: JSON.stringify({ status: "maybe", revision: "x" }) })).toBeUndefined();
	});

	test("bounds failure text and never serializes arbitrary error objects", () => {
		const reply = {
			status: "error",
			revision: "server-instance:2",
			message: `${"x".repeat(2_000)}\nprivate detail`,
		} as CodexReply;
		const encoded = encodeCodexReply(reply);
		expect(encoded).toBeDefined();
		const decoded = decodeCodexReply(encoded);
		expect(decoded?.status).toBe("error");
		if (decoded?.status !== "ok") {
			expect(decoded?.message.length).toBeLessThanOrEqual(1_024);
			expect(decoded?.message).not.toContain("private detail");
		}
	});
});
