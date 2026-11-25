import React, { useEffect, useRef } from 'react';

interface RemoteAudioProps {
  stream: MediaStream;
  isMuted?: boolean;
  onPlaybackBlocked?: (blocked: boolean) => void;
}

export const RemoteAudio: React.FC<RemoteAudioProps> = ({
  stream,
  isMuted = false,
  onPlaybackBlocked,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl || !stream) return;

    audioEl.muted = false;
    audioEl.defaultMuted = false;

    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
    }

    const recoverAudio = async () => {
      if (!audioEl || !stream) return;
      if (isMuted) {
        onPlaybackBlocked?.(false);
        return;
      }

      try {
        if (audioEl.srcObject !== stream) {
          audioEl.srcObject = stream;
        }
        if (audioEl.paused) {
          await audioEl.play();
        }
        onPlaybackBlocked?.(false);
      } catch (err: any) {
        console.warn('[RemoteAudio] Play interrupted or blocked by device:', err);
        onPlaybackBlocked?.(true);

        // In iOS WebKit, resetting srcObject revives dead WebKit CoreAudio output graphs
        try {
          audioEl.srcObject = null;
          audioEl.srcObject = stream;
          await audioEl.play();
          onPlaybackBlocked?.(false);
        } catch (_) {}
      }
    };

    // Initial play attempt
    recoverAudio();

    // Event listeners to automatically resume whenever device returns or user interacts
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        recoverAudio();
      }
    };

    const handleUserGesture = () => {
      if (audioEl.paused && !isMuted) {
        recoverAudio();
      }
    };

    const handlePause = () => {
      if (!isMuted) {
        // iOS Safari paused this audio element during a system interruption (e.g. phone call)
        setTimeout(recoverAudio, 300);
      }
    };

    audioEl.addEventListener('pause', handlePause);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pageshow', handleVisibility);
    window.addEventListener('focus', handleVisibility);
    window.addEventListener('touchstart', handleUserGesture, { passive: true });
    window.addEventListener('click', handleUserGesture, { passive: true });

    // Track unmute listener (fires when iOS phone call is cut/ended)
    const audioTracks = stream.getAudioTracks();
    audioTracks.forEach((t) => {
      t.addEventListener('unmute', recoverAudio);
    });

    // 2-second watchdog timer: if device paused audio, automatically kick it back
    const watchdog = setInterval(() => {
      if (audioEl && !isMuted && audioEl.paused) {
        recoverAudio();
      }
    }, 2000);

    return () => {
      clearInterval(watchdog);
      audioEl.removeEventListener('pause', handlePause);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pageshow', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
      window.removeEventListener('touchstart', handleUserGesture);
      window.removeEventListener('click', handleUserGesture);
      audioTracks.forEach((t) => {
        t.removeEventListener('unmute', recoverAudio);
      });
    };
  }, [stream, isMuted, onPlaybackBlocked]);

  useEffect(() => {
    if (!stream) return;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });
  }, [stream, isMuted]);

  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      style={{
        position: 'fixed',
        top: '-9999px',
        left: '-9999px',
        width: '1px',
        height: '1px',
        opacity: 0,
        pointerEvents: 'none',
      }}
    />
  );
};
