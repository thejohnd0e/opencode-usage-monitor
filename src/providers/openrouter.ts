import { sanitizeCredentialError } from "../sanitize.js";
import { openrouterProviderToView } from "../views/openrouter-view.js";
import {
	defineProvider,
	type ProviderFetchContext,
	type ValidationResult,
} from "./contracts.js";
import {
	asRecord,
	createStatusProvider,
	createTimeoutController,
	readNumber,
	readString,
} from "./shared.js";
import type {
	ProviderDetail,
	StandardUsageProvider,
	StandardUsageWindow,
} from "./types.js";

const KEY_URL = "https://openrouter.ai/api/v1/key";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const statusProvider = createStatusProvider("openrouter", "OpenRouter");

export type OpenrouterOptions = Readonly<Record<string, never>>;

/**
 * OpenRouter publishes a per-key daily/weekly/monthly budget on
 * `GET /api/v1/key` (`effective_budget`), including `resets_at`, so the panel
 * can show a real percentage with a countdown. Request counts are not exposed.
 */
export const openrouterProviderDefinition = defineProvider<OpenrouterOptions>({
	metadata: {
		id: "openrouter",
		displayName: "OpenRouter",
		catalogOrder: 45,
		officialApi: {
			baseUrls: ["https://openrouter.ai"],
			documentationUrl: "https://openrouter.ai/docs/api-reference/get-current-key",
			endpoints: [
				{ method: "GET", path: "/api/v1/key" },
				{ method: "GET", path: "/api/v1/credits" },
			],
		},
	},
	credentialPolicy: {
		allowedSources: ["opencode", "env"],
		defaultCandidates: [
			{ source: "opencode", variant: "openrouter", name: "openrouter" },
			{ source: "env", variant: "openrouter", name: "OPENROUTER_API_KEY" },
		],
	},
	parseOptions: parseEmptyOptions,
	fetchUsage: fetchOpenrouterUsage,
	present: openrouterProviderToView,
	resolveCacheScopeMetadata: () => null,
});

export async function fetchOpenrouterUsage(
	context: ProviderFetchContext<OpenrouterOptions>,
): Promise<StandardUsageProvider> {
	if (context.signal.aborted) return statusProvider("error", "cancelled");
	const controller = createTimeoutController(context.timeoutMs, context.signal);
	const headers = {
		Authorization: `Bearer ${context.credential.secret}`,
		Accept: "application/json",
	};
	try {
		const response = await fetch(KEY_URL, {
			headers,
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403)
			return statusProvider("forbidden", "forbidden");
		if (!response.ok) return statusProvider("error", `api ${response.status}`);
		const key = await response.json();
		const credits = await fetchOpenrouterCredits(headers, controller.signal);
		return normalizeOpenrouterUsage({ key, credits });
	} catch (error) {
		const message = context.signal.aborted
			? "cancelled"
			: controller.signal.aborted
				? "timeout"
				: sanitizeCredentialError(error, context.credential.secret);
		return statusProvider("error", message);
	} finally {
		controller.dispose();
	}
}

async function fetchOpenrouterCredits(
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<unknown> {
	try {
		const response = await fetch(CREDITS_URL, { headers, signal });
		return response.ok ? await response.json() : undefined;
	} catch {
		return undefined;
	}
}

export type OpenrouterUsageInput = Readonly<{
	key: unknown;
	credits?: unknown;
}>;

export function normalizeOpenrouterUsage(
	input: OpenrouterUsageInput,
	nowMs: number = Date.now(),
): StandardUsageProvider {
	const key = asRecord(asRecord(asRecord(input)?.key)?.data) ?? {};
	const budget =
		asRecord(key.effective_budget) ??
		asRecord(Array.isArray(key.budgets) ? key.budgets[0] : undefined) ??
		{};
	const limit = readNumber(budget.limit_usd) ?? readNumber(key.limit);
	const spend = readNumber(budget.spend_usd) ?? readNumber(key.usage);
	const interval = readString(budget.reset_interval) ?? readString(key.limit_reset);
	const resetAt = parseIsoMs(budget.resets_at);
	const windows =
		limit !== undefined && limit > 0 && spend !== undefined
			? [openrouterWindow(openrouterWindowLabel(interval), limit, spend, resetAt)]
			: [];
	const details = openrouterDetails(
		spend,
		asRecord(asRecord(asRecord(input)?.credits)?.data),
	);
	if (windows.length === 0 && details.length === 0) {
		return {
			id: "openrouter",
			displayName: "OpenRouter",
			status: "partial",
			statusText: "no usage data",
			windows: [],
			fetchedAt: nowMs,
		};
	}
	return {
		id: "openrouter",
		displayName: "OpenRouter",
		status: "ready",
		windows,
		details,
		fetchedAt: nowMs,
	};
}

function openrouterWindowLabel(interval: string | undefined): "day" | "week" | "month" {
	if (interval === "weekly") return "week";
	if (interval === "monthly") return "month";
	return "day";
}

function openrouterWindow(
	label: "day" | "week" | "month",
	limit: number,
	spend: number,
	resetAt: number | undefined,
): StandardUsageWindow {
	const percentage = Math.min(100, Math.round((spend / limit) * 100));
	return {
		id: `openrouter-${label}`,
		label,
		kind: "rolling",
		period: { kind: "calendar", unit: label },
		usage: { kind: "percent", usedPercent: percentage },
		percentage,
		...(resetAt === undefined ? {} : { resetAt }),
		...(percentage >= 100 ? { limitReached: true } : {}),
		severity:
			percentage >= 100 ? "critical" : percentage >= 75 ? "warning" : "normal",
	};
}

function openrouterDetails(
	spend: number | undefined,
	credits: Record<string, unknown> | null,
): ProviderDetail[] {
	const details: ProviderDetail[] = [];
	if (spend !== undefined) {
		details.push({
			key: "spent",
			label: "spent",
			value: { kind: "currency", value: spend, currency: "USD" },
			visibility: "summary",
			priority: 90,
		});
	}
	const remaining = openrouterCreditsRemaining(credits);
	if (remaining !== undefined) {
		details.push({
			key: "credits",
			label: "credits",
			value: { kind: "currency", value: remaining, currency: "USD" },
			visibility: "summary",
			priority: 85,
		});
	}
	return details;
}

function openrouterCreditsRemaining(
	credits: Record<string, unknown> | null,
): number | undefined {
	if (!credits) return undefined;
	const total = readNumber(credits.total_credits);
	const used = readNumber(credits.total_usage) ?? 0;
	if (total === undefined) return undefined;
	return Math.round((total - used) * 100) / 100;
}

function parseIsoMs(value: unknown): number | undefined {
	const text = readString(value);
	if (text === undefined) return undefined;
	const ms = Date.parse(text);
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function parseEmptyOptions(input: unknown): ValidationResult<OpenrouterOptions> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return invalidOptions("options", "options must be an object");
	}
	const unknownKey = Object.keys(input)[0];
	if (unknownKey !== undefined)
		return invalidOptions(unknownKey, "unknown option");
	return { ok: true, value: Object.freeze({}) };
}

function invalidOptions(path: string, message: string): ValidationResult<never> {
	return { ok: false, issues: Object.freeze([{ path, message }]) };
}
