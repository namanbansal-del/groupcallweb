import React, { useEffect, useMemo, useState } from 'react';
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
  Check,
  X,
  Copy,
  MessageSquare,
  Smile,
  Pin,
  MoreVertical,
  Sparkles,
  Square,
} from 'lucide-react';
import type { Participant } from '../types';
import { useWebGroupCall } from '../hooks/useWebGroupCall';
import { useCallRecording } from '../hooks/useCallRecording';
import { ParticipantVideoTile } from './ParticipantVideoTile';
import { ParticipantVoiceCard } from './ParticipantVoiceCard';
import { ParticipantsDrawer } from './ParticipantsDrawer';
import { PresentationStage } from './PresentationStage';
import { RemoteAudio } from './RemoteAudio';
import { ChatPanel } from './ChatPanel';
import { ReactionPicker, ReactionsOverlay } from './ReactionsOverlay';
import { VirtualBackgroundModal } from './VirtualBackgroundModal';
import { MoreOptionsModal } from './MoreOptionsModal';

interface ActiveCallProps {
  call: ReturnType<typeof useWebGroupCall>;
}

export const ActiveCall: React.FC<ActiveCallProps> = ({ call }) => {
  const {
    callState,
    localStream,
    screenStream,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    toggleHandRaise,
    changeName,
    leaveGroupCall,
    chat,
    unreadChat,
    reactions,
    sendChat,
    sendReaction,
    clearUnread,
    virtualBgMode,
    applyVirtualBackground,
  } = call;

  const {
    recordingType,
    isRecording,
    recordingDurationSec,
    startScreenRecording,
    startAudioRecording,
    stopRecording,
  } = useCallRecording();

  const [currentPage, setCurrentPage] = useState(0);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [newNameInput, setNewNameInput] = useState('');
  const [copiedRoom, setCopiedRoom] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isReactOpen, setIsReactOpen] = useState(false);
  const [isVirtualBgOpen, setIsVirtualBgOpen] = useState(false);
  const [isMoreOptionsOpen, setIsMoreOptionsOpen] = useState(false);
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  // Keyboard shortcuts (Meet-style: Ctrl/Cmd+D mic, Ctrl/Cmd+E camera)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'd') {
        e.preventDefault();
        toggleMute();
      }
      if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        toggleCamera();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMute, toggleCamera]);

  useEffect(() => {
    if (isChatOpen && chat.length > 0) {
      clearUnread();
    }
  }, [isChatOpen, chat.length, clearUnread]);

  const handleCopyRoomCode = () => {
    if (callState.roomId) {
      navigator.clipboard.writeText(
        `${window.location.origin}${window.location.pathname}?room=${callState.roomId}`
      );
      setCopiedRoom(true);
      setTimeout(() => setCopiedRoom(false), 2000);
    }
  };

  // Group all participants with bulletproof deduplication and active-stream priority sorting
  const allUsers: Participant[] = useMemo(() => {
    const localId = callState.localParticipant.id;
    const activeLocalStream =
      callState.isScreenSharing && callState.localParticipant.stream
        ? callState.localParticipant.stream
        : callState.localParticipant.stream || localStream;

    const localWithStream: Participant = {
      ...callState.localParticipant,
      stream: activeLocalStream,
      isMuted: callState.isMuted,
      isCameraOff:
        callState.mode === 'audio' ? true : callState.isScreenSharing ? false : callState.isCameraOff,
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

    // Stable order by ID so tiles maintain a predictable layout and do not jump when hands are raised
    dedupedRemotes.sort((a, b) => a.id.localeCompare(b.id));

    return [localWithStream, ...dedupedRemotes];
  }, [
    callState.localParticipant,
    callState.isScreenSharing,
    localStream,
    callState.isMuted,
    callState.mode,
    callState.isCameraOff,
    callState.isHandRaised,
    callState.participants,
  ]);

  // Max 16 participants in one screen before pagination
  const pageSize = 16;
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
  const screenshareUser = allUsers.find(
    (u) => u.isScreenSharing && u.id !== callState.localParticipant.id
  );

  const isLocalScreenSharing = callState.isScreenSharing;
  const isRemoteScreenSharing = !!screenshareUser;
  const isAnyScreenSharing = isLocalScreenSharing || isRemoteScreenSharing;

  const presentationStream = isLocalScreenSharing
    ? screenStream || callState.localParticipant.stream
    : screenshareUser?.stream || null;

  const presentationPresenterName = isLocalScreenSharing
    ? callState.localParticipant.name
    : screenshareUser?.name || 'Participant';

  // Presenter participant & camera details for the bottom-right PiP frame
  const presenterParticipant = isLocalScreenSharing
    ? callState.localParticipant
    : screenshareUser || callState.localParticipant;

  const remotePresenterCameraStream = useMemo(() => {
    if (!screenshareUser?.stream) return null;
    const vTracks = screenshareUser.stream.getVideoTracks();
    if (vTracks.length > 1) {
      return new MediaStream([vTracks[1]]);
    }
    return null;
  }, [screenshareUser?.stream]);

  const presenterCameraStream = isLocalScreenSharing
    ? localStream
    : remotePresenterCameraStream;

  const presenterIsCameraOff = isLocalScreenSharing
    ? callState.isCameraOff
    : (screenshareUser?.isCameraOff ?? true);

  const presenterIsMuted = isLocalScreenSharing
    ? callState.isMuted
    : (screenshareUser?.isMuted ?? false);

  const handleScreenShareClick = () => {
    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getDisplayMedia === 'function'
    ) {
      toggleScreenShare();
    } else {
      alert(
        'Screen sharing is not supported by your current browser. Please update Google Chrome on Android or use Chrome on Desktop.'
      );
    }
  };

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

      {/* Active Recording Status Banner */}
      {isRecording && (
        <div className="recording-status-banner">
          <div className="recording-pulsing-dot" />
          <span>
            Recording {recordingType === 'screen' ? 'Screen & Audio' : 'Audio Only'} (
            {formatDuration(recordingDurationSec)})
          </span>
          <button
            type="button"
            className="btn-stop-recording-pill"
            onClick={stopRecording}
            title="Stop and save recording"
          >
            <Square size={12} fill="#FFFFFF" /> Stop Recording
          </button>
        </div>
      )}

      {/* Helper Banner when alone in the room */}
      {!isAnyScreenSharing && allUsers.length === 1 && (
        <div className="single-user-banner">
          <span>
            Waiting for others to join <strong>{callState.roomId}</strong>. Share this Room ID with participants to connect dynamically.
          </span>
        </div>
      )}

      {/* Main Calling Stage */}
      <main className="call-stage-area">
        {/* Previous Page Arrow */}
        {!isAnyScreenSharing && safePage > 0 && (
          <button
            type="button"
            className="carousel-arrow arrow-left"
            onClick={() => setCurrentPage(safePage - 1)}
            aria-label="Previous Page"
          >
            <ChevronLeft size={28} />
          </button>
        )}

        {/* Video, Voice Grid, or Fullscreen Presentation with Camera PiP */}
        <div className="stage-content">
          {isAnyScreenSharing && presentationStream ? (
            <PresentationStage
              screenStream={presentationStream}
              presenterName={presentationPresenterName}
              isLocalPresenter={isLocalScreenSharing}
              cameraStream={presenterCameraStream}
              cameraParticipant={presenterParticipant}
              isCameraOff={presenterIsCameraOff}
              isMuted={presenterIsMuted}
              onStopPresenting={isLocalScreenSharing ? toggleScreenShare : undefined}
              onRename={isLocalScreenSharing ? handleOpenRename : undefined}
            />
          ) : callState.mode === 'video' ? (
            pinnedId && allUsers.some((u) => u.id === pinnedId) ? (
              <div className="pinned-layout">
                <div className="pinned-main">
                  <div
                    className="video-grid-cell"
                    onDoubleClick={() => setPinnedId(null)}
                    style={{ height: '100%', position: 'relative' }}
                  >
                    <button
                      type="button"
                      onClick={() => setPinnedId(null)}
                      title="Click or double-click to unpin"
                      style={{
                        position: 'absolute',
                        top: 10,
                        left: 10,
                        zIndex: 10,
                        background: 'rgba(15, 23, 42, 0.75)',
                        backdropFilter: 'blur(4px)',
                        border: '1px solid rgba(255, 255, 255, 0.2)',
                        color: '#FFFFFF',
                        borderRadius: 6,
                        padding: '3px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        cursor: 'pointer',
                      }}
                    >
                      <Pin size={12} />
                      <span>Unpin</span>
                    </button>
                    <ParticipantVideoTile
                      participant={allUsers.find((u) => u.id === pinnedId)!}
                      isLocal={pinnedId === callState.localParticipant.id}
                      onRename={handleOpenRename}
                    />
                  </div>
                </div>
                <div className="pinned-strip">
                  {allUsers
                    .filter((u) => u.id !== pinnedId)
                    .map((u) => (
                      <div
                        key={u.id}
                        className="video-grid-cell"
                        onDoubleClick={() => setPinnedId(u.id)}
                      >
                        <ParticipantVideoTile
                          participant={u}
                          isLocal={u.id === callState.localParticipant.id}
                          onRename={handleOpenRename}
                        />
                      </div>
                    ))}
                </div>
              </div>
            ) : (
              <div
                className={`web-video-grid grid-count-${Math.min(currentUsers.length, 16)}`}
              >
                {currentUsers.map((user) => (
                  <div
                    key={user.id}
                    className="video-grid-cell"
                    onDoubleClick={() => setPinnedId(user.id)}
                    title="Double-click to pin"
                  >
                    <ParticipantVideoTile
                      participant={user}
                      isLocal={user.id === callState.localParticipant.id}
                      onRename={handleOpenRename}
                    />
                  </div>
                ))}
              </div>
            )
          ) : currentUsers.length === 1 && totalPages === 1 ? (
            /* Single Audio User Hero View */
            <div className="single-voice-hero">
              <ParticipantVoiceCard
                participant={currentUsers[0]}
                isLocal={currentUsers[0].id === callState.localParticipant.id}
                size="large"
                onRename={handleOpenRename}
              />
              <div className="single-tip-box">
                Waiting for others to join... Share room ID: <strong>{callState.roomId}</strong>
              </div>
            </div>
          ) : (
            /* Multi-User Audio Grid View */
            <div
              className={`web-voice-grid voice-grid-count-${Math.min(currentUsers.length, 16)}`}
            >
              {currentUsers.map((user) => (
                <div key={user.id} className="voice-grid-cell">
                  <ParticipantVoiceCard
                    participant={user}
                    isLocal={user.id === callState.localParticipant.id}
                    onRename={handleOpenRename}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Next Page Arrow */}
        {!isAnyScreenSharing && safePage < totalPages - 1 && (
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
      {!isAnyScreenSharing && totalPages > 1 && (
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
        {/* Left: Room Identity, Timer & Copy Code */}
        <div className="dock-room-info">
          <span className="dock-room-name" title={callState.roomId || 'Group Meeting'}>
            {callState.roomId || 'Group Meeting'}
          </span>
          <span className="dock-room-timer">{formatDuration(callState.durationSec)}</span>
          <button
            type="button"
            className="btn-dock-copy"
            onClick={handleCopyRoomCode}
            title="Copy Room ID to invite others"
          >
            {copiedRoom ? <Check size={12} color="#10B981" /> : <Copy size={12} />}
            <span className="dock-copy-label">{copiedRoom ? 'Copied' : 'Copy'}</span>
          </button>
        </div>

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

          {/* Visual Effects / Virtual Background (Desktop) */}
          {callState.mode === 'video' && !callState.isCameraOff && (
            <button
              type="button"
              className={`dock-btn dock-btn-desktop-only ${virtualBgMode !== 'none' ? 'dock-btn-active' : ''}`}
              onClick={() => setIsVirtualBgOpen(true)}
              title="Visual Effects & Virtual Background"
            >
              <Sparkles size={20} />
              <span className="dock-btn-label">Effects</span>
            </button>
          )}

          {/* Screen Share (Always available in video mode, works for Android, iOS, Desktop) */}
          {callState.mode === 'video' && (
            <button
              type="button"
              className={`dock-btn ${callState.isScreenSharing ? 'dock-btn-active' : ''}`}
              onClick={handleScreenShareClick}
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

          {/* Reactions (Desktop Only) */}
          <button
            type="button"
            className={`dock-btn dock-btn-desktop-only ${isReactOpen ? 'dock-btn-active' : ''}`}
            onClick={() => setIsReactOpen((v) => !v)}
            title="Send a reaction"
          >
            <Smile size={20} />
            <span className="dock-btn-label">React</span>
          </button>

          {/* In-Call Chat */}
          <button
            type="button"
            className={`dock-btn ${isChatOpen ? 'dock-btn-active' : ''}`}
            onClick={() => {
              setIsChatOpen((v) => !v);
              clearUnread();
            }}
            title="Chat with everyone"
          >
            <MessageSquare size={20} />
            <span className="dock-btn-label">Chat</span>
            {unreadChat > 0 && !isChatOpen && (
              <span className="dock-badge">{unreadChat}</span>
            )}
          </button>

          {/* Open Participants Drawer (Desktop Only) */}
          <button
            type="button"
            className={`dock-btn dock-btn-desktop-only ${isDrawerOpen ? 'dock-btn-active' : ''}`}
            onClick={() => setIsDrawerOpen(!isDrawerOpen)}
            title="View Participants"
          >
            <Users size={20} />
            <span className="dock-btn-label">People ({allUsers.length})</span>
          </button>

          {/* More Options (Three Dots) - Opens modal on mobile & desktop */}
          <button
            type="button"
            className={`dock-btn ${isMoreOptionsOpen || isRecording ? 'dock-btn-active' : ''}`}
            onClick={() => setIsMoreOptionsOpen(true)}
            title="More Options"
          >
            <MoreVertical size={20} />
            <span className="dock-btn-label">More</span>
            {isRecording && <span className="dock-rec-dot" />}
          </button>

          {/* End / Leave Call */}
          <button
            type="button"
            className="dock-btn dock-btn-end"
            onClick={() => setShowLeaveConfirm(true)}
            title="Leave Meeting"
          >
            <PhoneOff size={20} />
            <span className="dock-btn-label">Leave</span>
          </button>
        </div>

        {/* Right Spacer for balanced layout on desktop */}
        <div className="dock-right-spacer" />
      </footer>

      {/* Leave Call Confirmation Dialog */}
      {showLeaveConfirm && (
        <div
          className="drawer-overlay"
          style={{ zIndex: 110 }}
          onClick={() => setShowLeaveConfirm(false)}
        >
          <div
            className="lobby-card"
            style={{
              maxWidth: '400px',
              margin: 'auto',
              padding: '28px 24px',
              position: 'relative',
              textAlign: 'center',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="drawer-close-btn"
              style={{ position: 'absolute', top: '16px', right: '16px' }}
              onClick={() => setShowLeaveConfirm(false)}
              aria-label="Close"
            >
              <X size={18} />
            </button>

            <div
              style={{
                width: '52px',
                height: '52px',
                borderRadius: '50%',
                background: '#FEE2E2',
                color: '#EF4444',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 16px',
              }}
            >
              <PhoneOff size={24} />
            </div>

            <h2 style={{ fontSize: '19px', fontWeight: 800, marginBottom: '8px', color: 'var(--text-primary)' }}>
              Leave Meeting?
            </h2>
            <p
              style={{
                fontSize: '14px',
                color: 'var(--text-secondary)',
                lineHeight: '1.5',
                marginBottom: '24px',
              }}
            >
              Are you sure you want to leave <strong>{callState.roomId || 'the call'}</strong>? You will be disconnected from all participants.
            </p>

            <div
              style={{
                display: 'flex',
                gap: '12px',
                justifyContent: 'center',
              }}
            >
              <button
                type="button"
                className="page-step-btn"
                style={{ flex: 1, padding: '10px 16px', justifyContent: 'center' }}
                onClick={() => setShowLeaveConfirm(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-stop-share"
                style={{
                  flex: 1,
                  padding: '10px 16px',
                  borderRadius: '10px',
                  fontSize: '14px',
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
                onClick={() => {
                  setShowLeaveConfirm(false);
                  leaveGroupCall();
                }}
              >
                <PhoneOff size={16} />
                <span>Leave Call</span>
              </button>
            </div>
          </div>
        </div>
      )}

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

      {isReactOpen && (
        <ReactionPicker
          onPick={(e) => {
            sendReaction(e);
            setIsReactOpen(false);
          }}
        />
      )}
      <ReactionsOverlay reactions={reactions} />
      <ChatPanel
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        messages={chat}
        onSend={sendChat}
        selfId={callState.localParticipant.id}
      />

      {/* Virtual Background & Visual Effects Modal */}
      <VirtualBackgroundModal
        isOpen={isVirtualBgOpen}
        onClose={() => setIsVirtualBgOpen(false)}
        currentMode={virtualBgMode}
        onSelectMode={(mode, customUrl) => applyVirtualBackground(mode, customUrl)}
        localStream={localStream}
      />

      {/* More Options Modal (Three Dots Menu for Mobile & Desktop) */}
      <MoreOptionsModal
        isOpen={isMoreOptionsOpen}
        onClose={() => setIsMoreOptionsOpen(false)}
        onOpenVirtualBackground={() => setIsVirtualBgOpen(true)}
        isRecording={isRecording}
        recordingType={recordingType}
        recordingDurationSec={recordingDurationSec}
        onStartScreenRecord={() =>
          startScreenRecording({
            localStream,
            participants: allUsers,
            roomId: callState.roomId,
          })
        }
        onStartAudioRecord={() =>
          startAudioRecording({
            localStream,
            participants: allUsers,
            roomId: callState.roomId,
          })
        }
        onStopRecord={stopRecording}
        onToggleScreenShare={handleScreenShareClick}
        isScreenSharing={callState.isScreenSharing}
        onToggleChat={() => {
          setIsChatOpen((v) => !v);
          clearUnread();
        }}
        isChatOpen={isChatOpen}
        unreadChat={unreadChat}
        onToggleReactions={() => setIsReactOpen((v) => !v)}
        onToggleParticipants={() => setIsDrawerOpen((v) => !v)}
        participantCount={allUsers.length}
        onCopyRoomLink={handleCopyRoomCode}
        hasCopied={copiedRoom}
      />
    </div>
  );
};
