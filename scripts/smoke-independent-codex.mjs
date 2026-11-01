import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const consumerDir = process.argv[2] && resolve(process.argv[2]);
if (!consumerDir || !existsSync(join(consumerDir, "node_modules", "opencode-usage-monitor"))) {
  throw new Error("Expected an installed packed consumer directory as the argument");
}

const installed = join(consumerDir, "node_modules", "opencode-usage-monitor");
const packageInfo = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
assert.equal(packageInfo.name, "opencode-usage-monitor");
assert.equal(Object.hasOwn(packageInfo.dependencies ?? {}, "codex-limits"), false);
assert.equal(existsSync(join(consumerDir, "node_modules", "codex-limits")), false);

const serverBundle = readFileSync(join(installed, "dist", "index.js"), "utf8");
const tuiBundle = readFileSync(join(installed, "dist", "tui.js"), "utf8");
assert.match(serverBundle, /usage-monitor\.codex/);
assert.match(tuiBundle, /usage-monitor\.codex/);
assert.doesNotMatch(tuiBundle, /setOpenAIUsageReader|codex-limits/);

const tempHome = mkdtempSync(join(tmpdir(), "usage-monitor-codex-smoke-"));
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const configDir = join(tempHome, ".config", "opencode");
await (await import("node:fs/promises")).mkdir(configDir, { recursive: true });
writeFileSync(join(configDir, "usage-monitor.json"), JSON.stringify({
  version: 2,
  refresh: { mode: "manual", timeout_ms: 5_000 },
  providers: {
    openai: { options: { show_resets: true, show_reset_expiry: true } },
  },
}));
assert.equal(existsSync(join(homedir(), ".config", "opencode", "usage-monitor.json")), true);

const importRoot = pathToFileURL(join(installed, "dist", "index.js")).href;
const importTui = pathToFileURL(join(installed, "dist", "tui.js")).href;
const [{ default: serverPlugin }, { default: tuiPlugin }] = await Promise.all([
  import(importRoot),
  import(importTui),
]);
assert.equal(serverPlugin.id, "usage-monitor");
assert.equal(tuiPlugin.id, "usage-monitor.tui");

let serverRegistration;
const rpcInvalidationListeners = new Set();
const hostEventQueue = [];
let hostEventWake;
let reads = 0;
let successfulReads = 0;
let resolves = 0;
let credentialListCalls = 0;
let modelConnection = "model-active";
let statisticsAccount = "stats-account-a";
let currentFetchAccount = "";
let hostRefreshes = 0;
let credentialActivations = 0;
let hostCredentialExpires = Date.now() - 1;
const readWaiters = new Map();

function waitForRead(target) {
  if (successfulReads >= target) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiters = readWaiters.get(target) ?? [];
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for successful Codex RPC read ${target}; observed ${successfulReads} successes / ${reads} attempts`)), 10_000);
    readWaiters.set(target, [...waiters, () => { clearTimeout(timer); resolve(); }]);
  });
}

function signalReadWaiters() {
  for (const [target, waiters] of readWaiters) {
    if (successfulReads < target) continue;
    readWaiters.delete(target);
    for (const resolve of waiters) resolve();
  }
}

const serverContext = {
  options: { usageCredentialID: "statistics-only" },
  integration: {
    get: async ({ integrationID }) => ({
      data: {
        id: integrationID,
        name: "OpenAI",
        methods: [],
        connections: [{
          type: "credential",
          id: "statistics-only",
          label: "statistics",
          method: "oauth",
        }],
      },
    }),
    connection: {
      active: async () => ({
        type: "credential",
        id: modelConnection,
        label: "model",
        method: "oauth",
      }),
      resolve: async (connection) => {
		assert.equal(connection.id, "statistics-only");
		resolves += 1;
		if (hostCredentialExpires <= Date.now()) {
			hostRefreshes += 1;
			hostCredentialExpires = Date.now() + 60_000;
		}
        return {
          type: "oauth",
          methodID: "oauth",
          refresh: "refresh-token-must-not-escape",
          access: `refreshed-access-${statisticsAccount}`,
			expires: hostCredentialExpires,
          metadata: { accountID: statisticsAccount },
        };
      },
    },
  },
  credential: {
    activate: async () => { credentialActivations += 1; },
  },
  rpc: {
    register: async (definition, handlers) => {
      assert.equal(definition.id, "usage-monitor.codex");
      serverRegistration = { definition, handlers };
      return {
        events: {
          emit: async (name, payload) => {
            assert.equal(name, "invalidated");
            for (const listener of rpcInvalidationListeners) listener({ type: "rpc.usage-monitor.codex.invalidated", data: payload });
          },
        },
        dispose() { serverRegistration = undefined; },
      };
    },
  },
  event: {
    subscribe: ({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        signal.addEventListener("abort", () => hostEventWake?.(), { once: true });
        while (!signal.aborted) {
          if (hostEventQueue.length > 0) {
            yield hostEventQueue.shift();
            continue;
          }
          await new Promise((resolve) => { hostEventWake = resolve; });
        }
      },
    }),
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const address = String(url);
  assert.equal(new URL(address).host, "chatgpt.com");
  const authorization = new Headers(init.headers).get("Authorization");
  assert.match(authorization ?? "", /^Bearer refreshed-access-/);
  currentFetchAccount = new Headers(init.headers).get("ChatGPT-Account-Id") ?? "";
  if (address.endsWith("/backend-api/wham/usage")) {
    return Response.json({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3_600 },
        secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: Math.floor(Date.now() / 1000) + 86_400 },
      },
      rate_limit_reset_credits: { available_count: 1 },
    });
  }
  if (address.endsWith("/backend-api/wham/rate-limit-reset-credits")) {
    return Response.json({ credits: [{ status: "available", title: "Test reset", expires_at: new Date(Date.now() + 86_400_000).toISOString() }] });
  }
  throw new Error("Unexpected upstream URL");
};

let serverCleanup;
let tuiCleanup;
try {
  serverCleanup = await serverPlugin.setup(serverContext);
  assert.ok(serverRegistration, "server RPC registration is missing");
  assert.equal(serverRegistration.definition.id, "usage-monitor.codex");

  const client = {
    credential: {
      list: async () => {
        credentialListCalls += 1;
        throw new Error("TUI must not request OpenAI credential.list permission");
      },
    },
    rpc(definition) {
      assert.equal(definition.id, serverRegistration.definition.id, "TUI and server RPC contracts differ");
      assert.equal(JSON.stringify(definition), JSON.stringify(serverRegistration.definition), "TUI and server RPC schemas differ");
      return {
        async read(input, { signal }) {
          reads += 1;
          try {
            const result = await serverRegistration.handlers.read(input, { signal });
            const decoded = JSON.parse(result.encoded);
            assert.equal(decoded.status, "ok");
            assert.equal(decoded.snapshot.windows.length, 2);
            assert.deepEqual(decoded.snapshot.windows.map((window) => window.label), ["5h", "week"]);
            assert.ok(decoded.snapshot.details.some((detail) => detail.key.startsWith("reset-credit-")));
            assert.doesNotMatch(JSON.stringify(decoded), /refreshed-access|refresh-token/);
            successfulReads += 1;
            return result;
          } finally {
            signalReadWaiters();
          }
        },
        events: {
          on(name, handler, { signal }) {
            assert.equal(name, "invalidated");
            rpcInvalidationListeners.add(handler);
            signal.addEventListener("abort", () => rpcInvalidationListeners.delete(handler), { once: true });
            return () => rpcInvalidationListeners.delete(handler);
          },
        },
      };
    },
    experimental: { usage: { limits: async () => ({ location: { directory: tempHome }, data: null }) } },
  };
  const tuiContext = {
    client,
    data: { on: () => () => undefined },
    theme: {
      text: { base: "white", muted: "gray", feedback: { warning: { base: "yellow" }, error: { base: "red" } } },
      background: { base: "black" },
      border: { base: "gray" },
    },
    keymap: { layer: () => undefined },
    ui: { slot: () => () => undefined, toast: { show: () => undefined } },
  };
  tuiCleanup = await tuiPlugin.setup(tuiContext);

  await waitForRead(1);
  assert.equal(currentFetchAccount, "stats-account-a");
  assert.equal(modelConnection, "model-active");
  assert.equal(credentialListCalls, 0);
  assert.equal(credentialActivations, 0);
  assert.equal(hostRefreshes, 1);
  assert.ok(resolves >= 1, "host did not resolve/refresh the statistics OAuth credential");

  statisticsAccount = "stats-account-b";
	hostCredentialExpires = Date.now() - 1;
  hostEventQueue.push({ type: "credential.updated", data: {} });
  hostEventWake?.();
  await waitForRead(2);
  assert.equal(currentFetchAccount, "stats-account-b", "account invalidation did not trigger an isolated refresh");
  assert.equal(modelConnection, "model-active", "statistics account selection changed the model connection");
  assert.equal(credentialListCalls, 0);
  assert.equal(credentialActivations, 0);
  assert.equal(hostRefreshes, 2);
} finally {
  await tuiCleanup?.();
  await serverCleanup?.();
  globalThis.fetch = originalFetch;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
  rmSync(tempHome, { recursive: true, force: true });
}

console.log("independent Codex RPC smoke passed (mocked host/upstream; no live credentials/config)");
