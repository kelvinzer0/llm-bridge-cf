// ===================================================================
//  LLM Bridge — Durable Object
//  Bridges Chrome extension (WebSocket) ↔ OpenAI-compatible HTTP API
// ===================================================================

import { DurableObject } from "cloudflare:workers"
import type {
  ModelDefinition, ModelObject, ModelsListResponse,
  ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk,
  EmbeddingRequest, EmbeddingResponse,
  ResponsesAPIRequest, ResponsesAPIResponse, ResponsesOutputItem, ResponsesContentPart,
  UsageInfo, OpenAIError,
} from "./types"

interface PendingRequest {
  resolve: Function
  reject: Function
  timer: ReturnType<typeof setTimeout>
  // For streaming: SSE writer + state
  writer?: WritableStreamDefaultWriter<Uint8Array>
  encoder?: TextEncoder
  model?: string
  completionId?: string
  created?: number
  fullContent?: string
  streaming?: boolean
}

export class LLMBridge extends DurableObject {
  // ── In-memory state (survives only within a single DO instance) ──
  private models = new Map<string, ModelDefinition>()
  private extensionWs: WebSocket | null = null
  private extensionConnected = false
  private pendingRequests = new Map<string, PendingRequest>()
  private stateRestored = false

  // ── Restore persisted state on wake ───────────────────────────────
  private async restoreState(): Promise<void> {
    if (this.stateRestored) return
    this.stateRestored = true
    try {
      const stored = await this.ctx.storage.get<Record<string, ModelDefinition>>("models")
      if (stored) {
        for (const [k, v] of Object.entries(stored)) this.models.set(k, v)
      }
      const sockets = this.ctx.getWebSockets()
      if (sockets.length > 0) {
        this.extensionWs = sockets[0]
        this.extensionConnected = true
      } else {
        this.extensionConnected = false
        this.extensionWs = null
      }
    } catch {}
  }

  // ── HTTP Fetch Handler ────────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    await this.restoreState()
    const url = new URL(request.url)

    // Health check
    if (url.pathname === "/health" || url.pathname.endsWith("/health")) {
      const sockets = this.ctx.getWebSockets()
      return Response.json({
        status: "ok",
        extensionConnected: sockets.length > 0,
        modelsRegistered: this.models.size,
        models: Array.from(this.models.keys()),
      })
    }

    // WebSocket upgrade for extension
    if (url.pathname === "/ws/extension" || url.pathname.endsWith("/ws/extension")) {
      const upgrade = request.headers.get("Upgrade")
      if (upgrade !== "websocket") return new Response("Expected websocket", { status: 426 })

      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      this.extensionWs = pair[1]
      this.extensionConnected = true

      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    // ── OpenAI-compatible API routes ──

    // POST /v1/chat/completions
    if ((url.pathname === "/v1/chat/completions" || url.pathname.endsWith("/v1/chat/completions")) && request.method === "POST") {
      return this.handleCompletions(request)
    }

    // POST /v1/responses
    if ((url.pathname === "/v1/responses" || url.pathname.endsWith("/v1/responses")) && request.method === "POST") {
      return this.handleResponses(request)
    }

    // POST /v1/embeddings
    if ((url.pathname === "/v1/embeddings" || url.pathname.endsWith("/v1/embeddings")) && request.method === "POST") {
      return this.handleEmbeddings(request)
    }

    // GET /v1/models or /v1/models/:id
    if (url.pathname.match(/\/v1\/models(\/.*)?$/) && request.method === "GET") {
      const modelIdMatch = url.pathname.match(/\/v1\/models\/(.+)$/)
      if (modelIdMatch) {
        return this.handleRetrieveModel(modelIdMatch[1])
      }
      return this.handleModels()
    }

    return Response.json(
      { error: { message: "Not Found", type: "invalid_request_error", code: null, param: null } } satisfies OpenAIError,
      { status: 404 }
    )
  }

  // ── WebSocket: Hibernation callbacks ──────────────────────────────

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.restoreState()
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message)
      const msg = JSON.parse(text)

      switch (msg.type) {
        case "registerModels": {
          for (const m of msg.models) {
            this.models.set(m.id, { ...m, created: m.created || Math.floor(Date.now() / 1000) })
          }
          await this.ctx.storage.put("models", Object.fromEntries(this.models))
          break
        }

        case "unregisterModels": {
          for (const id of msg.ids) this.models.delete(id)
          await this.ctx.storage.put("models", Object.fromEntries(this.models))
          break
        }

        case "stream": {
          const p = this.pendingRequests.get(msg.requestId)
          if (!p || !p.streaming || !p.writer || !p.encoder) break
          const deltaContent = msg.delta?.content || ""
          p.fullContent = (p.fullContent || "") + deltaContent

          if ((p as any).isResponsesApi) {
            // Responses API: emit typed content_part.delta event
            const writeEvent = (p as any).writeEvent as (event: string, data: unknown) => void
            writeEvent("response.content_part.delta", {
              type: "response.content_part.delta",
              output_index: 0,
              content_index: 0,
              delta: { type: "text_delta", text: deltaContent },
            })
          } else {
            // Chat Completions: emit standard SSE chunk
            const chunk: ChatCompletionChunk = {
              id: p.completionId!,
              object: "chat.completion.chunk",
              created: p.created!,
              model: p.model!,
              choices: [{
                index: 0,
                delta: { content: deltaContent },
                finish_reason: null,
              }],
            }
            await p.writer.write(p.encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          }
          break
        }

        case "response": {
          const p = this.pendingRequests.get(msg.requestId)
          if (!p) break
          clearTimeout(p.timer)
          this.pendingRequests.delete(msg.requestId)
          const finalContent = msg.content || p.fullContent || ""

          if (p.streaming && p.writer && p.encoder) {
            if ((p as any).isResponsesApi) {
              // Responses API: emit completion events
              const writeEvent = (p as any).writeEvent as (event: string, data: unknown) => void
              const messageId = (p as any).messageId as string
              const responseId = (p as any).responseId as string
              const usage = msg.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

              writeEvent("response.content_part.done", {
                type: "response.content_part.done", output_index: 0, content_index: 0,
                part: { type: "output_text", text: finalContent },
              })
              writeEvent("response.output_item.done", {
                type: "response.output_item.done", output_index: 0,
                item: {
                  type: "message", id: messageId, role: "assistant",
                  content: [{ type: "output_text", text: finalContent }],
                },
              })
              writeEvent("response.completed", {
                type: "response.completed",
                response: {
                  id: responseId, object: "response", created_at: p.created!,
                  status: "completed", model: p.model!,
                  output: [{
                    type: "message", id: messageId, role: "assistant",
                    content: [{ type: "output_text", text: finalContent }],
                  }],
                  usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
                },
              })
              await p.writer.close()
            } else {
              // Chat Completions: send final chunk with finish_reason
              const finalChunk: ChatCompletionChunk = {
                id: p.completionId!,
                object: "chat.completion.chunk",
                created: p.created!,
                model: p.model!,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              }
              await p.writer.write(p.encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`))
              await p.writer.write(p.encoder.encode(`data: [DONE]\n\n`))
              await p.writer.close()
            }
          } else {
            // Non-streaming: resolve the promise with a full response
            p.resolve({
              content: finalContent,
              usage: msg.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            })
          }
          break
        }

        case "streamError": {
          const p = this.pendingRequests.get(msg.requestId)
          if (!p) break
          clearTimeout(p.timer)
          this.pendingRequests.delete(msg.requestId)

          if (p.streaming && p.writer && p.encoder) {
            const errEvent = { error: { message: msg.error, type: "server_error", code: null, param: null } }
            await p.writer.write(p.encoder.encode(`data: ${JSON.stringify(errEvent)}\n\n`))
            await p.writer.write(p.encoder.encode(`data: [DONE]\n\n`))
            await p.writer.close()
          } else {
            p.reject(new Error(msg.error))
          }
          break
        }

        case "embedResult": {
          const p = this.pendingRequests.get(msg.requestId)
          if (!p) break
          clearTimeout(p.timer)
          this.pendingRequests.delete(msg.requestId)
          p.resolve({
            embeddings: msg.embeddings || [],
            usage: msg.usage || { prompt_tokens: 0, total_tokens: 0 },
          })
          break
        }

        case "pong":
          break
      }
    } catch {}
  }

  async webSocketClose(): Promise<void> {
    this.extensionConnected = false
    this.extensionWs = null
    this.models.clear()
    await this.ctx.storage.delete("models")
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer)
      p.reject(new Error("Extension disconnected"))
    }
    this.pendingRequests.clear()
  }

  async webSocketError(): Promise<void> {
    await this.webSocketClose()
  }

  // ── /v1/chat/completions ──────────────────────────────────────────

  private async handleCompletions(request: Request): Promise<Response> {
    let body: ChatCompletionRequest
    try { body = await request.json() as ChatCompletionRequest } catch {
      return this.errorResponse("Invalid JSON body", 400)
    }

    if (!body.model) return this.errorResponse("'model' is required", 400)
    if (!body.messages || !Array.isArray(body.messages)) return this.errorResponse("'messages' is required", 400)
    if (!this.models.has(body.model)) return this.errorResponse(`Model '${body.model}' not found`, 404)

    const activeWs = this.getActiveWs()
    if (!activeWs) return this.errorResponse("Extension not connected", 503)

    const requestId = crypto.randomUUID()
    const completionId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`
    const created = Math.floor(Date.now() / 1000)

    // Forward to extension
    activeWs.send(JSON.stringify({
      type: "completionRequest",
      requestId,
      request: body,
    }))

    if (body.stream) {
      // ── Streaming response via SSE ──
      const { readable, writable } = new TransformStream<Uint8Array>()
      const writer = writable.getWriter()
      const encoder = new TextEncoder()

      // Send initial chunk with role
      const initChunk: ChatCompletionChunk = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }

      this.pendingRequests.set(requestId, {
        resolve: () => {},
        reject: (err: Error) => {
          writer.write(encoder.encode(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`)).catch(() => {})
          writer.write(encoder.encode(`data: [DONE]\n\n`)).catch(() => {})
          writer.close().catch(() => {})
        },
        timer: setTimeout(() => {
          this.pendingRequests.delete(requestId)
          writer.write(encoder.encode(`data: ${JSON.stringify({ error: { message: "Timeout" } })}\n\n`)).catch(() => {})
          writer.write(encoder.encode(`data: [DONE]\n\n`)).catch(() => {})
          writer.close().catch(() => {})
        }, 120_000),
        writer,
        encoder,
        model: body.model,
        completionId,
        created,
        fullContent: "",
        streaming: true,
      })

      // Write the initial role chunk
      writer.write(encoder.encode(`data: ${JSON.stringify(initChunk)}\n\n`)).catch(() => {})

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      })
    } else {
      // ── Non-streaming response ──
      try {
        const result = await new Promise<{ content: string; usage: UsageInfo }>((resolve, reject) => {
          this.pendingRequests.set(requestId, {
            resolve,
            reject,
            timer: setTimeout(() => {
              this.pendingRequests.delete(requestId)
              reject(new Error("Timeout"))
            }, 120_000),
            model: body.model,
            completionId,
            created,
            fullContent: "",
            streaming: false,
          })
        })

        const response: ChatCompletionResponse = {
          id: completionId,
          object: "chat.completion",
          created,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }],
          usage: result.usage,
        }
        return Response.json(response)
      } catch (err) {
        return this.errorResponse((err as Error).message, 500)
      }
    }
  }

  // ── /v1/responses ─────────────────────────────────────────────────

  private async handleResponses(request: Request): Promise<Response> {
    let body: ResponsesAPIRequest
    try { body = await request.json() as ResponsesAPIRequest } catch {
      return this.errorResponse("Invalid JSON body", 400)
    }

    if (!body.model) return this.errorResponse("'model' is required", 400)
    if (!body.input) return this.errorResponse("'input' is required", 400)
    if (!this.models.has(body.model)) return this.errorResponse(`Model '${body.model}' not found`, 404)

    const activeWs = this.getActiveWs()
    if (!activeWs) return this.errorResponse("Extension not connected", 503)

    const requestId = crypto.randomUUID()
    const responseId = `resp_${crypto.randomUUID().slice(0, 12)}`
    const messageId = `msg_${crypto.randomUUID().slice(0, 12)}`
    const createdAt = Math.floor(Date.now() / 1000)

    // Forward to extension
    activeWs.send(JSON.stringify({
      type: "responsesRequest",
      requestId,
      request: body,
    }))

    if (body.stream) {
      // ── Streaming Responses API via SSE ──
      const { readable, writable } = new TransformStream<Uint8Array>()
      const writer = writable.getWriter()
      const encoder = new TextEncoder()

      const writeEvent = (event: string, data: unknown) =>
        writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {})

      // Emit initial events
      const initialResponse: ResponsesAPIResponse = {
        id: responseId, object: "response", created_at: createdAt,
        status: "in_progress", model: body.model, output: [],
      }
      writeEvent("response.created", { type: "response.created", response: initialResponse })
      writeEvent("response.in_progress", { type: "response.in_progress", response: initialResponse })

      // Output item added
      const outputItem: ResponsesOutputItem = {
        type: "message", id: messageId, role: "assistant", content: [],
      }
      writeEvent("response.output_item.added", {
        type: "response.output_item.added", output_index: 0, item: outputItem,
      })

      // Content part added
      const emptyPart: ResponsesContentPart = { type: "output_text", text: "" }
      writeEvent("response.content_part.added", {
        type: "response.content_part.added", output_index: 0, content_index: 0, part: emptyPart,
      })

      this.pendingRequests.set(requestId, {
        resolve: () => {},
        reject: (err: Error) => {
          writeEvent("response.failed", {
            type: "response.failed",
            response: { ...initialResponse, status: "failed", error: { message: err.message } },
          })
          writer.close().catch(() => {})
        },
        timer: setTimeout(() => {
          this.pendingRequests.delete(requestId)
          writer.close().catch(() => {})
        }, 120_000),
        writer,
        encoder,
        model: body.model,
        completionId: responseId,
        created: createdAt,
        fullContent: "",
        streaming: true,
      })

      // Override the default stream handler — we need Responses-format events
      // We'll handle this specially in webSocketMessage by checking completionId prefix
      // Actually, we store extra metadata to differentiate
      const pending = this.pendingRequests.get(requestId)!
      // Tag as responses-style with a custom field
      ;(pending as any).isResponsesApi = true
      ;(pending as any).messageId = messageId
      ;(pending as any).responseId = responseId
      ;(pending as any).writeEvent = writeEvent

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      })
    } else {
      // ── Non-streaming Responses API ──
      try {
        const result = await new Promise<{ content: string; usage: UsageInfo }>((resolve, reject) => {
          this.pendingRequests.set(requestId, {
            resolve,
            reject,
            timer: setTimeout(() => {
              this.pendingRequests.delete(requestId)
              reject(new Error("Timeout"))
            }, 120_000),
            streaming: false,
            fullContent: "",
          })
        })

        const response: ResponsesAPIResponse = {
          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "completed",
          model: body.model,
          output: [{
            type: "message",
            id: messageId,
            role: "assistant",
            content: [{ type: "output_text", text: result.content }],
          }],
          usage: {
            input_tokens: result.usage.prompt_tokens,
            output_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          },
        }
        return Response.json(response)
      } catch (err) {
        return this.errorResponse((err as Error).message, 500)
      }
    }
  }

  // ── /v1/embeddings ────────────────────────────────────────────────

  private async handleEmbeddings(request: Request): Promise<Response> {
    let body: EmbeddingRequest
    try { body = await request.json() as EmbeddingRequest } catch {
      return this.errorResponse("Invalid JSON body", 400)
    }

    if (!body.model) return this.errorResponse("'model' is required", 400)
    if (!body.input) return this.errorResponse("'input' is required", 400)
    if (!this.models.has(body.model)) return this.errorResponse(`Model '${body.model}' not found`, 404)

    const activeWs = this.getActiveWs()
    if (!activeWs) return this.errorResponse("Extension not connected", 503)

    const requestId = crypto.randomUUID()

    activeWs.send(JSON.stringify({
      type: "embeddingRequest",
      requestId,
      request: body,
    }))

    try {
      const result = await new Promise<{ embeddings: number[][]; usage: { prompt_tokens: number; total_tokens: number } }>((resolve, reject) => {
        this.pendingRequests.set(requestId, {
          resolve,
          reject,
          timer: setTimeout(() => {
            this.pendingRequests.delete(requestId)
            reject(new Error("Timeout"))
          }, 60_000),
          streaming: false,
        })
      })

      const response: EmbeddingResponse = {
        object: "list",
        data: result.embeddings.map((emb, i) => ({
          object: "embedding" as const,
          index: i,
          embedding: emb,
        })),
        model: body.model,
        usage: result.usage,
      }
      return Response.json(response)
    } catch (err) {
      return this.errorResponse((err as Error).message, 500)
    }
  }

  // ── /v1/models ────────────────────────────────────────────────────

  private handleModels(): Response {
    const data: ModelObject[] = Array.from(this.models.values()).map(m => ({
      id: m.id,
      object: "model" as const,
      created: m.created || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by,
    }))
    const response: ModelsListResponse = { object: "list", data }
    return Response.json(response)
  }

  private handleRetrieveModel(modelId: string): Response {
    const m = this.models.get(modelId)
    if (!m) return this.errorResponse(`Model '${modelId}' not found`, 404)
    const obj: ModelObject = {
      id: m.id,
      object: "model",
      created: m.created || Math.floor(Date.now() / 1000),
      owned_by: m.owned_by,
    }
    return Response.json(obj)
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private getActiveWs(): WebSocket | null {
    const sockets = this.ctx.getWebSockets()
    return sockets.length > 0 ? sockets[0] : null
  }

  private errorResponse(message: string, status: number): Response {
    const body: OpenAIError = {
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code: null,
        param: null,
      },
    }
    return Response.json(body, { status })
  }
}
