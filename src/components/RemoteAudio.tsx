import React, { useEffect, useRef } from 'react';

interface RemoteAudioProps {
  stream: MediaStream;
  isMuted?: boolean;
}

export const RemoteAudio: React.FC<RemoteAudioProps> = ({ stream, isMuted = false }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl || !stream) return;

    if (audioEl.srcObject !== stream) {
      audioEl.srcObject = stream;
    }

    const playPromise = audioEl.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        // Autoplay may need user gesture; it will resume when user interacts
        console.warn('[RemoteAudio] Autoplay blocked, will play on user interaction:', err);
      });
    }
  }, [stream]);

  useEffect(() => {
    if (!stream) return;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !isMuted;
    });
  }, [stream, isMuted]);

  return <audio ref={audioRef} autoPlay playsInline />;
};
