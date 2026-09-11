const urlInput = document.getElementById("urlInput")
const newRoomBtn = document.getElementById("newRoomBtn")
const connectBtn = document.getElementById("connectBtn")
const disconnectBtn = document.getElementById("disconnectBtn")
const dot = document.getElementById("dot")
const statusText = document.getElementById("statusText")
const roomInfo = document.getElementById("roomInfo")
const roomId = document.getElementById("roomId")
const modelCount = document.getElementById("modelCount")
const modelsSection = document.getElementById("modelsSection")
const modelList = document.getElementById("modelList")
const apiInfo = document.getElementById("apiInfo")
const apiBaseUrl = document.getElementById("apiBaseUrl")
const apiKeyDisplay = document.getElementById("apiKeyDisplay")
const copyBaseUrl = document.getElementById("copyBaseUrl")
const copyApiKey = document.getElementById("copyApiKey")

function updateUI(state) {
  // Status dot & text
  dot.className = `dot ${state.connectionState}`
  statusText.textContent =
    state.connectionState === "connected" ? "Connected" :
    state.connectionState === "connecting" ? "Connecting..." :
    "Disconnected"

  // Button visibility
  const isConnected = state.connectionState === "connected"
  connectBtn.style.display = isConnected ? "none" : "block"
  newRoomBtn.style.display = isConnected ? "none" : "block"
  disconnectBtn.style.display = isConnected ? "block" : "none"

  // URL input
  if (state.workerUrl) urlInput.value = state.workerUrl

  if (isConnected) {
    // Room info
    roomInfo.style.display = "block"
    roomId.textContent = state.room || "-"

    // Models
    const models = state.models || []
    modelCount.textContent = models.length

    if (models.length > 0) {
      modelsSection.style.display = "block"
      modelList.innerHTML = models.map(m => {
        const desc = m.description ? `<div class="model-desc">${m.description}</div>` : ""
        return `<div class="model-item"><span class="model-id">${m.id || m}</span>${desc}</div>`
      }).join("")
    } else {
      modelsSection.style.display = "none"
    }

    // API info
    if (state.workerUrl) {
      apiInfo.style.display = "block"
      apiBaseUrl.textContent = `${state.workerUrl}/v1`
      apiKeyDisplay.textContent = state.apiKey || "-"
    }
  } else {
    roomInfo.style.display = "none"
    modelsSection.style.display = "none"
    apiInfo.style.display = "none"
  }
}

// Get initial state
chrome.runtime.sendMessage({ type: "getState" }, (response) => {
  if (response) updateUI(response)
})

// Listen for state updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "stateUpdate") updateUI(msg.state)
})

// ── New Room ──
newRoomBtn.addEventListener("click", async () => {
  const baseUrl = urlInput.value.trim().replace(/\/+$/, "")
  if (!baseUrl) {
    alert("Enter bridge URL first")
    return
  }

  newRoomBtn.disabled = true
  newRoomBtn.textContent = "Creating..."

  try {
    const res = await fetch(`${baseUrl}/new`)
    const data = await res.json()

    urlInput.value = baseUrl
    chrome.runtime.sendMessage({
      type: "connect",
      url: baseUrl,
      room: data.room,
      apiKey: data.api_key,
    })
    updateUI({
      connectionState: "connecting",
      workerUrl: baseUrl,
      room: data.room,
      apiKey: data.api_key,
      models: [],
    })
  } catch (err) {
    alert(`Failed: ${err.message}`)
  } finally {
    newRoomBtn.disabled = false
    newRoomBtn.textContent = "🚀 New Room"
  }
})

// ── Connect ──
connectBtn.addEventListener("click", () => {
  const url = urlInput.value.trim()
  if (!url) return

  const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`)
  const room = urlObj.searchParams.get("room") || "default"
  const baseUrl = `${urlObj.protocol}//${urlObj.host}`

  chrome.runtime.sendMessage({ type: "connect", url: baseUrl, room })
  updateUI({ connectionState: "connecting", workerUrl: baseUrl, room, models: [] })
})

// ── Disconnect ──
disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "disconnect" })
  updateUI({ connectionState: "disconnected", models: [] })
})

// ── Copy buttons ──
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text)
  const original = btn.textContent
  btn.textContent = "✅"
  setTimeout(() => { btn.textContent = original }, 1500)
}

copyBaseUrl.addEventListener("click", () => {
  copyToClipboard(apiBaseUrl.textContent, copyBaseUrl)
})

copyApiKey.addEventListener("click", () => {
  copyToClipboard(apiKeyDisplay.textContent, copyApiKey)
})
