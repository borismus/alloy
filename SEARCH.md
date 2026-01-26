# Local SearXNG Setup

This guide sets up a local SearXNG instance for web search.

## Prerequisites

- Docker Desktop installed and running

## Setup

### 1. Create config directory

```bash
mkdir -p ~/.searxng
```

### 2. Create settings file

Create `~/.searxng/settings.yml`:

```yaml
use_default_settings: true

search:
  formats:
    - html
    - json

server:
  secret_key: "promptbox-searxng-local"
  limiter: false
```

### 3. Start SearXNG

```bash
docker run -d \
  --name searxng \
  -p 7731:8080 \
  -v ~/.searxng:/etc/searxng \
  searxng/searxng
```

### 4. Configure PromptBox

Add to your vault's `config.yaml`:

```yaml
SEARCH_PROVIDER: searxng
SEARXNG_URL: http://localhost:7731
```

### 5. Verify

```bash
curl "http://localhost:7731/search?q=test&format=json"
```

You should see JSON output with search results.

## Managing the Instance

```bash
# Stop
docker stop searxng

# Start (after stopping)
docker start searxng

# Remove completely
docker rm -f searxng

# View logs
docker logs searxng
```

## Troubleshooting

**Container won't start:**
```bash
docker rm -f searxng
docker run -d --name searxng -p 7731:8080 -v ~/.searxng:/etc/searxng searxng/searxng
```

**JSON returns HTML error:**
Ensure `settings.yml` includes `json` in the `formats` list and restart:
```bash
docker restart searxng
```
