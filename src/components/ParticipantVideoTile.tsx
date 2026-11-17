import React, { useEffect, useRef } from 'react';
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

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream, isCameraOff]);

  const showVideo = stream && !isCameraOff;

  return (
    <div
      className={`video-tile-wrap ${isSpeaking && !isMuted ? 'speaking-active' : ''}`}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className={`video-elem ${isLocal && !isScreenSharing ? 'video-mirrored' : ''}`}
        />
      ) : (
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
            <span>Presenting</span>
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
