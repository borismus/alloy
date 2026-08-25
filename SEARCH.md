# Web Search Setup

Alloy's built-in `web_search` tool uses [Serper](https://serper.dev/) to query
Google Search. This is separate from sidebar vault search, which needs no API key
and runs locally through `GET /api/search`.

## Configure Serper

1. Create a Serper account and API key at <https://serper.dev/>.
2. Add the key at the top level of your vault's `config.yaml`:

```yaml
version: 2

# providers: ...

serperApiKey: your-serper-key
```

3. Restart Alloy after changing `config.yaml`.

The key remains in the vault and is sent only to Serper when a model calls
`web_search`.

## Verify

Ask a tool-capable model to search the web, or invoke a skill that calls
`web_search`. A successful call appears as a search pill in the response.

Claude and Codex subscription adapters may also invoke native web tools supplied
by their CLIs. Those searches do not use `serperApiKey`; Alloy still surfaces
them as tool pills.

## Troubleshooting

- **`SERPER_API_KEY not configured`** — add `serperApiKey` exactly as shown
  above and restart the backend.
- **401/403 from Serper** — verify the key and account status.
- **No search pill** — explicit `/skill-name` invocation is deterministic;
  autonomous tool selection remains model-dependent.

SearXNG configuration is not currently supported by the Rust backend.
