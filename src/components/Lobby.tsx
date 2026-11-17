import React, { useEffect, useRef, useState } from 'react';
import { Video, VideoOff, Mic, MicOff, Users, ArrowRight, ShieldCheck, Sparkles, Settings } from 'lucide-react';
import type { CallMode } from '../types';

interface LobbyProps {
  onJoin: (roomId: string, name: string, mode: CallMode) => void;
  defaultName?: string;
  defaultRoomId?: string;
  serverUrl: string;
  onUpdateServerUrl: (url: string) => void;
}

export const Lobby: React.FC<LobbyProps> = ({
  onJoin,
  defaultName = 'Alex Johnson',
  defaultRoomId = 'TEST-ROOM',
  serverUrl,
  onUpdateServerUrl,
}) => {
  const [roomId, setRoomId] = useState(defaultRoomId);
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<CallMode>('video');
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [customServerUrl, setCustomServerUrl] = useState(serverUrl);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Initialize camera preview
  useEffect(() => {
    let active = true;

    async function startPreview() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
          audio: true,
        });
        if (active) {
          setPreviewStream(stream);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
          }
        }
      } catch (err) {
        console.warn('Could not access camera/mic preview:', err);
      }
    }

    startPreview();

    return () => {
      active = false;
      previewStream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const togglePreviewCam = () => {
    if (previewStream) {
      previewStream.getVideoTracks().forEach((t) => {
        t.enabled = !cameraEnabled;
      });
      setCameraEnabled(!cameraEnabled);
    }
  };

  const togglePreviewMic = () => {
    if (previewStream) {
      previewStream.getAudioTracks().forEach((t) => {
        t.enabled = !micEnabled;
      });
      setMicEnabled(!micEnabled);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId.trim() || !name.trim()) return;
    // Release preview stream so ActiveCall can take control of media
    previewStream?.getTracks().forEach((t) => t.stop());
    onJoin(roomId.trim().toUpperCase(), name.trim(), mode);
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
                <span>Camera is Off</span>
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
            <label className="form-label" htmlFor="roomIdInput">
              Meeting Room ID
            </label>
            <input
              id="roomIdInput"
              type="text"
              className="form-input"
              placeholder="e.g. DEMO-50-ROOM"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.toUpperCase())}
              required
            />
          </div>

          {/* Join Call Button */}
          <button type="submit" className="join-submit-btn">
            <span>Join {mode === 'video' ? 'Video Meeting' : 'Voice Room'}</span>
            <ArrowRight size={18} />
          </button>
        </form>

        {/* Server Connection Config (Optional) */}
        <div className="server-config-section">
          <button
            type="button"
            className="server-config-toggle"
            onClick={() => setShowServerConfig(!showServerConfig)}
          >
            <Settings size={14} />
            <span>Signaling Server: {serverUrl}</span>
          </button>

          {showServerConfig && (
            <div className="server-config-card">
              <label className="server-config-label">
                Backend Signaling Server URL:
              </label>
              <div className="server-input-row">
                <input
                  type="text"
                  className="server-input"
                  placeholder="e.g. http://localhost:4000 or https://your-server.com"
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
                  Save
                </button>
              </div>
              <p className="server-config-hint">
                Enter your backend team's server IP or domain to connect with other real devices.
              </p>
            </div>
          )}
        </div>

        {/* Feature Badges Footer */}
        <div className="lobby-features">
          <div className="feature-item">
            <ShieldCheck size={16} color="#10B981" />
            <span>P2P Encrypted</span>
          </div>
          <div className="feature-item">
            <Sparkles size={16} color="#2563EB" />
            <span>50-User Stress Test Ready</span>
          </div>
        </div>
      </div>
    </div>
  );
};

