import { hasSecretPattern, sanitizeCredentialError } from "./sanitize.js";
import { getWindowSeverity } from "./severity.js";
import { validateAndCloneUsageSnapshot } from "./snapshot-validation.js";
import type { CodexAccount } from "./codex-account.js";
import {
	asRecord,
	createStatusProvider,
	normalizeEpochMs,
	readNumber,
	readString,
	slug,
} from "./providers/shared.js";
import type { OpenAIOptions } from "./providers/openai.js";
import type {
	StandardUsageProvider,
	StandardUsageWindow,
} from "./providers/types.js";

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_RESET_CREDITS_URL =
	"https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const MAX_RESET_CREDITS = 100;
const MAX_RESET_TITLE_LENGTH = 200;
const MAX_RESET_COUNT = 1_000_000;
const statusProvider = createStatusProvider("openai", "openai");

type RateWindow = {
	usedPercent?: number;
	limitWindowSeconds?: number;
	resetAfterSeconds?: number;
	resetAt?: number;
};

type ResetCredit = Readonly<{
	title: string;
	expiresAt?: number;
}>;

type ParsedWhamUsage = {
	plan?: string;
	primary?: RateWindow;
	secondary?: RateWindow;
	limitReached?: boolean;
	additionalLimits: Array<{ label: string; limitReached: boolean }>;
	availableResetCount?: number;
	properties: Record<string, unknown>;
};

export async function fetchCodexSnapshot(
	account: CodexAccount,
	options: OpenAIOptions,
	signal: AbortSignal,
): Promise<StandardUsageProvider> {
	if (signal.aborted) return abortStatus(signal);
	if (
		!account.access ||
		!account.accountID ||
		!Number.isFinite(account.expires) ||
		account.expires <= Date.now()
	) {
		return statusProvider("missing-auth", "oauth missing or expired");
	}

	try {
		const response = await fetch(OPENAI_USAGE_URL, {
			headers: createOpenAIHeaders(account.access, account.accountID),
			signal,
		});
		if (response.status === 401 || response.status === 403) {
			return statusProvider("forbidden", "forbidden");
		}
		if (!response.ok) return statusProvider("error", `api ${response.status}`);

		const raw: unknown = await response.json();
		const parsed = parseWhamUsage(raw);
		const nowMs = Date.now();
		if (!hasSupportedWindows(parsed)) {
			return statusProvider("error", "Codex usage contains no supported windows");
		}

		let credits: readonly ResetCredit[] = [];
		if (
			options.show_resets &&
			options.show_reset_expiry &&
			(parsed.availableResetCount ?? 0) > 0
		) {
			credits = await fetchAvailableResetCredits(
				account.access,
				account.accountID,
				signal,
				nowMs,
			);
		}

		const nearestExpiry = credits.find((credit) => credit.expiresAt !== undefined)
			?.expiresAt;
		const snapshot = normalizeParsedWhamUsage(
			parsed,
			nowMs,
			nearestExpiry,
			options.show_resets,
		);
		if (options.show_resets && options.show_reset_expiry) {
			snapshot.details = [
				...(snapshot.details ?? []),
				...resetCreditDetails(credits),
			];
		}

		const validation = validateAndCloneUsageSnapshot(snapshot, "openai", {
			credential: account.access,
		});
		if (!validation.ok) {
			return statusProvider(
				"error",
				validation.reason === "credential"
					? "Codex response contained credential data"
					: "Codex response was invalid",
			);
		}
		return validation.snapshot;
	} catch (error: unknown) {
		if (signal.aborted) return abortStatus(signal);
		return statusProvider(
			"error",
			sanitizeCredentialError(error, account.access),
		);
	}
}

export function normalizeWhamUsage(
	raw: unknown,
	nowMs: number = Date.now(),
	nearestResetExpiryMs?: number,
	showResets = true,
): StandardUsageProvider {
	return normalizeParsedWhamUsage(
		parseWhamUsage(raw),
		nowMs,
		nearestResetExpiryMs,
		showResets,
	);
}

async function fetchAvailableResetCredits(
	access: string,
	accountID: string,
	signal: AbortSignal,
	nowMs: number,
): Promise<readonly ResetCredit[]> {
	try {
		const response = await fetch(OPENAI_RESET_CREDITS_URL, {
			headers: createOpenAIHeaders(access, accountID),
			signal,
		});
		if (!response.ok) return [];
		return parseResetCredits(await response.json(), nowMs);
	} catch (error: unknown) {
		if (signal.aborted) throw error;
		return [];
	}
}

function parseResetCredits(raw: unknown, nowMs: number): readonly ResetCredit[] {
	const entries = asRecord(raw)?.credits;
	if (!Array.isArray(entries)) return [];
	return entries
		.slice(0, MAX_RESET_CREDITS * 4)
		.flatMap((entry): ResetCredit[] => {
			const record = asRecord(entry);
			if (!record || record.status !== "available") return [];
			const expiresAt = parseExpiry(record.expires_at);
			if (expiresAt === undefined || expiresAt <= nowMs) return [];
			const sourceTitle = readString(record.title)?.trim();
			const cleanTitle = sourceTitle
				?.replace(/[\u0000-\u001f\u007f]/g, " ")
				.trim()
				.slice(0, MAX_RESET_TITLE_LENGTH);
			return [{
				title:
					cleanTitle && !hasSecretPattern(cleanTitle)
						? cleanTitle
						: "Reset credit",
				...(expiresAt !== undefined ? { expiresAt } : {}),
			}];
		})
		.sort((left, right) => (left.expiresAt ?? Infinity) - (right.expiresAt ?? Infinity))
		.slice(0, MAX_RESET_CREDITS);
}

function resetCreditDetails(credits: readonly ResetCredit[]) {
	return credits.flatMap((credit, index) => {
		const expiry = credit.expiresAt === undefined
			? "Expiry unavailable"
			: formatResetExpiry(credit.expiresAt);
		return [
			{
				key: `reset-credit-${index}-title`,
				label: "reset",
				value: { kind: "text" as const, value: `  • ${credit.title}` },
				visibility: "summary" as const,
				priority: 94,
				tone: "normal" as const,
			},
			{
				key: `reset-credit-${index}-expiry`,
				label: "until",
				value: { kind: "text" as const, value: `    ${expiry}` },
				visibility: "summary" as const,
				priority: 93,
				tone: "muted" as const,
			},
		];
	});
}

function formatResetExpiry(expiresAt: number): string {
	const date = new Date(expiresAt);
	if (!Number.isFinite(date.getTime())) return "Expiry unavailable";
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: true,
	}).format(date);
}

function createOpenAIHeaders(
	access: string,
	accountID: string,
): Record<string, string> {
	return {
		Authorization: `Bearer ${access}`,
		"ChatGPT-Account-Id": accountID,
		Accept: "application/json",
		Origin: "https://chatgpt.com",
		Referer: "https://chatgpt.com/",
	};
}

function normalizeParsedWhamUsage(
	parsed: ParsedWhamUsage,
	nowMs: number,
	nearestResetExpiryMs: number | undefined,
	showResets: boolean,
): StandardUsageProvider {
	const windows = [
		parsed.primary
			? rateWindowToStandard(
					"openai-primary",
					"rolling",
					parsed.primary,
					parsed.limitReached ?? false,
					nowMs,
				)
			: undefined,
		parsed.secondary
			? rateWindowToStandard(
					"openai-secondary",
					"weekly",
					parsed.secondary,
					false,
					nowMs,
				)
			: undefined,
	].filter((window): window is StandardUsageWindow => window !== undefined);
	const alerts = parsed.additionalLimits
		.filter((limit) => limit.limitReached)
		.map((limit) => ({
			id: `${slug(limit.label)}-limit`,
			label: `${limit.label} LIMIT`,
			severity: "critical" as const,
		}));

	const status = windows.length > 0 ? "ready" : "partial";
	const details = whamDetails(
		parsed,
		nowMs,
		nearestResetExpiryMs,
		showResets,
	);
	return {
		id: "openai",
		displayName: "openai",
		status,
		...(status === "partial" ? { statusText: "partial data" } : {}),
		...(parsed.plan ? { plan: parsed.plan } : {}),
		windows,
		details,
		...(alerts.length > 0 ? { alerts } : {}),
		fetchedAt: nowMs,
	};
}

function parseWhamUsage(raw: unknown): ParsedWhamUsage {
	const data = asRecord(raw) ?? {};
	const rateLimit = asRecord(data.rate_limit) ?? {};
	return {
		plan: readString(data.plan_type),
		primary: parseRateWindow(rateLimit.primary_window),
		secondary: parseRateWindow(rateLimit.secondary_window),
		limitReached: rateLimit.limit_reached === true,
		additionalLimits: parseAdditionalLimits(data.additional_rate_limits),
		properties: collectWhamProperties(data),
		availableResetCount: parseAvailableResetCount(
			data.rate_limit_reset_credits,
		),
	};
}

function parseRateWindow(raw: unknown): RateWindow | undefined {
	const data = asRecord(raw);
	if (!data) return undefined;
	return {
		usedPercent: readNumber(data.used_percent),
		limitWindowSeconds: readNumber(data.limit_window_seconds),
		resetAfterSeconds: readNumber(data.reset_after_seconds),
		resetAt: readNumber(data.reset_at),
	};
}

function rateWindowToStandard(
	id: string,
	kind: StandardUsageWindow["kind"],
	window: RateWindow,
	limitReached: boolean,
	nowMs: number,
): StandardUsageWindow | undefined {
	const percentage = window.usedPercent;
	const resetAt =
		normalizeEpochMs(window.resetAt) ??
		resetAfterToEpochMs(window.resetAfterSeconds, nowMs);
	if (
		percentage === undefined ||
		percentage < 0 ||
		percentage > 100
	) return undefined;
	const standard = {
		id,
		label:
			kind === "weekly" ? "week" : secondsToLabel(window.limitWindowSeconds),
		kind,
		period: window.limitWindowSeconds !== undefined
			? { kind: "rolling" as const, durationMs: window.limitWindowSeconds * 1000 }
			: { kind: "unknown" as const },
		usage: { kind: "percent" as const, usedPercent: percentage },
		percentage,
		...(resetAt !== undefined ? { resetAt } : {}),
		...(limitReached ? { limitReached: true } : {}),
	} satisfies StandardUsageWindow;
	return { ...standard, severity: getWindowSeverity(standard) };
}

function whamDetails(
	parsed: ParsedWhamUsage,
	nowMs: number,
	nearestResetExpiryMs: number | undefined,
	showResets: boolean,
) {
	const details = [
		parsed.plan
			? { key: "plan", label: "plan", value: { kind: "text" as const, value: parsed.plan }, visibility: "detail" as const, priority: 100 }
			: undefined,
	showResets
			? resetDetail(parsed.availableResetCount, nearestResetExpiryMs, nowMs)
			: undefined,
		stringDetail("credits-balance", "credits balance", parsed.properties.creditsBalance, 90),
		booleanDetail("credits-has", "has credits", parsed.properties.creditsHas ?? parsed.properties.creditsHas_credits, 80),
		booleanDetail("credits-unlimited", "unlimited credits", parsed.properties.creditsUnlimited, 70),
		numberDetail("spend-limit", "spend limit", parsed.properties.spendControlIndividualLimit ?? parsed.properties.spendControlIndividual_limit, 60),
		arrayDetail("approx-local", "approx local", parsed.properties.creditsApproxLocalMessages ?? parsed.properties.creditsApprox_local_messages, 40),
	];
	return details.filter((detail): detail is NonNullable<typeof detail> => detail !== undefined);
}

function resetDetail(
	availableCount: number | undefined,
	nearestExpiryMs: number | undefined,
	nowMs: number,
) {
	if (availableCount === undefined) return undefined;
	const remainingExpiryMs =
		nearestExpiryMs === undefined ? undefined : nearestExpiryMs - nowMs;
	const expiresInDays =
		remainingExpiryMs === undefined
			? undefined
			: Math.max(0, Math.ceil(remainingExpiryMs / 86_400_000));
	return {
		key: "resets",
		label: "resets",
		value: {
			kind: "text" as const,
			value: `${availableCount}${expiresInDays === undefined ? "" : ` · expires ${expiresInDays}d`}`,
		},
		visibility: "summary" as const,
		priority: 95,
		...(remainingExpiryMs === undefined
			? {}
			: { tone: resetExpiryTone(remainingExpiryMs) }),
	};
}

function resetExpiryTone(remainingMs: number): "normal" | "warn" | "bad" {
	if (remainingMs <= 2 * 3_600_000) return "bad";
	if (remainingMs <= 24 * 3_600_000) return "warn";
	return "normal";
}

function stringDetail(key: string, label: string, value: unknown, priority: number) {
	return typeof value === "string" && value.length > 0
		? { key, label, value: { kind: "text" as const, value }, visibility: "detail" as const, priority }
		: undefined;
}

function booleanDetail(key: string, label: string, value: unknown, priority: number) {
	return typeof value === "boolean"
		? { key, label, value: { kind: "flag" as const, value }, visibility: "detail" as const, priority }
		: undefined;
}

function numberDetail(key: string, label: string, value: unknown, priority: number) {
	return typeof value === "number" && Number.isFinite(value)
		? { key, label, value: { kind: "number" as const, value }, visibility: "debug" as const, priority }
		: undefined;
}

function arrayDetail(key: string, label: string, value: unknown, priority: number) {
	return Array.isArray(value)
		? { key, label, value: { kind: "text" as const, value: `items[${value.length}]` }, visibility: "debug" as const, priority }
		: undefined;
}

function collectWhamProperties(
	data: Record<string, unknown>,
): Record<string, unknown> {
	const credits = asRecord(data.credits);
	const spendControl = asRecord(data.spend_control);
	return {
		...flattenObject("credits", credits),
		...flattenObject("spendControl", spendControl),
	};
}

function parseAvailableResetCount(raw: unknown): number | undefined {
	const availableCount = readNumber(asRecord(raw)?.available_count);
	return availableCount !== undefined &&
		Number.isSafeInteger(availableCount) &&
		availableCount >= 0 &&
		availableCount <= MAX_RESET_COUNT
		? availableCount
		: undefined;
}

function parseExpiry(value: unknown): number | undefined {
	const epochMs = typeof value === "number"
		? normalizeEpochMs(value)
		: typeof value === "string"
			? Date.parse(value)
			: undefined;
	return epochMs !== undefined && Number.isFinite(epochMs) && epochMs > 0
		? epochMs
		: undefined;
}

function parseAdditionalLimits(
	raw: unknown,
): Array<{ label: string; limitReached: boolean }> {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry) => {
		const data = asRecord(entry);
		if (!data) return [];
		const rateLimit = asRecord(data.rate_limit);
		const label =
			readString(data.metered_feature) ??
			readString(data.limit_name) ??
			"limit";
		return [{ label: label.slice(0, 128), limitReached: rateLimit?.limit_reached === true }];
	});
}

function flattenObject(
	prefix: string,
	value: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
	if (!value) return {};
	return Object.fromEntries(
		Object.entries(value).map(([key, val]) => [
			`${prefix}${capitalize(key)}`,
			val,
		]),
	);
}

function secondsToLabel(seconds: number | undefined): string {
	if (seconds === undefined || seconds <= 0) return "rolling";
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function resetAfterToEpochMs(
	seconds: number | undefined,
	nowMs: number,
): number | undefined {
	return seconds === undefined ? undefined : nowMs + seconds * 1000;
}

function hasSupportedWindows(parsed: ParsedWhamUsage): boolean {
	return [parsed.primary, parsed.secondary].some(
		(window) =>
			window?.usedPercent !== undefined &&
			window.usedPercent >= 0 &&
			window.usedPercent <= 100,
	);
}

function abortStatus(signal: AbortSignal): StandardUsageProvider {
	const reason = signal.reason;
	return statusProvider(
		"error",
		reason instanceof DOMException && reason.name === "TimeoutError"
			? "timeout"
			: "cancelled",
	);
}

function capitalize(value: string): string {
	return value.length === 0
		? value
		: `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
