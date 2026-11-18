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
  User,
  Edit2,
  Check,
  X,
} from 'lucide-react';
import type { Participant } from '../types';
import { useWebGroupCall } from '../hooks/useWebGroupCall';
import { ParticipantVideoTile } from './ParticipantVideoTile';
import { ParticipantVoiceCard } from './ParticipantVoiceCard';
import { ParticipantsDrawer } from './ParticipantsDrawer';
import { RemoteAudio } from './RemoteAudio';

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
    changeName,
    leaveGroupCall,
  } = call;

  const [currentPage, setCurrentPage] = useState(0);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newNameInput, setNewNameInput] = useState('');

  // Group all participants with bulletproof deduplication
  const allUsers: Participant[] = useMemo(() => {
    const localId = callState.localParticipant.id;
    const localWithStream: Participant = {
      ...callState.localParticipant,
      stream: localStream,
      isMuted: callState.isMuted,
      isCameraOff: callState.mode === 'audio' ? true : callState.isCameraOff,
      isHandRaised: callState.isHandRaised,
      isScreenSharing: callState.isScreenSharing,
    };
    const remotes = Array.isArray(callState.participants) ? callState.participants : [];

    // Filter out self and deduplicate by ID, socketId, and userId
    const seenIds = new Set<string>();
    seenIds.add(localId);
    if (callState.localParticipant.socketId) seenIds.add(callState.localParticipant.socketId);
    if (callState.localParticipant.userId) seenIds.add(callState.localParticipant.userId);

    const dedupedRemotes: Participant[] = [];
    for (const r of remotes) {
      if (!r || !r.id) continue;
      if (seenIds.has(r.id)) continue;
      if (r.socketId && seenIds.has(r.socketId)) continue;
      if (r.userId && seenIds.has(r.userId)) continue;

      seenIds.add(r.id);
      if (r.socketId) seenIds.add(r.socketId);
      if (r.userId) seenIds.add(r.userId);
      dedupedRemotes.push(r);
    }

    return [localWithStream, ...dedupedRemotes];
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

  const handleOpenRename = () => {
    setNewNameInput(callState.localParticipant.name);
    setIsEditingName(true);
  };

  const handleSaveRename = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newNameInput.trim();
    if (trimmed) {
      changeName(trimmed);
      try {
        localStorage.setItem('groupcall_user_name', trimmed);
      } catch {}
    }
    setIsEditingName(false);
  };

  return (
    <div className="active-call-layout">
      {/* Global persistent audio playback for all remote participants */}
      {/* This ensures audio from participants on ANY page is audible and does NOT mute when video is stopped */}
      <div className="global-audio-tracks" style={{ display: 'none' }} aria-hidden="true">
        {callState.participants.map((p) => {
          if (!p.stream || p.id === callState.localParticipant.id) return null;
          return (
            <RemoteAudio
              key={`remote-audio-${p.id}`}
              stream={p.stream}
              isMuted={p.isMuted}
            />
          );
        })}
      </div>

      {/* Top Navigation Bar */}
      <header className="call-header">
        <div className="call-header-left">
          <div className="room-identity">
            <h1 className="room-name">{callState.roomId || 'Group Meeting'}</h1>
            <span className="room-timer">{formatDuration(callState.durationSec)}</span>
          </div>
        </div>

        <div className="call-header-right">
          {/* Change Display Name Button */}
          <button
            type="button"
            className="btn-header-tool"
            onClick={handleOpenRename}
            title="Change Your Display Name"
          >
            <User size={15} />
            <span style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {callState.localParticipant.name}
            </span>
            <Edit2 size={12} color="#64748B" />
          </button>

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

      {/* Helper Banner when alone in the room */}
      {allUsers.length === 1 && (
        <div className="single-user-banner">
          <span>
            Waiting for others to join <strong>{callState.roomId}</strong>. Share this Room ID with participants to connect dynamically.
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
                Waiting for others to join... Share room ID: <strong>{callState.roomId}</strong>
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
        onOpenRename={handleOpenRename}
      />

      {/* Change Name Modal Dialog */}
      {isEditingName && (
        <div className="drawer-overlay" style={{ zIndex: 100 }} onClick={() => setIsEditingName(false)}>
          <div
            className="lobby-card"
            style={{ maxWidth: '420px', margin: 'auto', padding: '24px', position: 'relative' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="drawer-close-btn"
              style={{ position: 'absolute', top: '16px', right: '16px' }}
              onClick={() => setIsEditingName(false)}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <h2 style={{ fontSize: '18px', fontWeight: 800, marginBottom: '6px' }}>Change Display Name</h2>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '18px' }}>
              Your new name will be visible to all participants in this meeting.
            </p>
            <form onSubmit={handleSaveRename}>
              <div className="form-group">
                <label className="form-label" htmlFor="renameInput">Display Name</label>
                <input
                  id="renameInput"
                  type="text"
                  className="form-input"
                  value={newNameInput}
                  onChange={(e) => setNewNameInput(e.target.value)}
                  placeholder="Enter your name"
                  autoFocus
                  required
                />
              </div>
              <div style={{ display: 'flex', gap: '10px', marginTop: '20px', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  className="page-step-btn"
                  onClick={() => setIsEditingName(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="join-submit-btn"
                  style={{ width: 'auto', padding: '10px 20px' }}
                >
                  <Check size={16} />
                  <span>Save Name</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
