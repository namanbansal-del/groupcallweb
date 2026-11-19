import React, { useEffect, useRef } from 'react';
import { MonitorUp, MicOff, Hand, Edit2 } from 'lucide-react';
import type { Participant } from '../types';

interface PresentationStageProps {
  screenStream: MediaStream | null;
  presenterName: string;
  isLocalPresenter: boolean;
  cameraStream: MediaStream | null;
  cameraParticipant: Participant;
  isCameraOff: boolean;
  isMuted: boolean;
  onStopPresenting?: () => void;
  onRename?: () => void;
}

export const PresentationStage: React.FC<PresentationStageProps> = ({
  screenStream,
  presenterName,
  isLocalPresenter,
  cameraStream,
  cameraParticipant,
  isCameraOff,
  isMuted,
  onStopPresenting,
  onRename,
}) => {
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);

  // Hook up full screen shared screen stream
  useEffect(() => {
    const el = screenVideoRef.current;
    if (!el) return;

    el.muted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', 'true');
    el.setAttribute('webkit-playsinline', 'true');

    if (screenStream) {
      if (el.srcObject !== screenStream) {
        el.srcObject = screenStream;
      }
      el.play().catch((err) => {
        console.warn('[PresentationStage] Screen video play error:', err);
      });
    } else {
      el.srcObject = null;
    }
  }, [screenStream]);

  // Hook up bottom-right camera stream
  const hasLiveCameraTrack = !!(
    cameraStream &&
    cameraStream.getVideoTracks().length > 0 &&
    cameraStream.getVideoTracks().some((t) => t.readyState !== 'ended')
  );
  const showCameraVideo = hasLiveCameraTrack && !isCameraOff;

  useEffect(() => {
    const el = cameraVideoRef.current;
    if (!el) return;

    el.muted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', 'true');
    el.setAttribute('webkit-playsinline', 'true');

    if (cameraStream && showCameraVideo) {
      if (el.srcObject !== cameraStream) {
        el.srcObject = cameraStream;
      }
      el.play().catch((err) => {
        console.warn('[PresentationStage] Camera video play error:', err);
      });
    } else {
      el.srcObject = null;
    }
  }, [cameraStream, showCameraVideo]);

  const initial = cameraParticipant.name ? cameraParticipant.name.slice(0, 1).toUpperCase() : '?';

  return (
    <div className="presentation-stage-container">
      {/* Full Screen Shared Screen Area */}
      <div className="presentation-screen-wrapper">
        <video
          ref={screenVideoRef}
          autoPlay
          playsInline
          muted
          className="presentation-screen-video"
        />

        {/* Top Floating Presentation Badge */}
        <div className="presentation-badge-bar">
          <div className="presentation-badge-tag">
            <MonitorUp size={15} color="#3B82F6" />
            <span>
              {isLocalPresenter ? 'You are sharing your screen' : `${presenterName}'s Screen`}
            </span>
          </div>

          {isLocalPresenter && onStopPresenting && (
            <button
              type="button"
              className="btn-presentation-stop"
              onClick={onStopPresenting}
            >
              Stop Sharing
            </button>
          )}
        </div>

        {/* Bottom-Right Floating Camera PiP Frame */}
        <div className="pip-camera-overlay">
          {showCameraVideo ? (
            <video
              ref={cameraVideoRef}
              autoPlay
              playsInline
              muted
              className={`pip-camera-video ${isLocalPresenter ? 'video-mirrored' : ''}`}
            />
          ) : (
            <div className="pip-avatar-fallback">
              <div className="avatar-circle-sm">
                <span>{initial}</span>
              </div>
            </div>
          )}

          {/* Camera Frame Badges */}
          <div className="pip-info-pill">
            {isLocalPresenter && onRename ? (
              <button
                type="button"
                className="participant-name-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onRename();
                }}
                title="Click to edit your display name"
              >
                <span className="pip-name">{cameraParticipant.name} (You)</span>
                <Edit2 size={10} className="name-edit-icon" />
              </button>
            ) : (
              <span className="pip-name" title={cameraParticipant.name}>
                {cameraParticipant.name} {isLocalPresenter && '(You)'}
              </span>
            )}
            {isMuted ? (
              <div className="pip-mic-muted" title="Muted">
                <MicOff size={11} color="#EF4444" />
              </div>
            ) : cameraParticipant.isSpeaking ? (
              <div className="voice-wave-indicator" title="Speaking">
                <span className="bar bar1" />
                <span className="bar bar2" />
                <span className="bar bar3" />
              </div>
            ) : null}
            {cameraParticipant.isHandRaised && (
              <Hand size={11} color="#F59E0B" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
