import { Rpc } from "@opencode/plugin/rpc";
import { hasSecretPattern } from "./sanitize.js";
import { validateAndCloneUsageSnapshot } from "./snapshot-validation.js";
import type { StandardUsageProvider } from "./providers/types.js";

export type CodexReadInput = Readonly<{
	show_resets: boolean;
	show_reset_expiry: boolean;
	timeout_ms: number;
}>;

export type CodexReply =
	| Readonly<{ status: "ok"; revision: string; snapshot: StandardUsageProvider }>
	| Readonly<{
			status: "missing-auth" | "forbidden" | "error" | "unsupported";
			revision: string;
			message: string;
	  }>;

export const CodexUsage = Rpc.define({
	id: "usage-monitor.codex",
	methods: {
		read: {
			input: {
				type: "object",
				properties: {
					show_resets: { type: "boolean" },
					show_reset_expiry: { type: "boolean" },
					timeout_ms: { type: "integer", minimum: 1_000, maximum: 30_000 },
				},
				required: ["show_resets", "show_reset_expiry", "timeout_ms"],
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: { encoded: { type: "string", maxLength: 300_000 } },
				required: ["encoded"],
				additionalProperties: false,
			},
		},
	},
	events: {
		invalidated: {
			schema: {
				type: "object",
				properties: { revision: { type: "string", maxLength: 128 } },
				required: ["revision"],
				additionalProperties: false,
			},
		},
	},
});

export function parseCodexReadInput(value: unknown): CodexReadInput | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).length !== 3) return undefined;
	if (typeof value.show_resets !== "boolean") return undefined;
	if (typeof value.show_reset_expiry !== "boolean") return undefined;
	if (
		typeof value.timeout_ms !== "number" ||
		!Number.isSafeInteger(value.timeout_ms) ||
		value.timeout_ms < 1_000 ||
		value.timeout_ms > 30_000
	) return undefined;
	return Object.freeze({
		show_resets: value.show_resets,
		show_reset_expiry: value.show_reset_expiry,
		timeout_ms: value.timeout_ms,
	});
}

export function encodeCodexReply(
	reply: CodexReply,
	credential?: string,
): Readonly<{ encoded: string }> | undefined {
	const normalized = normalizeReply(reply, credential);
	if (!normalized) return undefined;
	const encoded = JSON.stringify(normalized);
	if (encoded.length > 300_000) return undefined;
	return Object.freeze({ encoded });
}

export function decodeCodexReply(value: unknown): CodexReply | undefined {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 1 ||
		typeof value.encoded !== "string" ||
		value.encoded.length > 300_000
	) {
		return undefined;
	}
	try {
		return normalizeReply(JSON.parse(value.encoded) as unknown);
	} catch {
		return undefined;
	}
}

function normalizeReply(value: unknown, credential?: string): CodexReply | undefined {
	if (!isRecord(value) || !isSafeText(value.revision, 128)) return undefined;
	if (value.status === "ok") {
		if (Object.keys(value).length !== 3 || !("snapshot" in value)) return undefined;
		const validation = validateAndCloneUsageSnapshot(value.snapshot, "openai", { credential });
		if (!validation.ok) return undefined;
		return Object.freeze({ status: "ok", revision: value.revision, snapshot: validation.snapshot });
	}
	if (
		value.status !== "missing-auth" &&
		value.status !== "forbidden" &&
		value.status !== "error" &&
		value.status !== "unsupported"
	) return undefined;
	if (typeof value.message !== "string") return undefined;
	if (Object.keys(value).length !== 3) return undefined;
	const message = value.message.split("\n")[0]?.slice(0, 1_024) ?? "";
	if (hasSecretPattern(message) || (credential && message.includes(credential))) return undefined;
	return Object.freeze({ status: value.status, revision: value.revision, message });
}

function isSafeText(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
		!/[\u0000-\u001f\u007f]/.test(value) && !hasSecretPattern(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
