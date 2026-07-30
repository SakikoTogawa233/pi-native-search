# @sakiko233/pi-native-search

[![npm version](https://img.shields.io/npm/v/@sakiko233/pi-native-search)](https://www.npmjs.com/package/@sakiko233/pi-native-search)
[![license](https://img.shields.io/npm/l/pi-native-search)](LICENSE)

A minimal [Pi](https://github.com/badlogic/pi-mono) extension that enables provider-native web search for OpenAI Codex, Kimi For Coding, and DeepSeek.

## Supported providers

| Provider | Search mode | Auth source |
|---|---|---|
| **OpenAI Codex** | Main-request injection of `{ "type": "web_search" }` | Pi's `openai-codex` OAuth resolver |
| **Kimi For Coding** | Claude Code-style nested Anthropic Messages request declaring `web_search_20250305` | `KIMI_API_KEY` or Kimi OAuth |
| **DeepSeek** | Claude Code-style nested Anthropic Messages request declaring `web_search_20250305` against `https://api.deepseek.com/anthropic` | `DEEPSEEK_API_KEY` |

All other providers are intentionally unsupported.

## Install

```bash
pi install npm:@sakiko233/pi-native-search
```

## Usage

For OpenAI Codex, the extension does not register a client-side search tool. It appends a server-side `{ "type": "web_search" }` entry to the outgoing request's existing tools list and sets `tool_choice` to `auto`:

```json
{
  "tools": [...existingTools, { "type": "web_search" }],
  "tool_choice": "auto"
}
```

Codex keeps full access to its local tools (read, bash, edit, write) while gaining web search. The server-side `web_search` tool produces no client tool card.

For Kimi For Coding and DeepSeek, the extension registers a `web_search` tool. When the main model calls it, the extension sends a nested Anthropic Messages request declaring:

```json
{
  "type": "web_search_20250305",
  "name": "web_search",
  "max_uses": 8
}
```

The provider performs the search server-side and returns text plus search-result blocks, which the extension formats as an ordinary tool result.

## Configuration

```text
/search           # open settings
/search providers # show supported providers
/search config    # print current configuration
/search on        # enable web search
/search off       # disable web search
```

Configuration persists in `~/.pi/agent/search-config.json`.

## Roadmap

- **Selectable search protocol via `/search`**

  Today the search protocol is hardwired per provider. The plan is to decouple provider from protocol so users can choose which protocol each provider uses directly from the `/search` settings UI — e.g. Kimi For Coding and DeepSeek offer the Anthropic server-tool protocol (`web_search_20250305`), while OpenAI Codex offers the OpenAI request-injection protocol (`{ "type": "web_search" }`). This is especially useful for providers that expose multiple compatible endpoints (for example DeepSeek's OpenAI- and Anthropic-compatible APIs).

- **Third-party search tools via MCP**

  Add an option to route search through a third-party search tool exposed via MCP (Model Context Protocol) instead of relying on the active provider's native server-side search, letting users plug in external search backends.

## Development

```bash
npm install --no-save --ignore-scripts typescript
npm run typecheck
```

The extension is a single TypeScript file, `extensions/index.ts`, loaded directly by Pi.

## License

MIT — see [LICENSE](LICENSE).
