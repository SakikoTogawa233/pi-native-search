import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the real extension factory and registered callbacks, with no network,
// real credentials, or writes to the user's Pi configuration.
const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const plain = (value) => JSON.parse(JSON.stringify(value));
const endpoint = "https://open.bigmodel.cn/api/anthropic/v1/messages";

function harness({ provider = "zai-coding-cn", config, auth, storedKey, env = {}, fetchImpl } = {}) {
  const files = new Map();
  if (config) files.set("/test-agent/search-config.json", JSON.stringify(config));
  if (storedKey) files.set("/test-agent/auth.json", JSON.stringify({
    [provider]: { type: "api_key", key: storedKey },
  }));
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const requests = [];
  let active = ["read", "bash"];
  const exports = {};
  const modules = {
    "node:fs": {
      existsSync: (path) => files.has(path),
      readFileSync: (path) => files.get(path),
      mkdirSync() {},
      writeFileSync: (path, text) => files.set(path, text),
    },
    "node:path": { join },
    "@mariozechner/pi-coding-agent": { getAgentDir: () => "/test-agent" },
    "@sinclair/typebox": { Type: { Object: (v) => v, String: (v) => v } },
    "@mariozechner/pi-tui": {},
  };
  runInNewContext(compiled, {
    exports,
    process: { env },
    require(name) {
      assert.ok(name in modules, `Unexpected import: ${name}`);
      return modules[name];
    },
    async fetch(url, options) {
      requests.push({ url, ...options, body: JSON.parse(options.body) });
      if (fetchImpl) return fetchImpl(url, options);
      return { ok: true, json: async () => ({ content: [] }) };
    },
  });
  exports.default({
    on: (name, fn) => events.set(name, fn),
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, cmd) => commands.set(name, cmd),
    getActiveTools: () => active,
    setActiveTools: (names) => { active = [...names]; },
  });
  const ctx = {
    model: { provider, id: "glm-5.3", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
    modelRegistry: { getProviderAuth: async () => auth },
    ui: { setStatus() {}, notify() {}, theme: { fg: (_, text) => text } },
  };
  return {
    ctx, events, commands, requests,
    active: () => active,
    execute: (signal, update) => tools.get("web_search").execute(
      "test-call", { query: "Node.js release schedule" }, signal, update, ctx,
    ),
  };
}

test("GLM activation and model switching preserve unrelated tools", async () => {
  const h = harness();
  await h.events.get("session_start")({}, h.ctx);
  assert.deepEqual(h.active(), ["read", "bash", "web_search"]);
  await h.events.get("session_tree")({}, h.ctx);
  assert.equal(h.active().filter((name) => name === "web_search").length, 1);
  h.ctx.model.provider = "unsupported";
  await h.events.get("model_select")({}, h.ctx);
  assert.deepEqual(h.active(), ["read", "bash"]);
});

test("GLM uses Anthropic endpoint, registry headers, tool schema, model, and abort signal", async () => {
  const h = harness({ auth: { auth: {
    headers: { Authorization: "Bearer test-only" },
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  } } });
  const signal = new AbortController().signal;
  const updates = [];
  const result = await h.execute(signal, (value) => updates.push(value));
  assert.equal(result.isError, undefined);
  const [request] = h.requests;
  assert.equal(request.url, endpoint);
  assert.equal(request.method, "POST");
  assert.equal(request.headers.Authorization, "Bearer test-only");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.signal, signal);
  assert.equal(request.body.model, "glm-5.3");
  assert.deepEqual(plain(request.body.tools), [
    { type: "web_search_20250305", name: "web_search", max_uses: 8 },
  ]);
  assert.match(request.body.messages[0].content, /Node.js release schedule/);
  assert.equal(updates.length, 1);
});

test("GLM falls back to stored API key or ZAI_API_KEY without real credentials", async () => {
  for (const options of [
    { storedKey: "stored-test-key" },
    { storedKey: "stored-test-key", env: { ZAI_API_KEY: "env-test-key" } },
  ]) {
    const h = harness(options);
    await h.execute();
    assert.equal(h.requests[0].headers["x-api-key"], options.env?.ZAI_API_KEY ?? options.storedKey);
  }
});

test("search result blocks and citations are parsed and sources deduplicated", async () => {
  const h = harness({ fetchImpl: async () => ({ ok: true, json: async () => ({ content: [
    { type: "thinking", thinking: "not part of tool output" },
    { type: "server_tool_use", name: "web_search", input: { search_query: "Node.js" } },
    { type: "web_search_tool_result", content: [
      { type: "web_search_result", title: "Node.js", url: "https://nodejs.org/en" },
      { type: "web_search_result", title: "Releases", url: "https://nodejs.org/en/about/previous-releases" },
    ] },
    { type: "text", text: "Search completed.", citations: [
      { title: "Node.js", url: "https://nodejs.org/en" },
    ] },
  ] }) }) });
  const result = await h.execute();
  assert.equal(result.details.provider, "zai-coding-cn");
  assert.equal(result.details.searchCount, 1);
  assert.equal(result.details.resultCount, 2);
  assert.match(result.content[0].text, /Search completed\./);
  assert.equal((result.content[0].text.match(/^- \[/gm) ?? []).length, 2);
  assert.doesNotMatch(result.content[0].text, /not part of tool output/);
});

test("global and provider switches disable GLM requests", async () => {
  for (const config of [
    { enabled: false, providerOverrides: {} },
    { enabled: true, providerOverrides: { "zai-coding-cn": { searchEnabled: false } } },
  ]) {
    const h = harness({ config });
    await h.events.get("session_start")({}, h.ctx);
    assert.ok(!h.active().includes("web_search"));
    assert.equal((await h.execute()).details.error, "disabled");
    assert.equal(h.requests.length, 0);
  }
});

test("search off/on commands update tool activation", async () => {
  const h = harness();
  await h.commands.get("search").handler("off", h.ctx);
  assert.ok(!h.active().includes("web_search"));
  await h.commands.get("search").handler("on", h.ctx);
  assert.ok(h.active().includes("web_search"));
});

test("unsupported providers do not send network requests", async () => {
  const h = harness({ provider: "unsupported" });
  assert.equal((await h.execute()).details.error, "unsupported-provider");
  assert.equal(h.requests.length, 0);
});

test("Codex still injects server search and keeps local tools", async () => {
  const h = harness({ provider: "openai-codex" });
  await h.events.get("session_start")({}, h.ctx);
  assert.deepEqual(h.active(), ["read", "bash"]);
  const payload = { tools: [{ type: "function", name: "read" }] };
  const injected = h.events.get("before_provider_request")({ payload }, h.ctx);
  assert.deepEqual(plain(injected.tools), [...payload.tools, { type: "web_search" }]);
  assert.equal(payload.tools.length, 1);
  assert.equal((await h.execute()).details.error, "request-injection");
  assert.equal(h.requests.length, 0);
});

test("Kimi and DeepSeek retain their endpoint routing", async () => {
  for (const [provider, baseUrl, expected] of [
    ["kimi-coding", "https://api.kimi.com/coding/", "https://api.kimi.com/coding/v1/messages"],
    ["deepseek", "https://api.deepseek.com", "https://api.deepseek.com/anthropic/v1/messages"],
  ]) {
    const h = harness({ provider });
    h.ctx.model.baseUrl = baseUrl;
    await h.execute();
    assert.equal(h.requests[0].url, expected);
  }
});

test("HTTP and cancellation errors are returned without false search counts", async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401, text: async () => "Unauthorized" }),
    async () => { throw new Error("Aborted"); },
  ]) {
    const h = harness({ fetchImpl });
    const result = await h.execute();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Search failed:/);
    assert.equal(result.details.searchCount, undefined);
  }
});
