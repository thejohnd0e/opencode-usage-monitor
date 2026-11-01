import { afterEach, describe, expect, test } from "bun:test";

import { fetchCodexSnapshot } from "../codex-fetch.js";
import type { CodexAccount } from "../codex-account.js";
import { restoreFetch } from "./_helpers.js";

const account: CodexAccount = {
	connectionID: "cred-openai",
	accountID: "account-123",
	access: "oauth-access",
	expires: 2_000_000_000_000,
};

const options = { show_resets: true, show_reset_expiry: true } as const;
const usage = {
	plan_type: "plus",
	rate_limit: {
		primary_window: {
			used_percent: 25,
			limit_window_seconds: 18_000,
			reset_at: 2_000_000_100,
		},
		secondary_window: {
			used_percent: 40,
			limit_window_seconds: 604_800,
			reset_at: 2_000_100_000,
		},
	},
	rate_limit_reset_credits: { available_count: 2 },
};

afterEach(() => restoreFetch());

describe("server-side Codex collection", () => {
	test("fetches five-hour and weekly windows with reset timestamps", async () => {
		globalThis.fetch = (async () => Response.json(usage)) as unknown as typeof fetch;
		const result = await fetchCodexSnapshot(account, options, new AbortController().signal);

		expect(result).toMatchObject({
			id: "openai",
			status: "ready",
			windows: [
				{ id: "openai-primary", label: "5h", percentage: 25, resetAt: 2_000_000_100_000 },
				{ id: "openai-secondary", label: "week", percentage: 40, resetAt: 2_000_100_000_000 },
			],
		});
		expect(JSON.stringify(result)).not.toContain(account.access);
	});

	test("counts zero reset credits without requesting details", async () => {
		const requests: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return Response.json({ ...usage, rate_limit_reset_credits: { available_count: 0 } });
		}) as unknown as typeof fetch;
		const result = await fetchCodexSnapshot(account, options, new AbortController().signal);

		expect(requests).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
		expect(result.details?.find((detail) => detail.key === "resets")?.value).toEqual({
			kind: "text",
			value: "0",
		});
	});

	test("keeps valid usage when reset-credit details fail", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return calls === 1
				? Response.json(usage)
				: Response.json({ error: "unavailable" }, { status: 503 });
		}) as unknown as typeof fetch;
		const result = await fetchCodexSnapshot(account, options, new AbortController().signal);

		expect(result.status).toBe("ready");
		expect(result.windows).toHaveLength(2);
		expect(result.details?.some((detail) => detail.key.startsWith("reset-credit-"))).toBe(false);
	});

	test("does not request or render reset details when disabled", async () => {
		const requests: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return Response.json(usage);
		}) as unknown as typeof fetch;
		const result = await fetchCodexSnapshot(
			account,
			{ show_resets: false, show_reset_expiry: true },
			new AbortController().signal,
		);

		expect(requests).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
		expect(result.details?.some((detail) => detail.key === "resets")).toBe(false);
	});

	test("maps authorization failures and malformed usage to safe statuses", async () => {
		for (const status of [401, 403]) {
			globalThis.fetch = (async () => Response.json({}, { status })) as unknown as typeof fetch;
			expect(await fetchCodexSnapshot(account, options, new AbortController().signal)).toMatchObject({
				status: "forbidden",
				statusText: "forbidden",
			});
		}

		globalThis.fetch = (async () => Response.json({ rate_limit: {} })) as unknown as typeof fetch;
		expect(await fetchCodexSnapshot(account, options, new AbortController().signal)).toMatchObject({
			status: "error",
		});
	});

	test("distinguishes timeout from cancellation and never exposes the access token", async () => {
		const timedOut = new AbortController();
		globalThis.fetch = (async () => {
			timedOut.abort(new DOMException("timeout", "TimeoutError"));
			throw timedOut.signal.reason;
		}) as unknown as typeof fetch;
		expect(await fetchCodexSnapshot(account, options, timedOut.signal)).toMatchObject({
			status: "error",
			statusText: "timeout",
		});

		globalThis.fetch = (async () => {
			throw new Error(`request failed with ${account.access}`);
		}) as unknown as typeof fetch;
		const failed = await fetchCodexSnapshot(account, options, new AbortController().signal);
		expect(JSON.stringify(failed)).not.toContain(account.access);
	});

	test("renders only bounded future available reset credits with stable keys", async () => {
		const now = Date.now();
		const credits = Array.from({ length: 110 }, (_, index) => ({
			status: "available",
			title: index < 2 ? "Full reset" : `Reset ${index}`,
			expires_at: new Date(now + (index + 1) * 60_000).toISOString(),
		}));
		credits.splice(99, 0, {
			status: "available",
			title: "Invalid date",
			expires_at: "not-a-date",
		});
		credits.push(
			{ status: "used", title: "Used reset", expires_at: new Date(now + 60_000).toISOString() },
			{ status: "available", title: "Expired", expires_at: new Date(now - 60_000).toISOString() },
		);
		const requests: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return requests.length === 1
				? Response.json(usage)
				: Response.json({ credits, available_count: 111 });
		}) as unknown as typeof fetch;
		const result = await fetchCodexSnapshot(account, options, new AbortController().signal);
		const details = result.details?.filter((detail) => detail.key.startsWith("reset-credit-")) ?? [];

		expect(details).toHaveLength(200);
		expect(details[0]).toMatchObject({ key: "reset-credit-0-title", value: { value: "  • Full reset" } });
		expect(details[2]).toMatchObject({ key: "reset-credit-1-title", value: { value: "  • Full reset" } });
		expect(details.some((detail) => JSON.stringify(detail).includes("Used reset"))).toBe(false);
		expect(details.some((detail) => JSON.stringify(detail).includes("Expired"))).toBe(false);
		expect(details.some((detail) => JSON.stringify(detail).includes("Invalid date"))).toBe(false);
	});

	test("limits credit titles to 200 printable characters", async () => {
		const calls = { count: 0 };
		globalThis.fetch = (async () => {
			calls.count += 1;
			return calls.count === 1 ? Response.json(usage) : Response.json({
				credits: [{ status: "available", title: `  ${"x".repeat(300)}\nunsafe`, expires_at: "2099-01-01T00:00:00Z" }],
				available_count: 1,
			});
		}) as unknown as typeof fetch;
		const result = await fetchCodexSnapshot(account, options, new AbortController().signal);
		const title = result.details?.find((detail) => detail.key === "reset-credit-0-title")?.value;

		expect(title?.kind).toBe("text");
		if (title?.kind === "text") {
			expect(title.value.length).toBeLessThanOrEqual(204);
			expect(title.value).not.toContain("\n");
		}
	});
});
