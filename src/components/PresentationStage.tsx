import React, { useEffect, useRef, useState } from 'react';
import { MonitorUp, MicOff, Hand, Edit2, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Participant } from '../types';
import { ParticipantVideoTile } from './ParticipantVideoTile';

interface PresentationStageProps {
  screenStream: MediaStream | null;
  presenterName: string;
  isLocalPresenter: boolean;
  cameraStream?: MediaStream | null;
  cameraParticipant: Participant;
  isCameraOff: boolean;
  isMuted: boolean;
  participants: Participant[];
  localParticipantId: string;
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
  participants,
  localParticipantId,
  onStopPresenting,
  onRename,
}) => {
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);

  // Pagination for the top participant strip (4 to 5 visible per page)
  const [stripPage, setStripPage] = useState(0);
  const stripPageSize = 5;
  const totalStripPages = Math.max(1, Math.ceil(participants.length / stripPageSize));
  const safeStripPage = Math.min(stripPage, totalStripPages - 1);
  const currentStripUsers = participants.slice(
    safeStripPage * stripPageSize,
    (safeStripPage + 1) * stripPageSize
  );

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
      {/* Top Carousel Strip: 4 to 5 Participant Video Tiles with Pagination */}
      {participants.length > 0 && (
        <div className="presentation-participants-strip">
          {totalStripPages > 1 && (
            <button
              type="button"
              className="strip-arrow-btn strip-arrow-left"
              disabled={safeStripPage === 0}
              onClick={() => setStripPage((p) => Math.max(0, p - 1))}
              aria-label="Previous participants page"
            >
              <ChevronLeft size={18} />
            </button>
          )}

          <div className={`presentation-strip-carousel strip-count-${currentStripUsers.length}`}>
            {currentStripUsers.map((user) => (
              <div key={user.id} className="presentation-strip-cell">
                <ParticipantVideoTile
                  participant={user}
                  isLocal={user.id === localParticipantId}
                  onRename={user.id === localParticipantId ? onRename : undefined}
                />
              </div>
            ))}
          </div>

          {totalStripPages > 1 && (
            <button
              type="button"
              className="strip-arrow-btn strip-arrow-right"
              disabled={safeStripPage >= totalStripPages - 1}
              onClick={() => setStripPage((p) => Math.min(totalStripPages - 1, p + 1))}
              aria-label="Next participants page"
            >
              <ChevronRight size={18} />
            </button>
          )}

          {totalStripPages > 1 && (
            <div className="strip-page-indicator">
              {safeStripPage + 1}/{totalStripPages}
            </div>
          )}
        </div>
      )}

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
