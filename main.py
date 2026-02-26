"""
Speech-to-Speech Mini Demo - FastAPI Backend
STT  : openai/whisper-large-v3
LLM  : HuggingFaceH4/zephyr-7b-beta:featherless-ai
TTS  : gTTS (Google Text-to-Speech)
"""

import asyncio
import base64
import json
import logging
import os
import time
import uuid
from datetime import datetime
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, Column, String, DateTime, Text, Float
from sqlalchemy.orm import declarative_base, Session, sessionmaker
from huggingface_hub import InferenceClient
from openai import OpenAI
from gtts import gTTS

# ─────────────────────────────────────────────────────
# Setup
# ─────────────────────────────────────────────────────

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

HF_TOKEN = os.getenv("HF_TOKEN")

# ─────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────

DATABASE_URL = "sqlite:///./s2s.db"
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine)
Base = declarative_base()


class CallSession(Base):
    __tablename__ = "call_sessions"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    created_at = Column(DateTime, default=datetime.utcnow)
    ended_at = Column(DateTime, nullable=True)
    status = Column(String, default="connected")


class Turn(Base):
    __tablename__ = "turns"
    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, nullable=False)
    user_transcript_final = Column(Text, nullable=True)
    assistant_text = Column(Text, nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    ended_at = Column(DateTime, nullable=True)
    time_to_first_partial = Column(Float, nullable=True)
    time_to_final_transcript = Column(Float, nullable=True)
    time_to_first_audio = Column(Float, nullable=True)


Base.metadata.create_all(bind=engine)

# ─────────────────────────────────────────────────────
# FastAPI
# ─────────────────────────────────────────────────────

app = FastAPI(title="S2S Mini Demo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────────────
# AI Clients
# ─────────────────────────────────────────────────────

# Whisper (STT)
hf_client = InferenceClient(
    provider="hf-inference",
    api_key=HF_TOKEN,
)

# Zephyr (LLM)
llm_client = OpenAI(
    base_url="https://router.huggingface.co/v1",
    api_key=HF_TOKEN,
)

# ─────────────────────────────────────────────────────
# AI Functions
# ─────────────────────────────────────────────────────

async def transcribe_audio(audio_bytes: bytes) -> dict:
    result = hf_client.automatic_speech_recognition(
        audio_bytes,
        model="openai/whisper-large-v3",
    )

    text = result.get("text", "").strip()
    confidence = 0.9 if text else 0.0
    return {"text": text, "confidence": confidence}


async def call_llm_streaming(prompt: str):
    completion = llm_client.chat.completions.create(
        model="HuggingFaceH4/zephyr-7b-beta:featherless-ai",
        messages=[
            {"role": "system", "content": "You are a helpful voice assistant. Keep responses concise (1-3 sentences)."},
            {"role": "user", "content": prompt}
        ],
        max_tokens=200,
    )

    text = completion.choices[0].message.content.strip()

    # Simulated streaming (word-by-word)
    words = text.split()
    for i, word in enumerate(words):
        yield word + (" " if i < len(words) - 1 else "")
        await asyncio.sleep(0.02)


def synthesize_speech(text: str) -> bytes:
    tts = gTTS(text=text, lang="en")
    file_name = f"{uuid.uuid4()}.mp3"
    tts.save(file_name)

    with open(file_name, "rb") as f:
        audio_bytes = f.read()

    os.remove(file_name)
    return audio_bytes


def chunk_audio(audio_bytes: bytes, chunk_size: int = 8192):
    for i in range(0, len(audio_bytes), chunk_size):
        yield audio_bytes[i:i + chunk_size]



@app.websocket("/call")
async def websocket_call(ws: WebSocket):
    await ws.accept()

    session_id = str(uuid.uuid4())
    db: Session = SessionLocal()

    session = CallSession(id=session_id, status="connected")
    db.add(session)
    db.commit()

    await ws.send_json({"type": "session_id", "session_id": session_id})

    audio_buffer = bytearray()
    turn_start_time: Optional[float] = None
    current_turn_id: Optional[str] = None

    try:
        while True:
            message = await ws.receive()

            # Audio frames
            if "bytes" in message and message["bytes"]:
                audio_buffer.extend(message["bytes"])

            # Control messages
            elif "text" in message:
                data = json.loads(message["text"])
                msg_type = data.get("type")

                # START
                if msg_type == "start":
                    audio_buffer.clear()
                    turn_start_time = time.time()
                    current_turn_id = str(uuid.uuid4())

                    session.status = "active"
                    db.commit()

                    await ws.send_json({
                        "type": "trace_event",
                        "event": "turn_started",
                        "turn_id": current_turn_id,
                        "ts": turn_start_time,
                    })

                # STOP
                elif msg_type == "stop":
                    if not audio_buffer:
                        await ws.send_json({"type": "error", "message": "No audio received"})
                        continue

                    turn = Turn(
                        id=current_turn_id,
                        session_id=session_id,
                        started_at=datetime.utcfromtimestamp(turn_start_time),
                    )
                    db.add(turn)
                    db.commit()

                    raw_audio = bytes(audio_buffer)
                    audio_buffer.clear()

                    # ── STT ─────────────────────────
                    await ws.send_json({"type": "stt_partial", "text": "..."})

                    stt_result = await transcribe_audio(raw_audio)
                    transcript = stt_result["text"]
                    confidence = stt_result["confidence"]

                    time_to_final = time.time() - turn_start_time
                    turn.time_to_final_transcript = time_to_final
                    turn.user_transcript_final = transcript
                    db.commit()

                    await ws.send_json({
                        "type": "stt_final",
                        "text": transcript,
                        "confidence": confidence,
                        "latency_ms": round(time_to_final * 1000),
                    })

                    # Silence rule
                    if not transcript or confidence < 0.3:
                        reply = "I'm sorry, I didn't catch that. Could you repeat?"
                    else:
                        # ── LLM ───────────────────────
                        reply = ""
                        async for chunk in call_llm_streaming(transcript):
                            reply += chunk
                            await ws.send_json({
                                "type": "assistant_text",
                                "text": chunk,
                                "is_final": False,
                            })

                        await ws.send_json({
                            "type": "assistant_text",
                            "text": "",
                            "is_final": True,
                            "full_text": reply,
                        })

                    # ── TTS ─────────────────────────
                    audio_bytes = synthesize_speech(reply)

                    first_chunk = True
                    for chunk in chunk_audio(audio_bytes):
                        if first_chunk:
                            turn.time_to_first_audio = time.time() - turn_start_time
                            db.commit()
                            first_chunk = False

                        await ws.send_json({
                            "type": "tts_audio_chunk",
                            "audio": base64.b64encode(chunk).decode(),
                        })
                        await asyncio.sleep(0.01)

                    await ws.send_json({"type": "tts_done"})

                    turn.assistant_text = reply
                    turn.ended_at = datetime.utcnow()
                    db.commit()

                elif msg_type == "end_call":
                    break

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    finally:
        session.status = "ended"
        session.ended_at = datetime.utcnow()
        db.commit()
        db.close()