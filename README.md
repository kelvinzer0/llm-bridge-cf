# LLM Bridge — Turn Any Web Page Into an LLM Provider

An OpenAI-compatible API bridge powered by Cloudflare Workers Durable Objects. Connect a Chrome extension, register "models" from web pages, and expose them via standard `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`, and `/v1/models` endpoints.

> **Idea:** Imagine making Google Search, Bing, or any web-based AI into an OpenAI-compatible LLM that any tool can use.

## How It Works

```
┌─────────────────┐  WebSocket   ┌──────────────────────┐  OpenAI API  ┌──────────────┐
│  Web Page        │ ───────────→ │  Cloudflare Worker   │ ←──────────→ │  Any OpenAI  │
│  (Extension      │  register    │  (Durable Object)    │              │  Client      │
│   turns page     │  models      │                      │ /v1/chat/    │  (curl,      │
│   into LLM)      │              │  LLM Bridge          │ completions  │   Python,    │
│                  │  stream      │  + model registry    │ /v1/models   │   Node.js,   │
│  process         │  response    │  + request routing   │ /v1/embed    │   etc.)      │
│  queries         │←─────────────│  forward requests    │              │              │
└─────────────────┘              └──────────────────────┘              └──────────────┘
```

## Quick Start

### 1. Deploy

```bash
git clone https://github.com/kelvinzer0/llm-bridge-cf
cd llm-bridge-cf
npm install
npx wrangler login
npm run deploy
```

### 2. Create a Room

```bash
curl https://llm-bridge.<subdomain>.workers.dev/new
```

Response:
```json
{
  "room": "ab1fe4c7",
  "extension_url": "wss://llm-bridge.<subdomain>.workers.dev/ws/extension?room=ab1fe4c7",
  "api_base_url": "https://llm-bridge.<subdomain>.workers.dev/v1",
  "api_key": "a1b2c3d4e5f6g7h8i9j0k1l2_ab1fe4c7",
  "health_url": "https://llm-bridge.<subdomain>.workers.dev/health?room=ab1fe4c7"
}
```

### 3. Load the Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select `extension-example/`
4. Click the extension icon → enter your worker URL → "New Room"
5. Navigate to google.com — the extension auto-registers `google-search` and `web-extractor` models

### 4. Use the API

```bash
# List models
curl https://llm-bridge.<subdomain>.workers.dev/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"

# Chat completion
curl https://llm-bridge.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google-search",
    "messages": [{"role": "user", "content": "What is Cloudflare Workers?"}]
  }'

# Streaming
curl https://llm-bridge.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google-search",
    "messages": [{"role": "user", "content": "What is Cloudflare Workers?"}],
    "stream": true
  }'
```

### 5. Use with OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://llm-bridge.<subdomain>.workers.dev/v1",
    api_key="YOUR_API_KEY",
)

# List models
models = client.models.list()
for model in models:
    print(model.id)

# Chat completion
response = client.chat.completions.create(
    model="google-search",
    messages=[{"role": "user", "content": "What is Cloudflare Workers?"}],
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="web-extractor",
    messages=[{"role": "user", "content": "Summarize this page"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/new` | GET | Generate new room + API key |
| `/v1/chat/completions` | POST | Chat completions (OpenAI compatible) |
| `/v1/responses` | POST | Responses API (OpenAI compatible) |
| `/v1/embeddings` | POST | Embeddings (OpenAI compatible) |
| `/v1/models` | GET | List registered models |
| `/v1/models/:id` | GET | Get single model info |
| `/ws/extension?room=<id>` | WebSocket | Extension connects here |
| `/health?room=<id>` | GET | Room status |

## Authentication

The API key format is `<token>_<roomId>`:
- Token part is for authentication
- Room ID part routes to the correct Durable Object
- Passed via `Authorization: Bearer <api_key>` header

Example: `Bearer abc123def456_a1b2c3d4` → token=`abc123def456`, room=`a1b2c3d4`

## Extension ↔ Bridge Protocol

### Extension → Bridge (WebSocket)

| Message | Description |
|---------|-------------|
| `{ type: "registerModels", models: [...] }` | Register available LLM models |
| `{ type: "unregisterModels", ids: [...] }` | Remove models |
| `{ type: "stream", requestId, delta: { content } }` | Stream partial response |
| `{ type: "response", requestId, content, usage }` | Complete response |
| `{ type: "streamError", requestId, error }` | Report error |
| `{ type: "embedResult", requestId, embeddings, usage }` | Return embeddings |
| `{ type: "pong" }` | Keepalive response |

### Bridge → Extension (WebSocket)

| Message | Description |
|---------|-------------|
| `{ type: "completionRequest", requestId, request }` | Handle chat completion |
| `{ type: "responsesRequest", requestId, request }` | Handle Responses API |
| `{ type: "embeddingRequest", requestId, request }` | Handle embedding |
| `{ type: "ping" }` | Keepalive |

## Context-Aware Models

The extension auto-detects the current page and registers appropriate models:

| Page | Model ID | Description |
|------|----------|-------------|
| google.com | `google-search` | Searches Google and returns results |
| bing.com | `bing-search` | Searches Bing and returns results |
| duckduckgo.com | `duckduckgo-search` | Searches DuckDuckGo |
| Any page | `web-extractor` | Extracts and returns page content |

## Development

```bash
npm run dev       # Local dev with wrangler
npm run typecheck # Type checking
npm run deploy    # Deploy to Cloudflare
```

## Derived From

This project is derived from [mcp-bridge-cf](https://github.com/kelvinzer0/mcp-bridge-cf), transforming the MCP protocol bridge into an OpenAI-compatible LLM API bridge.

## License

MIT
