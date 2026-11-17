import React from 'react';
import { MicOff, Hand } from 'lucide-react';
import type { Participant } from '../types';

interface ParticipantVoiceCardProps {
  participant: Participant;
  isLocal?: boolean;
  size?: 'normal' | 'large';
}

export const ParticipantVoiceCard: React.FC<ParticipantVoiceCardProps> = ({
  participant,
  isLocal = false,
  size = 'normal',
}) => {
  const { name, isMuted, isSpeaking, isHandRaised, isHost } = participant;
  const initial = name ? name.slice(0, 1).toUpperCase() : '?';
  const isLarge = size === 'large';

  return (
    <div className={`voice-card ${isLarge ? 'voice-card-large' : ''}`}>
      <div className="voice-avatar-container">
        {/* Animated Speaking Ripple */}
        {isSpeaking && !isMuted && (
          <div className={`speaking-ripple ${isLarge ? 'ripple-large' : ''}`} />
        )}

        {/* Circular Avatar */}
        <div
          className={`voice-avatar-circle ${isLarge ? 'avatar-large' : ''} ${
            isSpeaking && !isMuted ? 'avatar-speaking' : ''
          }`}
        >
          <span>{initial}</span>
        </div>

        {/* Muted Icon Badge */}
        {isMuted && (
          <div className={`voice-badge-muted ${isLarge ? 'badge-muted-large' : ''}`} title="Muted">
            <MicOff size={isLarge ? 16 : 13} color="#FFFFFF" />
          </div>
        )}

        {/* Hand Raised Badge */}
        {isHandRaised && (
          <div
            className={`voice-badge-hand ${isLarge ? 'badge-hand-large' : ''}`}
            title="Hand Raised"
          >
            <Hand size={isLarge ? 14 : 11} />
          </div>
        )}
      </div>

      {/* Full Participant Name */}
      <div className={`voice-name ${isLarge ? 'voice-name-large' : ''}`} title={name}>
        {name} {isLocal && '(You)'}
      </div>

      {/* Role Pill */}
      <div className={`voice-role ${isLarge ? 'voice-role-large' : ''}`}>
        {isLocal ? 'You' : isHost ? 'Host' : 'Speaker'}
      </div>
    </div>
  );
};
