import React, { useEffect, useRef, useState } from 'react';
import { Video, VideoOff, Mic, MicOff, Users, ArrowRight, Dices } from 'lucide-react';
import type { CallMode } from '../types';

interface LobbyProps {
  onJoin: (
    roomId: string,
    name: string,
    mode: CallMode,
    cameraEnabled?: boolean,
    micEnabled?: boolean,
    existingStream?: MediaStream | null
  ) => void;
  defaultName?: string;
  defaultRoomId?: string;
  serverUrl: string;
  onUpdateServerUrl: (url: string) => void;
  isSocketConnected?: boolean;
}

function generateMeetCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let str = '';
  for (let i = 0; i < 10; i++) {
    str += chars[bytes[i] % chars.length];
  }
  return `${str.slice(0, 3)}-${str.slice(3, 7)}-${str.slice(7, 10)}`;
}

export const Lobby: React.FC<LobbyProps> = ({
  onJoin,
  defaultName = 'Alex Johnson',
  defaultRoomId,
  serverUrl,
  onUpdateServerUrl,
  isSocketConnected = false,
}) => {
  // Generate a random room by default (Google Meet style abc-defg-hij)
  const [roomId, setRoomId] = useState(() => {
    if (defaultRoomId) return defaultRoomId;
    return generateMeetCode();
  });
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<CallMode>('video');
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [customServerUrl, setCustomServerUrl] = useState(serverUrl);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (defaultName) {
      setName(defaultName);
    }
  }, [defaultName]);

  // Initialize camera preview only in video mode
  useEffect(() => {
    let active = true;

    if (mode === 'audio') {
      if (previewStreamRef.current) {
        previewStreamRef.current.getVideoTracks().forEach((t) => t.stop());
      }
      setPreviewStream(null);
      return;
    }

    async function startPreview() {
      try {
        setCameraError(null);
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280, min: 640 },
            height: { ideal: 720, min: 360 },
            aspectRatio: { ideal: 1.7777777778 },
          },
          audio: true,
        });
        if (active) {
          previewStreamRef.current = stream;
          setPreviewStream(stream);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        } else {
          stream.getTracks().forEach((t) => t.stop());
        }
      } catch (err: any) {
        console.warn('Could not access camera/mic preview:', err);
        if (active) {
          setCameraError(
            err.name === 'NotAllowedError'
              ? 'Camera/microphone access blocked in browser. Please enable permissions.'
              : 'Could not access camera device.'
          );
        }
      }
    }

    startPreview();

    return () => {
      active = false;
      if (previewStreamRef.current) {
        previewStreamRef.current.getTracks().forEach((t) => t.stop());
        previewStreamRef.current = null;
      }
    };
  }, [mode]);

  const togglePreviewCam = () => {
    const nextState = !cameraEnabled;
    setCameraEnabled(nextState);
    if (previewStreamRef.current) {
      previewStreamRef.current.getVideoTracks().forEach((t) => {
        t.enabled = nextState;
      });
    }
  };

  const togglePreviewMic = () => {
    const nextState = !micEnabled;
    setMicEnabled(nextState);
    if (previewStreamRef.current) {
      previewStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = nextState;
      });
    }
  };

  const generateRandomRoom = () => {
    setRoomId(generateMeetCode());
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId.trim() || !name.trim()) return;

    // Preserve active working camera stream for the call (prevents NotReadableError on mobile iOS/Android)
    const stream = previewStreamRef.current;
    previewStreamRef.current = null;
    setPreviewStream(null);

    onJoin(
      roomId.trim().toUpperCase(),
      name.trim(),
      mode,
      cameraEnabled,
      micEnabled,
      stream
    );
  };

  return (
    <div className="lobby-wrapper">
      <div className="lobby-card">
        {/* Header */}
        <div className="lobby-header">
          <div className="lobby-badge">
            <Users size={18} color="#2563EB" />
            <span>GroupCall 50 Web</span>
          </div>
          <h1 className="lobby-title">Enterprise WebRTC Group Calling</h1>
          <p className="lobby-subtitle">
            HD Audio & Video Rooms supporting up to 50 concurrent participants
          </p>
        </div>

        {/* Mode Selector Tabs */}
        <div className="mode-toggle-group">
          <button
            type="button"
            className={`mode-btn ${mode === 'video' ? 'mode-btn-active' : ''}`}
            onClick={() => setMode('video')}
          >
            <Video size={18} />
            <span>Video Meeting</span>
          </button>
          <button
            type="button"
            className={`mode-btn ${mode === 'audio' ? 'mode-btn-active' : ''}`}
            onClick={() => setMode('audio')}
          >
            <Mic size={18} />
            <span>Voice Room (Audio)</span>
          </button>
        </div>

        {/* Live Video Preview Box */}
        {mode === 'video' && (
          <div className="preview-container">
            {cameraEnabled && previewStream ? (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="preview-video video-mirrored"
              />
            ) : (
              <div className="preview-placeholder">
                <div className="preview-avatar">
                  {name ? name.slice(0, 1).toUpperCase() : '?'}
                </div>
                <span style={{ textAlign: 'center', padding: '0 12px' }}>
                  {cameraError || 'Camera is Off'}
                </span>
              </div>
            )}

            {/* Quick Preview Media Toggles */}
            <div className="preview-controls">
              <button
                type="button"
                className={`preview-ctrl-btn ${!micEnabled ? 'ctrl-off' : ''}`}
                onClick={togglePreviewMic}
                title={micEnabled ? 'Mute Microphone' : 'Unmute Microphone'}
              >
                {micEnabled ? <Mic size={18} /> : <MicOff size={18} />}
              </button>
              <button
                type="button"
                className={`preview-ctrl-btn ${!cameraEnabled ? 'ctrl-off' : ''}`}
                onClick={togglePreviewCam}
                title={cameraEnabled ? 'Turn Off Camera' : 'Turn On Camera'}
              >
                {cameraEnabled ? <Video size={18} /> : <VideoOff size={18} />}
              </button>
            </div>
          </div>
        )}

        {/* Form Inputs */}
        <form onSubmit={handleSubmit} className="lobby-form">
          <div className="form-group">
            <label className="form-label" htmlFor="userNameInput">
              Your Name
            </label>
            <input
              id="userNameInput"
              type="text"
              className="form-input"
              placeholder="e.g. Alex Johnson"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label className="form-label" htmlFor="roomIdInput" style={{ margin: 0 }}>
                Meeting Room ID
              </label>
              <button
                type="button"
                onClick={generateRandomRoom}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--primary)',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: 0,
                }}
              >
                <Dices size={14} />
                <span>New Clean Room</span>
              </button>
            </div>
            <input
              id="roomIdInput"
              type="text"
              className="form-input"
              placeholder="e.g. ROOM-5821 or TEST-ROOM"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
              required
            />
            {roomId === 'TEST-ROOM' && (
              <span style={{ fontSize: '11px', color: '#D97706', marginTop: '4px', display: 'block' }}>
                Note: TEST-ROOM is a shared public test room with existing participants. Click "New Clean Room" for a private meeting.
              </span>
            )}
          </div>

          {/* Join Call Button */}
          <button type="submit" className="join-submit-btn">
            <span>Join {mode === 'video' ? 'Video Meeting' : 'Voice Room'}</span>
            <ArrowRight size={18} />
          </button>
        </form>

        {/* Server Connection Status Bar */}
        <div className="server-config-section">
          <div className="server-status-bar">
            <span
              className={`server-status-pill ${
                isSocketConnected ? 'status-connected' : 'status-disconnected'
              }`}
            >
              <span className="status-dot" />
              {isSocketConnected ? 'Server Online' : 'Server Disconnected'}
            </span>

            <button
              type="button"
              className="server-config-toggle"
              onClick={() => setShowServerConfig(!showServerConfig)}
            >
              <span>Change Server URL</span>
            </button>
          </div>

          {!isSocketConnected && (
            <div className="server-warning-box">
              Cannot reach signaling server at <code>{serverUrl}</code>. Multiple users
              cannot see each other without a connected signaling server.
            </div>
          )}

          {showServerConfig && (
            <div className="server-config-card">
              <label className="server-config-label">
                Backend Signaling Server URL:
              </label>
              <div className="server-input-row">
                <input
                  type="text"
                  className="server-input"
                  placeholder="e.g. https://tech.techugo.com:1065"
                  value={customServerUrl}
                  onChange={(e) => setCustomServerUrl(e.target.value)}
                />
                <button
                  type="button"
                  className="server-save-btn"
                  onClick={() => {
                    onUpdateServerUrl(customServerUrl.trim());
                    setShowServerConfig(false);
                  }}
                >
                  Save & Connect
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
