import React, { useState, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import {
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneOff,
  User,
  Lock,
  CheckCircle,
  AlertCircle,
  LogIn,
  UserPlus,
  LogOut,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Activity,
  ShieldCheck,
} from 'lucide-react';

interface DirectUser {
  id: string;
  name: string;
  phone: string;
}

interface IncomingCallInfo {
  callId: string;
  callerName: string;
  callerPhone: string;
  callerSocketId: string;
  roomCode?: string;
}

interface DirectCallingPanelProps {
  socket: Socket | null;
  serverUrl: string;
  isSocketConnected: boolean;
}

export const DirectCallingPanel: React.FC<DirectCallingPanelProps> = ({
  socket,
  serverUrl,
  isSocketConnected,
}) => {
  // Auth State
  const [currentUser, setCurrentUser] = useState<DirectUser | null>(() => {
    try {
      const stored = localStorage.getItem('calling_currentUser');
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [nameInput, setNameInput] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSuccess, setAuthSuccess] = useState<string | null>(null);

  // Calling State
  const [targetPhone, setTargetPhone] = useState('');
  const [callState, setCallState] = useState<'idle' | 'ringing' | 'connected' | 'ended'>('idle');
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);
  const [callStatusMessage, setCallStatusMessage] = useState<string | null>(null);
  const [callDuration, setCallDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(true);

  // Media & WebRTC Refs
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const currentCallIdRef = useRef<string | null>(null);
  const activePeerSidRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const iceServersRef = useRef<RTCIceServer[]>([
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ]);

  // Fetch STUN/TURN ice servers on mount
  useEffect(() => {
    fetch(`${serverUrl}/api/webrtc/config`)
      .then((res) => res.json())
      .then((cfg) => {
        if (cfg.iceServers?.length) {
          iceServersRef.current = cfg.iceServers;
        }
      })
      .catch((err) => console.warn('Could not fetch ice servers:', err));
  }, [serverUrl]);

  // Auto-connect socket with auth token if logged in
  useEffect(() => {
    if (socket && currentUser) {
      const token = localStorage.getItem('calling_authToken');
      if (token) {
        socket.auth = { token };
        if (!socket.connected) {
          socket.connect();
        }
      }
    }
  }, [socket, currentUser]);

  // Direct Calling Socket Event Listeners
  useEffect(() => {
    if (!socket) return;

    const onIncomingCall = (data: IncomingCallInfo) => {
      console.log('[Direct Call] Incoming call:', data);
      setIncomingCall(data);
      currentCallIdRef.current = data.callId;
      activePeerSidRef.current = data.callerSocketId;
    };

    const onCallAccepted = async (data: any) => {
      console.log('[Direct Call] Call accepted by peer:', data);
      setCallState('connected');
      setCallStatusMessage('Call Connected');
      activePeerSidRef.current = data.calleeSocketId;
      // Start duration timer
      startCallTimer();
      // Caller initiates WebRTC offer
      await createOffer(data.calleeSocketId);
    };

    const onCallRejected = () => {
      console.log('[Direct Call] Call was rejected or busy');
      setCallStatusMessage('Call was declined or user is busy');
      cleanupCallSession();
    };

    const onCallEnded = () => {
      console.log('[Direct Call] Call ended by peer');
      setCallStatusMessage('Call ended by peer');
      cleanupCallSession();
    };

    const onReceiveOffer = async (payload: { from: string; offer: RTCSessionDescriptionInit }) => {
      console.log('[Direct Call] Received WebRTC offer from:', payload.from);
      activePeerSidRef.current = payload.from;
      await handleReceiveOffer(payload.from, payload.offer);
    };

    const onReceiveAnswer = async (payload: { from: string; answer: RTCSessionDescriptionInit }) => {
      console.log('[Direct Call] Received WebRTC answer from:', payload.from);
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(payload.answer));
      }
    };

    const onReceiveCandidate = async (payload: { from: string; candidate: RTCIceCandidateInit }) => {
      if (peerConnectionRef.current && payload.candidate) {
        try {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (e) {
          console.warn('[Direct Call] addIceCandidate error:', e);
        }
      }
    };

    const onPeerDisconnected = () => {
      if (callState === 'connected' || callState === 'ringing') {
        setCallStatusMessage('Participant disconnected');
        cleanupCallSession();
      }
    };

    socket.on('call:incoming', onIncomingCall);
    socket.on('call:accepted', onCallAccepted);
    socket.on('call:rejected', onCallRejected);
    socket.on('call:ended', onCallEnded);
    socket.on('offer', onReceiveOffer);
    socket.on('answer', onReceiveAnswer);
    socket.on('ice-candidate', onReceiveCandidate);
    socket.on('user-disconnected', onPeerDisconnected);
    socket.on('user-left', onPeerDisconnected);

    return () => {
      socket.off('call:incoming', onIncomingCall);
      socket.off('call:accepted', onCallAccepted);
      socket.off('call:rejected', onCallRejected);
      socket.off('call:ended', onCallEnded);
      socket.off('offer', onReceiveOffer);
      socket.off('answer', onReceiveAnswer);
      socket.off('ice-candidate', onReceiveCandidate);
      socket.off('user-disconnected', onPeerDisconnected);
      socket.off('user-left', onPeerDisconnected);
    };
  }, [socket, callState]);

  // Duration Timer
  const startCallTimer = () => {
    setCallDuration(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setCallDuration((prev) => prev + 1);
    }, 1000);
  };

  const stopCallTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Capture Local Audio/Video
  const getLocalMediaStream = async (enableVideo: boolean = false): Promise<MediaStream> => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: enableVideo,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current && enableVideo) {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (err: any) {
      console.warn('Microphone/Camera capture error:', err);
      // Fallback to audio only
      const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = audioOnly;
      return audioOnly;
    }
  };

  // Get or Create RTCPeerConnection
  const getOrCreatePeerConnection = async (targetSid: string): Promise<RTCPeerConnection> => {
    if (peerConnectionRef.current) return peerConnectionRef.current;

    const pc = new RTCPeerConnection({
      iceServers: iceServersRef.current,
    });

    const stream = await getLocalMediaStream(!isCameraOff);
    stream.getTracks().forEach((track) => {
      pc.addTrack(track, stream);
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('ice-candidate', {
          targetId: targetSid,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      console.log('[Direct Call] ontrack received remote media:', event.track.kind);
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      if (event.track.kind === 'video' && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
      if (event.track.kind === 'audio' && remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.play().catch(() => {});
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[Direct Call] ICE connection state:', pc.iceConnectionState);
      if (['disconnected', 'failed', 'closed'].includes(pc.iceConnectionState)) {
        cleanupCallSession();
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  };

  // Create & Relay SDP Offer
  const createOffer = async (targetSid: string) => {
    if (!socket) return;
    try {
      const pc = await getOrCreatePeerConnection(targetSid);
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);

      socket.emit('offer', {
        targetId: targetSid,
        offer: pc.localDescription,
      });
    } catch (err) {
      console.error('[Direct Call] Create offer error:', err);
    }
  };

  // Handle Received SDP Offer & Relay Answer
  const handleReceiveOffer = async (fromSid: string, offer: RTCSessionDescriptionInit) => {
    if (!socket) return;
    try {
      const pc = await getOrCreatePeerConnection(fromSid);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer', {
        targetId: fromSid,
        answer: pc.localDescription,
      });
      setCallState('connected');
      startCallTimer();
    } catch (err) {
      console.error('[Direct Call] Handle offer error:', err);
    }
  };

  // Cleanup active call
  const cleanupCallSession = () => {
    stopCallTimer();
    setCallState('idle');
    setIncomingCall(null);
    currentCallIdRef.current = null;
    activePeerSidRef.current = null;

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
  };

  // 1-to-1 Calling Actions
  const handleInitiateCall = async () => {
    if (!targetPhone.trim() || !socket) return;
    setAuthError(null);
    setCallStatusMessage(`Calling ${targetPhone}...`);
    setCallState('ringing');

    try {
      await getLocalMediaStream(!isCameraOff);
      socket.emit(
        'call:initiate',
        { toPhone: targetPhone.trim() },
        (res: { ok: boolean; callId?: string; error?: string }) => {
          if (res?.ok && res.callId) {
            currentCallIdRef.current = res.callId;
            setCallStatusMessage(`Ringing ${targetPhone}...`);
          } else {
            setCallStatusMessage(res?.error || 'Call failed: user is offline or not found');
            cleanupCallSession();
          }
        }
      );
    } catch (err: any) {
      setCallStatusMessage(`Media error: ${err.message}`);
      cleanupCallSession();
    }
  };

  const handleAcceptIncomingCall = async () => {
    if (!incomingCall || !socket) return;
    const { callId, callerSocketId } = incomingCall;
    setIncomingCall(null);
    setCallState('connected');
    setCallStatusMessage('Connecting call...');

    try {
      await getLocalMediaStream(!isCameraOff);
      socket.emit('call:accept', {
        callerSocketId,
        callId,
      });
      startCallTimer();
    } catch (err: any) {
      console.error('Accept call media error:', err);
      cleanupCallSession();
    }
  };

  const handleRejectIncomingCall = () => {
    if (!incomingCall || !socket) return;
    socket.emit('call:reject', {
      callerSocketId: incomingCall.callerSocketId,
      callId: incomingCall.callId,
    });
    setIncomingCall(null);
  };

  const handleEndCall = () => {
    if (socket && (activePeerSidRef.current || currentCallIdRef.current)) {
      socket.emit('call:end', {
        targetSocketId: activePeerSidRef.current,
        callId: currentCallIdRef.current,
      });
    }
    cleanupCallSession();
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleCamera = async () => {
    const nextState = !isCameraOff;
    setIsCameraOff(nextState);
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !nextState;
      }
    }
  };

  // Authentication Handlers
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    setAuthSuccess(null);

    const endpoint = authMode === 'signup' ? '/api/calling/signup' : '/api/calling/login';
    const body = authMode === 'signup'
      ? { name: nameInput.trim(), phone: phoneInput.trim(), password: passwordInput }
      : { phone: phoneInput.trim(), password: passwordInput };

    try {
      const res = await fetch(`${serverUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      localStorage.setItem('calling_authToken', data.token);
      localStorage.setItem('calling_currentUser', JSON.stringify(data.user));
      setCurrentUser(data.user);
      setAuthSuccess(`Signed in as ${data.user.name} (${data.user.phone})`);

      // Register socket with token
      if (socket) {
        socket.auth = { token: data.token };
        socket.disconnect().connect();
      }
    } catch (err: any) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = () => {
    localStorage.removeItem('calling_authToken');
    localStorage.removeItem('calling_currentUser');
    setCurrentUser(null);
    setAuthSuccess(null);
    if (socket) {
      socket.auth = {};
      socket.disconnect().connect();
    }
  };

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="direct-calling-container">
      {/* Hidden audio element for remote audio playback */}
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {/* ── 1. INCOMING CALL MODAL ───────────────────────────────── */}
      {incomingCall && (
        <div className="incoming-modal-backdrop">
          <div className="incoming-modal-card">
            <div className="incoming-pulse-icon">
              <PhoneIncoming size={36} color="#FFFFFF" />
            </div>
            <span className="incoming-modal-tag">Incoming Direct Call</span>
            <h3 className="incoming-caller-name">{incomingCall.callerName}</h3>
            <p className="incoming-caller-phone">{incomingCall.callerPhone}</p>

            <div className="incoming-modal-actions">
              <button
                type="button"
                className="incoming-btn-decline"
                onClick={handleRejectIncomingCall}
              >
                <PhoneOff size={18} />
                <span>Decline</span>
              </button>
              <button
                type="button"
                className="incoming-btn-accept"
                onClick={handleAcceptIncomingCall}
              >
                <PhoneCall size={18} />
                <span>Accept</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 2. ACTIVE DIRECT CALL SCREEN ─────────────────────────── */}
      {callState === 'connected' || callState === 'ringing' ? (
        <div className="direct-active-call-card">
          <div className="direct-call-header">
            <div className="call-avatar-pulse">
              <Phone size={32} color="#FFFFFF" />
            </div>
            <h3 className="direct-call-title">
              {callState === 'connected' ? 'Call in Progress' : 'Calling...'}
            </h3>
            <p className="direct-call-phone">
              {targetPhone || activePeerSidRef.current || 'Direct Connection'}
            </p>
            <div className="direct-call-status-badge">
              <span className={`status-indicator-dot ${callState === 'connected' ? 'dot-active' : 'dot-ringing'}`} />
              <span>{callState === 'connected' ? formatDuration(callDuration) : 'Ringing...'}</span>
            </div>
          </div>

          {/* Optional video tiles if video is active */}
          {!isCameraOff && (
            <div className="direct-video-preview-row">
              <video ref={localVideoRef} autoPlay playsInline muted className="direct-local-video" />
              <video ref={remoteVideoRef} autoPlay playsInline className="direct-remote-video" />
            </div>
          )}

          {/* Controls */}
          <div className="direct-call-controls">
            <button
              type="button"
              className={`direct-ctrl-btn ${isMuted ? 'btn-danger-active' : ''}`}
              onClick={toggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            <button
              type="button"
              className={`direct-ctrl-btn ${isCameraOff ? 'btn-off' : ''}`}
              onClick={toggleCamera}
              title={isCameraOff ? 'Turn on video' : 'Turn off video'}
            >
              {isCameraOff ? <VideoOff size={20} /> : <Video size={20} />}
            </button>
            <button
              type="button"
              className="direct-ctrl-btn btn-end-call"
              onClick={handleEndCall}
              title="End Call"
            >
              <PhoneOff size={22} />
            </button>
          </div>
        </div>
      ) : (
        /* ── 3. LOBBY DIALER & AUTH PANEL ───────────────────────── */
        <div className="direct-lobby-content">
          {/* User Profile / Auth Status Bar */}
          {currentUser ? (
            <div className="auth-profile-card">
              <div className="auth-profile-info">
                <div className="auth-avatar">{currentUser.name.slice(0, 1).toUpperCase()}</div>
                <div>
                  <div className="auth-name-row">
                    <span className="auth-user-name">{currentUser.name}</span>
                    <span className="auth-online-pill">
                      <span className="auth-online-dot" /> Online
                    </span>
                  </div>
                  <span className="auth-user-phone">{currentUser.phone}</span>
                </div>
              </div>
              <button
                type="button"
                className="auth-logout-btn"
                onClick={handleSignOut}
                title="Sign out of phone calling"
              >
                <LogOut size={14} />
                <span>Sign Out</span>
              </button>
            </div>
          ) : (
            <div className="auth-box">
              <div className="auth-tabs">
                <button
                  type="button"
                  className={`auth-tab ${authMode === 'login' ? 'active' : ''}`}
                  onClick={() => setAuthMode('login')}
                >
                  <LogIn size={14} />
                  <span>Log In</span>
                </button>
                <button
                  type="button"
                  className={`auth-tab ${authMode === 'signup' ? 'active' : ''}`}
                  onClick={() => setAuthMode('signup')}
                >
                  <UserPlus size={14} />
                  <span>Register Phone</span>
                </button>
              </div>

              <form onSubmit={handleAuthSubmit} className="auth-form">
                {authMode === 'signup' && (
                  <div className="auth-input-group">
                    <label>Full Name</label>
                    <div className="auth-input-wrapper">
                      <User size={15} color="#64748B" />
                      <input
                        type="text"
                        placeholder="e.g. Alice Johnson"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        required={authMode === 'signup'}
                      />
                    </div>
                  </div>
                )}

                <div className="auth-input-group">
                  <label>Phone Number</label>
                  <div className="auth-input-wrapper">
                    <Phone size={15} color="#64748B" />
                    <input
                      type="tel"
                      placeholder="+1234567890"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="auth-input-group">
                  <label>Password</label>
                  <div className="auth-input-wrapper">
                    <Lock size={15} color="#64748B" />
                    <input
                      type="password"
                      placeholder="••••••••"
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      required
                    />
                  </div>
                </div>

                {authError && (
                  <div className="auth-alert alert-error">
                    <AlertCircle size={14} />
                    <span>{authError}</span>
                  </div>
                )}
                {authSuccess && (
                  <div className="auth-alert alert-success">
                    <CheckCircle size={14} />
                    <span>{authSuccess}</span>
                  </div>
                )}

                <button type="submit" className="auth-submit-btn" disabled={authLoading}>
                  <span>{authLoading ? 'Authenticating...' : authMode === 'signup' ? 'Sign Up' : 'Log In'}</span>
                </button>
              </form>
            </div>
          )}

          {/* 1-to-1 Phone Dialer */}
          <div className="dialer-section">
            <h4 className="dialer-title">Direct 1-to-1 WebRTC Calling</h4>
            <p className="dialer-desc">
              Call any registered mobile app or web participant directly by their phone number.
            </p>

            <div className="dialer-input-row">
              <div className="dialer-input-wrapper">
                <Phone size={16} color="#64748B" />
                <input
                  type="tel"
                  className="dialer-input"
                  placeholder="Enter Callee's Phone (e.g. +1234567890)"
                  value={targetPhone}
                  onChange={(e) => setTargetPhone(e.target.value)}
                />
              </div>

              <button
                type="button"
                className="dialer-call-btn"
                onClick={handleInitiateCall}
                disabled={!targetPhone.trim() || !isSocketConnected}
              >
                <PhoneCall size={16} />
                <span>Call</span>
              </button>
            </div>

            {callStatusMessage && (
              <div className="call-status-pill">
                <Activity size={14} />
                <span>{callStatusMessage}</span>
              </div>
            )}
          </div>

          {/* API Health Pill */}
          <div className="api-health-box">
            <ShieldCheck size={16} color="#10B981" />
            <div className="api-health-text">
              <span>Signaling: <strong>{isSocketConnected ? 'Online (WS & Polling)' : 'Connecting...'}</strong></span>
              <span className="api-subtext">STUN/TURN: {iceServersRef.current.length} Servers Active</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
