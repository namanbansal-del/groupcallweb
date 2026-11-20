import { useState, useRef, useCallback, useEffect } from 'react';
import type { Participant } from '../types';

export type RecordingType = 'none' | 'screen' | 'audio';

interface StartRecordingOptions {
  localStream: MediaStream | null;
  participants: Participant[];
  roomId: string | null;
}

export function useCallRecording() {
  const [recordingType, setRecordingType] = useState<RecordingType>('none');
  const [recordingDurationSec, setRecordingDurationSec] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<any>(null);

  // Timer updater for active recording
  useEffect(() => {
    if (recordingType !== 'none') {
      setRecordingDurationSec(0);
      timerRef.current = setInterval(() => {
        setRecordingDurationSec((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      setRecordingDurationSec(0);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recordingType]);

  // Mix all audio sources (local mic + screen audio + all remote participants)
  const createMixedAudioDestination = useCallback(
    (
      localStream: MediaStream | null,
      participants: Participant[],
      screenStream?: MediaStream | null
    ): { ctx: AudioContext; destination: MediaStreamAudioDestinationNode } => {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const destination = ctx.createMediaStreamDestination();

      // 1. Local user audio
      if (localStream && localStream.getAudioTracks().length > 0) {
        try {
          const localAudio = new MediaStream([localStream.getAudioTracks()[0]]);
          const localSource = ctx.createMediaStreamSource(localAudio);
          localSource.connect(destination);
        } catch (e) {
          console.warn('[Recording] Could not mix local audio:', e);
        }
      }

      // 2. Screen audio (if captured from tab/system)
      if (screenStream && screenStream.getAudioTracks().length > 0) {
        try {
          const screenAudioSource = ctx.createMediaStreamSource(screenStream);
          screenAudioSource.connect(destination);
        } catch (e) {
          console.warn('[Recording] Could not mix screen audio:', e);
        }
      }

      // 3. Remote participants' audio
      participants.forEach((p) => {
        if (p.stream && p.stream.getAudioTracks().length > 0) {
          try {
            const remoteSource = ctx.createMediaStreamSource(p.stream);
            remoteSource.connect(destination);
          } catch (e) {
            console.warn(`[Recording] Could not mix remote participant ${p.name}:`, e);
          }
        }
      });

      return { ctx, destination };
    },
    []
  );

  // ── Stop Active Recording ───────────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.warn('[Recording] Error stopping recorder:', err);
      }
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {}
      audioContextRef.current = null;
    }

    setRecordingType('none');
  }, []);

  // ── Start Screen Recording with Audio ───────────────────────────────
  const startScreenRecording = useCallback(
    async ({ localStream, participants, roomId }: StartRecordingOptions) => {
      if (recordingType !== 'none') {
        stopRecording();
      }

      try {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          alert('Screen recording is not supported in this browser. Please use Chrome or Edge on desktop.');
          return;
        }

        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true, // Attempt to capture system/tab audio
        });

        screenStreamRef.current = screenStream;

        // Auto-stop if user clicks "Stop sharing" on the browser banner
        const videoTrack = screenStream.getVideoTracks()[0];
        if (videoTrack) {
          videoTrack.onended = () => {
            stopRecording();
          };
        }

        // Mix local, remote, and screen audio
        const { ctx, destination } = createMixedAudioDestination(
          localStream,
          participants,
          screenStream
        );
        audioContextRef.current = ctx;

        // Combine video track with mixed audio track
        const combinedTracks: MediaStreamTrack[] = [videoTrack];
        const mixedAudioTrack = destination.stream.getAudioTracks()[0];
        if (mixedAudioTrack) {
          combinedTracks.push(mixedAudioTrack);
        }

        const recordStream = new MediaStream(combinedTracks);
        recordedChunksRef.current = [];

        // Pick best supported video container
        const mimeTypes = [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
          'video/mp4',
        ];
        const selectedMime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

        const recorder = new MediaRecorder(recordStream, selectedMime ? { mimeType: selectedMime } : undefined);
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            recordedChunksRef.current.push(event.data);
          }
        };

        recorder.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, {
            type: selectedMime || 'video/webm',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const ext = selectedMime.includes('mp4') ? 'mp4' : 'webm';
          a.download = `Meeting-Recording-${roomId || 'Room'}-${dateStr}.${ext}`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 100);
        };

        recorder.start(1000); // 1-second chunks
        setRecordingType('screen');
      } catch (err: any) {
        if (err.name !== 'NotAllowedError') {
          console.error('[Recording] Failed to start screen recording:', err);
          alert('Could not start screen recording: ' + (err.message || 'Permission denied'));
        }
        stopRecording();
      }
    },
    [recordingType, stopRecording, createMixedAudioDestination]
  );

  // ── Start Audio Only Recording (MP3 / Audio) ─────────────────────────
  const startAudioRecording = useCallback(
    async ({ localStream, participants, roomId }: StartRecordingOptions) => {
      if (recordingType !== 'none') {
        stopRecording();
      }

      try {
        const { ctx, destination } = createMixedAudioDestination(localStream, participants);
        audioContextRef.current = ctx;

        recordedChunksRef.current = [];

        // Pick best supported audio container
        const mimeTypes = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/mp4',
          'audio/ogg',
        ];
        const selectedMime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

        const recorder = new MediaRecorder(
          destination.stream,
          selectedMime ? { mimeType: selectedMime } : undefined
        );
        mediaRecorderRef.current = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            recordedChunksRef.current.push(event.data);
          }
        };

        recorder.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, {
            type: selectedMime || 'audio/webm',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.style.display = 'none';
          a.href = url;
          const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const ext = selectedMime.includes('mp4') ? 'm4a' : 'mp3';
          a.download = `Meeting-Audio-${roomId || 'Room'}-${dateStr}.${ext}`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 100);
        };

        recorder.start(1000);
        setRecordingType('audio');
      } catch (err: any) {
        console.error('[Recording] Failed to start audio recording:', err);
        alert('Could not start audio recording: ' + (err.message || 'Unknown error'));
        stopRecording();
      }
    },
    [recordingType, stopRecording, createMixedAudioDestination]
  );

  return {
    recordingType,
    isRecording: recordingType !== 'none',
    recordingDurationSec,
    startScreenRecording,
    startAudioRecording,
    stopRecording,
  };
}
