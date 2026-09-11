#!/usr/bin/env python3
"""
Test script for llm-bridge-cf deployed on Cloudflare Workers.
Simulates:
1. Creating a new room (/new)
2. Connecting mock Chrome Extension via WebSocket
3. Extension registering models ("google-search", "web-extractor")
4. Client checking /v1/models (OpenAI standard)
5. Client calling /v1/chat/completions (streaming and non-streaming)
6. Client calling /v1/embeddings
7. Extension handling requests and returning results
"""

import json
import threading
import time
import requests
import websocket

BASE_URL = "https://llm-bridge.insidexofficial.workers.dev"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

def mock_extension_worker(ws_url, ready_event, stop_event):
    def on_open(ws):
        print("[Mock Extension] Connected via WebSocket!")
        # 1. Register Models
        register_msg = {
            "type": "registerModels",
            "models": [
                {
                    "id": "google-search",
                    "name": "Google Search Mock",
                    "owned_by": "mock-extension",
                    "description": "Mocked web-to-LLM Google Search"
                },
                {
                    "id": "web-extractor",
                    "name": "Web Extractor Mock",
                    "owned_by": "mock-extension",
                    "description": "Mocked web content extractor"
                }
            ]
        }
        ws.send(json.dumps(register_msg))
        print("[Mock Extension] Sent registerModels")
        time.sleep(0.5)
        ready_event.set()

    def on_message(ws, message):
        data = json.loads(message)
        msg_type = data.get("type")
        req_id = data.get("requestId")
        print(f"[Mock Extension] Received message from Bridge: type={msg_type}, reqId={req_id}")

        if msg_type == "completionRequest":
            req = data.get("request", {})
            is_stream = req.get("stream", False)
            model = req.get("model")
            user_msg = req.get("messages", [{}])[-1].get("content", "")
            print(f"[Mock Extension] Processing completion for query: '{user_msg}' (stream={is_stream})")

            if is_stream:
                # Stream chunks
                words = [f"Found result for '{user_msg}': ", "Google ", "Search ", "data ", "simulated ", "via ", "Chrome Extension bridge."]
                for w in words:
                    chunk = {
                        "type": "stream",
                        "requestId": req_id,
                        "delta": {"content": w}
                    }
                    ws.send(json.dumps(chunk))
                    time.sleep(0.05)

                # End response
                ws.send(json.dumps({
                    "type": "response",
                    "requestId": req_id,
                    "content": "".join(words),
                    "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
                }))
            else:
                # Non-streaming response
                ws.send(json.dumps({
                    "type": "response",
                    "requestId": req_id,
                    "content": f"Non-stream result for '{user_msg}' using model {model}.",
                    "usage": {"prompt_tokens": 8, "completion_tokens": 15, "total_tokens": 23}
                }))

        elif msg_type == "embeddingRequest":
            req = data.get("request", {})
            inputs = req.get("input")
            if isinstance(inputs, str):
                inputs = [inputs]
            embeddings = [[0.01 * (i + j) for j in range(8)] for i in range(len(inputs))]
            ws.send(json.dumps({
                "type": "embedResult",
                "requestId": req_id,
                "embeddings": embeddings,
                "usage": {"prompt_tokens": 5, "total_tokens": 5}
            }))

        elif msg_type == "ping":
            ws.send(json.dumps({"type": "pong"}))

    def on_error(ws, error):
        print(f"[Mock Extension] Error: {error}")

    def on_close(ws, close_status_code, close_msg):
        print(f"[Mock Extension] Connection closed: {close_status_code} - {close_msg}")

    ws = websocket.WebSocketApp(
        ws_url,
        header={"User-Agent": "Mozilla/5.0"},
        on_open=on_open,
        on_message=on_message,
        on_error=on_error,
        on_close=on_close
    )

    wst = threading.Thread(target=ws.run_forever)
    wst.daemon = True
    wst.start()

    stop_event.wait()
    ws.close()

def main():
    print("=== 1. Testing /new endpoint ===")
    r = requests.get(f"{BASE_URL}/new", headers=HEADERS)
    print(f"Status Code: {r.status_code}")
    room_data = r.json()
    print("Room Info:", json.dumps(room_data, indent=2))

    ws_url = room_data["extension_url"]
    api_key = room_data["api_key"]
    api_base = room_data["api_base_url"]
    auth_headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0"
    }

    print("\n=== 2. Starting Mock Extension WebSocket Client ===")
    ready_event = threading.Event()
    stop_event = threading.Event()
    ext_thread = threading.Thread(
        target=mock_extension_worker,
        args=(ws_url, ready_event, stop_event)
    )
    ext_thread.daemon = True
    ext_thread.start()

    if not ready_event.wait(timeout=10):
        print("Mock extension connection timeout!")
        return

    print("Extension connected and models registered successfully!")

    print("\n=== 3. Testing GET /v1/models (OpenAI Standard) ===")
    r_models = requests.get(f"{api_base}/models", headers=auth_headers)
    print(f"Status: {r_models.status_code}")
    print("Models Response:", json.dumps(r_models.json(), indent=2))

    print("\n=== 4. Testing POST /v1/chat/completions (Non-Streaming) ===")
    payload_non_stream = {
        "model": "google-search",
        "messages": [
            {"role": "user", "content": "Siapa presiden Indonesia saat ini?"}
        ],
        "stream": False
    }
    r_chat = requests.post(f"{api_base}/chat/completions", headers=auth_headers, json=payload_non_stream)
    print(f"Status: {r_chat.status_code}")
    print("Chat Completion Response:", json.dumps(r_chat.json(), indent=2))

    print("\n=== 5. Testing POST /v1/chat/completions (Streaming SSE) ===")
    payload_stream = {
        "model": "google-search",
        "messages": [
            {"role": "user", "content": "Berita terkini AI 2026"}
        ],
        "stream": True
    }
    r_stream = requests.post(f"{api_base}/chat/completions", headers=auth_headers, json=payload_stream, stream=True)
    print(f"Status: {r_stream.status_code}")
    print("SSE Stream chunks received:")
    for line in r_stream.iter_lines():
        if line:
            decoded = line.decode("utf-8")
            print("  ", decoded)

    print("\n=== 6. Testing POST /v1/embeddings ===")
    payload_embed = {
        "model": "web-extractor",
        "input": ["Teks untuk dihitung embedding", "Kalimat kedua"]
    }
    r_embed = requests.post(f"{api_base}/embeddings", headers=auth_headers, json=payload_embed)
    print(f"Status: {r_embed.status_code}")
    print("Embedding Response:", json.dumps(r_embed.json(), indent=2))

    print("\nStopping mock extension...")
    stop_event.set()
    time.sleep(1)
    print("\n=== All Tests Passed Successfully! ===")

if __name__ == "__main__":
    main()
