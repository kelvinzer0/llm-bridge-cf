// ===================================================================
//  LLM Bridge — Cloudflare Worker Entry Point
//  Routes requests to the LLMBridge Durable Object
// ===================================================================

export { LLMBridge } from "./bridge"

interface Env {
  LLM_BRIDGE: DurableObjectNamespace
}

// ── Auth helpers ────────────────────────────────────────────────────

/**
 * Parse `Authorization: Bearer <token>_<roomId>` header.
 * Split on the LAST underscore so tokens can contain underscores.
 */
function parseAuth(request: Request): { token: string; room: string } | null {
  const auth = request.headers.get("Authorization")
  if (!auth) return null

  const bearer = auth.replace(/^Bearer\s+/i, "")
  const lastUnderscore = bearer.lastIndexOf("_")
  if (lastUnderscore <= 0) return null

  return {
    token: bearer.slice(0, lastUnderscore),
    room: bearer.slice(lastUnderscore + 1),
  }
}

/** Standard CORS headers */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // ── CORS preflight ──
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS })
    }

    // ── /new — Generate a new room ──
    if (url.pathname === "/new") {
      const roomId = crypto.randomUUID().slice(0, 8)
      const token = crypto.randomUUID().replace(/-/g, "").slice(0, 24)
      const apiKey = `${token}_${roomId}`
      const base = url.origin
      const wsBase = base.replace("https://", "wss://").replace("http://", "ws://")

      return Response.json({
        room: roomId,
        extension_url: `${wsBase}/ws/extension?room=${roomId}`,
        api_base_url: `${base}/v1`,
        api_key: apiKey,
        health_url: `${base}/health?room=${roomId}`,
        usage: {
          curl: `curl ${base}/v1/chat/completions -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"Hello"}]}'`,
          models: `curl ${base}/v1/models -H "Authorization: Bearer ${apiKey}"`,
        },
      }, { headers: CORS })
    }

    // ── Determine room (from auth header or query param) ──
    let room: string | null = null

    // API endpoints use Bearer token
    if (
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/chat/") ||
      url.pathname.startsWith("/responses") ||
      url.pathname.startsWith("/models") ||
      url.pathname.startsWith("/embeddings")
    ) {
      const auth = parseAuth(request)
      if (!auth) {
        return Response.json({
          error: {
            message: "Missing or invalid Authorization header. Expected: Bearer <token>_<roomId>",
            type: "invalid_request_error",
            code: "invalid_api_key",
            param: null,
          },
        }, { status: 401, headers: CORS })
      }
      room = auth.room
    } else {
      // Extension WS and health use query param
      room = url.searchParams.get("room") || "default"
    }

    // ── Forward to Durable Object ──
    const id = env.LLM_BRIDGE.idFromName(room)
    const stub = env.LLM_BRIDGE.get(id)
    const response = await stub.fetch(request)

    // Add CORS headers (skip for WebSocket 101 responses)
    if (response.status !== 101) {
      const headers = new Headers(response.headers)
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    }

    return response
  },
}
