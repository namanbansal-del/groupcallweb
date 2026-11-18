import React, { useEffect, useRef, useState } from 'react';
import { MicOff, Hand, MonitorUp } from 'lucide-react';
import type { Participant } from '../types';

interface ParticipantVideoTileProps {
  participant: Participant;
  isLocal?: boolean;
}

export const ParticipantVideoTile: React.FC<ParticipantVideoTileProps> = ({
  participant,
  isLocal = false,
}) => {
  const { name, isMuted, isCameraOff, isSpeaking, isHandRaised, isScreenSharing, stream } =
    participant;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const initial = name ? name.slice(0, 1).toUpperCase() : '?';
  const [, setTrackVersion] = useState(0);

  // Check if live video tracks actually exist on this stream
  const hasLiveVideoTrack = !!(
    stream &&
    stream.getVideoTracks().length > 0 &&
    stream.getVideoTracks().some((t) => t.readyState !== 'ended')
  );

  const showVideo = hasLiveVideoTrack && (!isCameraOff || isScreenSharing);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    // Strict mobile / Safari inline autoplay compliance
    videoEl.muted = true;
    videoEl.defaultMuted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');

    if (stream && showVideo) {
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
      }
      const playPromise = videoEl.play();
      if (playPromise !== undefined) {
        playPromise.catch((err) => {
          console.warn('[ParticipantVideoTile] play() error:', err?.message || err);
        });
      }
    } else {
      videoEl.srcObject = null;
    }

    const handleLoadedMetadata = () => {
      if (videoEl && showVideo) {
        videoEl.play().catch(() => {});
      }
    };
    videoEl.addEventListener('loadedmetadata', handleLoadedMetadata);

    const handleUserInteraction = () => {
      if (videoEl && videoEl.paused && showVideo) {
        videoEl.play().catch(() => {});
      }
    };
    window.addEventListener('touchstart', handleUserInteraction, { once: true });
    window.addEventListener('click', handleUserInteraction, { once: true });

    // Listen to video tracks unmuting or ending
    if (stream) {
      const vTracks = stream.getVideoTracks();
      const onTrackChange = () => {
        setTrackVersion((v) => v + 1);
        if (videoEl && videoEl.paused && showVideo) {
          videoEl.play().catch(() => {});
        }
      };

      vTracks.forEach((t) => {
        t.addEventListener('unmute', onTrackChange);
        t.addEventListener('ended', onTrackChange);
      });

      return () => {
        videoEl.removeEventListener('loadedmetadata', handleLoadedMetadata);
        window.removeEventListener('touchstart', handleUserInteraction);
        window.removeEventListener('click', handleUserInteraction);
        vTracks.forEach((t) => {
          t.removeEventListener('unmute', onTrackChange);
          t.removeEventListener('ended', onTrackChange);
        });
      };
    }

    return () => {
      videoEl.removeEventListener('loadedmetadata', handleLoadedMetadata);
      window.removeEventListener('touchstart', handleUserInteraction);
      window.removeEventListener('click', handleUserInteraction);
    };
  }, [stream, showVideo, isCameraOff, isScreenSharing]);

  return (
    <div
      className={`video-tile-wrap ${isSpeaking && !isMuted ? 'speaking-active' : ''}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={true}
        className={`video-elem ${isLocal && !isScreenSharing ? 'video-mirrored' : ''} ${
          isScreenSharing ? 'video-screenshare' : ''
        }`}
        style={{ display: showVideo ? 'block' : 'none' }}
      />
      {!showVideo && (
        <div className="video-avatar-fallback">
          <div className={`avatar-circle-lg ${isSpeaking && !isMuted ? 'speaking-ring' : ''}`}>
            <span>{initial}</span>
          </div>
        </div>
      )}

      {/* Floating Badges */}
      <div className="video-badges-top">
        {isHandRaised && (
          <div className="badge-hand">
            <Hand size={14} className="badge-icon" />
            <span>Hand Raised</span>
          </div>
        )}

        {isScreenSharing && (
          <div className="badge-screen">
            <MonitorUp size={14} />
            <span>{isLocal ? 'Your Screen' : 'Presenting'}</span>
          </div>
        )}
      </div>

      {/* Bottom Name & Mic Pill */}
      <div className="video-info-pill">
        <span className="participant-name" title={name}>
          {name} {isLocal && '(You)'}
        </span>
        {isMuted ? (
          <div className="mic-badge-muted" title="Muted">
            <MicOff size={13} color="#EF4444" />
          </div>
        ) : (
          isSpeaking && (
            <div className="voice-wave-indicator" title="Speaking">
              <span className="bar bar1" />
              <span className="bar bar2" />
              <span className="bar bar3" />
            </div>
          )
        )}
      </div>
    </div>
  );
};
