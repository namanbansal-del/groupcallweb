import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallMode, GroupCallState, HostSettings, Participant } from '../types';
import { VirtualBackgroundProcessor, BackgroundMode } from '../utils/virtualBackground';

export interface ChatMessage {
  id: string;
  userId: string;
  name: string;
  text: string;
  ts: number;
}

const FALLBACK_ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
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
    isHost: false,
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
    isHost: false,
    hostSettings: {
      allowScreenShare: true,
      allowChat: true,
      allowUnmute: true,
      allowCamera: true,
    },
    hostNotification: null,
    durationSec: 0,
    error: null,
  });

  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [unreadChat, setUnreadChat] = useState(0);
  const [reactions, setReactions] = useState<{ id: string; emoji: string; name: string }[]>([]);

  const pushReaction = useCallback((emoji: string, name: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setReactions((p) => [...p, { id, emoji, name }]);
    setTimeout(() => setReactions((p) => p.filter((r) => r.id !== id)), 3000);
  }, []);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [iceConfig, setIceConfig] = useState<RTCConfiguration>(FALLBACK_ICE_SERVERS);
  const iceConfigRef = useRef<RTCConfiguration>(FALLBACK_ICE_SERVERS);
  iceConfigRef.current = iceConfig;

  const localStreamRef = useRef<MediaStream | null>(null);
  const rawCameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const [virtualBgMode, setVirtualBgMode] = useState<BackgroundMode>('none');
  const vbProcessorRef = useRef<VirtualBackgroundProcessor | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const peerStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const peerScreenStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const processedCandidatesRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<number | null>(null);
  const stateRef = useRef(callState);
  stateRef.current = callState;
  const toggleScreenShareRef = useRef<() => void>(() => {});
  const leaveGroupCallRef = useRef<() => void>(() => {});
  const iceRestartAttemptsRef = useRef<Map<string, number>>(new Map());
  const MAX_ICE_RESTART_ATTEMPTS = 3;

  // ── ICE Candidate Buffer to prevent race conditions ─────────────
  const queueCandidate = useCallback((peerId: string, candidate: RTCIceCandidateInit) => {
    const list = pendingCandidatesRef.current.get(peerId) || [];
    list.push(candidate);
    pendingCandidatesRef.current.set(peerId, list);
    console.log(`[Web Mesh] Queued candidate for peer ${peerId} (count: ${list.length})`);
  }, []);

  const drainPendingCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current.get(peerId);
    if (queued && queued.length > 0) {
      console.log(`[Web Mesh] Draining ${queued.length} queued ICE candidates for ${peerId}`);
      for (const cand of queued) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch (err) {
          console.warn(`[Web Mesh] Error adding drained candidate for ${peerId}:`, err);
        }
      }
      pendingCandidatesRef.current.delete(peerId);
    }
  }, []);

  // ── Web Audio Analyser for Speaking Pulse ────────────────────────
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const remoteAnalysersRef = useRef<
    Map<string, { analyser: AnalyserNode; dataArray: Uint8Array; source: MediaStreamAudioSourceNode }>
  >(new Map());

  const getOrCreateAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        audioContextRef.current = new AudioCtx();
      }
    }
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => {});
    }
    return audioContextRef.current;
  }, []);

  const attachRemoteAudioAnalyser = useCallback(
    (peerId: string, stream: MediaStream) => {
      try {
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) return;
        const ctx = getOrCreateAudioContext();
        if (!ctx) return;

        if (remoteAnalysersRef.current.has(peerId)) {
          const old = remoteAnalysersRef.current.get(peerId);
          try {
            old?.source.disconnect();
          } catch {}
          remoteAnalysersRef.current.delete(peerId);
        }

        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.4;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        remoteAnalysersRef.current.set(peerId, { analyser, dataArray, source });
      } catch (e) {
        console.warn('[Web Audio] Error setting up remote analyser for', peerId, e);
      }
    },
    [getOrCreateAudioContext]
  );

  useEffect(() => {
    const resumeAudio = () => {
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {});
      }
    };
    window.addEventListener('click', resumeAudio);
    window.addEventListener('touchstart', resumeAudio);
    window.addEventListener('keydown', resumeAudio);
    return () => {
      window.removeEventListener('click', resumeAudio);
      window.removeEventListener('touchstart', resumeAudio);
      window.removeEventListener('keydown', resumeAudio);
    };
  }, []);

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
        isScreenSharing?: boolean;
        stream?: MediaStream | null;
        screenStream?: MediaStream | null;
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
        // Prefer real name over generic placeholder names like "Participant (xxxx)" or "User_xxxx"
        const isCurrentPlaceholder =
          existing.name.startsWith('Participant (') || existing.name.startsWith('User_');
        const isNewPlaceholder =
          info.name.startsWith('Participant (') || info.name.startsWith('User_');
        const bestName =
          !isNewPlaceholder && info.name
            ? info.name
            : isCurrentPlaceholder && !isNewPlaceholder
            ? info.name
            : existing.name || info.name;

        updated[index] = {
          ...existing,
          name: bestName,
          socketId: info.socketId || existing.socketId,
          userId: info.userId || existing.userId,
          isMuted: typeof info.isMuted === 'boolean' ? info.isMuted : existing.isMuted,
          isCameraOff: typeof info.isCameraOff === 'boolean' ? info.isCameraOff : existing.isCameraOff,
          isHandRaised: typeof info.isHandRaised === 'boolean' ? info.isHandRaised : existing.isHandRaised,
          isScreenSharing: typeof info.isScreenSharing === 'boolean' ? info.isScreenSharing : existing.isScreenSharing,
          stream: info.stream !== undefined ? info.stream : existing.stream,
          screenStream: info.screenStream !== undefined ? info.screenStream : existing.screenStream,
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
          isScreenSharing: info.isScreenSharing ?? false,
          isHost: false,
          stream: info.stream || null,
          screenStream: info.screenStream || null,
        },
      ];
    },
    [currentUser.id, socket?.id]
  );

  // ── Setup P2P DataChannel for Real-Time Direct Hand-Raise & Name Sync ────
  const setupDataChannel = useCallback(
    (peerId: string, dc: RTCDataChannel) => {
      dataChannelsRef.current.set(peerId, dc);

      const sendSync = () => {
        if (dc.readyState === 'open') {
          try {
            dc.send(
              JSON.stringify({
                type: 'sync-user',
                name: stateRef.current.localParticipant.name,
                isHandRaised: stateRef.current.localParticipant.isHandRaised,
                isScreenSharing: stateRef.current.localParticipant.isScreenSharing,
                isHost: stateRef.current.isHost,
                userId: currentUser.id,
              })
            );
            if (stateRef.current.isHost) {
              dc.send(
                JSON.stringify({
                  type: 'host-settings',
                  settings: stateRef.current.hostSettings,
                })
              );
            }
          } catch (e) {
            console.warn('[DataChannel] sendSync error:', e);
          }
        }
      };

      dc.onopen = () => {
        console.log(`[DataChannel] Connected directly to peer ${peerId}`);
        sendSync();
      };

      dc.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log(`[DataChannel] Direct P2P packet from ${peerId}:`, data);

          if (data.type === 'host-mute') {
            const isMe = data.targetId === currentUser.id || data.targetId === socket?.id;
            if (isMe && !stateRef.current.isHost) {
              localStreamRef.current?.getAudioTracks().forEach((t) => {
                t.enabled = false;
              });
              setCallState((p) => ({
                ...p,
                isMuted: true,
                localParticipant: { ...p.localParticipant, isMuted: true },
                hostNotification: 'You were muted by the meeting host.',
              }));
              if (socket?.connected) {
                socket.emit('toggle-audio', { enabled: false });
              }
            }
            return;
          }

          if (data.type === 'host-mute-all') {
            if (!stateRef.current.isHost) {
              localStreamRef.current?.getAudioTracks().forEach((t) => {
                t.enabled = false;
              });
              setCallState((p) => ({
                ...p,
                isMuted: true,
                localParticipant: { ...p.localParticipant, isMuted: true },
                hostNotification: 'All participants were muted by the meeting host.',
              }));
              if (socket?.connected) {
                socket.emit('toggle-audio', { enabled: false });
              }
            }
            return;
          }

          if (data.type === 'host-stop-screenshare') {
            const isMe = data.targetId === currentUser.id || data.targetId === socket?.id;
            if (isMe && stateRef.current.isScreenSharing) {
              toggleScreenShare();
              setCallState((p) => ({
                ...p,
                hostNotification: 'Your screen sharing was stopped by the host.',
              }));
            }
            return;
          }

          if (data.type === 'host-remove') {
            const isMe = data.targetId === currentUser.id || data.targetId === socket?.id;
            if (isMe) {
              leaveGroupCall();
              alert('You were removed from the meeting by the host.');
            }
            return;
          }

          if (data.type === 'host-settings') {
            if (data.settings) {
              setCallState((p) => ({ ...p, hostSettings: data.settings }));
              if (!data.settings.allowScreenShare && stateRef.current.isScreenSharing && !stateRef.current.isHost) {
                toggleScreenShare();
                setCallState((p) => ({
                  ...p,
                  hostNotification: 'Screen sharing has been disabled by the meeting host.',
                }));
              }
            }
            return;
          }

          if (data.type === 'chat') {
            setChat((p) =>
              p.some((m) => m.id === data.id)
                ? p
                : [
                    ...p,
                    {
                      id: data.id,
                      userId: data.userId,
                      name: data.name,
                      text: data.text,
                      ts: data.ts,
                    },
                  ]
            );
            setUnreadChat((n) => n + 1);
            return;
          }
          if (data.type === 'reaction') {
            pushReaction(data.emoji, data.name);
            return;
          }

          if (data.type === 'sync-user' || data.type === 'name-change') {
            const realName = (data.name || '').trim();
            setCallState((prev) => ({
              ...prev,
              participants: prev.participants.map((p) => {
                const match =
                  p.id === peerId ||
                  p.socketId === peerId ||
                  (data.userId && p.userId === data.userId);
                if (match) {
                  return {
                    ...p,
                    name: realName || p.name,
                    isHandRaised:
                      typeof data.isHandRaised === 'boolean' ? data.isHandRaised : p.isHandRaised,
                    isScreenSharing:
                      typeof data.isScreenSharing === 'boolean'
                        ? data.isScreenSharing
                        : p.isScreenSharing,
                    isHost: typeof data.isHost === 'boolean' ? data.isHost : p.isHost,
                  };
                }
                return p;
              }),
            }));
          } else if (data.type === 'camera-toggle') {
            const isCameraOff =
              typeof data.isCameraOff === 'boolean' ? data.isCameraOff : !data.enabled;
            setCallState((prev) => ({
              ...prev,
              participants: prev.participants.map((p) => {
                const match =
                  p.id === peerId ||
                  p.socketId === peerId ||
                  (data.userId && p.userId === data.userId);
                return match ? { ...p, isCameraOff } : p;
              }),
            }));
          } else if (data.type === 'hand-raise') {
            const isHandRaised = !!data.isHandRaised;
            setCallState((prev) => ({
              ...prev,
              participants: prev.participants.map((p) => {
                const match =
                  p.id === peerId ||
                  p.socketId === peerId ||
                  (data.userId && p.userId === data.userId);
                return match ? { ...p, isHandRaised } : p;
              }),
            }));
          } else if (data.type === 'screen-share') {
            const isScreenSharing = !!data.isScreenSharing;
            const remoteCameraOff =
              typeof data.isCameraOff === 'boolean' ? data.isCameraOff : undefined;
            setCallState((prev) => ({
              ...prev,
              participants: prev.participants.map((p) => {
                const match =
                  p.id === peerId ||
                  p.socketId === peerId ||
                  (data.userId && p.userId === data.userId);
                return match
                  ? {
                      ...p,
                      isScreenSharing,
                      isCameraOff: isScreenSharing
                        ? false
                        : remoteCameraOff !== undefined
                        ? remoteCameraOff
                        : p.isCameraOff,
                    }
                  : p;
              }),
            }));
          }
        } catch (err) {
          console.warn('[DataChannel] Error parsing packet:', err);
        }
      };

      dc.onclose = () => {
        dataChannelsRef.current.delete(peerId);
      };
    },
    [currentUser.id, pushReaction]
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

  const setupAudioDetection = useCallback(
    (stream: MediaStream) => {
      try {
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) return;

        const ctx = getOrCreateAudioContext();
        if (!ctx) return;

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.4;

        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);

        analyserRef.current = analyser;
        const localDataArray = new Uint8Array(analyser.frequencyBinCount);

        if (animFrameRef.current) {
          cancelAnimationFrame(animFrameRef.current);
        }

        const checkAudioLevel = () => {
          // 1. Check local audio level
          if (analyserRef.current) {
            analyserRef.current.getByteFrequencyData(localDataArray);
            let sum = 0;
            for (let i = 0; i < localDataArray.length; i++) {
              sum += localDataArray[i];
            }
            const avg = sum / localDataArray.length;
            const isSpeaking = avg > 18 && !stateRef.current.isMuted;

            if (stateRef.current.localParticipant.isSpeaking !== isSpeaking) {
              setCallState((prev) => ({
                ...prev,
                localParticipant: { ...prev.localParticipant, isSpeaking },
              }));
            }
          }

          // 2. Check remote audio levels from all connected peers
          if (remoteAnalysersRef.current.size > 0) {
            let hasChanged = false;
            const nextParticipants = stateRef.current.participants.map((p) => {
              const entry =
                remoteAnalysersRef.current.get(p.id) ||
                (p.socketId ? remoteAnalysersRef.current.get(p.socketId) : undefined) ||
                (p.userId ? remoteAnalysersRef.current.get(p.userId) : undefined);

              if (entry) {
                entry.analyser.getByteFrequencyData(entry.dataArray as any);
                let sum = 0;
                for (let i = 0; i < entry.dataArray.length; i++) {
                  sum += entry.dataArray[i];
                }
                const avg = sum / entry.dataArray.length;
                const isSpeaking = avg > 18 && !p.isMuted;
                if (p.isSpeaking !== isSpeaking) {
                  hasChanged = true;
                  return { ...p, isSpeaking };
                }
              }
              return p;
            });

            if (hasChanged) {
              setCallState((prev) => ({
                ...prev,
                participants: nextParticipants,
              }));
            }
          }

          animFrameRef.current = requestAnimationFrame(checkAudioLevel);
        };

        checkAudioLevel();
      } catch (e) {
        console.warn('Audio detection not supported:', e);
      }
    },
    [getOrCreateAudioContext]
  );

  // ── Helper to attach/bind local media tracks to peer transceivers ──
  const attachLocalTracksToPeer = useCallback(async (pc: RTCPeerConnection) => {
    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
    const screenTrack =
      stateRef.current.isScreenSharing && screenStreamRef.current
        ? screenStreamRef.current.getVideoTracks()[0]
        : null;

    const transceivers = pc.getTransceivers();

    // 1. Audio Transceiver
    const audioTransceiver = transceivers.find(
      (t) => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio'
    );
    if (audioTransceiver && audioTransceiver.sender) {
      audioTransceiver.direction = 'sendrecv';
      if (audioTrack && audioTransceiver.sender.track !== audioTrack) {
        await audioTransceiver.sender.replaceTrack(audioTrack).catch(() => {});
      }
    } else if (audioTrack) {
      try {
        pc.addTrack(audioTrack, localStreamRef.current!);
      } catch (e) {}
    }

    // 2. Video Transceivers (Index 0 = Camera, Index 1 = Screen Share)
    const videoTransceivers = transceivers.filter(
      (t) =>
        t.receiver.track?.kind === 'video' ||
        t.sender.track?.kind === 'video' ||
        t.mid === '1' ||
        t.mid === '2'
    );

    // Video Transceiver 0: Camera Video
    if (videoTransceivers[0] && videoTransceivers[0].sender) {
      videoTransceivers[0].direction = 'sendrecv';
      if (cameraTrack && videoTransceivers[0].sender.track !== cameraTrack) {
        await videoTransceivers[0].sender.replaceTrack(cameraTrack).catch(() => {});
      }
    } else if (cameraTrack) {
      try {
        pc.addTrack(cameraTrack, localStreamRef.current!);
      } catch (e) {}
    }

    // Video Transceiver 1: Screen Share Video (only send if screenTrack is actively present)
    if (videoTransceivers[1] && videoTransceivers[1].sender) {
      if (screenTrack) {
        videoTransceivers[1].direction = 'sendrecv';
        if (videoTransceivers[1].sender.track !== screenTrack) {
          await videoTransceivers[1].sender.replaceTrack(screenTrack).catch(() => {});
        }
      } else {
        videoTransceivers[1].direction = 'recvonly';
        if (videoTransceivers[1].sender.track) {
          await videoTransceivers[1].sender.replaceTrack(null).catch(() => {});
        }
      }
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

      const pc = new RTCPeerConnection(iceConfigRef.current);
      peersRef.current.set(remoteSocketId, pc);

      // As initiator, add local tracks and transceivers before creating offer
      if (isInitiator) {
        const audioTrack = localStreamRef.current?.getAudioTracks()[0];
        const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
        const screenTrack =
          stateRef.current.isScreenSharing && screenStreamRef.current
            ? screenStreamRef.current.getVideoTracks()[0]
            : null;

        if (audioTrack) {
          try {
            pc.addTrack(audioTrack, localStreamRef.current!);
          } catch (e) {}
        }
        if (cameraTrack) {
          try {
            pc.addTrack(cameraTrack, localStreamRef.current!);
          } catch (e) {}
        }
        if (screenTrack && screenStreamRef.current) {
          try {
            pc.addTrack(screenTrack, screenStreamRef.current);
          } catch (e) {}
        }

        const transceivers = pc.getTransceivers();
        const hasAudio = transceivers.some((t) => t.sender.track?.kind === 'audio');
        const videoTransceivers = transceivers.filter((t) => t.sender.track?.kind === 'video');

        if (!hasAudio) {
          try {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
          } catch (e) {}
        }
        // Transceiver 0: Camera Video
        if (videoTransceivers.length < 1) {
          try {
            pc.addTransceiver('video', { direction: 'sendrecv' });
          } catch (e) {}
        }
        // Transceiver 1: Screen Share Video (only allocate if actively presenting screen)
        if (screenTrack && videoTransceivers.length < 2) {
          try {
            pc.addTransceiver('video', { direction: 'sendrecv' });
          } catch (e) {}
        }
      }

      // P2P DataChannel setup for real name & hand-raise messaging
      if (isInitiator) {
        try {
          const dc = pc.createDataChannel('groupcall-control');
          setupDataChannel(remoteSocketId, dc);
        } catch (e) {
          console.warn('[Web Mesh] Error creating DataChannel:', e);
        }
      }

      pc.ondatachannel = (event) => {
        setupDataChannel(remoteSocketId, event.channel);
      };

      // Handle ICE connection state changes and auto-restart on disconnect/failure
      pc.oniceconnectionstatechange = () => {
        const iceState = pc.iceConnectionState;
        console.log(`[Web Mesh] ICE state for ${remoteSocketId}: ${iceState}`);
        if (iceState === 'failed' || iceState === 'disconnected') {
          const attempts = (iceRestartAttemptsRef.current.get(remoteSocketId) || 0) + 1;
          iceRestartAttemptsRef.current.set(remoteSocketId, attempts);
          if (attempts > MAX_ICE_RESTART_ATTEMPTS) {
            console.warn(`[Web Mesh] ICE restart limit reached for ${remoteSocketId}, stopping retries`);
            setCallState((prev) => ({
              ...prev,
              error: 'Connection to a participant was lost. Please refresh to reconnect.',
            }));
            return;
          }
          console.warn(`[Web Mesh] ICE ${iceState} with ${remoteSocketId}. Triggering restartIce (attempt ${attempts})...`);
          try {
            if (typeof pc.restartIce === 'function') {
              pc.restartIce();
            }
            if (pc.signalingState === 'stable') {
              pc.createOffer({ iceRestart: true })
                .then((offer) => pc.setLocalDescription(offer))
                .then(() => {
                  if (pc.localDescription) {
                    socket?.emit('offer', {
                      targetId: remoteSocketId,
                      to: remoteSocketId,
                      offer: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
                    });
                  }
                })
                .catch((err) => console.warn('[Web Mesh] restartIce offer failed:', err));
            }
          } catch (e) {
            console.warn('[Web Mesh] restartIce error:', e);
          }
        }
        if (iceState === 'connected') {
          iceRestartAttemptsRef.current.delete(remoteSocketId);
        }
      };

      // Relay ICE candidates without duplicate emissions
      pc.onicecandidate = (event) => {
        if (event.candidate && socket?.connected) {
          const candidateData = event.candidate.toJSON();
          socket.emit('ice-candidate', {
            targetId: remoteSocketId,
            to: remoteSocketId,
            candidate: candidateData,
          });
        }
      };

      // Remote stream received: Create a new MediaStream instance to trigger React re-renders
      pc.ontrack = (event) => {
        console.log(`[Web Mesh] ontrack from ${remoteSocketId}: kind=${event.track.kind}`);

        if (event.track.kind === 'video') {
          let stream = peerStreamsRef.current.get(remoteSocketId);
          if (!stream) {
            stream = new MediaStream();
            peerStreamsRef.current.set(remoteSocketId, stream);
          }

          const existingVideoTracks = stream.getVideoTracks().filter((t) => t.readyState === 'live');

          const isPeerSignaledScreenSharing = !!stateRef.current.participants.find(
            (p) => p.id === remoteSocketId || p.socketId === remoteSocketId
          )?.isScreenSharing;

          // A track is a screen share track ONLY IF:
          // 1. The remote peer has explicitly signaled that they are sharing their screen (via socket/datachannel), AND
          // 2. The peer already has an active camera track and this is a distinct 2nd video track
          const isScreenShareTrack =
            isPeerSignaledScreenSharing &&
            existingVideoTracks.length > 0 &&
            !existingVideoTracks.some((t) => t.id === event.track.id);

          if (isScreenShareTrack) {
            console.log(`[Web Mesh] Valid remote screen share track from ${remoteSocketId}`);
            let screenStream = peerScreenStreamsRef.current.get(remoteSocketId);
            if (!screenStream) {
              screenStream = new MediaStream();
            }
            if (!screenStream.getTracks().some((t) => t.id === event.track.id)) {
              screenStream.addTrack(event.track);
            }
            const freshScreenStream = new MediaStream(screenStream.getTracks());
            peerScreenStreamsRef.current.set(remoteSocketId, freshScreenStream);

            event.track.onended = () => {
              console.log(`[Web Mesh] Remote screen share track ended from ${remoteSocketId}`);
              setCallState((prev) => ({
                ...prev,
                participants: prev.participants.map((p) =>
                  p.id === remoteSocketId || p.socketId === remoteSocketId
                    ? { ...p, isScreenSharing: false, screenStream: null }
                    : p
                ),
              }));
            };

            setCallState((prev) => ({
              ...prev,
              participants: prev.participants.map((p) =>
                p.id === remoteSocketId || p.socketId === remoteSocketId
                  ? { ...p, isScreenSharing: true, screenStream: freshScreenStream }
                  : p
              ),
            }));
            return;
          }

          // Primary Camera Video Track:
          if (!stream.getTracks().some((t) => t.id === event.track.id)) {
            stream.addTrack(event.track);
          }
          const freshStream = new MediaStream(stream.getTracks());
          peerStreamsRef.current.set(remoteSocketId, freshStream);

          event.track.onunmute = () => {
            console.log(`[Web Mesh] Video track unmuted from ${remoteSocketId}`);
            setCallState((prev) => ({
              ...prev,
              participants: prev.participants.map((p) =>
                p.id === remoteSocketId || p.socketId === remoteSocketId
                  ? {
                      ...p,
                      stream: new MediaStream(peerStreamsRef.current.get(remoteSocketId)?.getTracks() || []),
                      isCameraOff: false,
                    }
                  : p
              ),
            }));
          };

          setCallState((prev) => {
            const exists = prev.participants.some(
              (p) => p.id === remoteSocketId || p.socketId === remoteSocketId
            );
            if (exists) {
              return {
                ...prev,
                participants: prev.participants.map((p) =>
                  p.id === remoteSocketId || p.socketId === remoteSocketId
                    ? {
                        ...p,
                        stream: freshStream,
                        isCameraOff: false,
                      }
                    : p
                ),
              };
            }
            return {
              ...prev,
              participants: upsertParticipant(prev.participants, {
                id: remoteSocketId,
                socketId: remoteSocketId,
                name: _remoteUserName || `User_${remoteSocketId.slice(0, 4)}`,
                stream: freshStream,
                isCameraOff: false,
              }),
            };
          });
          return;
        }

        // Camera / Audio Track
        let stream = peerStreamsRef.current.get(remoteSocketId);
        if (!stream) {
          stream = new MediaStream();
        }

        if (!stream.getTracks().some((t) => t.id === event.track.id)) {
          stream.addTrack(event.track);
        }

        event.track.onunmute = () => {
          console.log(`[Web Mesh] Track unmuted from ${remoteSocketId}: ${event.track.kind}`);
          setCallState((prev) => ({
            ...prev,
            participants: prev.participants.map((p) =>
              p.id === remoteSocketId || p.socketId === remoteSocketId
                ? { ...p, stream: new MediaStream(peerStreamsRef.current.get(remoteSocketId)?.getTracks() || []) }
                : p
            ),
          }));
        };

        // Create a new reference so React hooks and child components re-render immediately
        const freshStream = new MediaStream(stream.getTracks());
        peerStreamsRef.current.set(remoteSocketId, freshStream);

        // Attach remote audio analyser for live speaking pulse
        if (freshStream.getAudioTracks().length > 0) {
          attachRemoteAudioAnalyser(remoteSocketId, freshStream);
        }

        const hasVideo = freshStream.getVideoTracks().length > 0;

        setCallState((prev) => {
          const exists = prev.participants.some(
            (p) => p.id === remoteSocketId || p.socketId === remoteSocketId
          );
          if (exists) {
            return {
              ...prev,
              participants: prev.participants.map((p) =>
                p.id === remoteSocketId || p.socketId === remoteSocketId
                  ? {
                      ...p,
                      stream: freshStream,
                      isCameraOff: hasVideo ? false : p.isCameraOff,
                    }
                  : p
              ),
            };
          }
          return {
            ...prev,
            participants: upsertParticipant(prev.participants, {
              id: remoteSocketId,
              socketId: remoteSocketId,
              name: _remoteUserName || `User_${remoteSocketId.slice(0, 4)}`,
              stream: freshStream,
              isCameraOff: !hasVideo,
            }),
          };
        });
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
            targetId: remoteSocketId,
            to: remoteSocketId,
            offer: offerData,
          });
        } catch (e) {
          console.error('Error creating offer for peer', remoteSocketId, e);
        }
      }

      return pc;
    },
    [attachRemoteAudioAnalyser, currentUser.id, setupDataChannel, socket, upsertParticipant]
  );

  // ── Join Group Call ──────────────────────────────────────────────
  const joinGroupCall = useCallback(
    async (
      roomId: string,
      mode: CallMode = 'video',
      userName?: string,
      cameraEnabled: boolean = true,
      micEnabled: boolean = true,
      existingStream?: MediaStream | null,
      isHost: boolean = false
    ) => {
      const roomCode = roomId.trim().toUpperCase() || 'TEST-ROOM';
      const effectiveName = (userName || currentUser.name || 'Alex Johnson').trim();
      const initialCameraOff = mode === 'audio' || !cameraEnabled;
      const initialMuted = !micEnabled;

      try {
        setCallState((prev) => ({
          ...prev,
          roomId: roomCode,
          mode,
          status: 'joining',
          isCameraOff: initialCameraOff,
          isMuted: initialMuted,
          isHost,
          error: null,
          localParticipant: {
            ...prev.localParticipant,
            name: effectiveName,
            isCameraOff: initialCameraOff,
            isMuted: initialMuted,
            isHost,
            socketId: socket?.id || currentUser.id,
            userId: currentUser.id,
          },
        }));

        let stream: MediaStream | null = null;

        // 1. Reuse existing live stream if passed from Lobby (prevents iOS Safari NotReadableError)
        if (
          existingStream &&
          existingStream.getTracks().some((t) => t.readyState === 'live')
        ) {
          stream = existingStream;
          if (initialCameraOff) {
            stream.getVideoTracks().forEach((track) => {
              track.stop();
              stream?.removeTrack(track);
            });
          }
          if (initialMuted) {
            stream.getAudioTracks().forEach((track) => {
              track.enabled = false;
            });
          }
        } else {
          // 2. Otherwise acquire fresh media with mobile-safe constraints
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: initialCameraOff
                ? false
                : {
                    facingMode: 'user',
                    width: { ideal: 1280, min: 640 },
                    height: { ideal: 720, min: 360 },
                    aspectRatio: { ideal: 1.7777777778 },
                  },
            });

            if (stream && initialMuted) {
              stream.getAudioTracks().forEach((track) => {
                track.enabled = false;
              });
            }
          } catch (mediaErr: any) {
            console.warn('getUserMedia initial error, trying mobile fallback:', mediaErr);
            if (!initialCameraOff) {
              try {
                // Secondary fallback: relaxed constraints without resolution bounds
                stream = await navigator.mediaDevices.getUserMedia({
                  audio: true,
                  video: { facingMode: 'user' },
                });
                if (stream && initialMuted) {
                  stream.getAudioTracks().forEach((track) => {
                    track.enabled = false;
                  });
                }
              } catch (secondErr) {
                try {
                  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                  if (stream && initialMuted) {
                    stream.getAudioTracks().forEach((track) => {
                      track.enabled = false;
                    });
                  }
                } catch {
                  stream = null;
                }
              }
            }
          }
        }

        // Determine actual camera state based on real live video track availability
        const actualCameraOff =
          !stream ||
          stream.getVideoTracks().length === 0 ||
          stream.getVideoTracks().every((t) => t.readyState === 'ended') ||
          initialCameraOff;

        localStreamRef.current = stream;
        rawCameraTrackRef.current = stream ? stream.getVideoTracks()[0] || null : null;
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
          isCameraOff: actualCameraOff,
          isMuted: initialMuted,
          isHost,
          localParticipant: {
            ...prev.localParticipant,
            name: effectiveName,
            stream,
            isMuted: initialMuted,
            isCameraOff: actualCameraOff,
            isHost,
          },
        }));

        const emitJoin = () => {
          if (!socket) return;
          socket.emit(
            'join-room',
            {
              roomCode,
              roomId: roomCode,
              userName: effectiveName,
              name: effectiveName,
              displayName: effectiveName,
              userId: currentUser.id,
              isHost,
              user: {
                id: currentUser.id,
                name: effectiveName,
                userName: effectiveName,
                isHost,
              },
              isCameraOff: actualCameraOff,
              isMuted: initialMuted,
            },
            (ack: any) => {
              if (ack) {
                console.log(`[Web] Joined '${ack.roomCode}'. Total: ${ack.totalUsers}`);
              }
            }
          );
        };

        if (socket?.connected) {
          emitJoin();
        } else if (socket) {
          socket.once('connect', emitJoin);
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

  // ── Auto Re-join on Socket Reconnection ─────────────────────────
  useEffect(() => {
    if (!socket) return;
    const handleReconnect = () => {
      console.log('[Socket] Reconnected! Checking active call status...');
      if (stateRef.current.status === 'joined' && stateRef.current.roomId) {
        console.log(`[Socket] Re-joining room ${stateRef.current.roomId} after reconnect`);
        socket.emit('join-room', {
          roomCode: stateRef.current.roomId,
          roomId: stateRef.current.roomId,
          userName: stateRef.current.localParticipant.name,
          name: stateRef.current.localParticipant.name,
          displayName: stateRef.current.localParticipant.name,
          userId: currentUser.id,
          user: {
            id: currentUser.id,
            name: stateRef.current.localParticipant.name,
            userName: stateRef.current.localParticipant.name,
          },
          isCameraOff: stateRef.current.isCameraOff,
          isMuted: stateRef.current.isMuted,
        });
      }
    };

    socket.on('connect', handleReconnect);
    return () => {
      socket.off('connect', handleReconnect);
    };
  }, [socket, currentUser.id]);

  // ── Handle iOS / Mobile App Switching & Audio Interruption Recovery ─────────
  useEffect(() => {
    const handleVisibilityOrFocus = async () => {
      // Re-connect socket if it dropped while in background
      if (socket && !socket.connected) {
        socket.connect();
      }

      // Resume AudioContext if suspended (e.g. after phone call or alarm on iOS)
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {});
      }

      // Verify and recover local audio/video tracks
      const localStream = localStreamRef.current;
      if (localStream) {
        const vTracks = localStream.getVideoTracks();
        if (vTracks.length > 0) {
          vTracks.forEach((t) => {
            if (t.readyState === 'live') {
              t.enabled = !stateRef.current.isCameraOff;
            }
          });
        }

        const aTracks = localStream.getAudioTracks();
        const micDead = aTracks.length === 0 || aTracks.some((t) => t.readyState === 'ended');
        if (micDead && !stateRef.current.isMuted) {
          console.warn('[AudioRecovery] Local mic track ended during device interruption, re-acquiring...');
          try {
            const newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const newTrack = newStream.getAudioTracks()[0];
            if (newTrack && localStreamRef.current) {
              aTracks.forEach((t) => {
                localStreamRef.current?.removeTrack(t);
                t.stop();
              });
              localStreamRef.current.addTrack(newTrack);
              peersRef.current.forEach(async (pc) => {
                const transceivers = pc.getTransceivers();
                const audioTransceiver = transceivers.find(
                  (t) => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio'
                );
                if (audioTransceiver?.sender) {
                  await audioTransceiver.sender.replaceTrack(newTrack).catch(() => {});
                }
              });
            }
          } catch (micErr) {
            console.warn('[AudioRecovery] Failed to reacquire mic track:', micErr);
          }
        } else {
          aTracks.forEach((t) => {
            if (t.readyState === 'live') {
              t.enabled = !stateRef.current.isMuted;
            }
          });
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        handleVisibilityOrFocus();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
    };
  }, [socket]);

  // ── Change Display Name ──────────────────────────────────────────
  const changeName = useCallback(
    (newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;

      setCallState((prev) => ({
        ...prev,
        localParticipant: { ...prev.localParticipant, name: trimmed },
      }));

      // 1. Direct P2P DataChannel broadcast (bypasses any server drops)
      const msg = JSON.stringify({
        type: 'name-change',
        name: trimmed,
        userId: currentUser.id,
      });
      dataChannelsRef.current.forEach((dc) => {
        if (dc.readyState === 'open') {
          try {
            dc.send(msg);
          } catch (e) {}
        }
      });

      // 2. Also emit over socket without duplicates
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
    remoteAnalysersRef.current.forEach((val) => {
      try {
        val.source.disconnect();
      } catch {}
    });
    remoteAnalysersRef.current.clear();

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      setLocalStream(null);
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }
    setScreenStream(null);

    dataChannelsRef.current.forEach((dc) => {
      try {
        dc.close();
      } catch (e) {}
    });
    dataChannelsRef.current.clear();

    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    peerStreamsRef.current.clear();
    peerScreenStreamsRef.current.clear();
    iceRestartAttemptsRef.current.clear();

    if (vbProcessorRef.current) {
      vbProcessorRef.current.destroy();
      vbProcessorRef.current = null;
    }
    setVirtualBgMode('none');
  }, []);

  // ── Leave Group Call ─────────────────────────────────────────────
  const leaveGroupCall = useCallback(() => {
    if (socket?.connected) {
      socket.emit('leave-room');
    }

    cleanup();
    setChat([]);
    setUnreadChat(0);

    setCallState((prev) => ({
      ...prev,
      status: 'idle',
      roomId: null,
      participants: [],
      durationSec: 0,
      isScreenSharing: false,
    }));
  }, [cleanup, socket]);

  // ── Toggle Microphone ────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (stateRef.current.isMuted && !stateRef.current.isHost && !stateRef.current.hostSettings.allowUnmute) {
      setCallState((prev) => ({
        ...prev,
        hostNotification: 'The host has disabled unmuting for participants.',
      }));
      return;
    }

    const nextMuted = !stateRef.current.isMuted;
    if (localStreamRef.current) {
      const aTracks = localStreamRef.current.getAudioTracks();
      const dead = aTracks.length === 0 || aTracks.every((t) => t.readyState === 'ended');
      if (!nextMuted && dead) {
        navigator.mediaDevices?.getUserMedia({ audio: true }).then((newStream) => {
          const newTrack = newStream.getAudioTracks()[0];
          if (newTrack && localStreamRef.current) {
            aTracks.forEach((t) => {
              localStreamRef.current?.removeTrack(t);
              t.stop();
            });
            localStreamRef.current.addTrack(newTrack);
            peersRef.current.forEach(async (pc) => {
              const transceivers = pc.getTransceivers();
              const audioTransceiver = transceivers.find(
                (t) => t.receiver.track?.kind === 'audio' || t.sender.track?.kind === 'audio'
              );
              if (audioTransceiver?.sender) {
                await audioTransceiver.sender.replaceTrack(newTrack).catch(() => {});
              }
            });
          }
        }).catch((err) => {
          console.warn('[AudioRecovery] Failed to reacquire mic track on unmute:', err);
        });
      } else {
        aTracks.forEach((track) => {
          track.enabled = !nextMuted;
        });
      }
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

  // ── Toggle Camera (Complete Hardware Sensor Power Down) ───────────
  const toggleCamera = useCallback(async () => {
    if (stateRef.current.isCameraOff && !stateRef.current.isHost && !stateRef.current.hostSettings.allowCamera) {
      setCallState((prev) => ({
        ...prev,
        hostNotification: 'The host has disabled video for participants.',
      }));
      return;
    }

    const nextCameraOff = !stateRef.current.isCameraOff;

    if (nextCameraOff) {
      // Stopping camera: Stop all video tracks completely so camera hardware sensor powers down
      vbProcessorRef.current?.stop();
      rawCameraTrackRef.current = null;
      setVirtualBgMode('none');

      if (localStreamRef.current) {
        localStreamRef.current.getVideoTracks().forEach((track) => {
          track.stop();
          localStreamRef.current?.removeTrack(track);
        });
      }
      peersRef.current.forEach((pc) => {
        const transceivers = pc.getTransceivers();
        const videoTransceiver = transceivers.find(
          (t) =>
            t.sender.track?.kind === 'video' ||
            t.receiver.track?.kind === 'video' ||
            t.mid === '1'
        );
        if (videoTransceiver && videoTransceiver.sender) {
          videoTransceiver.sender.replaceTrack(null).catch(() => {});
        } else {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(null).catch(() => {});
        }
      });
    } else {
      // Starting camera: acquire fresh video track from getUserMedia
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280, min: 640 },
            height: { ideal: 720, min: 360 },
            aspectRatio: { ideal: 1.7777777778 },
          },
        });
        const newTrack = videoStream.getVideoTracks()[0];
        if (newTrack) {
          if (!localStreamRef.current) {
            localStreamRef.current = new MediaStream();
          }
          localStreamRef.current.addTrack(newTrack);
          rawCameraTrackRef.current = newTrack;

          peersRef.current.forEach((pc) => {
            const transceivers = pc.getTransceivers();
            const videoTransceiver = transceivers.find(
              (t) =>
                t.sender.track?.kind === 'video' ||
                t.receiver.track?.kind === 'video' ||
                t.mid === '1'
            );
            if (videoTransceiver && videoTransceiver.sender) {
              videoTransceiver.sender.replaceTrack(newTrack).catch(() => {});
              videoTransceiver.direction = 'sendrecv';
            } else {
              const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
              if (sender) {
                sender.replaceTrack(newTrack).catch(() => {});
              } else {
                try {
                  pc.addTrack(newTrack, localStreamRef.current!);
                } catch (e) {}
              }
            }
          });
        }
      } catch (err) {
        console.warn('Could not re-enable camera:', err);
      }
    }

    const currentLocalStream = localStreamRef.current
      ? new MediaStream(localStreamRef.current.getTracks())
      : null;

    setCallState((prev) => ({
      ...prev,
      isCameraOff: nextCameraOff,
      localParticipant: {
        ...prev.localParticipant,
        isCameraOff: nextCameraOff,
        stream: currentLocalStream,
      },
    }));

    // Broadcast camera toggle over DataChannel to prevent remote tile freezing
    const cameraMsg = JSON.stringify({
      type: 'camera-toggle',
      isCameraOff: nextCameraOff,
      enabled: !nextCameraOff,
      userId: currentUser.id,
    });
    dataChannelsRef.current.forEach((dc) => {
      if (dc.readyState === 'open') {
        try {
          dc.send(cameraMsg);
        } catch (e) {}
      }
    });

    if (socket?.connected) {
      socket.emit('toggle-video', { enabled: !nextCameraOff });
    }
  }, [currentUser.id, socket]);

  // ── Apply Virtual Background (Blur, Office, Custom) ───────────────
  const applyVirtualBackground = useCallback(
    async (mode: BackgroundMode, customImgUrl?: string) => {
      setVirtualBgMode(mode);

      if (!localStreamRef.current) return;

      if (!vbProcessorRef.current) {
        vbProcessorRef.current = new VirtualBackgroundProcessor();
      }

      if (mode === 'none') {
        if (vbProcessorRef.current) {
          vbProcessorRef.current.stop();
        }
        const rawTrack = rawCameraTrackRef.current;
        if (rawTrack && rawTrack.readyState === 'live') {
          const currentVTrack = localStreamRef.current.getVideoTracks()[0];
          if (currentVTrack && currentVTrack !== rawTrack) {
            localStreamRef.current.removeTrack(currentVTrack);
            localStreamRef.current.addTrack(rawTrack);
          }
          peersRef.current.forEach((pc) => {
            const transceivers = pc.getTransceivers();
            const videoTransceiver = transceivers.find(
              (t) =>
                t.sender.track?.kind === 'video' ||
                t.receiver.track?.kind === 'video' ||
                t.mid === '1'
            );
            if (videoTransceiver && videoTransceiver.sender) {
              videoTransceiver.sender.replaceTrack(rawTrack).catch(() => {});
            } else {
              const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
              if (sender) sender.replaceTrack(rawTrack).catch(() => {});
            }
          });
          const freshStream = new MediaStream(localStreamRef.current.getTracks());
          setLocalStream(freshStream);
          setCallState((prev) => ({
            ...prev,
            localParticipant: {
              ...prev.localParticipant,
              stream: freshStream,
            },
          }));
        }
        return;
      }

      // If processor is already running, switch effect instantly on the fly without renegotiating or restarting
      if (vbProcessorRef.current && vbProcessorRef.current.isStarted()) {
        await vbProcessorRef.current.setMode(mode, customImgUrl);
        return;
      }

      // Ensure raw camera track is stored
      if (!rawCameraTrackRef.current || rawCameraTrackRef.current.readyState === 'ended') {
        const vTrack = localStreamRef.current.getVideoTracks()[0];
        if (vTrack) {
          rawCameraTrackRef.current = vTrack;
        }
      }

      if (!rawCameraTrackRef.current) return;

      const rawStream = new MediaStream([rawCameraTrackRef.current]);
      const processedTrack = await vbProcessorRef.current.start(rawStream, mode, customImgUrl);

      if (processedTrack) {
        const currentVTrack = localStreamRef.current.getVideoTracks()[0];
        if (currentVTrack) {
          localStreamRef.current.removeTrack(currentVTrack);
        }
        localStreamRef.current.addTrack(processedTrack);

        // Replace track on all connected peers
        peersRef.current.forEach((pc) => {
          const transceivers = pc.getTransceivers();
          const videoTransceiver = transceivers.find(
            (t) =>
              t.sender.track?.kind === 'video' ||
              t.receiver.track?.kind === 'video' ||
              t.mid === '1'
          );
          if (videoTransceiver && videoTransceiver.sender) {
            videoTransceiver.sender.replaceTrack(processedTrack).catch(() => {});
          } else {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(processedTrack).catch(() => {});
          }
        });

        const freshStream = new MediaStream(localStreamRef.current.getTracks());
        setLocalStream(freshStream);
        setCallState((prev) => ({
          ...prev,
          localParticipant: {
            ...prev.localParticipant,
            stream: freshStream,
          },
        }));
      }
    },
    []
  );

  // ── Toggle Screen Sharing ────────────────────────────────────────
  const toggleScreenShare = useCallback(async () => {
    if (!stateRef.current.isScreenSharing && !stateRef.current.isHost && !stateRef.current.hostSettings.allowScreenShare) {
      setCallState((prev) => ({
        ...prev,
        hostNotification: 'Screen sharing is disabled by the meeting host.',
      }));
      return;
    }

    if (stateRef.current.isScreenSharing) {
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }
      setScreenStream(null);

      const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;

      // Reset screen transceiver on all peers
      peersRef.current.forEach(async (pc) => {
        const transceivers = pc.getTransceivers();
        const videoTransceivers = transceivers.filter(
          (t) =>
            t.receiver.track?.kind === 'video' ||
            t.sender.track?.kind === 'video' ||
            t.mid === '1' ||
            t.mid === '2'
        );
        if (videoTransceivers[1] && videoTransceivers[1].sender) {
          await videoTransceivers[1].sender.replaceTrack(null).catch(() => {});
        } else if (videoTransceivers[0] && videoTransceivers[0].sender) {
          await videoTransceivers[0].sender.replaceTrack(cameraTrack).catch(() => {});
        }
      });

      setCallState((prev) => ({
        ...prev,
        isScreenSharing: false,
        localParticipant: {
          ...prev.localParticipant,
          stream: localStreamRef.current,
          screenStream: null,
          isScreenSharing: false,
        },
      }));

      // Broadcast screen share stopped with camera state to peers via DataChannel
      const msg = JSON.stringify({
        type: 'screen-share',
        isScreenSharing: false,
        isCameraOff: stateRef.current.isCameraOff,
        userId: currentUser.id,
      });
      dataChannelsRef.current.forEach((dc) => {
        if (dc.readyState === 'open') {
          try { dc.send(msg); } catch (e) {}
        }
      });
      if (socket?.connected) {
        socket.emit('toggle-screen-share', {
          enabled: false,
          isScreenSharing: false,
          isCameraOff: stateRef.current.isCameraOff,
          userId: currentUser.id,
        });
      }
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: false,
        });
        screenStreamRef.current = screenStream;
        setScreenStream(screenStream);

        const screenTrack = screenStream.getVideoTracks()[0];
        if (screenTrack && 'contentHint' in screenTrack) {
          screenTrack.contentHint = 'detail';
        }

        screenTrack.onended = () => {
          toggleScreenShare();
        };

        // Attach screen track to dedicated screen transceiver (index 1), keeping camera (index 0) active!
        peersRef.current.forEach(async (pc) => {
          const transceivers = pc.getTransceivers();
          const videoTransceivers = transceivers.filter(
            (t) =>
              t.receiver.track?.kind === 'video' ||
              t.sender.track?.kind === 'video' ||
              t.mid === '1' ||
              t.mid === '2'
          );
          if (videoTransceivers[1] && videoTransceivers[1].sender) {
            videoTransceivers[1].direction = 'sendrecv';
            await videoTransceivers[1].sender.replaceTrack(screenTrack).catch((err) => {
              console.warn('[ScreenShare] replaceTrack error on transceiver 1:', err);
            });
          } else if (videoTransceivers[0] && videoTransceivers[0].sender) {
            // Fallback for single-transceiver peers
            await videoTransceivers[0].sender.replaceTrack(screenTrack).catch((err) => {
              console.warn('[ScreenShare] replaceTrack error on fallback:', err);
            });
          }
        });

        setCallState((prev) => ({
          ...prev,
          isScreenSharing: true,
          localParticipant: {
            ...prev.localParticipant,
            stream: localStreamRef.current,
            screenStream,
            isScreenSharing: true,
          },
        }));

        // Broadcast screen share started to peers via DataChannel
        const msg = JSON.stringify({
          type: 'screen-share',
          isScreenSharing: true,
          isCameraOff: stateRef.current.isCameraOff,
          userId: currentUser.id,
        });
        dataChannelsRef.current.forEach((dc) => {
          if (dc.readyState === 'open') {
            try { dc.send(msg); } catch (e) {}
          }
        });
        if (socket?.connected) {
          socket.emit('toggle-screen-share', {
            enabled: true,
            isScreenSharing: true,
            isCameraOff: stateRef.current.isCameraOff,
            userId: currentUser.id,
          });
        }
      } catch (err) {
        console.warn('Screen share canceled or failed:', err);
      }
    }
  }, [currentUser.id, socket]);

  // ── Toggle Hand Raise (P2P DataChannel + Socket Fallback) ─────────
  const toggleHandRaise = useCallback(() => {
    const nextHand = !stateRef.current.isHandRaised;
    setCallState((prev) => ({
      ...prev,
      isHandRaised: nextHand,
      localParticipant: { ...prev.localParticipant, isHandRaised: nextHand },
    }));

    // 1. Direct WebRTC DataChannel broadcast to all peers (100% reliable)
    const msg = JSON.stringify({
      type: 'hand-raise',
      isHandRaised: nextHand,
      userId: currentUser.id,
      name: stateRef.current.localParticipant.name,
    });
    dataChannelsRef.current.forEach((dc) => {
      if (dc.readyState === 'open') {
        try {
          dc.send(msg);
        } catch (e) {
          console.warn('[DataChannel] send hand-raise error:', e);
        }
      }
    });

    // 2. Also emit over socket as fallback (no duplicates)
    if (socket?.connected) {
      const payload = {
        roomId: stateRef.current.roomId,
        roomCode: stateRef.current.roomId,
        userId: currentUser.id,
        socketId: socket.id,
        id: socket.id,
        isHandRaised: nextHand,
      };
      socket.emit('hand-raise', payload);
    }
  }, [currentUser.id, socket]);

  // ── Host control socket listeners (useCallback so they are stable for the socket effect deps) ──
  const onHostMuteUser = useCallback(
    (payload: any = {}) => {
      const targetId = payload.socketId || payload.userId || payload.targetId || payload.id;
      if (!targetId) return;
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === targetId || p.socketId === targetId || p.userId === targetId
            ? { ...p, isMuted: true }
            : p
        ),
      }));
      if (targetId === currentUser.id || targetId === socket?.id) {
        localStreamRef.current?.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
        setCallState((prev) => ({
          ...prev,
          isMuted: true,
          localParticipant: { ...prev.localParticipant, isMuted: true },
          hostNotification: 'You were muted by the meeting host.',
        }));
      }
    },
    [currentUser.id, socket]
  );

  const onHostMuteAll = useCallback(() => {
    setCallState((prev) => ({
      ...prev,
      participants: prev.participants.map((p) => ({ ...p, isMuted: true })),
      hostNotification: 'All participants have been muted.',
    }));
    if (currentUser.id) {
      localStreamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = false;
      });
      setCallState((prev) => ({
        ...prev,
        isMuted: true,
        localParticipant: { ...prev.localParticipant, isMuted: true },
      }));
    }
  }, [currentUser.id]);

  const onHostStopScreenShare = useCallback(
    (payload: any = {}) => {
      const targetId = payload.socketId || payload.userId || payload.targetId || payload.id;
      if (!targetId) return;
      const isMe = targetId === currentUser.id || targetId === socket?.id;
      if (isMe && stateRef.current.isScreenSharing) {
        toggleScreenShareRef.current();
      }
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === targetId || p.socketId === targetId || p.userId === targetId
            ? { ...p, isScreenSharing: false, screenStream: null }
            : p
        ),
      }));
    },
    [currentUser.id, socket]
  );

  const onHostRemove = useCallback(() => {
    if (stateRef.current.status === 'idle') return;
    leaveGroupCallRef.current();
    alert('You were removed from the meeting by the host.');
  }, []);

  const onHostSettingsUpdate = useCallback(
    (payload: any = {}) => {
      if (!payload?.settings) return;
      setCallState((prev) => ({
        ...prev,
        hostSettings: payload.settings,
      }));
      if (!payload.settings.allowScreenShare && stateRef.current.isScreenSharing && !stateRef.current.isHost) {
        toggleScreenShareRef.current();
      }
    },
    []
  );

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

      const isFirst = rawUsers.length === 0;

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
            isCameraOff: typeof u.isCameraOff === 'boolean' ? u.isCameraOff : false,
            isHandRaised: u.isHandRaised ?? false,
          });
        }
        return {
          ...prev,
          participants: currentList,
          localParticipant: {
            ...prev.localParticipant,
            isHost: isFirst,
          },
        };
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
          isCameraOff: typeof payload.isCameraOff === 'boolean' ? payload.isCameraOff : false,
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

      console.log(`[Web Mesh] Received offer from ${peerId}`);
      const pc = await createPeer(peerId, undefined, false);
      if (!pc) return;

      try {
        // Guard against duplicate / colliding offer processing
        if (pc.signalingState !== 'stable') {
          if (pc.signalingState === 'have-remote-offer') {
            console.warn(`[Web Mesh] Ignoring duplicate in-flight offer from ${peerId}`);
            return;
          }
          try {
            await pc.setLocalDescription({ type: 'rollback' });
          } catch (rbErr) {
            console.warn('[Web Mesh] Rollback failed, continuing:', rbErr);
          }
        }

        await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
        // Crucial: Bind local tracks to transceivers so the answer includes local camera/screen with sendrecv!
        await attachLocalTracksToPeer(pc);
        // Drain buffered ICE candidates after setting remote description
        await drainPendingCandidates(peerId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const answerData = { type: answer.type, sdp: answer.sdp };
        socket.emit('answer', {
          targetId: peerId,
          to: peerId,
          answer: answerData,
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

      console.log(`[Web Mesh] Received answer from ${peerId}`);
      const pc = peersRef.current.get(peerId);
      if (pc) {
        if (pc.signalingState !== 'have-local-offer') {
          console.warn(`[Web Mesh] Ignoring duplicate/unexpected answer from ${peerId} (signalingState: ${pc.signalingState})`);
          return;
        }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(remoteAnswer));
          // Drain buffered ICE candidates after setting remote description
          await drainPendingCandidates(peerId, pc);
        } catch (e) {
          console.error('Error handling answer from peer:', peerId, e);
        }
      }
    };

    // 5. Receiving ICE Candidate
    const onIceCandidate = async ({ from, candidate, senderId }: { from?: string; candidate: any; senderId?: string }) => {
      const peerId = from || senderId;
      if (!peerId || !candidate) return;

      const candKey = `${peerId}_${candidate.candidate || candidate.sdpMid}_${candidate.sdpMLineIndex}`;
      if (processedCandidatesRef.current.has(candKey)) {
        return;
      }
      processedCandidatesRef.current.add(candKey);

      const pc = peersRef.current.get(peerId);
      if (pc && pc.remoteDescription && pc.remoteDescription.type) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('Error adding ICE candidate from peer:', peerId, e);
        }
      } else {
        // Buffer candidate until remote description is set
        queueCandidate(peerId, candidate);
      }
    };

    // 6. User Disconnected / Left
    const onUserDisconnected = (payload: any = {}) => {
      const peerId = payload.socketId || payload.userId || payload.id;
      if (!peerId) return;

      // Close WebRTC peer connection
      for (const [key, pc] of peersRef.current.entries()) {
        if (key === peerId || key === payload.socketId || key === payload.userId) {
          pc.close();
          peersRef.current.delete(key);
          peerStreamsRef.current.delete(key);
          peerScreenStreamsRef.current.delete(key);
        }
      }
      dataChannelsRef.current.delete(peerId);

      // Clean up Web Audio analyser for this peer (prevents ghost audio detection & memory leak)
      const oldAnalyser = remoteAnalysersRef.current.get(peerId);
      if (oldAnalyser) {
        try {
          oldAnalyser.source.disconnect();
        } catch {}
        remoteAnalysersRef.current.delete(peerId);
      }
      // Also try socketId key
      const oldAnalyserBySocket = remoteAnalysersRef.current.get(payload.socketId);
      if (oldAnalyserBySocket && oldAnalyserBySocket !== oldAnalyser) {
        try {
          oldAnalyserBySocket.source.disconnect();
        } catch {}
        remoteAnalysersRef.current.delete(payload.socketId);
      }

      // Clear buffered ICE candidates for this peer (prevents unbounded memory growth)
      pendingCandidatesRef.current.delete(peerId);
      if (payload.socketId) pendingCandidatesRef.current.delete(payload.socketId);
      iceRestartAttemptsRef.current.delete(peerId);
      if (payload.socketId) iceRestartAttemptsRef.current.delete(payload.socketId);

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

    // 8. Hand Raise Listener (from Socket)
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

    // 9. Display Name Change Listener (from Socket)
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

    // 10. Screen Share Toggle Listener (from Socket)
    const onPeerToggleScreenShare = (payload: any = {}) => {
      const peerId = payload.socketId || payload.userId || payload.id;
      if (!peerId) return;
      const isScreenSharing =
        typeof payload.enabled === 'boolean'
          ? payload.enabled
          : !!payload.isScreenSharing;
      const remoteCameraOff =
        typeof payload.isCameraOff === 'boolean' ? payload.isCameraOff : undefined;

      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === peerId || p.socketId === peerId || p.userId === peerId
            ? {
                ...p,
                isScreenSharing,
                isCameraOff: isScreenSharing
                  ? false
                  : remoteCameraOff !== undefined
                  ? remoteCameraOff
                  : p.isCameraOff,
              }
            : p
        ),
      }));
    };

    // Register clean, non-duplicate standard socket events
    socket.on('all-users', onAllUsers);
    socket.on('user-connected', onUserConnected);
    socket.on('offer', onOffer);
    socket.on('answer', onAnswer);
    socket.on('ice-candidate', onIceCandidate);
    socket.on('user-disconnected', onUserDisconnected);
    socket.on('user-left', onUserDisconnected);
    socket.on('toggle-audio', onPeerToggleAudio);
    socket.on('toggle-video', onPeerToggleVideo);
    socket.on('peer:toggle-audio', onPeerToggleAudio);
    socket.on('peer:toggle-video', onPeerToggleVideo);
    socket.on('toggle-screen-share', onPeerToggleScreenShare);
    socket.on('peer:toggle-screen-share', onPeerToggleScreenShare);
    socket.on('hand-raise', onPeerHandRaise);
    socket.on('change-name', onPeerNameChange);
    // Host control events from signaling server
    socket.on('host:mute-user', onHostMuteUser);
    socket.on('host:mute-all', onHostMuteAll);
    socket.on('host:stop-screenshare', onHostStopScreenShare);
    socket.on('host-remove', onHostRemove);
    socket.on('peer:host-settings', onHostSettingsUpdate);
    socket.on('host:settings-update', onHostSettingsUpdate);

    return () => {
      socket.off('all-users', onAllUsers);
      socket.off('user-connected', onUserConnected);
      socket.off('offer', onOffer);
      socket.off('answer', onAnswer);
      socket.off('ice-candidate', onIceCandidate);
      socket.off('user-disconnected', onUserDisconnected);
      socket.off('user-left', onUserDisconnected);
      socket.off('toggle-audio', onPeerToggleAudio);
      socket.off('toggle-video', onPeerToggleVideo);
      socket.off('peer:toggle-audio', onPeerToggleAudio);
      socket.off('peer:toggle-video', onPeerToggleVideo);
      socket.off('toggle-screen-share', onPeerToggleScreenShare);
      socket.off('peer:toggle-screen-share', onPeerToggleScreenShare);
      socket.off('hand-raise', onPeerHandRaise);
      socket.off('change-name', onPeerNameChange);
      socket.off('host:mute-user', onHostMuteUser);
      socket.off('host:mute-all', onHostMuteAll);
      socket.off('host:stop-screenshare', onHostStopScreenShare);
      socket.off('host-remove', onHostRemove);
      socket.off('peer:host-settings', onHostSettingsUpdate);
      socket.off('host:settings-update', onHostSettingsUpdate);
    };
  }, [
    createPeer,
    currentUser.id,
    drainPendingCandidates,
    queueCandidate,
    socket,
    upsertParticipant,
    onHostMuteUser,
    onHostMuteAll,
    onHostStopScreenShare,
    onHostRemove,
    onHostSettingsUpdate,
  ]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const broadcast = useCallback((obj: unknown) => {
    const msg = JSON.stringify(obj);
    dataChannelsRef.current.forEach((dc) => {
      if (dc.readyState === 'open') {
        try {
          dc.send(msg);
        } catch {}
      }
    });
  }, []);

  const sendChat = useCallback(
    (text: string) => {
      if (!stateRef.current.isHost && !stateRef.current.hostSettings.allowChat) {
        setCallState((prev) => ({
          ...prev,
          hostNotification: 'In-call chat is disabled by the meeting host.',
        }));
        return;
      }

      const m: ChatMessage = {
        id: `${currentUser.id}-${Date.now()}`,
        userId: currentUser.id,
        name: stateRef.current.localParticipant.name,
        text,
        ts: Date.now(),
      };
      setChat((p) => [...p, m]);
      broadcast({ type: 'chat', ...m });
    },
    [broadcast, currentUser.id]
  );

  const sendReaction = useCallback(
    (emoji: string) => {
      const name = stateRef.current.localParticipant.name;
      pushReaction(emoji, 'You');
      broadcast({ type: 'reaction', emoji, name, userId: currentUser.id });
    },
    [broadcast, currentUser.id, pushReaction]
  );

  const clearUnread = useCallback(() => setUnreadChat(0), []);

  // ── Host Admin Controls ───────────────────────────────────────────
  const hostMuteParticipant = useCallback(
    (peerId: string) => {
      broadcast({ type: 'host-mute', targetId: peerId });
      socket?.emit('host:mute-user', { targetId: peerId, roomId: stateRef.current.roomId });
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === peerId || p.socketId === peerId || p.userId === peerId
            ? { ...p, isMuted: true }
            : p
        ),
      }));
    },
    [broadcast, socket]
  );

  const hostMuteAll = useCallback(() => {
    broadcast({ type: 'host-mute-all' });
    socket?.emit('host:mute-all', { roomId: stateRef.current.roomId });
    setCallState((prev) => ({
      ...prev,
      participants: prev.participants.map((p) => ({ ...p, isMuted: true })),
      hostNotification: 'All participants have been muted.',
    }));
  }, [broadcast, socket]);

  const hostStopScreenShare = useCallback(
    (peerId: string) => {
      broadcast({ type: 'host-stop-screenshare', targetId: peerId });
      socket?.emit('host:stop-screenshare', { targetId: peerId, roomId: stateRef.current.roomId });
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === peerId || p.socketId === peerId || p.userId === peerId
            ? { ...p, isScreenSharing: false, screenStream: null }
            : p
        ),
      }));
    },
    [broadcast, socket]
  );

  const hostRemoveParticipant = useCallback(
    (peerId: string) => {
      broadcast({ type: 'host-remove', targetId: peerId });
      socket?.emit('host:remove-user', { targetId: peerId, roomId: stateRef.current.roomId });
      const pc = peersRef.current.get(peerId);
      if (pc) {
        pc.close();
        peersRef.current.delete(peerId);
      }
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.filter(
          (p) => p.id !== peerId && p.socketId !== peerId && p.userId !== peerId
        ),
      }));
    },
    [broadcast, socket]
  );

  const hostUpdateSettings = useCallback(
    (newSettings: Partial<HostSettings>) => {
      const updated: HostSettings = {
        ...stateRef.current.hostSettings,
        ...newSettings,
      };
      setCallState((prev) => ({
        ...prev,
        hostSettings: updated,
      }));
      broadcast({ type: 'host-settings', settings: updated });
      socket?.emit('host:settings-update', { settings: updated, roomId: stateRef.current.roomId });
    },
    [broadcast, socket]
  );

  const clearHostNotification = useCallback(() => {
    setCallState((prev) => ({ ...prev, hostNotification: null }));
  }, []);

  // Keep refs to late-defined callbacks so socket listeners can call them safely
  toggleScreenShareRef.current = toggleScreenShare;
  leaveGroupCallRef.current = leaveGroupCall;

  return {
    callState,
    localStream,
    screenStream,
    joinGroupCall,
    leaveGroupCall,
    changeName,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleHandRaise,
    chat,
    unreadChat,
    reactions,
    sendChat,
    sendReaction,
    clearUnread,
    virtualBgMode,
    applyVirtualBackground,
    hostMuteParticipant,
    hostMuteAll,
    hostStopScreenShare,
    hostRemoveParticipant,
    hostUpdateSettings,
    clearHostNotification,
  };
}
