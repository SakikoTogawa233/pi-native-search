/**
 * Provider-native web search for Pi.
 *
 * Supported providers:
 * - OpenAI Codex: injects `{ type: "web_search" }` into the main request
 *   instead of registering a client-side search tool.
 * - Kimi For Coding, DeepSeek, and GLM Coding (Z.ai): use a Claude Code-style
 *   nested Anthropic Messages request declaring the server-side
 *   `web_search_20250305` tool.
 *
 * Config persists in ~/.pi/agent/search-config.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  Container,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
} from "@mariozechner/pi-tui";

interface ProviderOverride {
  searchEnabled?: boolean;
}

interface SearchConfig {
  enabled: boolean;
  providerOverrides: Record<string, ProviderOverride>;
}

interface ProviderDefinition {
  name: string;
  envKey: string;
}

interface NativeSearchResult {
  text: string;
  searchCount: number;
  resultCount: number;
}

interface AnthropicTextCitation {
  title?: string;
  url?: string;
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  content?: unknown;
  citations?: AnthropicTextCitation[];
}

interface ProviderRequestAuth {
  headers: Record<string, string>;
  baseUrl?: string;
}

const PROVIDERS: Record<string, ProviderDefinition> = {
  "openai-codex": {
    name: "OpenAI Codex",
    envKey: "",
  },
  "kimi-coding": {
    name: "Kimi For Coding",
    envKey: "KIMI_API_KEY",
  },
  deepseek: {
    name: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
  },
  "zai-coding-cn": {
    name: "GLM Coding (Z.ai)",
    envKey: "ZAI_API_KEY",
  },
};

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const ZAI_ANTHROPIC_BASE_URL = "https://open.bigmodel.cn/api/anthropic";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function getConfigPath(): string {
  return join(getAgentDir(), "search-config.json");
}

function loadConfig(): SearchConfig {
  if (existsSync(getConfigPath())) {
    return JSON.parse(readFileSync(getConfigPath(), "utf-8"));
  }
  return { enabled: true, providerOverrides: {} };
}

function saveConfig(config: SearchConfig): void {
  const agentDir = getAgentDir();
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

function getApiKey(provider: string): string | undefined {
  const envKey = PROVIDERS[provider]?.envKey;
  if (envKey && process.env[envKey]) return process.env[envKey];

  const authPath = join(getAgentDir(), "auth.json");
  if (!existsSync(authPath)) return undefined;
  const entry = JSON.parse(readFileSync(authPath, "utf-8"))[provider];
  if (entry?.type === "api_key" && entry.key && !entry.key.startsWith("!")) {
    return entry.key;
  }
  return undefined;
}

function hasCredentials(provider: string): boolean {
  const authPath = join(getAgentDir(), "auth.json");
  if (getApiKey(provider)) return true;
  if (!existsSync(authPath)) return false;
  const entry = JSON.parse(readFileSync(authPath, "utf-8"))[provider];
  return entry?.type === "oauth" && !!entry.refresh;
}

function getCurrentProvider(ctx: ExtensionContext): string {
  return ctx.model?.provider ?? "";
}

function getCurrentModel(ctx: ExtensionContext): string {
  return ctx.model?.id ?? "";
}

function getCurrentBaseUrl(ctx: ExtensionContext): string {
  return ctx.model?.baseUrl ?? "";
}

function isSupportedProvider(provider: string): boolean {
  return provider in PROVIDERS;
}

function isRequestInjectionProvider(provider: string): boolean {
  return provider === "openai-codex";
}

function isSearchEnabledFor(
  provider: string,
  config: SearchConfig,
): boolean {
  return config.enabled && config.providerOverrides[provider]?.searchEnabled !== false;
}

function getNativeSearchBaseUrl(
  provider: string,
  modelBaseUrl: string,
  authBaseUrl?: string,
): string {
  if (provider === "deepseek") return DEEPSEEK_ANTHROPIC_BASE_URL;
  if (provider === "zai-coding-cn") return ZAI_ANTHROPIC_BASE_URL;
  return authBaseUrl || modelBaseUrl || DEFAULT_ANTHROPIC_BASE_URL;
}

interface ProviderAuthResolver {
  getProviderAuth(provider: string): Promise<
    | {
        auth: { headers?: Record<string, string>; baseUrl?: string };
      }
    | undefined
  >;
}

async function getProviderRequestAuth(
  ctx: ExtensionContext,
  provider: string,
): Promise<ProviderRequestAuth> {
  const registry = ctx.modelRegistry as unknown as ProviderAuthResolver;
  const auth = await registry.getProviderAuth(provider);
  const headers = { ...(auth?.auth.headers ?? {}) };
  if (Object.keys(headers).length === 0) {
    const apiKey = getApiKey(provider);
    if (apiKey) headers["x-api-key"] = apiKey;
  }
  return { headers, baseUrl: auth?.auth.baseUrl };
}

async function anthropicStyleSearch(
  query: string,
  provider: string,
  model: string,
  modelBaseUrl: string,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<NativeSearchResult> {
  const auth = await getProviderRequestAuth(ctx, provider);
  const baseUrl = getNativeSearchBaseUrl(provider, modelBaseUrl, auth.baseUrl);
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...auth.headers,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system:
        "You are an assistant for performing a web search tool use. Use web_search when current information is needed, then answer with Markdown sources.",
      messages: [
        {
          role: "user",
          content: `Perform a web search for the query: ${query}`,
        },
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 8,
        },
      ],
    }),
  });

  if (!response.ok) {
    const message = (await response.text()).slice(0, 200);
    throw new Error(`${PROVIDERS[provider].name} ${response.status}: ${message}`);
  }

  const data = (await response.json()) as { content?: AnthropicContentBlock[] };
  const textParts: string[] = [];
  const sources: { title: string; url: string }[] = [];
  let searchCount = 0;
  let resultCount = 0;

  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
      for (const citation of block.citations ?? []) {
        if (citation.url) {
          sources.push({ title: citation.title ?? citation.url, url: citation.url });
        }
      }
      continue;
    }

    if (block.type !== "web_search_tool_result") continue;
    searchCount++;
    if (!Array.isArray(block.content)) continue;

    for (const item of block.content as {
      type?: string;
      title?: string;
      url?: string;
    }[]) {
      if ((item.type === "web_search_result" || !item.type) && item.url) {
        resultCount++;
        sources.push({ title: item.title ?? item.url, url: item.url });
      }
    }
  }

  const uniqueSources = [
    ...new Map(sources.map((source) => [source.url, source])).values(),
  ];
  if (uniqueSources.length > 0) {
    textParts.push("\n## Sources:");
    for (const source of uniqueSources.slice(0, 8)) {
      textParts.push(`- [${source.title}](${source.url})`);
    }
  }

  return {
    text: textParts.join("\n").trim() || "No results found.",
    searchCount,
    resultCount,
  };
}

function updateStatus(ctx: ExtensionContext, config: SearchConfig): void {
  const provider = getCurrentProvider(ctx);
  if (!config.enabled || !isSupportedProvider(provider)) {
    ctx.ui.setStatus("search", undefined);
    return;
  }

  const mode = isRequestInjectionProvider(provider) ? "inject" : "native";
  ctx.ui.setStatus(
    "search",
    ctx.ui.theme.fg("accent", `search[${mode}:${getCurrentModel(ctx)}]`),
  );
}

function applyToolsConfig(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const provider = getCurrentProvider(ctx);
  const activeTools = pi.getActiveTools().filter((tool) => tool !== "web_search");
  if (configShouldEnableSearchTool(provider)) activeTools.push("web_search");
  pi.setActiveTools(activeTools);
}

function configShouldEnableSearchTool(provider: string): boolean {
  if (!isSupportedProvider(provider) || isRequestInjectionProvider(provider)) {
    return false;
  }
  return isSearchEnabledFor(provider, searchExtensionConfig);
}

let searchExtensionConfig: SearchConfig = { enabled: true, providerOverrides: {} };

export default function searchExtension(pi: ExtensionAPI): void {
  searchExtensionConfig = loadConfig();

  pi.on("before_provider_request", (event, ctx) => {
    const provider = getCurrentProvider(ctx);
    if (!isRequestInjectionProvider(provider)) return;
    if (!isSearchEnabledFor(provider, searchExtensionConfig)) return;

    const payload = event.payload as Record<string, unknown>;
    const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
    return {
      ...payload,
      tools: [...existingTools, { type: "web_search" }],
      tool_choice: "auto",
    };
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using the active provider's server-side search.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const provider = getCurrentProvider(ctx);
      if (!isSupportedProvider(provider)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Provider ${provider} is not supported.`,
            },
          ],
          details: { error: "unsupported-provider" },
        };
      }
      if (isRequestInjectionProvider(provider)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Web search is injected into the main Codex request and has no client-side tool.",
            },
          ],
          details: { error: "request-injection" },
        };
      }
      if (!isSearchEnabledFor(provider, searchExtensionConfig)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Web search is disabled. Use /search to enable it.",
            },
          ],
          details: { error: "disabled" },
        };
      }

      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text: `Searching via ${PROVIDERS[provider].name}: "${params.query}"...`,
          },
        ],
        details: {},
      });

      try {
        const result = await anthropicStyleSearch(
          params.query,
          provider,
          getCurrentModel(ctx),
          getCurrentBaseUrl(ctx),
          ctx,
          signal,
        );
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            query: params.query,
            provider,
            method: "native",
            searchCount: result.searchCount,
            resultCount: result.resultCount,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `Search failed: ${message}` }],
          details: { query: params.query, provider, error: message },
          isError: true,
        };
      }
    },
    renderCall(args: { query?: string }, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("web_search ")) +
          theme.fg("muted", args.query ? `"${args.query}"` : ""),
        0,
        0,
      );
    },
    renderResult(
      result: { content?: { type?: string; text?: string }[] },
      { expanded, isPartial }: { expanded?: boolean; isPartial?: boolean },
      theme: any,
    ) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const textBlock = result.content?.[0];
      const text = textBlock?.type === "text" ? (textBlock.text ?? "") : "";
      const lines = text ? text.split("\n").length : 0;
      return expanded
        ? new Text(text, 0, 0)
        : new Text(
            theme.fg("success", "web search completed") +
              theme.fg("dim", ` (${lines} lines)`),
            0,
            0,
          );
    },
  });

  pi.registerCommand("search", {
    description: "Configure provider-native web search",
    getArgumentCompletions(prefix) {
      return ["on", "off", "providers", "config"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const subcommand = args?.trim().toLowerCase();
      if (subcommand === "providers") {
        await showProviders(ctx);
        return;
      }
      if (subcommand === "config") {
        showConfig(ctx);
        return;
      }
      if (subcommand === "on") {
        searchExtensionConfig.enabled = true;
        saveConfig(searchExtensionConfig);
        applyToolsConfig(pi, ctx);
        updateStatus(ctx, searchExtensionConfig);
        ctx.ui.notify("Web search enabled", "info");
        return;
      }
      if (subcommand === "off") {
        searchExtensionConfig.enabled = false;
        saveConfig(searchExtensionConfig);
        applyToolsConfig(pi, ctx);
        updateStatus(ctx, searchExtensionConfig);
        ctx.ui.notify("Web search disabled", "info");
        return;
      }
      await showSettings(ctx);
    },
  });

  async function showSettings(ctx: ExtensionContext): Promise<void> {
    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Web Search",
          currentValue: searchExtensionConfig.enabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        },
      ];

      const currentProvider = getCurrentProvider(ctx);
      for (const provider of Object.keys(PROVIDERS).sort()) {
        const definition = PROVIDERS[provider];
        const override = searchExtensionConfig.providerOverrides[provider];
        const current = provider === currentProvider ? " ← current" : "";
        items.push({
          id: `provider:${provider}`,
          label: `${definition.name}${current} - Search`,
          currentValue: override?.searchEnabled === false ? "disabled" : "enabled",
          values: ["enabled", "disabled"],
        });
      }

      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Search Settings"))));
      container.addChild(new Text(theme.fg("dim", "Supported providers only")));
      container.addChild(new Text(""));
      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 12),
        getSettingsListTheme(),
        (id, value) => {
          if (id === "enabled") {
            searchExtensionConfig.enabled = value === "enabled";
          } else {
            const provider = id.split(":")[1];
            searchExtensionConfig.providerOverrides[provider] = {
              searchEnabled: value === "enabled",
            };
          }
          saveConfig(searchExtensionConfig);
          applyToolsConfig(pi, ctx);
          updateStatus(ctx, searchExtensionConfig);
        },
        () => done(undefined),
      );
      container.addChild(settingsList);
      container.addChild(new Text(theme.fg("dim", "↑↓ navigate • tab toggle • esc close")));

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  async function showProviders(ctx: ExtensionContext): Promise<void> {
    const currentProvider = getCurrentProvider(ctx);
    const items: SelectItem[] = Object.entries(PROVIDERS)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, definition]) => ({
        value: provider,
        label: `${definition.name}${provider === currentProvider ? " ← current" : ""}${hasCredentials(provider) ? " ✓" : ""}`,
        description: `mode: ${isRequestInjectionProvider(provider) ? "main-request injection" : "Anthropic server tool"} | auth: ${hasCredentials(provider) ? "yes" : "no"}`,
      }));

    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Providers"))));
      container.addChild(new Text(theme.fg("dim", "✓ = has credentials")));
      container.addChild(new Text(""));
      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      selectList.onSelect = () => {};
      selectList.onCancel = () => done(undefined);
      container.addChild(selectList);
      container.addChild(new Text(theme.fg("dim", "esc close")));

      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  function showConfig(ctx: ExtensionContext): void {
    const provider = getCurrentProvider(ctx);
    const definition = PROVIDERS[provider];
    ctx.ui.notify(
      [
        `Web search: ${searchExtensionConfig.enabled ? "enabled" : "disabled"}`,
        `Provider: ${definition?.name ?? provider ?? "?"} ${definition ? (hasCredentials(provider) ? "✓" : "✗") : "unsupported"}`,
        `Model: ${getCurrentModel(ctx) || "?"}`,
        `Base URL: ${getCurrentBaseUrl(ctx) || "?"}`,
        `Mode: ${definition ? (isRequestInjectionProvider(provider) ? "main-request injection" : "Anthropic server tool") : "unsupported"}`,
      ].join("\n"),
      "info",
    );
  }

  function refresh(ctx: ExtensionContext): void {
    applyToolsConfig(pi, ctx);
    updateStatus(ctx, searchExtensionConfig);
  }

  pi.on("session_start", async (_event, ctx) => refresh(ctx));
  pi.on("model_select", async (_event, ctx) => refresh(ctx));
  pi.on("session_tree", async (_event, ctx) => refresh(ctx));
}
