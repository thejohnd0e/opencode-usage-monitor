/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { ExperimentalUsageLimitsOutput } from "@opencode/client";

import {
	normalizeOpenCodeGoUsage,
	opencodeGoProviderDefinition,
} from "../providers/opencode-go.js";
import { providerToView } from "../views/index.js";

const NOW_MS = Date.parse("2026-09-03T00:00:00.000Z");
const HOST_USAGE_FIXTURE: ExperimentalUsageLimitsOutput = {
	location: { directory: "/fixture" },
	data: {
		workspace: { id: "workspace-1", usageURL: "https://opencode.ai/usage" },
		go: {
			rolling: { percent: 0, limited: false, resetsAt: NOW_MS + 60_000 },
			weekly: { percent: 0, limited: false, resetsAt: NOW_MS + 86_400_000 },
			monthly: { percent: 6, limited: false, resetsAt: NOW_MS + 2_592_000_000 },
		},
		budgets: [],
	},
};

describe("OpenCode Go provider", () => {
	test("normalizes typed host limits into the existing three windows", () => {
		const provider = normalizeOpenCodeGoUsage(HOST_USAGE_FIXTURE, NOW_MS);

		expect(provider).toMatchObject({ status: "ready", fetchedAt: NOW_MS });
		expect(provider.windows.map((window) => ({
			label: window.label,
			percentage: window.percentage,
			resetAt: window.resetAt,
			limitReached: window.limitReached,
		}))).toEqual([
			{ label: "5h", percentage: 0, resetAt: NOW_MS + 60_000, limitReached: undefined },
			{ label: "week", percentage: 0, resetAt: NOW_MS + 86_400_000, limitReached: undefined },
			{ label: "month", percentage: 6, resetAt: NOW_MS + 2_592_000_000, limitReached: undefined },
		]);
		expect(providerToView(provider).metrics.map((metric) => metric.label)).toEqual([
			"5h", "week", "month",
		]);
	});

	test("maps the SDK limited flag and keeps existing window periods", () => {
		const raw: ExperimentalUsageLimitsOutput = {
			...HOST_USAGE_FIXTURE,
			data: {
				...HOST_USAGE_FIXTURE.data!,
				go: {
					...HOST_USAGE_FIXTURE.data!.go!,
					monthly: { percent: 76, limited: true, resetsAt: NOW_MS + 1 },
				},
			},
		};
		const provider = normalizeOpenCodeGoUsage(raw, NOW_MS);
		expect(provider.windows[2]?.limitReached).toBe(true);
		expect(provider.windows[0]?.period).toEqual({ kind: "rolling", durationMs: 5 * 60 * 60 * 1000 });
		expect(provider.windows[1]?.period).toEqual({ kind: "calendar", unit: "week" });
		expect(provider.windows[2]?.period).toEqual({ kind: "calendar", unit: "billing" });
	});

	test("shows usage as unavailable when signed out or Go is not present", () => {
		expect(normalizeOpenCodeGoUsage({ ...HOST_USAGE_FIXTURE, data: null }, NOW_MS))
			.toMatchObject({ status: "unsupported", statusText: "OpenCode Go usage unavailable", windows: [] });
		const withoutGo: ExperimentalUsageLimitsOutput = {
			...HOST_USAGE_FIXTURE,
			data: { ...HOST_USAGE_FIXTURE.data!, go: undefined },
		};
		expect(normalizeOpenCodeGoUsage(withoutGo, NOW_MS))
			.toMatchObject({ status: "unsupported", windows: [] });
	});

	test("keeps valid windows partial and rejects invalid percentages and reset times", () => {
		const provider = normalizeOpenCodeGoUsage({
			...HOST_USAGE_FIXTURE,
			data: {
				...HOST_USAGE_FIXTURE.data!,
				go: {
					rolling: { percent: 40, limited: false, resetsAt: NOW_MS + 10 },
					weekly: { percent: 101, limited: true, resetsAt: NOW_MS + 20 },
					monthly: { percent: 50, limited: false, resetsAt: Number.NaN },
				},
			},
		}, NOW_MS);

		expect(provider.status).toBe("partial");
		expect(provider.windows).toHaveLength(1);
		expect(provider.windows[0]).toMatchObject({ percentage: 40, resetAt: NOW_MS + 10 });
	});

	test("fetches through the injected host SDK method without Go credentials", async () => {
		let calls = 0;
		const provider = await fetchUsage(async () => {
			calls += 1;
			return HOST_USAGE_FIXTURE;
		});
		expect(calls).toBe(1);
		expect(provider.status).toBe("ready");
		expect(opencodeGoProviderDefinition.registration.credentialMode).toBe("none");
	});

	test("sanitizes host errors and reports cancellation without credential data", async () => {
		const failed = await fetchUsage(async () => {
			throw new Error("Authorization: Bearer secret-value");
		});
		expect(failed.status).toBe("error");
		expect(JSON.stringify(failed)).not.toContain("secret-value");

		const controller = new AbortController();
		controller.abort();
		const parsed = opencodeGoProviderDefinition.registration.parseOptions({});
		if (!parsed.ok) throw new Error("OpenCode Go options did not parse");
		const cancelled = await parsed.value.fetchUsage({
			credential: { secret: "", source: "opencode", variant: "host-usage", epoch: 0 },
			signal: controller.signal,
			timeoutMs: 1000,
			fetchHostUsageLimits: async () => HOST_USAGE_FIXTURE,
		});
		expect(cancelled).toMatchObject({ status: "error", statusText: "cancelled" });
	});
});

async function fetchUsage(
	fetchHostUsageLimits: () => Promise<ExperimentalUsageLimitsOutput>,
) {
	const parsed = opencodeGoProviderDefinition.registration.parseOptions({});
	if (!parsed.ok) throw new Error("OpenCode Go options did not parse");
	return parsed.value.fetchUsage({
		credential: { secret: "", source: "opencode", variant: "host-usage", epoch: 0 },
		signal: new AbortController().signal,
		timeoutMs: 1000,
		fetchHostUsageLimits,
	});
}
