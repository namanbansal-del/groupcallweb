import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallMode, GroupCallState, Participant } from '../types';

const ICE_SERVERS: RTCConfiguration = {
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
}: {
  socket: any;
  currentUser: { id: string; name: string; avatar?: string };
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

  // ── Create Peer Connection for a Remote User ─────────────────────
  const createPeer = useCallback(
    async (remoteUserId: string, isInitiator: boolean) => {
      if (peersRef.current.has(remoteUserId)) {
        return peersRef.current.get(remoteUserId)!;
      }

      const pc = new RTCPeerConnection(ICE_SERVERS);
      peersRef.current.set(remoteUserId, pc);

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current!);
        });
      }

      pc.onicecandidate = (event) => {
        if (event.candidate && socket?.connected) {
          socket.emit('peer:ice-candidate', {
            roomId: stateRef.current.roomId,
            targetUserId: remoteUserId,
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (event) => {
        let stream = peerStreamsRef.current.get(remoteUserId);
        if (event.streams && event.streams[0]) {
          stream = event.streams[0];
        } else {
          if (!stream) stream = new MediaStream();
          stream.addTrack(event.track);
        }
        if (stream) {
          peerStreamsRef.current.set(remoteUserId, stream);
        }

        setCallState((prev) => ({
          ...prev,
          participants: prev.participants.map((p) =>
            p.id === remoteUserId ? { ...p, stream } : p,
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
          socket?.emit('peer:offer', {
            roomId: stateRef.current.roomId,
            targetUserId: remoteUserId,
            sdp: offer,
          });
        } catch (e) {
          console.error('Error creating offer for peer', remoteUserId, e);
        }
      }

      return pc;
    },
    [socket],
  );

  // ── Join Group Call ──────────────────────────────────────────────
  const joinGroupCall = useCallback(
    async (roomId: string, mode: CallMode = 'video') => {
      try {
        setCallState((prev) => ({
          ...prev,
          roomId,
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
          // Fallback to audio only if video failed
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
          socket.emit('room:join', {
            roomId,
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
    if (socket?.connected && stateRef.current.roomId) {
      socket.emit('room:leave', {
        roomId: stateRef.current.roomId,
        userId: currentUser.id,
      });
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

    if (socket?.connected && stateRef.current.roomId) {
      socket.emit('peer:media-toggle', {
        roomId: stateRef.current.roomId,
        userId: currentUser.id,
        isMuted: nextMuted,
        isCameraOff: stateRef.current.isCameraOff,
      });
    }
  }, [currentUser.id, socket]);

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

    if (socket?.connected && stateRef.current.roomId) {
      socket.emit('peer:media-toggle', {
        roomId: stateRef.current.roomId,
        userId: currentUser.id,
        isMuted: stateRef.current.isMuted,
        isCameraOff: nextCameraOff,
      });
    }
  }, [currentUser.id, socket]);

  // ── Toggle Screen Sharing ────────────────────────────────────────
  const toggleScreenShare = useCallback(async () => {
    if (stateRef.current.isScreenSharing) {
      // Stop screen share
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => t.stop());
        screenStreamRef.current = null;
      }

      // Revert peer tracks to camera video
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
      // Start screen share
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

        // Replace track on all active peers
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

    if (socket?.connected && stateRef.current.roomId) {
      socket.emit('peer:hand-raise', {
        roomId: stateRef.current.roomId,
        userId: currentUser.id,
        isHandRaised: nextHand,
      });
    }
  }, [currentUser.id, socket]);

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

    // Start background activity ticker for speaking waves and hand raises
    if (!simulationTimerRef.current) {
      simulationTimerRef.current = window.setInterval(() => {
        setCallState((prev) => {
          if (prev.participants.length === 0) return prev;
          const updated = prev.participants.map((p) => {
            // randomly fluctuate speaking
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
      const currentTotal = 1 + prev.participants.length; // 1 is local user
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

  // ── Socket Room Listeners ────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    const onRoomPeers = async ({ peers }: { peers?: Participant[] } = {}) => {
      const safePeers = Array.isArray(peers) ? peers : [];
      setCallState((prev) => ({ ...prev, participants: safePeers }));
      for (const peer of safePeers) {
        if (peer?.id) {
          await createPeer(peer.id, true);
        }
      }
    };

    const onPeerJoined = async ({ user }: { user: Participant }) => {
      setCallState((prev) => {
        if (prev.participants.some((p) => p.id === user.id)) return prev;
        return { ...prev, participants: [...prev.participants, user] };
      });
      await createPeer(user.id, false);
    };

    const onPeerLeft = ({ userId }: { userId: string }) => {
      const pc = peersRef.current.get(userId);
      if (pc) {
        pc.close();
        peersRef.current.delete(userId);
        peerStreamsRef.current.delete(userId);
      }
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.filter((p) => p.id !== userId),
      }));
    };

    const onPeerOffer = async ({ senderId, sdp }: { senderId: string; sdp: any }) => {
      const pc = await createPeer(senderId, false);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('peer:answer', {
          roomId: stateRef.current.roomId,
          targetUserId: senderId,
          sdp: answer,
        });
      } catch (e) {
        console.error('Error handling peer offer', e);
      }
    };

    const onPeerAnswer = async ({ senderId, sdp }: { senderId: string; sdp: any }) => {
      const pc = peersRef.current.get(senderId);
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } catch (e) {
          console.error('Error handling peer answer', e);
        }
      }
    };

    const onPeerCandidate = async ({
      senderId,
      candidate,
    }: {
      senderId: string;
      candidate: any;
    }) => {
      const pc = peersRef.current.get(senderId);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding ICE candidate', e);
        }
      }
    };

    const onPeerMediaToggle = ({
      userId,
      isMuted,
      isCameraOff,
    }: {
      userId: string;
      isMuted: boolean;
      isCameraOff: boolean;
    }) => {
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === userId ? { ...p, isMuted, isCameraOff } : p,
        ),
      }));
    };

    const onPeerHandRaise = ({
      userId,
      isHandRaised,
    }: {
      userId: string;
      isHandRaised: boolean;
    }) => {
      setCallState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.id === userId ? { ...p, isHandRaised } : p,
        ),
      }));
    };

    socket.on('room:peers', onRoomPeers);
    socket.on('peer:joined', onPeerJoined);
    socket.on('peer:left', onPeerLeft);
    socket.on('peer:offer', onPeerOffer);
    socket.on('peer:answer', onPeerAnswer);
    socket.on('peer:ice-candidate', onPeerCandidate);
    socket.on('peer:media-toggle', onPeerMediaToggle);
    socket.on('peer:hand-raise', onPeerHandRaise);

    return () => {
      socket.off('room:peers', onRoomPeers);
      socket.off('peer:joined', onPeerJoined);
      socket.off('peer:left', onPeerLeft);
      socket.off('peer:offer', onPeerOffer);
      socket.off('peer:answer', onPeerAnswer);
      socket.off('peer:ice-candidate', onPeerCandidate);
      socket.off('peer:media-toggle', onPeerMediaToggle);
      socket.off('peer:hand-raise', onPeerHandRaise);
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
