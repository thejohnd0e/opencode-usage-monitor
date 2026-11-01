import { Plugin as ServerPlugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/rpc";
import { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import { createElement, insert, setProp, type JSX } from "@opentui/solid";

export const server = ServerPlugin.define({
  id: "fixture.server",
  async setup(context) {
    const active = await context.integration.connection.active("openai");
    if (active?.type === "credential") {
      const credential = await context.integration.connection.resolve(active);
      if (credential?.type === "oauth") void credential.access;
    }
    const integration = await context.integration.get({ integrationID: "openai" });
    void integration.data.connections;

    const codexUsage = Rpc.define({
      id: "fixture.codex-usage",
      methods: {
        read: {
          input: {
            type: "object",
            properties: {
              show_resets: { type: "boolean" },
              show_reset_expiry: { type: "boolean" },
              timeout_ms: { type: "integer", minimum: 1000, maximum: 30000 },
            },
            required: ["show_resets", "show_reset_expiry", "timeout_ms"],
            additionalProperties: false,
          },
          output: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false },
        },
      },
      events: {
        invalidated: { schema: { type: "object", properties: { revision: { type: "string" } }, required: ["revision"], additionalProperties: false } },
      },
    });
    const registration = await context.rpc.register(codexUsage, {
      read: async (_input, { signal }) => {
        void signal.aborted;
        return { status: "ready" };
      },
    });
    await registration.events.emit("invalidated", { revision: "1" });
    const abort = new AbortController();
    for await (const _event of context.event.subscribe({ signal: abort.signal })) break;
    abort.abort();
    return () => registration.dispose();
  },
});

export const tui = TuiPlugin.define({
  id: "fixture.tui",
  setup(context) {
    const codexUsage = Rpc.define({
      id: "fixture.codex-usage",
      methods: {
        read: {
          input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
          output: { type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false },
        },
      },
      events: {
        invalidated: { schema: { type: "object", properties: { revision: { type: "string" } }, required: ["revision"], additionalProperties: false } },
      },
    });
    const codexClient = context.client.rpc(codexUsage);
    const removeInvalidation = codexClient.events.on("invalidated", (event) => {
      void event.data.revision;
    });
    void codexClient.read({ value: "fixture" }, { signal: new AbortController().signal });
    const removeUpdated = context.data.on("credential.updated", () => undefined);
    const removeSwitched = context.data.on("credential.switched", (event) => {
      void event.data.integrationID;
    });
    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const container = createElement("box");
        setProp(container, "width", "100%");
        insert(container, () => {
          const label = createElement("text");
          setProp(label, "fg", context.theme.text.base);
          insert(label, context.theme.text.muted ? "fixture" : "fixture");
          return label;
        });
        return container as unknown as JSX.Element;
      },
    });

    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "fixture.refresh",
        title: "Refresh fixture",
        slash: { name: "fixture-refresh" },
        run: async () => {
          const credentials = await context.client.credential.list();
          context.ui.toast.show({
            title: "Fixture",
            message: `${credentials.length} credentials`,
            variant: "info",
          });
        },
      }],
    }));

    return () => {
        removeSlot();
        removeInvalidation();
      removeUpdated();
      removeSwitched();
    };
  },
});
