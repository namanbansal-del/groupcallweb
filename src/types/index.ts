export type CallMode = 'audio' | 'video';

export type CallStatus = 'idle' | 'joining' | 'joined' | 'left';

export interface Participant {
  id: string;
  socketId?: string;
  userId?: string;
  name: string;
  avatar?: string;
  isMuted: boolean;
  isCameraOff: boolean;
  isSpeaking?: boolean;
  isHandRaised?: boolean;
  isScreenSharing?: boolean;
  isHost?: boolean;
  stream?: MediaStream | null;
}

export interface GroupCallState {
  roomId: string | null;
  mode: CallMode;
  status: CallStatus;
  participants: Participant[];
  localParticipant: Participant;
  activeSpeakerId: string | null;
  isMuted: boolean;
  isCameraOff: boolean;
  isHandRaised: boolean;
  isScreenSharing: boolean;
  durationSec: number;
  error: string | null;
}

