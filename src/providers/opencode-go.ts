import { sanitizeError } from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";
import { providerToView } from "../views/index.js";
import type { ExperimentalUsageLimitsOutput, UsageLimitsMeter } from "@opencode/client";
import {
	defineProvider,
	type ProviderFetchContext,
	type ValidationIssue,
	type ValidationResult,
} from "./contracts.js";
import {
	asRecord,
	createStatusProvider,
	createTimeoutController,
	normalizeEpochMs,
	readNumber,
} from "./shared.js";
import type {
	StandardUsageProvider,
	StandardUsageWindow,
	UsagePeriod,
} from "./types.js";

const ROLLING_WINDOW_MS = 5 * 60 * 60 * 1000;
const statusProvider = createStatusProvider("opencode-go", "OpenCode Go");

type GoWindowKind = "rolling" | "weekly" | "monthly";

export type OpenCodeGoOptions = Readonly<Record<string, never>>;

export const opencodeGoProviderDefinition = defineProvider<OpenCodeGoOptions>({
	metadata: {
		id: "opencode-go",
		displayName: "OpenCode Go",
		catalogOrder: 40,
		officialApi: {
			baseUrls: ["https://opencode.ai"],
			documentationUrl: "https://opencode.ai/docs/go",
			endpoints: [{ method: "GET", path: "/api/experimental/usage/limits" }],
		},
	},
	credentialMode: "none",
	credentialPolicy: {
		allowedSources: [],
		defaultCandidates: [],
	},
	parseOptions: parseEmptyOptions,
	fetchUsage: fetchOpenCodeGoUsage,
	present: providerToView,
	resolveCacheScopeMetadata: () => null,
});

async function fetchOpenCodeGoUsage(
	context: ProviderFetchContext<OpenCodeGoOptions>,
): Promise<StandardUsageProvider> {
	if (context.signal.aborted) return statusProvider("error", "cancelled");
	if (!context.fetchHostUsageLimits)
		return statusProvider("unsupported", "OpenCode host usage API unavailable");

	const controller = createTimeoutController(context.timeoutMs, context.signal);
	try {
		const result = await context.fetchHostUsageLimits(controller.signal);
		if (context.signal.aborted) return statusProvider("error", "cancelled");
		if (controller.signal.aborted) return statusProvider("error", "timeout");
		return normalizeOpenCodeGoUsage(result);
	} catch (error: unknown) {
		const message = context.signal.aborted
			? "cancelled"
			: controller.signal.aborted
				? "timeout"
				: sanitizeError(error);
		return statusProvider("error", message);
	} finally {
		controller.dispose();
	}
}

function parseEmptyOptions(input: unknown): ValidationResult<OpenCodeGoOptions> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return invalidOptions("options", "options must be an object");
	}
	const unknownKey = Object.keys(input)[0];
	return unknownKey
		? invalidOptions(unknownKey, "unknown option")
		: { ok: true, value: Object.freeze({}) };
}

function invalidOptions<T>(path: string, message: string): ValidationResult<T> {
	const issues: readonly ValidationIssue[] = Object.freeze([{ path, message }]);
	return { ok: false, issues };
}

export function normalizeOpenCodeGoUsage(
	raw: ExperimentalUsageLimitsOutput,
	nowMs: number = Date.now(),
): StandardUsageProvider {
	const go = raw.data?.go;
	if (!go)
		return {
			...statusProvider("unsupported", "OpenCode Go usage unavailable"),
			fetchedAt: nowMs,
		};
	const windows = (["rolling", "weekly", "monthly"] as const).flatMap((kind) => {
		const window = normalizeWindow(kind, go[kind]);
		return window ? [window] : [];
	});
	const ready = windows.length === 3;

	return {
		id: "opencode-go",
		displayName: "OpenCode Go",
		status: ready ? "ready" : "partial",
		...(ready ? {} : { statusText: "partial data" }),
		windows,
		fetchedAt: nowMs,
	};
}

function normalizeWindow(
	kind: GoWindowKind,
	raw: UsageLimitsMeter,
): StandardUsageWindow | undefined {
	const percentage = readNumber(raw.percent);
	const resetAt = normalizeEpochMs(raw.resetsAt);
	if (percentage === undefined || percentage < 0 || percentage > 100 || resetAt === undefined)
		return undefined;
	const window = {
		id: `opencode-go-${kind}`,
		label: labelForWindow(kind),
		kind,
		period: periodForWindow(kind),
		usage: { kind: "percent" as const, usedPercent: percentage },
		percentage,
		resetAt,
		...(raw.limited ? { limitReached: true } : {}),
	} satisfies StandardUsageWindow;
	return { ...window, severity: getWindowSeverity(window) };
}

function labelForWindow(kind: GoWindowKind): string {
	if (kind === "rolling") return "5h";
	return kind === "weekly" ? "week" : "month";
}

function periodForWindow(kind: GoWindowKind): UsagePeriod {
	if (kind === "rolling") {
		return { kind: "rolling", durationMs: ROLLING_WINDOW_MS };
	}
	return {
		kind: "calendar",
		unit: kind === "weekly" ? "week" : "billing",
	};
}
