import { Plugin } from "@opencode/plugin";
import {
	parseCodexServerOptions,
} from "./codex-account.js";
import { createCodexCollector } from "./codex-collector.js";
import {
	CodexUsage,
	encodeCodexReply,
	parseCodexReadInput,
} from "./codex-contract.js";
import { fetchCodexSnapshot } from "./codex-fetch.js";

export default Plugin.define({
	id: "usage-monitor",
	async setup(context) {
		let options;
		try {
			options = parseCodexServerOptions(context.options);
		} catch {
			options = undefined;
		}
		const collector = createCodexCollector({
			host: context,
			options: options ?? {},
			fetchSnapshot: fetchCodexSnapshot,
		});
		const registration = await context.rpc.register(CodexUsage, {
			read: async (rawInput, { signal }) => {
				const input = parseCodexReadInput(rawInput);
				const reply = input && options
					? await collector.read(input, signal)
					: { status: "unsupported" as const, revision: "invalid-config", message: "Codex usage configuration is invalid" };
				return encodeCodexReply(reply) ?? {
					encoded: JSON.stringify({ status: "error", revision: "invalid", message: "Codex response unavailable" }),
				};
			},
		});

		const events = new AbortController();
		const eventInstanceID = crypto.randomUUID();
		let eventRevision = 0;
		const invalidateAndNotify = async () => {
			collector.invalidate();
			await registration.events.emit("invalidated", {
				revision: `${eventInstanceID}:${++eventRevision}`,
			});
		};
		const eventTask = (async () => {
			try {
				for await (const event of context.event.subscribe({ signal: events.signal })) {
					if (event.type === "credential.updated") {
						await invalidateAndNotify();
						continue;
					}
					if (event.type === "credential.switched" && event.data.integrationID === "openai") {
						await invalidateAndNotify();
					}
				}
			} catch {
				// Host event stream closes during shutdown.
			}
		})();

		return async () => {
			collector.dispose();
			events.abort();
			registration.dispose();
			await eventTask;
		};
	},
});
