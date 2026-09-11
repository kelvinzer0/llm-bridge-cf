// ===================================================================
//  LLM Bridge — Type Definitions
//  Covers Extension↔Worker WebSocket protocol & OpenAI API shapes
// ===================================================================

// ── Model Definition ────────────────────────────────────────────────

export interface ModelDefinition {
  id: string
  name?: string
  owned_by: string
  description?: string
  created?: number
}

// ── Extension → Worker Messages ─────────────────────────────────────

export interface RegisterModelsMessage {
  type: "registerModels"
  models: ModelDefinition[]
}

export interface UnregisterModelsMessage {
  type: "unregisterModels"
  ids: string[]
}

export interface StreamMessage {
  type: "stream"
  requestId: string
  delta: { content: string; role?: string }
}

export interface ResponseMessage {
  type: "response"
  requestId: string
  content: string
  usage?: UsageInfo
}

export interface StreamErrorMessage {
  type: "streamError"
  requestId: string
  error: string
}

export interface EmbedResultMessage {
  type: "embedResult"
  requestId: string
  embeddings: number[][]
  usage?: { prompt_tokens: number; total_tokens: number }
}

export interface PongMessage {
  type: "pong"
}

export type ExtensionMessage =
  | RegisterModelsMessage
  | UnregisterModelsMessage
  | StreamMessage
  | ResponseMessage
  | StreamErrorMessage
  | EmbedResultMessage
  | PongMessage

// ── Worker → Extension Messages ─────────────────────────────────────

export interface CompletionRequestMessage {
  type: "completionRequest"
  requestId: string
  request: ChatCompletionRequest
}

export interface EmbeddingRequestMessage {
  type: "embeddingRequest"
  requestId: string
  request: EmbeddingRequest
}

export interface ResponsesRequestMessage {
  type: "responsesRequest"
  requestId: string
  request: ResponsesAPIRequest
}

export interface PingMessage {
  type: "ping"
}

export type WorkerMessage =
  | CompletionRequestMessage
  | EmbeddingRequestMessage
  | ResponsesRequestMessage
  | PingMessage

// ── OpenAI Chat Completions ─────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "developer"
  content: string
  name?: string
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  stream?: boolean
  stop?: string | string[]
  presence_penalty?: number
  frequency_penalty?: number
  n?: number
  [key: string]: unknown
}

export interface ChatCompletionChoice {
  index: number
  message: { role: "assistant"; content: string }
  finish_reason: "stop" | "length" | "content_filter" | null
}

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage: UsageInfo
}

export interface ChatCompletionChunkChoice {
  index: number
  delta: { role?: string; content?: string }
  finish_reason: "stop" | "length" | "content_filter" | null
}

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: ChatCompletionChunkChoice[]
}

// ── OpenAI Responses API ────────────────────────────────────────────

export interface ResponsesAPIRequest {
  model: string
  input: string | ChatMessage[]
  stream?: boolean
  temperature?: number
  max_output_tokens?: number
  [key: string]: unknown
}

export interface ResponsesAPIResponse {
  id: string
  object: "response"
  created_at: number
  status: "completed" | "in_progress" | "failed"
  model: string
  output: ResponsesOutputItem[]
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number }
}

export interface ResponsesOutputItem {
  type: "message"
  id: string
  role: "assistant"
  content: ResponsesContentPart[]
}

export interface ResponsesContentPart {
  type: "output_text"
  text: string
}

// ── OpenAI Embeddings ───────────────────────────────────────────────

export interface EmbeddingRequest {
  model: string
  input: string | string[]
  dimensions?: number
}

export interface EmbeddingData {
  object: "embedding"
  index: number
  embedding: number[]
}

export interface EmbeddingResponse {
  object: "list"
  data: EmbeddingData[]
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

// ── OpenAI Models ───────────────────────────────────────────────────

export interface ModelObject {
  id: string
  object: "model"
  created: number
  owned_by: string
}

export interface ModelsListResponse {
  object: "list"
  data: ModelObject[]
}

// ── Shared ──────────────────────────────────────────────────────────

export interface UsageInfo {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface OpenAIError {
  error: {
    message: string
    type: string
    code: string | null
    param: string | null
  }
}
