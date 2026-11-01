import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import {
	parseCodexServerOptions,
	resolveCodexAccount,
} from "../codex-account.js";

type FixtureConnection = { type: "credential"; id: string; label: string; method: "oauth" };
const openaiConnection: FixtureConnection = { type: "credential", id: "cred-openai", label: "Codex", method: "oauth" };
const unrelatedConnection: FixtureConnection = { type: "credential", id: "cred-other", label: "Other", method: "oauth" };
const oauthCredential = {
	type: "oauth",
	methodID: "codex",
	refresh: "must-not-escape",
	access: "access-token",
	expires: 2_000_000_000_000,
	metadata: { accountID: "account-123", arbitrary: "must-not-escape" },
} as const;

function hostFixture(input: {
	integrationID?: string;
	connections?: readonly FixtureConnection[];
	active?: FixtureConnection | undefined;
	credential?: unknown;
}) {
	const calls: string[] = [];
	const host = {
		integration: {
			get: async ({ integrationID }: { integrationID: string }) => ({
				data: {
					id: input.integrationID ?? integrationID,
					name: "OpenAI",
					methods: [],
					connections: input.connections ?? [openaiConnection],
				},
			}),
			connection: {
				active: async (integrationID: string) => {
					calls.push(`active:${integrationID}`);
					return input.active === undefined ? openaiConnection : input.active;
				},
				resolve: async (connection: unknown) => {
					calls.push(`resolve:${(connection as { id: string }).id}`);
					return input.credential === undefined ? oauthCredential : input.credential;
				},
			},
		},
	};
	return { host: host as unknown as Pick<Plugin.Context, "integration">, calls };
}

describe("Codex server credential selection", () => {
	test("defaults to OpenCode's active OpenAI connection", async () => {
		const { host, calls } = hostFixture({});
		const account = await resolveCodexAccount(host, {});

		expect(calls).toEqual(["active:openai", "resolve:cred-openai"]);
		expect(account).toEqual({
			connectionID: "cred-openai",
			accountID: "account-123",
			access: "access-token",
			expires: 2_000_000_000_000,
		});
		expect(JSON.stringify(account)).not.toContain("must-not-escape");
	});

	test("explicit selection resolves only that OpenAI connection and never activates or falls back", async () => {
		const { host, calls } = hostFixture({
			connections: [unrelatedConnection, openaiConnection],
		});
		const account = await resolveCodexAccount(host, {
			usageCredentialID: "cred-openai",
		});

		expect(calls).toEqual(["resolve:cred-openai"]);
		expect(account?.connectionID).toBe("cred-openai");

		const missing = hostFixture({ connections: [unrelatedConnection] });
		expect(await resolveCodexAccount(missing.host, {
			usageCredentialID: "cred-missing",
		})).toBeUndefined();
		expect(missing.calls).toEqual([]);
	});

	test("rejects non-OpenAI integrations and non-OAuth or incomplete credentials", async () => {
		const wrongIntegration = hostFixture({ integrationID: "other" });
		expect(await resolveCodexAccount(wrongIntegration.host, {
			usageCredentialID: "cred-openai",
		})).toBeUndefined();

		const noAccount = hostFixture({
			credential: { ...oauthCredential, metadata: {} },
		});
		expect(await resolveCodexAccount(noAccount.host, {})).toBeUndefined();

		const apiKey = hostFixture({ credential: { type: "key", key: "api-key" } });
		expect(await resolveCodexAccount(apiKey.host, {})).toBeUndefined();

		const expired = hostFixture({
			credential: { ...oauthCredential, expires: 1 },
		});
		expect(await resolveCodexAccount(expired.host, {})).toBeUndefined();
	});

	test("rejects invalid or blank server options", () => {
		expect(parseCodexServerOptions({})).toEqual({});
		expect(parseCodexServerOptions({ usageCredentialID: " cred-1 " })).toEqual({
			usageCredentialID: "cred-1",
		});
		expect(() => parseCodexServerOptions({ usageCredentialID: "  " })).toThrow();
		expect(() => parseCodexServerOptions({ usageCredentialID: 7 })).toThrow();
	});
});
