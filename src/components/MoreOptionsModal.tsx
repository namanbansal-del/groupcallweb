import React from 'react';
import {
  X,
  Sparkles,
  Video,
  Mic,
  MonitorUp,
  MessageSquare,
  Smile,
  Users,
  Copy,
  Square,
  Check,
  Shield,
} from 'lucide-react';
import type { RecordingType } from '../hooks/useCallRecording';

interface MoreOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenVirtualBackground: () => void;
  isRecording: boolean;
  recordingType: RecordingType;
  recordingDurationSec: number;
  onStartScreenRecord: () => void;
  onStartAudioRecord: () => void;
  onStopRecord: () => void;
  onToggleScreenShare: () => void;
  isScreenSharing: boolean;
  onToggleChat: () => void;
  isChatOpen: boolean;
  unreadChat: number;
  onToggleReactions: () => void;
  onToggleParticipants: () => void;
  participantCount: number;
  onCopyRoomLink: () => void;
  hasCopied: boolean;
  isHost?: boolean;
  onOpenHostControls?: () => void;
}

export const MoreOptionsModal: React.FC<MoreOptionsModalProps> = ({
  isOpen,
  onClose,
  onOpenVirtualBackground,
  isRecording,
  recordingType,
  recordingDurationSec,
  onStartScreenRecord,
  onStartAudioRecord,
  onStopRecord,
  onToggleScreenShare,
  isScreenSharing,
  onToggleChat,
  isChatOpen,
  unreadChat,
  onToggleReactions,
  onToggleParticipants,
  participantCount,
  onCopyRoomLink,
  hasCopied,
  isHost = false,
  onOpenHostControls,
}) => {
  if (!isOpen) return null;

  const formatSecs = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="more-options-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="More Options"
      >
        <div className="sheet-handle" />

        <div className="sheet-header">
          <h3>More Options</h3>
          <button type="button" className="btn-modal-close" onClick={onClose} aria-label="Close options">
            <X size={20} />
          </button>
        </div>

        <div className="sheet-items-grid">
          {/* Host Controls (If Host) */}
          {isHost && onOpenHostControls && (
            <button
              type="button"
              className="sheet-item-btn item-active"
              onClick={() => {
                onClose();
                onOpenHostControls();
              }}
            >
              <div className="sheet-item-icon bg-blue">
                <Shield size={20} color="#3B82F6" />
              </div>
              <div className="sheet-item-text">
                <span className="sheet-item-title">Host Controls 👑</span>
                <span className="sheet-item-desc">Mute all, lock screen share & permissions</span>
              </div>
            </button>
          )}

          {/* 1. Visual Effects & Background */}
          <button
            type="button"
            className="sheet-item-btn"
            onClick={() => {
              onClose();
              onOpenVirtualBackground();
            }}
          >
            <div className="sheet-item-icon bg-purple">
              <Sparkles size={20} color="#C084FC" />
            </div>
            <div className="sheet-item-text">
              <span className="sheet-item-title">Apply Visual Effects</span>
              <span className="sheet-item-desc">Blur background or choose image</span>
            </div>
          </button>

          {/* 2. Record Screen with Audio */}
          <button
            type="button"
            className={`sheet-item-btn ${isRecording && recordingType === 'screen' ? 'recording-active' : ''}`}
            onClick={() => {
              onClose();
              if (isRecording && recordingType === 'screen') {
                onStopRecord();
              } else {
                onStartScreenRecord();
              }
            }}
          >
            <div className={`sheet-item-icon ${isRecording && recordingType === 'screen' ? 'bg-red-pulse' : 'bg-blue'}`}>
              {isRecording && recordingType === 'screen' ? (
                <Square size={18} color="#FFFFFF" fill="#FFFFFF" />
              ) : (
                <Video size={20} color="#60A5FA" />
              )}
            </div>
            <div className="sheet-item-text">
              <span className="sheet-item-title">
                {isRecording && recordingType === 'screen'
                  ? `Stop Recording (${formatSecs(recordingDurationSec)})`
                  : 'Record Screen with Audio'}
              </span>
              <span className="sheet-item-desc">Save full screen video & mixed audio</span>
            </div>
          </button>

          {/* 3. Record Audio Only (MP3) */}
          <button
            type="button"
            className={`sheet-item-btn ${isRecording && recordingType === 'audio' ? 'recording-active' : ''}`}
            onClick={() => {
              onClose();
              if (isRecording && recordingType === 'audio') {
                onStopRecord();
              } else {
                onStartAudioRecord();
              }
            }}
          >
            <div className={`sheet-item-icon ${isRecording && recordingType === 'audio' ? 'bg-red-pulse' : 'bg-emerald'}`}>
              {isRecording && recordingType === 'audio' ? (
                <Square size={18} color="#FFFFFF" fill="#FFFFFF" />
              ) : (
                <Mic size={20} color="#34D399" />
              )}
            </div>
            <div className="sheet-item-text">
              <span className="sheet-item-title">
                {isRecording && recordingType === 'audio'
                  ? `Stop Audio Recording (${formatSecs(recordingDurationSec)})`
                  : 'Record Audio Only (MP3)'}
              </span>
              <span className="sheet-item-desc">Save high quality voice recording</span>
            </div>
          </button>

          {/* 4. Share Screen (Ensured for Android, iOS, Desktop) */}
          <button
            type="button"
            className={`sheet-item-btn ${isScreenSharing ? 'item-active' : ''}`}
            onClick={() => {
              onClose();
              onToggleScreenShare();
            }}
          >
            <div className="sheet-item-icon bg-indigo">
              <MonitorUp size={20} color="#818CF8" />
            </div>
            <div className="sheet-item-text">
              <span className="sheet-item-title">
                {isScreenSharing ? 'Stop Sharing Screen' : 'Share Screen'}
              </span>
              <span className="sheet-item-desc">Present your screen to everyone</span>
            </div>
          </button>

          {/* 5. In-call Chat */}
          <button
            type="button"
            className={`sheet-item-btn ${isChatOpen ? 'item-active' : ''}`}
            onClick={() => {
              onClose();
              onToggleChat();
            }}
          >
            <div className="sheet-item-icon bg-amber">
              <MessageSquare size={20} color="#FBBF24" />
            </div>
            <div className="sheet-item-text">
              <span className="sheet-item-title">In-call Messages</span>
              <span className="sheet-item-desc">Chat with call participants</span>
            </div>
            {unreadChat > 0 && <span className="sheet-badge">{unreadChat}</span>}
          </button>

          {/* 6. Reactions */}
          <button
            type="button"
            className="sheet-item-btn"
            onClick={() => {
              onClose();
              onToggleReactions();
            }}
          >
            <div className="sheet-item-icon bg-pink">
              <Smile size={20} color="#F472B6" />
            </div>
            <div className="sheet-item-text">
              <span className="sheet-item-title">Send Reaction</span>
              <span className="sheet-item-desc">Express yourself with emojis</span>
            </div>
          </button>

          {/* 7. People List */}
          <button
            type="button"
            className="sheet-item-btn"
            onClick={() => {
              onClose();
              onToggleParticipants();
            }}
          >
            <div className="sheet-item-icon bg-cyan">
              <Users size={20} color="#22D3EE" />
            </div>
            <div className="sheet-item-text">
              <span className="sheet-item-title">Participants</span>
              <span className="sheet-item-desc">{participantCount} people in meeting</span>
            </div>
          </button>

          {/* 8. Copy Invite Link */}
          <button
            type="button"
            className="sheet-item-btn"
            onClick={() => {
              onCopyRoomLink();
            }}
          >
            <div className="sheet-item-icon bg-slate">
              {hasCopied ? <Check size={20} color="#10B981" /> : <Copy size={20} color="#CBD5E1" />}
            </div>
            <div className="sheet-item-text">
              <span className="sheet-item-title">
                {hasCopied ? 'Link Copied to Clipboard!' : 'Share Meeting Link'}
              </span>
              <span className="sheet-item-desc">Invite others to join this call</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
