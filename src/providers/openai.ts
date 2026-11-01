import { discoverOpenAICredential } from "../auth.js";
import { fetchCodexSnapshot, normalizeWhamUsage } from "../codex-fetch.js";
import { sanitizeCredentialError } from "../sanitize.js";
import { openAIProviderToView } from "../views/openai-view.js";
import {
	defineProvider,
	LegacyAdapterFacade,
	type LegacyProviderBridge,
	type ProviderFetchContext,
	type ValidationIssue,
	type ValidationResult,
} from "./contracts.js";
import { createStatusProvider, createTimeoutController } from "./shared.js";
import type {
	ProviderContext,
	StandardUsageProvider,
	UsageProviderAdapter,
} from "./types.js";

const statusProvider = createStatusProvider("openai", "openai");
type OpenAIUsageReader = () => Promise<StandardUsageProvider>;
let openAIUsageReader: OpenAIUsageReader | undefined;

export type OpenAIOptions = Readonly<{
	show_resets: boolean;
	show_reset_expiry: boolean;
}>;

export { normalizeWhamUsage };

export function setOpenAIUsageReader(
	reader: OpenAIUsageReader | undefined,
): void {
	openAIUsageReader = reader;
}

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
		allowedSources: ["opencode"],
		defaultCandidates: [
			{ source: "opencode", variant: "openai", name: "openai" },
		],
	},
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
	if (context.credential.source !== "opencode") {
		return statusProvider("error", "invalid credential source");
	}
	if (context.credential.variant !== "openai") {
		return statusProvider("error", "invalid credential variant");
	}
	if (openAIUsageReader) {
		try {
			return await openAIUsageReader();
		} catch {
			return statusProvider("error", "Codex statistics temporarily unavailable");
		}
	}
	const accountId = context.credential.metadata?.accountId;
	const type = context.credential.metadata?.type;
	const expires = Number(context.credential.metadata?.expires);
	if (type !== "oauth") return statusProvider("missing-auth", "oauth missing");
	if (!Number.isFinite(expires) || expires <= Date.now()) {
		return statusProvider("missing-auth", "oauth expired");
	}
	if (!accountId) return statusProvider("missing-auth", "account id missing");

	const controller = createTimeoutController(context.timeoutMs, context.signal);
	try {
		const result = await fetchCodexSnapshot(
			{
				connectionID: "active-openai",
				accountID: accountId,
				access: context.credential.secret,
				expires,
			},
			context.options,
			controller.signal,
		);
		if (context.signal.aborted) return statusProvider("error", "cancelled");
		if (controller.signal.aborted) return statusProvider("error", "timeout");
		return result;
	} catch (error: unknown) {
		return statusProvider(
			"error",
			sanitizeCredentialError(error, context.credential.secret),
		);
	} finally {
		controller.dispose();
	}
}

function resolveLegacyOpenAIContext(
	context: ProviderContext,
	signal: AbortSignal,
) {
	const credential = discoverOpenAICredential(context.auth, context.env);
	if (!("token" in credential))
		return {
			ok: false as const,
			status: "missing-auth" as const,
			message: credential.message,
		};
	return {
		ok: true as const,
		options: { show_resets: true, show_reset_expiry: false },
		fetchContext: {
			credential: {
				secret: credential.token,
				source: "opencode" as const,
				variant: "openai",
				epoch: 0,
				metadata: {
					accountId: credential.accountId,
					type: "oauth",
					expires: String(credential.expires),
				},
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
