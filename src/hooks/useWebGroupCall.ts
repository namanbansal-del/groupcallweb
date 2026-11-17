import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallMode, GroupCallState, Participant } from '../types';

const FALLBACK_ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

const SAMPLE_NAMES = [
  'Sarah Jenkins', 'Rohan Verma', 'Fatima Al-Mansoor', 'Nikola Tesla',
  'David Kim', 'Elena Rostova', 'Marcus Brody', 'Aisha Diallo',
  'Liam Chen', 'Olivia Martin', 'Ethan Brown', 'Sophia Lee',
  'Mason Garcia', 'Isabella Miller', 'James Davis', 'Mia Rodriguez',
  'Benjamin Martinez', 'Charlotte Hernandez', 'Lucas Lopez', 'Amelia Gonzalez',
  'Henry Wilson', 'Harper Anderson', 'Alexander Thomas', 'Evelyn Taylor',
  'Daniel Moore', 'Abigail Jackson', 'Matthew Martin', 'Emily Lee',
  'Jackson Perez', 'Elizabeth Thompson', 'Sebastian White', 'Mila Harris',
  'Jack Sanchez', 'Ella Clark', 'Samuel Ramirez', 'Avery Lewis',
  'Owen Robinson', 'Sofia Walker', 'Theodore Young', 'Camila Allen',
  'Wyatt King', 'Aria Wright', 'John Scott', 'Scarlett Torres',
  'Leo Nguyen', 'Victoria Hill', 'Oliver Flores', 'Grace Green',
  'Noah Adams', 'Chloe Nelson',
];

export function useWebGroupCall({
  socket,
  currentUser,
  serverUrl,
}: {
  socket: any;
  currentUser: { id: string; name: string; avatar?: string };
  serverUrl?: string;
}) {
  const initialLocal: Participant = {
    id: currentUser.id,
    name: currentUser.name,
    avatar: currentUser.avatar,
    isMuted: false,
    isCameraOff: false,
    isSpeaking: false,
    isHandRaised: false,
    isScreenSharing: false,
    isHost: true,
    stream: null,
  };

  const [callState, setCallState] = useState<GroupCallState>({
    roomId: null,
    mode: 'video',
    status: 'idle',
    participants: [],
    localParticipant: initialLocal,
    activeSpeakerId: null,
    isMuted: false,
    isCameraOff: false,
    isHandRaised: false,
    isScreenSharing: false,
    durationSec: 0,
    error: null,
  });

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [iceConfig, setIceConfig] = useState<RTCConfiguration>(FALLBACK_ICE_SERVERS);

  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const peerStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const timerRef = useRef<number | null>(null);
  const simulationTimerRef = useRef<number | null>(null);
  const stateRef = useRef(callState);
  stateRef.current = callState;

  // ── Web Audio Analyser for Speaking Pulse ────────────────────────
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // ── Fetch ICE Config from REST Endpoint (/api/webrtc/config) ─────
  useEffect(() => {
    let active = true;
    async function fetchIce() {
      if (!serverUrl) return;
      try {
        const res = await fetch(`${serverUrl}/api/webrtc/config`);
        const data = await res.json();
        if (active && data?.iceServers && Array.isArray(data.iceServers)) {
          console.log('[Web ICE Config] Loaded', data.iceServers.length, 'servers from backend');
          setIceConfig({ iceServers: data.iceServers });
        }
      } catch (err) {
        console.warn('[Web ICE Config] Using fallback Google STUN');
      }
    }
    fetchIce();
    return () => {
      active = false;
    };
  }, [serverUrl]);

  const setupAudioDetection = useCallback((stream: MediaStream) => {
    try {
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) return;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;

      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = ctx;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const checkAudioLevel = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        const isSpeaking = average > 18 && !stateRef.current.isMuted;

        if (stateRef.current.localParticipant.isSpeaking !== isSpeaking) {
          setCallState((prev) => ({
            ...prev,
            localParticipant: { ...prev.localParticipant, isSpeaking },
          }));
        }

        animFrameRef.current = requestAnimationFrame(checkAudioLevel);
      };

      checkAudioLevel();
    } catch (e) {
      console.warn('Audio detection not supported:', e);
    }
  }, []);

  // ── Create Peer Connection for a Remote Peer (socketId) ───────────
  const createPeer = useCallback(
    async (remoteSocketId: string, _remoteUserName?: string, isInitiator: boolean = false) => {
      if (peersRef.current.has(remoteSocketId)) {
        return peersRef.current.get(remoteSocketId)!;
      }

      const pc = new RTCPeerConnection(iceConfig);
      peersRef.current.set(remoteSocketId, pc);

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current!);
        });
      }

      // Relay ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && socket?.connected) {
          socket.emit('ice-candidate', {
            to: remoteSocketId,
            candidate: event.candidate.toJSON(),
          });
          // Backward-compatible alias
          socket.emit('peer:ice-candidate', {
            roomId: stateRef.current.roomId,
            targetUserId: remoteSocketId,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      // Remote stream received
      pc.ontrack = (event) => {
        let stream = peerStreamsRef.current.get(remoteSocketId);
        if (event.streams && event.streams[0]) {
          stream = event.streams[0];
        } else {
          if (!stream) stream = new MediaStream();
          stream.addTrack(event.track);
        }
        if (stream) {
          peerStreamsRef.current.set(remoteSocketId, stream);
        }

        setCallState((prev) => ({
          ...prev,
          participants: prev.participants.map((p) =>
            p.id === remoteSocketId ? { ...p, stream } : p,
          ),
        }));
      };

      if (isInitiator) {
        try {
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
          });
          await pc.setLocalDescription(offer);

          // Standard guide event
          socket?.emit('offer', {
            to: remoteSocketId,
            offer: pc.localDescription,
          });
          // Backward-compatible alias
          socket?.emit('peer:offer', {
            roomId: stateRef.current.roomId,
            targetUserId: remoteSocketId,
            sdp: pc.localDescription,
          });
        } catch (e) {
          console.error('Error creating offer for peer', remoteSocketId, e);
        }
      }

      return pc;
    },
    [iceConfig, socket],
  );

  // ── Join Group Call ──────────────────────────────────────────────
  const joinGroupCall = useCallback(
    async (roomId: string, mode: CallMode = 'video') => {
      const roomCode = roomId.trim().toUpperCase() || 'TEST-ROOM';

      try {
        setCallState((prev) => ({
          ...prev,
          roomId: roomCode,
          mode,
          status: 'joining',
          error: null,
          localParticipant: {
            ...prev.localParticipant,
            name: currentUser.name,
          },
        }));

        let stream: MediaStream | null = null;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: mode === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 } } : false,
          });
        } catch (mediaErr: any) {
          console.warn('getUserMedia warning:', mediaErr);
          if (mode === 'video') {
            try {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch {
              stream = null;
            }
          }
        }

        localStreamRef.current = stream;
        setLocalStream(stream);

        if (stream) {
          setupAudioDetection(stream);
        }

        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = window.setInterval(() => {
          setCallState((prev) => ({ ...prev, durationSec: prev.durationSec + 1 }));
        }, 1000);

        setCallState((prev) => ({
          ...prev,
          status: 'joined',
          localParticipant: {
            ...prev.localParticipant,
            stream,
            isMuted: false,
            isCameraOff: mode === 'audio',
          },
        }));

        if (socket?.connected) {
          // Standard guide event: join-room
          socket.emit(
            'join-room',
            {
              roomCode,
              userName: currentUser.name,
              userId: currentUser.id,
            },
            (ack: any) => {
              if (ack) {
                console.log(`[Web] Joined '${ack.roomCode}'. Total: ${ack.totalUsers}`);
              }
            },
          );

          // Backward-compatible alias
          socket.emit('room:join', {
            roomId: roomCode,
            user: {
              id: currentUser.id,
              name: currentUser.name,
              avatar: currentUser.avatar,
              isMuted: false,
              isCameraOff: mode === 'audio',
              mode,
            },
          });
        }
      } catch (err: any) {
        setCallState((prev) => ({
          ...prev,
          status: 'idle',
          error: err?.message || 'Failed to join group call',
        }));
      }
    },
    [currentUser, socket, setupAudioDetection],
  );

  // ── Cleanup ──────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (simulationTimerRef.current) {
      clearInterval(simulationTimerRef.current);
      simulationTimerRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }

    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    peerStreamsRef.current.clear();
  }, []);

  // ── Leave Group Call ─────────────────────────────────────────────
  const leaveGroupCall = useCallback(() => {
    if (socket?.connected) {
      // Standard guide event
      socket.emit('leave-room');
      // Backward-compatible alias
      if (stateRef.current.roomId) {
        socket.emit('room:leave', {
          roomId: stateRef.current.roomId,
          userId: currentUser.id,
        });
      }
    }

    cleanup();

    setCallState((prev) => ({
      ...prev,
      status: 'idle',
      roomId: null,
      participants: [],
      durationSec: 0,
      isScreenSharing: false,
    }));
  }, [cleanup, currentUser.id, socket]);

  // ── Toggle Microphone ────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const nextMuted = !stateRef.current.isMuted;
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !nextMuted;
      });
    }
    setCallState((prev) => ({
      ...prev,
      isMuted: nextMuted,
      localParticipant: { ...prev.localParticipant, isMuted: nextMuted },
    }));

    if (socket?.connected) {
      // Standard guide event
      socket.emit('toggle-audio', { enabled: !nextMuted });
    }
  }, [socket]);

  // ── Toggle Camera ────────────────────────────────────────────────
  const toggleCamera = useCallback(() => {
    const nextCameraOff = !stateRef.current.isCameraOff;
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = !nextCameraOff;
      });
    }
    setCallState((prev) => ({
      ...prev,
      isCameraOff: nextCameraOff,
      localParticipant: { ...prev.localParticipant, isCameraOff: nextCameraOff },
    }));

    if (socket?.connected) {
      // Standard guide event
      socket.emit('toggle-video', { enabled: !nextCameraOff });
    }
  }, [socket]);

  // ── Toggle Screen Sharing ────────────────────────────────────────
  const toggleScreenShare = useCallback(async () => {
    if (stateRef.current.isScreenSharing) {
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }

      if (localStreamRef.current) {
        const videoTrack = localStreamRef.current.getVideoTracks()[0];
        if (videoTrack) {
          peersRef.current.forEach((pc) => {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(videoTrack);
          });
        }
      }

      setCallState((prev) => ({
        ...prev,
        isScreenSharing: false,
        localParticipant: {
          ...prev.localParticipant,
          stream: localStreamRef.current,
          isScreenSharing: false,
        },
      }));
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        screenStreamRef.current = screenStream;

        const screenTrack = screenStream.getVideoTracks()[0];
        screenTrack.onended = () => {
          toggleScreenShare();
        };

        peersRef.current.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        });

        setCallState((prev) => ({
          ...prev,
          isScreenSharing: true,
          localParticipant: {
            ...prev.localParticipant,
            stream: screenStream,
            isScreenSharing: true,
          },
        }));
      } catch (err) {
        console.warn('Screen share canceled or failed:', err);
      }
    }
  }, []);

  // ── Toggle Hand Raise ────────────────────────────────────────────
  const toggleHandRaise = useCallback(() => {
    const nextHand = !stateRef.current.isHandRaised;
    setCallState((prev) => ({
      ...prev,
      isHandRaised: nextHand,
      localParticipant: { ...prev.localParticipant, isHandRaised: nextHand },
    }));

    if (socket?.connected) {
      socket.emit('peer:hand-raise', { isHandRaised: nextHand });
    }
  }, [socket]);

  // ── Up to 50 Participants Stress Simulator ───────────────────────
  const addSimulatedUsers = useCallback((count: number = 1, forceVideo = false) => {
    setCallState((prev) => {
      const currentCount = prev.participants.length;
      const newParticipants: Participant[] = [];

      for (let i = 0; i < count; i++) {
        const idx = (currentCount + i) % SAMPLE_NAMES.length;
        const name = `${SAMPLE_NAMES[idx]}`;
        const id = `sim_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;
        newParticipants.push({
          id,
          name,
          isMuted: Math.random() > 0.65,
          isCameraOff: forceVideo ? false : (prev.mode === 'audio' || Math.random() > 0.4),
          isSpeaking: Math.random() > 0.7,
          isHandRaised: Math.random() > 0.85,
          isHost: false,
          stream: null,
        });
      }

      return {
        ...prev,
        participants: [...prev.participants, ...newParticipants],
      };
    });

    if (!simulationTimerRef.current) {
      simulationTimerRef.current = window.setInterval(() => {
        setCallState((prev) => {
          if (prev.participants.length === 0) return prev;
          const updated = prev.participants.map((p) => {
            const roll = Math.random();
            const isSpeaking = !p.isMuted && roll > 0.75;
            return { ...p, isSpeaking };
          });
          return { ...prev, participants: updated };
        });
      }, 2500);
    }
  }, []);

  const fill50SimulatedUsers = useCallback(() => {
    setCallState((prev) => {
      const currentTotal = 1 + prev.participants.length;
      const needed = Math.max(0, 50 - currentTotal);
      if (needed === 0) return prev;

      const newSims: Participant[] = [];
      for (let i = 0; i < needed; i++) {
        const name = SAMPLE_NAMES[i % SAMPLE_NAMES.length];
        const id = `sim_50_${i}_${Date.now()}`;
        newSims.push({
          id,
          name,
          isMuted: i % 3 === 0,
          isCameraOff: prev.mode === 'audio' ? true : i % 4 === 0,
          isSpeaking: i === 1 || i === 3,
          isHandRaised: i === 2 || i === 7,
          isHost: false,
          stream: null,
        });
      }

      return {
        ...prev,
        participants: [...prev.participants, ...newSims],
      };
    });

    if (!simulationTimerRef.current) {
      simulationTimerRef.current = window.setInterval(() => {
        setCallState((prev) => {
          if (prev.participants.length === 0) return prev;
          const updated = prev.participants.map((p, index) => {
            const isSpeaking = !p.isMuted && (index % 4 === Math.floor(Math.random() * 4));
            return { ...p, isSpeaking };
          });
          return { ...prev, participants: updated };
        });
      }, 2800);
    }
  }, []);

  const clearSimulatedUsers = useCallback(() => {
    if (simulationTimerRef.current) {
      clearInterval(simulationTimerRef.current);
      simulationTimerRef.current = null;
    }
    setCallState((prev) => ({
      ...prev,
      participants: prev.participants.filter((p) => !p.id.startsWith('sim_')),
    }));
  }, []);

  // ── Socket Room Listeners (Frontend Integration Guide Compliant) ─
  useEffect(() => {
    if (!socket) return;

    // 1. Peer Discovery: Server sends existing users to joiner
    const onAllUsers = async ({ users }: { users?: Array<{ socketId: string; userName: string }> } = {}) => {
      const safeUsers = Array.isArray(users) ? users : [];
      console.log(`[Web Mesh] Received all-users list with ${safeUsers.length} peers`);

      setCallState((prev) => {
        const newParticipants = safeUsers.map((u) => ({
          id: u.socketId,
          name: u.userName,
          isMuted: false,
          isCameraOff: prev.mode === 'audio',
          isSpeaking: false,
          isHandRaised: false,
          isHost: false,
          stream: null,
        }));
        return { ...prev, participants: newParticipants };
      });

      // Joiner initiates offers to all existing peers
      for (const user of safeUsers) {
        if (user?.socketId) {
          await createPeer(user.socketId, user.userName, true);
        }
      }
    };

    // 2. Peer Discovery: Existing users receive new joiner
    const onUserConnected = async ({
      socketId,
      userName,
      totalUsers,
    }: {
      socketId: string;
      userName: string;
      totalUsers?: number;
    }) => {
      console.log(`[Web Mesh] user-connected: ${userName} (${socketId}). Total: ${totalUsers}`);
      setCallState((prev) => {
        if (prev.participants.some((p) => p.id === socketId)) return prev;
        return {
          ...prev,
          participants: [
            ...prev.participants,
            {
              id: socketId,
              name: userName,
              isMuted: false,
              isCameraOff: prev.mode === 'audio',
              isSpeaking: false,
              isHandRaised: false,
              isHost: false,
              stream: null,
            },
          ],
        };
      });
      // Existing peer prepares connection and waits for the new joiner's offer
      await createPeer(socketId, userName, false);
    };

    // 3. Receiving SDP Offer
    const onOffer = async ({ from, offer, sdp, senderId }: { from?: string; offer?: any; sdp?: any; senderId?: string }) => {
      const peerId = from || senderId;
      const remoteOffer = offer || sdp;
      if (!peerId || !remoteOffer) return;

      const pc = await createPeer(peerId, `User_${peerId.slice(0, 4)}`, false);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit('answer', {
          to: peerId,
          answer: pc.localDescription,
        });
        // Backward-compatible alias
        socket.emit('peer:answer', {
          roomId: stateRef.current.roomId,
          targetUserId: peerId,
          sdp: pc.localDescription,
        });
      } catch (e) {
        console.error('Error handling offer from peer:', peerId, e);
      }
    };

    // 4. Receiving SDP Answer
    const onAnswer = async ({ from, answer, sdp, senderId }: { from?: string; answer?: any; sdp?: any; senderId?: string }) => {
      const peerId = from || senderId;
      const remoteAnswer = answer || sdp;
      if (!peerId || !remoteAnswer) return;

      const pc = peersRef.current.get(peerId);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(remoteAnswer));
        } catch (e) {
          console.error('Error handling answer from peer:', peerId, e);
        }
      }
    };

    // 5. Receiving ICE Candidate
    const onIceCandidate = async ({ from, candidate, senderId }: { from?: string; candidate: any; senderId?: string }) => {
      const peerId = from || senderId;
      if (!peerId || !candidate) return;

      const pc = peersRef.current.get(peerId);
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('Error adding ICE candidate from peer:', peerId, e);
        }
      }
    };

    // 6. User Disconnected / Left
    const onUserDisconnected = ({ socketId, userId, userName: _userName }: { socketId?: string; userId?: string; userName?: string }) => {
      const peerId = socketId || userId;
      if (!peerId) return;

      const pc = peersRef.current.get(peerId);
      if (pc) {
        pc.close();
        peersRef.current.delete(peerId);
        peerStreamsRef.current.delete(peerId);
      }

      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.filter((p) => p.id !== peerId),
      }));
    };

    // 7. Peer Media Toggles
    const onPeerToggleAudio = ({ socketId, enabled }: { socketId: string; enabled: boolean }) => {
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === socketId ? { ...p, isMuted: !enabled } : p,
        ),
      }));
    };

    const onPeerToggleVideo = ({ socketId, enabled }: { socketId: string; enabled: boolean }) => {
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === socketId ? { ...p, isCameraOff: !enabled } : p,
        ),
      }));
    };

    const onPeerHandRaise = ({ socketId, userId, isHandRaised }: { socketId?: string; userId?: string; isHandRaised: boolean }) => {
      const peerId = socketId || userId;
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === peerId ? { ...p, isHandRaised } : p,
        ),
      }));
    };

    // Register standard guide events
    socket.on('all-users', onAllUsers);
    socket.on('user-connected', onUserConnected);
    socket.on('offer', onOffer);
    socket.on('answer', onAnswer);
    socket.on('ice-candidate', onIceCandidate);
    socket.on('user-disconnected', onUserDisconnected);
    socket.on('peer:toggle-audio', onPeerToggleAudio);
    socket.on('peer:toggle-video', onPeerToggleVideo);
    socket.on('peer:hand-raise', onPeerHandRaise);

    // Backward-compatible aliases
    socket.on('room:peers', onAllUsers);
    socket.on('peer:joined', ({ user }: any) => {
      if (user?.id) onUserConnected({ socketId: user.id, userName: user.name });
    });
    socket.on('peer:left', ({ userId, socketId }: any) => {
      onUserDisconnected({ socketId: socketId || userId });
    });
    socket.on('peer:offer', onOffer);
    socket.on('peer:answer', onAnswer);
    socket.on('peer:ice-candidate', onIceCandidate);
    socket.on('peer:media-toggle', ({ userId, isMuted, isCameraOff }: any) => {
      if (typeof isMuted === 'boolean') onPeerToggleAudio({ socketId: userId, enabled: !isMuted });
      if (typeof isCameraOff === 'boolean') onPeerToggleVideo({ socketId: userId, enabled: !isCameraOff });
    });

    return () => {
      socket.off('all-users', onAllUsers);
      socket.off('user-connected', onUserConnected);
      socket.off('offer', onOffer);
      socket.off('answer', onAnswer);
      socket.off('ice-candidate', onIceCandidate);
      socket.off('user-disconnected', onUserDisconnected);
      socket.off('peer:toggle-audio', onPeerToggleAudio);
      socket.off('peer:toggle-video', onPeerToggleVideo);
      socket.off('peer:hand-raise', onPeerHandRaise);

      socket.off('room:peers', onAllUsers);
      socket.off('peer:joined');
      socket.off('peer:left');
      socket.off('peer:offer', onOffer);
      socket.off('peer:answer', onAnswer);
      socket.off('peer:ice-candidate', onIceCandidate);
      socket.off('peer:media-toggle');
    };
  }, [createPeer, socket]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
    callState,
    localStream,
    joinGroupCall,
    leaveGroupCall,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleHandRaise,
    addSimulatedUsers,
    fill50SimulatedUsers,
    clearSimulatedUsers,
  };
}
