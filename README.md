# 🌉 LLM Bridge — Turn Any Web Page into an OpenAI-Compatible LLM Provider

[![CI & Deploy](https://github.com/kelvinzer0/llm-bridge-cf/actions/workflows/deploy.yml/badge.svg)](https://github.com/kelvinzer0/llm-bridge-cf/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20Durable%20Objects-orange?logo=cloudflare)](https://workers.cloudflare.com/)
[![OpenAI Compatible](https://img.shields.io/badge/OpenAI-API%20Compatible-412991?logo=openai)](https://platform.openai.com/docs)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178c6?logo=typescript)](https://www.typescriptlang.org/)

> **LLM Bridge** transforms any website (Google Search, Bing, social feeds, documentation, internal dashboards) into an **OpenAI-compatible LLM provider** using a lightweight Chrome Extension and Cloudflare Workers with Durable Objects.

Plug it directly into any OpenAI-compatible client, including **LangChain, LlamaIndex, Cursor, OpenCode, AutoGen, Python/Node SDKs**, or standard `curl`.

---

## 🚀 Key Features

* **⚡ 100% OpenAI API Compatible**:
  - `POST /v1/chat/completions` (full streaming SSE & non-streaming support)
  - `POST /v1/responses` (agentic typed SSE events)
  - `POST /v1/embeddings` (vector generation)
  - `GET /v1/models` & `GET /v1/models/:id` (dynamic model discovery)
* **🌐 Web as an LLM**: Turn any active browser tab into an AI reasoning engine (e.g., query Google search results in real time as an LLM).
* **🔒 Isolated Multi-Tenant Rooms**: Powered by Cloudflare Workers Durable Objects (WebSocket hibernation for zero idle costs).
* **🔑 Simple Bearer Authentication**: Uses standard `Authorization: Bearer <token>_<roomId>`.
* **🔄 Dynamic Model Lifecycle**: Automatically registers and unregisters models (`registerModels`) as you browse different web contexts.
* **✅ Verified in CI**: End-to-end verified on every commit using the **official OpenAI Python SDK**.

---

## 🏛️ Architecture Overview

```text
┌───────────────────────────┐      WebSocket       ┌─────────────────────────────────┐
│     Chrome Extension      │ ───────────────────> │   Cloudflare Worker Gateway     │
│   (Turn Web Pages into    │  registerModels      │       (Durable Objects)         │
│      an LLM Provider)     │ <─────────────────── │  • Room & Model Registry        │
│                           │  completionRequest   │  • Request routing & queueing   │
│  • Google Search          │ ───────────────────> │  • Stream aggregation & SSE     │
│  • Bing Search            │  stream / response   └─────────────────────────────────┘
│  • Custom Web Scrapers    │                                        ▲
└───────────────────────────┘                                        │ OpenAI API (/v1/*)
                                                                     ▼
                                                   ┌─────────────────────────────────┐
                                                   │    Any OpenAI-Compatible Client │
                                                   │  (Python SDK, Cursor, LangChain)│
                                                   └─────────────────────────────────┘
```

---

## ⚡ Quick Start

### 1. Deploy to Cloudflare Workers

Clone the repository and deploy with Wrangler:

```bash
git clone https://github.com/kelvinzer0/llm-bridge-cf.git
cd llm-bridge-cf
npm install
npx wrangler login
npm run deploy
```

Live Demo Worker: `https://llm-bridge.insidexofficial.workers.dev`

### 2. Create an Isolated Session Room

Generate a dedicated room and API key:

```bash
curl -A "Mozilla/5.0" https://llm-bridge.insidexofficial.workers.dev/new
```

Example JSON Response:
```json
{
  "room": "868ff0aa",
  "extension_url": "wss://llm-bridge.insidexofficial.workers.dev/ws/extension?room=868ff0aa",
  "api_base_url": "https://llm-bridge.insidexofficial.workers.dev/v1",
  "api_key": "254f8becef894733bdd4848e_868ff0aa",
  "health_url": "https://llm-bridge.insidexofficial.workers.dev/health?room=868ff0aa"
}
```

### 3. Load the Browser Extension

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the [`extension-example/`](./extension-example) directory.
4. Click the **LLM Bridge** icon in Chrome:
   - Enter your Worker URL (or click **🚀 New Room**).
   - Click **Connect**.
5. Navigate to any page (e.g., `google.com`) — models like `google-search` and `web-extractor` are dynamically registered!

---

## 💻 Usage with Official OpenAI Python SDK

Install the official OpenAI package:

```bash
pip install openai
```

Run standard completions:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://llm-bridge.insidexofficial.workers.dev/v1",
    api_key="YOUR_API_KEY_HERE"  # format: <token>_<roomId>
)

# 1. List available models discovered from your browser
models = client.models.list()
for model in models.data:
    print(f"Discovered: {model.id} (owned by {model.owned_by})")

# 2. Chat Completion (Non-Streaming)
response = client.chat.completions.create(
    model="google-search",
    messages=[{"role": "user", "content": "What are latest developments in quantum computing?"}],
)
print("Response:", response.choices[0].message.content)

# 3. Chat Completion (Streaming SSE)
stream = client.chat.completions.create(
    model="google-search",
    messages=[{"role": "user", "content": "Summarize today's tech news"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)

# 4. Generate Embeddings
embeddings = client.embeddings.create(
    model="web-extractor",
    input=["First text sample", "Second text sample"]
)
print("Vector length:", len(embeddings.data[0].embedding))
```

---

## 📡 REST API Reference

| Endpoint | Method | Headers | Description |
|---|---|---|---|
| `/new` | `GET` | — | Generate new room ID, WebSocket URL, and API key |
| `/v1/models` | `GET` | `Authorization: Bearer <api_key>` | List all active models in the room |
| `/v1/models/:id` | `GET` | `Authorization: Bearer <api_key>` | Get specific model metadata |
| `/v1/chat/completions` | `POST` | `Authorization: Bearer <api_key>` | Chat completions (supports `stream: true/false`) |
| `/v1/responses` | `POST` | `Authorization: Bearer <api_key>` | OpenAI Responses API with typed events |
| `/v1/embeddings` | `POST` | `Authorization: Bearer <api_key>` | Create text embeddings |
| `/ws/extension?room=<id>` | `WebSocket` | — | Chrome extension persistent bridge connection |
| `/health?room=<id>` | `GET` | — | Check connection state & registered model count |

---

## 🔄 Protocol: Extension ↔ Cloudflare Worker

### Extension ➔ Worker (WebSocket)

| Type | Payload Sample | Purpose |
|---|---|---|
| `registerModels` | `{ "type": "registerModels", "models": [{ "id": "google-search" }] }` | Register active models |
| `unregisterModels` | `{ "type": "unregisterModels", "ids": ["google-search"] }` | Deregister inactive models |
| `stream` | `{ "type": "stream", "requestId": "...", "delta": { "content": "..." } }` | Push partial token stream |
| `response` | `{ "type": "response", "requestId": "...", "content": "...", "usage": {...} }` | Finalize request output |
| `embedResult` | `{ "type": "embedResult", "requestId": "...", "embeddings": [[...]] }` | Return calculated vectors |
| `pong` | `{ "type": "pong" }` | Keepalive response |

### Worker ➔ Extension (WebSocket)

| Type | Payload Sample | Purpose |
|---|---|---|
| `completionRequest` | `{ "type": "completionRequest", "requestId": "...", "request": {...} }` | Forward user prompt to extension |
| `responsesRequest` | `{ "type": "responsesRequest", "requestId": "...", "request": {...} }` | Forward Responses API query |
| `embeddingRequest` | `{ "type": "embeddingRequest", "requestId": "...", "request": {...} }` | Forward embedding calculation |
| `ping` | `{ "type": "ping" }` | Health heartbeat |

---

## 🧪 CI & Verification

Every pull request and push to `main` runs automated CI via GitHub Actions:
1. **TypeScript Typecheck** (`npm run typecheck`)
2. **Cloudflare Deployment** via `cloudflare/wrangler-action`
3. **Live E2E Testing** (`test_openai_sdk.py`) validating all endpoints against the official OpenAI Python SDK.

---

## 📜 Derived From & Attribution

Derived and re-architected from [mcp-bridge-cf](https://github.com/kelvinzer0/mcp-bridge-cf). While MCP Bridge routes Model Context Protocol tool calls, **LLM Bridge** translates browser interactions into a standardized **OpenAI LLM Provider**.

## 📄 License

[MIT](LICENSE) © 2026 [Kelvin Andrian](https://github.com/kelvinzer0)
