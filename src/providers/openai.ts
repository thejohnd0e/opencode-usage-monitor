import { normalizeWhamUsage } from "../codex-fetch.js";
import { openAIProviderToView } from "../views/openai-view.js";
import {
	defineProvider,
	LegacyAdapterFacade,
	type LegacyProviderBridge,
	type ProviderFetchContext,
	type ValidationIssue,
	type ValidationResult,
} from "./contracts.js";
import { createStatusProvider } from "./shared.js";
import type {
	ProviderContext,
	StandardUsageProvider,
	UsageProviderAdapter,
} from "./types.js";

const statusProvider = createStatusProvider("openai", "openai");

export type OpenAIOptions = Readonly<{
	show_resets: boolean;
	show_reset_expiry: boolean;
}>;

export { normalizeWhamUsage };

export const openaiProviderDefinition = defineProvider<OpenAIOptions>({
	metadata: {
		id: "openai",
		displayName: "openai",
		catalogOrder: 10,
		officialApi: {
			baseUrls: ["https://chatgpt.com"],
			documentationUrl:
				"https://github.com/chopratejas/headroom/blob/master/headroom/subscription/codex_rate_limits.py",
			endpoints: [
				{ method: "GET", path: "/backend-api/wham/usage" },
				{ method: "GET", path: "/backend-api/wham/rate-limit-reset-credits" },
			],
		},
	},
	credentialPolicy: {
		allowedSources: [],
		defaultCandidates: [],
	},
	credentialMode: "none",
	parseOptions: parseOpenAIOptions,
	fetchUsage: fetchOpenAIUsage,
	present: openAIProviderToView,
	resolveCacheScopeMetadata: () => null,
});

const openaiLegacyBridge: LegacyProviderBridge = {
	configKey: "show_openai",
	isAvailable: () => true,
	resolve: resolveLegacyOpenAIContext,
};

export const openAIUsageAdapter: UsageProviderAdapter = new LegacyAdapterFacade(
	openaiProviderDefinition.registration,
	openaiLegacyBridge,
);

async function fetchOpenAIUsage(
	context: ProviderFetchContext<OpenAIOptions>,
): Promise<StandardUsageProvider> {
	if (context.signal.aborted) return statusProvider("error", "cancelled");
	if (!context.fetchCodexUsage) return statusProvider("unsupported", "Codex host RPC unavailable");
	try {
		const reply = await context.fetchCodexUsage({
			show_resets: context.options.show_resets,
			show_reset_expiry: context.options.show_reset_expiry,
			timeout_ms: Math.min(30_000, Math.max(1_000, context.timeoutMs)),
		}, context.signal);
		if (context.signal.aborted) return statusProvider("error", "cancelled");
		if (reply.status === "ok") return reply.snapshot;
		return statusProvider(reply.status, reply.message);
	} catch {
		return statusProvider("error", "Codex host RPC unavailable");
	}
}

function resolveLegacyOpenAIContext(
	context: ProviderContext,
	signal: AbortSignal,
) {
	return {
		ok: true as const,
		options: { show_resets: true, show_reset_expiry: false },
		fetchContext: {
			credential: {
				secret: "",
				source: "opencode" as const,
				variant: "host-usage",
				epoch: 0,
			},
			signal,
			timeoutMs: context.timeoutMs,
		},
	};
}

function parseOpenAIOptions(input: unknown): ValidationResult<OpenAIOptions> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return invalidOptions("options", "options must be an object");
	}
	const options = input as Record<string, unknown>;
	const allowedKeys = new Set(["show_resets", "show_reset_expiry"]);
	const unknownKey = Object.keys(options).find((key) => !allowedKeys.has(key));
	if (unknownKey) return invalidOptions(unknownKey, "unknown option");
	if (options.show_resets !== undefined && typeof options.show_resets !== "boolean") {
		return invalidOptions("show_resets", "must be a boolean");
	}
	if (
		options.show_reset_expiry !== undefined &&
		typeof options.show_reset_expiry !== "boolean"
	) {
		return invalidOptions("show_reset_expiry", "must be a boolean");
	}
	return {
		ok: true,
		value: Object.freeze({
			show_resets: options.show_resets ?? true,
			show_reset_expiry: options.show_reset_expiry ?? false,
		}),
	};
}

function invalidOptions<T>(path: string, message: string): ValidationResult<T> {
	const issues: readonly ValidationIssue[] = Object.freeze([{ path, message }]);
	return { ok: false, issues };
}
