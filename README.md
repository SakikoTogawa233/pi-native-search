# @sakikotogawa/pi-native-search

[![npm version](https://img.shields.io/npm/v/@sakikotogawa/pi-native-search)](https://www.npmjs.com/package/@sakikotogawa/pi-native-search)
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
pi install npm:@sakikotogawa/pi-native-search
```

## Usage

For OpenAI Codex, the extension does not register a client-side search tool. It rewrites the outgoing request to:

```json
{
  "tools": [{ "type": "web_search" }],
  "tool_choice": "auto"
}
```

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

## Development

```bash
npm install --no-save --ignore-scripts typescript
npm run typecheck
```

The extension is a single TypeScript file, `extensions/index.ts`, loaded directly by Pi.

## License

MIT — see [LICENSE](LICENSE).
