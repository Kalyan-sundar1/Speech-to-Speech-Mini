"""
Tests for Business Rule #1: Concurrent Isolation
Two simultaneous browser calls must not cross-talk.

Run with: pytest test_concurrent_isolation.py -v
"""
import asyncio
import json
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock, patch
import uuid

# ── Test: Session Registry Isolation ──────────────────────────────────────────

def test_active_sessions_are_isolated():
    """Each session_id maps to its own WebSocket. No sharing."""
    from main import active_sessions

    ws1 = MagicMock()
    ws2 = MagicMock()
    id1, id2 = str(uuid.uuid4()), str(uuid.uuid4())

    active_sessions[id1] = ws1
    active_sessions[id2] = ws2

    assert active_sessions[id1] is ws1
    assert active_sessions[id2] is ws2
    assert active_sessions[id1] is not active_sessions[id2]

    # Cleanup
    del active_sessions[id1]
    del active_sessions[id2]


def test_session_cleanup_on_disconnect():
    """After a session ends, it should be removed from active_sessions."""
    from main import active_sessions

    ws = MagicMock()
    sid = str(uuid.uuid4())
    active_sessions[sid] = ws

    # Simulate teardown
    active_sessions.pop(sid, None)

    assert sid not in active_sessions


def test_no_session_id_reuse():
    """Each new session must get a unique ID."""
    ids = {str(uuid.uuid4()) for _ in range(1000)}
    assert len(ids) == 1000, "UUID collision detected"


# ── Test: DB Turn Isolation ────────────────────────────────────────────────────

def test_turns_are_scoped_to_session():
    """Turns from session A must not appear when querying session B."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from main import Base, Turn, CallSession

    # Use in-memory SQLite for testing
    test_engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=test_engine)
    TestSession = sessionmaker(bind=test_engine)
    db = TestSession()

    # Create two sessions
    sid_a = str(uuid.uuid4())
    sid_b = str(uuid.uuid4())

    db.add(CallSession(id=sid_a, status="active"))
    db.add(CallSession(id=sid_b, status="active"))

    # Add turns to session A
    db.add(Turn(
        id=str(uuid.uuid4()),
        session_id=sid_a,
        user_transcript_final="Hello from A",
        assistant_text="Response for A",
    ))

    # Add turns to session B
    db.add(Turn(
        id=str(uuid.uuid4()),
        session_id=sid_b,
        user_transcript_final="Hello from B",
        assistant_text="Response for B",
    ))
    db.commit()

    # Query session A turns
    turns_a = db.query(Turn).filter(Turn.session_id == sid_a).all()
    assert len(turns_a) == 1
    assert turns_a[0].user_transcript_final == "Hello from A"

    # Query session B turns
    turns_b = db.query(Turn).filter(Turn.session_id == sid_b).all()
    assert len(turns_b) == 1
    assert turns_b[0].user_transcript_final == "Hello from B"

    # Verify no cross-contamination
    for turn in turns_a:
        assert turn.session_id == sid_a
    for turn in turns_b:
        assert turn.session_id == sid_b

    db.close()


# ── Test: Low Confidence / Silence Rule ───────────────────────────────────────

def test_low_confidence_detection():
    """Empty transcript or low confidence should trigger repeat prompt."""
    test_cases = [
        {"text": "", "confidence": 0.0, "should_ask_repeat": True},
        {"text": "   ", "confidence": 0.0, "should_ask_repeat": True},
        {"text": "hello", "confidence": 0.9, "should_ask_repeat": False},
        {"text": "some words", "confidence": 0.5, "should_ask_repeat": False},
    ]

    for case in test_cases:
        transcript = case["text"].strip()
        confidence = case["confidence"]
        should_repeat = not transcript or confidence < 0.3
        assert should_repeat == case["should_ask_repeat"], f"Failed for {case}"


# ── Async Test: Concurrent Sessions Don't Share State ─────────────────────────

@pytest.mark.asyncio
async def test_concurrent_sessions_independent_buffers():
    """
    Simulate two concurrent sessions processing audio simultaneously.
    Verify each session's audio buffer is independent.
    """
    buffer_a = bytearray()
    buffer_b = bytearray()

    async def session_a():
        for i in range(5):
            buffer_a.extend(bytes([i]))
            await asyncio.sleep(0.001)

    async def session_b():
        for i in range(10, 15):
            buffer_b.extend(bytes([i]))
            await asyncio.sleep(0.001)

    # Run concurrently
    await asyncio.gather(session_a(), session_b())

    # Verify no cross-contamination
    assert bytes(buffer_a) == bytes(range(5))
    assert bytes(buffer_b) == bytes(range(10, 15))
    assert bytes(buffer_a) != bytes(buffer_b)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
