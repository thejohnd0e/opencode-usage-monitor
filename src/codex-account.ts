import type { Plugin } from "@opencode/plugin";

const OPENAI_INTEGRATION_ID = "openai";
const MAX_CREDENTIAL_ID_LENGTH = 256;

export type CodexServerOptions = Readonly<{
	usageCredentialID?: string;
}>;

export type CodexAccount = Readonly<{
	connectionID: string;
	accountID: string;
	access: string;
	expires: number;
}>;

export function parseCodexServerOptions(input: unknown): CodexServerOptions {
	if (!isRecord(input)) throw new TypeError("Invalid Codex usage options");
	const keys = Object.keys(input);
	if (keys.some((key) => key !== "usageCredentialID")) {
		throw new TypeError("Invalid Codex usage options");
	}
	const selected = input.usageCredentialID;
	if (selected === undefined) return Object.freeze({});
	if (typeof selected !== "string") {
		throw new TypeError("Invalid Codex usage credential ID");
	}
	const usageCredentialID = selected.trim();
	if (!isSafeCredentialID(usageCredentialID)) {
		throw new TypeError("Invalid Codex usage credential ID");
	}
	return Object.freeze({ usageCredentialID });
}

export async function resolveCodexAccount(
	host: Pick<Plugin.Context, "integration">,
	options: CodexServerOptions,
): Promise<CodexAccount | undefined> {
	try {
		const connection = options.usageCredentialID
			? await findSelectedConnection(host, options.usageCredentialID)
			: await host.integration.connection.active(OPENAI_INTEGRATION_ID);
		if (!connection || connection.type !== "credential") return undefined;

		const credential = await host.integration.connection.resolve(connection);
		if (!credential || credential.type !== "oauth") return undefined;
		const accountID = readAccountID(credential.metadata);
		if (
			!accountID ||
			!isSafeCredentialID(connection.id) ||
			!isNonEmptyString(credential.access) ||
			!Number.isSafeInteger(credential.expires) ||
			credential.expires <= Date.now()
		) {
			return undefined;
		}

		return Object.freeze({
			connectionID: connection.id,
			accountID,
			access: credential.access,
			expires: credential.expires,
		});
	} catch {
		return undefined;
	}
}

async function findSelectedConnection(
	host: Pick<Plugin.Context, "integration">,
	credentialID: string,
): Promise<Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>> {
	const integration = await host.integration.get({
		integrationID: OPENAI_INTEGRATION_ID,
	});
	if (integration.data.id !== OPENAI_INTEGRATION_ID) return undefined;
	return (
		integration.data.connections.find(
			(connection) =>
				connection.type === "credential" && connection.id === credentialID,
		) ?? undefined
	);
}

function readAccountID(metadata: unknown): string | undefined {
	if (!isRecord(metadata)) return undefined;
	const accountID =
		typeof metadata.accountID === "string"
			? metadata.accountID
			: metadata.accountId;
	return typeof accountID === "string" && isSafeCredentialID(accountID)
		? accountID
		: undefined;
}

function isSafeCredentialID(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= MAX_CREDENTIAL_ID_LENGTH &&
		![...value].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127;
		})
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
