/**
 * LLM Bridge — Background Service Worker
 *
 * Manages WebSocket connection to the Cloudflare Worker bridge.
 * Routes LLM API requests (completions, embeddings, responses) to content scripts.
 */

let ws = null
let workerUrl = ""
let room = ""
let apiKey = ""
let reconnectTimer = null
let connectionState = "disconnected"

const registeredModels = new Map()

// ============================================================
//  CONNECTION
// ============================================================

async function connect(url, roomId = "default", key = "") {
  if (ws) disconnect()

  workerUrl = url
  room = roomId
  apiKey = key
  connectionState = "connecting"
  broadcastState()

  try {
    const wsUrl = url.replace(/^http/, "ws") + `/ws/extension?room=${roomId}`
    ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      connectionState = "connected"
      broadcastState()
      clearTimeout(reconnectTimer)
      chrome.storage.local.set({ workerUrl: url, room: roomId, apiKey: key })

      // Re-register models on reconnect
      if (registeredModels.size > 0) {
        sendToWorker({ type: "registerModels", models: Array.from(registeredModels.values()) })
      }
    }

    ws.onmessage = (event) => {
      try {
        handleWorkerMessage(JSON.parse(event.data))
      } catch (err) {
        console.error("[LLM Bridge] Bad message:", err)
      }
    }

    ws.onclose = () => {
      connectionState = "disconnected"
      broadcastState()
      ws = null
      reconnectTimer = setTimeout(() => {
        if (workerUrl) connect(workerUrl, room, apiKey)
      }, 5000)
    }

    ws.onerror = (err) => console.error("[LLM Bridge] WS error:", err)
  } catch (err) {
    console.error("[LLM Bridge] Connect failed:", err)
    connectionState = "disconnected"
    broadcastState()
  }
}

function disconnect() {
  clearTimeout(reconnectTimer)
  workerUrl = ""
  room = ""
  apiKey = ""
  if (ws) { ws.close(); ws = null }
  connectionState = "disconnected"
  broadcastState()
}

function sendToWorker(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// ============================================================
//  WORKER MESSAGES (Bridge → Extension)
// ============================================================

function handleWorkerMessage(msg) {
  switch (msg.type) {
    case "completionRequest":
    case "embeddingRequest":
    case "responsesRequest":
      forwardToContentScript(msg)
      break
    case "ping":
      sendToWorker({ type: "pong" })
      break
  }
}

/**
 * Forward a request from the bridge to the active tab's content script.
 * The content script will handle it and send back stream/response messages.
 */
async function forwardToContentScript(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab) {
      sendToWorker({
        type: "streamError",
        requestId: msg.requestId,
        error: "No active tab available",
      })
      return
    }

    await ensureContentScript(tab.id)
    chrome.tabs.sendMessage(tab.id, msg)
  } catch (err) {
    sendToWorker({
      type: "streamError",
      requestId: msg.requestId,
      error: `Failed to forward to content script: ${err.message}`,
    })
  }
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" })
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
    await new Promise((r) => setTimeout(r, 100))
  }
}

// ============================================================
//  MESSAGE HANDLING (from popup & content scripts)
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // ── Popup messages ──
    case "connect":
      connect(msg.url, msg.room || "default", msg.apiKey || "")
      break
    case "disconnect":
      disconnect()
      break
    case "getState":
      sendResponse({
        connectionState, workerUrl, room, apiKey,
        modelsCount: registeredModels.size,
        models: Array.from(registeredModels.values()),
      })
      break

    // ── Content script messages ──
    case "registerModels":
      for (const model of msg.models) registeredModels.set(model.id, model)
      sendToWorker({ type: "registerModels", models: msg.models })
      broadcastState()
      break
    case "unregisterModels":
      for (const id of msg.ids) registeredModels.delete(id)
      sendToWorker({ type: "unregisterModels", ids: msg.ids })
      broadcastState()
      break

    // ── Forwarded responses from content script → bridge ──
    case "stream":
      sendToWorker({ type: "stream", requestId: msg.requestId, delta: msg.delta })
      break
    case "response":
      sendToWorker({
        type: "response", requestId: msg.requestId,
        content: msg.content, usage: msg.usage,
      })
      break
    case "streamError":
      sendToWorker({ type: "streamError", requestId: msg.requestId, error: msg.error })
      break
    case "embedResult":
      sendToWorker({
        type: "embedResult", requestId: msg.requestId,
        embeddings: msg.embeddings, usage: msg.usage,
      })
      break
  }
})

// ============================================================
//  STATE BROADCASTING
// ============================================================

function broadcastState() {
  const state = {
    connectionState, workerUrl, room, apiKey,
    modelsCount: registeredModels.size,
    models: Array.from(registeredModels.values()),
  }
  chrome.runtime.sendMessage({ type: "stateUpdate", state }).catch(() => {})
}

// ============================================================
//  AUTO-RECONNECT & CONTEXT DETECTION
// ============================================================

chrome.storage.local.get(["workerUrl", "room", "apiKey"], ({ workerUrl: savedUrl, room: savedRoom, apiKey: savedKey }) => {
  if (savedUrl) connect(savedUrl, savedRoom || "default", savedKey || "")
})

// Re-detect models when tab changes
chrome.tabs.onActivated.addListener(async () => {
  if (connectionState === "connected") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab) {
      try {
        await ensureContentScript(tab.id)
        chrome.tabs.sendMessage(tab.id, { type: "detectAndRegister" })
      } catch {}
    }
  }
})

// Re-detect models when page finishes loading
chrome.webNavigation?.onCompleted?.addListener(async (details) => {
  if (details.frameId === 0 && connectionState === "connected") {
    try {
      await ensureContentScript(details.tabId)
      chrome.tabs.sendMessage(details.tabId, { type: "detectAndRegister" })
    } catch {}
  }
})
