import React, { useEffect, useRef, useState } from 'react';
import { MicOff, Hand, MonitorUp, Edit2 } from 'lucide-react';
import type { Participant } from '../types';

interface ParticipantVideoTileProps {
  participant: Participant;
  isLocal?: boolean;
  isVirtualBgActive?: boolean;
  onRename?: () => void;
}

export const ParticipantVideoTile: React.FC<ParticipantVideoTileProps> = ({
  participant,
  isLocal = false,
  isVirtualBgActive = false,
  onRename,
}) => {
  const { name, isMuted, isCameraOff, isSpeaking, isHandRaised, isScreenSharing, isHost, stream } =
    participant;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const initial = name ? name.slice(0, 1).toUpperCase() : '?';
  const [, setTrackVersion] = useState(0);
  const [hasFrames, setHasFrames] = useState(isLocal);

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

    // Reset frame state on stream change
    if (!isLocal) {
      setHasFrames(false);
    }

    // Strict mobile / Safari inline autoplay compliance
    videoEl.muted = true;
    videoEl.defaultMuted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', 'true');
    videoEl.setAttribute('webkit-playsinline', 'true');

    const checkReady = () => {
      if (videoEl && videoEl.videoWidth > 0) {
        setHasFrames(true);
      }
    };

    if (stream && showVideo) {
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
      }
      const playPromise = videoEl.play();
      if (playPromise !== undefined) {
        playPromise.then(checkReady).catch((err) => {
          console.warn('[ParticipantVideoTile] play() error:', err?.message || err);
        });
      }
    } else {
      videoEl.srcObject = null;
      setHasFrames(false);
    }

    videoEl.addEventListener('loadeddata', checkReady);
    videoEl.addEventListener('playing', checkReady);
    videoEl.addEventListener('canplay', checkReady);
    videoEl.addEventListener('timeupdate', checkReady);
    videoEl.addEventListener('resize', checkReady);

    // Auto-resume on mobile / iOS when user switches back from another app
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && videoEl && showVideo) {
        if (videoEl.paused) {
          videoEl.play().then(checkReady).catch(() => {});
        } else {
          checkReady();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const handleUserInteraction = () => {
      if (videoEl && videoEl.paused && showVideo) {
        videoEl.play().then(checkReady).catch(() => {});
      }
    };
    window.addEventListener('touchstart', handleUserInteraction, { once: true });
    window.addEventListener('click', handleUserInteraction, { once: true });

    // Listen to video tracks unmuting or ending
    if (stream) {
      const vTracks = stream.getVideoTracks();
      const onTrackChange = () => {
        setTrackVersion((v) => v + 1);
        if (videoEl && showVideo) {
          videoEl.play().then(checkReady).catch(() => {});
        }
      };

      vTracks.forEach((t) => {
        t.addEventListener('unmute', onTrackChange);
        t.addEventListener('ended', onTrackChange);
      });

      return () => {
        videoEl.removeEventListener('loadeddata', checkReady);
        videoEl.removeEventListener('playing', checkReady);
        videoEl.removeEventListener('canplay', checkReady);
        videoEl.removeEventListener('timeupdate', checkReady);
        videoEl.removeEventListener('resize', checkReady);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('touchstart', handleUserInteraction);
        window.removeEventListener('click', handleUserInteraction);
        vTracks.forEach((t) => {
          t.removeEventListener('unmute', onTrackChange);
          t.removeEventListener('ended', onTrackChange);
        });
      };
    }

    return () => {
      videoEl.removeEventListener('loadeddata', checkReady);
      videoEl.removeEventListener('playing', checkReady);
      videoEl.removeEventListener('canplay', checkReady);
      videoEl.removeEventListener('timeupdate', checkReady);
      videoEl.removeEventListener('resize', checkReady);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('touchstart', handleUserInteraction);
      window.removeEventListener('click', handleUserInteraction);
    };
  }, [stream, showVideo, isCameraOff, isScreenSharing, isLocal]);

  // Video feed is actively visible only when frames are rendering
  const isVideoRendering = showVideo && (isLocal || hasFrames);

  const shouldMirror = isLocal && !isScreenSharing && !isVirtualBgActive;

  return (
    <div
      className={`video-tile-wrap ${isSpeaking && !isMuted ? 'speaking-active' : ''}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={true}
        className={`video-elem ${shouldMirror ? 'video-mirrored' : ''} ${
          isScreenSharing ? 'video-screenshare' : ''
        }`}
        style={{
          display: showVideo ? 'block' : 'none',
          opacity: isVideoRendering ? 1 : 0,
          transition: 'opacity 0.2s ease',
        }}
      />
      {!isVideoRendering && (
        <div className="video-avatar-fallback">
          <div className={`avatar-circle-lg ${isSpeaking && !isMuted ? 'speaking-ring' : ''}`}>
            <span>{initial}</span>
          </div>
          <span className="avatar-center-name" title={name}>
            {name} {isLocal && '(You)'}
          </span>
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
        {isLocal && onRename ? (
          <button
            type="button"
            className="participant-name-btn"
            onClick={(e) => {
              e.stopPropagation();
              onRename();
            }}
            title="Click to edit your display name"
          >
            <span className="participant-name">{name} (You)</span>
            <Edit2 size={11} className="name-edit-icon" />
          </button>
        ) : (
          <span className="participant-name" title={name}>
            {name} {isLocal && '(You)'}
          </span>
        )}
        {isHost && <span className="tag-host">Host</span>}
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
