import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallMode, GroupCallState, Participant } from '../types';

const FALLBACK_ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

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
    socketId: socket?.id || currentUser.id,
    userId: currentUser.id,
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
  const stateRef = useRef(callState);
  stateRef.current = callState;

  // ── Web Audio Analyser for Speaking Pulse ────────────────────────
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // ── Helper to upsert a participant into the list safely without duplicates ──
  const upsertParticipant = useCallback(
    (
      list: Participant[],
      info: {
        id: string;
        socketId?: string;
        userId?: string;
        name: string;
        isMuted?: boolean;
        isCameraOff?: boolean;
        isHandRaised?: boolean;
        stream?: MediaStream | null;
      }
    ): Participant[] => {
      const myUserId = currentUser.id;
      const mySocketId = socket?.id;
      const primaryId = info.id || info.socketId || info.userId;
      if (!primaryId) return list;

      // Never add self as a remote participant
      if (
        primaryId === myUserId ||
        primaryId === mySocketId ||
        info.socketId === mySocketId ||
        info.userId === myUserId
      ) {
        return list;
      }

      const index = list.findIndex(
        (p) =>
          p.id === primaryId ||
          (info.socketId && (p.socketId === info.socketId || p.id === info.socketId)) ||
          (info.userId && (p.userId === info.userId || p.id === info.userId))
      );

      if (index >= 0) {
        const existing = list[index];
        const updated = [...list];
        updated[index] = {
          ...existing,
          name: info.name || existing.name,
          socketId: info.socketId || existing.socketId,
          userId: info.userId || existing.userId,
          isMuted: typeof info.isMuted === 'boolean' ? info.isMuted : existing.isMuted,
          isCameraOff: typeof info.isCameraOff === 'boolean' ? info.isCameraOff : existing.isCameraOff,
          isHandRaised: typeof info.isHandRaised === 'boolean' ? info.isHandRaised : existing.isHandRaised,
          stream: info.stream !== undefined ? info.stream : existing.stream,
        };
        return updated;
      }

      return [
        ...list,
        {
          id: primaryId,
          socketId: info.socketId || primaryId,
          userId: info.userId || primaryId,
          name: info.name || `User_${primaryId.slice(0, 4)}`,
          isMuted: info.isMuted ?? false,
          isCameraOff: info.isCameraOff ?? false,
          isSpeaking: false,
          isHandRaised: info.isHandRaised ?? false,
          isScreenSharing: false,
          isHost: false,
          stream: info.stream || null,
        },
      ];
    },
    [currentUser.id, socket?.id]
  );

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
      if (!remoteSocketId || remoteSocketId === socket?.id || remoteSocketId === currentUser.id) {
        return null as any;
      }

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
          const candidateData = event.candidate.toJSON();
          socket.emit('ice-candidate', {
            to: remoteSocketId,
            candidate: candidateData,
          });
          // Backward-compatible alias
          socket.emit('peer:ice-candidate', {
            roomId: stateRef.current.roomId,
            targetUserId: remoteSocketId,
            candidate: candidateData,
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
            p.id === remoteSocketId || p.socketId === remoteSocketId ? { ...p, stream } : p
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

          const offerData = { type: offer.type, sdp: offer.sdp };
          socket?.emit('offer', {
            to: remoteSocketId,
            offer: offerData,
          });
          socket?.emit('peer:offer', {
            roomId: stateRef.current.roomId,
            targetUserId: remoteSocketId,
            sdp: offerData,
          });
        } catch (e) {
          console.error('Error creating offer for peer', remoteSocketId, e);
        }
      }

      return pc;
    },
    [currentUser.id, iceConfig, socket]
  );

  // ── Join Group Call ──────────────────────────────────────────────
  const joinGroupCall = useCallback(
    async (roomId: string, mode: CallMode = 'video', userName?: string) => {
      const roomCode = roomId.trim().toUpperCase() || 'TEST-ROOM';
      const effectiveName = (userName || currentUser.name || 'Alex Johnson').trim();

      try {
        setCallState((prev) => ({
          ...prev,
          roomId: roomCode,
          mode,
          status: 'joining',
          error: null,
          localParticipant: {
            ...prev.localParticipant,
            name: effectiveName,
            socketId: socket?.id || currentUser.id,
            userId: currentUser.id,
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
            name: effectiveName,
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
              userName: effectiveName,
              userId: currentUser.id,
            },
            (ack: any) => {
              if (ack) {
                console.log(`[Web] Joined '${ack.roomCode}'. Total: ${ack.totalUsers}`);
              }
            }
          );

          // Backward-compatible alias
          socket.emit('room:join', {
            roomId: roomCode,
            user: {
              id: currentUser.id,
              name: effectiveName,
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
    [currentUser, socket, setupAudioDetection]
  );

  // ── Change Display Name ──────────────────────────────────────────
  const changeName = useCallback(
    (newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;

      setCallState((prev) => ({
        ...prev,
        localParticipant: { ...prev.localParticipant, name: trimmed },
      }));

      if (socket?.connected) {
        const payload = {
          userName: trimmed,
          name: trimmed,
          userId: currentUser.id,
          socketId: socket.id,
          roomId: stateRef.current.roomId,
          roomCode: stateRef.current.roomId,
        };
        socket.emit('change-name', payload);
        socket.emit('peer:name-change', payload);
        socket.emit('user:update-name', payload);
      }
    },
    [currentUser.id, socket]
  );

  // ── Cleanup ──────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
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
      socket.emit('leave-room');
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
      const payload = {
        roomId: stateRef.current.roomId,
        roomCode: stateRef.current.roomId,
        userId: currentUser.id,
        socketId: socket.id,
        id: socket.id,
        isHandRaised: nextHand,
        enabled: nextHand,
        raised: nextHand,
      };
      socket.emit('peer:hand-raise', payload);
      socket.emit('hand-raise', payload);
      socket.emit('raise-hand', payload);
    }
  }, [currentUser.id, socket]);

  // ── Socket Room Listeners (Frontend Integration Guide Compliant) ─
  useEffect(() => {
    if (!socket) return;

    // 1. Peer Discovery: Server sends existing users to joiner
    const onAllUsers = async (payload: any = {}) => {
      const rawUsers = Array.isArray(payload?.users)
        ? payload.users
        : Array.isArray(payload?.peers)
        ? payload.peers
        : Array.isArray(payload)
        ? payload
        : [];

      console.log(`[Web Mesh] Received all-users list with ${rawUsers.length} peers`);

      setCallState((prev) => {
        let currentList = prev.participants;
        for (const u of rawUsers) {
          const uid = u.socketId || u.userId || u.id;
          if (!uid) continue;
          currentList = upsertParticipant(currentList, {
            id: uid,
            socketId: u.socketId || u.id,
            userId: u.userId || u.id,
            name: u.userName || u.name || `User_${uid.slice(0, 4)}`,
            isMuted: u.isMuted ?? false,
            isCameraOff: u.isCameraOff ?? (prev.mode === 'audio'),
            isHandRaised: u.isHandRaised ?? false,
          });
        }
        return { ...prev, participants: currentList };
      });

      // Joiner initiates offers to all existing peers
      for (const user of rawUsers) {
        const targetSocketId = user?.socketId || user?.id;
        const targetUserId = user?.userId || user?.id;
        if (
          targetSocketId &&
          targetSocketId !== socket.id &&
          targetSocketId !== currentUser.id &&
          targetUserId !== currentUser.id
        ) {
          await createPeer(targetSocketId, user.userName || user.name, true);
        }
      }
    };

    // 2. Peer Discovery: Existing users receive new joiner
    const onUserConnected = async (payload: any = {}) => {
      const socketId = payload.socketId || payload.id || payload.user?.id;
      const userId = payload.userId || payload.user?.userId || payload.user?.id || socketId;
      const userName = payload.userName || payload.user?.name || `User_${(socketId || '').slice(0, 4)}`;

      if (!socketId) return;
      if (socketId === socket.id || socketId === currentUser.id || userId === currentUser.id) {
        return; // Ignore self
      }

      console.log(`[Web Mesh] user-connected: ${userName} (${socketId}). Total: ${payload.totalUsers}`);

      setCallState((prev) => ({
        ...prev,
        participants: upsertParticipant(prev.participants, {
          id: socketId,
          socketId,
          userId,
          name: userName,
          isCameraOff: prev.mode === 'audio',
        }),
      }));

      // Existing peer prepares connection and waits for the new joiner's offer
      await createPeer(socketId, userName, false);
    };

    // 3. Receiving SDP Offer
    const onOffer = async ({ from, offer, sdp, senderId }: { from?: string; offer?: any; sdp?: any; senderId?: string }) => {
      const peerId = from || senderId;
      const remoteOffer = offer || sdp;
      if (!peerId || !remoteOffer || peerId === socket.id || peerId === currentUser.id) return;

      const pc = await createPeer(peerId, `User_${peerId.slice(0, 4)}`, false);
      if (!pc) return;

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const answerData = { type: answer.type, sdp: answer.sdp };
        socket.emit('answer', {
          to: peerId,
          answer: answerData,
        });
        socket.emit('peer:answer', {
          roomId: stateRef.current.roomId,
          targetUserId: peerId,
          sdp: answerData,
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
    const onUserDisconnected = (payload: any = {}) => {
      const peerId = payload.socketId || payload.userId || payload.id;
      if (!peerId) return;

      for (const [key, pc] of peersRef.current.entries()) {
        if (key === peerId || key === payload.socketId || key === payload.userId) {
          pc.close();
          peersRef.current.delete(key);
          peerStreamsRef.current.delete(key);
        }
      }

      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.filter(
          (p) =>
            p.id !== peerId &&
            p.socketId !== peerId &&
            p.userId !== peerId &&
            (!payload.socketId || p.socketId !== payload.socketId) &&
            (!payload.userId || p.userId !== payload.userId)
        ),
      }));
    };

    // 7. Peer Media Toggles
    const onPeerToggleAudio = ({ socketId, userId, id, enabled }: any) => {
      const peerId = socketId || userId || id;
      if (!peerId) return;
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === peerId || p.socketId === peerId || p.userId === peerId
            ? { ...p, isMuted: !enabled }
            : p
        ),
      }));
    };

    const onPeerToggleVideo = ({ socketId, userId, id, enabled }: any) => {
      const peerId = socketId || userId || id;
      if (!peerId) return;
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === peerId || p.socketId === peerId || p.userId === peerId
            ? { ...p, isCameraOff: !enabled }
            : p
        ),
      }));
    };

    // 8. Hand Raise Listener
    const onPeerHandRaise = (payload: any = {}) => {
      const peerId = payload.socketId || payload.userId || payload.id || payload.user?.id;
      if (!peerId) return;

      const isHandRaised =
        typeof payload.isHandRaised === 'boolean'
          ? payload.isHandRaised
          : typeof payload.enabled === 'boolean'
          ? payload.enabled
          : typeof payload.raised === 'boolean'
          ? payload.raised
          : true;

      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) => {
          const match =
            p.id === peerId ||
            p.socketId === peerId ||
            p.userId === peerId ||
            (payload.socketId && p.socketId === payload.socketId) ||
            (payload.userId && p.userId === payload.userId) ||
            (payload.id && p.id === payload.id);
          return match ? { ...p, isHandRaised } : p;
        }),
      }));
    };

    // 9. Display Name Change Listener
    const onPeerNameChange = (payload: any = {}) => {
      const peerId = payload.socketId || payload.userId || payload.id;
      const updatedName = payload.userName || payload.name;
      if (!peerId || !updatedName) return;

      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) => {
          const match =
            p.id === peerId ||
            p.socketId === peerId ||
            p.userId === peerId ||
            (payload.socketId && p.socketId === payload.socketId) ||
            (payload.userId && p.userId === payload.userId);
          return match ? { ...p, name: updatedName } : p;
        }),
      }));
    };

    // Register standard and compatible socket events
    socket.on('all-users', onAllUsers);
    socket.on('room:peers', onAllUsers);

    socket.on('user-connected', onUserConnected);
    socket.on('peer:joined', ({ user }: any) => {
      if (user?.id) onUserConnected({ socketId: user.id, userName: user.name, userId: user.id });
    });

    socket.on('offer', onOffer);
    socket.on('peer:offer', onOffer);

    socket.on('answer', onAnswer);
    socket.on('peer:answer', onAnswer);

    socket.on('ice-candidate', onIceCandidate);
    socket.on('peer:ice-candidate', onIceCandidate);

    socket.on('user-disconnected', onUserDisconnected);
    socket.on('peer:left', ({ userId, socketId }: any) => {
      onUserDisconnected({ socketId: socketId || userId, userId });
    });

    socket.on('toggle-audio', onPeerToggleAudio);
    socket.on('peer:toggle-audio', onPeerToggleAudio);

    socket.on('toggle-video', onPeerToggleVideo);
    socket.on('peer:toggle-video', onPeerToggleVideo);

    socket.on('peer:media-toggle', ({ userId, isMuted, isCameraOff }: any) => {
      if (typeof isMuted === 'boolean') onPeerToggleAudio({ socketId: userId, enabled: !isMuted });
      if (typeof isCameraOff === 'boolean') onPeerToggleVideo({ socketId: userId, enabled: !isCameraOff });
    });

    socket.on('peer:hand-raise', onPeerHandRaise);
    socket.on('hand-raise', onPeerHandRaise);
    socket.on('raise-hand', onPeerHandRaise);

    socket.on('peer:name-change', onPeerNameChange);
    socket.on('change-name', onPeerNameChange);
    socket.on('user:update-name', onPeerNameChange);

    return () => {
      socket.off('all-users', onAllUsers);
      socket.off('room:peers', onAllUsers);
      socket.off('user-connected', onUserConnected);
      socket.off('peer:joined');
      socket.off('offer', onOffer);
      socket.off('peer:offer', onOffer);
      socket.off('answer', onAnswer);
      socket.off('peer:answer', onAnswer);
      socket.off('ice-candidate', onIceCandidate);
      socket.off('peer:ice-candidate', onIceCandidate);
      socket.off('user-disconnected', onUserDisconnected);
      socket.off('peer:left');
      socket.off('toggle-audio', onPeerToggleAudio);
      socket.off('peer:toggle-audio', onPeerToggleAudio);
      socket.off('toggle-video', onPeerToggleVideo);
      socket.off('peer:toggle-video', onPeerToggleVideo);
      socket.off('peer:media-toggle');
      socket.off('peer:hand-raise', onPeerHandRaise);
      socket.off('hand-raise', onPeerHandRaise);
      socket.off('raise-hand', onPeerHandRaise);
      socket.off('peer:name-change', onPeerNameChange);
      socket.off('change-name', onPeerNameChange);
      socket.off('user:update-name', onPeerNameChange);
    };
  }, [createPeer, currentUser.id, socket, upsertParticipant]);

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
    changeName,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleHandRaise,
  };
}
