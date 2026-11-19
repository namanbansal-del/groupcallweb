import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallMode, GroupCallState, Participant } from '../types';

const FALLBACK_ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    {
      urls: [
        'stun:13.126.239.227:3478',
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
    {
      urls: [
        'turn:13.126.239.227:3478?transport=udp',
        'turn:13.126.239.227:3478?transport=tcp',
      ],
      username: 'turnuser',
      credential: 'techugo@123',
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
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [iceConfig, setIceConfig] = useState<RTCConfiguration>(FALLBACK_ICE_SERVERS);
  const iceConfigRef = useRef<RTCConfiguration>(FALLBACK_ICE_SERVERS);
  iceConfigRef.current = iceConfig;

  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const peerStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const dataChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const timerRef = useRef<number | null>(null);
  const stateRef = useRef(callState);
  stateRef.current = callState;

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
                userId: currentUser.id,
              })
            );
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
                  };
                }
                return p;
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
                      isCameraOff: isScreenSharing ? false : p.isCameraOff,
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
    [currentUser.id]
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

  // ── Helper to attach/bind local media tracks to peer transceivers ──
  const attachLocalTracksToPeer = useCallback(async (pc: RTCPeerConnection) => {
    const stream =
      stateRef.current.isScreenSharing && screenStreamRef.current
        ? screenStreamRef.current
        : localStreamRef.current;

    const audioTrack = localStreamRef.current?.getAudioTracks()[0];
    const videoTrack = stream?.getVideoTracks()[0];

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

    // 2. Video Transceiver
    const videoTransceiver = transceivers.find(
      (t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video' || t.mid === '1'
    );
    if (videoTransceiver && videoTransceiver.sender) {
      videoTransceiver.direction = 'sendrecv';
      if (videoTrack && videoTransceiver.sender.track !== videoTrack) {
        await videoTransceiver.sender.replaceTrack(videoTrack).catch(() => {});
      }
    } else if (videoTrack) {
      try {
        pc.addTrack(videoTrack, stream!);
      } catch (e) {}
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
        const stream =
          stateRef.current.isScreenSharing && screenStreamRef.current
            ? screenStreamRef.current
            : localStreamRef.current;

        if (stream) {
          stream.getTracks().forEach((track) => {
            try {
              pc.addTrack(track, stream);
            } catch (e) {
              console.warn('[Web Mesh] Error adding track:', e);
            }
          });
        }

        const transceivers = pc.getTransceivers();
        const hasAudio = transceivers.some((t) => t.sender.track?.kind === 'audio');
        const hasVideo = transceivers.some((t) => t.sender.track?.kind === 'video');
        if (!hasAudio) {
          try {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
          } catch (e) {}
        }
        if (!hasVideo) {
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

      // Relay ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && socket?.connected) {
          const candidateData = event.candidate.toJSON();
          socket.emit('ice-candidate', {
            to: remoteSocketId,
            candidate: candidateData,
          });
          socket.emit('peer:ice-candidate', {
            roomId: stateRef.current.roomId,
            targetUserId: remoteSocketId,
            candidate: candidateData,
          });
        }
      };

      // Remote stream received: Create a new MediaStream instance to trigger React re-renders
      pc.ontrack = (event) => {
        console.log(`[Web Mesh] ontrack from ${remoteSocketId}: kind=${event.track.kind}`);
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
    [currentUser.id, setupDataChannel, socket, upsertParticipant]
  );

  // ── Join Group Call ──────────────────────────────────────────────
  const joinGroupCall = useCallback(
    async (
      roomId: string,
      mode: CallMode = 'video',
      userName?: string,
      cameraEnabled: boolean = true,
      micEnabled: boolean = true,
      existingStream?: MediaStream | null
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
          error: null,
          localParticipant: {
            ...prev.localParticipant,
            name: effectiveName,
            isCameraOff: initialCameraOff,
            isMuted: initialMuted,
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
                    width: { ideal: 640 },
                    height: { ideal: 480 },
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
          localParticipant: {
            ...prev.localParticipant,
            name: effectiveName,
            stream,
            isMuted: initialMuted,
            isCameraOff: actualCameraOff,
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
              user: {
                id: currentUser.id,
                name: effectiveName,
                userName: effectiveName,
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

          socket.emit('room:join', {
            roomId: roomCode,
            user: {
              id: currentUser.id,
              name: effectiveName,
              userName: effectiveName,
              avatar: currentUser.avatar,
              isMuted: initialMuted,
              isCameraOff: actualCameraOff,
              mode,
            },
          });
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

      // 2. Also emit over socket
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

  // ── Toggle Camera (Complete Hardware Sensor Power Down) ───────────
  const toggleCamera = useCallback(async () => {
    const nextCameraOff = !stateRef.current.isCameraOff;

    if (nextCameraOff) {
      // Stopping camera: Stop all video tracks completely so camera hardware sensor powers down
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
          video: { width: { ideal: 640 }, height: { ideal: 480 } },
        });
        const newTrack = videoStream.getVideoTracks()[0];
        if (newTrack) {
          if (!localStreamRef.current) {
            localStreamRef.current = new MediaStream();
          }
          localStreamRef.current.addTrack(newTrack);

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
      setScreenStream(null);

      const cameraTrack = localStreamRef.current?.getVideoTracks()[0] || null;

      // Revert video track back to camera on all peers
      peersRef.current.forEach((pc) => {
        const transceivers = pc.getTransceivers();
        const videoTransceiver = transceivers.find(
          (t) =>
            t.sender.track?.kind === 'video' ||
            t.receiver.track?.kind === 'video' ||
            t.mid === '1'
        );
        if (videoTransceiver && videoTransceiver.sender) {
          videoTransceiver.direction = cameraTrack ? 'sendrecv' : 'recvonly';
          videoTransceiver.sender.replaceTrack(cameraTrack).catch(() => {});
        } else {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(cameraTrack).catch(() => {});
        }
      });

      setCallState((prev) => ({
        ...prev,
        isScreenSharing: false,
        localParticipant: {
          ...prev.localParticipant,
          stream: localStreamRef.current,
          isScreenSharing: false,
        },
      }));

      // Broadcast screen share stopped to peers via DataChannel
      const msg = JSON.stringify({
        type: 'screen-share',
        isScreenSharing: false,
        userId: currentUser.id,
      });
      dataChannelsRef.current.forEach((dc) => {
        if (dc.readyState === 'open') {
          try { dc.send(msg); } catch (e) {}
        }
      });
      if (socket?.connected) {
        socket.emit('toggle-screen-share', { enabled: false, userId: currentUser.id });
      }
    } else {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            displaySurface: 'monitor',
          },
          audio: false,
        });
        screenStreamRef.current = screenStream;
        setScreenStream(screenStream);

        const screenTrack = screenStream.getVideoTracks()[0];
        screenTrack.onended = () => {
          toggleScreenShare();
        };

        // Replace video track with screen track on all peers
        peersRef.current.forEach((pc) => {
          const transceivers = pc.getTransceivers();
          const videoTransceiver = transceivers.find(
            (t) =>
              t.sender.track?.kind === 'video' ||
              t.receiver.track?.kind === 'video' ||
              t.mid === '1'
          );
          if (videoTransceiver && videoTransceiver.sender) {
            videoTransceiver.direction = 'sendrecv';
            videoTransceiver.sender.replaceTrack(screenTrack).catch((err) => {
              console.warn('[ScreenShare] replaceTrack error:', err);
            });
          } else {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) {
              sender.replaceTrack(screenTrack).catch((err) => {
                console.warn('[ScreenShare] replaceTrack error:', err);
              });
            }
          }
        });

        setCallState((prev) => ({
          ...prev,
          isScreenSharing: true,
          localParticipant: {
            ...prev.localParticipant,
            stream: screenStream,
            isScreenSharing: true,
            isCameraOff: false,
          },
        }));

        // Broadcast screen share started to peers via DataChannel
        const msg = JSON.stringify({
          type: 'screen-share',
          isScreenSharing: true,
          userId: currentUser.id,
        });
        dataChannelsRef.current.forEach((dc) => {
          if (dc.readyState === 'open') {
            try { dc.send(msg); } catch (e) {}
          }
        });
        if (socket?.connected) {
          socket.emit('toggle-screen-share', { enabled: true, userId: currentUser.id });
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

    // 2. Also emit over socket as fallback
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

      console.log(`[Web Mesh] Received offer from ${peerId}`);
      const pc = await createPeer(peerId, undefined, false);
      if (!pc) return;

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
        // Crucial: Bind local tracks to transceivers so the answer includes local camera/screen with sendrecv!
        await attachLocalTracksToPeer(pc);
        // Drain buffered ICE candidates after setting remote description
        await drainPendingCandidates(peerId, pc);

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

      console.log(`[Web Mesh] Received answer from ${peerId}`);
      const pc = peersRef.current.get(peerId);
      if (pc) {
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

      for (const [key, pc] of peersRef.current.entries()) {
        if (key === peerId || key === payload.socketId || key === payload.userId) {
          pc.close();
          peersRef.current.delete(key);
          peerStreamsRef.current.delete(key);
        }
      }
      dataChannelsRef.current.delete(peerId);

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
  }, [createPeer, currentUser.id, drainPendingCandidates, queueCandidate, socket, upsertParticipant]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

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
  };
}
