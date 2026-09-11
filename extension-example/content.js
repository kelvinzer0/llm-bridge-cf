/**
 * LLM Bridge — Content Script
 *
 * Runs in every page. Detects context and registers appropriate LLM models.
 * Handles completion, embedding, and responses API requests by interacting
 * with the page content and streaming results back.
 */

// ============================================================
//  PAGE CONTEXT DETECTION
// ============================================================

function detectContext() {
  const hostname = window.location.hostname
  if (hostname.includes("google.com") && !hostname.includes("docs.google") && !hostname.includes("mail.google")) return "google"
  if (hostname.includes("bing.com")) return "bing"
  if (hostname.includes("duckduckgo.com")) return "duckduckgo"
  return "generic"
}

// ============================================================
//  MODEL DEFINITIONS PER CONTEXT
// ============================================================

function getModelsForContext(context) {
  const models = {
    google: [
      {
        id: "google-search",
        name: "Google Search",
        owned_by: "llm-bridge-extension",
        description: "Uses Google Search to answer queries — searches and extracts results from google.com",
      },
    ],
    bing: [
      {
        id: "bing-search",
        name: "Bing Search",
        owned_by: "llm-bridge-extension",
        description: "Uses Bing Search to answer queries",
      },
    ],
    duckduckgo: [
      {
        id: "duckduckgo-search",
        name: "DuckDuckGo Search",
        owned_by: "llm-bridge-extension",
        description: "Uses DuckDuckGo Search to answer queries",
      },
    ],
    generic: [],
  }

  // Always include a web-extractor model on any page
  const base = [
    {
      id: "web-extractor",
      name: "Web Content Extractor",
      owned_by: "llm-bridge-extension",
      description: "Extracts and summarizes content from the current web page",
    },
  ]

  return [...base, ...(models[context] || [])]
}

// ============================================================
//  REQUEST HANDLERS
// ============================================================

/**
 * Handle a chat completion request.
 * Extracts the last user message, interacts with the page based on context,
 * and streams back the response.
 */
async function handleCompletionRequest(requestId, request) {
  try {
    const messages = request.messages || []
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user")
    const query = lastUserMsg?.content || ""
    const shouldStream = request.stream !== false

    if (!query) {
      chrome.runtime.sendMessage({
        type: "response", requestId,
        content: "No user message provided.",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      })
      return
    }

    const context = detectContext()
    let resultText = ""

    if (context === "google" && request.model === "google-search") {
      resultText = await executeGoogleSearch(query, requestId, shouldStream)
    } else if (context === "bing" && request.model === "bing-search") {
      resultText = await executeBingSearch(query, requestId, shouldStream)
    } else if (context === "duckduckgo" && request.model === "duckduckgo-search") {
      resultText = await executeDuckDuckGoSearch(query, requestId, shouldStream)
    } else {
      // web-extractor: extract page content and provide it as context
      resultText = await executeWebExtraction(query, requestId, shouldStream)
    }

    // Estimate token usage
    const promptTokens = Math.ceil(query.length / 4)
    const completionTokens = Math.ceil(resultText.length / 4)

    chrome.runtime.sendMessage({
      type: "response", requestId,
      content: resultText,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    })
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "streamError", requestId,
      error: err.message || "Unknown error in content script",
    })
  }
}

/**
 * Handle an embedding request.
 * Generates a simple word-frequency based embedding vector.
 */
function handleEmbeddingRequest(requestId, request) {
  try {
    const inputs = Array.isArray(request.input) ? request.input : [request.input]
    const dimensions = request.dimensions || 256
    const embeddings = inputs.map(text => generateSimpleEmbedding(text, dimensions))

    const totalTokens = inputs.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)

    chrome.runtime.sendMessage({
      type: "embedResult", requestId,
      embeddings,
      usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
    })
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "streamError", requestId,
      error: err.message || "Embedding error",
    })
  }
}

/**
 * Handle a Responses API request.
 * Delegates to the same logic as completions.
 */
async function handleResponsesRequest(requestId, request) {
  try {
    // Convert Responses API input to messages format
    let query = ""
    if (typeof request.input === "string") {
      query = request.input
    } else if (Array.isArray(request.input)) {
      const lastUser = [...request.input].reverse().find(m => m.role === "user")
      query = lastUser?.content || ""
    }

    const shouldStream = request.stream !== false
    const context = detectContext()
    let resultText = ""

    if (context === "google" && request.model === "google-search") {
      resultText = await executeGoogleSearch(query, requestId, shouldStream)
    } else if (context === "bing" && request.model === "bing-search") {
      resultText = await executeBingSearch(query, requestId, shouldStream)
    } else {
      resultText = await executeWebExtraction(query, requestId, shouldStream)
    }

    const promptTokens = Math.ceil(query.length / 4)
    const completionTokens = Math.ceil(resultText.length / 4)

    chrome.runtime.sendMessage({
      type: "response", requestId,
      content: resultText,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    })
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "streamError", requestId,
      error: err.message || "Responses API error",
    })
  }
}

// ============================================================
//  SEARCH ENGINE IMPLEMENTATIONS
// ============================================================

/**
 * Google Search: type query into search box, submit, and extract results.
 * Streams results incrementally if streaming is enabled.
 */
async function executeGoogleSearch(query, requestId, shouldStream) {
  // Find the search input
  const searchInput = document.querySelector('input[name="q"], textarea[name="q"]')
  if (!searchInput) {
    return extractPageContent(query)
  }

  // Type the query and submit
  searchInput.value = query
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  searchInput.form?.submit()

  // Wait for results to load
  await waitForElement("#search, #rso, .g", 10000)
  await sleep(1000)

  // Extract search results
  const results = extractGoogleResults()
  const formatted = formatSearchResults(results, query)

  // Stream the results if needed
  if (shouldStream) {
    await streamText(requestId, formatted)
  }

  return formatted
}

async function executeBingSearch(query, requestId, shouldStream) {
  const searchInput = document.querySelector('#sb_form_q, input[name="q"]')
  if (!searchInput) return extractPageContent(query)

  searchInput.value = query
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  searchInput.form?.submit()

  await waitForElement("#b_results, .b_algo", 10000)
  await sleep(1000)

  const results = extractBingResults()
  const formatted = formatSearchResults(results, query)

  if (shouldStream) await streamText(requestId, formatted)
  return formatted
}

async function executeDuckDuckGoSearch(query, requestId, shouldStream) {
  const searchInput = document.querySelector('#searchbox_input, input[name="q"]')
  if (!searchInput) return extractPageContent(query)

  searchInput.value = query
  searchInput.dispatchEvent(new Event("input", { bubbles: true }))
  searchInput.form?.submit()

  await waitForElement('[data-testid="result"], .result', 10000)
  await sleep(1000)

  const results = extractDuckDuckGoResults()
  const formatted = formatSearchResults(results, query)

  if (shouldStream) await streamText(requestId, formatted)
  return formatted
}

/**
 * Web Extractor: extract page content and present it as a response
 */
async function executeWebExtraction(query, requestId, shouldStream) {
  const pageContent = extractPageContent(query)

  if (shouldStream) await streamText(requestId, pageContent)
  return pageContent
}

// ============================================================
//  RESULT EXTRACTORS
// ============================================================

function extractGoogleResults() {
  const results = []
  const items = document.querySelectorAll("#rso .g, #search .g")

  for (const item of Array.from(items).slice(0, 10)) {
    const titleEl = item.querySelector("h3")
    const linkEl = item.querySelector("a[href]")
    const snippetEl = item.querySelector(".VwiC3b, .lEBKkf, [data-sncf]")

    if (titleEl) {
      results.push({
        title: titleEl.textContent?.trim() || "",
        url: linkEl?.getAttribute("href") || "",
        snippet: snippetEl?.textContent?.trim() || "",
      })
    }
  }

  // Also try featured snippets
  const featured = document.querySelector(".hgKElc, .IZ6rdc")
  if (featured) {
    results.unshift({
      title: "Featured Snippet",
      url: "",
      snippet: featured.textContent?.trim() || "",
    })
  }

  return results
}

function extractBingResults() {
  const results = []
  const items = document.querySelectorAll(".b_algo")

  for (const item of Array.from(items).slice(0, 10)) {
    const titleEl = item.querySelector("h2 a")
    const snippetEl = item.querySelector(".b_caption p, .b_lineclamp2")

    if (titleEl) {
      results.push({
        title: titleEl.textContent?.trim() || "",
        url: titleEl.getAttribute("href") || "",
        snippet: snippetEl?.textContent?.trim() || "",
      })
    }
  }
  return results
}

function extractDuckDuckGoResults() {
  const results = []
  const items = document.querySelectorAll('[data-testid="result"], article.result')

  for (const item of Array.from(items).slice(0, 10)) {
    const titleEl = item.querySelector("h2 a, a[data-testid='result-title-a']")
    const snippetEl = item.querySelector('[data-result="snippet"], .result__snippet')

    if (titleEl) {
      results.push({
        title: titleEl.textContent?.trim() || "",
        url: titleEl.getAttribute("href") || "",
        snippet: snippetEl?.textContent?.trim() || "",
      })
    }
  }
  return results
}

function extractPageContent(query) {
  const title = document.title
  const url = window.location.href
  const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute("content") || ""

  // Extract main content
  const contentSelectors = [
    "article", "main", "[role='main']",
    ".content", "#content", ".post-content",
    ".article-body", ".entry-content",
  ]

  let mainContent = ""
  for (const sel of contentSelectors) {
    const el = document.querySelector(sel)
    if (el) {
      mainContent = el.textContent?.trim() || ""
      break
    }
  }

  if (!mainContent) {
    mainContent = document.body.innerText?.substring(0, 5000) || ""
  }

  // Truncate to reasonable length
  if (mainContent.length > 4000) {
    mainContent = mainContent.substring(0, 4000) + "..."
  }

  return [
    `# Page: ${title}`,
    `URL: ${url}`,
    metaDesc ? `Description: ${metaDesc}` : "",
    "",
    "## Content",
    mainContent,
    "",
    query ? `## Query: ${query}` : "",
    query ? `The above is the content of the current web page. The user asked: "${query}"` : "",
  ].filter(Boolean).join("\n")
}

function formatSearchResults(results, query) {
  if (results.length === 0) {
    return `No search results found for: "${query}"`
  }

  const lines = [`# Search Results for: "${query}"\n`]

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    lines.push(`## ${i + 1}. ${r.title}`)
    if (r.url) lines.push(`URL: ${r.url}`)
    if (r.snippet) lines.push(r.snippet)
    lines.push("")
  }

  lines.push(`---\n*${results.length} results found*`)
  return lines.join("\n")
}

// ============================================================
//  EMBEDDING GENERATOR
// ============================================================

/**
 * Generate a simple deterministic embedding vector from text.
 * Uses character/word frequency hashing — not production ML quality,
 * but provides a consistent, dimension-correct vector for testing.
 */
function generateSimpleEmbedding(text, dimensions = 256) {
  const embedding = new Float32Array(dimensions)
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, "")
  const words = normalized.split(/\s+/)

  // Hash words into vector dimensions
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    let hash = 0
    for (let j = 0; j < word.length; j++) {
      hash = ((hash << 5) - hash + word.charCodeAt(j)) | 0
    }
    const idx = Math.abs(hash) % dimensions
    embedding[idx] += 1.0 / words.length
  }

  // Also add character n-gram features
  for (let i = 0; i < normalized.length - 2; i++) {
    const trigram = normalized.substring(i, i + 3)
    let hash = 0
    for (let j = 0; j < trigram.length; j++) {
      hash = ((hash << 5) - hash + trigram.charCodeAt(j)) | 0
    }
    const idx = Math.abs(hash) % dimensions
    embedding[idx] += 0.1 / normalized.length
  }

  // L2 normalize
  let norm = 0
  for (let i = 0; i < dimensions; i++) norm += embedding[i] * embedding[i]
  norm = Math.sqrt(norm) || 1
  const result = []
  for (let i = 0; i < dimensions; i++) result.push(embedding[i] / norm)

  return result
}

// ============================================================
//  STREAMING HELPER
// ============================================================

/**
 * Stream text content in chunks back to the bridge via background script.
 * Simulates token-by-token streaming by splitting into word groups.
 */
async function streamText(requestId, text) {
  const words = text.split(/(\s+)/)
  const chunkSize = 3 // words per chunk
  let buffer = ""

  for (let i = 0; i < words.length; i++) {
    buffer += words[i]
    if ((i + 1) % chunkSize === 0 || i === words.length - 1) {
      chrome.runtime.sendMessage({
        type: "stream",
        requestId,
        delta: { content: buffer },
      })
      buffer = ""
      // Small delay to simulate streaming
      await sleep(20)
    }
  }
}

// ============================================================
//  HELPERS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector)
    if (el) { resolve(el); return }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) {
        observer.disconnect()
        clearTimeout(timer)
        resolve(el)
      }
    })

    const timer = setTimeout(() => {
      observer.disconnect()
      resolve(null) // Don't reject, just resolve null
    }, timeout)

    observer.observe(document.body, { childList: true, subtree: true })
  })
}

// ============================================================
//  MESSAGE HANDLING
// ============================================================

let currentContext = null
let registeredModelIds = new Set()

function detectAndRegister() {
  const newContext = detectContext()

  if (newContext !== currentContext) {
    // Unregister old models
    if (registeredModelIds.size > 0) {
      chrome.runtime.sendMessage({
        type: "unregisterModels",
        ids: Array.from(registeredModelIds),
      })
    }

    // Register new context models
    const models = getModelsForContext(newContext)
    registeredModelIds = new Set(models.map(m => m.id))
    currentContext = newContext

    chrome.runtime.sendMessage({
      type: "registerModels",
      models,
    })
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "ping":
      sendResponse({ pong: true })
      break

    case "completionRequest":
      handleCompletionRequest(msg.requestId, msg.request)
      break

    case "embeddingRequest":
      handleEmbeddingRequest(msg.requestId, msg.request)
      break

    case "responsesRequest":
      handleResponsesRequest(msg.requestId, msg.request)
      break

    case "detectAndRegister":
      detectAndRegister()
      break
  }
  return true // keep channel open for async
})

// Initial detection on script load
detectAndRegister()
