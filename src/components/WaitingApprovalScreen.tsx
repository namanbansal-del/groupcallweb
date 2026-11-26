import React from 'react';
import { Clock, Shield, ArrowLeft, XCircle } from 'lucide-react';

interface WaitingApprovalScreenProps {
  status: 'waiting_approval' | 'denied';
  roomId: string | null;
  onReturnToLobby: () => void;
}

export const WaitingApprovalScreen: React.FC<WaitingApprovalScreenProps> = ({
  status,
  roomId,
  onReturnToLobby,
}) => {
  const isDenied = status === 'denied';

  return (
    <div className="waiting-approval-container">
      <div className="waiting-approval-card">
        {isDenied ? (
          <div className="waiting-icon-wrap icon-denied">
            <XCircle size={44} color="#EF4444" />
          </div>
        ) : (
          <div className="waiting-icon-wrap icon-pulse">
            <Clock size={44} color="#2563EB" />
          </div>
        )}

        <div className="waiting-badge">
          <Shield size={14} color={isDenied ? '#EF4444' : '#2563EB'} />
          <span>{isDenied ? 'Entry Denied' : 'Waiting Room'}</span>
        </div>

        <h2 className="waiting-title">
          {isDenied ? "You can't join this call" : 'Asking to be let in...'}
        </h2>

        <p className="waiting-desc">
          {isDenied
            ? 'The meeting host has declined your request to join this meeting.'
            : `You will join the call in '${roomId || 'Meeting'}' as soon as the meeting host admits you.`}
        </p>

        {!isDenied && (
          <div className="waiting-pulse-bar">
            <div className="waiting-pulse-dot" />
            <span>Waiting for host response</span>
          </div>
        )}

        <button
          type="button"
          className="waiting-return-btn"
          onClick={onReturnToLobby}
        >
          <ArrowLeft size={16} />
          <span>Return to Lobby</span>
        </button>
      </div>
    </div>
  );
};
