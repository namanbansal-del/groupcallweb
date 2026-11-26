import React, { useEffect, useRef, useState } from 'react';
import { Video, VideoOff, Mic, MicOff, Users, ArrowRight, Dices, Shield, Key, LogIn, LogOut, Lock } from 'lucide-react';
import type { CallMode } from '../types';
import { AuthModal, type AuthUser } from './AuthModal';

interface LobbyProps {
  onJoin: (
    roomId: string,
    name: string,
    mode: CallMode,
    cameraEnabled?: boolean,
    micEnabled?: boolean,
    existingStream?: MediaStream | null,
    isHost?: boolean
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
  // Stored Authenticated User (Required to Join Meeting)
  const [authenticatedUser, setAuthenticatedUser] = useState<AuthUser | null>(() => {
    try {
      const stored = localStorage.getItem('calling_currentUser');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  // Auto-open auth modal if user is not yet logged in
  const [showAuthModal, setShowAuthModal] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('calling_currentUser');
    } catch {
      return true;
    }
  });

  // Generate a random room by default (Google Meet style abc-defg-hij)
  const [roomId, setRoomId] = useState(() => {
    if (defaultRoomId) return defaultRoomId;
    return generateMeetCode();
  });
  const [name, setName] = useState(() => authenticatedUser?.name || defaultName);
  const mode: CallMode = 'video';
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [customServerUrl, setCustomServerUrl] = useState(serverUrl);
  const [joinAsHost, setJoinAsHost] = useState(false);
  const [hostKey, setHostKey] = useState('admin123');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (defaultName) {
      setName(defaultName);
    }
  }, [defaultName]);

  // Initialize camera preview for video meeting
  useEffect(() => {
    let active = true;

    async function startPreview() {
      try {
        setCameraError(null);
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'user',
              width: { ideal: 1280, min: 640 },
              height: { ideal: 720, min: 360 },
              aspectRatio: { ideal: 1.7777777778 },
            },
            audio: true,
          });
        } catch (strictErr) {
          console.warn('Ideal camera constraints failed, trying basic fallback:', strictErr);
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });
        }

        if (active) {
          previewStreamRef.current = stream;
          setPreviewStream(stream);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => {});
          }
        } else {
          stream.getTracks().forEach((t) => t.stop());
        }
      } catch (err: any) {
        console.warn('Could not access camera/mic preview:', err);
        if (active) {
          // Fallback to video-only if audio device is locked or unavailable
          try {
            const videoOnlyStream = await navigator.mediaDevices.getUserMedia({ video: true });
            if (active) {
              previewStreamRef.current = videoOnlyStream;
              setPreviewStream(videoOnlyStream);
              setMicEnabled(false);
              if (videoRef.current) {
                videoRef.current.srcObject = videoOnlyStream;
                videoRef.current.play().catch(() => {});
              }
              return;
            } else {
              videoOnlyStream.getTracks().forEach((t) => t.stop());
            }
          } catch (_) {
            // Both failed
          }

          setCameraError(
            err.name === 'NotAllowedError'
              ? 'Camera/microphone access blocked in browser. Please enable permissions in your address bar.'
              : 'Could not access camera device. Check permissions or close other apps using the camera.'
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

  // Ensure videoRef always has the active stream attached and playing
  useEffect(() => {
    if (videoRef.current) {
      if (previewStream && cameraEnabled) {
        videoRef.current.srcObject = previewStream;
        videoRef.current.play().catch((err) => {
          console.warn('Preview video play warning:', err);
        });
      } else {
        videoRef.current.srcObject = null;
      }
    }
  }, [previewStream, cameraEnabled]);

  const togglePreviewCam = async () => {
    const nextState = !cameraEnabled;
    setCameraEnabled(nextState);

    if (!nextState) {
      // User turned camera OFF: Stop all video tracks to completely release hardware camera sensor and turn off green LED
      if (previewStreamRef.current) {
        previewStreamRef.current.getVideoTracks().forEach((t) => {
          t.stop();
          previewStreamRef.current?.removeTrack(t);
        });
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setPreviewStream((prev) => {
        if (!prev) return null;
        return new MediaStream(prev.getAudioTracks());
      });
    } else {
      // User turned camera ON: Re-acquire camera stream and turn green LED on
      try {
        let videoStream: MediaStream;
        try {
          videoStream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'user',
              width: { ideal: 1280, min: 640 },
              height: { ideal: 720, min: 360 },
              aspectRatio: { ideal: 1.7777777778 },
            },
          });
        } catch {
          videoStream = await navigator.mediaDevices.getUserMedia({ video: true });
        }

        const newVideoTrack = videoStream.getVideoTracks()[0];
        if (newVideoTrack) {
          if (!previewStreamRef.current) {
            previewStreamRef.current = new MediaStream([newVideoTrack]);
          } else {
            previewStreamRef.current.addTrack(newVideoTrack);
          }
          const updatedStream = new MediaStream(previewStreamRef.current.getTracks());
          setPreviewStream(updatedStream);
          if (videoRef.current) {
            videoRef.current.srcObject = updatedStream;
            videoRef.current.play().catch(() => {});
          }
        }
      } catch (err) {
        console.warn('Failed to re-enable camera:', err);
        setCameraEnabled(false);
      }
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

  const handleAuthSuccess = (user: AuthUser) => {
    setAuthenticatedUser(user);
    setName(user.name);
    try {
      localStorage.setItem('groupcall_user_name', user.name);
    } catch {}
  };

  const handleSignOut = () => {
    localStorage.removeItem('calling_authToken');
    localStorage.removeItem('calling_currentUser');
    setAuthenticatedUser(null);
  };

  const generateRandomRoom = () => {
    setRoomId(generateMeetCode());
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!authenticatedUser) {
      setShowAuthModal(true);
      return;
    }
    if (!roomId.trim() || !name.trim()) return;

    let stream = previewStreamRef.current;
    if (!cameraEnabled && stream) {
      // Ensure all video tracks are stopped so the green camera light is off if joining with camera disabled
      stream.getVideoTracks().forEach((t) => {
        t.stop();
        stream?.removeTrack(t);
      });
    }

    previewStreamRef.current = null;
    setPreviewStream(null);

    const isHost = joinAsHost && (hostKey.trim().length > 0);

    onJoin(
      roomId.trim().toUpperCase(),
      name.trim(),
      mode,
      cameraEnabled,
      micEnabled,
      stream,
      isHost
    );
  };

  return (
    <div className="lobby-wrapper">
      <div className="lobby-card">
        <div className="lobby-grid">
          {/* Left Column: Big Responsive Camera Preview */}
          <div className="lobby-preview-col">
            <div className="preview-container">
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="preview-video video-mirrored"
                style={{ display: cameraEnabled && previewStream ? 'block' : 'none' }}
              />
              {(!cameraEnabled || !previewStream) && (
                <div className="preview-placeholder">
                  <div className="preview-avatar">
                    {name ? name.slice(0, 1).toUpperCase() : '?'}
                  </div>
                  <span className="preview-status-text">
                    {cameraError || (!cameraEnabled ? 'Camera is Off' : 'Starting camera preview...')}
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
                  {micEnabled ? <Mic size={20} /> : <MicOff size={20} />}
                </button>
                <button
                  type="button"
                  className={`preview-ctrl-btn ${!cameraEnabled ? 'ctrl-off' : ''}`}
                  onClick={togglePreviewCam}
                  title={cameraEnabled ? 'Turn Off Camera' : 'Turn On Camera'}
                >
                  {cameraEnabled ? <Video size={20} /> : <VideoOff size={20} />}
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Header & Join Form */}
          <div className="lobby-action-col">
            <div className="lobby-header">
              <div className="lobby-header-top-row">
                <div className="lobby-badge">
                  <Users size={16} color="#2563EB" />
                  <span>GroupCall 50 Web</span>
                </div>

                {/* Account / Sign In Pill */}
                {authenticatedUser ? (
                  <div className="lobby-account-pill">
                    <div className="lobby-account-avatar">
                      {authenticatedUser.name.slice(0, 1).toUpperCase()}
                    </div>
                    <span className="lobby-account-name">{authenticatedUser.name}</span>
                    <button
                      type="button"
                      className="lobby-account-logout"
                      onClick={handleSignOut}
                      title="Sign Out"
                    >
                      <LogOut size={13} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="lobby-signin-btn"
                    onClick={() => setShowAuthModal(true)}
                  >
                    <LogIn size={14} />
                    <span>Sign In</span>
                  </button>
                )}
              </div>

              <h1 className="lobby-title">Enterprise WebRTC Group Calling</h1>
              <p className="lobby-subtitle">
                HD Video Meetings supporting up to 50 concurrent participants
              </p>
            </div>

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

              {/* Host / Admin Login Section */}
              <div className="host-login-box">
                <label className="host-toggle-label">
                  <input
                    type="checkbox"
                    checked={joinAsHost}
                    onChange={(e) => setJoinAsHost(e.target.checked)}
                    className="host-checkbox"
                  />
                  <div className="host-toggle-content">
                    <div className="host-toggle-title">
                      <Shield size={16} color="#2563EB" />
                      <span>Join as Meeting Host / Admin</span>
                    </div>
                    <span className="host-toggle-desc">
                      Full control: mute anyone, lock screen sharing, and manage meeting permissions
                    </span>
                  </div>
                </label>

                {joinAsHost && (
                  <div className="host-key-wrap">
                    <div className="host-key-input-row">
                      <Key size={14} color="#64748B" />
                      <input
                        type="password"
                        className="host-key-input"
                        placeholder="Admin Host Passcode (default: admin123)"
                        value={hostKey}
                        onChange={(e) => setHostKey(e.target.value)}
                      />
                    </div>
                    <span className="host-key-hint">Default passcode: <code>admin123</code></span>
                  </div>
                )}
              </div>

              {/* Mandatory Auth Gate Banner if not signed in */}
              {!authenticatedUser && (
                <div className="auth-required-gate-box" onClick={() => setShowAuthModal(true)}>
                  <div className="auth-gate-icon-circle">
                    <Lock size={15} color="#2563EB" />
                  </div>
                  <div className="auth-gate-text">
                    <strong>Account Required</strong>
                    <span>Sign in or register an account to enter video calls</span>
                  </div>
                  <button type="button" className="auth-gate-pill-btn">Sign In</button>
                </div>
              )}

              {/* Join Call Button (Requires Auth) */}
              {authenticatedUser ? (
                <button type="submit" className="join-submit-btn">
                  <span>{joinAsHost ? 'Join as Meeting Host 👑' : 'Join Video Meeting'}</span>
                  <ArrowRight size={18} />
                </button>
              ) : (
                <button
                  type="button"
                  className="join-submit-btn auth-required-btn"
                  onClick={() => setShowAuthModal(true)}
                >
                  <LogIn size={18} />
                  <span>Sign In / Sign Up to Join</span>
                </button>
              )}
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
      </div>

      {/* Login & Signup Modal */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        serverUrl={serverUrl}
        onAuthSuccess={handleAuthSuccess}
      />
    </div>
  );
};
