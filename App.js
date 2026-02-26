import React, { useState, useEffect, useRef, useCallback } from "react";
import "./App.css";

const WS_URL = process.env.REACT_APP_WS_URL || "ws://localhost:8000/call";
const API_URL = process.env.REACT_APP_API_URL || "http://localhost:8000";

// ── Audio helpers ──────────────────────────────────────────────────────────────

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ── App Component ──────────────────────────────────────────────────────────────

export default function App() {
  const [callStatus, setCallStatus] = useState("idle"); // idle | connecting | connected | listening | speaking | ended
  const [sttPartial, setSttPartial] = useState("");
  const [sttFinal, setSttFinal] = useState("");
  const [assistantText, setAssistantText] = useState("");
  const [traceEvents, setTraceEvents] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [activeTab, setActiveTab] = useState("call"); // call | trace | sessions
  const [error, setError] = useState("");
  const [latency, setLatency] = useState({
    stt_partial_ms: null,
    stt_final_ms: null,
    first_audio_ms: null,
  });

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const turnStartRef = useRef(null);
  const sessionIdRef = useRef(null);

  // ── Audio playback queue ─────────────────────────────────────────────────────

  const playNextChunk = useCallback(async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    isPlayingRef.current = true;

    const chunk = audioQueueRef.current.shift();
    try {
      const ctx = audioContextRef.current;
      const audioBuffer = await ctx.decodeAudioData(chunk);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        isPlayingRef.current = false;
        playNextChunk();
      };
      source.start(0);
      setCallStatus("speaking");
    } catch (e) {
      console.error("Audio decode error", e);
      isPlayingRef.current = false;
      playNextChunk();
    }
  }, []);

  const enqueueAudio = useCallback((base64Data) => {
    const buffer = base64ToArrayBuffer(base64Data);
    audioQueueRef.current.push(buffer);
    if (!isPlayingRef.current) playNextChunk();
  }, [playNextChunk]);

  // ── WebSocket message handler ─────────────────────────────────────────────────

  const handleMessage = useCallback((event) => {
    let data;
    try { data = JSON.parse(event.data); }
    catch { return; }

    const now = Date.now();

    switch (data.type) {
      case "session_id":
        sessionIdRef.current = data.session_id;
        setCallStatus("connected");
        break;

      case "stt_partial":
        setSttPartial(data.text);
        if (!latency.stt_partial_ms && turnStartRef.current) {
          setLatency(l => ({ ...l, stt_partial_ms: now - turnStartRef.current }));
        }
        break;

      case "stt_final":
        setSttPartial("");
        setSttFinal(data.text);
        setLatency(l => ({ ...l, stt_final_ms: data.latency_ms }));
        break;

      case "assistant_text":
        if (!data.is_final) {
          setAssistantText(prev => prev + data.text);
        }
        break;

      case "tts_audio_chunk":
        if (!latency.first_audio_ms && turnStartRef.current) {
          setLatency(l => ({ ...l, first_audio_ms: now - turnStartRef.current }));
        }
        enqueueAudio(data.audio);
        break;

      case "tts_done":
        // All audio chunks sent, queue will drain naturally
        break;

      case "trace_event":
        setTraceEvents(prev => [{
          ...data,
          wall_time: new Date().toLocaleTimeString(),
        }, ...prev].slice(0, 50));

        if (data.event === "turn_complete" && data.latency) {
          setLatency(l => ({
            ...l,
            stt_final_ms: data.latency.stt_ms || l.stt_final_ms,
            first_audio_ms: data.latency.first_audio_ms || l.first_audio_ms,
          }));
        }
        break;

      case "error":
        setError(data.message);
        setTimeout(() => setError(""), 5000);
        break;

      default:
        break;
    }
  }, [enqueueAudio, latency]);

  // ── Start Call ─────────────────────────────────────────────────────────────────

  const startCall = useCallback(async () => {
    setError("");
    setCallStatus("connecting");
    setTraceEvents([]);

    // Init AudioContext
    audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();

    // Connect WebSocket
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = handleMessage;
    ws.onerror = () => {
      setError("WebSocket connection failed. Is the backend running?");
      setCallStatus("idle");
    };
    ws.onclose = () => {
      if (callStatus !== "ended") setCallStatus("idle");
    };
    ws.onopen = () => {
      setCallStatus("connected");
    };
  }, [handleMessage, callStatus]);

  // ── Start Recording ─────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;

      // Notify server
      turnStartRef.current = Date.now();
      setSttFinal("");
      setAssistantText("");
      setSttPartial("");
      setLatency({ stt_partial_ms: null, stt_final_ms: null, first_audio_ms: null });
      audioQueueRef.current = [];
      isPlayingRef.current = false;

      wsRef.current.send(JSON.stringify({ type: "start" }));

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      };

      mediaRecorder.start(250); // 250ms chunks
      setCallStatus("listening");
    } catch (err) {
      setError("Microphone access denied. Please allow microphone access.");
    }
  }, []);

  // ── Stop Recording ──────────────────────────────────────────────────────────

  const stopRecording = useCallback(() => {
    if (!mediaRecorderRef.current) return;

    mediaRecorderRef.current.stop();
    mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
    mediaRecorderRef.current = null;

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }

    setCallStatus("connected");
  }, []);

  // ── End Call ────────────────────────────────────────────────────────────────

  const endCall = useCallback(() => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream?.getTracks().forEach(t => t.stop());
    }
    if (wsRef.current) {
      wsRef.current.send(JSON.stringify({ type: "end_call" }));
      wsRef.current.close();
    }
    audioContextRef.current?.close();
    setCallStatus("ended");
  }, []);

  // ── Load Sessions ───────────────────────────────────────────────────────────

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/sessions`);
      const data = await r.json();
      setSessions(data);
    } catch (e) {
      console.error("Failed to load sessions", e);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "sessions") loadSessions();
  }, [activeTab, loadSessions]);

  // ── Status colors ───────────────────────────────────────────────────────────

  const statusInfo = {
    idle: { label: "Idle", color: "#6b7280", dot: "#6b7280" },
    connecting: { label: "Connecting...", color: "#f59e0b", dot: "#f59e0b" },
    connected: { label: "Connected", color: "#10b981", dot: "#10b981" },
    listening: { label: "🎤 Listening...", color: "#3b82f6", dot: "#3b82f6" },
    speaking: { label: "🔊 Speaking...", color: "#8b5cf6", dot: "#8b5cf6" },
    ended: { label: "Call Ended", color: "#6b7280", dot: "#6b7280" },
  };

  const status = statusInfo[callStatus] || statusInfo.idle;

  return (
    <div className="app">
      <header className="header">
        <h1>🎙️ Voice AI Demo</h1>
        <div className="status-indicator">
          <span className="status-dot" style={{ background: status.dot }} />
          <span style={{ color: status.color }}>{status.label}</span>
        </div>
      </header>

      {error && <div className="error-banner">⚠️ {error}</div>}

      <nav className="tabs">
        {["call", "trace", "sessions"].map(tab => (
          <button
            key={tab}
            className={`tab ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>

      {/* ── CALL TAB ── */}
      {activeTab === "call" && (
        <div className="call-screen">
          <div className="call-controls">
            {callStatus === "idle" || callStatus === "ended" ? (
              <button className="btn btn-primary" onClick={startCall}>
                📞 Start Call
              </button>
            ) : (
              <>
                {callStatus === "connected" && (
                  <button className="btn btn-record" onClick={startRecording}>
                    🎤 Hold to Speak
                  </button>
                )}
                {callStatus === "listening" && (
                  <button className="btn btn-stop-record" onClick={stopRecording}>
                    ⏹ Stop Speaking
                  </button>
                )}
                {callStatus !== "idle" && callStatus !== "ended" && (
                  <button className="btn btn-danger" onClick={endCall}>
                    📵 End Call
                  </button>
                )}
              </>
            )}
          </div>

          <div className="panels">
            <div className="panel">
              <h3>📝 Transcript</h3>
              <div className="panel-content">
                {sttPartial && (
                  <div className="partial">
                    <span className="label">Partial: </span>
                    <em>{sttPartial}</em>
                  </div>
                )}
                {sttFinal && (
                  <div className="final">
                    <span className="label">You: </span>
                    <strong>{sttFinal}</strong>
                  </div>
                )}
                {!sttPartial && !sttFinal && (
                  <p className="placeholder">Transcript will appear here...</p>
                )}
              </div>
            </div>

            <div className="panel">
              <h3>🤖 Assistant</h3>
              <div className="panel-content">
                {assistantText ? (
                  <p className="assistant-text">{assistantText}</p>
                ) : (
                  <p className="placeholder">Response will appear here...</p>
                )}
              </div>
            </div>
          </div>

          {/* Latency stats */}
          {(latency.stt_final_ms || latency.first_audio_ms) && (
            <div className="latency-stats">
              <h4>⏱ Latency</h4>
              <div className="stats-grid">
                {latency.stt_partial_ms && (
                  <div className="stat">
                    <span className="stat-label">First Partial</span>
                    <span className="stat-value">{latency.stt_partial_ms}ms</span>
                  </div>
                )}
                {latency.stt_final_ms && (
                  <div className="stat">
                    <span className="stat-label">STT Final</span>
                    <span className="stat-value">{latency.stt_final_ms}ms</span>
                  </div>
                )}
                {latency.first_audio_ms && (
                  <div className="stat">
                    <span className="stat-label">First Audio</span>
                    <span className="stat-value">{latency.first_audio_ms}ms</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── TRACE TAB ── */}
      {activeTab === "trace" && (
        <div className="trace-panel">
          <h3>🔍 Trace Events</h3>
          {traceEvents.length === 0 ? (
            <p className="placeholder">No trace events yet. Start a call to see real-time trace data.</p>
          ) : (
            <div className="trace-list">
              {traceEvents.map((evt, i) => (
                <div key={i} className={`trace-event trace-${evt.event}`}>
                  <span className="trace-time">{evt.wall_time}</span>
                  <span className="trace-type">{evt.event}</span>
                  {evt.latency_ms && (
                    <span className="trace-latency">{evt.latency_ms}ms</span>
                  )}
                  {evt.transcript && (
                    <span className="trace-detail">"{evt.transcript}"</span>
                  )}
                  {evt.latency && (
                    <span className="trace-detail">
                      STT:{evt.latency.stt_ms}ms | Audio:{evt.latency.first_audio_ms}ms
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SESSIONS TAB ── */}
      {activeTab === "sessions" && (
        <div className="sessions-panel">
          <div className="sessions-header">
            <h3>📋 Recent Sessions</h3>
            <button className="btn btn-sm" onClick={loadSessions}>↻ Refresh</button>
          </div>
          {sessions.length === 0 ? (
            <p className="placeholder">No sessions yet.</p>
          ) : (
            <table className="sessions-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Ended</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id} className={`status-row-${s.status}`}>
                    <td className="mono">{s.id.slice(0, 8)}...</td>
                    <td>
                      <span className={`badge badge-${s.status}`}>{s.status}</span>
                    </td>
                    <td>{s.created_at ? new Date(s.created_at).toLocaleString() : "—"}</td>
                    <td>{s.ended_at ? new Date(s.ended_at).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
