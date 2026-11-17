import React, { useMemo, useState } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  MonitorUp,
  Hand,
  PhoneOff,
  Users,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Plus,
  RefreshCw,
} from 'lucide-react';
import type { Participant } from '../types';
import { useWebGroupCall } from '../hooks/useWebGroupCall';
import { ParticipantVideoTile } from './ParticipantVideoTile';
import { ParticipantVoiceCard } from './ParticipantVoiceCard';
import { ParticipantsDrawer } from './ParticipantsDrawer';

interface ActiveCallProps {
  call: ReturnType<typeof useWebGroupCall>;
}

export const ActiveCall: React.FC<ActiveCallProps> = ({ call }) => {
  const {
    callState,
    localStream,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleHandRaise,
    leaveGroupCall,
    addSimulatedUsers,
    fill50SimulatedUsers,
    clearSimulatedUsers,
  } = call;

  const [currentPage, setCurrentPage] = useState(0);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [showStressMenu, setShowStressMenu] = useState(false);

  // Group all participants including local user
  const allUsers: Participant[] = useMemo(() => {
    const localWithStream: Participant = {
      ...callState.localParticipant,
      stream: localStream,
      isMuted: callState.isMuted,
      isCameraOff: callState.mode === 'audio' ? true : callState.isCameraOff,
      isHandRaised: callState.isHandRaised,
      isScreenSharing: callState.isScreenSharing,
    };
    const remotes = Array.isArray(callState.participants) ? callState.participants : [];
    return [localWithStream, ...remotes];
  }, [
    callState.localParticipant,
    localStream,
    callState.isMuted,
    callState.mode,
    callState.isCameraOff,
    callState.isHandRaised,
    callState.isScreenSharing,
    callState.participants,
  ]);

  // Video pagination: 6 per page on desktop
  // Audio pagination: 9 per page
  const pageSize = callState.mode === 'video' ? 6 : 9;
  const totalPages = Math.max(1, Math.ceil(allUsers.length / pageSize));

  // Chunk users into pages
  const pagesData: Participant[][] = useMemo(() => {
    const pages: Participant[][] = [];
    for (let i = 0; i < allUsers.length; i += pageSize) {
      pages.push(allUsers.slice(i, i + pageSize));
    }
    return pages.length > 0 ? pages : [[]];
  }, [allUsers, pageSize]);

  // Ensure current page is valid
  const safePage = Math.min(currentPage, totalPages - 1);
  const currentUsers = pagesData[safePage] || [];

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const handRaisers = allUsers.filter((u) => u.isHandRaised);

  return (
    <div className="active-call-layout">
      {/* Top Navigation Bar */}
      <header className="call-header">
        <div className="call-header-left">
          <div className="room-identity">
            <h1 className="room-name">{callState.roomId || 'Group Meeting'}</h1>
            <span className="room-timer">{formatDuration(callState.durationSec)}</span>
          </div>
        </div>

        <div className="call-header-right">
          {/* 🧪 Stress Simulator Dropdown Button */}
          <div className="stress-menu-wrapper">
            <button
              type="button"
              className={`btn-header-tool ${showStressMenu ? 'btn-tool-active' : ''}`}
              onClick={() => setShowStressMenu(!showStressMenu)}
            >
              <FlaskConical size={16} />
              <span>Test ({allUsers.length}/50)</span>
            </button>

            {showStressMenu && (
              <div className="stress-dropdown-menu">
                <div className="stress-menu-header">🧪 50-User Simulator</div>
                <button
                  type="button"
                  className="stress-menu-item"
                  onClick={() => {
                    addSimulatedUsers(1);
                  }}
                >
                  <Plus size={15} />
                  <span>+1 Audio Participant</span>
                </button>
                <button
                  type="button"
                  className="stress-menu-item"
                  onClick={() => {
                    addSimulatedUsers(1, true);
                  }}
                >
                  <Plus size={15} />
                  <span>+1 Video Participant</span>
                </button>
                <button
                  type="button"
                  className="stress-menu-item"
                  onClick={() => {
                    addSimulatedUsers(5);
                  }}
                >
                  <Plus size={15} />
                  <span>+5 Participants</span>
                </button>
                <button
                  type="button"
                  className="stress-menu-item stress-primary"
                  onClick={() => {
                    fill50SimulatedUsers();
                    setShowStressMenu(false);
                  }}
                >
                  <span>🚀 Fill to 50 Users</span>
                </button>
                <button
                  type="button"
                  className="stress-menu-item stress-danger"
                  onClick={() => {
                    clearSimulatedUsers();
                    setCurrentPage(0);
                  }}
                >
                  <RefreshCw size={14} />
                  <span>Reset Test Users</span>
                </button>
              </div>
            )}
          </div>

          {/* Participant Drawer Button */}
          <button
            type="button"
            className="btn-header-tool"
            onClick={() => setIsDrawerOpen(true)}
          >
            <Users size={16} />
            <span>{allUsers.length}</span>
          </button>
        </div>
      </header>

      {/* Raised Hands Alert Banner */}
      {handRaisers.length > 0 && (
        <div className="hand-raise-alert">
          <Hand size={16} className="alert-icon" />
          <span>
            {handRaisers.map((h) => h.name).join(', ')}{' '}
            {handRaisers.length === 1 ? 'has raised hand' : 'have raised hands'}
          </span>
        </div>
      )}

      {/* Main Calling Stage */}
      <main className="call-stage-area">
        {/* Previous Page Arrow */}
        {safePage > 0 && (
          <button
            type="button"
            className="carousel-arrow arrow-left"
            onClick={() => setCurrentPage(safePage - 1)}
            aria-label="Previous Page"
          >
            <ChevronLeft size={28} />
          </button>
        )}

        {/* Video or Voice Grid View */}
        <div className="stage-content">
          {callState.mode === 'video' ? (
            <div
              className={`web-video-grid grid-count-${Math.min(currentUsers.length, 6)}`}
            >
              {currentUsers.map((user) => (
                <div key={user.id} className="video-grid-cell">
                  <ParticipantVideoTile
                    participant={user}
                    isLocal={user.id === callState.localParticipant.id}
                  />
                </div>
              ))}
            </div>
          ) : currentUsers.length === 1 && totalPages === 1 ? (
            /* Single Audio User Hero View */
            <div className="single-voice-hero">
              <ParticipantVoiceCard
                participant={currentUsers[0]}
                isLocal={currentUsers[0].id === callState.localParticipant.id}
                size="large"
              />
              <div className="single-tip-box">
                Waiting for others to join... Tap <strong>Test (1/50)</strong> to simulate up to 50 users.
              </div>
            </div>
          ) : (
            /* Multi-User Audio Grid View */
            <div className="web-voice-grid">
              {currentUsers.map((user) => (
                <div key={user.id} className="voice-grid-cell">
                  <ParticipantVoiceCard
                    participant={user}
                    isLocal={user.id === callState.localParticipant.id}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Next Page Arrow */}
        {safePage < totalPages - 1 && (
          <button
            type="button"
            className="carousel-arrow arrow-right"
            onClick={() => setCurrentPage(safePage + 1)}
            aria-label="Next Page"
          >
            <ChevronRight size={28} />
          </button>
        )}
      </main>

      {/* Bottom Pagination Control */}
      {totalPages > 1 && (
        <div className="pagination-bar-wrap">
          <button
            type="button"
            disabled={safePage === 0}
            className="page-step-btn"
            onClick={() => setCurrentPage(safePage - 1)}
          >
            Prev
          </button>

          <div className="pagination-dots">
            {Array.from({ length: Math.min(totalPages, 10) }).map((_, idx) => (
              <button
                key={idx}
                type="button"
                className={`page-dot ${idx === safePage ? 'page-dot-active' : ''}`}
                onClick={() => setCurrentPage(idx)}
                aria-label={`Page ${idx + 1}`}
              />
            ))}
            {totalPages > 10 && (
              <span className="dot-more">+{totalPages - 10}</span>
            )}
          </div>

          <span className="page-indicator-text">
            Page {safePage + 1} of {totalPages}
          </span>

          <button
            type="button"
            disabled={safePage === totalPages - 1}
            className="page-step-btn"
            onClick={() => setCurrentPage(safePage + 1)}
          >
            Next
          </button>
        </div>
      )}

      {/* Bottom Floating Control Dock */}
      <footer className="call-footer-dock">
        <div className="dock-container">
          {/* Mute Mic */}
          <button
            type="button"
            className={`dock-btn ${callState.isMuted ? 'dock-btn-danger' : ''}`}
            onClick={toggleMute}
            title={callState.isMuted ? 'Unmute Mic' : 'Mute Mic'}
          >
            {callState.isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            <span className="dock-btn-label">
              {callState.isMuted ? 'Unmute' : 'Mute'}
            </span>
          </button>

          {/* Toggle Video */}
          {callState.mode === 'video' && (
            <button
              type="button"
              className={`dock-btn ${callState.isCameraOff ? 'dock-btn-danger' : ''}`}
              onClick={toggleCamera}
              title={callState.isCameraOff ? 'Start Camera' : 'Stop Camera'}
            >
              {callState.isCameraOff ? <VideoOff size={20} /> : <Video size={20} />}
              <span className="dock-btn-label">
                {callState.isCameraOff ? 'Start Video' : 'Stop Video'}
              </span>
            </button>
          )}

          {/* Screen Share */}
          {callState.mode === 'video' && (
            <button
              type="button"
              className={`dock-btn ${callState.isScreenSharing ? 'dock-btn-active' : ''}`}
              onClick={toggleScreenShare}
              title={callState.isScreenSharing ? 'Stop Presenting' : 'Share Screen'}
            >
              <MonitorUp size={20} />
              <span className="dock-btn-label">
                {callState.isScreenSharing ? 'Stop Share' : 'Share'}
              </span>
            </button>
          )}

          {/* Raise Hand */}
          <button
            type="button"
            className={`dock-btn ${callState.isHandRaised ? 'dock-btn-warning' : ''}`}
            onClick={toggleHandRaise}
            title={callState.isHandRaised ? 'Lower Hand' : 'Raise Hand'}
          >
            <Hand size={20} />
            <span className="dock-btn-label">
              {callState.isHandRaised ? 'Lower Hand' : 'Raise Hand'}
            </span>
          </button>

          {/* Open Participants Drawer */}
          <button
            type="button"
            className={`dock-btn ${isDrawerOpen ? 'dock-btn-active' : ''}`}
            onClick={() => setIsDrawerOpen(!isDrawerOpen)}
            title="View Participants"
          >
            <Users size={20} />
            <span className="dock-btn-label">People ({allUsers.length})</span>
          </button>

          {/* End / Leave Call */}
          <button
            type="button"
            className="dock-btn dock-btn-end"
            onClick={leaveGroupCall}
            title="Leave Meeting"
          >
            <PhoneOff size={20} />
            <span className="dock-btn-label">Leave</span>
          </button>
        </div>
      </footer>

      {/* Searchable 50-Person Drawer */}
      <ParticipantsDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        participants={callState.participants}
        localParticipant={callState.localParticipant}
      />
    </div>
  );
};

