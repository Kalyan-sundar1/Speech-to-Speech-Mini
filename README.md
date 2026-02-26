# 🎙️ Speech-to-Speech Mini Demo

A full-stack voice AI demo: browser mic → STT → LLM → TTS → audio playback.  
Uses **100% open/free models** via the **HuggingFace Inference API**.

---

## Architecture

```
Browser (React)
    │  WebSocket /call
    ▼
FastAPI Backend
    ├─► HuggingFace Whisper (STT)
    ├─► HuggingFace Mistral-7B (LLM)
    └─► HuggingFace MMS-TTS (TTS)
         │
    SQLite (sessions + turns)
```

## Models Used (all free on HuggingFace Inference API)

| Role | Model | HF ID |
|------|-------|--------|
| STT  | Whisper Large v3 | `openai/whisper-large-v3` |
| LLM  | Mistral 7B Instruct | `HuggingFaceH4/zephyr-7b-beta:featherless-ai` |
| TTS  | MMS-TTS (English) | `gTTS` |

**Alternatives** (set via env vars):
- LLM: `HuggingFaceH4/zephyr-7b-beta`, `tiiuae/falcon-7b-instruct`
- TTS: `microsoft/speecht5_tts`

---

## Setup

### 1. Get a Free HuggingFace Token

1. Sign up at https://huggingface.co
2. Go to https://huggingface.co/settings/tokens
3. Create a **Read** token

### 2. Backend

```bash
cd backend
cp .env.example .env
# Edit .env and add your HF_TOKEN
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### 3. Frontend

```bash
cd frontend
npm install
npm start
# Opens at http://localhost:3000
```

### 4. Docker Compose (Optional)

```bash
cp backend/.env.example .env
# Edit .env
docker compose up --build
# Frontend: http://localhost:3000
# Backend:  http://localhost:8000
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HF_TOKEN` | *(required)* | HuggingFace API token |
| `DATABASE_URL` | `sqlite:///./s2s.db` | SQLite or PostgreSQL URL |
| `STT_MODEL` | `openai/whisper-large-v3` | HF model for speech-to-text |
| `LLM_MODEL` | `HuggingFaceH4/zephyr-7b-beta:featherless-ai` | HF model for LLM |
| `TTS_MODEL` | `gTTS` | HF model for text-to-speech |

---

## API Reference

### WebSocket: `ws://localhost:8000/call`

**Client → Server (control messages):**
```json
{ "type": "start" }          // Begin a new turn; start sending audio frames
{ "type": "stop" }           // Finished speaking; trigger STT→LLM→TTS
{ "type": "end_call" }       // Hang up
```

**Client → Server (audio):**  
Raw binary frames (WebM/Opus from MediaRecorder, ~250ms chunks)

**Server → Client events:**
```json
{ "type": "session_id", "session_id": "uuid" }
{ "type": "stt_partial", "text": "...", "ts": 1234567890 }
{ "type": "stt_final", "text": "...", "confidence": 0.9, "latency_ms": 1200 }
{ "type": "assistant_text", "text": "chunk", "is_final": false }
{ "type": "tts_audio_chunk", "audio": "<base64 wav>" }
{ "type": "tts_done" }
{ "type": "trace_event", "event": "stt_start|llm_start|...", "ts": ..., "latency_ms": ... }
{ "type": "error", "message": "..." }
```

### REST Endpoints

```
GET /sessions              # List recent sessions
GET /sessions/{id}/turns   # Get all turns for a session
GET /health                # Health check + active session count
```

---

## Business Rule Implemented

**Rule #1: Concurrent Isolation**

Two simultaneous browser calls must not cross-talk. Implementation:

1. **Session registry**: `active_sessions: dict[session_id → WebSocket]` — each session owns its own WebSocket reference. The server never broadcasts to all sessions.
2. **Per-connection state**: Each WebSocket handler runs as an independent async coroutine with its own `audio_buffer`, `turn_id`, and `session_id` local variables — no shared mutable state.
3. **DB scoping**: All `Turn` records are tagged with `session_id`. Queries always filter by `session_id`.

**Run the tests:**
```bash
cd backend
pip install pytest pytest-asyncio
pytest test_concurrent_isolation.py -v
```

Tests cover:
- Session registry isolation (two WS objects don't share state)
- Session cleanup on disconnect
- DB turn scoping (turns from session A never appear in session B queries)
- Low-confidence silence detection
- Concurrent audio buffer independence (async test)

---

## Low Confidence / Silence Rule

If STT returns empty text or confidence < 0.3, the assistant responds with:
> "I'm sorry, I didn't catch that. Could you please repeat?"

This is TTS-synthesized and streamed back — no LLM call is made.

---

## Trace Panel

The UI's **Trace** tab shows real-time pipeline events with timing:

| Event | Description |
|-------|-------------|
| `turn_started` | User pressed "Stop Speaking" |
| `stt_start` | Audio sent to Whisper |
| `stt_done` | Transcript received |
| `llm_start` | Transcript sent to LLM |
| `llm_done` | Full response received |
| `tts_start` | Text sent to TTS |
| `tts_first_chunk` | First audio chunk ready |
| `turn_complete` | Full pipeline latency summary |

---

## Project Structure

```
s2s/
├── backend/
│   ├── main.py                     # FastAPI app + WebSocket handler
│   ├── test_concurrent_isolation.py # Business rule tests
│   ├── requirements.txt
│   ├── .env.example
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.js                  # Main React component
│   │   └── App.css
│   ├── public/index.html
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml
└── README.md
```
