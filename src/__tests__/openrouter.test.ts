/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import { CONFIG_DEFAULTS } from "../config.js";
import { formatProviderMetrics } from "../format.js";
import {
	fetchOpenrouterUsage,
	normalizeOpenrouterUsage,
	openrouterProviderDefinition,
} from "../providers/openrouter.js";
import { validateAndCloneUsageSnapshot } from "../snapshot-validation.js";
import { providerToView } from "../views/index.js";
import {
	captureRequest,
	mockJsonResponse,
	nowMs,
	restoreFetch,
	TEST_WIDTH,
} from "./_helpers.js";

afterEach(() => {
	restoreFetch();
});

const RESET_ISO = "2026-11-01T00:00:00.000Z";

function keyResponse(overrides: Record<string, unknown> = {}) {
	return {
		data: {
			label: "sk-or-v1-8c6...f48",
			limit: 50,
			limit_reset: "daily",
			limit_remaining: 37.5,
			usage: 12.5,
			effective_budget: {
				scope: "key_limit",
				limit_usd: 50,
				spend_usd: 12.5,
				remaining_usd: 37.5,
				reset_interval: "daily",
				resets_at: RESET_ISO,
			},
			...overrides,
		},
	};
}

const credential = {
	secret: "sk-or-test",
	source: "env" as const,
	variant: "openrouter",
	epoch: 1,
};

function callFetch() {
	const controller = new AbortController();
	return fetchOpenrouterUsage({
		credential,
		options: {},
		signal: controller.signal,
		timeoutMs: 1000,
	});
}

describe("openrouter provider", () => {
	test("daily budget becomes a day window with percent and reset time", () => {
		const snapshot = normalizeOpenrouterUsage({ key: keyResponse() }, 1_000);
		expect(snapshot.id).toBe("openrouter");
		expect(snapshot.displayName).toBe("OpenRouter");
		expect(snapshot.status).toBe("ready");
		expect(snapshot.fetchedAt).toBe(1_000);
		expect(snapshot.windows).toHaveLength(1);
		expect(snapshot.windows[0]).toMatchObject({
			label: "day",
			percentage: 25,
			usage: { kind: "percent", usedPercent: 25 },
			resetAt: Date.parse(RESET_ISO),
			severity: "normal",
		});
	});

	test("spent and credits are shown as USD details", () => {
		const snapshot = normalizeOpenrouterUsage(
			{ key: keyResponse(), credits: { data: { total_credits: 5, total_usage: 1.25 } } },
			1_000,
		);
		expect(snapshot.details?.[0]).toMatchObject({
			key: "spent",
			value: { kind: "currency", value: 12.5, currency: "USD" },
			visibility: "summary",
		});
		expect(snapshot.details?.[1]).toMatchObject({
			key: "credits",
			value: { kind: "currency", value: 3.75, currency: "USD" },
		});
	});

	test("a key without a budget keeps the money rows and drops the window", () => {
		const snapshot = normalizeOpenrouterUsage(
			{ key: { data: { label: "sk-or", limit: null, limit_remaining: null, usage: 4.2 } } },
			1_000,
		);
		expect(snapshot.status).toBe("ready");
		expect(snapshot.windows).toEqual([]);
		expect(snapshot.details?.[0]).toMatchObject({ key: "spent", value: { value: 4.2, currency: "USD" } });
		expect(snapshot.details?.some((detail) => detail.key === "credits")).toBe(false);
	});

	test("weekly and monthly budgets keep their own reset labels", () => {
		const budget = (interval: string) => ({
			key: keyResponse({ effective_budget: { limit_usd: 10, spend_usd: 1, reset_interval: interval, resets_at: RESET_ISO } }),
		});
		expect(normalizeOpenrouterUsage(budget("weekly"), 1_000).windows[0]?.label).toBe("week");
		expect(normalizeOpenrouterUsage(budget("monthly"), 1_000).windows[0]?.label).toBe("month");
	});

	test("overspending is critical and a missing resets_at leaves no countdown", () => {
		const snapshot = normalizeOpenrouterUsage(
			{ key: keyResponse({ effective_budget: { limit_usd: 10, spend_usd: 12, reset_interval: "daily" } }) },
			1_000,
		);
		expect(snapshot.windows[0]).toMatchObject({ percentage: 100, severity: "critical" });
		expect(snapshot.windows[0]?.resetAt).toBeUndefined();
		expect(snapshot.windows[0]?.limitReached).toBe(true);
	});

	test("an empty payload is partial, not ready", () => {
		const snapshot = normalizeOpenrouterUsage({ key: { data: {} } }, 1_000);
		expect(snapshot.status).toBe("partial");
		expect(snapshot.windows).toEqual([]);
	});

	test("the snapshot passes the runtime validator", () => {
		const validated = validateAndCloneUsageSnapshot(
			normalizeOpenrouterUsage({ key: keyResponse() }, 1_000),
			"openrouter",
		);
		expect(validated.ok).toBe(true);
		if (!validated.ok) return;
		expect(validated.snapshot.windows?.[0]?.label).toBe("day");
	});

	test("fetches both endpoints with the bearer token and stays ready", async () => {
		const urls: string[] = [];
		const auth: string[] = [];
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
			const headers = new Headers(init?.headers ?? {});
			auth.push(headers.get("authorization") ?? "");
			const body = (urls.at(-1) ?? "").endsWith("/credits")
				? { data: { total_credits: 5, total_usage: 1.25 } }
				: keyResponse();
			return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
		}) as unknown as typeof fetch;

		const provider = await callFetch();
		expect(provider.status).toBe("ready");
		expect(urls).toEqual([
			"https://openrouter.ai/api/v1/key",
			"https://openrouter.ai/api/v1/credits",
		]);
		expect(auth).toEqual(["Bearer sk-or-test", "Bearer sk-or-test"]);
		expect(provider.details?.[1]).toMatchObject({ key: "credits", value: { value: 3.75 } });
	});

	test("maps 401 and 403 to forbidden without leaking the token", async () => {
		for (const status of [401, 403]) {
			mockJsonResponse({ error: "nope" }, status);
			const provider = await callFetch();
			expect(provider.status).toBe("forbidden");
			expect(JSON.stringify(provider)).not.toContain("sk-or-test");
		}
	});

	test("declares its catalog metadata and credential candidates", () => {
		expect(openrouterProviderDefinition.metadata.id).toBe("openrouter");
		expect(openrouterProviderDefinition.metadata.catalogOrder).toBe(45);
		expect(openrouterProviderDefinition.credentialPolicy.defaultCandidates).toEqual([
			{ source: "opencode", variant: "openrouter", name: "openrouter" },
			{ source: "env", variant: "openrouter", name: "OPENROUTER_API_KEY" },
		]);
	});
});

	describe("openrouter rendering", () => {
	const render = (spend: number, resetInMs: number, interval = "daily", width = TEST_WIDTH) => {
		const now = nowMs();
		const provider = normalizeOpenrouterUsage(
			{
				key: keyResponse({
						effective_budget: { limit_usd: 50, spend_usd: spend, reset_interval: interval, resets_at: new Date(now + resetInMs).toISOString() },
				}),
			},
			now,
		);
		return formatProviderMetrics(providerToView(provider), CONFIG_DEFAULTS, width)
			.map((line) => [line.text, line.suffix].filter(Boolean).join("  "))
			.join("\n");
	};

	test("renders the budget row with a minute countdown", () => {
		const text = render(5, 5 * 86_400_000 + 18 * 3_600_000 + 13 * 60_000);
		expect(text).toContain("day");
		expect(text).toContain("10%");
		expect(text).toContain("reset 5d 18h 13m");
		expect(text).toContain("spent");
	});

	test("drops the smallest unit instead of cutting a number when the row is too narrow", () => {
		const text = render(50, 5 * 86_400_000 + 18 * 3_600_000 + 13 * 60_000, "weekly", 30);
		expect(text).toContain("week");
		expect(text).toContain("100%");
		expect(text).toContain("reset 5d 18h\n");
		expect(text).not.toContain("reset 5d 18h 1");
	});
});
