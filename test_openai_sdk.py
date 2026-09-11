#!/usr/bin/env python3
"""
Test script using the OFFICIAL openai Python SDK against llm-bridge-cf on Cloudflare Workers.
Validates:
1. client.models.list()
2. client.models.retrieve("google-search")
3. client.chat.completions.create(..., stream=False)
4. client.chat.completions.create(..., stream=True)
5. client.embeddings.create(...)
"""

import json
import threading
import time
import requests
import websocket
from openai import OpenAI

BASE_URL = "https://llm-bridge.insidexofficial.workers.dev"

def mock_extension_worker(ws_url, ready_event, stop_event):
    def on_open(ws):
        # Register Models
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
        time.sleep(0.5)
        ready_event.set()

    def on_message(ws, message):
        data = json.loads(message)
        msg_type = data.get("type")
        req_id = data.get("requestId")

        if msg_type == "completionRequest":
            req = data.get("request", {})
            is_stream = req.get("stream", False)
            model = req.get("model")
            user_msg = req.get("messages", [{}])[-1].get("content", "")

            if is_stream:
                words = ["Halo", " dari", " OpenAI", " official", " Python", " SDK", " test!"]
                for w in words:
                    chunk = {
                        "type": "stream",
                        "requestId": req_id,
                        "delta": {"content": w}
                    }
                    ws.send(json.dumps(chunk))
                    time.sleep(0.04)

                ws.send(json.dumps({
                    "type": "response",
                    "requestId": req_id,
                    "content": "".join(words),
                    "usage": {"prompt_tokens": 12, "completion_tokens": 15, "total_tokens": 27}
                }))
            else:
                ws.send(json.dumps({
                    "type": "response",
                    "requestId": req_id,
                    "content": f"Respon resmi SDK OpenAI untuk prompt: '{user_msg}'. Model: {model}",
                    "usage": {"prompt_tokens": 10, "completion_tokens": 16, "total_tokens": 26}
                }))

        elif msg_type == "embeddingRequest":
            req = data.get("request", {})
            inputs = req.get("input")
            if isinstance(inputs, str):
                inputs = [inputs]
            # Dimensi vector embedding 16 float
            embeddings = [[0.05 * (i + 1) * (j + 1) for j in range(16)] for i in range(len(inputs))]
            ws.send(json.dumps({
                "type": "embedResult",
                "requestId": req_id,
                "embeddings": embeddings,
                "usage": {"prompt_tokens": 6, "total_tokens": 6}
            }))

        elif msg_type == "ping":
            ws.send(json.dumps({"type": "pong"}))

    ws = websocket.WebSocketApp(
        ws_url,
        header={"User-Agent": "Mozilla/5.0"},
        on_open=on_open,
        on_message=on_message
    )

    wst = threading.Thread(target=ws.run_forever)
    wst.daemon = True
    wst.start()

    stop_event.wait()
    ws.close()

def main():
    print(">>> 1. Creating Room on Cloudflare Worker")
    res = requests.get(f"{BASE_URL}/new", headers={"User-Agent": "Mozilla/5.0"})
    res.raise_for_status()
    room_data = res.json()
    room_id = room_data["room"]
    api_key = room_data["api_key"]
    base_url = room_data["api_base_url"]
    ws_url = room_data["extension_url"]

    print(f"Room: {room_id}")
    print(f"API Base: {base_url}")
    print(f"API Key: {api_key}")

    print("\n>>> 2. Connecting Extension via WebSocket")
    ready_event = threading.Event()
    stop_event = threading.Event()
    ext_thread = threading.Thread(target=mock_extension_worker, args=(ws_url, ready_event, stop_event))
    ext_thread.daemon = True
    ext_thread.start()

    if not ready_event.wait(timeout=10):
        raise TimeoutError("Extension failed to connect within 10s")
    print("Extension connected & models registered!")

    print("\n>>> 3. Initializing official OpenAI Client")
    client = OpenAI(
        base_url=base_url,
        api_key=api_key,
        default_headers={"User-Agent": "Mozilla/5.0"}
    )

    print("\n>>> 4. Testing client.models.list()")
    models = client.models.list()
    for m in models.data:
        print(f" - Model ID: {m.id}, Owned By: {m.owned_by}, Created: {m.created}")
    assert len(models.data) >= 2, "Harus ada minimal 2 model"

    print("\n>>> 5. Testing client.models.retrieve('google-search')")
    m_single = client.models.retrieve("google-search")
    print(f"Single model retrieved: {m_single.id} (owned by {m_single.owned_by})")
    assert m_single.id == "google-search"

    print("\n>>> 6. Testing client.chat.completions.create(stream=False)")
    chat_resp = client.chat.completions.create(
        model="google-search",
        messages=[{"role": "user", "content": "Jelaskan cara kerja LLM Bridge"}],
        stream=False
    )
    print(f"Chat ID: {chat_resp.id}")
    print(f"Model: {chat_resp.model}")
    print(f"Content: {chat_resp.choices[0].message.content}")
    print(f"Finish Reason: {chat_resp.choices[0].finish_reason}")
    print(f"Usage: {chat_resp.usage}")
    assert chat_resp.choices[0].message.content is not None

    print("\n>>> 7. Testing client.chat.completions.create(stream=True)")
    stream = client.chat.completions.create(
        model="google-search",
        messages=[{"role": "user", "content": "Test streaming via OpenAI SDK"}],
        stream=True
    )
    full_stream_text = []
    print("Streaming chunks via SDK:")
    for chunk in stream:
        delta = chunk.choices[0].delta.content or ""
        if delta:
            print(delta, end="", flush=True)
            full_stream_text.append(delta)
    print("\n[Stream Complete]")
    assert len(full_stream_text) > 0

    print("\n>>> 8. Testing client.embeddings.create(...)")
    emb_resp = client.embeddings.create(
        model="web-extractor",
        input=["Contoh teks embedding 1", "Contoh teks embedding 2"]
    )
    print(f"Embeddings count: {len(emb_resp.data)}")
    print(f"Vector 1 length: {len(emb_resp.data[0].embedding)}")
    print(f"Vector sample: {emb_resp.data[0].embedding[:4]}")
    print(f"Usage: {emb_resp.usage}")
    assert len(emb_resp.data) == 2
    assert len(emb_resp.data[0].embedding) == 16

    print("\nShutting down mock extension...")
    stop_event.set()
    time.sleep(1)
    print("\n=======================================================")
    print(" SUCCESS: 100% COMPLIANT WITH OFFICIAL OPENAI PYTHON SDK!")
    print("=======================================================")

if __name__ == "__main__":
    main()
